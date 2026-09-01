#!/usr/bin/env bun
/**
 * 上下文读数口径的真机验证。
 *
 * **为什么单测不够。** 单测里的比值是脚本自己设的常数，锚点是脚本自己造的行。
 * 这里要回答三件单测答不了的事：这台机器上真实模型的估算/真值比是多少、
 * 装一个 MCP 之后真实会话的读数会不会跳、跑着的时候与回头看是不是同一个数。
 *
 *   bun run scripts/context-scale-live.ts
 *
 * 跑一轮要发真实请求（每条会话两三轮短对话），按配置里的模型逐个来。
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { buildAdapter, estimateMessages } from '@qywork/ai'
import type { AgentEvent, ConversationId, EventEnvelope, RunId } from '@qywork/core'
import { envelopeHeadTokens } from '@qywork/core'
import type { ModelRef, QyConfig } from '@qywork/runtime'
import {
  buildHistory,
  contextPanel,
  loadConfig,
  makeSummarizer,
  RuntimeCompaction,
  resolveModel,
} from '@qywork/runtime'
import { serve } from '@qywork/server'
import {
  getConversation,
  latestTodos,
  listProviderRequests,
  listRuns,
  listSteps,
  Store,
} from '@qywork/store'

const WS_DIR = join(import.meta.dir, '..', '.tmp', 'smoke-ws', 'context-scale')
const DB = join(WS_DIR, 'context-scale.sqlite3')
/** 换行。写进模板串里，避免转义在工具链上被折半。 */
const NL = String.fromCharCode(10)
const RUN_TIMEOUT_MS = 240_000
/** 第四段要模型逐个读的文件数。多几个才凑得出可折单元。 */
const NOTES = 8
/** 只写在第一份被折叠的工具结果里，重启后不能从召回问题本身抄答案。 */
const RECALL_MARKER = 'QYWORK-RESTART-7429'

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  process.stdout.write(`${ok ? '  ✓' : '  ✗'} ${label}\n`)
  if (!ok) {
    failures++
    if (detail !== undefined) process.stdout.write(`      ${JSON.stringify(detail)}\n`)
  }
}
function note(line: string): void {
  process.stdout.write(`  · ${line}\n`)
}

/** 一个只有 echo 的 stdio MCP server。装上它工具表就多一条，信封跟着换一份。 */
const MCP_SOURCE = `
let buf = ''
let ready = false
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1)
    if (!line.trim()) continue
    let m; try { m = JSON.parse(line) } catch { continue }
    if (m.method === 'initialize') {
      send({ jsonrpc: '2.0', id: m.id, result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'scale-fixture', version: '1.0.0' },
      } })
      continue
    }
    if (m.method === 'notifications/initialized') { ready = true; continue }
    if (!ready) { send({ jsonrpc: '2.0', id: m.id, error: { code: -32002, message: '还没 initialized' } }); continue }
    if (m.method === 'tools/list') {
      send({ jsonrpc: '2.0', id: m.id, result: { tools: [{
        name: 'echo',
        description: '原样返回传进来的文本',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      }] } })
      continue
    }
    if (m.method === 'tools/call') {
      send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: String(m.params?.arguments?.text ?? '') }] } })
      continue
    }
    if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: m.method } })
  }
})
`

/**
 * 斜率法用的料：中英各半，两千余字。
 *
 * 中英混排是刻意的——`TokenDensity` 的三个系数里中文与非中文分开计，
 * 只发一种就只量到半把尺。
 */
const BULK = [
  '压缩把一段历史换成摘要、把工具结果换成定位符之后，原文仍在账本里躺着。',
  'The projection budget answers how many tokens the summary may occupy after the fold line moves.',
  '锚点是上一次 provider 真值描述的那个上下文，信封换一份时只换头部。',
  'Token estimation is only used for the panel and for budget decisions; exact values come from usage.',
]
  .join(String.fromCharCode(10))
  .repeat(12)

interface Live {
  base: string
  token: string
  close: () => void
}

/** provider 真值：四项相加，与 `contextPanel` 的 `anchorTokens` 同一口径。 */
function trueTokens(r: {
  providerInputTokens: number | null
  providerOutputTokens: number | null
  providerCachedTokens: number | null
  providerCacheWriteTokens: number | null
}): number {
  return (
    (r.providerInputTokens ?? 0) +
    (r.providerCachedTokens ?? 0) +
    (r.providerCacheWriteTokens ?? 0) +
    (r.providerOutputTokens ?? 0)
  )
}

