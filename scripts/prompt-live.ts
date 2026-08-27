#!/usr/bin/env bun
/**
 * 三层提示词与尾区注记的真机验证。
 *
 * **为什么单测不够。** 单测只能断言提示词里有哪几个字，答不了「模型看了以后照做没有」。
 * 这里验的是行为：告诉它权限模式之后它还撞不撞、能力段列了子 agent 之后它派不派、
 * 待办那两句禁止复述之后它还写不写「继续执行第 N 项」。
 *
 * 会话落在**主库**，跑完能在面板里逐条翻开看。工作区是 `.tmp/prompt-live`，
 * 面板上会多出一个同名 work。
 *
 *   bun run scripts/prompt-live.ts                       # 配置里全部模型
 *   bun run scripts/prompt-live.ts deepseek/deepseek-v4-pro   # 指定几个
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AgentEvent, ConversationId, EventEnvelope, RunId } from '@qywork/core'
import { dataPath, loadConfig, type ModelRef, type QyConfig } from '@qywork/runtime'
import { serve } from '@qywork/server'
import { listProviderRequests, listRuns, listSteps, Store } from '@qywork/store'

const WS_DIR = join(import.meta.dir, '..', '.tmp', 'prompt-live')
/** 换行。写进模板串里，避免转义在工具链上被折半。 */
const NL = String.fromCharCode(10)
const RUN_TIMEOUT_MS = 300_000

interface Verdict {
  ref: string
  turns: number
  /** 每条断言的名字与结果。跑挂的模型这里是空的，由 `error` 说明。 */
  checks: { name: string; ok: boolean; detail: string }[]
  cachedRatio: number | null
  conversationId: string
  error?: string
}

function line(s: string): void {
  process.stdout.write(s + NL)
}

/** 起一轮对话并等它跑完。返回这一轮的 runId。 */
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
    else if (ev.type === 'run.finished' || ev.type === 'run.error') done.resolve()
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
  const timer = setTimeout(() => done.reject(new Error('这一轮超时')), RUN_TIMEOUT_MS)
  try {
    await done.promise
  } finally {
    clearTimeout(timer)
    ws.close()
  }
  return runId
}

interface Live {
  base: string
  token: string
  close: () => void
}

