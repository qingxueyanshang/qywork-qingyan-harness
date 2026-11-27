/**
 * 后台命令的端到端回归测试。使用假 provider 与真实进程，不产生费用、不访问网络。
 *
 * 覆盖范围：`command-tasks/table.ts`（任务表、按会话绑定的端口、回执投递、文件改动的追加）、`tools/src/shell.ts` 的
 * `run_command` 转入后台与后台输出的保留上限、`tools/src/workspace-watch.ts` 的后台观察、
 * `store/src/repos/steps.ts` 的 `appendStepFileChanges`、`store/src/repos/messages.ts` 的 `listConversationChangesPage`、
 * `run-control.ts` 的端口装配与回执入口、`commands.ts` 的 `command.stop`、
 * `runtime/session/tool-context.ts` 的通道注入与 `runtime/session/permission.ts` 的权限裁决、`agent/loop` 在工具结束后注入「调整方向」消息，
 * `team-run.ts` 中子 agent 会话的后台命令端口与轮次之间的处理（`settleAfterRound`）。
 * `background_command` 的取舍由 `tools/src/shell.test.ts` 覆盖，此处只覆盖它经由任务表在本轮内等待命令结束。
 *
 * 必须使用真实链路与真实进程：被测的行为是「工具等待结束而进程仍存活」「停止本轮不结束后台命令」，
 * 替换为桩只能验证桩被调用。进程是否存活按 pid 查询，命令把自身 pid 写入工作区文件。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, readlinkSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationId, EventEnvelope } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  listConversationChangesPage,
  listMessages,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import { EventBus } from '../bus.ts'
import { handleCommand } from '../commands.ts'
import { startRun, submitMessage } from '../run-control.ts'
import { RunManager } from '../runs.ts'
import { SubagentRegistry } from '../subagents.ts'
import { CommandTaskTable } from './table.ts'

// ───────────────────────── 假 provider ─────────────────────────

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

const SSE_HEADERS = { 'content-type': 'text/event-stream' }

function usage() {
  return { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } }
}

/** 一轮工具调用，可含多个调用，按给出的顺序执行。 */
function callsTurn(calls: { id: string; name: string; args: Record<string, unknown> }[]): string {
  const events: { type: string; [k: string]: unknown }[] = [
    { type: 'response.created', response: { id: 'resp_tool' } },
  ]
  calls.forEach((c, i) => {
    events.push(
      {
        type: 'response.output_item.added',
        output_index: i,
        item: { type: 'function_call', id: `fc_${i}`, call_id: c.id, name: c.name },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: i,
        item_id: `fc_${i}`,
        delta: JSON.stringify(c.args),
      },
      { type: 'response.output_item.done', output_index: i, item: { type: 'function_call' } },
    )
  })
  events.push({
    type: 'response.completed',
    response: { id: 'resp_tool', status: 'completed', usage: usage() },
  })
  return sse(events)
}

function textTurn(text: string): string {
  return sse([
    { type: 'response.created', response: { id: 'resp_text' } },
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: { id: 'resp_text', status: 'completed', usage: usage() },
    },
  ])
}

/** 每次请求取出一项；函数在请求到达时生成应答（用于引用工具结果返回之后才确定的任务编号）。 */
let script: (string | (() => string))[] = []
let bodies: string[] = []

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    bodies.push(await req.text())
    const entry = script.shift()
    const next = typeof entry === 'function' ? entry() : entry
    // 脚本耗尽时返回 401（`auth_failed`，立即终止且不重发）：多出的请求由 `bodies` 记录，用例据此断言没有多余的一轮。
    if (!next) return new Response('脚本已用完', { status: 401 })
    return new Response(next, { headers: SSE_HEADERS })
  },
})

// ───────────────────────── 装配 ─────────────────────────

let dir = ''
let store: Store
let content: ContentStore
let bus: EventBus
let runs: RunManager
let subagents: SubagentRegistry
let commands: CommandTaskTable
let config: QyConfig
let workspaceId = ''
let events: EventEnvelope[] = []

/**
 * 被测命令：把 pid 写入 `<名称>.pid`，输出一行，等到 `<名称>.go` 出现时输出完成行并退出。
 * 是否退出由用例写入文件控制，不依赖计时。
 */
const HOLD_SCRIPT = `
const name = process.argv[2] ?? 'x'
await Bun.write(name + '.pid', String(process.pid))
console.log(name + ' started')
const timer = setInterval(async () => {
  if (await Bun.file(name + '.go').exists()) {
    clearInterval(timer)
    console.log(name + ' finished')
    process.exit(0)
  }
}, 20)
`

/**
 * 转入后台之后写入文件的命令：把 pid 写入 `.tmp/<名称>.pid`，等到 `.tmp/<名称>.go` 出现时写入 `late/<名称>.txt`；
 * 第二个参数为 `exit` 时随即退出，否则继续运行直到被停止。控制文件位于 `.tmp`，观察器不报告该目录。
 */
const LATE_SCRIPT = `
import { mkdir, writeFile } from 'node:fs/promises'
const [name, mode] = process.argv.slice(2)
await writeFile('.tmp/' + name + '.pid', String(process.pid))
console.log(name + ' started')
const timer = setInterval(async () => {
  if (!(await Bun.file('.tmp/' + name + '.go').exists())) return
  clearInterval(timer)
  await mkdir('late', { recursive: true })
  await writeFile('late/' + name + '.txt', 'a\\nb\\n')
  console.log(name + ' wrote')
  if (mode === 'exit') process.exit(0)
  setInterval(() => {}, 1000)
}, 20)
`

