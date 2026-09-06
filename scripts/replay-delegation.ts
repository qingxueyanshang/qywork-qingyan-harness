#!/usr/bin/env bun
/**
 * 真机全场景复刻：用户原话起一轮，真实模型、真实子 agent，服务与账本另起一份不碰 `~/.qywork`。
 *
 * 两条线共用同一套骨架（起服务、建会话、发消息、读事件与账本），按参数二选一。
 *
 * 默认线验的是单元测试验不到的一段：模型按运行快照建临时子 agent 而不建角色、四个模型各归各、
 * 四个子 agent 并行起跑且状态当场落库；中断之后一句「继续」续跑原来那四个子 agent，
 * 不另起四个；最后父会话自己验收。
 *
 * `--cli` 线验外部 CLI 那一种：格状态带种类、实时页收到的是正文而不是原始 JSON 行、
 * 回执过投递闸、长任务全程不被中途终止、续派认同一条子会话。
 *
 *   bun run scripts/replay-delegation.ts                  # 首派 → 中断 → 继续 → 验收
 *   bun run scripts/replay-delegation.ts --no-interrupt   # 首派 →（一格失败先交回 → 汇合）→ 验收
 *   bun run scripts/replay-delegation.ts --cli            # 外部 CLI：成功 / 静默 / 续派 / 长思考
 *   bun run scripts/replay-delegation.ts --round-min=120  # 一轮最多等多少分钟，默认 45
 *   bun run scripts/replay-delegation.ts --parent=deepseek/deepseek-v4-flash  # 父会话换一对接口 × 模型
 *
 * 不中断那条线上，只要有一格比其余格先失败，就一并验「失败回执先到」：首派在其余格还在跑时
 * 返回、回执带 running；父会话下一次调用是等或 revise 同一张图；其余格的终态仍落在首派那张卡上。
 *
 * 配置（含密钥）读 `~/.qywork/config.json`；工作区与账本落 `.tmp/replay-ws/<时间戳>/`，跑完不删。
 * 每一行进度与结论同时追加到该目录的 `replay.log`：一条线要跑几十分钟，分段查看只能看它。
 */

import { appendFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { deliveryBudget } from '@qywork/agent'
import { buildAdapter } from '@qywork/ai'
import {
  type AgentEvent,
  type ConversationId,
  foldWorkflow,
  type NodeState,
  type RunId,
  type Step,
  SUBAGENT_NODE_ID,
} from '@qywork/core'
import { loadConfig, type ModelRef, type QyConfig, resolveModel } from '@qywork/runtime'
import { serve } from '@qywork/server'
import {
  getConversation,
  latestSubagentPhases,
  listChildConversations,
  listProviderRequests,
  listRuns,
  listSteps,
  listWorkflowRecords,
  Store,
  workflowIdsOf,
} from '@qywork/store'
import { MAX_TIMEOUT_MS } from '@qywork/tools'

/** 外部 CLI 那条线。两条线各自的工作区、用户原话与判据都不同，只共用骨架。 */
const CLI = process.argv.includes('--cli')

/** 每次跑一个带时间戳的目录，旧的一律留着：账本是事后排查子 agent 为什么停的唯一证据。 */
const ROOT = join(
  import.meta.dir,
  '..',
  '.tmp',
  'replay-ws',
  new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-'),
)
const WS_DIR = join(ROOT, CLI ? 'checkout' : 'racer')
const DB = join(ROOT, 'replay.sqlite3')
const LOG = join(ROOT, 'replay.log')

/** 用户原话，一字不改。 */
const INSTRUCTION =
  '帮我设立4个子agent，然后分别安排glm5.3flash、qwen3.8flash、deepseek4.0flash version、Gemini3.8flash\n' +
  '同时做一个赛车游戏，要3d的，漫画风格，最后你来做验收和横向对比，主要是看游戏有没有bug还有可玩性，有bug让他们继续优化,，利用workflow的功能，来完成这件事'

/** 用户点名的四个模型在配置里的 id。deepseek 那个用户写的是「4.0flash version」，两个 flash 都认。 */
const EXPECTED_MODELS: { name: string; matches: (model: string) => boolean }[] = [
  { name: 'glm-5.3-flash', matches: (m) => m === 'glm-5.3-flash' },
  { name: 'qwen3.8-flash', matches: (m) => m === 'qwen3.8-flash' },
  { name: 'deepseek-v4-flash*', matches: (m) => m.startsWith('deepseek-v4-flash') },
  { name: 'gemini-3.8-flash', matches: (m) => m === 'gemini-3.8-flash' },
]

const INTERRUPT = !process.argv.includes('--no-interrupt')
/**
 * 父会话用哪一对接口 × 模型。不给就用配置里当前生效的；某家接口连不上时换一家跑父会话。
 *
 * `--cli` 线另有默认值：那条线验的是外部 CLI，父会话只负责派活与转述，
 * 用一台便宜模型跑；不定死默认值的话每次都要在命令行上补一遍。
 */
const PARENT = ((): ModelRef | null => {
  const raw = process.argv.find((a) => a.startsWith('--parent='))?.slice('--parent='.length)
  if (!raw) return CLI ? { provider: 'deepseek', model: 'deepseek-v4-flash' } : null
  const at = raw.indexOf('/')
  return at > 0 ? { provider: raw.slice(0, at), model: raw.slice(at + 1) } : null
})()
/** 四个都跑起来之后再等这么久才中断：要让它们各自留下一段真实上下文。 */
const INTERRUPT_AFTER_MS = 120_000
/** 父会话从收到原话到四格起跑的上限。glm-5.3-flash 实测组一次参数要 4 分钟，被挡回一次再加 1 分钟。 */
const FIRST_DISPATCH_TIMEOUT_MS = 12 * 60_000
const ROUND_TIMEOUT_MS =
  Number(
    process.argv.find((a) => a.startsWith('--round-min='))?.slice('--round-min='.length) || 45,
  ) * 60_000

type Started = Extract<AgentEvent, { type: 'tool.started' }>
type Finished = Extract<AgentEvent, { type: 'tool.finished' }>
type Member = Extract<AgentEvent, { type: 'team.member' }>
type Output = Extract<AgentEvent, { type: 'team.output' }>

/** 终端与 `replay.log` 同时收一份。跑一条线要几十分钟，中途只能靠这个文件看进度。 */
function out(line: string): void {
  process.stdout.write(`${line}\n`)
  appendFileSync(LOG, `${line}\n`)
}

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  out(`${ok ? '  ✓' : '  ✗'} ${label}`)
  if (!ok) {
    failures++
    if (detail !== undefined) out(`      ${JSON.stringify(detail).slice(0, 800)}`)
  }
}
const stamp = () => new Date().toISOString().slice(11, 19)
const log = (line: string) => out(`[${stamp()}] ${line}`)

