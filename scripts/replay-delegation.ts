#!/usr/bin/env bun
/**
 * 派发任务事件化的真实环境复现：使用真实模型与真实外部 CLI，服务与账本独立启动一份，不访问 `~/.qywork`。
 *
 * 每条路径各占一条会话，共用一个工作区与一份账本（`assign` 见 `pathAssign`）：
 *
 * - `6.1` 单项派发：`subagent` 派发后立即返回、该轮随即结束、子 agent 仍在运行；回执作为一条
 *   `origin='subagent'` 的消息发起新一轮，超出预算时正文中的定位符在新一轮中可由 `read_resource` 读取。
 * - `6.2` 注入：父会话运行中子 agent 完成，回执写入为 run 内 `kind:'user'` 的 step，不发起新一轮。
 * - `6.3` 全部停止：仅子 agent 运行中时执行停止，节点进入中断、忙态恢复为 false、不由回执发起新一轮。
 * - `6.4` 工作流：首次派发立即返回、节点逐个进入终态、上游全部完成后发送检查点回执、批准后下一批开始执行、完成。
 * - `6.5` 重启：子 agent 运行中时结束服务进程再重启，节点被标记为中断、不自动发起新一轮，
 *   下一轮的运行快照中该子 agent 标为「上一轮未完成」。
 *
 *   bun run scripts/replay-delegation.ts                     # 全部路径按序运行
 *   bun run scripts/replay-delegation.ts --only=6.1,6.3      # 只运行指定的路径
 *   bun run scripts/replay-delegation.ts --parent=gemini/gemini-3.8-flash
 *   bun run scripts/replay-delegation.ts --round-min=45      # 每轮最长等待分钟数
 *
 * 服务运行在子进程中（`replay-server.ts`），配置（含密钥）由该进程读取 `~/.qywork/config.json`；
 * 令牌经环境变量传递，两者都不进日志。
 *
 * 工作区与账本位于 `.tmp/replay-ws/<时间戳>/`，执行完毕后不删除；每一行进度同时追加到该目录的
 * `replay.log`：一条路径需要运行几分钟到几十分钟，分段查看只能依靠该文件。
 */

import { appendFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { applySpecOverride, lookupModel } from '@qywork/ai'
import {
  type AgentEvent,
  type ConversationId,
  foldWorkflow,
  type NodeState,
  type RunId,
  type Step,
  SUBAGENT_NODE_ID,
} from '@qywork/core'
import { loadConfig, type ModelRef, resolveModel } from '@qywork/runtime'
import {
  listChildConversations,
  listMessages,
  listRunContextSnapshots,
  listRuns,
  listSteps,
  listWorkflowRecords,
  Store,
  workflowIdsOf,
} from '@qywork/store'
import { observationBudget } from '@qywork/tools'

// ─────────────────────────── 参数与目录 ───────────────────────────

const arg = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)

const ALL_PATHS = ['6.1', '6.2', '6.3', '6.4', '6.5', 'assign'] as const
type PathId = (typeof ALL_PATHS)[number]

const SELECTED: PathId[] = (() => {
  const raw = arg('--only')
  if (!raw) return [...ALL_PATHS]
  const picked = raw.split(',').map((s) => s.trim())
  const unknown = picked.filter((p) => !ALL_PATHS.includes(p as PathId))
  if (unknown.length) throw new Error(`--only 中无法识别：${unknown.join('、')}`)
  return ALL_PATHS.filter((p) => picked.includes(p))
})()

/**
 * 单项派发路径使用的子 agent 种类。事件模型与种类无关；外部 CLI 使用本机账号，
 * 触发其自身的用量上限时用 `--subagent=temp` 换用临时子 agent 继续验证。
 */
const SUBAGENT_KIND: 'cli' | 'temp' = (() => {
  const raw = arg('--subagent') ?? 'cli'
  if (raw !== 'cli' && raw !== 'temp') throw new Error('--subagent 只接受 cli 或 temp')
  return raw
})()

/** 用户原话中指定的子 agent：外部 CLI 按 `@cli:id` 指定，临时子 agent 写明 kind 与名字。 */
const WHO =
  SUBAGENT_KIND === 'cli' ? '@cli:claude' : '一个临时子 agent（kind 填 temp，名字叫「审查员」）'

/** 父会话使用的接口 × 模型。某个接口在带回执的往返上静默超时时，换用其他接口重新运行。 */
const PARENT: ModelRef = (() => {
  const raw = arg('--parent') ?? 'deepseek/deepseek-v4-flash'
  const at = raw.indexOf('/')
  if (at <= 0) throw new Error('--parent 必须写成 provider/model')
  return { provider: raw.slice(0, at), model: raw.slice(at + 1) }
})()

/** 每次运行使用一个带时间戳的目录，旧目录一律保留：账本是事后排查子 agent 停止原因的唯一证据。 */
const ROOT = join(
  import.meta.dir,
  '..',
  '.tmp',
  'replay-ws',
  new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-'),
)
const WS_DIR = join(ROOT, 'checkout')
const DB = join(ROOT, 'replay.sqlite3')
const LOG = join(ROOT, 'replay.log')

/** 服务令牌。只写入环境变量与本机 URL，不写入日志。 */
const TOKEN = crypto.randomUUID()

/** 一轮的最长等待时间。外部 CLI 一次审查通常运行几分钟。 */
const ROUND_TIMEOUT_MS = Number(arg('--round-min') ?? 45) * 60_000
/** 派发即返回的时间上限：该调用只创建记录、启动进程。 */
const DISPATCH_MS = 15_000
/** 一个工作流从首次派发到完成的时间上限。 */
const GRAPH_TIMEOUT_MS = 90 * 60_000
/** 停止与重启之后的观察时长，用于确认没有回执发起新一轮。 */
const QUIET_MS = 60_000

// ─────────────────────────── 记录 ───────────────────────────

/** 同时输出到终端与 `replay.log`。一条路径需要运行几十分钟，中途只能通过该文件查看进度。 */
function out(line: string): void {
  process.stdout.write(`${line}\n`)
  appendFileSync(LOG, `${line}\n`)
}

const stamp = () => new Date().toISOString().slice(11, 19)
const log = (line: string) => out(`[${stamp()}] ${line}`)