/**
 * 输出超过保留上限的命令：输出 1200 行、每行 1000 个字符后输出一行完成标记，
 * 等到 `.tmp/<名称>.go` 出现时输出结束行并退出。
 *
 * 完成标记必须用 `process.stdout.write`，不能用 `console.log`：管道写满时，Bun 1.4.2 在 Linux 与
 * macOS 上直接丢弃紧随其后的 `console.log` 输出，而 `process.stdout.write` 的输出排队保留
 * （WSL2 实测：读取方延迟 1 秒时 `console.log` 的一行三次全部丢失，`process.stdout.write` 三次全部到达）。
 */
const FLOOD_SCRIPT = `
import { writeFile } from 'node:fs/promises'
const name = process.argv[2]
await writeFile('.tmp/' + name + '.pid', String(process.pid))
const line = 'x'.repeat(999) + '\\n'
for (let i = 0; i < 1200; i += 1) process.stdout.write(line)
process.stdout.write(name + ' flooded\\n')
const timer = setInterval(async () => {
  if (await Bun.file('.tmp/' + name + '.go').exists()) {
    clearInterval(timer)
    console.log(name + ' finished')
    process.exit(0)
  }
}, 20)
`

/**
 * 持续占用 CPU、没有输出的命令：把 pid 写入 `<名称>.pid` 后循环计算；`<名称>.idle` 出现时停止计算、只每 50 毫秒检查一次文件，
 * `<名称>.go` 出现时退出。停滞判定按进程树的 CPU 占用区分两种状态（`tree.ts` 的 `treeBusy`）。
 */
const SPIN_SCRIPT = `
import { existsSync } from 'node:fs'
const name = process.argv[2]
await Bun.write(name + '.pid', String(process.pid))
for (;;) {
  if (existsSync(name + '.go')) process.exit(0)
  if (existsSync(name + '.idle')) break
  const until = Date.now() + 50
  while (Date.now() < until) {}
}
setInterval(() => {
  if (existsSync(name + '.go')) process.exit(0)
}, 50)
`

/**
 * 交互程序：逐行读取标准输入，每行输出一行回应；输入关闭时输出结束行并退出。
 */
const ANSWER_SCRIPT = [
  "import { createInterface } from 'node:readline'",
  "process.stdout.write('ready' + String.fromCharCode(10))",
  'const rl = createInterface({ input: process.stdin })',
  "rl.on('line', (line) => process.stdout.write('答:' + line.toUpperCase() + String.fromCharCode(10)))",
  "rl.on('close', () => { process.stdout.write('再见' + String.fromCharCode(10)); process.exit(0) })",
].join(String.fromCharCode(10))

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-bgcmd-'))
  await writeFile(join(dir, 'answer.ts'), ANSWER_SCRIPT)
  await writeFile(join(dir, 'hold.ts'), HOLD_SCRIPT)
  await writeFile(join(dir, 'late.ts'), LATE_SCRIPT)
  await writeFile(join(dir, 'flood.ts'), FLOOD_SCRIPT)
  await writeFile(join(dir, 'spin.ts'), SPIN_SCRIPT)
  await mkdir(join(dir, '.tmp'), { recursive: true })
  const dbPath = join(dir, 'bgcmd.sqlite3')
  store = new Store({ path: dbPath })
  content = new ContentStore(contentPathFor(dbPath))
  bus = new EventBus()
  subagents = new SubagentRegistry()
  runs = new RunManager(store, bus, subagents)
  commands = new CommandTaskTable(
    (event, conversationId) => bus.publish(event, conversationId),
    store,
  )
  config = {
    active: { provider: 'fake', model: 'deepseek-v4-flash' },
    providers: {
      fake: {
        kind: 'openai_responses',
        apiKey: 'sk-fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 'deepseek-v4-flash': {} },
      },
    },
    mode: 'auto',
  }
  workspaceId = upsertWorkspace(store, dir, 'bgcmd-ws').id
  bus.subscribe({
    id: 'test',
    origin: 'cli',
    conversations: null,
    send: (frame) => {
      events.push(frame)
    },
  })
})

afterAll(async () => {
  commands.stopAll()
  await provider.stop(true)
  store?.close()
  content?.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

function deps() {
  return { store, content, config, bus, runs, subagents, commands }
}

function conversation(): ConversationId {
  script = []
  bodies = []
  events = []
  return createConversation(store, {
    workspaceId: workspaceId as never,
    provider: 'fake',
    model: 'deepseek-v4-flash',
  }).id
}

async function until(check: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 4000; i += 1) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error(`等待超时：${label}`)
}

/**
 * 等待该会话空闲，且收尾阶段不会再发起下一轮。
 *
 * 收尾时先释放占位，再关闭扩展、取出跟进消息并重新占位；本文件的工作区没有插件与 MCP 服务，
 * 两步之间只经过微任务，轮询无法观察到其间的空闲。后台命令结束时的回执另行发起一轮，用例按请求数等待。
 */
async function idle(cv: ConversationId): Promise<void> {
  await until(() => !runs.isBusy(cv) && runs.armedOf(cv) === null, '会话空闲')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * 等到命令在 `at` 目录（工作区相对）中写出 pid 文件，返回该命令在宿主上的 pid，供 `alive` 查询。
 *
 * Linux 上命令运行在 bwrap 的 pid 命名空间中（`--unshare-pid`），脚本写出的 `process.pid` 是命名空间内的
 * 编号（2、3…），按它查询宿主进程表无法查到该命令，或查到无关的进程。因此在宿主的 /proc 中按命令行
 * （`<bun> <脚本>.ts <名称> …`）与工作目录找到同一个进程。其他平台没有 pid 命名空间，脚本写出的即宿主 pid。
 * 须在命令仍在运行时调用：已退出的进程不在进程表中。
 */
async function pidOf(name: string, at = ''): Promise<number> {
  const file = join(dir, at, `${name}.pid`)
  await until(() => existsSync(file) && readFileSync(file, 'utf8').length > 0, `${name} 的 pid`)
  const written = Number(readFileSync(file, 'utf8'))
  if (process.platform !== 'linux') return written
  const cwd = realpathSync(dir)
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const argv = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0')
      if (argv[0] !== process.execPath || !argv[1]?.endsWith('.ts') || argv[2] !== name) continue
      if (readlinkSync(`/proc/${entry}/cwd`) !== cwd) continue
      return Number(entry)
    } catch {
      // 遍历期间退出的进程：读取失败，跳过。
    }
  }
  throw new Error(`宿主进程表中未找到命令 ${name}`)
}

