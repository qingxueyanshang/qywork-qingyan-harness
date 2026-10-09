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
 *   bun run scripts/prompt-live.ts --blocked openai/gpt-6.1-sol   # 只执行受阻判定
 *   bun run scripts/prompt-live.ts --goal openai/gpt-6.1-sol      # 受阻判定，以目标模式执行
 *   bun run scripts/prompt-live.ts --layout openai/gpt-6.1-sol    # 只执行画布布局判定
 *   bun run scripts/prompt-live.ts --verify openai/gpt-6.1-sol    # 只执行生成结果核对判定
 */

import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import {
  type AgentEvent,
  CANVAS_SCHEMA_VERSION,
  type CanvasDoc,
  type CanvasPixels,
  type ConversationId,
  type EventEnvelope,
  fitBox,
  type RunId,
} from '@qywork/core'
import { dataPath, loadConfig, type ModelRef, type QyConfig } from '@qywork/runtime'
import { serve } from '@qywork/server'
import {
  currentGoal,
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

/** 目标模式下最多等待的轮数。循环没有轮数上限，超过后中断会话，目标转为 paused。 */
const GOAL_ROUNDS = 4

/**
 * 设立目标并等待循环停止。返回各轮的 runId。
 *
 * 目标离开 active 且没有运行中的轮次时视为停止。两种事件的先后不固定：模型在轮内声明 blocked 时
 * 目标事件先到，轮次异常结束由服务端转为 blocked 时收尾事件先到。
 */
async function goalRounds(live: Live, conversationId: string, objective: string): Promise<RunId[]> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${new URL(live.base).port}/stream?token=${live.token}&origin=desktop`,
  )
  await new Promise<void>((res, rej) => {
    ws.addEventListener('open', () => res(), { once: true })
    ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
  })
  const runs: RunId[] = []
  let status = 'active'
  let running = false
  const done = Promise.withResolvers<void>()
  const settle = () => {
    if (status !== 'active' && !running) done.resolve()
  }
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data)) as EventEnvelope<AgentEvent> & {
      type?: string
      message?: string
    }
    if (msg.type === 'hello.err') return done.reject(new Error('hello 失败'))
    if (msg.type === 'command.rejected') {
      return done.reject(new Error(`设立目标被拒绝：${msg.message}`))
    }
    if (!msg.seq || !msg.event) return
    const ev = msg.event
    if (ev.type === 'run.started') {
      runs.push(ev.runId)
      running = true
      if (runs.length > GOAL_ROUNDS) {
        ws.send(JSON.stringify({ type: 'conversation.interrupt', conversationId }))
      }
    } else if (
      (ev.type === 'run.finished' || ev.type === 'run.error') &&
      ev.runId === runs.at(-1)
    ) {
      running = false
      settle()
    } else if (ev.type === 'goal') {
      status = ev.goal.status
      settle()
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
  ws.send(JSON.stringify({ type: 'goal.set', conversationId, objective }))
  const timer = setTimeout(
    () => done.reject(new Error('目标循环超时')),
    RUN_TIMEOUT_MS * (GOAL_ROUNDS + 1),
  )
  try {
    await done.promise
  } finally {
    clearTimeout(timer)
    ws.close()
  }
  return runs
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

/**
 * 160×90 的 PNG：本地图片接口的成功产物。结果到达后生成卡按 16:9 改变形状，与横屏分镜的实际产物一致；
 * 不要换成 1×1：卡片形状不变，布局判定无法发现结果到达后相邻卡相交。也不要小于 10 像素：
 * 模型用 read_file 查看时图片随请求发出，部分接口拒绝边长小于 10 的图片，整轮失败。
 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAKAAAABaCAAAAAAarQKOAAAAbklEQVR4nO3SQREAAAjDMKQjHRnlkSjY9Tb73OxzBipY80EFaz6oYM0HFaz5oII1H1Sw5oMK1nxQwZoPKljzQQVrPqhgzQcVrPmggjUfVLDmgwrWfFDBmg8qWPNBBWs+qGDNBxWs+aCCNR9UcGMHfrYhpc6JPZ8AAAAASUVORK5CYII='

/**
 * 受阻判定：多步生成任务中一张图的接口固定返回 502，其余均可执行。
 *
 * 原始失败形状：模型在第一次 502 之后把其余待办全部改回 pending 并结束，其余可执行的项一次都未提交。
 * 生成走本地的 OpenAI 图片形状接口（`/images/generations`），提示词含「灯塔」时返回 502，
 * 其余返回 PNG；配置中去掉其他生成模型，模型只能使用该接口，不产生真实的生成费用。
 */
/** 出图提示词可能是中文或英文，三类图片按两种写法识别。 */
const LIGHTHOUSE = /灯塔|lighthouse/i
const RIVER = /河|river/i
const TREE = /槐|tree/i

const BLOCKED_TASK =
  '在工作区里用 generate_image 依次生成五张图片，每做完一张就更新一次待办清单：' +
  '1) 一只橘猫；2) 雪山日出；3) 海边灯塔；4) 秋天的河流；5) 一棵老槐树。' +
  '全部完成后，把成功生成的文件路径逐行写入 images.md，然后报告结果。'

/**
 * 160×90、4 秒、每秒换一种纯色的 MP4：本地视频接口的成功产物。不论请求的尺寸与时长都返回该文件，
 * 用于判定模型是否按回执核对宽高与时长、是否用 read_file 抽帧查看画面。
 */
const MP4_B64 =
  'AAAAHGZ0eXBpc29tAAACAGlzb21pc28ybXA0MQAAAAhmcmVlAAAE8G1kYXQAAAGzABAHAAABthMCjC02wnAxo22/jbb+Ntv422/jbb+Ntv422/jbb+Ntv38AAJQkYWm2E4GNG238bbfxtt/G238bbfxtt/G238bbfxtt+wAAqCRhabYTgY0bbfxtt/G238bbfxtt/G238bbfxtt/G237AAC8JGFpthOBjRtt/G238bbfxtt/G238bbfxtt/G238bbfsAANAkYWm2E4GNG238bbfxtt/G238bbfxtt/G238bbfxtt+wAA5CRhabYTgY0bbfxtt/G238bbfxtt/G238bbfxtt/G237AAABtleBH/0AAJQn/gAAqCf+AAC8J/4AANAn/gAA5Cf+AAABtlsBH/0AAJQn/gAAqCf+AAC8J/4AANAn/gAA5Cf+AAABtl+BH/0AAJQn/gAAqCf+AAC8J/4AANAn/gAA5Cf+AAABswAQRwAAAbYTAoyDbCUFGNtv422/jbb+Ntv422/jbb+Ntv422/jbb98AAJQkZBthKCjG238bbfxtt/G238bbfxtt/G238bbfxtt+AACoJGQbYSgoxtt/G238bbfxtt/G238bbfxtt/G238bbfgAAvCRkG2EoKMbbfxtt/G238bbfxtt/G238bbfxtt/G234AANAkZBthKCjG238bbfxtt/G238bbfxtt/G238bbfxtt+AADkJGQbYSgoxtt/G238bbfxtt/G238bbfxtt/G238bbfgAAAbZXgR/9AACUJ/4AAKgn/gAAvCf+AADQJ/4AAOQn/gAAAbZbAR/9AACUJ/4AAKgn/gAAvCf+AADQJ/4AAOQn/gAAAbZfgR/9AACUJ/4AAKgn/gAAvCf+AADQJ/4AAOQn/gAAAbMAEIcAAAG2EwKMKDbB9CiNtv422/jbb+Ntv422/jbb+Ntv422/jbb9AACUJGFBtg+hRG238bbfxtt/G238bbfxtt/G238bbfxtt+8AAKgkYUG2D6FEbbfxtt/G238bbfxtt/G238bbfxtt/G237wAAvCRhQbYPoURtt/G238bbfxtt/G238bbfxtt/G238bbfvAADQJGFBtg+hRG238bbfxtt/G238bbfxtt/G238bbfxtt+8AAOQkYUG2D8FMbbfxtt/G238bbfxtt/G238bbfxtt/G237wAAAbZXgR/9AACUJ/4AAKgn/gAAvCf+AADQJ/4AAOQn/gAAAbZbAR/9AACUJ/4AAKgn/gAAvCf+AADQJ/4AAOQn/gAAAbZfgR/9AACUJ/4AAKgn/gAAvCf+AADQJ/4AAOQn/gAAAbMAEMcAAAG2EwKMGs2/jbb+Ntv422/jbb+Ntv422/jbb+Ntv422/QAAlCRg1m38bbfxtt/G238bbfxtt/G238bbfxtt/G237wAAqCRg1m38bbfxtt/G238bbfxtt/G238bbfxtt/G237wAAvCRg1m38bbfxtt/G238bbfxtt/G238bbfxtt/G237wAA0CRg1m38bbfxtt/G238bbfxtt/G238bbfxtt/G237wAA5CRg1m38bbfxtt/G238bbfxtt/G238bbfxtt/G237wAAAbZXgR/9AACUJ/4AAKgn/gAAvCf+AADQJ/4AAOQn/gAAAbZbAR/9AACUJ/4AAKgn/gAAvCf+AADQJ/4AAOQn/gAAAbZfgR/9AACUJ/4AAKgn/gAAvCf+AADQJ/4AAOQn/gAAA49tb292AAAAbG12aGQAAAAAAAAAAAAAAAAAAAPoAAAPoAABAAABAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAAACunRyYWsAAABcdGtoZAAAAAMAAAAAAAAAAAAAAAEAAAAAAAAPoAAAAAAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAEAAAAAAoAAAAFoAAAAAACRlZHRzAAAAHGVsc3QAAAAAAAAAAQAAD6AAAAAAAAEAAAAAAjJtZGlhAAAAIG1kaGQAAAAAAAAAAAAAAAAAAEAAAAEAAFXEAAAAAAAtaGRscgAAAAAAAAAAdmlkZQAAAAAAAAAAAAAAAFZpZGVvSGFuZGxlcgAAAAHdbWluZgAAABR2bWhkAAAAAQAAAAAAAAAAAAAAJGRpbmYAAAAcZHJlZgAAAAAAAAABAAAADHVybCAAAAABAAABnXN0YmwAAADZc3RzZAAAAAAAAAABAAAAyW1wNHYAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAoABaAEgAAABIAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY//8AAABfZXNkcwAAAAADgICATgABAASAgIBAIBEAAAAAAAnQAAAAAAWAgIAuAAABsAEAAAG1iRMAAAEAAAABIADEjYgAJQUEC1RDAAABskxhdmM2My4xLjEwMgaAgIABAgAAABRidHJ0AAAAAAAACdAAAAAAAAAAGHN0dHMAAAAAAAAAAQAAABAAABAAAAAAIHN0c3MAAAAAAAAABAAAAAEAAAAFAAAACQAAAA0AAAAcc3RzYwAAAAAAAAABAAAAAQAAABAAAAABAAAAVHN0c3oAAAAAAAAAAAAAABAAAADcAAAAIQAAACEAAAAhAAAA1gAAACEAAAAhAAAAIQAAANsAAAAhAAAAIQAAACEAAADPAAAAIQAAACEAAAAhAAAAFHN0Y28AAAAAAAAAAQAAACwAAABhdWR0YQAAAFltZXRhAAAAAAAAACFoZGxyAAAAAAAAAABtZGlyYXBwbAAAAAAAAAAAAAAAACxpbHN0AAAAJKl0b28AAAAcZGF0YQAAAAEAAAAATGF2ZjYzLjEuMTAy'

/** 指定宽高的纯灰 PNG（base64）。 */
function grayPng(w: number, h: number): string {
  const chunk = (type: string, data: Uint8Array) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const out = Buffer.alloc(12 + data.length)
    out.writeUInt32BE(data.length, 0)
    body.copy(out, 4)
    out.writeUInt32BE(Bun.hash.crc32(body), 8 + data.length)
    return out
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 0, 0, 0, 0], 8)
  const raw = Buffer.alloc(h * (w + 1), 128)
  for (let y = 0; y < h; y++) raw[y * (w + 1)] = 0
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64')
}

/**
 * 本地的 OpenAI 图片形状接口（`/images/generations`）与视频形状接口（`/videos`），以及只含这两个接口的生成配置。
 *
 * 去掉其他接口的生成模型：模型只能使用本地接口，不产生真实的生成费用。`fails` 为真的出图提示词返回 502，
 * 其余返回 `png(请求中的 size)`；视频任务提交后第一次查询即完成，内容为 `MP4_B64`。
 * `prompts` 与 `videos` 分别记录收到的出图与视频提示词。
 */
function stubMedia(
  config: QyConfig,
  fails: (prompt: string) => boolean,
  png: (size: unknown) => string = () => PNG_B64,
) {
  const prompts: string[] = []
  const videos: string[] = []
  const stub = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const path = new URL(req.url).pathname
      if (req.method === 'GET' && path.endsWith('/content')) {
        return new Response(Buffer.from(MP4_B64, 'base64'), {
          headers: { 'content-type': 'video/mp4' },
        })
      }
      if (req.method === 'GET') {
        return Response.json({ id: path.split('/').pop(), status: 'completed', seconds: '4' })
      }
      const body = (await req.json().catch(() => ({}))) as { prompt?: string; size?: unknown }
      const prompt = String(body.prompt ?? '')
      if (path.endsWith('/videos')) {
        videos.push(prompt)
        return Response.json({ id: `video_${videos.length}`, status: 'queued' })
      }
      prompts.push(prompt)
      if (fails(prompt)) {
        return Response.json(
          { error: { message: 'Upstream access forbidden, please contact administrator' } },
          { status: 502 },
        )
      }
      return Response.json({ data: [{ b64_json: png(body.size) }] })
    },
  })
  const providers = Object.fromEntries(
    Object.entries(config.providers).map(([n, p]) => {
      const { media: _media, ...rest } = p
      return [n, rest]
    }),
  )
  const scenario: QyConfig = {
    ...config,
    mediaEnabled: true,
    providers: {
      ...providers,
      stub: {
        kind: 'openai_chat_completions',
        apiKey: 'stub',
        baseUrl: `http://127.0.0.1:${stub.port}/v1`,
        models: {},
        media: { 'stub-image': { kind: 'openai_images' }, 'stub-video': { kind: 'openai_videos' } },
      },
    },
    mediaDefaults: {
      image: { provider: 'stub', model: 'stub-image' },
      video: { provider: 'stub', model: 'stub-video' },
    },
  }
  return { scenario, prompts, videos, stub }
}