function start(store: Store, config: QyConfig): Live {
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

/**
 * 这条会话里模型说过的话，按 step 类型分开。
 *
 * **正文与思考必须分开量。** 禁止复述待办管的是用户读到的那段正文；
 * 思考里规划「下一步做第几条」是正常推理，一起禁会伤到它的执行能力。
 */
function saidBy(store: Store, conversationId: string, kind: 'text' | 'thinking'): string {
  return listRuns(store, conversationId as ConversationId)
    .flatMap((r) => listSteps(store, r.id))
    .filter((s) => s.kind === kind)
    .map((s) => s.content ?? '')
    .join(NL)
}

/** 这条会话里调过的所有工具名，按顺序。 */
function toolCalls(store: Store, conversationId: string): string[] {
  return listRuns(store, conversationId as ConversationId)
    .flatMap((r) => listSteps(store, r.id))
    .filter((s) => s.toolName !== null)
    .map((s) => s.toolName as string)
}

/** 这条会话里所有工具结果的正文，用来找「被拒」与错误原文。 */
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
 * 「继续执行第 N 项」这个开场白，连同它指的是第几项。
 *
 * **报某一条做完了不算问题**，要挡的是同一条被反复拿来开场：
 * 「继续第 4 项验证：写脚本」「继续第 4 项验证：运行脚本」——
 * 待办清单每轮重发，不禁止的话模型每次调工具前都把它念一遍。
 */
const CONTINUE_RE = /继续(?:执行)?第\s*([0-9一二三四五六七八九十]+)\s*(?:项|条|步)/g

/** 被重复开场的编号，以及各自重复了几次。 */
function repeatedOpeners(text: string): [string, number][] {
  const count = new Map<string, number>()
  for (const m of text.matchAll(CONTINUE_RE)) {
    const n = m[1] as string
    count.set(n, (count.get(n) ?? 0) + 1)
  }
  return [...count].filter(([, c]) => c > 1)
}

const TASKS = {
  /**
   * 第 1 轮：权限边界。
   *
   * 尾区已经写明 auto 模式拒什么。看它是直接依据那句话回答，
   * 还是先去撞一次工具、拿到拒绝再回答——后者每次多付一轮 token。
   */
  permission:
    '不要动手做任何事，直接回答：你现在这条会话处在什么权限模式下？' +
    '这个模式下有哪些操作会被拒绝？',

  /**
   * 第 2 轮：能力段里的记忆与定时。
   *
   * 说的是一件跨会话有效的事实 + 一件按时重复的事，两条能力段各点一条。
   */
  capability:
    '这个项目以后一律用 bun，不要用 npm——这条记下来，下次开会话也要知道。' +
    '另外每天早上九点提醒我跑一次测试。',

  /**
   * 第 3 轮：多步任务，验待办不复述。
   *
   * **六步且其中两步各要两次工具调用**：四步的短任务复现不出「同一条清单项内
   * 连着调两次工具、每次都先报一遍进行到第几项」这个形状，而那正是要挡的形状。
   */
  todos:
    '在工作区里按顺序做六件事，每做完一件就更新一次待办清单：' +
    '1) 新建 a.txt 写入 alpha；2) 新建 b.txt 写入 beta；3) 新建 c.txt 写入 gamma；' +
    '4) 把 a.txt 改成 ALPHA，改完读回来确认；5) 把 b.txt 改成 BETA，改完读回来确认；' +
    '6) 用 grep 逐个核对三个文件的内容，然后报告。',

  /**
   * 第 4 轮：派子 agent。
   *
   * 验的是模型把「不填 model」写成字符串 `"null"` 时不再派活失败。
   */
  delegate:
    '派两个子 agent 并行去做：一个数一下工作区里有几个 .txt 文件，' +
    '另一个报告 a.txt 的内容。不要指定模型，用当前会话的模型。',

  /**
   * 第 5 轮：修改力度。
   *
   * 明确说了「只改这一处」，看它有没有连带改动别的文件。
   */
  scope: '把 b.txt 的内容改成 BETA。只改这一个文件，别的什么都不要动。',
}

async function runFor(store: Store, config: QyConfig, ref: ModelRef): Promise<Verdict> {
  const name = `${ref.provider}/${ref.model}`
  const v: Verdict = { ref: name, turns: 0, checks: [], cachedRatio: null, conversationId: '' }
  const live = start(store, config)
  try {
    const conv = await newConversation(live, `提示词真机 · ${name}`)
    if (!conv) throw new Error('建会话失败')
    v.conversationId = conv
    await setModel(live, conv, ref)

    for (const [, task] of Object.entries(TASKS)) {
      await turn(live, conv, task)
      v.turns++
    }

    const text = saidBy(store, conv, 'text')
    const thinking = saidBy(store, conv, 'thinking')
    const tools = toolCalls(store, conv)
    const outputs = toolOutputs(store, conv)
    const add = (n: string, ok: boolean, d = '') => v.checks.push({ name: n, ok, detail: d })

    // 权限段：说得出模式名，且这一轮没有靠撞出来。
    add(
      '权限模式答得出来（尾区告知生效）',
      /auto|自动|完全访问|full/i.test(text),
      text.slice(0, 120).replace(/\s+/g, ' '),
    )
    add(
      '权限那一轮没有先撞一次被拒的工具',
      !/denied|被拒|拒绝执行/.test(outputs.split(NL).slice(0, 6).join(NL)),
    )

    // 能力段：记忆与定时两条各要命中一次。
    add('能力段·记忆：调了 write_memory', tools.includes('write_memory'), tools.join(','))
    add('能力段·定时：调了 create_schedule', tools.includes('create_schedule'))
    add('能力段·派活：调了 subagent', tools.includes('subagent'))
    add('能力段·待办：调了 write_todos', tools.includes('write_todos'))

    // 只卡正文里同一条被反复开场；思考里的次数一并报出来，但不判失败。
    const repeated = repeatedOpeners(text)
    const inThinking = repeatedOpeners(thinking).length
    add(
      '正文没有把同一条反复拿来开场',
      repeated.length === 0,
      repeated.length
        ? repeated.map(([n, c]) => `第 ${n} 条 ×${c}`).join('、')
        : `思考里 ${inThinking} 条重复（不计失败）`,
    )

    // 子 agent 的 model 归一化：不该再出现「配置里没有模型 null」。
    add('派活没有因为 model=null 失败', !/配置里没有模型\s*(null|undefined)/.test(outputs))

    v.cachedRatio = cachedRatio(store, conv)
    add(
      '缓存有命中（冻结前缀没被打散）',
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
  await rm(WS_DIR, { recursive: true, force: true })
  await mkdir(WS_DIR, { recursive: true })
  await writeFile(join(WS_DIR, 'README.txt'), `提示词真机验证的工作区。${NL}`, 'utf8')

  const config = await loadConfig()
  // 落主库，跑完能在面板里翻开看每一轮。
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
      line(`  ✗ 跑挂了：${v.error}（跑完 ${v.turns} 轮）`)
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
      line(`  ${v.ref.padEnd(38)} 跑挂：${v.error}`)
      continue
    }
    const pass = v.checks.filter((c) => c.ok).length
    const ratio = v.cachedRatio === null ? '—' : `${(v.cachedRatio * 100).toFixed(1)}%`
    line(`  ${v.ref.padEnd(38)} ${pass}/${v.checks.length} 通过　缓存命中 ${ratio}`)
  }
  // 逐条看哪一项在多少个模型上没过：某一项全线不过说明是提示词的问题，
  // 只在个别模型上不过说明是那个模型的服从度。
  if (alive.length) {
    line('')
    line('逐项跨模型：')
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
      ? '没有一个模型跑通'
      : failed === 0
        ? '全部通过'
        : `${failed} 个模型有未通过项`,
  )
  return alive.length > 0 && failed === 0 ? 0 : 1
}

process.exit(await main())
