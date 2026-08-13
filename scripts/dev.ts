#!/usr/bin/env bun
/**
 * 开发编排：两端都从源码跑，两端都自动重载。
 *
 * ## 为什么要有这个脚本
 *
 * 桌面外壳跑的是**预编译的 `bin/qy`**（`externalBin`），于是改了 `packages/server`
 * 之后不重编就完全看不出来——而且症状会伪装成前端 bug。这轮真实踩到过一次：
 * 旧二进制里没有某条 POST 路由，前端抛出来的是一句
 * `Cannot read properties of undefined (reading 'id')`。
 *
 * 补一个「启动前先重编」只是把窗口缩小到一次启动之内：改一行 server 还是得重启整个应用。
 * 所以这里换掉那条路——**开发时根本不用那个二进制**：
 *
 * - sidecar：`bun --watch` 直接跑 `packages/cli/src/index.ts`。各包的 `exports`
 *   指的就是 `./src/*.ts`（不是 dist），所以 watch 会跟着 import 盯到全部源码。
 * - 前端：vite 自己的 HMR，由 `tauri dev` 的 `beforeDevCommand` 拉起。
 * - 外壳：`sidecar::from_env()` 看见 `QYWORK_TOKEN` + `QYWORK_PORT` 就复用外部
 *   sidecar，不再自己 spawn（`apps/desktop/src-tauri/src/lib.rs`）。
 *
 * 两端都从同一棵源码树跑，「客户端和服务端不是同一批出的」在开发路径上不再可能。
 *
 * ## 端口和令牌必须钉死
 *
 * 令牌与 base 是**建窗口时一次性注入**到 WebView 的。sidecar 每次重启如果换端口
 * 或换令牌，WebView 手里那份立刻失效——换令牌的表现是 `bad_token`，而握手被拒是
 * 终态，客户端不会重连，看起来就是「改了个文件，应用死了」。
 * 所以端口固定、令牌由本脚本生成一次后灌给两边，重启只换进程不换身份，
 * 客户端按已有的退避重连自己接回来。
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const PORT = Number(process.env.QYWORK_PORT ?? 7717)
/** 每次开发会话现生成一个。不写死在仓库里——那就是一个入库的凭证。 */
const TOKEN = process.env.QYWORK_TOKEN ?? randomBytes(24).toString('hex')

/** 端口被占就直接说，不偷偷换一个——换了 WebView 手里那份 base 就是错的。 */
async function portTaken(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    })
    return res.ok || res.status === 401
  } catch {
    return false
  }
}

if (await portTaken(PORT)) {
  process.stderr.write(
    `端口 ${PORT} 上已经有东西在跑。先把它停掉，或用 QYWORK_PORT=<别的端口> 重来。\n`,
  )
  process.exit(1)
}

const env = { ...process.env, QYWORK_TOKEN: TOKEN, QYWORK_PORT: String(PORT) }

/**
 * 用**正在跑的这个 bun**，不写裸名 `bun`。
 *
 * Windows 上 npm 装的 bun 在 PATH 上是 `.cmd` shim，而 `Bun.spawn` 不走 shell 解析，
 * 传 `'bun'` 直接 ENOENT。这一条是机器级陷阱，不是本仓的事，但踩上去的是本仓。
 */
const BUN = process.execPath

process.stderr.write(`[dev] sidecar 从源码跑（bun --watch），:${PORT}\n`)
const agent = Bun.spawn(
  [
    BUN,
    '--watch',
    join(ROOT, 'packages/cli/src/index.ts'),
    'serve',
    '--port',
    String(PORT),
    // 只绑本机：局域网接入由应用内显式开启，开发脚本不替用户做这个决定。
    '--host',
    '127.0.0.1',
    '--cwd',
    ROOT,
  ],
  { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
)

/** 等它真的能应答再拉外壳——否则 WebView 首屏会先闪一个「未配对」。 */
const deadline = Date.now() + 30_000
while (!(await portTaken(PORT))) {
  if (agent.exitCode !== null) {
    process.stderr.write('[dev] sidecar 启动失败，见上面的输出\n')
    process.exit(1)
  }
  if (Date.now() > deadline) {
    process.stderr.write('[dev] sidecar 30 秒内没起来\n')
    agent.kill()
    process.exit(1)
  }
  await Bun.sleep(200)
}
process.stderr.write('[dev] sidecar 就绪，拉起桌面外壳\n')

const shell = Bun.spawn([BUN, 'run', '--cwd', join(ROOT, 'apps/desktop'), 'tauri', 'dev'], {
  cwd: ROOT,
  // QYWORK_WORKSPACE 钉到仓库根：不给的话 tauri dev 的 cwd 是 src-tauri，
  // 会被 resolve_workspace 当成一个项目记进账本。
  env: { ...env, QYWORK_WORKSPACE: ROOT },
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'inherit',
})

/** 谁先退都把另一个收干净——留下的 qy 会占着端口和 SQLite 的 WAL 锁。 */
const stopAll = () => {
  agent.kill()
  shell.kill()
}
process.on('SIGINT', stopAll)
process.on('SIGTERM', stopAll)

const code = await shell.exited
agent.kill()
process.exit(code)