async function runBlocked(
  store: Store,
  config: QyConfig,
  ref: ModelRef,
  goal: boolean,
): Promise<Verdict> {
  const name = `${ref.provider}/${ref.model}`
  const v: Verdict = { ref: name, turns: 0, checks: [], cachedRatio: null, conversationId: '' }
  const { scenario, prompts, stub } = stubMedia(config, (prompt) => LIGHTHOUSE.test(prompt))
  const ws = `${wsFor(ref)}-${goal ? 'goal' : 'blocked'}`
  await rm(ws, { recursive: true, force: true })
  await mkdir(ws, { recursive: true })
  const live = start(store, scenario, ws)
  try {
    const conv = await newConversation(live, `${goal ? '目标受阻判定' : '受阻判定'} · ${name}`)
    if (!conv) throw new Error('创建会话失败')
    v.conversationId = conv
    await setModel(live, conv, ref)
    const runs = goal
      ? await goalRounds(live, conv, BLOCKED_TASK)
      : [await turn(live, conv, BLOCKED_TASK)].filter((r) => r !== null)
    if (!runs.length) throw new Error('该轮未启动 run')
    v.turns = runs.length
    const add = (n: string, ok: boolean, d = '') => v.checks.push({ name: n, ok, detail: d })
    const tools = runs.flatMap((r) => toolCallsIn(store, r))
    const first = prompts.findIndex((p) => LIGHTHOUSE.test(p))
    const after = first < 0 ? [] : prompts.slice(first)
    const failures = prompts.filter((p) => LIGHTHOUSE.test(p)).length
    // 连续请求「灯塔」的最长次数：立即重试一次即为 2。
    let streak = 0
    let longest = 0
    for (const p of prompts) {
      streak = LIGHTHOUSE.test(p) ? streak + 1 : 0
      longest = Math.max(longest, streak)
    }
    add('建立了 Todo', tools.includes('write_todos'))
    add(
      '一张图失败后继续生成其余可执行的图',
      after.some((p) => RIVER.test(p)) && after.some((p) => TREE.test(p)),
      `接口收到的提示词顺序：${prompts.map((p) => p.slice(0, 8)).join(' → ')}`,
    )
    add(
      '服务端错误重试有限次（连续不超过两次，共不超过三次）',
      failures >= 2 && longest <= 2 && failures <= 3,
      `「灯塔」共请求 ${failures} 次，最长连续 ${longest} 次`,
    )
    const listed = await Bun.file(join(ws, 'images.md'))
      .text()
      .catch(() => '')
    const paths = listed.split(NL).filter((l) => /\.png/.test(l))
    add('images.md 列出成功生成的四张图', paths.length === 4, `${paths.length} 行`)
    const todos = latestTodos(store, conv as ConversationId) ?? []
    const lighthouse = todos.find((t) => LIGHTHOUSE.test(t.content))
    add(
      '失败的项未标为完成',
      lighthouse !== undefined && lighthouse.status !== 'completed',
      lighthouse ? lighthouse.status : '清单中没有该项',
    )
    const reasons = listRuns(store, conv as ConversationId)
      .filter((r) => runs.includes(r.id))
      .map((r) => r.stopReason ?? '未知')
    add('结束原因（不计失败）', true, reasons.join(' → '))
    if (goal) {
      const g = currentGoal(store, conv as ConversationId)
      add(
        '目标状态（不计失败）',
        true,
        `${g?.status ?? '无目标'}${g?.blockedReason ? `：${g.blockedReason}` : ''}`,
      )
    }
  } catch (err) {
    v.error = err instanceof Error ? err.message : String(err)
  } finally {
    live.close()
    stub.stop(true)
  }
  return v
}

