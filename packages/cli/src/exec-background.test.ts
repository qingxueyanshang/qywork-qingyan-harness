/**
 * `qy exec` 的后台命令：覆盖 `index.ts` 的 `runExec` 装配后台命令端口、本轮结束后执行回执、等待由前台转入后台的命令
 * 与停止仍在运行的命令。
 * 任务表与端口本身由 `server/src/command-tasks/table.test.ts` 覆盖。
 *
 * 失败形状：`qy exec` 没有后台命令端口，`run_command` 不提供 `background`，需要先启动服务再连续执行的任务
 * 只能以 probe_url 或 nohup 自行管理进程。测试启动真实的 CLI 进程与真实命令，模型由假接口按脚本应答。
 */

import { afterAll, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, 'index.ts')
const BUN = process.execPath.replaceAll('\\', '/')

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

const usage = () => ({
  input_tokens: 10,
  output_tokens: 5,
  input_tokens_details: { cached_tokens: 0 },
})

function callTurn(id: string, name: string, args: Record<string, unknown>): string {
  return sse([
    { type: 'response.created', response: { id: 'resp_tool' } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_0', call_id: id, name },
    },
    {
      type: 'response.function_call_arguments.delta',
      output_index: 0,
      item_id: 'fc_0',
      delta: JSON.stringify(args),
    },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } },
    {
      type: 'response.completed',
      response: { id: 'resp_tool', status: 'completed', usage: usage() },
    },
  ])
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

/** 每次请求取出一项；函数按至今收到的请求体生成应答（用于引用上一次工具结果中的任务编号）。 */
let script: (string | ((bodies: string[]) => string))[] = []
let bodies: string[] = []
const provider = Bun.serve({
  port: 0,
  async fetch(req) {
    bodies.push(await req.text())
    const entry = script.shift()
    const next = typeof entry === 'function' ? entry(bodies) : entry
    // 脚本用完时返回 401（不重发，一次即进入终态），多出的请求由 `bodies` 记录。
    if (!next) return new Response('脚本已用完', { status: 401 })
    return new Response(next, { headers: { 'content-type': 'text/event-stream' } })
  },
})

afterAll(async () => {
  await provider.stop(true)
})

/** 把 pid 写入 `<名称>.pid` 后持续运行，直到被停止。 */
const HOLD =
  "await Bun.write(process.argv[2] + '.pid', String(process.pid)); console.log('started'); setInterval(() => {}, 1000)"
/**
 * 等到 `<名称>.pid` 出现后退出。紧随后台命令执行：按脚本应答时本轮在毫秒内结束，停止命令时 shell 可能尚未
 * 创建执行命令的子进程，Windows 上 `taskkill /T` 因此遗漏随后创建的子进程。
 */
const WAIT = "while (!(await Bun.file(process.argv[2] + '.pid').exists())) await Bun.sleep(10)"
/** 输出一行后 300 毫秒退出。 */
const SHORT = "console.log('short done'); setTimeout(() => process.exit(0), 300)"
/** 3 秒后输出一行并退出。 */
const SLOW = "setTimeout(() => { console.log('slow done'); process.exit(0) }, 3000)"

async function exec(prompt: string) {
  const home = await mkdtemp(join(tmpdir(), 'qywork-exec-bg-'))
  const ws = await mkdtemp(join(tmpdir(), 'qywork-exec-bg-ws-'))
  await writeFile(join(ws, 'hold.ts'), HOLD)
  await writeFile(join(ws, 'wait.ts'), WAIT)
  await writeFile(join(ws, 'short.ts'), SHORT)
  await writeFile(join(ws, 'slow.ts'), SLOW)
  const config = {
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
  await writeFile(join(home, 'config.json'), JSON.stringify(config), 'utf8')
  const proc = Bun.spawn([process.execPath, CLI, 'exec', '--cwd', ws, '--json', prompt], {
    env: { ...process.env, QYWORK_HOME: home },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { out, err, code, ws }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Windows 上 `taskkill /F` 返回时进程的终止可能尚未完成，按时限等待其退出。 */
async function exited(pid: number): Promise<boolean> {
  for (let i = 0; i < 200; i += 1) {
    if (!alive(pid)) return true
    await Bun.sleep(25)
  }
  return false
}

test('本轮结束时仍在运行的后台命令被停止并列出，进程不残留', async () => {
  script = [
    callTurn('call_bg', 'run_command', { command: `"${BUN}" hold.ts H`, background: true }),
    callTurn('call_wait', 'run_command', { command: `"${BUN}" wait.ts H` }),
    textTurn('服务已启动。'),
  ]
  bodies = []
  const r = await exec('启动服务')
  expect(r.code).toBe(0)
  expect(r.out).toContain('命令已在后台启动')
  expect(r.err).toContain('已停止仍在运行的后台命令')
  const pidFile = join(r.ws, 'H.pid')
  expect(existsSync(pidFile)).toBe(true)
  expect(await exited(Number(readFileSync(pidFile, 'utf8')))).toBe(true)
  // 被停止的命令没有回执，不再执行一轮。
  expect(bodies).toHaveLength(3)
}, 60_000)

test('本轮中结束的后台命令的回执在本轮结束后作为下一轮的消息执行', async () => {
  script = [
    callTurn('call_bg', 'run_command', { command: `"${BUN}" short.ts`, background: true }),
    // 任务编号在启动之后才知道，取自上一次请求中的工具结果。
    (seen) =>
      callTurn('call_wait', 'background_command', {
        task_id: /cmd_[0-9a-f]{8}/.exec(seen.at(-1) ?? '')?.[0] ?? '',
        wait_seconds: 30,
      }),
    textTurn('等待结果。'),
    textTurn('已收到结果。'),
  ]
  bodies = []
  const r = await exec('启动并等待结果')
  expect(r.code).toBe(0)
  expect(bodies).toHaveLength(4)
  expect(bodies[2]).toContain('已结束，结果见下一条回执消息')
  expect(bodies[3]).toContain('[后台命令回执]')
  expect(bodies[3]).toContain('short done')
  expect(r.err).not.toContain('已停止仍在运行的后台命令')
}, 60_000)

/**
 * 失败形状：前台命令超过等待上限转入后台之后，模型结束本轮，`qy exec` 按「仍在运行的后台命令在退出前停止」终止该命令，
 * 一条会自行结束的构建因此没有结果。
 */
test('由前台转入后台的命令在本轮结束后等到结束，回执作为下一轮的消息执行，不被停止', async () => {
  script = [
    callTurn('call_fg', 'run_command', { command: `"${BUN}" slow.ts`, wait_seconds: 1 }),
    textTurn('命令在后台运行。'),
    textTurn('已收到结果。'),
  ]
  bodies = []
  const r = await exec('执行一条较慢的命令')
  expect(r.code).toBe(0)
  expect(bodies).toHaveLength(3)
  expect(bodies[1]).toContain('命令在 1 秒内没有结束，已转入后台继续运行')
  expect(bodies[2]).toContain('[后台命令回执]')
  expect(bodies[2]).toContain('slow done')
  expect(r.err).not.toContain('已停止仍在运行的后台命令')
}, 60_000)