let failures = 0
function check(label: string, ok: boolean, detail?: unknown): void {
  out(`${ok ? '  ✓' : '  ✗'} ${label}`)
  if (!ok) {
    failures++
    if (detail !== undefined) out(`      ${JSON.stringify(detail).slice(0, 800)}`)
  }
}

const readings: string[] = []
const note = (line: string) => {
  readings.push(line)
  out(`  · ${line}`)
}

const oneLine = (text: string, limit = 200): string =>
  text.trim().replaceAll('\n', ' | ').slice(0, limit)

// ─────────────────────────── 工作区 ───────────────────────────

/**
 * 一个小型 JS 项目，每个文件都足够短、可一次读完，且各含可明确指出的缺陷，
 * 审查任务因此有确定的产出。运行前实时生成，不纳入仓库。
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

/**
 * 用于超出投递限制的填充文件：内容可机械复述，长度按父模型的单份视图尺寸计算。
 *
 * 摘录上限是 `observationBudget` token 折算的字节数，折算比按最坏密度取 2.5 字节每 token
 * （`@qywork/agent` 的 `tokensToBytes`）。取 1.3 倍才能写入正文库并在回执中留下定位符。
 */
function bulkText(viewTokens: number): string {
  const target = Math.ceil(viewTokens * 2.5 * 1.3)
  const lines: string[] = []
  let size = 0
  for (let i = 1; size < target; i++) {
    const line = `${String(i).padStart(5, '0')}|qywork replay filler line, delivery gate fixture, index ${i}|end`
    lines.push(line)
    size += line.length + 1
  }
  return `${lines.join('\n')}\n`
}

async function writeFixture(viewTokens: number): Promise<number> {
  await mkdir(join(WS_DIR, 'src'), { recursive: true })
  for (const [rel, body] of Object.entries(FIXTURE)) await Bun.write(join(WS_DIR, rel), body)
  const bulk = bulkText(viewTokens)
  await Bun.write(join(WS_DIR, 'bulk.txt'), bulk)
  return bulk.length
}

// ─────────────────────────── 用户原话 ───────────────────────────

/**
 * 每段都指定派发对象（`WHO`）：系统提示规定只在用户点名或明确要求时派发给外部 CLI，
 * 未指定时模型会创建临时子 agent。
 */
const MESSAGES = {
  single:
    `派 ${WHO} 审查这个项目里的 src/cart.js。任务就写：只读 src/cart.js，不要修改任何文件，` +
    '列出这个文件的缺陷并给一句总体结论；然后把工作区根目录下 bulk.txt 的全文一字不差地抄进' +
    '你的最终回答里，不要省略、不要用省略号、不要总结。\n' +
    '你自己不要读任何文件、不要调用别的工具，派出去之后直接告诉我你派出去了。\n' +
    '它的回执到了之后：把它对 src/cart.js 的结论转述给我；如果回执里说完整输出已保存，' +
    '就用 read_resource 读回完整内容，并告诉我 bulk.txt 的最后一行是什么。',
  inject:
    `先派 ${WHO} 做一件小事：任务就写「只读 src/format.js，指出它的缺陷，三句话说完，` +
    '不要修改任何文件」。派出去之后立刻用 run_command 执行 `sleep 240`，timeout_ms 填 300000。\n' +
    '命令跑完之后，把这中间收到的子 agent 回执内容转述给我。中途不要重复派活，也不要调别的工具。',
  long:
    `派 ${WHO} 做一件长活。任务就写：读完 src 下的全部 js 文件与 package.json，` +
    '逐个文件写一份问题清单（每个文件至少五条，说清行为缺陷与边界处理），' +
    '再写一份整体重构建议（模块划分、错误处理、测试策略），不要修改任何文件。\n' +
    '你自己不要读文件、不要调用别的工具，派出去之后直接告诉我你派出去了。',
  graph:
    '用 workflow 一次交一整张图，不要用 subagent 一个个派：\n' +
    '第一批四个临时子 agent 并行，各审查一个文件——分别是 src/cart.js、src/discount.js、' +
    'src/inventory.js、src/format.js，每个只读它那一个文件、不要修改任何文件，列出缺陷并给一句结论；' +
    '这四格接同一个 checkpoint。\n' +
    '第二批一个临时子 agent，把四份清单合成一份总报告（只用上游产出，不读文件），' +
    '它接在第一个 checkpoint 后面，后面再接第二个 checkpoint。\n' +
    'maxConcurrent 填 4，模型都不要指定，跟当前会话。\n' +
    '收到检查点回执再决定：第一个 checkpoint 核验后 approve 进第二批，第二个 checkpoint 到了也 approve，' +
    '最后把总报告转述给我。',
  recall: '你手上还有没有没跑完的子 agent？只回答这一句，不要派活、不要调用任何工具。',
  assign:
    '帮我设立4个子agent，然后分别安排glm5.3flash、qwen3.8flash、deepseek4.0flash version、Gemini3.8flash。' +
    '同时做一个赛车游戏，要3d的，漫画风格，最后你来做验收和横向对比，主要是看游戏有没有bug还有可玩性，有bug让他们继续优化,，利用workflow的功能，来完成这件事',
}

// ─────────────────────────── 服务进程 ───────────────────────────

interface Service {
  proc: Bun.Subprocess
  port: number
}

let service: Service | null = null
const portOf = (): number => service?.port ?? 0

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    Bun.sleep(ms).then<never>(() => {
      throw new Error(`等待 ${label} 超时（${Math.round(ms / 1000)}s）`)
    }),
  ])
}

async function drain(stream: ReadableStream<Uint8Array>, onText?: (text: string) => void) {
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true })
    onText?.(text)
    const trimmed = text.trim()
    if (trimmed) out(`  [svc] ${oneLine(trimmed, 400)}`)
  }
}

/**
 * 启动服务进程。
 *
 * argv 第一位用 `process.execPath` 直接运行该文件，不要写成 `bun run <文件>`：
 * 后者先启动一个转发进程再启动真正的服务，`kill` 只能结束转发进程，
 * 服务进程继续写入同一份账本，「停止服务再重启」路径因此无法复现。
 */
