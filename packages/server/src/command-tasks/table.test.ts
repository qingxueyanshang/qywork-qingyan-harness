/**
 * 后台命令的端到端回归测试。使用假 provider 与真实进程，不产生费用、不访问网络。
 *
 * 覆盖范围：`command-tasks/table.ts`（任务表、按会话绑定的端口、回执投递、文件改动的追加）、`tools/src/shell.ts` 的
 * `run_command` 转入后台与后台输出的保留上限、`tools/src/workspace-watch.ts` 的后台观察、
 * `store/src/repos.ts` 的 `appendStepFileChanges` 与 `listConversationChangesPage`、
 * `run-control.ts` 的端口装配与回执入口、`commands.ts` 的 `command.stop`、
 * `runtime/session.ts` 的通道注入与权限裁决、`agent/loop` 在工具结束后注入「调整方向」消息。
 * `background_command` 的取舍由 `tools/src/shell.test.ts` 覆盖。
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

let script: string[] = []
let bodies: string[] = []

const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    bodies.push(await req.text())
    const next = script.shift()
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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-bgcmd-'))
  await writeFile(join(dir, 'hold.ts'), HOLD_SCRIPT)
  await writeFile(join(dir, 'late.ts'), LATE_SCRIPT)
  await writeFile(join(dir, 'flood.ts'), FLOOD_SCRIPT)
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
  provider.stop(true)
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
  throw new Error(`等不到：${label}`)
}

/** 等待该会话空闲，且收尾阶段经 setTimeout(0) 安排的下一轮已有机会启动。 */
async function idle(cv: ConversationId): Promise<void> {
  await until(() => !runs.isBusy(cv), '会话空闲')
  await Bun.sleep(80)
  await until(() => !runs.isBusy(cv), '会话空闲')
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
 * 编号（2、3…），按它查询宿主进程表查不到该命令，或查到无关的进程。因此在宿主的 /proc 中按命令行
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
  throw new Error(`宿主进程表中找不到命令 ${name}`)
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
const flood = (name: string) => `"${process.execPath.replaceAll('\\', '/')}" flood.ts ${name}`

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
    expect(second).toContain('等待期间用户发来消息，命令转入后台继续运行')
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
    expect(third).toContain(`[后台命令回执] 任务 ${task!.id} 已结束：命令执行成功`)
    expect(third).toContain('B finished')
    await idle(cv)
    expect(commands.listOf(cv)).toEqual([])
    expect(listMessages(store, cv).map((m) => m.origin)).toEqual([null, 'command'])
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
    expect(receipt).toContain(`[后台命令回执] 任务 ${task!.id} 已结束：命令执行成功`)
    expect(receipt).toMatch(/stdout 已丢弃最早的 \d+ 个字符/)
    expect(receipt).toContain('F finished')
    await idle(cv)
  }, 30_000)
})