const run = (id: string, args: Record<string, unknown>) => ({ id, name: 'run_command', args })

/** 接收指令的假连接：只记录回执，不打开真实的 socket。 */
function socket() {
  const sent: Record<string, unknown>[] = []
  return {
    sent,
    ws: {
      data: { authed: true, id: 'c1', origin: 'cli' },
      send: (raw: string) => sent.push(JSON.parse(raw)),
    } as never,
  }
}

/**
 * 运行被测脚本的命令。直接使用 bun 可执行文件的路径：PATH 上的 `bun` 可能是 npm 安装的 sh 脚本，
 * 它经 `exec` 启动 bun 时 Windows 上的父进程链在中途断开，按进程树终止无法到达 bun 本身。
 */
const hold = (name: string) => `"${process.execPath.replaceAll('\\', '/')}" hold.ts ${name}`
const late = (name: string, mode?: 'exit') =>
  `"${process.execPath.replaceAll('\\', '/')}" late.ts ${name}${mode ? ` ${mode}` : ''}`
const answer = () => `"${process.execPath.replaceAll('\\', '/')}" answer.ts`
const flood = (name: string) => `"${process.execPath.replaceAll('\\', '/')}" flood.ts ${name}`
const spin = (name: string) => `"${process.execPath.replaceAll('\\', '/')}" spin.ts ${name}`

/** 某次工具调用的 step id，取自 `tool.started` 事件。 */
function stepOf(callId: string): string {
  for (const f of events) {
    if (f.event.type === 'tool.started' && f.event.toolCallId === callId) return f.event.stepId
  }
  throw new Error(`未找到调用 ${callId} 的 step`)
}

/** 变更清单中报告了 `path` 的 step 与其所在轮次的用户消息。 */
function changeOwner(cv: ConversationId, path: string) {
  const page = listConversationChangesPage(store, cv, { limit: 10 })
  for (const turn of page.turns) {
    for (const step of turn.steps) {
      const change = step.fileChanges.find((c) => c.path === path)
      if (change) return { turn: turn.text, stepId: step.id, change, totals: page.totals }
    }
  }
  return null
}

// ───────────────────────── 用例 ─────────────────────────

describe('前台命令照常等待', () => {
  test('等待期间没有用户消息：等到命令结束，结果写明退出码，任务表中没有该命令', async () => {
    const cv = conversation()
    await writeFile(join(dir, 'F.go'), '')
    script.push(callsTurn([run('call_f', { command: hold('F') })]), textTurn('构建完成。'))

    void startRun(cv, '运行一次构建', undefined, deps())
    await until(() => bodies.length === 2, '工具结果送达')
    expect(bodies[1]).toContain('命令执行成功')
    expect(bodies[1]).toContain('F finished')
    expect(bodies[1]).not.toMatch(/cmd_[0-9a-f]{8}/)
    await idle(cv)
    expect(commands.listOf(cv)).toEqual([])
    expect(events.some((f) => f.conversationId === cv && f.event.type === 'commands.changed')).toBe(
      false,
    )
  }, 30_000)

  /**
   * 原始失败形状：「排队」的消息结束前台等待，命令转入后台。排队的消息在本轮结束后才送达，不改变当前这一步，
   * 转入后台只使模型提前取得「仍在运行」的结果。
   */
  test('收到「排队」的消息时不转入后台：命令在前台等到结束，消息在本轮结束后送达', async () => {
    const cv = conversation()
    script.push(
      callsTurn([run('call_q', { command: hold('Q') })]),
      textTurn('构建完成。'),
      textTurn('已查看文档。'),
    )

    void startRun(cv, '运行一次构建', undefined, deps())
    await pidOf('Q')
    await until(() => bodies.length === 1, '第一次请求')

    await submitMessage(cv, { id: 'queue_1', content: '构建完再看文档', steer: false }, deps())
    // 端口在队列变化时立即重新检查；此处等待的时长远大于一次检查。
    await Bun.sleep(300)
    expect(bodies.length).toBe(1)
    expect(commands.listOf(cv)).toEqual([])

    await writeFile(join(dir, 'Q.go'), '')
    await until(() => bodies.length === 2, '工具结果送达')
    expect(bodies[1]).toContain('命令执行成功')
    expect(bodies[1]).toContain('Q finished')
    expect(bodies[1]).not.toMatch(/cmd_[0-9a-f]{8}/)
    expect(bodies[1]).not.toContain('构建完再看文档')
    await until(() => bodies.length === 3, '排队的消息开启的下一轮')
    expect(bodies[2]).toContain('构建完再看文档')
    await idle(cv)
    expect(commands.listOf(cv)).toEqual([])
  }, 30_000)
})