async function startService(): Promise<void> {
  const proc = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'replay-server.ts'), DB, WS_DIR],
    {
      cwd: join(import.meta.dir, '..'),
      env: { ...process.env, QY_REPLAY_TOKEN: TOKEN },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  const ready = Promise.withResolvers<number>()
  let buffered = ''
  void drain(proc.stdout, (text) => {
    buffered += text
    const hit = /port=(\d+)/.exec(buffered)
    if (hit) ready.resolve(Number(hit[1]))
  }).then(() => ready.reject(new Error('服务进程未输出端口即退出')))
  void drain(proc.stderr)
  const port = await withTimeout(ready.promise, 90_000, '服务进程输出端口')
  service = { proc, port }
  log(`服务进程已启动：pid ${proc.pid}，端口 ${port}`)
}

async function stopService(): Promise<void> {
  if (!service) return
  const { proc } = service
  service = null
  proc.kill()
  await proc.exited
  log(`服务进程已停止：pid ${proc.pid}`)
}

async function createConversation(title: string): Promise<ConversationId> {
  const res = await fetch(`http://127.0.0.1:${portOf()}/api/conversations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ title, provider: PARENT.provider, model: PARENT.model }),
  })
  const body = (await res.json().catch(() => ({}))) as { conversation?: { id?: string } }
  const id = body.conversation?.id
  if (!id) throw new Error(`创建会话失败：HTTP ${res.status}`)
  return id as ConversationId
}

// ─────────────────────────── 事件流 ───────────────────────────

type Started = Extract<AgentEvent, { type: 'tool.started' }>
type Finished = Extract<AgentEvent, { type: 'tool.finished' }>
type RunStarted = Extract<AgentEvent, { type: 'run.started' }>
type Busy = Extract<AgentEvent, { type: 'conversation.busy' }>
type Injected = Extract<AgentEvent, { type: 'message.injected' }>
type TextDelta = Extract<AgentEvent, { type: 'text.delta' }>

interface Feed {
  conversationId: ConversationId
  events: AgentEvent[]
  /** 与 `events` 同下标：收到对应事件的本机时刻，用于计算派发到返回的间隔。 */
  stamps: number[]
  send(content: string): void
  interrupt(): void
  /** 服务进程重启后重新连接并重新订阅。 */
  reconnect(): Promise<void>
  close(): void
}

const TRACED_TOOLS = new Set(['workflow', 'subagent', 'read_resource', 'run_command'])

async function openFeed(conversationId: ConversationId): Promise<Feed> {
  const events: AgentEvent[] = []
  const stamps: number[] = []
  const toolNames = new Map<string, string>()
  let socket: WebSocket | null = null

  const trace = (ev: AgentEvent): void => {
    switch (ev.type) {
      case 'run.started':
        log(
          `run.started ${ev.runId}${ev.userMessage ? ` ← ${oneLine(ev.userMessage.content)}` : ''}`,
        )
        break
      case 'tool.started':
        toolNames.set(ev.toolCallId, ev.toolName)
        if (TRACED_TOOLS.has(ev.toolName)) {
          log(`tool.started ${ev.toolName} ${oneLine(JSON.stringify(ev.args), 300)}`)
        }
        break
      case 'tool.finished': {
        const name = toolNames.get(ev.toolCallId)
        if (name && TRACED_TOOLS.has(name)) {
          log(
            `tool.finished ${name} ${ev.status} ${oneLine(String(ev.outcome?.message ?? ''), 300)}`,
          )
        }
        break
      }
      case 'team.member':
        log(
          `node ${ev.nodeId} → ${ev.state.phase}${ev.state.subagentId ? ` (${ev.state.subagentId})` : ''}${ev.state.error ? `：${ev.state.error}` : ''}`,
        )
        break
      case 'message.injected':
        log(`message.injected ${oneLine(ev.content)}`)
        break
      case 'conversation.busy':
        if (ev.conversationId === conversationId) log(`busy=${ev.busy}`)
        break
      case 'run.finished':
      case 'run.error':
        log(`${ev.type} ${oneLine(JSON.stringify(ev), 300)}`)
        break
      default:
        break
    }
  }

  const connect = async (): Promise<void> => {
    const ws = new WebSocket(`ws://127.0.0.1:${portOf()}/stream?token=${TOKEN}&origin=desktop`)
    await new Promise<void>((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true })
      ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true })
    })
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(String(e.data)) as {
        seq?: number
        event?: AgentEvent
        type?: string
        message?: string
      }
      if (msg.type === 'hello.err') {
        log(`hello 失败：${msg.message}`)
        return
      }
      if (!msg.seq || !msg.event) return
      events.push(msg.event)
      stamps.push(Date.now())
      trace(msg.event)
    })
    ws.send(
      JSON.stringify({
        type: 'hello',
        token: TOKEN,
        origin: 'desktop',
        subscribe: [conversationId],
      }),
    )
    await Bun.sleep(300)
    socket = ws
  }

  await connect()
  return {
    conversationId,
    events,
    stamps,
    send(content) {
      socket?.send(
        JSON.stringify({
          type: 'message.send',
          clientRequestId: crypto.randomUUID(),
          conversationId,
          content,
        }),
      )
    },
    interrupt() {
      socket?.send(JSON.stringify({ type: 'conversation.interrupt', conversationId }))
    },
    async reconnect() {
      socket?.close()
      socket = null
      await connect()
    },
    close() {
      socket?.close()
      socket = null
    },
  }
}

// ─────────────────────────── 事件流上的判据 ───────────────────────────

function firstIndex(feed: Feed, from: number, hit: (ev: AgentEvent) => boolean): number {
  for (let i = Math.max(0, from); i < feed.events.length; i++) {
    if (hit(feed.events[i]!)) return i
  }
  return -1
}

function lastIndex(feed: Feed, from: number, hit: (ev: AgentEvent) => boolean): number {
  for (let i = feed.events.length - 1; i >= Math.max(0, from); i--) {
    if (hit(feed.events[i]!)) return i
  }
  return -1
}

/** 等待条件成立。判据无法对应到某一条事件时使用。 */
async function waitUntil(label: string, hit: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (hit()) return
    await Bun.sleep(400)
  }
  throw new Error(`等待 ${label} 超时（${Math.round(ms / 1000)}s）`)
}

async function waitIndex(
  feed: Feed,
  label: string,
  from: number,
  hit: (ev: AgentEvent) => boolean,
  ms: number,
): Promise<number> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const at = firstIndex(feed, from, hit)
    if (at >= 0) return at
    await Bun.sleep(400)
  }
  throw new Error(`等待 ${label} 超时（${Math.round(ms / 1000)}s）`)
}