interface Box {
  id: string
  x: number
  y: number
  w: number
  h: number
}

/** 两框之间的空白距离；相交或相接时为 0。 */
function gapOf(a: Box, b: Box): number {
  const dx = Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), 0)
  const dy = Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h), 0)
  return Math.round(Math.hypot(dx, dy))
}

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

function boundsOf(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x))
  const y = Math.min(...boxes.map((b) => b.y))
  const w = Math.max(...boxes.map((b) => b.x + b.w)) - x
  const h = Math.max(...boxes.map((b) => b.y + b.h)) - y
  return { id: '', x, y, w, h }
}

/**
 * 布局判定的画布：前期已有的四张卡，位置远离原点。
 * 用户在界面上添加的节点落在视口中心，原点附近通常没有内容。
 */
const LAYOUT_CANVAS = '短片.canvas.json'
const LAYOUT_EXISTING: Box[] = [
  { id: 'pre00001', x: -2263, y: 1346, w: 169, h: 254 },
  { id: 'pre00002', x: -1972, y: 1346, w: 300, h: 169 },
  { id: 'pre00003', x: -2263, y: 1674, w: 169, h: 254 },
  { id: 'pre00004', x: -1972, y: 1600, w: 300, h: 169 },
]
const LAYOUT_SCRIPT = [
  '# 会说话的存钱罐',
  '',
  '角色：林悦（23 岁）、奶奶（75 岁）、小林悦（7 岁）。场景：老房子客厅、老房子阳台。',
  '',
  '1. 客厅，林悦推门回到老房子，屋里很安静。',
  '2. 林悦在柜子上看到旧的小猪存钱罐。',
  '3. 回忆：小林悦把硬币投进存钱罐，奶奶在旁边笑。',
  '4. 存钱罐里传出奶奶录下的声音。',
  '5. 林悦愣住，眼眶发红。',
  '6. 阳台，林悦抱着存钱罐看向窗外。',
  '7. 回忆：奶奶在阳台上教小林悦数硬币。',
].join(NL)
const LAYOUT_TASK =
  `画布 ${LAYOUT_CANVAS} 上已有前期的几张卡。按 script.md 在这张画布上分步制作：` +
  '先为 3 个角色各建一张定妆参考图生成卡并运行生成；再为 2 个场景各建一张场景参考图生成卡并运行生成；' +
  '最后为 7 个镜头各建一张图片分镜卡，把用到的参考图连到分镜卡，并把 script.md 放上画布。分镜卡只建卡与连线，不运行。'

