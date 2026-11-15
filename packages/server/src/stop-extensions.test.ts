/**
 * 覆盖 `server.ts` 的 `stop()` 在扩展仍在加载时的行为，经由 `runtime/extensions.ts` 的 `acquireExtensions`
 * 中止参数与 `mcp/load.ts` 的中止处理。
 *
 * 原始失败形状：MCP 服务在初始化握手阶段不回复时，`stop()` 等待扩展加载，直到初始化超时（30 秒）才结束；
 * 桌面外壳在 5 秒时终止 sidecar，该服务进程残留。
 */

import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '@qywork/store'
import { serve } from './server.ts'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = performance.now() + 15_000
  while (!(await predicate())) {
    if (performance.now() > deadline) throw new Error(message)
    await Bun.sleep(20)
  }
}

test('MCP 服务在握手阶段不回复时，stop 立即中止握手并终止该服务进程', async () => {
  const root = await mkdtemp(join(tmpdir(), 'stop-extensions-'))
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  await mkdir(home)
  await mkdir(workspace)
  // 启动后写入自身 pid，之后不读取标准输入，`initialize` 永远得不到回复。
  const server = join(root, 'hang.ts')
  const pidFile = join(root, 'hang.pid')
  await writeFile(
    server,
    'await Bun.write(process.argv[2], String(process.pid))\nsetInterval(() => {}, 1000)\n',
  )
  // Windows 上 MCP 服务经 shell 启动，参数以空格拼接，路径中不能有空白。
  for (const p of [process.execPath, server, pidFile]) {
    if (/\s/.test(p)) throw new Error(`路径含空白：${p}`)
  }
  await writeFile(
    join(home, 'mcp.json'),
    JSON.stringify({ servers: { hang: { command: process.execPath, args: [server, pidFile] } } }),
  )
  const previousHome = process.env.QYWORK_HOME
  process.env.QYWORK_HOME = home
  const store = new Store({ path: join(root, 'data.sqlite3') })
  let pid = 0
  try {
    const handle = serve({
      store,
      config: { providers: {}, mode: 'auto' },
      workspaceRoot: workspace,
      port: 0,
      host: '127.0.0.1',
    })
    await until(async () => {
      pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
      return pid > 0
    }, 'MCP 服务未启动')
    expect(alive(pid)).toBe(true)

    const started = performance.now()
    await handle.stop()
    const elapsed = performance.now() - started
    // 远小于初始化超时（30 秒），且在外壳的停止时限（5 秒）之内。
    expect(elapsed).toBeLessThan(5_000)
    await until(() => !alive(pid), 'MCP 服务进程在停止之后仍在运行')
  } finally {
    if (pid > 0 && alive(pid)) process.kill(pid)
    store.close()
    if (previousHome === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = previousHome
  }
}, 60_000)