interface Round {
  start: number
  end: number
  runId: RunId
  ended: AgentEvent
}

/**
 * 等待从 `from` 起的完整一轮。
 *
 * 收尾必须按 runId 识别。一轮报错时 `run.error` 与 `run.finished` 先后发送，
 * 只等待下一条终态事件时，后到的一条会使下一轮被立即判定为已收尾。
 */
async function awaitRound(feed: Feed, label: string, from: number, ms: number): Promise<Round> {
  const deadline = Date.now() + ms
  const start = await waitIndex(feed, `${label} 开始`, from, (ev) => ev.type === 'run.started', ms)
  const runId = (feed.events[start] as RunStarted).runId
  const end = await waitIndex(
    feed,
    `${label} 结束`,
    start,
    (ev) => (ev.type === 'run.finished' || ev.type === 'run.error') && ev.runId === runId,
    Math.max(1000, deadline - Date.now()),
  )
  return { start, end, runId, ended: feed.events[end]! }
}

/** 同 `awaitRound`，超时返回 null 而不是抛错。回执驱动的轮次不保证存在下一轮。 */
async function tryRound(
  feed: Feed,
  label: string,
  from: number,
  ms: number,
): Promise<Round | null> {
  try {
    return await awaitRound(feed, label, from, ms)
  } catch {
    return null
  }
}

/** 该轮的模型正文。 */
function textOf(feed: Feed, round: Round): string {
  return feed.events
    .slice(round.start, round.end + 1)
    .filter((ev): ev is TextDelta => ev.type === 'text.delta')
    .map((ev) => ev.delta)
    .join('')
}

/**
 * 一次工具调用在事件流中的起止下标。
 *
 * `pick` 默认取最后一次：模型遗漏参数时调用被工具拒绝并重新派发，之前的调用不计入。
 * 需要该会话对该工具的第一次调用（首次派发）时传 `'first'`：同一个工作流之后的
 * approve 与 revise 也使用该工具名。
 */
function callOf(
  feed: Feed,
  from: number,
  toolName: string,
  pick: 'first' | 'last' = 'last',
): { call: Started; started: number; finished: number; done: Finished } | null {
  const locate = pick === 'first' ? firstIndex : lastIndex
  const startedAt = locate(
    feed,
    from,
    (ev) => ev.type === 'tool.started' && ev.toolName === toolName,
  )
  if (startedAt < 0) return null
  const call = feed.events[startedAt] as Started
  const finishedAt = firstIndex(
    feed,
    startedAt,
    (ev) => ev.type === 'tool.finished' && ev.toolCallId === call.toolCallId,
  )
  if (finishedAt < 0) return null
  return {
    call,
    started: startedAt,
    finished: finishedAt,
    done: feed.events[finishedAt] as Finished,
  }
}

/** 某个工具在该区间内的全部终态，按到达顺序排列。 */
function finishedOf(feed: Feed, from: number, toolName: string): Finished[] {
  const ids = new Set(
    feed.events
      .filter((ev): ev is Started => ev.type === 'tool.started' && ev.toolName === toolName)
      .map((ev) => ev.toolCallId),
  )
  return feed.events
    .slice(Math.max(0, from))
    .filter((ev): ev is Finished => ev.type === 'tool.finished' && ids.has(ev.toolCallId))
}

/**
 * 回执正文在事件流中的两种位置：发起新一轮（`run.started` 带 `userMessage`），
 * 或注入当前轮（`message.injected`）。
 */
interface Receipt {
  index: number
  content: string
  injected: boolean
}

function receipts(feed: Feed, from: number): Receipt[] {
  const out: Receipt[] = []
  for (let i = Math.max(0, from); i < feed.events.length; i++) {
    const ev = feed.events[i]!
    if (ev.type === 'run.started' && ev.userMessage?.content.startsWith('[')) {
      out.push({ index: i, content: ev.userMessage.content, injected: false })
    }
    if (ev.type === 'message.injected' && (ev as Injected).content.startsWith('[')) {
      out.push({ index: i, content: (ev as Injected).content, injected: true })
    }
  }
  return out.filter((r) => /^\[(子 agent|workflow) 回执\]/.test(r.content))
}

/** 该会话当前的忙态：事件流中最后一条 `conversation.busy`。 */
function busyNow(feed: Feed): boolean | null {
  const at = lastIndex(
    feed,
    0,
    (ev) => ev.type === 'conversation.busy' && ev.conversationId === feed.conversationId,
  )
  return at < 0 ? null : (feed.events[at] as Busy).busy
}

// ─────────────────────────── 账本上的判据 ───────────────────────────

let store: Store

function stepById(conversationId: ConversationId, stepId: string): Step | undefined {
  return listRuns(store, conversationId)
    .flatMap((r) => listSteps(store, r.id))
    .find((s) => s.id === stepId)
}

function nodesOn(step: Step | undefined): Record<string, NodeState> | undefined {
  const payload = step?.payload
  if (!payload) return undefined
  return payload.kind === 'tool_call' || payload.kind === 'tool_result' ? payload.nodes : undefined
}

function nodeOf(
  conversationId: ConversationId,
  stepId: string,
  nodeId: string,
): NodeState | undefined {
  return nodesOn(stepById(conversationId, stepId))?.[nodeId]
}

/** 账本中带来源的消息行。只有回执发起新一轮时才存在；注入的回执写在 step 上，此处为空。 */
function originMessages(conversationId: ConversationId) {
  return listMessages(store, conversationId).filter((m) => m.origin !== null)
}

/** 该会话各 run 中注入的用户 step。 */
function injectedSteps(conversationId: ConversationId) {
  return listRuns(store, conversationId)
    .flatMap((r) => listSteps(store, r.id))
    .filter((s) => s.kind === 'user')
}

/**
 * 账本中带来源标记的两处记录，合并返回。
 *
 * 回执写入哪一处取决于投递时父会话是否在运行：空闲时发起新一轮，写入 `messages.origin`；
 * 运行中则注入当前轮，写入 step 的 `payload.origin`。判据必须识别两处，只识别一处会把另一种形状判定为没有标记。
 */
