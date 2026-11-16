/**
 * 覆盖 `index.ts` 的 `qy serve` 停止：外壳经标准输入写入 `stop` 时执行 `handle.stop()` 并以 0 退出；
 * 标准输入结束与无法识别的指令不停止服务。端到端核对两种结束方式：正常停止，与 sidecar 被直接终止
 * （此时由 `tools/runner.ts` 的 `leave` 终止命令）。两种方式下运行中的命令进程树都结束，
 * 已退出的命令留下的后代进程仍在运行。
 *
 * 原始失败形状：外壳退出时直接终止 sidecar，`handle.stop()` 不执行；Windows 上 runner 随 sidecar 一同结束，
 * 运行中命令的 shell 被终止而它启动的程序继续运行。
 */

import { afterAll, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const CLI = join(import.meta.dir, 'index.ts')

/** 测试结束时仍需清理的进程（已退出的命令有意留下的后代进程）监听的端口。 */
const leftovers: number[] = []
afterAll(async () => {
  await Promise.all(leftovers.map((port) => fetch(`http://127.0.0.1:${port}/exit`).catch(() => {})))
})

async function until(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  ms = 20_000,
): Promise<void> {
  const deadline = performance.now() + ms
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error(message)
    await Bun.sleep(20)
  }
}

/**
 * 命令启动的进程是否仍在运行，按它监听的回环端口判定。不按 pid 判定：Linux 的内核沙箱在独立的
 * pid 命名空间中执行命令，进程在其中取得的 pid 在宿主上指向另一个进程。
 */
async function alive(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) })
    return true
  } catch {
    return false
  }
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  } else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
}

/** 以外壳相同的方式启动：`--credentials-stdin`，写入一行凭据后保持管道打开。 */
async function startServe(home: string, workspace: string) {
  const token = `token-${crypto.randomUUID()}`
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI,
      'serve',
      '--port',
      '0',
      '--host',
      '127.0.0.1',
      '--print-token',
      '--parent-pid',
      String(process.pid),
      '--credentials-stdin',
      '--cwd',
      workspace,
    ],
    {
      env: { ...process.env, QYWORK_HOME: home },
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      // 与外壳相同：sidecar 有控制台而没有控制台窗口。
      windowsHide: true,
    },
  )
  proc.stdin.write(`${JSON.stringify({ token })}\n`)
  proc.stdin.flush()
  let output = ''
  void (async () => {
    for await (const chunk of proc.stdout) output += new TextDecoder().decode(chunk)
  })()
  void new Response(proc.stderr).text()
  await until(() => /QYWORK_PORT=\d+/.test(output), '未输出就绪回执')
  const port = Number(/QYWORK_PORT=(\d+)/.exec(output)?.[1])
  const send = (line: string) => {
    proc.stdin.write(`${line}\n`)
    proc.stdin.flush()
  }
  return { proc, port, token, send, base: `http://127.0.0.1:${port}` }
}