describe('前台命令在等待期间转入后台', () => {
  test('收到「调整方向」消息时工具等待结束，命令仍存活；下一次请求带有该消息与命令仍在运行的结果', async () => {
    const cv = conversation()
    script.push(callsTurn([run('call_a', { command: hold('A') })]), textTurn('已改为查看文档。'))

    void startRun(cv, '运行一次构建', undefined, deps())
    const pid = await pidOf('A')
    await until(() => bodies.length === 1, '第一次请求')
    expect(commands.listOf(cv)).toEqual([])

    await submitMessage(cv, { id: 'steer_1', content: '先停下，改为查看文档', steer: true }, deps())
    await until(() => bodies.length === 2, '工具结束后的第二次请求')
    const second = bodies[1]!
    expect(second).toContain('先停下，改为查看文档')
    expect(second).toContain('等待期间用户发来调整方向的消息，命令转入后台继续运行')
    const [task] = commands.listOf(cv)
    expect(task?.command).toBe(hold('A'))
    expect(second).toContain(task!.id)
    expect(second).toContain('A started')

    await idle(cv)
    expect(alive(pid)).toBe(true)

    // 界面按任务编号停止：进程树结束，任务表移除该条，被停止的命令不发送回执。
    // 回执的投递与条目的移除在同一个回调中同步执行，移除之后投递若发生，会话此刻已忙或队列非空。
    const sock = socket()
    const stop = { type: 'command.stop', conversationId: cv, id: task!.id } as const
    await handleCommand(stop, { ...deps(), ws: sock.ws })
    expect(sock.sent).toEqual([])
    await until(() => !alive(pid), '命令进程结束')
    await until(() => commands.listOf(cv).length === 0, '任务表移除')
    expect(runs.isBusy(cv)).toBe(false)
    expect(runs.queueOf(cv)).toEqual([])
    expect(bodies.length).toBe(2)
    await handleCommand(stop, { ...deps(), ws: sock.ws })
    expect(sock.sent.at(-1)).toMatchObject({ type: 'command.rejected', message: '该命令已结束' })
  }, 30_000)
})

/**
 * 原始失败形状：一条持续占用 CPU、没有输出的前台命令，停滞判定每次检查都认为它仍在工作，前台等待不设上限，
 * 工具调用一直不返回，模型无从干预（基准 query-optimize 三次试验阻塞 660–840 秒直到时限）。
 * 等待上限经 `wait_seconds` 取 1 秒，停滞判定经 `timeout_ms` 取 1 秒。
 */
describe('前台命令超过等待上限转入后台', () => {
  const taskOf = (cv: ConversationId) => commands.listOf(cv)[0]?.id ?? ''
  const bg = (id: string, args: Record<string, unknown>) => ({
    id,
    name: 'background_command',
    args,
  })

  test('到达上限时工具返回，命令仍在运行；可经 background_command 读取与停止，被停止的命令没有回执', async () => {
    const cv = conversation()
    script.push(
      callsTurn([run('call_s', { command: spin('Q1'), timeout_ms: 1000, wait_seconds: 1 })]),
      () => callsTurn([bg('call_r', { task_id: taskOf(cv) })]),
      () => callsTurn([bg('call_x', { task_id: taskOf(cv), stop: true })]),
      textTurn('查询过慢，已停止。'),
    )

    void startRun(cv, '运行查询', undefined, deps())
    const pid = await pidOf('Q1')
    await until(() => bodies.length >= 2, '到达等待上限后的第二次请求')
    const [task] = commands.listOf(cv)
    expect(task?.command).toBe(spin('Q1'))
    expect(bodies[1]).toContain(`命令在 1 秒内没有结束，已转入后台继续运行，任务编号 ${task!.id}`)
    expect(alive(pid)).toBe(true)

    await until(() => bodies.length === 4, '读取与停止之后的请求')
    expect(bodies[2]).toContain(`后台命令 ${task!.id}（`)
    expect(bodies[2]).toContain('）仍在运行，输出为至今的内容')
    expect(bodies[3]).toContain(`已停止后台命令 ${task!.id}`)
    await idle(cv)
    await until(() => !alive(pid), '命令进程结束')
    await until(() => commands.listOf(cv).length === 0, '任务表移除')
    expect(bodies.length).toBe(4)
  }, 30_000)

  test('转入后台的命令结束时送达回执；不再占用 CPU 的命令仍按 timeout_ms 判定停滞并送达回执，以 background 启动的命令不判定', async () => {
    const cv = conversation()
    script.push(
      callsTurn([
        run('call_e', { command: spin('Q2'), timeout_ms: 1000, wait_seconds: 1 }),
        run('call_i', { command: spin('Q3'), timeout_ms: 1000, wait_seconds: 1 }),
        run('call_k', { command: hold('Q4'), timeout_ms: 1000, background: true }),
      ]),
      textTurn('三条命令在后台运行。'),
      textTurn('Q2 已完成。'),
      textTurn('Q3 已终止。'),
    )

    void startRun(cv, '运行三条命令', undefined, deps())
    const pidQ2 = await pidOf('Q2')
    const pidQ3 = await pidOf('Q3')
    const pidQ4 = await pidOf('Q4')
    await until(() => bodies.length === 2, '三条命令转入后台后的请求')
    expect(bodies[1]).toContain('命令在 1 秒内没有结束，已转入后台继续运行')
    await idle(cv)
    const ids: Record<string, string> = Object.fromEntries(
      commands.listOf(cv).map((c) => [c.command.split(' ').at(-1) as string, c.id]),
    )

    await writeFile(join(dir, 'Q2.go'), '')
    await until(() => bodies.length === 3, 'Q2 的回执发起的一轮')
    expect(bodies[2]).toContain(`[后台任务回执] 任务 ${ids.Q2} 已结束：命令执行成功`)
    expect(alive(pidQ2)).toBe(false)
    await idle(cv)

    await writeFile(join(dir, 'Q3.idle'), '')
    await until(() => bodies.length === 4, 'Q3 被判定停滞后的回执')
    expect(bodies[3]).toContain(`[后台任务回执] 任务 ${ids.Q3} 已结束：命令连续 1 秒没有输出`)
    expect(bodies[3]).toContain('判定为停滞，已终止')
    await until(() => !alive(pidQ3), 'Q3 的进程结束')
    await idle(cv)

    // Q4 以 background 启动，同样每 20 毫秒检查一次文件、没有输出，在 Q3 被判定停滞之后仍在运行。
    expect(alive(pidQ4)).toBe(true)
    expect(commands.listOf(cv).map((c) => c.id)).toEqual([ids.Q4!])
    commands.stop(cv, ids.Q4!)
    await until(() => !alive(pidQ4), 'Q4 的进程结束')
    await until(() => commands.listOf(cv).length === 0, '任务表移除')
  }, 30_000)
})