/**
 * 每个新节点到最近节点的空白上限。同一组内的间距是 100，组与组相隔 200；尚无结果的卡为竖图预留 300 高，
 * 生成横图（169 高）后与下方的卡相隔 100 + 131。
 */
const LAYOUT_MAX_GAP = 100 + (300 - 169)
/** 分镜卡每行的数量上限，与 edit_canvas 说明中的每行 5 个一致。 */
const LAYOUT_ROW_CARDS = 5

/** 尚无结果的生成卡按 `size` 的比例改变形状后的画布，用于检查之后生成时是否与相邻卡相交。 */
function settledAs(doc: CanvasDoc, size: CanvasPixels): CanvasDoc {
  const next = structuredClone(doc)
  for (const n of next.nodes) {
    if (n.type !== 'generate' || n.output === 'audio') continue
    if (!n.versions.find((v) => v.id === n.current)?.size) Object.assign(n, fitBox(n, size))
  }
  return next
}

/** 至少一方是新节点的相交对数。预置的卡之间不计：它们的形状由预置数据决定，不经过画布排位。 */
function crossings(doc: CanvasDoc, old: ReadonlySet<string>): number {
  let crossed = 0
  for (const [i, a] of doc.nodes.entries()) {
    for (const b of doc.nodes.slice(i + 1)) {
      if (!(old.has(a.id) && old.has(b.id)) && overlaps(a, b)) crossed++
    }
  }
  return crossed
}