/**
 * `--cli` 线的工作区：一个小 JS 项目，每个文件都短到能被一次读完，且各留着可指认的缺陷，
 * 审查任务因此有确定的产出。跑之前现生成，不进仓库。
 */
const FIXTURE: Record<string, string> = {
  'package.json': `{
  "name": "checkout",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": { "start": "node src/index.js" }
}
`,
  'README.md': `# checkout

购物车结算：库存、折扣、金额格式化。入口 src/index.js。
`,
  'src/cart.js': `export function createCart() {
  return { items: [] }
}

export function addItem(cart, item) {
  const found = cart.items.find((x) => x.sku === item.sku)
  if (found) {
    found.qty = item.qty
    return cart
  }
  cart.items.push({ ...item })
  return cart
}

export function removeItem(cart, sku) {
  const at = cart.items.findIndex((x) => x.sku === sku)
  cart.items.splice(at, 1)
  return cart
}

export function subtotal(cart) {
  let sum = 0
  for (let i = 0; i <= cart.items.length; i++) {
    sum += cart.items[i].price * cart.items[i].qty
  }
  return sum
}
`,
  'src/discount.js': `export const CODES = {
  NONE: 0,
  SAVE10: 10,
  SAVE25: 25,
  HALF: 50,
}

export function applyDiscount(amount, code) {
  const percent = CODES[code]
  if (!percent) return amount
  return amount - (amount * percent) / 100
}

export function applyFlat(amount, off) {
  return amount - off
}

export function stack(amount, codes) {
  let out = amount
  for (const code of codes) out = applyDiscount(out, code)
  return out
}
`,
  'src/inventory.js': `const stock = { 'sku-1': 3, 'sku-2': 0, 'sku-3': 12 }

export function inStock(sku) {
  return stock[sku] > 0
}

export function reserve(cart) {
  for (const item of cart.items) stock[item.sku] = stock[item.sku] - item.qty
  return cart
}

export function restock(sku, qty) {
  stock[sku] += qty
}
`,
  'src/format.js': `export function money(value) {
  return '¥' + Math.round(value * 100) / 100
}

export function line(item) {
  return item.sku + ' x' + item.qty + ' = ' + money(item.price * item.qty)
}
`,
  'src/index.js': `import { addItem, createCart, subtotal } from './cart.js'
import { stack } from './discount.js'
import { line, money } from './format.js'
import { reserve } from './inventory.js'

const cart = createCart()
addItem(cart, { sku: 'sku-1', price: 19.9, qty: 2 })
addItem(cart, { sku: 'sku-3', price: 4.05, qty: 3 })
reserve(cart)

for (const item of cart.items) console.log(line(item))
console.log('合计', money(stack(subtotal(cart), ['SAVE10'])))
`,
}

async function writeFixture(): Promise<void> {
  await mkdir(join(WS_DIR, 'src'), { recursive: true })
  for (const [rel, body] of Object.entries(FIXTURE)) await Bun.write(join(WS_DIR, rel), body)
}

/**
 * `--cli` 线的四段用户原话。**每段都要带 `@cli:claude`**：系统提示规定外部 CLI
 * 只在用户点名或明确要求时派，不点名的话模型会建一个临时子 agent。
 *
 * 等待那一段**不要改回 `sleep 700`**：claude 2.1.261 的 Bash 工具拦下独立的长 sleep
 * （原话「Blocked: standalone sleep」），并在拦截信息里给出 until 循环这一种写法。
 *
 * 它的边界：量得到的是一次长时间执行之后的回执与它在下一次请求里占的份额，
 * **量不到静默额度**——同一版本在工具执行期间每 30 秒发一条 `tool_progress` 心跳，
 * 流不会静默到额度，到点终止由 `packages/tools/src/sandbox.test.ts` 的静默计时用例锁着。
 */