/**
 * 子 agent 会话与顶层会话使用同一个任务表与端口。原始失败形状：子 agent 会话没有后台命令端口，一条持续占用 CPU、没有输出的前台命令
 * 使工具调用一直不返回，子 agent 无从干预，派发它的父会话随之一直等待。父会话的第一轮依次调用 subagent 与 wait_subagents，
 * 子 agent 的各次请求因此在父会话的下一次请求之前按顺序到达假 provider。
 */
describe('子 agent 会话中的后台命令', () => {
  const dispatch = (task: string) =>
    callsTurn([
      { id: 'call_d', name: 'subagent', args: { name: '执行者', task } },
      { id: 'call_w', name: 'wait_subagents', args: { timeout_seconds: 25 } },
    ])

  test('前台命令超过等待上限时交回子 agent；本轮结束后等到命令结束，以回执执行下一轮，再向父会话回执', async () => {
    const cv = conversation()
    script.push(
      dispatch('运行查询 M1'),
      callsTurn([run('call_m', { command: spin('M1'), timeout_ms: 1000, wait_seconds: 1 })]),
      textTurn('查询仍在后台运行。'),
      textTurn('查询已完成。'),
      textTurn('子 agent 已完成。'),
    )

    void startRun(cv, '派发查询', undefined, deps())
    const pid = await pidOf('M1')
    await until(() => bodies.length >= 3, '子 agent 在等待上限之后的请求')
    expect(bodies[2]).toContain('命令在 1 秒内没有结束，已转入后台继续运行')
    expect(alive(pid)).toBe(true)

    // 子 agent 本轮已结束，派发仍未返回：等待由前台转入后台的命令。
    await Bun.sleep(300)
    expect(bodies.length).toBe(3)
    await writeFile(join(dir, 'M1.go'), '')
    await until(() => bodies.length >= 4, '回执发起的子 agent 下一轮')
    expect(bodies[3]).toContain('[后台任务回执] 任务 cmd_')
    expect(bodies[3]).toContain('已结束：命令执行成功')
    await until(() => bodies.length === 5, '父会话收到子 agent 回执后的请求')
    expect(bodies[4]).toContain('[子 agent 回执]')
    expect(bodies[4]).toContain('查询仍在后台运行。')
    expect(bodies[4]).toContain('查询已完成。')
    expect(bodies[4]).not.toContain('停止了仍在运行的后台命令')
    await idle(cv)
    expect(alive(pid)).toBe(false)
  }, 30_000)

  test('以 background 启动的命令在子 agent 结束时停止，并写入返回父会话的回执', async () => {
    const cv = conversation()
    script.push(
      dispatch('启动服务 M2'),
      // 前台命令 M2g 使子 agent 停留到取得 M2 的宿主 pid：按脚本应答时子 agent 在毫秒内结束并停止 M2，
      // Linux 上之后已无法在进程表中找到它；Windows 上停止时 shell 可能尚未创建 M2 的进程。
      callsTurn([
        run('call_h', { command: hold('M2'), timeout_ms: 1000, background: true }),
        run('call_g', { command: hold('M2g') }),
      ]),
      textTurn('服务已启动。'),
      textTurn('子 agent 已完成。'),
    )

    void startRun(cv, '派发服务', undefined, deps())
    const pid = await pidOf('M2')
    await pidOf('M2g')
    await writeFile(join(dir, 'M2g.go'), '')
    await until(() => bodies.length === 4, '父会话收到子 agent 回执后的请求')
    expect(bodies[3]).toContain('服务已启动。')
    expect(bodies[3]).toContain('子 agent 结束时停止了仍在运行的后台命令：cmd_')
    expect(bodies[3]).toContain('hold.ts M2')
    await idle(cv)
    await until(() => !alive(pid), 'M2 的进程结束')
  }, 30_000)
})