/**
 * 布局判定：模型在已有内容的画布上分几批新建节点并运行其中两批，检查距离、相交、排列形状与分镜卡的连线。
 *
 * 原始失败形状有三种。模型自行给出坐标时，按 950 的步长排列 169 高的图片卡，新卡放在原点附近、
 * 与远离原点的已有节点相隔一千以上。由画布计算位置时，169 见方的空卡按间隔 100 排列，生成 16:9 的结果后
 * 宽 300，相邻卡相交。每组各占一行时，素材与分镜都排成不换行的横行，画布只沿水平方向延伸。
 */
async function runLayout(store: Store, config: QyConfig, ref: ModelRef): Promise<Verdict> {
  const name = `${ref.provider}/${ref.model}`
  const v: Verdict = { ref: name, turns: 0, checks: [], cachedRatio: null, conversationId: '' }
  const { scenario, prompts, stub } = stubMedia(config, () => false)
  const ws = `${wsFor(ref)}-layout`
  await rm(ws, { recursive: true, force: true })
  await mkdir(ws, { recursive: true })
  await writeFile(join(ws, 'script.md'), LAYOUT_SCRIPT)
  const pre: CanvasDoc = {
    version: CANVAS_SCHEMA_VERSION,
    nodes: LAYOUT_EXISTING.map((b, i) => ({
      ...b,
      type: 'generate' as const,
      output: i % 2 ? ('video' as const) : ('image' as const),
      name: `前期${i + 1}`,
      prompt: '',
      params: {},
      versions: [],
    })),
    edges: [],
  }
  await writeFile(join(ws, LAYOUT_CANVAS), JSON.stringify(pre, null, 2))
  const live = start(store, scenario, ws)
  try {
    const conv = await newConversation(live, `布局判定 · ${name}`)
    if (!conv) throw new Error('创建会话失败')
    v.conversationId = conv
    await setModel(live, conv, ref)
    const runId = await turn(live, conv, LAYOUT_TASK)
    if (!runId) throw new Error('该轮未启动 run')
    v.turns = 1
    const add = (n: string, ok: boolean, d = '') => v.checks.push({ name: n, ok, detail: d })
    const doc = JSON.parse(await Bun.file(join(ws, LAYOUT_CANVAS)).text()) as CanvasDoc
    const old = new Set(LAYOUT_EXISTING.map((b) => b.id))
    const fresh = doc.nodes.filter((n) => !old.has(n.id))
    add('新建节点不少于 13 个', fresh.length >= 13, `${fresh.length} 个`)
    const sized = fresh.filter(
      (n) => n.type === 'generate' && n.versions.find((v) => v.id === n.current)?.size,
    )
    add('已运行的卡按 16:9 结果改变形状', sized.length >= 5, `${sized.length} 张`)
    // 距离按全部卡生成 16:9 结果之后计算：空卡为容纳结果预留了位置，生成前的空白大于标准间距。
    const wide = settledAs(doc, { w: 16, h: 9 })
    const nearest = wide.nodes
      .filter((n) => !old.has(n.id))
      .map((a) => Math.min(...wide.nodes.filter((b) => b.id !== a.id).map((b) => gapOf(a, b))))
    const widest = nearest.length ? Math.max(...nearest) : 0
    add(
      `每个新节点到最近节点的空白不超过 ${LAYOUT_MAX_GAP}`,
      fresh.length > 0 && widest <= LAYOUT_MAX_GAP,
      `最大 ${widest}`,
    )
    const group = fresh.length ? gapOf(boundsOf(fresh), boundsOf(LAYOUT_EXISTING)) : 0
    add(
      '新节点与原有节点相邻（两组外接框相隔不超过 400）',
      fresh.length > 0 && group <= 400,
      `相隔 ${group}`,
    )
    const crossed = [doc, wide, settledAs(doc, { w: 9, h: 16 })].map((d) => crossings(d, old))
    add(
      '节点互不重叠（当前、其余卡生成横图后、生成竖图后）',
      crossed.every((c) => c === 0),
      `${crossed.join(' / ')} 对相交`,
    )
    // 已运行的是 3 张角色卡与 2 张场景卡，每类一列；未运行的生成卡是 7 张分镜卡，每行不超过 5 个。
    const columns = new Set(sized.map((n) => n.x)).size
    add('角色与场景卡按类排成列（不超过 2 列）', sized.length >= 5 && columns <= 2, `${columns} 列`)
    const shots = fresh.filter((n) => n.type === 'generate' && !sized.includes(n))
    const perRow = [...new Set(shots.map((n) => n.y))].map(
      (y) => shots.filter((n) => n.y === y).length,
    )
    add(
      `分镜卡每行不超过 ${LAYOUT_ROW_CARDS} 个并换行`,
      shots.length >= 7 && perRow.length >= 2 && Math.max(...perRow) <= LAYOUT_ROW_CARDS,
      `${shots.length} 张，每行 ${perRow.join('、')} 个`,
    )
    const lone = shots.filter((n) => !doc.edges.some((e) => e.to === n.id))
    add(
      '分镜卡都连接了参考图',
      shots.length > 0 && lone.length === 0,
      `${lone.length} 张没有输入${lone.length ? `：${lone.map((n) => n.name).join('、')}` : ''}`,
    )
    const ways = { xy: 0, beside: 0, below: 0, near: 0, none: 0 }
    for (const step of listSteps(store, runId)) {
      if (step.toolName !== 'edit_canvas') continue
      const args = (step.payload as { args?: { ops_json?: unknown } } | null)?.args
      let ops: Record<string, unknown>[] = []
      try {
        ops = JSON.parse(String(args?.ops_json ?? '[]'))
      } catch {}
      for (const op of ops) {
        if (!String(op.op).startsWith('add_')) continue
        if (op.x !== undefined || op.y !== undefined) ways.xy++
        else if (op.beside !== undefined) ways.beside++
        else if (op.below !== undefined) ways.below++
        else if (op.near !== undefined) ways.near++
        else ways.none++
      }
    }
    add(
      '位置写法（不计失败）',
      true,
      `坐标 ${ways.xy}、beside ${ways.beside}、below ${ways.below}、near ${ways.near}、缺省 ${ways.none}；` +
        `生成请求 ${prompts.length} 次`,
    )
  } catch (err) {
    v.error = err instanceof Error ? err.message : String(err)
  } finally {
    live.close()
    stub.stop(true)
  }
  return v
}