function originLanded(conversationId: ConversationId): ('subagent' | 'workflow')[] {
  const fromMessages = originMessages(conversationId).map(
    (m) => m.origin as 'subagent' | 'workflow',
  )
  const fromSteps = injectedSteps(conversationId).flatMap((s) =>
    s.payload?.kind === 'user' && s.payload.origin ? [s.payload.origin] : [],
  )
  return [...fromMessages, ...fromSteps]
}

/** 等待节点进入指定的相位，返回该节点状态。 */
async function waitNode(
  conversationId: ConversationId,
  stepId: string,
  nodeId: string,
  phases: string[],
  ms: number,
): Promise<NodeState> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const state = nodeOf(conversationId, stepId, nodeId)
    if (state && phases.includes(state.phase)) return state
    await Bun.sleep(500)
  }
  const state = nodeOf(conversationId, stepId, nodeId)
  throw new Error(
    `等待 ${nodeId} 进入 ${phases.join('/')} 超时，当前为 ${state?.phase ?? '（无此节点）'}`,
  )
}

// ─────────────────────────── 6.1 单项派发 ───────────────────────────

/** 审查结论中可识别的词：模型转述结论时至少命中一个。 */
const REVIEW_MARKS = ['cart', 'subtotal', '越界', 'splice', 'removeItem', 'addItem']

async function pathSingle(): Promise<void> {
  out('\n══ 6.1 单项派发：指定 @cli:claude 审查一个文件 ══')
  const conversationId = await createConversation('6.1 单项派发')
  const feed = await openFeed(conversationId)
  try {
    const from = feed.events.length
    feed.send(MESSAGES.single)
    const first = await awaitRound(feed, '6.1 首轮', from, ROUND_TIMEOUT_MS)
    const hit = callOf(feed, from, 'subagent')
    if (!hit) throw new Error('6.1：该轮未派发 subagent')
    const data = (hit.done.outcome.data ?? {}) as { subagentId?: string }
    const subagentId = data.subagentId ?? ''
    const latency = (feed.stamps[hit.finished] ?? 0) - (feed.stamps[hit.started] ?? 0)

    check(
      `6.1 subagent 派发即返回（${(latency / 1000).toFixed(1)}s ≤ ${DISPATCH_MS / 1000}s）`,
      latency <= DISPATCH_MS,
      latency,
    )
    check('6.1 该调用的终态为成功', hit.done.status === 'success', [
      hit.done.status,
      hit.done.outcome.message,
    ])
    check('6.1 回执带有 subagentId', !!subagentId, hit.done.outcome)
    check(
      '6.1 该轮随即结束（run.finished）',
      first.ended.type === 'run.finished',
      oneLine(JSON.stringify(first.ended), 300),
    )
    check('6.1 结束后忙态仍为 true', busyNow(feed) === true, busyNow(feed))
    const working = nodeOf(conversationId, hit.call.stepId, SUBAGENT_NODE_ID)
    check('6.1 卡片上的节点仍在运行（working）', working?.phase === 'working', working)
    check(`6.1 卡片上节点的种类为 ${SUBAGENT_KIND}`, working?.kind === SUBAGENT_KIND, working)
    note(
      `6.1 派发后 ${(latency / 1000).toFixed(1)}s 返回；首轮 ${((feed.stamps[first.end]! - feed.stamps[first.start]!) / 1000).toFixed(1)}s；` +
        `subagentId=${subagentId}`,
    )

    // ── 回执发起新一轮 ──
    const receiptAt = await waitIndex(
      feed,
      '6.1 子 agent 回执',
      first.end,
      (ev) => ev.type === 'run.started' && !!ev.userMessage?.content.startsWith('[子 agent 回执]'),
      ROUND_TIMEOUT_MS,
    )
    const receipt = (feed.events[receiptAt] as RunStarted).userMessage?.content ?? ''
    check(
      '6.1 回执发起了新一轮，未注入任何一轮',
      receipts(feed, first.end).every((r) => !r.injected),
      receipts(feed, first.end).map((r) => [r.injected, oneLine(r.content, 120)]),
    )
    check(
      '6.1 回执首行为 [子 agent 回执] 且带有 subagentId',
      receipt.split('\n')[0]?.startsWith('[子 agent 回执]') === true &&
        receipt.includes(subagentId),
      oneLine(receipt, 300),
    )
    const rows = originMessages(conversationId)
    check(
      '6.1 账本中该消息带有 origin=subagent',
      rows.length === 1 && rows[0]?.origin === 'subagent' && rows[0]?.content === receipt,
      rows.map((m) => [m.origin, oneLine(m.content, 120)]),
    )
    const done = await waitNode(
      conversationId,
      hit.call.stepId,
      SUBAGENT_NODE_ID,
      ['done', 'failed'],
      5000,
    )
    check('6.1 卡片上的节点变为 done', done.phase === 'done', done)
    note(`6.1 回执 ${receipt.length} 字符，首行：${oneLine(receipt.split('\n')[0] ?? '', 160)}`)

    const second = await awaitRound(feed, '6.1 回执轮', receiptAt, ROUND_TIMEOUT_MS)
    const said = textOf(feed, second)
    check(
      '6.1 新一轮中模型引用了审查结论',
      REVIEW_MARKS.some((m) => said.toLowerCase().includes(m.toLowerCase())),
      oneLine(said, 400),
    )
    note(`6.1 回执轮正文 ${said.length} 字符：${oneLine(said, 240)}`)

    // ── 超长产出：定位符可读取 ──
    const locator = /完整输出已保存：(rs_[0-9a-zA-Z]+)/.exec(receipt)
    if (!locator) {
      note('6.1 回执未超出预算，没有可读取的定位符；本次未验证 read_resource')
    } else {
      const reads = finishedOf(feed, receiptAt, 'read_resource')
      check(
        `6.1 回执中的定位符 ${locator[1]} 在新一轮中可读取`,
        reads.some((r) => r.status === 'success'),
        reads.map((r) => [r.status, oneLine(r.outcome.message, 160)]),
      )
      note(`6.1 定位符 ${locator[1]}，read_resource 调用 ${reads.length} 次`)
    }
  } finally {
    feed.close()
  }
}

// ─────────────────────────── 6.2 注入 ───────────────────────────