async function fixtureDirs(name: string) {
  const dir = await mkdtemp(join(tmpdir(), `qy-serve-stop-${name}-`))
  const home = join(dir, 'home')
  const workspace = join(dir, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  return { dir, home, workspace }
}

/** 进程在 `ms` 内退出时返回退出码，否则返回 null。 */
function exitWithin(proc: { exited: Promise<number> }, ms: number): Promise<number | null> {
  return Promise.race([proc.exited, Bun.sleep(ms).then(() => null)])
}

test('标准输入写入 stop 时执行停止流程并以 0 退出，无法识别的指令被忽略', async () => {
  const { home, workspace } = await fixtureDirs('line')
  await writeFile(join(home, 'config.json'), '{}')
  const serve = await startServe(home, workspace)
  try {
    serve.send('noise')
    serve.send('stop')
    expect(await exitWithin(serve.proc, 10_000)).toBe(0)
    const log = await readFile(join(home, 'logs', 'qy.log'), 'utf8')
    expect(log).toContain('忽略无法识别的标准输入指令')
    expect(log).toContain('收到停止请求，停止服务 source=stdin')
    // `handle.stop()` 的第一行日志。
    expect(log).toContain('[server] 停止服务')
  } finally {
    killTree(serve.proc.pid)
    await serve.proc.exited
  }
}, 30_000)

/** 开发脚本交付凭据后即关闭标准输入，服务必须继续运行。 */
test('标准输入结束不停止服务', async () => {
  const { home, workspace } = await fixtureDirs('eof')
  await writeFile(join(home, 'config.json'), '{}')
  const serve = await startServe(home, workspace)
  try {
    await serve.proc.stdin.end()
    // 读到标准输入结束时服务不产生任何可观察的事件，只能观察一段时长内未退出。
    expect(await exitWithin(serve.proc, 1_000)).toBeNull()
    const health = await fetch(`${serve.base}/api/health`, { signal: AbortSignal.timeout(2000) })
    expect(health.status).toBe(200)
  } finally {
    killTree(serve.proc.pid)
    await serve.proc.exited
  }
}, 30_000)

// ───────────────────────── 端到端：运行中的命令与已退出命令留下的进程 ─────────────────────────

/**
 * 命令执行的程序。`launch` 以 detached 启动一个常驻进程后立即退出（已退出的命令留下的后代进程）；
 * `hold` 一直运行到被终止（运行中的命令）。常驻进程与 `hold` 各监听一个回环端口并把端口写入给定的文件，
 * 请求 `/exit` 时退出。文件位于工作区中：有内核沙箱的平台上，测试目录中工作区之外的位置对命令只读。
 */
const FIXTURE = `
const [mode, file] = process.argv.slice(2)
if (mode === 'launch') {
  const service = Bun.spawn([process.execPath, import.meta.path, 'service', file], {
    stdio: ['ignore', 'ignore', 'ignore'],
    detached: true,
  })
  service.unref()
  process.exit(0)
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req) {
    if (new URL(req.url).pathname === '/exit') setTimeout(() => process.exit(0), 10)
    return new Response('ok')
  },
})
await Bun.write(file, String(server.port))
`

function sse(events: { type: string; [k: string]: unknown }[]): string {
  return `${events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n`).join('\n')}\n`
}

function commandTurn(callId: string, command: string): string {
  return sse([
    { type: 'response.created', response: { id: `resp_${callId}` } },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: `fc_${callId}`, call_id: callId, name: 'run_command' },
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: `fc_${callId}`,
      delta: JSON.stringify({ command }),
    },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call' } },
    {
      type: 'response.completed',
      response: {
        id: `resp_${callId}`,
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
      },
    },
  ])
}

function textTurn(text: string): string {
  return sse([
    { type: 'response.created', response: { id: 'resp_text' } },
    { type: 'response.output_text.delta', delta: text },
    {
      type: 'response.completed',
      response: {
        id: 'resp_text',
        status: 'completed',
        usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } },
      },
    },
  ])
}

/**
 * 启动服务并经一轮对话执行两条命令：先执行 `launch`（退出后留下常驻进程），再执行 `hold`（保持运行）。
 * 两条命令都由 `run_command` 经 runner 启动。返回服务与两个进程监听的端口。
 */
async function serveWithCommands(name: string) {
  const { dir, home, workspace } = await fixtureDirs(name)
  const fixture = join(dir, 'fixture.ts')
  await writeFile(fixture, FIXTURE)
  const servicePort = join(workspace, 'service.port')
  const holdPort = join(workspace, 'hold.port')
  // 命令行同时适用于 bash 与 PowerShell：正斜杠路径，不含空白时无需引号。
  const slash = (p: string) => p.replaceAll('\\', '/')
  for (const p of [process.execPath, fixture, dir]) {
    if (/\s/.test(p)) throw new Error(`路径含空白，命令行无法同时适用于两种 shell：${p}`)
  }
  const command = (mode: string, file: string) =>
    `${slash(process.execPath)} ${slash(fixture)} ${mode} ${slash(file)}`

  const provider = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = await req.text()
      const turn = body.includes('call_hold')
        ? textTurn('完成')
        : body.includes('call_launch')
          ? commandTurn('call_hold', command('hold', holdPort))
          : commandTurn('call_launch', command('launch', servicePort))
      return new Response(turn, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      active: { provider: 'fake', model: 'deepseek-v4-flash' },
      providers: {
        fake: {
          kind: 'openai_responses',
          apiKey: 'sk-fake',
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          models: { 'deepseek-v4-flash': {} },
        },
      },
      mode: 'full',
    }),
  )

  const serve = await startServe(home, workspace)
  const auth = { authorization: `Bearer ${serve.token}` }
  const created = (await (
    await fetch(`${serve.base}/api/conversations`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ title: '停止' }),
    })
  ).json()) as { conversation: { id: string } }
  const conversationId = created.conversation.id

  const ws = new WebSocket(`ws://127.0.0.1:${serve.port}/stream?origin=desktop`)
  const hello = Promise.withResolvers<void>()
  ws.addEventListener('message', (e) => {
    if (JSON.parse(String(e.data)).type === 'hello.ok') hello.resolve()
  })
  await new Promise<void>((resolve) => ws.addEventListener('open', () => resolve(), { once: true }))
  ws.send(
    JSON.stringify({
      type: 'hello',
      token: serve.token,
      origin: 'desktop',
      subscribe: [conversationId],
    }),
  )
  await hello.promise
  ws.send(
    JSON.stringify({
      type: 'message.send',
      clientRequestId: crypto.randomUUID(),
      conversationId,
      content: '启动服务并运行检查',
    }),
  )

  const readPort = async (file: string) => Number(await readFile(file, 'utf8').catch(() => 'NaN'))
  let service = Number.NaN
  let hold = Number.NaN
  const deadline = performance.now() + 30_000
  while (!(service > 0 && hold > 0)) {
    if (performance.now() > deadline) throw new Error('命令未启动')
    service = await readPort(servicePort)
    hold = await readPort(holdPort)
    await Bun.sleep(50)
  }
  leftovers.push(service, hold)
  expect(await alive(service)).toBe(true)
  expect(await alive(hold)).toBe(true)
  const close = async () => {
    ws.close()
    await provider.stop(true)
  }
  return { serve, service, hold, close }
}