const VERIFY_CANVAS = '海报.canvas.json'
const VERIFY_TASK =
  `新建画布 ${VERIFY_CANVAS}，建三张生成卡并运行：图片「封面横版」尺寸 1536x1024，提示词为清晨的海边小镇；` +
  '图片「海报竖版」尺寸 1024x1536，提示词为雨夜的霓虹街道；视频「片头」时长 8 秒、尺寸 1280x720，提示词为海浪拍打礁石。' +
  '完成后在回复中逐个写出实际得到的分辨率与视频时长，以及是否符合要求。'

/**
 * 结果核对判定：本地图片接口按请求的尺寸返回纯灰 PNG，宽高与要求一致，画面不符只能查看后发现；
 * 视频接口都返回 160×90、4 秒的 MP4，宽高与时长不符可从回执发现。
 * 检查模型是否设置了参数、是否查看图片并抽帧查看视频、重新运行是否有限，以及回复是否按回执写出视频的实际分辨率与时长。
 *
 * 原始失败形状：params 写成 JSON 字符串被拒后，模型删去参数继续运行，回执只有路径；
 * 结束回复按自己的计划写「480p、15 秒」，实际产物是缺省的 1080P、5 秒，且全程未查看任何图片与视频。
 */
async function runVerify(store: Store, config: QyConfig, ref: ModelRef): Promise<Verdict> {
  const name = `${ref.provider}/${ref.model}`
  const v: Verdict = { ref: name, turns: 0, checks: [], cachedRatio: null, conversationId: '' }
  const pngOf = (size: unknown) => {
    const m = /^(\d+)x(\d+)$/.exec(String(size))
    return m ? grayPng(Number(m[1]), Number(m[2])) : PNG_B64
  }
  const { scenario, prompts, videos, stub } = stubMedia(config, () => false, pngOf)
  const ws = `${wsFor(ref)}-verify`
  await rm(ws, { recursive: true, force: true })
  await mkdir(ws, { recursive: true })
  const live = start(store, scenario, ws)
  try {
    const conv = await newConversation(live, `结果核对判定 · ${name}`)
    if (!conv) throw new Error('创建会话失败')
    v.conversationId = conv
    await setModel(live, conv, ref)
    const runId = await turn(live, conv, VERIFY_TASK)
    if (!runId) throw new Error('该轮未启动 run')
    v.turns = 1
    const add = (n: string, ok: boolean, d = '') => v.checks.push({ name: n, ok, detail: d })
    const doc = JSON.parse(
      await Bun.file(join(ws, VERIFY_CANVAS))
        .text()
        .catch(() => '{"nodes":[]}'),
    ) as CanvasDoc
    const cards = doc.nodes.flatMap((n) => (n.type === 'generate' ? [n] : []))
    const images = cards.filter((n) => n.output === 'image')
    const clips = cards.filter((n) => n.output === 'video')
    const sized = (n: (typeof cards)[number]) => /^\d+x\d+$/.test(String(n.params.size))
    add(
      '图片卡都设置了尺寸参数',
      images.length === 2 && images.every(sized),
      images.map((n) => String(n.params.size ?? '未设置')).join('、'),
    )
    add(
      '视频卡设置了时长与尺寸参数',
      clips.length === 1 && clips.every((n) => n.params.seconds !== undefined && sized(n)),
      clips.map((n) => JSON.stringify(n.params)).join('、'),
    )
    add(
      '每张卡重新运行不超过一次',
      prompts.length >= 2 && prompts.length <= 4 && videos.length >= 1 && videos.length <= 2,
      `图片接口 ${prompts.length} 次，视频接口 ${videos.length} 次`,
    )
    const steps = listSteps(store, runId)
    const reads = steps.flatMap((s) =>
      s.toolName === 'read_file' && s.status === 'success'
        ? [String((s.payload as { args?: { path?: unknown } } | null)?.args?.path)]
        : [],
    )
    const viewed = (ext: RegExp) =>
      reads.filter((p) => /generated[\\/]/.test(p) && ext.test(p)).length
    add(
      '查看了生成的图片',
      viewed(/\.(png|jpe?g|webp)$/i) > 0,
      `成功读取 ${viewed(/\.(png|jpe?g|webp)$/i)} 次`,
    )
    add('抽帧查看了生成的视频', viewed(/\.mp4$/i) > 0, `成功读取 ${viewed(/\.mp4$/i)} 次`)
    // 回复是最后一次工具调用之后的正文；助手正文按步骤保存，不在消息表中。
    const last = steps.findLastIndex((s) => s.toolName !== null)
    const reply = steps
      .slice(last + 1)
      .filter((s) => s.kind === 'text')
      .map((s) => s.content ?? '')
      .join(NL)
    add(
      '回复按回执写出视频的实际分辨率 160×90 与时长 4 秒',
      /160\s*[×xX*]\s*90/.test(reply) && /(^|[^\d.])4(\.0+)?\s*(秒|s\b)/.test(reply),
      reply.replace(/\s+/g, ' ').slice(0, 200),
    )
  } catch (err) {
    v.error = err instanceof Error ? err.message : String(err)
  } finally {
    live.close()
    stub.stop(true)
  }
  return v
}