async function pathInject(): Promise<void> {
  out('\n══ 6.2 注入：父会话运行中子 agent 完成 ══')
  const conversationId = await createConversation('6.2 注入')
  const feed = await openFeed(conversationId)
  try {
    const from = feed.events.length
    feed.send(MESSAGES.inject)
    const round = await awaitRound(feed, '6.2 本轮', from, ROUND_TIMEOUT_MS)
    const injected = feed.events
      .slice(round.start, round.end + 1)
      .filter((ev): ev is Injected => ev.type === 'message.injected')
      .filter((ev) => ev.content.startsWith('[子 agent 回执]'))

    check('6.2 回执注入本轮，未发起新一轮', injected.length === 1, injected.length)
    const steps = injectedSteps(conversationId).filter(
      (s) => s.payload?.kind === 'user' && s.payload.origin === 'subagent',
    )
    check(
      '6.2 回执写入为 run 内的 step（kind:user，payload.origin=subagent）',
      steps.length === 1,
      injectedSteps(conversationId).map((s) => [s.kind, s.payload]),
    )
    check('6.2 该 step 属于本轮', steps[0]?.runId === round.runId, [steps[0]?.runId, round.runId])
    const runs = listRuns(store, conversationId)
    check(
      `6.2 只有一轮（runs=${runs.length}）`,
      runs.length === 1,
      runs.map((r) => r.id),
    )
    check(
      '6.2 账本中未新增带 origin 的消息行',
      originMessages(conversationId).length === 0,
      originMessages(conversationId).map((m) => m.origin),
    )
    const said = textOf(feed, round)
    const after = said.slice(Math.max(0, said.length - 1500))
    check(
      '6.2 模型在同一轮中随后引用了回执',
      /format\.js|回执|money|line/i.test(after),
      oneLine(said, 400),
    )
    const cmd = callOf(feed, from, 'run_command')
    note(
      `6.2 本轮 ${((feed.stamps[round.end]! - feed.stamps[round.start]!) / 1000).toFixed(1)}s；` +
        `注入正文首行：${oneLine(injected[0]?.content.split('\n')[0] ?? '（没有）', 160)}`,
    )
    note(
      `6.2 长命令 ${cmd ? oneLine(String((cmd.call.args as { command?: string }).command ?? ''), 80) : '（未调用 run_command）'}`,
    )
  } finally {
    feed.close()
  }
}

// ─────────────────────────── 6.3 全部停止 ───────────────────────────

async function pathStop(): Promise<void> {
  out('\n══ 6.3 全部停止：仅子 agent 运行时执行停止 ══')
  const conversationId = await createConversation('6.3 停止')
  const feed = await openFeed(conversationId)
  try {
    const from = feed.events.length
    feed.send(MESSAGES.long)
    const round = await awaitRound(feed, '6.3 首轮', from, ROUND_TIMEOUT_MS)
    const hit = callOf(feed, from, 'subagent')
    if (!hit) throw new Error('6.3：该轮未派发 subagent')
    const working = nodeOf(conversationId, hit.call.stepId, SUBAGENT_NODE_ID)
    check(
      '6.3 执行停止之前只有子 agent 在运行',
      working?.phase === 'working' && busyNow(feed) === true,
      [working?.phase, busyNow(feed)],
    )
    check('6.3 该轮已结束', round.ended.type === 'run.finished', round.ended.type)

    const quietFrom = feed.events.length
    log('发送 conversation.interrupt')
    feed.interrupt()
    const stopped = await waitNode(
      conversationId,
      hit.call.stepId,
      SUBAGENT_NODE_ID,
      ['interrupted', 'failed', 'done'],
      120_000,
    )
    check('6.3 节点进入中断', stopped.phase === 'interrupted', stopped)
    check(
      '6.3 节点的错误原因为停止',
      ['已停止', '调用中断'].includes(stopped.error ?? ''),
      stopped.error,
    )
    await waitIndex(
      feed,
      '6.3 忙态恢复为 false',
      quietFrom,
      (ev) => ev.type === 'conversation.busy' && ev.conversationId === conversationId && !ev.busy,
      120_000,
    )
    check('6.3 忙态恢复为 false', busyNow(feed) === false, busyNow(feed))

    log(`观察 ${QUIET_MS / 1000}s，确认没有回执发起新一轮`)
    await Bun.sleep(QUIET_MS)
    const started = feed.events.slice(quietFrom).filter((ev) => ev.type === 'run.started')
    check(`6.3 停止之后没有新发起的轮次（${started.length}）`, started.length === 0, started)
    check(
      '6.3 账本中没有任何带 origin 的记录',
      originLanded(conversationId).length === 0,
      originLanded(conversationId),
    )
    check(
      '6.3 未注入任何一轮',
      receipts(feed, quietFrom).length === 0,
      receipts(feed, quietFrom).map((r) => oneLine(r.content, 120)),
    )
    note(
      `6.3 停止后节点的相位 ${stopped.phase}，错误原因「${stopped.error ?? ''}」，忙态 ${busyNow(feed)}`,
    )
  } finally {
    feed.close()
  }
}

// ─────────────────────────── 6.4 工作流 ───────────────────────────