test('停止之后运行中的命令进程树已结束，已退出的命令留下的进程仍在运行', async () => {
  const run = await serveWithCommands('e2e')
  try {
    run.serve.send('stop')
    expect(await exitWithin(run.serve.proc, 15_000)).toBe(0)
    // 进程树在停止流程开始时同步终止，服务退出时运行中的命令已不存在。
    await until(async () => !(await alive(run.hold)), '运行中的命令在服务停止后仍在运行', 5_000)
    expect(await alive(run.service)).toBe(true)
  } finally {
    await run.close()
    killTree(run.serve.proc.pid)
    await run.serve.proc.exited
  }
}, 90_000)

/**
 * sidecar 崩溃，或外壳请求停止后超时将其终止时，`handle.stop()` 不执行：runner 不随 sidecar 结束，
 * 发现父进程退出后终止尚未退出的命令进程树（`runner.ts` 的 `leave`）。
 */
test('sidecar 被直接终止后，运行中的命令进程树在时限内结束，已退出的命令留下的进程仍在运行', async () => {
  const run = await serveWithCommands('crash')
  try {
    // 只终止 sidecar 进程本身，不带进程树。
    run.serve.proc.kill('SIGKILL')
    await run.serve.proc.exited
    // runner 经 IPC 断开或每 3 秒一次的父进程轮询发现 sidecar 已退出。
    await until(
      async () => !(await alive(run.hold)),
      '运行中的命令在 sidecar 被终止后仍在运行',
      10_000,
    )
    expect(await alive(run.service)).toBe(true)
  } finally {
    await run.close()
  }
}, 90_000)