interface TurnResult {
  contexts: Extract<AgentEvent, { type: 'context' }>[]
  runId: RunId
}

/** 起一轮对话并等它跑完，一并把这一轮的 `context` 事件按到达顺序收下来。 */
async function turn(live: Live, conversationId: string, content: string): Promise<TurnResult> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${new URL(live.base).port}/stream?token=${live.token}&origin=desktop`,
  )
  await new Promise<void>((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true })
    ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
  })
  const seen: Extract<AgentEvent, { type: 'context' }>[] = []
  let runId: RunId | null = null
  const done = Promise.withResolvers<void>()
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data)) as EventEnvelope<AgentEvent> & { type?: string }
    if (msg.type === 'hello.err') return done.reject(new Error('hello 失败'))
    if (!msg.seq || !msg.event) return
    const ev = msg.event
    if (ev.type === 'context') seen.push(ev)
    else if (ev.type === 'run.started') runId = ev.runId
    else if (ev.type === 'run.error' && ev.runId === runId) {
      done.reject(new Error(`${ev.code}: ${ev.message}`))
    } else if (ev.type === 'run.finished' && ev.runId === runId) {
      done.resolve()
    }
  })
  ws.send(
    JSON.stringify({
      type: 'hello',
      token: live.token,
      origin: 'desktop',
      subscribe: [conversationId],
    }),
  )
  await Bun.sleep(200)
  ws.send(
    JSON.stringify({
      type: 'message.send',
      clientRequestId: crypto.randomUUID(),
      conversationId,
      content,
    }),
  )
  let timedOut = false
  let interruptTimer: ReturnType<typeof setTimeout> | null = null
  const timer = setTimeout(() => {
    timedOut = true
    if (!runId) return done.reject(new Error('这一轮超时'))
    ws.send(JSON.stringify({ type: 'run.interrupt', runId }))
    interruptTimer = setTimeout(() => done.reject(new Error('这一轮超时，中断后仍未收尾')), 10_000)
  }, RUN_TIMEOUT_MS)
  try {
    await done.promise
    if (timedOut) throw new Error('这一轮超时，已中断')
  } finally {
    clearTimeout(timer)
    if (interruptTimer) clearTimeout(interruptTimer)
    ws.close()
  }
  if (!runId) throw new Error('这一轮没有起 run')
  return { contexts: seen, runId }
}

function start(store: Store, config: Awaited<ReturnType<typeof loadConfig>>): Live {
  const h = serve({ store, config, workspaceRoot: WS_DIR, port: 0, host: '127.0.0.1' })
  return { base: `http://127.0.0.1:${h.port}`, token: h.token, close: () => h.stop() }
}

async function newConversation(live: Live, title: string): Promise<string> {
  const created = (await (
    await fetch(`${live.base}/api/conversations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${live.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ title }),
    })
  ).json()) as { conversation?: { id?: string } }
  return created.conversation?.id ?? ''
}

/**
 * 把会话切到指定模型。
 *
 * **接口与模型要成对给**：只给模型名会被回执拒掉，而拒了以后这一轮照样跑默认模型，
 * 看起来像切过去了。
 */
async function setModel(live: Live, conversationId: string, ref: ModelRef): Promise<void> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${new URL(live.base).port}/stream?token=${live.token}&origin=desktop`,
  )
  await new Promise<void>((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true })
    ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
  })
  ws.send(
    JSON.stringify({
      type: 'hello',
      token: live.token,
      origin: 'desktop',
      subscribe: [conversationId],
    }),
  )
  await Bun.sleep(200)
  ws.send(JSON.stringify({ type: 'conversation.setModel', conversationId, ...ref }))
  await Bun.sleep(400)
  ws.close()
}

/** 一条会话里所有拿到回执的请求，按发送顺序。 */
function settled(store: Store, conversationId: string) {
  return listRuns(store, conversationId as ConversationId)
    .flatMap((r) => listProviderRequests(store, r.id))
    .filter((r) => r.providerInputTokens !== null)
    .sort((a, b) => (a.sentAt ?? 0) - (b.sentAt ?? 0))
}