async function pathGraph(): Promise<void> {
  out('\n══ 6.4 工作流：首次派发立即返回、节点逐个结束、检查点回执、批准后执行下一批 ══')
  const conversationId = await createConversation('6.4 工作流')
  const feed = await openFeed(conversationId)
  try {
    const from = feed.events.length
    feed.send(MESSAGES.graph)
    /*
     * 首次派发取该会话对 workflow 的第一次调用，且必须在等待该轮收尾之前取得。
     *
     * 父会话仍在运行时回执注入的是同一轮，该轮会持续到整个工作流执行完毕；
     * 在其收尾之后再取，取得的是末尾的 approve 调用。
     */
    await waitUntil(
      '6.4 首次派发 workflow 返回',
      () => callOf(feed, from, 'workflow', 'first') !== null,
      ROUND_TIMEOUT_MS,
    )
    const hit = callOf(feed, from, 'workflow', 'first')
    if (!hit) throw new Error('6.4：该轮未派发 workflow')
    const first = await awaitRound(feed, '6.4 首轮', from, ROUND_TIMEOUT_MS)
    const data = (hit.done.outcome.data ?? {}) as { workflowId?: string; dispatched?: string[] }
    const latency = (feed.stamps[hit.finished] ?? 0) - (feed.stamps[hit.started] ?? 0)
    const workflowId = data.workflowId ?? hit.call.stepId

    check(
      `6.4 首次派发立即返回（${(latency / 1000).toFixed(1)}s ≤ ${DISPATCH_MS / 1000}s）`,
      latency <= DISPATCH_MS,
      latency,
    )
    check('6.4 首次派发返回了运行中的节点', (data.dispatched ?? []).length > 0, data)
    // 首次派发返回时四个节点均未进入终态，才符合「派发即返回」；等待该轮收尾后无法判定，
    // 因为回执注入同一轮时，该轮会持续到整个工作流执行完毕。
    const settledAt = firstIndex(
      feed,
      hit.started,
      (ev) =>
        ev.type === 'team.member' &&
        ['done', 'failed', 'interrupted', 'skipped'].includes(ev.state.phase),
    )
    check('6.4 首次派发返回时尚无节点进入终态', settledAt < 0 || settledAt > hit.finished, [
      settledAt,
      hit.finished,
    ])
    note(
      `6.4 首次派发 ${(latency / 1000).toFixed(1)}s 返回，已启动 ${(data.dispatched ?? []).join('、')}`,
    )

    // 工作流执行至完成：其间的每一轮都由回执驱动。
    const deadline = Date.now() + GRAPH_TIMEOUT_MS
    const completed = () =>
      finishedOf(feed, from, 'workflow').some((f) =>
        String(f.outcome.message ?? '').includes('Workflow 已完成'),
      )
    let cursor = first.end
    while (Date.now() < deadline && !completed()) {
      const next = await tryRound(
        feed,
        '6.4 回执轮',
        cursor,
        Math.min(ROUND_TIMEOUT_MS, deadline - Date.now()),
      )
      if (!next) break
      cursor = next.end
    }

    const all = receipts(feed, from)
    const failure = all.find((r) => r.content.includes('）失败：'))
    const checkpoint = all.find((r) => r.content.includes('检查点'))
    check(
      '6.4 出现了检查点回执',
      !!checkpoint,
      all.map((r) => oneLine(r.content, 120)),
    )
    check(
      '6.4 检查点回执正文带有 checkpointId',
      (checkpoint?.content ?? '').includes('checkpointId='),
      oneLine(checkpoint?.content ?? '', 300),
    )
    if (failure) {
      check('6.4 失败回执排在检查点回执之前', !!checkpoint && failure.index < checkpoint.index, [
        failure.index,
        checkpoint?.index,
      ])
      note(`6.4 失败回执：${oneLine(failure.content, 200)}`)
    } else {
      note('6.4 本次没有节点失败，未验证失败回执')
    }

    const origins = originLanded(conversationId)
    check(
      '6.4 回执在账本中带有 origin=workflow',
      origins.length > 0 && origins.every((o) => o === 'workflow'),
      origins,
    )
    note(
      `6.4 回执位置：发起新一轮 ${originMessages(conversationId).length} 条，注入当前轮 ${
        injectedSteps(conversationId).length
      } 条`,
    )

    const approvals = feed.events.filter(
      (ev): ev is Started =>
        ev.type === 'tool.started' &&
        ev.toolName === 'workflow' &&
        (ev.args as { decision?: string }).decision === 'approve',
    )
    check(`6.4 父会话批准了检查点（${approvals.length} 次）`, approvals.length > 0)
    const afterApprove = approvals[0]
      ? callOf(feed, feed.events.indexOf(approvals[0]) - 1, 'workflow')
      : null
    const nextBatch = approvals
      .map((call) => {
        const at = firstIndex(
          feed,
          feed.events.indexOf(call),
          (ev) => ev.type === 'tool.finished' && ev.toolCallId === call.toolCallId,
        )
        return at < 0 ? null : (feed.events[at] as Finished)
      })
      .filter((f): f is Finished => !!f)
      .map((f) => (f.outcome.data ?? {}) as { dispatched?: string[] })
    check(
      '6.4 批准之后下一批开始执行',
      nextBatch.some((d) => (d.dispatched ?? []).length > 0),
      nextBatch,
    )
    check(
      '6.4 最后一次调用报告 Workflow 已完成',
      completed(),
      finishedOf(feed, from, 'workflow').map((f) => oneLine(String(f.outcome.message ?? ''), 120)),
    )

    const records = listWorkflowRecords(store, conversationId)
    const folded = workflowIdsOf(records).flatMap((id) => {
      const r = foldWorkflow(records, id)
      return r.ok ? [r.projection] : []
    })
    check(
      '6.4 账本中该工作流的折叠结果为已完成',
      folded.length === 1 && folded[0]?.phase === 'completed',
      folded.map((w) => [w.workflowId, w.phase, w.checkpointId]),
    )
    const phases = Object.entries(folded[0]?.states ?? {}).map(([id, n]) => `${id}=${n.phase}`)
    check(
      `6.4 每个节点都进入了终态（${phases.join('，')}）`,
      Object.values(folded[0]?.states ?? {}).every((n) =>
        ['done', 'failed', 'skipped', 'interrupted'].includes(n.phase),
      ),
      folded[0]?.states,
    )
    note(`6.4 workflowId=${workflowId}，回执 ${all.length} 条，批准 ${approvals.length} 次`)
    note(`6.4 检查点回执首行：${oneLine((checkpoint?.content ?? '').split('\n')[0] ?? '', 200)}`)
    note(
      `6.4 子会话：${listChildConversations(store, conversationId)
        .map((c) => `${c.title}(${c.source})`)
        .join('，')}`,
    )
    if (afterApprove)
      log(`6.4 末次 workflow 调用：${oneLine(afterApprove.done.outcome.message, 200)}`)
  } finally {
    feed.close()
  }
}

// ─────────────────────────── 6.5 重启 ───────────────────────────