const CLI_MESSAGES = {
  review:
    '派 @cli:claude 审查这个项目里的 src/cart.js。任务就写：只读 src/cart.js，不要修改任何文件，' +
    '列出这个文件的缺陷并给一句总体结论。它返回之后把它的结论转述给我。',
  wait:
    '再新建一个 @cli:claude 子 agent（不要续用上一个）。任务就写：用 Bash 工具执行 ' +
    '`until [ -f wait-done ]; do sleep 2; done` 等工作区根目录下的 wait-done 出现，' +
    '该工具的 timeout 参数填 750000；到点没等到就如实说，然后汇报 src 目录下有几个 js 文件。' +
    '这一次不管它成没成，都不要重派，把回执如实转述给我。',
  resume: (id: string) =>
    `让刚才那个 claude 子 agent（subagentId ${id}）再看一眼 src/discount.js：用 subagent 工具，` +
    `subagent 填 ${id}，任务是只读 src/discount.js 并指出这个文件的缺陷。`,
  heavy:
    '再派 @cli:claude 做一件重活。任务就写：读完 src 下的全部 js 文件与 package.json，' +
    '逐个文件写一份问题清单（每个文件至少三条，说清行为缺陷与边界处理），' +
    '再写一份整体重构建议（模块划分、错误处理、测试策略），不要修改任何文件。',
}

/**
 * 原始 stream-json 行的特征字段。实时页与回执里出现任何一个，都说明取到的是整段流
 * 而不是解析出来的正文。
 */
const RAW_FIELDS = /"type"\s*:|session_id|"subtype"\s*:/

/** 骨架交给 `--cli` 线的入口：服务、会话、事件流与发消息都已就绪。 */
interface Line {
  store: Store
  conversationId: ConversationId
  events: AgentEvent[]
  send: (content: string) => void
  config: QyConfig
  parent: ModelRef
}

/** 一次派活在事件流与账本里的全部落点，四条路径的判据都从这里取。 */
interface Dispatch {
  call: Started
  finished: Finished
  step: Step | undefined
  node: NodeState | undefined
  /** 这一格的实时输出，按到达顺序。 */
  deltas: string[]
  data: { output?: string; outputCoverage?: unknown; subagentId?: string }
  runId: RunId
}

const firstLine = (text: string): string =>
  (text.split('\n').find((l) => l.trim()) ?? '').trim().slice(0, 160)

/** 实时页那一段的原样开头，换行压成竖线：判据看的是它长什么样，不是它有多长。 */
const sample = (text: string): string => text.trim().replaceAll('\n', ' | ').slice(0, 200)

/**
 * 外部 CLI 的四条路径：成功、长时间等待、续派、长思考。
 *
 * 每条一轮，判据全部读复刻的账本与这一轮的事件流，不读 `~/.qywork`。
 * 任一轮抛出（没有收尾、没有派出去）就记一条未通过并停下，汇总照常打印。
 */