async function main(): Promise<number> {
  const config = await loadConfig()
  // 写入主库，执行完毕后可在面板中查看每一轮。
  const store = new Store({ path: dataPath() })

  // `--blocked`：只执行受阻判定一项（见 `runBlocked`）；`--goal`：同一任务以目标模式执行；
  // `--layout`：只执行画布布局判定一项（见 `runLayout`）；`--verify`：只执行结果核对判定一项（见 `runVerify`）。
  const blocked = process.argv.includes('--blocked')
  const goal = process.argv.includes('--goal')
  const layout = process.argv.includes('--layout')
  const verify = process.argv.includes('--verify')
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
  const refs: ModelRef[] = args.length
    ? args.map((a) => {
        const i = a.indexOf('/')
        return { provider: a.slice(0, i), model: a.slice(i + 1) }
      })
    : Object.entries(config.providers).flatMap(([provider, p]) =>
        Object.keys(p.models).map((model) => ({ provider, model })),
      )

  line(
    `共 ${refs.length} 个模型，每个 ${blocked || goal || layout || verify ? 1 : Object.keys(TASKS).length} 项真实任务。`,
  )
  const all: Verdict[] = []
  for (const ref of refs) {
    line('')
    line(`── ${ref.provider}/${ref.model} ──`)
    const v = await (layout
      ? runLayout(store, config, ref)
      : verify
        ? runVerify(store, config, ref)
        : blocked || goal
          ? runBlocked(store, config, ref, goal)
          : runFor(store, config, ref))
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