async function pathRestart(): Promise<void> {
  out('\n══ 6.5 重启：子 agent 运行中时停止服务进程再重新启动 ══')
  const conversationId = await createConversation('6.5 重启')
  const feed = await openFeed(conversationId)
  try {
    const from = feed.events.length
    feed.send(MESSAGES.long)
    const round = await awaitRound(feed, '6.5 首轮', from, ROUND_TIMEOUT_MS)
    const hit = callOf(feed, from, 'subagent')
    if (!hit) throw new Error('6.5：该轮未派发 subagent')
    const working = nodeOf(conversationId, hit.call.stepId, SUBAGENT_NODE_ID)
    check('6.5 重启之前该节点仍在运行', working?.phase === 'working', working)
    check('6.5 首轮已结束', round.ended.type === 'run.finished', round.ended.type)

    const quietFrom = feed.events.length
    await stopService()
    await startService()
    await feed.reconnect()

    const swept = nodeOf(conversationId, hit.call.stepId, SUBAGENT_NODE_ID)
    check('6.5 重启后该节点被标记为中断', swept?.phase === 'interrupted', swept)
    check(
      '6.5 账本中没有新增任何带 origin 的记录',
      originLanded(conversationId).length === 0,
      originLanded(conversationId),
    )
    log(`观察 ${QUIET_MS / 1000}s，确认没有自动发起新一轮`)
    await Bun.sleep(QUIET_MS)
    const started = feed.events.slice(quietFrom).filter((ev) => ev.type === 'run.started')
    check(`6.5 重启后没有自动发起新一轮（${started.length}）`, started.length === 0, started)
    note(`6.5 重启后节点的相位 ${swept?.phase}，错误原因「${swept?.error ?? ''}」`)

    // 由下一条用户消息发起新一轮，检查运行快照中该子 agent 的状态。
    const askFrom = feed.events.length
    feed.send(MESSAGES.recall)
    const asked = await awaitRound(feed, '6.5 下一轮', askFrom, ROUND_TIMEOUT_MS)
    const snapshot = listRunContextSnapshots(store, conversationId).find(
      (s) => s.runId === asked.runId,
    )
    const segments = (snapshot?.segments ?? []).map((s) => s.content).join('\n')
    const line = segments.split('\n').find((l) => l.includes('上一轮未完成')) ?? ''
    check('6.5 下一轮的运行快照中该子 agent 标为「上一轮未完成」', !!line, oneLine(segments, 600))
    note(`6.5 快照中的对应行：${oneLine(line, 240)}`)
  } finally {
    feed.close()
  }
}

// ─────────────────────────── 主流程 ───────────────────────────

const RUNNERS: Record<PathId, () => Promise<void>> = {
  '6.1': pathSingle,
  '6.2': pathInject,
  '6.3': pathStop,
  '6.4': pathGraph,
  '6.5': pathRestart,
  assign: pathAssign,
}

/**
 * 模型绑定实验：用户原话指定四个模型，检查父会话是否把它们填入节点的 provider / model。
 * 只检查派发调用的参数（被拒绝的调用也计入，参数已经写出），随后全部停止，不让子 agent 实际运行。
 */
async function pathAssign(): Promise<void> {
  out('\n══ assign 模型绑定：用户指定四个模型，检查父会话是否填写参数 ══')
  const conversationId = await createConversation('assign 模型绑定')
  const feed = await openFeed(conversationId)
  try {
    const from = feed.events.length
    feed.send(MESSAGES.assign)
    const isDispatch = (ev: AgentEvent): boolean =>
      ev.type === 'tool.started' && (ev.toolName === 'workflow' || ev.toolName === 'subagent')
    await waitIndex(feed, 'assign 首次派发调用', from, isDispatch, ROUND_TIMEOUT_MS)
    await tryRound(feed, 'assign 首轮', from, 90_000)
    feed.interrupt()
    const calls = feed.events.slice(from).filter((ev): ev is Started => isDispatch(ev))
    const agentNodes = (call: Started): Record<string, unknown>[] => {
      const args = call.args as Record<string, unknown>
      const nodes = Array.isArray(args.nodes) ? (args.nodes as Record<string, unknown>[]) : [args]
      return nodes.filter((n) => n.kind !== 'checkpoint')
    }
    calls.forEach((call, i) => {
      const line = agentNodes(call)
        .map(
          (n) =>
            String(n.name ?? n.id ?? '?') +
            ' → provider=' +
            JSON.stringify(n.provider ?? null) +
            ' model=' +
            JSON.stringify(n.model ?? null),
        )
        .join('；')
      note('assign 调用 ' + String(i + 1) + '（' + call.toolName + '）：' + line)
    })
    const last = calls.at(-1)
    const nodes = last ? agentNodes(last) : []
    const bound = nodes.filter((n) => typeof n.model === 'string' && n.model)
    check(
      'assign 最后一次派发调用中每个 agent 节点都填写了 model',
      nodes.length > 0 && bound.length === nodes.length,
      nodes.map((n) => [n.name ?? n.id, n.provider ?? null, n.model ?? null]),
    )
  } finally {
    feed.close()
  }
}

async function main(): Promise<number> {
  await mkdir(ROOT, { recursive: true })
  const config = await loadConfig()
  const stored = resolveModel(config, PARENT)
  if (!stored) throw new Error(`配置中没有 ${PARENT.provider} / ${PARENT.model}`)
  // 摘录预算与执行时的计算同源（`delegate.ts` 的 deliveryContext）：写死数值时，更换模型后两者不一致。
  const spec = applySpecOverride(lookupModel(stored.model, stored.kind), stored.spec)
  const viewTokens = observationBudget(spec.contextWindow)
  const bulkBytes = await writeFixture(viewTokens)

  store = new Store({ path: DB })
  await startService()
  log(
    `父会话 ${PARENT.provider} / ${PARENT.model}，窗口 ${spec.contextWindow}，单份视图尺寸 ${viewTokens} token`,
  )
  log(`工作区 ${WS_DIR}；bulk.txt ${bulkBytes} 字节；待运行 ${SELECTED.join('、')}`)

  try {
    for (const id of SELECTED) {
      const at = Date.now()
      try {
        await RUNNERS[id]()
      } catch (err) {
        check(`${id} 执行完毕`, false, err instanceof Error ? err.message : String(err))
      }
      log(`${id} 用时 ${((Date.now() - at) / 1000).toFixed(0)}s`)
    }
  } finally {
    await stopService()
    store.close()
  }

  out('\n汇总')
  for (const line of readings) out(`  ${line}`)
  out(`  复现目录 ${ROOT}`)
  return failures
}

const n = await main()
out(`\n${n === 0 ? '全部通过' : `${n} 项未通过`}`)
process.exit(n === 0 ? 0 : 1)