describe('后台命令结束时的回执', () => {
  test('会话空闲且上一轮正常结束：回执发起一轮并送达模型，消息来源记为 command', async () => {
    const cv = conversation()
    script.push(
      callsTurn([run('call_b', { command: hold('B'), background: true })]),
      textTurn('构建已在后台启动。'),
      textTurn('构建已完成。'),
    )

    void startRun(cv, '后台构建', undefined, deps())
    await until(() => bodies.length === 2, '工具结果送达')
    expect(bodies[1]).toContain('命令已在后台启动')
    await idle(cv)
    const pid = await pidOf('B')
    expect(alive(pid)).toBe(true)
    const [task] = commands.listOf(cv)
    expect(task?.command).toBe(hold('B'))
    expect(
      events.some(
        (f) =>
          f.conversationId === cv &&
          f.event.type === 'commands.changed' &&
          f.event.commands.some((c) => c.id === task!.id),
      ),
    ).toBe(true)

    await writeFile(join(dir, 'B.go'), '')
    await until(() => bodies.length === 3, '回执发起的一轮')
    const third = bodies[2]!
    expect(third).toContain(`[后台任务回执] 任务 ${task!.id} 已结束：命令执行成功`)
    expect(third).toContain('B finished')
    await idle(cv)
    expect(commands.listOf(cv)).toEqual([])
    expect(listMessages(store, cv).map((m) => m.origin)).toEqual([null, 'command'])
  }, 30_000)
})

describe('在本轮内等待后台命令', () => {
  test('background_command 带 wait_seconds 时等到命令结束才返回，回执在同一轮作为下一条消息送达', async () => {
    const cv = conversation()
    // 任务编号在登记时生成：第一批中的前台命令 W2 使本轮停留到编号可读，再写入后续的脚本。
    script.push(
      callsTurn([
        run('call_w', { command: hold('W'), background: true }),
        run('call_w2', { command: hold('W2') }),
      ]),
    )

    void startRun(cv, '后台构建并等待结果', undefined, deps())
    await pidOf('W2')
    await until(() => commands.listOf(cv).length === 1, '后台命令登记')
    const [task] = commands.listOf(cv)
    script.push(
      callsTurn([
        {
          id: 'call_wait',
          name: 'background_command',
          args: { task_id: task!.id, wait_seconds: 600 },
        },
      ]),
      textTurn('构建已完成。'),
    )
    await writeFile(join(dir, 'W2.go'), '')
    await until(() => bodies.length === 2, '等待调用发出')
    // 确认等待没有提前返回：工具在等待命令期间没有可观察的标志，提前返回时下一次请求会在这段时间内到达。
    await Bun.sleep(150)
    expect(bodies.length).toBe(2)
    expect(runs.isBusy(cv)).toBe(true)

    await writeFile(join(dir, 'W.go'), '')
    await until(() => bodies.length === 3, '等待结束后的请求')
    const third = bodies[2]!
    expect(third).toContain(`后台命令 ${task!.id} 已结束，结果见下一条回执消息`)
    expect(third).toContain(`[后台任务回执] 任务 ${task!.id} 已结束：命令执行成功`)
    expect(third).toContain('W finished')
    await idle(cv)
    expect(commands.listOf(cv)).toEqual([])
    expect(bodies.length).toBe(3)
  }, 30_000)

  /**
   * 原始失败形状：模型的请求发出之后后台任务结束，任务移出任务表；模型随后等待该任务，得到「本会话没有运行中的后台命令」，
   * 这一步显示为失败，回执随后才送达。
   */
  test('等待已结束、已移出任务表的命令：答复已结束，不答复没有该命令', async () => {
    const cv = conversation()
    script.push(
      callsTurn([
        run('call_q', { command: hold('Q'), background: true }),
        run('call_q2', { command: hold('Q2') }),
      ]),
    )
    void startRun(cv, '后台构建后等待', undefined, deps())
    await pidOf('Q2')
    await until(() => commands.listOf(cv).length === 1, '后台命令登记')
    const [task] = commands.listOf(cv)
    await writeFile(join(dir, 'Q.go'), '')
    await until(() => commands.listOf(cv).length === 0, '后台命令结束')
    script.push(
      callsTurn([
        {
          id: 'call_late',
          name: 'background_command',
          args: { task_id: task!.id, wait_seconds: 600 },
        },
      ]),
      textTurn('构建已完成。'),
    )
    await writeFile(join(dir, 'Q2.go'), '')
    await until(() => bodies.length === 3, '等待之后的请求')
    expect(bodies[2]).toContain(`后台命令 ${task!.id} 已结束，结果见回执消息`)
    expect(bodies[2]).not.toContain('没有运行中的后台命令')
    await idle(cv)
  }, 30_000)
})

describe('与后台命令交互', () => {
  /** 原始失败形状：后台命令的标准输入关闭，交互程序启动即读取到输入结束，无法根据输出写入下一行。 */
  test('background 启动的交互程序：写入一行后取得回应，关闭输入后程序结束并送达回执', async () => {
    const cv = conversation()
    script.push(
      callsTurn([
        run('call_a', { command: answer(), background: true }),
        run('call_h', { command: hold('H') }),
      ]),
    )
    void startRun(cv, '与交互程序对话', undefined, deps())
    await pidOf('H')
    await until(() => commands.listOf(cv).length === 1, '后台命令登记')
    const [task] = commands.listOf(cv)
    const nl = String.fromCharCode(10)
    script.push(
      callsTurn([
        {
          id: 'call_in',
          name: 'background_command',
          args: { task_id: task!.id, input: `hello${nl}` },
        },
      ]),
      callsTurn([
        {
          id: 'call_end',
          name: 'background_command',
          args: { task_id: task!.id, input: `bye${nl}`, close_input: true },
        },
      ]),
      textTurn('交互完成。'),
    )
    await writeFile(join(dir, 'H.go'), '')
    await until(() => bodies.length === 4, '关闭输入之后的请求')
    expect(bodies[2]).toContain('答:HELLO')
    expect(bodies[3]).toContain(`后台命令 ${task!.id} 随后结束`)
    expect(bodies[3]).toContain(`[后台任务回执] 任务 ${task!.id} 已结束`)
    expect(bodies[3]).toContain('再见')
    await idle(cv)
    expect(commands.listOf(cv)).toEqual([])
  }, 30_000)
})

