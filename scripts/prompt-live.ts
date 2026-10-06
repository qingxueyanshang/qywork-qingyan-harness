#!/usr/bin/env bun
/**
 * 三层提示词与上下文末尾注记的真实模型验证。
 *
 * **单元测试无法覆盖的部分。** 单元测试只能断言提示词中包含哪些文字，无法判定模型读取后是否遵循。
 * 本脚本验证行为：告知权限模式后模型是否仍触发拒绝、能力段列出子 agent 后模型是否派发、
 * 待办加入两句禁止复述的要求后模型是否仍写「继续执行第 N 项」。
 *
 * 会话写入主库，执行完毕后可在面板中逐条查看。工作区位于 `.tmp/prompt-live/<接口>-<模型>`，每个模型一个，
 * 面板上按模型各增加一个 work。
 *
 *   bun run scripts/prompt-live.ts                       # 配置中的全部模型
 *   bun run scripts/prompt-live.ts deepseek/deepseek-v4-pro   # 指定模型
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent, ConversationId, EventEnvelope, RunId } from '@qywork/core'
import { dataPath, loadConfig, type ModelRef, type QyConfig } from '@qywork/runtime'
import { serve } from '@qywork/server'
import {
  latestTodos,
  listProviderRequests,
  listRunContextSnapshots,
  listRuns,
  listSteps,
  Store,
} from '@qywork/store'

const WS_ROOT = join(import.meta.dir, '..', '.tmp', 'prompt-live')

/**
 * 每个模型一个工作区。
 *
 * 记忆保存在工作区的 `.agents/memory/`。若共用一个目录，第一个模型写入的记忆
 * 会保留给后续所有模型：它们在上下文末尾看到该记忆已存在，用 read_memory 确认后
 * 即回复「无需重复写入」。这是正确行为，却被断言按「未写入记忆」计为失败，
 * 导致通过率随执行顺序递减，易被误判为模型能力差异。
 *
 * 使用独立目录而不是每轮删除：Windows 上前一个 serve 仍持有目录，删除会报 EBUSY。
 */
export function wsFor(ref: ModelRef): string {
  return join(WS_ROOT, `${ref.provider}-${ref.model}`.replace(/[^\w.-]/g, '_'))
}
/** 换行符。不在模板字符串中写转义序列，避免工具链处理时反斜杠被减半。 */
const NL = String.fromCharCode(10)
const RUN_TIMEOUT_MS = Number(process.env.QYWORK_PROMPT_LIVE_TIMEOUT_MS ?? 300_000)

interface Verdict {
  ref: string
  turns: number
  /** 每条断言的名称与结果。执行失败的模型此处为空，由 `error` 说明原因。 */
  checks: { name: string; ok: boolean; detail: string }[]
  cachedRatio: number | null
  conversationId: string
  error?: string
}

function line(s: string): void {
  process.stdout.write(s + NL)
}