async function cliLine(ctx: Line): Promise<void> {
  const { store, conversationId, events } = ctx
  const stored = resolveModel(ctx.config, ctx.parent)
  if (!stored) throw new Error(`配置里没有 ${ctx.parent.provider} / ${ctx.parent.model}`)
  // 单次投递预算按父模型的窗口算，与执行时那一处同源：写死一个数的话，换模型就对不上。
  const spec = buildAdapter({
    kind: stored.kind,
    apiKey: stored.apiKey ?? '',
    model: stored.model,
    ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
    ...(stored.headers ? { headers: stored.headers } : {}),
    ...(stored.spec ? { spec: stored.spec } : {}),
    ...(stored.transport ? { transport: stored.transport } : {}),
  }).spec
  const { perCall } = deliveryBudget(spec.contextWindow)
  log(`父模型窗口 ${spec.contextWindow}，单次投递预算 ${perCall} token`)

  const stepOf = (stepId: string): Step | undefined =>
    listRuns(store, conversationId)
      .flatMap((r) => listSteps(store, r.id))
      .find((s) => s.id === stepId)

  const nodesOf = (step: Step | undefined): Record<string, NodeState> | undefined => {
    const payload = step?.payload
    if (!payload) return undefined
    return payload.kind === 'tool_call' || payload.kind === 'tool_result'
      ? payload.nodes
      : undefined
  }

  /** 这一轮最后一次 subagent 调用。参数被挡回的那次不算：模型会按回执补全重派。 */
  const dispatchOf = (from: number, label: string): Dispatch => {
    const slice = events.slice(from)
    const call = slice
      .filter((ev): ev is Started => ev.type === 'tool.started' && ev.toolName === 'subagent')
      .at(-1)
    if (!call) throw new Error(`${label}：这一轮没有派出 subagent`)
    const finished = slice.find(
      (ev): ev is Finished => ev.type === 'tool.finished' && ev.toolCallId === call.toolCallId,
    )
    if (!finished) throw new Error(`${label}：subagent 调用没有终态`)
    const step = stepOf(call.stepId)
    return {
      call,
      finished,
      step,
      node: nodesOf(step)?.[SUBAGENT_NODE_ID],
      deltas: slice
        .filter((ev): ev is Output => ev.type === 'team.output' && ev.stepId === call.stepId)
        .map((ev) => ev.delta),
      data: (finished.outcome.data ?? {}) as Dispatch['data'],
      runId: call.runId,
    }
  }

  const readings: string[] = []
  /**
   * 发一句，等**这一轮自己**收尾，返回它在事件流里的起点。
   *
   * **收尾要按 runId 认。** 一轮报错时 `run.error` 与 `run.finished` 会先后发两条，
   * 只等「下一条终态事件」的话，后到的那条会当场把下一轮判成已收尾。
   */
  const round = async (title: string, content: string): Promise<number> => {
    out(`\n${title}`)
    const from = events.length
    ctx.send(content)
    const deadline = Date.now() + ROUND_TIMEOUT_MS
    while (Date.now() < deadline) {
      const slice = events.slice(from)
      const runId = slice.find((ev) => ev.type === 'run.started')?.runId
      const ended = runId
        ? slice.find(
            (ev) => (ev.type === 'run.finished' || ev.type === 'run.error') && ev.runId === runId,
          )
        : undefined
      if (ended) {
        if (ended.type === 'run.error') check(`${title}：这一轮没有报错`, false, ended)
        return from
      }
      await Bun.sleep(500)
    }
    throw new Error(`${title}：这一轮 ${ROUND_TIMEOUT_MS / 1000}s 没有收尾`)
  }

  let subagentId = ''
  try {
    // ── 6.1 成功路径 ──
    const from = await round('6.1 成功路径：点名 @cli:claude 审查一个文件', CLI_MESSAGES.review)
    const d = dispatchOf(from, '6.1')
    subagentId = d.data.subagentId ?? ''
    const output = d.data.output ?? ''
    check('6.1 这一格做成了', d.finished.status === 'success' && d.node?.phase === 'done', [
      d.finished.status,
      d.node?.phase,
      d.finished.outcome.message,
    ])
    check('6.1 卡上那格的种类是 cli', d.node?.kind === 'cli', d.node)
    check('6.1 实时页收到了正文', d.deltas.length > 0)
    check(
      '6.1 实时页不是原始 JSON 行',
      d.deltas.length > 0 && !d.deltas.some((t) => RAW_FIELDS.test(t)),
      d.deltas.find((t) => RAW_FIELDS.test(t)),
    )
    check(
      '6.1 实时页带工具名标记',
      d.deltas.some((t) => t.includes('[工具 ')),
      sample(d.deltas.join('')),
    )
    check(
      '6.1 回执是审查正文',
      output.trim().length > 0 && !output.trimStart().startsWith('{') && !RAW_FIELDS.test(output),
      output.slice(0, 300),
    )
    check('6.1 正常篇幅没有被截断', d.data.outputCoverage === undefined, d.data.outputCoverage)
    check('6.1 回执带回了 subagentId', !!subagentId)
    readings.push(
      `6.1 durationMs=${d.node?.durationMs ?? d.finished.durationMs}，回执 ${output.length} 字符，实时页 ${d.deltas.length} 片`,
    )
    readings.push(`6.1 实时页样例：${sample(d.deltas.join(''))}`)
    readings.push(`6.1 回执样例：${firstLine(output)}`)

    // ── 6.2 静默路径 ──
    const from2 = await round('6.2 静默路径：让它等一个不会出现的文件', CLI_MESSAGES.wait)
    const d2 = dispatchOf(from2, '6.2')
    const idle = d2.node?.durationMs ?? d2.finished.durationMs
    const output2 = d2.data.output ?? ''
    check(
      `6.2 静默到点被终止（${(idle / 1000).toFixed(1)}s，额度 ${MAX_TIMEOUT_MS / 1000}s）`,
      idle >= MAX_TIMEOUT_MS && idle <= MAX_TIMEOUT_MS + 60_000,
      idle,
    )
    check(
      '6.2 回执文案说的是静默终止',
      d2.finished.outcome.message.includes(`静默 ${MAX_TIMEOUT_MS / 1000} 秒，已终止`),
      d2.finished.outcome.message,
    )
    check(
      '6.2 回执是被终止前已说出口的正文',
      output2.trim().length > 0 && !RAW_FIELDS.test(output2),
      output2.slice(0, 300),
    )
    const compactions = listSteps(store, d2.runId).filter((s) => s.kind === 'compaction')
    check(
      '6.2 这一轮没有压缩',
      compactions.length === 0,
      compactions.map((s) => s.payload),
    )
    // 带着回执的是这次调用之后开出的那一次请求。**按执行起点分前后，不按事件到达时刻**：
    // 请求开出与 `tool.finished` 到达同在一毫秒内，用后者比不出先后。
    const at = d2.step?.executionStartedAt ?? 0
    const turns = listProviderRequests(store, d2.runId).filter((r) => r.purpose === 'turn')
    const before = turns.filter((r) => r.createdAt <= at).at(-1)
    const after = turns.find((r) => r.createdAt > at)
    const grew =
      (after?.sentCategories.intermediateContent ?? 0) -
      (before?.sentCategories.intermediateContent ?? 0)
    check(
      `6.2 回执之后 intermediateContent 只涨 ${grew}，不超过单次预算 ${perCall}`,
      !!after && grew <= perCall,
      {
        before: before?.sentCategories.intermediateContent,
        after: after?.sentCategories.intermediateContent,
        perCall,
      },
    )
    readings.push(
      `6.2 durationMs=${idle}，回执 ${output2.length} 字符，压缩 step ${compactions.length} 条`,
    )
    readings.push(
      `6.2 intermediateContent ${before?.sentCategories.intermediateContent ?? '—'} → ${after?.sentCategories.intermediateContent ?? '—'}（预算 ${perCall}）`,
    )
    readings.push(`6.2 回执样例：${firstLine(output2)}`)

    // ── 6.3 续派路径 ──
    // 点名要用 6.1 那个 id：不写出来的话「刚才那个」在 6.2 之后指向不明。
    if (!subagentId) throw new Error('6.3：6.1 没有回 subagentId，续派无从点名')
    const from3 = await round(
      '6.3 续派路径：对同一个子 agent 再派一次',
      CLI_MESSAGES.resume(subagentId),
    )
    const d3 = dispatchOf(from3, '6.3')
    check('6.3 续派填的是 6.1 那个 subagentId', d3.call.args.subagent === subagentId, d3.call.args)
    // 模型会把没用到的可选参数一律填空串，所以判的是「没有值」而不是「没有这个键」。
    check('6.3 续派参数不带种类，种类只能来自会话记录', !d3.call.args.kind, d3.call.args)
    check('6.3 卡上那格仍是 cli', d3.node?.kind === 'cli', d3.node)
    check(
      '6.3 实时页是正文，不是原始 JSON 行',
      d3.deltas.length > 0 && !d3.deltas.some((t) => RAW_FIELDS.test(t)),
      d3.deltas.find((t) => RAW_FIELDS.test(t)),
    )
    readings.push(
      `6.3 durationMs=${d3.node?.durationMs ?? d3.finished.durationMs}，回执 ${(d3.data.output ?? '').length} 字符`,
    )
    readings.push(`6.3 实时页样例：${sample(d3.deltas.join(''))}`)

    // ── 6.4 长思考路径 ──
    const from4 = await round('6.4 长思考路径：读全部文件再写重构建议', CLI_MESSAGES.heavy)
    const d4 = dispatchOf(from4, '6.4')
    const long = d4.node?.durationMs ?? d4.finished.durationMs
    check(
      '6.4 事件持续流动时不被终止，重任务跑完',
      d4.finished.status === 'success' && d4.node?.phase === 'done',
      [d4.finished.status, d4.node?.phase, d4.finished.outcome.message],
    )
    readings.push(`6.4 durationMs=${long}，回执 ${(d4.data.output ?? '').length} 字符`)
    if (long <= MAX_TIMEOUT_MS) {
      readings.push(`6.4 未到 ${MAX_TIMEOUT_MS / 1000} s，总时长上限已删这件事不算被这条验证`)
    }
  } catch (err) {
    check('四条路径跑完', false, err instanceof Error ? err.message : String(err))
  }

  out('\n汇总')
  for (const line of readings) out(`  ${line}`)
  out(`  复刻目录 ${ROOT}`)
  out(
    `  会话 ${conversationId}；子会话：${listChildConversations(store, conversationId)
      .map((c) => `${c.title}=${c.id}(${c.source})`)
      .join('，')}`,
  )
}