describe('停止会话', () => {
  test('前台等待中的命令被结束，已转入后台的命令继续运行；按任务编号停止后进程树结束', async () => {
    const cv = conversation()
    script.push(
      callsTurn([
        run('call_c1', { command: hold('C1'), background: true }),
        run('call_c2', { command: hold('C2') }),
      ]),
    )

    void startRun(cv, '启动服务并运行测试', undefined, deps())
    const background = await pidOf('C1')
    const foreground = await pidOf('C2')
    await until(() => commands.listOf(cv).length === 1, '后台命令登记')

    expect(runs.interruptConversation(cv)).toBe(true)
    await until(() => !alive(foreground), '前台命令进程结束')
    await idle(cv)
    expect(alive(background)).toBe(true)

    const [task] = commands.listOf(cv)
    expect(commands.stop(cv, task!.id)).toBe(hold('C1'))
    await until(() => !alive(background), '后台命令进程结束')
    await until(() => commands.listOf(cv).length === 0, '任务表移除')
    expect(runs.isBusy(cv)).toBe(false)
    expect(runs.queueOf(cv)).toEqual([])
    expect(bodies.length).toBe(1)
  }, 30_000)
})

describe('应用关闭', () => {
  test('服务退出时结束全部后台命令，不发送回执', async () => {
    const first = conversation()
    script.push(
      callsTurn([run('call_d1', { command: hold('D1'), background: true })]),
      textTurn('已启动。'),
    )
    void startRun(first, '启动服务一', undefined, deps())
    await idle(first)
    const second = createConversation(store, {
      workspaceId: workspaceId as never,
      provider: 'fake',
      model: 'deepseek-v4-flash',
    }).id
    script.push(
      callsTurn([run('call_d2', { command: hold('D2'), background: true })]),
      textTurn('已启动。'),
    )
    void startRun(second, '启动服务二', undefined, deps())
    await idle(second)
    const pids = [await pidOf('D1'), await pidOf('D2')]
    expect(pids.every(alive)).toBe(true)
    const requests = bodies.length

    commands.stopAll()
    await until(() => pids.every((pid) => !alive(pid)), '全部后台命令结束')
    await until(
      () => commands.listOf(first).length + commands.listOf(second).length === 0,
      '任务表清空',
    )
    for (const cv of [first, second]) {
      expect(runs.isBusy(cv)).toBe(false)
      expect(runs.queueOf(cv)).toEqual([])
    }
    expect(bodies.length).toBe(requests)
  }, 30_000)
})

describe('权限判定', () => {
  test('background 为真的命令同样经过命令判定，被拒绝的命令不启动', async () => {
    const cv = conversation()
    script.push(
      callsTurn([run('call_e', { command: `sudo ${hold('E')}`, background: true })]),
      textTurn('无法执行。'),
    )
    void startRun(cv, '以管理员身份启动', undefined, deps())
    await until(() => bodies.length === 2, '工具结果送达')
    expect(bodies[1]).toContain('权限规则拒绝执行此命令')
    await idle(cv)
    expect(commands.listOf(cv)).toEqual([])
    expect(existsSync(join(dir, 'E.pid'))).toBe(false)
  }, 30_000)
})

/**
 * 原始失败形状：命令转入后台之后写入的文件，在命令结束后不出现在变更清单中。
 * 文件在本轮结束之后才写入，断言它归属发起命令的那一轮与那条 step，而不是回执发起的一轮。
 */
describe('转入后台之后的文件改动', () => {
  test('命令结束后，后台期间写入的文件进入变更清单，归属发起命令的 step，并发布 file.changed', async () => {
    const cv = conversation()
    script.push(
      callsTurn([run('call_g', { command: late('G', 'exit'), background: true })]),
      textTurn('构建已在后台启动。'),
      textTurn('构建已完成。'),
    )

    void startRun(cv, '后台构建', undefined, deps())
    await until(() => bodies.length === 2, '工具结果送达')
    await idle(cv)
    await pidOf('G', '.tmp')
    const stepId = stepOf('call_g')
    expect(changeOwner(cv, 'late/G.txt')).toBeNull()

    await writeFile(join(dir, '.tmp', 'G.go'), '')
    await until(() => bodies.length === 3, '回执发起的一轮')
    await idle(cv)
    const owner = changeOwner(cv, 'late/G.txt')
    expect(owner?.stepId).toBe(stepId)
    expect(owner?.turn).toBe('后台构建')
    expect(owner?.change).toEqual({
      path: 'late/G.txt',
      changeType: 'created',
      additions: 3,
      deletions: 0,
    })
    expect(owner?.totals.paths).toContain('late/G.txt')
    expect(
      events.some(
        (f) =>
          f.conversationId === cv &&
          f.event.type === 'file.changed' &&
          f.event.changes.some((c) => c.path === 'late/G.txt'),
      ),
    ).toBe(true)
  }, 30_000)

  test('被停止的命令同样记录后台期间的改动，不发送回执', async () => {
    const cv = conversation()
    script.push(
      callsTurn([run('call_h', { command: late('H'), background: true })]),
      textTurn('服务已在后台启动。'),
    )

    void startRun(cv, '启动服务', undefined, deps())
    await until(() => bodies.length === 2, '工具结果送达')
    await idle(cv)
    const pid = await pidOf('H', '.tmp')
    const stepId = stepOf('call_h')
    const [task] = commands.listOf(cv)

    await writeFile(join(dir, '.tmp', 'H.go'), '')
    await until(() => existsSync(join(dir, 'late', 'H.txt')), '命令写入文件')
    expect(commands.stop(cv, task!.id)).toBe(late('H'))
    await until(() => !alive(pid), '命令进程结束')
    await until(() => commands.listOf(cv).length === 0, '任务表移除')

    expect(changeOwner(cv, 'late/H.txt')?.stepId).toBe(stepId)
    expect(runs.isBusy(cv)).toBe(false)
    expect(bodies.length).toBe(2)
  }, 30_000)
})