/** 发起一轮对话并等待其执行完毕。返回该轮的 runId。 */
async function turn(live: Live, conversationId: string, content: string): Promise<RunId | null> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${new URL(live.base).port}/stream?token=${live.token}&origin=desktop`,
  )
  await new Promise<void>((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true })
    ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
  })
  let runId: RunId | null = null
  const done = Promise.withResolvers<void>()
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data)) as EventEnvelope<AgentEvent> & { type?: string }
    if (msg.type === 'hello.err') return done.reject(new Error('hello 失败'))
    if (!msg.seq || !msg.event) return
    const ev = msg.event
    if (ev.type === 'run.started') runId = ev.runId
    /*
     * 收尾事件必须核对 runId。上一个模型超时后其 run 仍保留在服务端，
     * 下一轮的连接会收到残留的 run.finished；不核对时会把「该轮已执行完毕」
     * 判定在一个从未发出的请求上：会话中 run 数为 0，而断言全部按
     * 「模型未调用工具」计为失败，被误判为模型未遵循指令。
     */ else if (ev.type === 'run.error' && ev.runId === runId) {
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
    if (!runId) return done.reject(new Error('本轮超时'))
    ws.send(JSON.stringify({ type: 'conversation.interrupt', conversationId }))
    interruptTimer = setTimeout(() => done.reject(new Error('本轮超时，中断后仍未结束')), 10_000)
  }, RUN_TIMEOUT_MS)
  try {
    await done.promise
    if (timedOut) throw new Error('本轮超时，已中断')
  } finally {
    clearTimeout(timer)
    if (interruptTimer) clearTimeout(interruptTimer)
    ws.close()
  }
  return runId
}

interface Live {
  base: string
  token: string
  close: () => void
}

function start(store: Store, config: QyConfig, workspaceRoot: string): Live {
  const h = serve({ store, config, workspaceRoot, port: 0, host: '127.0.0.1' })
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
 * 接口与模型必须成对传入：只传模型名时请求被回执拒绝，而拒绝后该轮仍运行默认模型，
 * 与切换成功无法区分。
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

/**
 * 该会话中模型输出的内容，按 step 类型区分。
 *
 * 正文与思考必须分开统计。禁止复述待办的要求只针对用户可见的正文；
 * 思考中规划「下一步做第几条」是正常推理，一并禁止会损害模型的执行能力。
 */
function saidBy(store: Store, conversationId: string, kind: 'text' | 'thinking'): string {
  return listRuns(store, conversationId as ConversationId)
    .flatMap((r) => listSteps(store, r.id))
    .filter((s) => s.kind === kind)
    .map((s) => s.content ?? '')
    .join(NL)
}

/** 指定一轮中模型输出的内容。 */
function saidIn(store: Store, runId: RunId | null, kind: 'text' | 'thinking'): string {
  if (!runId) return ''
  return listSteps(store, runId)
    .filter((step) => step.kind === kind)
    .map((step) => step.content ?? '')
    .join(NL)
}

/** 该会话中调用过的全部工具名，按调用顺序排列。 */
function toolCalls(store: Store, conversationId: string): string[] {
  return listRuns(store, conversationId as ConversationId)
    .flatMap((r) => listSteps(store, r.id))
    .filter((s) => s.toolName !== null)
    .map((s) => s.toolName as string)
}

/**
 * 单独一轮中调用过的工具名。
 *
 * 必须按轮区分：「用户明确要求写记忆」与「模型自主判断是否沉淀」是两件事，
 * 前者未完成是缺陷，后者是模型自身的判断，不应按同一条断言计分。
 * 按整条会话合并统计时，两者无法区分。
 */
function toolCallsIn(store: Store, runId: RunId | null): string[] {
  if (!runId) return []
  return listSteps(store, runId)
    .filter((s) => s.toolName !== null)
    .map((s) => s.toolName as string)
}

/** 该会话中全部工具结果的正文，用于查找「被拒」与错误原文。 */
function toolOutputs(store: Store, conversationId: string): string {
  return listRuns(store, conversationId as ConversationId)
    .flatMap((r) => listSteps(store, r.id))
    .filter((s) => s.toolName !== null)
    .map((s) => `${s.status}:${s.content ?? ''}`)
    .join(NL)
}

/** 缓存命中占比：命中 ÷（命中 + 全价输入）。没有任何回执时返回 null。 */
function cachedRatio(store: Store, conversationId: string): number | null {
  const reqs = listRuns(store, conversationId as ConversationId)
    .flatMap((r) => listProviderRequests(store, r.id))
    .filter((r) => r.providerInputTokens !== null)
  if (reqs.length === 0) return null
  let cached = 0
  let paid = 0
  for (const r of reqs) {
    cached += r.providerCachedTokens ?? 0
    paid += r.providerInputTokens ?? 0
  }
  return cached + paid === 0 ? null : cached / (cached + paid)
}

/**
 * 匹配「继续执行第 N 项」形式的开场白，并取出其中的项号。
 *
 * 报告某一项已完成不算问题，需要检出的是同一项被反复用作开场白：
 * 「继续第 4 项验证：写脚本」「继续第 4 项验证：运行脚本」。
 * 待办清单每轮重新发送，不加禁止时模型每次调用工具前都会复述一遍。
 */
const CONTINUE_RE = /继续(?:执行)?第\s*([0-9一二三四五六七八九十]+)\s*(?:项|条|步)/g

/** 被重复用作开场白的编号及各自的重复次数。 */
function repeatedOpeners(text: string): [string, number][] {
  const count = new Map<string, number>()
  for (const m of text.matchAll(CONTINUE_RE)) {
    const n = m[1] as string
    count.set(n, (count.get(n) ?? 0) + 1)
  }
  return [...count].filter(([, c]) => c > 1)
}

/**
 * 每个 run 独立检查重复开头。两个不同任务各出现一次「第 5 条」不算重复。
 */
export function repeatedOpenersInRuns(texts: string[]): [number, string, number][] {
  return texts.flatMap((text, index) =>
    repeatedOpeners(text).map(([item, count]): [number, string, number] => [
      index + 1,
      item,
      count,
    ]),
  )
}

const TASKS = {
  /**
   * 权限边界。
   *
   * 上下文末尾已写明 auto 模式拒绝哪些操作。检查模型是直接依据该句回答，
   * 还是先调用一次工具、取得拒绝后再回答：后者每次多消耗一轮 token。
   */
  permission:
    '不要动手做任何事，直接回答：你现在这条会话处在什么权限模式下？' +
    '这个模式下有哪些操作会被拒绝？',

  /**
   * 用户明确要求写入长期记忆。
   *
   * 措辞无歧义：「写进你的长期记忆」直接对应 write_memory。
   * 该轮未写入才是缺陷；模型在其他轮次自主判断是否沉淀，另行统计。
   */
  memory: '把这条写进你的长期记忆：本项目一律用 bun，不要用 npm。',

  /**
   * 能力段里的定时任务。
   *
   * 与记忆分为两轮：合并在一句中时，无法从工具序列判断模型遗漏了哪一项。
   */
  capability: '每天早上九点提醒我跑一次测试。',

  /**
   * 多步任务，验证模型不复述待办。
   *
   * 六步，其中两步各需两次工具调用：四步的短任务无法复现「同一清单项内
   * 连续调用两次工具、每次先报告进行到第几项」的形状，而该形状正是需要检出的。
   */
  todos:
    '在工作区里按顺序做六件事，每做完一件就更新一次待办清单：' +
    '1) 新建 a.txt 写入 alpha；2) 新建 b.txt 写入 beta；3) 新建 c.txt 写入 gamma；' +
    '4) 把 a.txt 改成 ALPHA，改完读回来确认；5) 把 b.txt 改成 BETA，改完读回来确认；' +
    '6) 用 grep 逐个核对三个文件的内容，然后报告。',

  /** 第一份清单完成后的第二个长任务，用于复现「二次指令不新建 Todo」。 */
  todosFollowup:
    '上一项工作已经结束。现在开始一项新的六步任务，每做完一件就更新一次待办清单：' +
    '1) 新建 d.txt 写入 delta；2) 新建 e.txt 写入 epsilon；3) 新建 f.txt 写入 zeta；' +
    '4) 把 d.txt 改成 DELTA，改完读回来确认；5) 把 e.txt 改成 EPSILON，改完读回来确认；' +
    '6) 用 grep 逐个核对 d.txt、e.txt、f.txt 的内容，然后报告。',

  /**
   * 派发子 agent。
   *
   * 验证模型把「不填 model」写成字符串 `"null"` 时不再派发任务失败。
   */
  delegate:
    '派两个子 agent 并行去做：一个数一下工作区里有几个 .txt 文件，' +
    '另一个报告 a.txt 的内容。不要指定模型，用当前会话的模型。',

  /**
   * 修改范围。
   *
   * 用户明确要求「只改这一处」，检查模型是否连带改动其他文件。
   */
  scope: '把 b.txt 的内容改成 BETA。只改这一个文件，别的什么都不要动。',
}

async function runFor(store: Store, config: QyConfig, ref: ModelRef): Promise<Verdict> {
  const name = `${ref.provider}/${ref.model}`
  const v: Verdict = { ref: name, turns: 0, checks: [], cachedRatio: null, conversationId: '' }
  const ws = wsFor(ref)
  // 只清理当前模型的 fixture：分批运行模型时，先前已完成的验收工作区必须保留。
  await rm(ws, { recursive: true, force: true })
  await mkdir(ws, { recursive: true })
  await writeFile(join(ws, 'README.txt'), `提示词真实模型验证的工作区。${NL}`, 'utf8')
  const live = start(store, config, ws)
  try {
    const conv = await newConversation(live, `提示词验证 · ${name}`)
    if (!conv) throw new Error('创建会话失败')
    v.conversationId = conv
    await setModel(live, conv, ref)

    // 记录每轮的 runId：按轮取得工具序列，才能区分「明确要求」与「自主判断」。
    const runOf: Record<string, RunId | null> = {}
    let firstTodosComplete = false
    for (const [key, task] of Object.entries(TASKS)) {
      const id = await turn(live, conv, task)
      // 未取得 runId 说明该轮未启动 run。立即抛错，避免其表现为多条「模型未调用工具」失败。
      if (!id) throw new Error(`${key} 轮未启动 run`)
      runOf[key] = id
      v.turns++
      if (key === 'todos') {
        const current = latestTodos(store, conv as ConversationId)
        firstTodosComplete = Boolean(
          current?.length && current.every((todo) => todo.status === 'completed'),
        )
      }
    }

    const text = saidBy(store, conv, 'text')
    const tools = toolCalls(store, conv)
    const outputs = toolOutputs(store, conv)
    const add = (n: string, ok: boolean, d = '') => v.checks.push({ name: n, ok, detail: d })

    // 权限段：能答出模式名，且该轮答案不是通过试错得出的。
    add(
      '能答出权限模式（上下文末尾告知生效）',
      /auto|自动|完全访问|full/i.test(text),
      text.slice(0, 120).replace(/\s+/g, ' '),
    )
    add(
      '权限轮未先触发一次被拒的工具调用',
      !/denied|被拒|拒绝执行/.test(outputs.split(NL).slice(0, 6).join(NL)),
    )

    /*
     * 记忆分两条，判据不同。
     *
     * 明确要求的那一轮未写入才是缺陷：用户要求「写进你的长期记忆」，写成工作区
     * 中的文件即为未遵循。其余各轮自主写入的条数只报告、不判定：是否沉淀由模型自行
     * 判断，按断言计分等于要求模型每轮都写入。
     */
    const namedRun = toolCallsIn(store, runOf.memory ?? null)
    add(
      '明确要求时写入了长期记忆',
      namedRun.includes('write_memory'),
      namedRun.join(',') || '该轮未调用任何工具',
    )
    const spontaneous = Object.entries(runOf)
      .filter(([k]) => k !== 'memory')
      .reduce(
        (n, [, id]) => n + toolCallsIn(store, id).filter((t) => t === 'write_memory').length,
        0,
      )
    add('自主沉淀（不计失败）', true, `其余各轮自主写入 ${spontaneous} 条`)
    add('能力段·定时：调用了 create_schedule', tools.includes('create_schedule'))
    add('能力段·派发：调用了 subagent', tools.includes('subagent'))
    const firstTodoTools = toolCallsIn(store, runOf.todos ?? null)
    const followupTodoTools = toolCallsIn(store, runOf.todosFollowup ?? null)
    const followupContext = listRunContextSnapshots(store, conv as ConversationId).find(
      (snapshot) => snapshot.runId === runOf.todosFollowup,
    )
    const oldTodoProjected = followupContext?.segments.some(
      (segment) =>
        segment.content.includes('## 当前待办清单') ||
        segment.content.includes('新建 a.txt 写入 alpha'),
    )
    const finalTodos = latestTodos(store, conv as ConversationId)
    add('首个长任务建立了 Todo', firstTodoTools.includes('write_todos'))
    add('首个长任务的 Todo 全部完成', firstTodosComplete)
    add('二次指令的 run 快照未继承已完成的旧清单', oldTodoProjected === false)
    add('二次长任务重新建立了 Todo', followupTodoTools.includes('write_todos'))
    add(
      '二次长任务的 Todo 全部完成',
      Boolean(finalTodos?.length && finalTodos.every((todo) => todo.status === 'completed')),
    )

    // 只检查正文中同一项被反复用作开场白；思考中的次数一并报告，但不判定失败。
    const runIds = Object.values(runOf)
    const repeated = repeatedOpenersInRuns(runIds.map((id) => saidIn(store, id, 'text')))
    const inThinking = repeatedOpenersInRuns(
      runIds.map((id) => saidIn(store, id, 'thinking')),
    ).length
    add(
      '正文未反复以同一项作为开场白',
      repeated.length === 0,
      repeated.length
        ? repeated.map(([run, item, count]) => `第 ${run} 轮·第 ${item} 条 ×${count}`).join('、')
        : `思考中 ${inThinking} 条重复（不计失败）`,
    )

    // 子 agent 的 model 归一化：不应再出现「配置中没有模型 null」。
    add('派发未因 model=null 失败', !/配置中没有模型\s*(null|undefined)/.test(outputs))

    v.cachedRatio = cachedRatio(store, conv)
    add(
      '缓存命中（冻结前缀未被打乱）',
      (v.cachedRatio ?? 0) > 0,
      `命中占比 ${((v.cachedRatio ?? 0) * 100).toFixed(1)}%`,
    )
  } catch (err) {
    v.error = err instanceof Error ? err.message : String(err)
  } finally {
    live.close()
  }
  return v
}

async function main(): Promise<number> {
  const config = await loadConfig()
  // 写入主库，执行完毕后可在面板中查看每一轮。
  const store = new Store({ path: dataPath() })

  const args = process.argv.slice(2)
  const refs: ModelRef[] = args.length
    ? args.map((a) => {
        const i = a.indexOf('/')
        return { provider: a.slice(0, i), model: a.slice(i + 1) }
      })
    : Object.entries(config.providers).flatMap(([provider, p]) =>
        Object.keys(p.models).map((model) => ({ provider, model })),
      )

  line(`共 ${refs.length} 个模型，每个 ${Object.keys(TASKS).length} 轮真实请求。`)
  const all: Verdict[] = []
  for (const ref of refs) {
    line('')
    line(`── ${ref.provider}/${ref.model} ──`)
    const v = await runFor(store, config, ref)
    all.push(v)
    if (v.error) {
      line(`  ✗ 执行失败：${v.error}（已完成 ${v.turns} 轮）`)
      continue
    }
    for (const c of v.checks) {
      line(`  ${c.ok ? '✓' : '✗'} ${c.name}${c.detail ? `　· ${c.detail}` : ''}`)
    }
    line(`  · 会话 ${v.conversationId}`)
  }

  line('')
  line('══ 汇总 ══')
  const alive = all.filter((v) => !v.error)
  for (const v of all) {
    if (v.error) {
      line(`  ${v.ref.padEnd(38)} 执行失败：${v.error}`)
      continue
    }
    const pass = v.checks.filter((c) => c.ok).length
    const ratio = v.cachedRatio === null ? '—' : `${(v.cachedRatio * 100).toFixed(1)}%`
    line(`  ${v.ref.padEnd(38)} ${pass}/${v.checks.length} 通过　缓存命中 ${ratio}`)
  }
  // 逐项统计在多少个模型上未通过：某一项在全部模型上均未通过说明是提示词的问题，
  // 只在个别模型上未通过说明是该模型的遵循程度。
  if (alive.length) {
    line('')
    line('各项跨模型结果：')
    for (const c of alive[0]!.checks) {
      const ok = alive.filter((v) => v.checks.find((x) => x.name === c.name)?.ok).length
      line(`  ${ok === alive.length ? '✓' : ok === 0 ? '✗' : '△'} ${c.name}　${ok}/${alive.length}`)
    }
  }

  store.close()
  const failed = alive.filter((v) => v.checks.some((c) => !c.ok)).length
  line('')
  line(
    alive.length === 0
      ? '没有模型执行成功'
      : failed === 0
        ? '全部通过'
        : `${failed} 个模型有未通过项`,
  )
  return alive.length > 0 && failed === 0 ? 0 : 1
}

if (import.meta.main) process.exit(await main())
