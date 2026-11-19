/**
 * `qy exec` 的后台命令：覆盖 `index.ts` 的 `runExec` 装配后台命令端口、本轮结束后执行回执与停止仍在运行的命令。
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
/** 输出一行后 300 毫秒退出。 */
const SHORT = "console.log('short done'); setTimeout(() => process.exit(0), 300)"

async function exec(prompt: string) {
  const home = await mkdtemp(join(tmpdir(), 'qywork-exec-bg-'))
  const ws = await mkdtemp(join(tmpdir(), 'qywork-exec-bg-ws-'))
  await writeFile(join(ws, 'hold.ts'), HOLD)
  await writeFile(join(ws, 'short.ts'), SHORT)
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

test('本轮结束时仍在运行的后台命令被停止并列出，进程不残留', async () => {
  script = [
    callTurn('call_bg', 'run_command', { command: `"${BUN}" hold.ts H`, background: true }),
    textTurn('服务已启动。'),
  ]
  bodies = []
  const r = await exec('启动服务')
  expect(r.code).toBe(0)
  expect(r.out).toContain('命令已在后台启动')
  expect(r.err).toContain('已停止仍在运行的后台命令')
  const pidFile = join(r.ws, 'H.pid')
  expect(existsSync(pidFile)).toBe(true)
  expect(alive(Number(readFileSync(pidFile, 'utf8')))).toBe(false)
  // 被停止的命令没有回执，不再执行一轮。
  expect(bodies).toHaveLength(2)
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