async function main(): Promise<number> {
  await mkdir(WS_DIR, { recursive: true })
  if (CLI) {
    await writeFixture()
    // claude 的 Bash 工具自己也有执行上限，默认与这里的静默额度同数。它先到点的话
    // 沉默会被它那一侧结束，静默路径量不到 qywork 这一侧的判据，所以抬高它那个上限。
    process.env.BASH_MAX_TIMEOUT_MS = String(MAX_TIMEOUT_MS + 300_000)
  }

  const store = new Store({ path: DB })
  const config = await loadConfig()
  const h = serve({ store, config, workspaceRoot: WS_DIR, port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${h.port}`
  const auth = { authorization: `Bearer ${h.token}` }
  const parent = PARENT ?? config.active
  log(`服务已起：${base}（父会话模型 ${parent.provider} / ${parent.model}）；账本 ${DB}`)

  try {
    const created = (await (
      await fetch(`${base}/api/conversations`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ title: '真机复刻', ...(PARENT ?? {}) }),
      })
    ).json()) as { conversation?: { id?: string } }
    const conversationId = (created.conversation?.id ?? '') as ConversationId
    if (!conversationId) throw new Error('建会话失败')

    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/stream?token=${h.token}&origin=desktop`)
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
    })

    const events: AgentEvent[] = []
    /** 与 events 同下标：收到那条事件的本机时刻。算「失败落格到调用返回」的间隔用。 */
    const stamps: number[] = []
    let text = ''
    let runId = ''
    let roundDone = Promise.withResolvers<AgentEvent>()
    const toolNames = new Map<string, string>()

    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data))
      if (msg.type === 'hello.err') return roundDone.reject(new Error(`hello 失败: ${msg.message}`))
      if (!msg.seq || !msg.event) return
      const ev = msg.event as AgentEvent
      events.push(ev)
      stamps.push(Date.now())
      switch (ev.type) {
        case 'run.started':
          runId = ev.runId
          text = ''
          log(`run.started ${ev.runId}`)
          break
        case 'text.delta':
          text += ev.delta
          break
        case 'tool.started': {
          toolNames.set(ev.toolCallId, ev.toolName)
          if (['workflow', 'subagent', 'define_role'].includes(ev.toolName)) {
            log(`tool.started ${ev.toolName} ${JSON.stringify(ev.args).slice(0, 400)}`)
          }
          break
        }
        case 'tool.finished': {
          const name = toolNames.get(ev.toolCallId)
          if (name && ['workflow', 'subagent', 'define_role'].includes(name)) {
            log(
              `tool.finished ${name} ${ev.status} ${String(ev.outcome?.message ?? '').slice(0, 300)}`,
            )
          }
          break
        }
        case 'team.member':
          log(
            `node ${ev.nodeId} → ${ev.state.phase}${ev.state.subagentId ? ` (${ev.state.subagentId})` : ''}${ev.state.error ? `：${ev.state.error}` : ''}`,
          )
          break
        case 'run.finished':
        case 'run.error':
          log(`${ev.type} ${JSON.stringify(ev).slice(0, 300)}`)
          roundDone.resolve(ev)
          break
        default:
          break
      }
    })

    ws.send(
      JSON.stringify({
        type: 'hello',
        token: h.token,
        origin: 'desktop',
        subscribe: [conversationId],
      }),
    )
    await Bun.sleep(300)

    const waitFor = async <T extends AgentEvent>(
      label: string,
      pick: (ev: AgentEvent) => ev is T,
      count: number,
      ms: number,
    ): Promise<T[]> => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const hits = events.filter(pick)
        if (hits.length >= count) return hits
        await Bun.sleep(500)
      }
      throw new Error(`等 ${label} 超时（${ms / 1000}s）`)
    }
    const started =
      (name: string) =>
      (ev: AgentEvent): ev is Started =>
        ev.type === 'tool.started' && ev.toolName === name
    const finishedOf = (name: string) =>
      events.filter(
        (ev): ev is Finished =>
          ev.type === 'tool.finished' && toolNames.get(ev.toolCallId) === name,
      )
    const working = (ev: AgentEvent): ev is Member =>
      ev.type === 'team.member' && ev.state.phase === 'working' && !!ev.state.subagentId

    const send = (content: string) => {
      roundDone = Promise.withResolvers<AgentEvent>()
      ws.send(
        JSON.stringify({
          type: 'message.send',
          clientRequestId: crypto.randomUUID(),
          conversationId,
          content,
        }),
      )
    }
    const endOfRound = (ms: number) =>
      Promise.race([
        roundDone.promise,
        Bun.sleep(ms).then(() => {
          throw new Error(`这一轮 ${ms / 1000}s 没有收尾`)
        }),
      ])

    if (CLI) {
      await cliLine({ store, conversationId, events, send, config, parent })
      ws.close()
      return failures
    }

    // ── 首派 ──
    process.stdout.write('\n首派：用户原话\n')
    send(INSTRUCTION)
    // 首派以真正起了节点的那次调用为准：参数被挡回的那次不算，模型会按回执补全重派。
    const live = await waitFor('四个节点 working', working, 4, FIRST_DISPATCH_TIMEOUT_MS)
    const first = events.find(
      (ev): ev is Started => started('workflow')(ev) && ev.stepId === live[0]!.stepId,
    )
    if (!first) throw new Error('起了节点却找不到对应的 workflow 调用')
    const args = first.args as {
      goal?: string
      nodes?: { id: string; kind?: string; name?: string; model?: string; provider?: string }[]
      maxConcurrent?: number
    }
    const agentNodes = (args.nodes ?? []).filter((n) => n.kind !== 'checkpoint')
    check('没有调用 define_role', events.filter(started('define_role')).length === 0)
    check('没有单独用 subagent 派', events.filter(started('subagent')).length === 0)
    check(`一张图四个 agent 节点（${agentNodes.length}）`, agentNodes.length === 4, agentNodes)
    check(
      '四个节点都是临时子 agent（kind=temp，带 name）',
      agentNodes.every((n) => n.kind === 'temp' && !!n.name),
      agentNodes.map((n) => [n.kind, n.name]),
    )
    const models = agentNodes.map((n) => n.model ?? '')
    check(
      '四个模型各归各，正是用户点名的四个',
      EXPECTED_MODELS.every((e) => models.some((m) => e.matches(m))) && new Set(models).size === 4,
      models,
    )
    check(
      '每个 model 都配了 provider',
      agentNodes.every((n) => !n.model || !!n.provider),
      agentNodes.map((n) => [n.provider, n.model]),
    )
    check('并发够四个同时跑', (args.maxConcurrent ?? 4) >= 4, args.maxConcurrent)

    const byNode = new Map(live.map((m) => [m.nodeId, m.state.subagentId as string]))
    check(`四个节点各有子 agent（${byNode.size}）`, byNode.size >= 4, [...byNode])
    const kids = listChildConversations(store, conversationId)
    check(
      `账本里四条子会话（${kids.length}）`,
      kids.length === 4,
      kids.map((c) => c.title),
    )
    check(
      '子会话都是临时种类、父会话是它',
      kids.every((c) => c.source === 'temp' && c.parentConversationId === conversationId),
    )
    check(
      '子会话的模型与节点上写的一致',
      agentNodes.every((n) => {
        const id = byNode.get(n.id)
        const c = id ? getConversation(store, id as ConversationId) : null
        return !!c && (!n.model || c.model === n.model)
      }),
      kids.map((c) => [c.title, c.provider, c.model]),
    )
    const spread =
      Math.max(...kids.map((c) => c.createdAt)) - Math.min(...kids.map((c) => c.createdAt))
    check(`四条子会话在 10 秒内先后建起（相差 ${spread}ms）`, spread < 10_000)
    const stepOf = () =>
      listRuns(store, conversationId)
        .flatMap((r) => listSteps(store, r.id))
        .find((s) => s.id === first.stepId)
    const persisted = stepOf()?.payload
    const nodesOnStep =
      persisted?.kind === 'tool_call' || persisted?.kind === 'tool_result'
        ? persisted.nodes
        : undefined
    check(
      '四格状态已经落在这条 step 上（刷新即可重画）',
      !!nodesOnStep &&
        agentNodes.every(
          (n) => nodesOnStep[n.id]?.phase === 'working' && !!nodesOnStep[n.id]?.subagentId,
        ),
      nodesOnStep,
    )

    const firstWorkflowId = first.stepId
    /** 账本里这条会话的每张工作流折出来的投影。 */
    const ledgerWorkflows = () => {
      const records = listWorkflowRecords(store, conversationId)
      return workflowIdsOf(records).flatMap((id) => {
        const folded = foldWorkflow(records, id)
        return folded.ok ? [folded.projection] : []
      })
    }
    if (INTERRUPT) {
      // ── 中断 ──
      log(`四个都在跑，${INTERRUPT_AFTER_MS / 1000}s 后中断`)
      await Bun.sleep(INTERRUPT_AFTER_MS)
      process.stdout.write('\n中断：run.interrupt\n')
      ws.send(JSON.stringify({ type: 'run.interrupt', runId }))
      const ended = await endOfRound(3 * 60_000)
      check(
        '这一轮以中断收尾',
        ended.type === 'run.finished' && ended.stopReason === 'user_interrupt',
        ended,
      )
      const after = stepOf()?.payload
      const afterNodes = after?.kind === 'tool_result' ? after.nodes : undefined
      check(
        '四格都落成终态（中断 / 失败），没有一格停在进行中',
        !!afterNodes &&
          agentNodes.every((n) =>
            ['interrupted', 'failed'].includes(afterNodes[n.id]?.phase ?? ''),
          ),
        afterNodes,
      )
      const phases = [...latestSubagentPhases(store, conversationId).values()]
      check(
        '账本里四个子 agent 的最后状态都不是进行中',
        phases.length === 4 && phases.every((phase) => phase !== 'working'),
        phases,
      )
      check(
        '账本里这张工作流折出来是失败',
        ledgerWorkflows()
          .map((w) => w.phase)
          .join() === 'failed',
      )

      // ── 继续 ──
      process.stdout.write('\n继续：一句「继续」\n')
      send('继续')
      const [resumeCall] = await waitFor(
        '续跑的 revise 调用',
        (ev): ev is Started =>
          started('workflow')(ev) && (ev.args as { decision?: string }).decision === 'revise',
        1,
        FIRST_DISPATCH_TIMEOUT_MS,
      )
      const resumeArgs = resumeCall!.args as {
        workflowId?: string
        decision?: string
        revisions?: { nodeId: string }[]
      }
      check(
        '续跑是 revise 同一张工作流，不是另起一张',
        resumeArgs.decision === 'revise' && resumeArgs.workflowId === firstWorkflowId,
        resumeArgs,
      )
      check(
        'revise 覆盖了四个节点',
        new Set((resumeArgs.revisions ?? []).map((r) => r.nodeId)).size === 4,
        resumeArgs.revisions,
      )
      const ended2 = await endOfRound(ROUND_TIMEOUT_MS)
      check(
        '续跑这一轮正常收尾',
        ended2.type === 'run.finished' && ended2.stopReason === 'completed',
        ended2,
      )
      const kidsAfter = listChildConversations(store, conversationId)
      check(`仍是原来四条子会话，没有另起（${kidsAfter.length}）`, kidsAfter.length === 4)
      check(
        '四个子 agent 各自续了第二轮',
        kidsAfter.every((c) => listRuns(store, c.id).length >= 2),
        kidsAfter.map((c) => [c.title, listRuns(store, c.id).length]),
      )
    } else {
      // ── 一格失败先交回 ──
      // 等首派那次调用返回。有格失败而其余还在跑时它先返回，回执带 running；没有这种情形时它跑到检查点才返回。
      const firstReturn = await (async (): Promise<Finished | null> => {
        const deadline = Date.now() + ROUND_TIMEOUT_MS
        let settled = false
        roundDone.promise.then(
          () => {
            settled = true
          },
          () => {
            settled = true
          },
        )
        while (Date.now() < deadline && !settled) {
          const hit = finishedOf('workflow').find((c) => c.toolCallId === first.toolCallId)
          if (hit) return hit
          await Bun.sleep(500)
        }
        return null
      })()
      const data = firstReturn?.outcome?.data as
        | {
            phase?: string
            receipts?: { nodeId: string; status: string; error?: string }[]
            running?: string[]
          }
        | undefined
      const running = data?.running ?? []
      if (firstReturn && running.length) {
        process.stdout.write('\n一格失败先交回\n')
        const failed = (data?.receipts ?? []).filter((r) => r.status === 'failed')
        check(
          `首派在其余格还在跑时返回：失败 ${failed.map((r) => r.nodeId).join('、')}，还在跑 ${running.join('、')}`,
          failed.length > 0 && data?.phase === 'waiting_review',
          data,
        )
        const returnIndex = events.indexOf(firstReturn)
        const failedIndex = events.findIndex(
          (ev): ev is Member =>
            ev.type === 'team.member' &&
            ev.state.phase === 'failed' &&
            failed.some((r) => r.nodeId === ev.nodeId),
        )
        const lag = (stamps[returnIndex] ?? 0) - (stamps[failedIndex] ?? 0)
        check(
          `失败落格到调用返回相隔 ${(lag / 1000).toFixed(1)}s`,
          failedIndex >= 0 && lag < 15_000,
        )
        check(
          '返回那一刻其余格都还没到终态',
          running.every(
            (id) =>
              !events
                .slice(0, returnIndex)
                .some(
                  (ev) =>
                    ev.type === 'team.member' &&
                    ev.nodeId === id &&
                    ['done', 'failed', 'interrupted', 'skipped'].includes(ev.state.phase),
                ),
          ),
        )
        const [next] = await waitFor(
          '父会话对同一张图的下一次调用',
          (ev): ev is Started =>
            started('workflow')(ev) &&
            events.indexOf(ev) > returnIndex &&
            (ev.args as { workflowId?: string }).workflowId === firstWorkflowId,
          1,
          FIRST_DISPATCH_TIMEOUT_MS,
        )
        const nextArgs = next!.args as { decision?: string; revisions?: { nodeId: string }[] }
        check(
          `下一次调用是${nextArgs.decision ? ` ${nextArgs.decision}` : '等'}同一张图，没有另起一张`,
          !nextArgs.decision || nextArgs.decision === 'revise',
          nextArgs,
        )
        check(
          '没有对还在跑的节点重派',
          !(nextArgs.revisions ?? []).some((r) => running.includes(r.nodeId)),
          nextArgs.revisions,
        )
        const ended = await endOfRound(ROUND_TIMEOUT_MS)
        check(
          '这一轮正常收尾',
          ended.type === 'run.finished' && ended.stopReason === 'completed',
          ended,
        )
        const card = stepOf()?.payload
        const cardNodes = card?.kind === 'tool_result' ? card.nodes : undefined
        check(
          '其余格的终态落在首派那张卡上',
          !!cardNodes &&
            running.every((id) =>
              ['done', 'failed', 'interrupted'].includes(cardNodes[id]?.phase ?? ''),
            ),
          cardNodes,
        )
        check(
          '首派的四条子会话都还在',
          listChildConversations(store, conversationId).filter((c) =>
            [...byNode.values()].includes(c.id),
          ).length === 4,
        )
      } else {
        if (firstReturn) log('首派一次跑到检查点，没有出现一格先失败的情形')
        const ended = await endOfRound(ROUND_TIMEOUT_MS)
        check(
          '这一轮正常收尾',
          ended.type === 'run.finished' && ended.stopReason === 'completed',
          ended,
        )
      }
    }

    // ── 验收 ──
    process.stdout.write('\n验收\n')
    const workflows = ledgerWorkflows()
    check('全程没有 define_role', events.filter(started('define_role')).length === 0)
    check(
      '工作流只有一张，且已完成',
      workflows.length === 1 && workflows[0]?.phase === 'completed',
      workflows.map((w) => [w.workflowId, w.phase, w.checkpointId]),
    )
    // 接口连不上的那一格父会话可以接受失败后批准：验的是没有一格停在半路。
    const phases = Object.entries(workflows[0]?.states ?? {}).map(([id, n]) => `${id}=${n.phase}`)
    check(
      `四格都到了终态（${phases.join('，')}）`,
      Object.values(workflows[0]?.states ?? {}).every((n) =>
        ['done', 'failed', 'skipped'].includes(n.phase),
      ),
      workflows[0]?.states,
    )
    const calls = finishedOf('workflow')
    // 有节点失败的那一轮回 failure 是对的：回执带着失败原因交回检查点。要挡的是图不合法那种错。
    check(
      `workflow 调用都返回了回执或完成（${calls.length} 次）`,
      calls.length > 0 &&
        calls.every((c) => c.status === 'success' || /回执/.test(String(c.outcome?.message ?? ''))),
      calls.map((c) => [c.status, c.outcome?.message]),
    )
    check('父会话给出了验收与横向对比', text.length > 200, text.slice(0, 200))
    process.stdout.write(`\n父会话最后一段：\n${text.slice(0, 2000)}\n`)
    process.stdout.write(
      `\n会话 ${conversationId}；子会话：${listChildConversations(store, conversationId)
        .map((c) => `${c.title}=${c.id}`)
        .join('，')}\n`,
    )

    ws.close()
  } finally {
    h.stop()
    store.close()
  }
  return failures
}

const n = await main()
out(`\n${n === 0 ? '全部通过' : `${n} 项未通过`}`)
process.exit(n === 0 ? 0 : 1)