describe('后台命令的输出上限', () => {
  test('转入后台之后每条流只保留最近的一段，读取与回执写明丢弃的字符数', async () => {
    const cv = conversation()
    script.push(
      callsTurn([run('call_f', { command: flood('F'), background: true })]),
      textTurn('已在后台启动。'),
      textTurn('已结束。'),
    )

    void startRun(cv, '输出大量日志', undefined, deps())
    await until(() => bodies.length === 2, '工具结果送达')
    await idle(cv)
    await pidOf('F', '.tmp')
    const [task] = commands.listOf(cv)
    await until(
      () => commands.output(cv, task!.id)?.stdout.includes('F flooded') === true,
      '输出读取完毕',
    )

    const total = 1200 * 1000 + 'F flooded\n'.length
    const read = commands.output(cv, task!.id)!
    expect(read.dropped.stdout).toBeGreaterThan(0)
    expect(read.stdout.length + read.dropped.stdout).toBe(total)
    expect(read.stdout.endsWith('F flooded\n')).toBe(true)

    await writeFile(join(dir, '.tmp', 'F.go'), '')
    await until(() => bodies.length === 3, '回执发起的一轮')
    const receipt = bodies[2]!
    expect(receipt).toContain(`[后台任务回执] 任务 ${task!.id} 已结束：命令执行成功`)
    expect(receipt).toMatch(/stdout 已丢弃最早的 \d+ 个字符/)
    expect(receipt).toContain('F finished')
    await idle(cv)
  }, 30_000)
})

/**
 * 原始失败形状：生成工具不读取用户消息的信号，执行期间「调整方向」的消息要等生成结束才送达；
 * 只验证包装函数时无法确认本轮结束之后生成仍在进行、结果仍写入工作区并以回执送达。
 * 生成经真实的会话装配与生成端口，图像接口由本地服务模拟，收到请求后保持不应答，由用例决定何时返回图片。
 */
describe('生成工具在执行期间转入后台', () => {
  const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1])
  let release: () => void = () => {}
  let arrived = false
  const images = Bun.serve({
    port: 0,
    async fetch(req) {
      await req.text()
      arrived = true
      await new Promise<void>((resolve) => {
        release = resolve
      })
      return Response.json({ data: [{ b64_json: Buffer.from(JPEG).toString('base64') }] })
    },
  })
  afterAll(() => images.stop(true))

  const mediaDeps = () => ({
    ...deps(),
    config: {
      ...config,
      providers: {
        ...config.providers,
        native: {
          kind: 'openai_chat_completions' as const,
          apiKey: 'test-key',
          baseUrl: `http://127.0.0.1:${images.port}/v1`,
          models: {},
          media: { 'grok-imagine-image-2.0': { kind: 'xai_images' as const } },
        },
      },
      mediaDefaults: { image: { provider: 'native', model: 'grok-imagine-image-2.0' } },
    } satisfies QyConfig,
  })

  test('收到「调整方向」消息时转入后台；本轮结束之后生成照常完成，文件写入工作区并以回执送达', async () => {
    const cv = conversation()
    const output = 'generated/cat.jpg'
    script.push(
      callsTurn([{ id: 'call_img', name: 'generate_image', args: { prompt: '一只猫', output } }]),
      textTurn('已改为查看文档。'),
      textTurn('图片已生成。'),
    )

    void startRun(cv, '生成一张猫的图片', undefined, mediaDeps())
    await until(() => arrived, '图像请求已发出')
    await submitMessage(cv, { id: 'steer_img', content: '先看文档', steer: true }, mediaDeps())
    await until(() => bodies.length === 2, '工具结束后的第二次请求')
    expect(bodies[1]).toContain(
      '执行期间用户发来调整方向的消息，已转入后台继续运行（生成图片 generated/cat.jpg）',
    )
    expect(bodies[1]).toContain('先看文档')
    const [task] = commands.listOf(cv)
    expect(task?.command).toBe(`生成图片 ${output}`)
    await idle(cv)
    expect(existsSync(join(dir, output))).toBe(false)

    release()
    await until(() => bodies.length === 3, '回执发起的一轮')
    expect(bodies[2]).toContain(
      `[后台任务回执] 任务 ${task!.id} 已结束：生成图片 ${output}：已生成 1 张`,
    )
    expect(readFileSync(join(dir, output))).toEqual(Buffer.from(JPEG))
    expect(changeOwner(cv, output)?.stepId).toBe(stepOf('call_img'))
    await idle(cv)
    expect(commands.listOf(cv)).toEqual([])
  }, 30_000)
})