/** 指定一轮的助手正文。召回断言只看重启后的那一轮，不从旧正文误命中。 */
function runText(store: Store, runId: RunId): string {
  return listSteps(store, runId)
    .filter((step) => step.kind === 'text')
    .map((step) => step.content ?? '')
    .join(NL)
}

/** 被重复拿来当开头的编号；正文允许汇报进度，但同一个编号不该反复复述。 */
function repeatedOpeners(text: string): [string, number][] {
  const count = new Map<string, number>()
  for (const match of text.matchAll(
    /继续(?:执行)?第\s*([0-9一二三四五六七八九十]+)\s*(?:项|条|步)/g,
  )) {
    const number = match[1] as string
    count.set(number, (count.get(number) ?? 0) + 1)
  }
  return [...count].filter(([, times]) => times > 1)
}

async function runFor(store: Store, config: QyConfig, ref: ModelRef): Promise<void> {
  // 每个模型都从「没装 MCP」起步，否则第二个模型的第一阶段就已经带着它了。
  await rm(join(WS_DIR, '.agents', 'mcp.json'), { force: true })
  const mcpEntry = join(WS_DIR, 'mcp-fixture.mjs')
  for (let i = 1; i <= NOTES; i++) {
    await writeFile(
      join(WS_DIR, `note-${i}.txt`),
      `第 ${i} 号记录${NL}${i === 1 ? `召回口令：${RECALL_MARKER}${NL}` : ''}${BULK.slice(0, 1200)}${NL}`,
      'utf8',
    )
  }
  const profile = resolveModel(config, ref)
  if (!profile) {
    process.stdout.write(`\n跳过 ${ref.provider}/${ref.model}：配置里解析不出这条接口\n`)
    return
  }
  const spec = buildAdapter({
    kind: profile.kind,
    apiKey: profile.apiKey ?? '',
    model: profile.model,
    ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
  }).spec

  // ── 一、真实模型在新尺下的估算/真值比 ──────────────────────────────
  process.stdout.write(
    `\n【一】新尺下的实测比值（模型 ${spec.id}，窗口 ${spec.contextWindow.toLocaleString()}）\n`,
  )
  let live = start(store, config)
  const conv = await newConversation(live, `口径真机验证 ${ref.model}`)
  await setModel(live, conv, ref)
  check(
    `会话切到 ${ref.model}`,
    getConversation(store, conv as ConversationId)?.model === ref.model,
    { 实际: getConversation(store, conv as ConversationId)?.model },
  )
  await turn(live, conv, '只回两个字：收到。不要调用任何工具。')
  // 第二轮塞一大段进去：斜率法要两次请求的体量差得开，差几十 token 量不出斜率。
  await turn(
    live,
    conv,
    `${BULK}

上面这段不用理会，只回两个字：明白。不要调用任何工具。`,
  )

  const rows = settled(store, conv)
  check('至少两次请求拿到了 usage 回执', rows.length >= 2, { 条数: rows.length })
  for (const r of rows) {
    const t = trueTokens(r)
    note(
      `turn ${r.turnIndex}.${r.retryIndex}　估算 ${r.measuredInputTokens}　真值 ${t}　比值 ${(r.measuredInputTokens / t).toFixed(3)}`,
    )
  }
  if (rows.length >= 2) {
    const a = rows[0]!
    const b = rows[rows.length - 1]!
    const dm = b.measuredInputTokens - a.measuredInputTokens
    const dt = trueTokens(b) - trueTokens(a)
    note(
      `斜率法（首尾相减）：Δ估算 ${dm} / Δ真值 ${dt} = ${dt !== 0 ? (dm / dt).toFixed(3) : '真值没变，量不出'}`,
    )
    note('这一行就是批 5 的 `scale` 在真机上的取值来源——它按请求现算，不是脚本里那个 1.47。')
  }

  // ── 二、装一个 MCP：信封变了，读数不许跳 ────────────────────────────
  process.stdout.write('\n【二】装一个 MCP 之后的第一次发送\n')
  const anchorRow = rows[rows.length - 1]
  live.close()
  await Bun.sleep(300)
  await writeFile(
    join(WS_DIR, '.agents', 'mcp.json'),
    JSON.stringify(
      { servers: { scalefx: { command: process.execPath, args: [mcpEntry] } } },
      null,
      2,
    ),
    'utf8',
  )
  live = start(store, config)
  await Bun.sleep(1500)
  const events = (await turn(live, conv, '只回两个字：好的。不要调用任何工具。')).contexts

  const after = settled(store, conv)
  const fresh = after.filter((r) => !rows.some((o) => o.id === r.id))
  const firstNew = fresh[0]
  const first = events[0]

  check(
    '这一轮确实换了一份信封（指纹与锚点那条不同）',
    !!firstNew && !!anchorRow && firstNew.cacheRouteFingerprint !== anchorRow.cacheRouteFingerprint,
    { 锚点: anchorRow?.cacheRouteFingerprint, 本轮: firstNew?.cacheRouteFingerprint },
  )
  check(
    '工具表真的多了一条（信封里 tools 变了）',
    !!firstNew &&
      !!anchorRow &&
      firstNew.sentCategories.mcpTools > anchorRow.sentCategories.mcpTools,
    { 锚点: anchorRow?.sentCategories.mcpTools, 本轮: firstNew?.sentCategories.mcpTools },
  )

  check('首个读数由上一份真值校准（修前这里是 estimated）', first?.source === 'calibrated', {
    source: first?.source,
  })
  if (first && firstNew && anchorRow) {
    const expected =
      trueTokens(anchorRow) -
      envelopeHeadTokens(anchorRow.sentCategories) +
      envelopeHeadTokens(firstNew.sentCategories)
    const bare = firstNew.measuredInputTokens
    note(
      `锚点真值 ${trueTokens(anchorRow)}　旧头部 ${envelopeHeadTokens(anchorRow.sentCategories)}　新头部 ${envelopeHeadTokens(firstNew.sentCategories)}`,
    )
    note(`读数 ${first.tokens}　修正式算出 ${expected}　裸估算（修前会显示这个）${bare}`)
    // 差额是本轮那条新用户消息：锚点覆盖到上一轮为止，它之后的历史另估。
    const uncovered = first.tokens - expected
    note(`差额 ${uncovered} = 本轮新用户消息（锚点覆盖到上一轮为止，它之后的另估）`)
    check('读数等于「真值 − 旧头部 + 新头部 + 本轮新消息」', uncovered >= 0 && uncovered <= 300, {
      读数: first.tokens,
      修正式: expected,
      差额: uncovered,
    })
    check('读数没有掉到裸估算上', first.tokens !== bare, { 读数: first.tokens, 裸估算: bare })
    const jump = Math.abs(bare - trueTokens(anchorRow)) / Math.max(1, spec.contextWindow)
    note(
      `修前这一跳的幅度：${(jump * 100).toFixed(1)} 个百分点（窗口 ${spec.contextWindow.toLocaleString()}）`,
    )
  }

  // ── 三、跑着的时候与回头看是同一个数 ────────────────────────────────
  process.stdout.write('\n【三】运行中与回头看\n')
  const panel = contextPanel(store, conv as ConversationId, {
    ...spec,
    providerName: ref.provider,
    providerKind: profile.kind,
  })
  note(
    `面板 ${panel.total}（${panel.percent}%，${panel.source}）　运行中末次事件 ${events[events.length - 1]?.tokens}`,
  )
  check(
    '面板与运行中最后一个读数同尺（差在一轮尾巴之内）',
    panel.source === 'actual' &&
      Math.abs(panel.total - (events[events.length - 1]?.tokens ?? 0)) <= panel.limit * 0.02,
    { 面板: panel.total, 事件: events[events.length - 1]?.tokens },
  )

  // ── 四、真模型写一次摘要：压完之后真值要落到软阈值之下 ──────────────
  process.stdout.write(`${NL}【四】真机压一次${NL}`)
  /*
   * 先让模型真的调几次工具。
   *
   * 压缩的可折单元就是执行记录，纯对话选不出单元、`run` 直接回 `nothing_to_fold`，
   * `projectionBudget` 那一段一行都走不到。
   */
  // 一轮里连调八次工具仍然只有一个可折单元；必须拆成真实的独立 run，才能验证
  // 「保留最近批次、折叠更早批次」的产品语义，而不是在测试里伪造 step。
  await turn(
    live,
    conv,
    '调用一次 write_todos，写入三项且状态全部为 completed：' +
      '“已确认会话可写”、“已确认工具可用”、“已准备重启验收”。不要做别的事。',
  )
  for (let i = 1; i <= NOTES; i++) {
    const filler = `${BULK.slice(0, 2400)}${NL}${NL}上面的材料只用于形成可折叠的长会话，不需要复述。${NL}`
    await turn(
      live,
      conv,
      i === 1
        ? `${filler}只用 read_file 读取 note-1.txt，按原样报告前两行并记住第二行的召回口令。不要读取其他文件。`
        : `${filler}只用 read_file 读取 note-${i}.txt，然后只报告第一行。不要读取其他文件。`,
    )
  }
  const foldable = listRuns(store, conv as ConversationId)
    .flatMap((r) => listSteps(store, r.id))
    .filter((s) => s.kind === 'tool_action').length
  check('模型真的产生了可折的执行记录', foldable > 0, { 工具步数: foldable })

  const workspaceId = getConversation(store, conv as ConversationId)?.workspaceId ?? ''
  const summarizer = makeSummarizer({
    store,
    conversationId: conv as ConversationId,
    workspaceId: workspaceId as never,
    profile: () => ({
      kind: profile.kind,
      apiKey: profile.apiKey ?? '',
      model: profile.model,
      ...(profile.baseUrl ? { baseUrl: profile.baseUrl } : {}),
    }),
  })
  let budgetSeen = 0
  const compaction = new RuntimeCompaction({
    store,
    conversationId: conv as ConversationId,
    messageIdUpperBound: null,
    // 走真实装配，不在这里自拼一个摘要器：自拼的那个不降思考档，量到的是另一件事。
    summarize: async (prompt, budgetTokens) => {
      budgetSeen = budgetTokens
      return summarizer(prompt, budgetTokens)
    },
  })

  const beforeMsgs = await buildHistory(store, conv as ConversationId, null, async (c) => c)
  /*
   * 两把尺都取**同一次请求**的：`measuredInputTokens` 就是那一次的 `estimateRequest`，
   * 与它的 provider 回执逐字配对。拿 `estimateMessages(history)` 顶替是错的——
   * 那份少了冻结前缀与工具表，比出来的不是这两把尺的比。
   */
  const lastRow = settled(store, conv).at(-1)
  if (!lastRow) {
    note('这条会话一次回执都没有，第四段没法验。')
    live.close()
    return
  }
  const estBefore = lastRow.measuredInputTokens
  const trueBefore = trueTokens(lastRow)
  /*
   * 造一个必须走摘要、但摘要仍放得下的窗口。
   *
   * 1.2 倍窗口只会触发工具正文收纳，模型摘要不会运行；0.8 倍让收纳后的占用仍高于
   * 软阈值，同时保留足够投影预算，因此这次验收会真实调用当前模型生成摘要。它是人工缩窗触发，不冒充模型
   * 原生 1M 窗口已经自然填满。
   */
  const window = Math.max(4096, Math.round(trueBefore * 0.8))
  const softAt = Math.floor(window * 0.8)
  const outcome = await compaction.run({
    trigger: 'automatic',
    model: spec.id,
    occupancy: trueBefore,
    estimatedOccupancy: estBefore,
    contextWindow: window,
    density: spec.density,
  })
  note(
    `真值占用 ${trueBefore}　估算占用 ${estBefore}　比值 ${(estBefore / trueBefore).toFixed(3)}　窗口 ${window}　软阈值 ${softAt}`,
  )
  note(
    `压缩结果 ${outcome.status}${outcome.status === 'compacted' ? `　摘要跑没跑 ${outcome.summarized}　摘要预算 ${budgetSeen}` : ''}`,
  )
  if (outcome.status === 'compacted') {
    const estAfter = estimateMessages(compaction.project(beforeMsgs), spec.density)
    // 按同一份实测比折回真值尺——这一步与 `afterCondense` 用的是同一个比值。
    const trueAfter = Math.round(estAfter / (estBefore / trueBefore))
    note(`压完估算 ${estAfter}　折回真值 ${trueAfter}`)
    check('压完之后真值落到软阈值之下', trueAfter <= softAt, {
      压完真值: trueAfter,
      软阈值: softAt,
    })
    check('这次压缩真实调用了模型生成摘要', outcome.summarized, outcome)
    check('摘要预算是正数（不是被算成负的）', budgetSeen > 0, { 预算: budgetSeen })

    // ── 五、停掉并重启服务：压缩投影、Todo 与缓存都必须能继续 ──────────
    process.stdout.write(`${NL}【五】压缩后重启并再次召回${NL}`)
    const beforeRestartTodos = latestTodos(store, conv as ConversationId)
    check(
      '重启前最后一份 Todo 是三项且全部完成',
      beforeRestartTodos?.length === 3 &&
        beforeRestartTodos.every((todo) => todo.status === 'completed'),
      beforeRestartTodos,
    )
    check(
      '压缩 manifest 已持久化',
      getConversation(store, conv as ConversationId)?.compactionManifest !== null,
    )

    live.close()
    await Bun.sleep(500)
    live = start(store, config)
    await Bun.sleep(1000)

    const recalled = await turn(
      live,
      conv,
      '不要读取文件，也不要调用工具。只根据重启前的会话回答：' +
        '第 1 号记录中的召回口令是什么？当前三项待办分别是什么状态？',
    )
    const answer = runText(store, recalled.runId)
    const recallRequests = listProviderRequests(store, recalled.runId)
    const recallCached = recallRequests
      .filter((request) => request.providerCachedTokens !== null)
      .reduce((sum, request) => sum + (request.providerCachedTokens ?? 0), 0)
    const warmed = await turn(
      live,
      conv,
      '仍然不要读取文件或调用工具。只回答：刚才召回的口令是否仍是 QYWORK-RESTART-7429？',
    )
    const warmRequests = listProviderRequests(store, warmed.runId)
    const warmCached = warmRequests
      .filter((request) => request.providerCachedTokens !== null)
      .reduce((sum, request) => sum + (request.providerCachedTokens ?? 0), 0)
    const afterRestartTodos = latestTodos(store, conv as ConversationId)
    const allText = listRuns(store, conv as ConversationId)
      .flatMap((run) => listSteps(store, run.id))
      .filter((step) => step.kind === 'text')
      .map((step) => step.content ?? '')
      .join(NL)

    check('重启后模型准确召回被压缩工具结果里的口令', answer.includes(RECALL_MARKER), answer)
    check(
      '重启后模型准确回答 Todo 全部完成',
      /(?:三项|3\s*项|全部).{0,30}(?:completed|已完成|完成)/is.test(answer),
      answer,
    )
    check(
      '重启后 Todo 真源没有丢失或被改写',
      JSON.stringify(afterRestartTodos) === JSON.stringify(beforeRestartTodos),
      { 重启前: beforeRestartTodos, 重启后: afterRestartTodos },
    )
    check('重启后的请求仍有真实缓存命中', recallCached > 0, {
      缓存token: recallCached,
      请求数: recallRequests.length,
    })
    check('重启后追加一轮会恢复缓存命中', warmCached > 0, {
      缓存token: warmCached,
      请求数: warmRequests.length,
    })
    check('整条会话正文没有重复编号开头', repeatedOpeners(allText).length === 0, {
      重复项: repeatedOpeners(allText),
    })
  } else {
    note('这条会话太短，选不出可折单元——`projectionBudget` 这一项本轮没验到。')
  }

  live.close()
}

async function main(): Promise<number> {
  await rm(WS_DIR, { recursive: true, force: true })
  await mkdir(join(WS_DIR, '.agents'), { recursive: true })
  await writeFile(join(WS_DIR, 'mcp-fixture.mjs'), MCP_SOURCE, 'utf8')

  const store = new Store({ path: DB })
  const config = await loadConfig()

  // 不给参数就只跑配置里当前生效的那一条；给了就逐条跑，形如 `deepseek/deepseek-v4-flash`。
  const args = process.argv.slice(2)
  const refs: ModelRef[] = args.length
    ? args.map((a) => {
        const i = a.indexOf('/')
        return { provider: a.slice(0, i), model: a.slice(i + 1) }
      })
    : [config.active]

  for (const ref of refs) {
    try {
      await runFor(store, config, ref)
    } catch (err) {
      failures++
      process.stdout.write(`  ✗ ${ref.provider}/${ref.model} 这一轮抛了：${err instanceof Error ? err.message : String(err)}
`)
    }
  }

  store.close()
  process.stdout.write(`
${failures === 0 ? '全部通过' : `${failures} 条未通过`}
`)
  return failures === 0 ? 0 : 1
}

process.exit(await main())
