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
/** 想要的那个端口；真正用哪个由 `pickPort` 定。 */
const WANT_PORT = Number(process.env.QYWORK_PORT ?? 7717)
/** 每次开发会话现生成一个。不写死在仓库里——那就是一个入库的凭证。 */
const TOKEN = process.env.QYWORK_TOKEN ?? randomBytes(24).toString('hex')

/** 那个端口上有没有一个**能应答的** qywork。用来等就绪，不用来判占用。 */
async function answers(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(800),
    })
    return res.ok || res.status === 401
  } catch {
    return false
  }
}

/**
 * 端口绑不绑得上。
 *
 * **判占用只能按「绑得上吗」，不能按「有没有人应答」。** 两者只在一种情况下不同，
 * 而那种情况天天发生：上一次跑留下的子进程**继承了监听句柄**——它不应答任何请求，
 * 但端口攥在它手里。按应答判会认为端口是空的，于是一路走到 `Bun.serve` 抛
 * EADDRINUSE，糊一屏栈；`netstat` 里显示的还是那个已经退出的 PID，看着像
 * 「没人占着却起不来」。
 */
async function bindable(port: number): Promise<boolean> {
  try {
    Bun.listen({ hostname: '127.0.0.1', port, socket: { data() {} } }).stop(true)
    return true
  } catch {
    return false
  }
}

/**
 * 这次用哪个端口。**只在启动时挑一次**，挑定之后灌给两边；会话中途绝不换
 * （换了 WebView 手里那份 base 就是错的）。
 *
 * 两种占用要分开处理，它们的正确做法相反：
 *
 * - **有一个能应答的 qywork 在跑** → 停下。再起一个不是端口问题，是两个进程抢
 *   同一份 SQLite 的 WAL 锁。
 * - **绑不上但没人应答** → 往上挪一个。这种占用来自「上一次跑留下的后台进程
 *   继承了监听句柄」：那些进程是模型用 `run_command` 起的服务，本来就该活着，
 *   不该为了让开一个端口去杀它们。
 */
async function pickPort(want: number): Promise<number> {
  if (await bindable(want)) return want
  if (await answers(want)) {
    process.stderr.write(
      `端口 ${want} 上已经有一个 qywork 在跑。先把它停掉，或用 QYWORK_PORT=<别的端口> 重来。\n`,
    )
    process.exit(1)
  }
  for (let p = want + 1; p <= want + 20; p++) {
    if (await bindable(p)) {
      process.stderr.write(
        `[dev] ${want} 被一个不应答的进程占着（上次留下的后台进程继承了监听句柄，` +
          `netstat 里那个 PID 可能已经不在了），这次改用 ${p}\n`,
      )
      return p
    }
  }
  process.stderr.write(`${want} 往上 20 个端口都绑不上。用 QYWORK_PORT=<别的端口> 重来。\n`)
  process.exit(1)
}

const PORT = await pickPort(WANT_PORT)

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
    // 这个脚本被硬关（关窗口、任务管理器）时它自己也退。少了这条，
    // 下面那个 stopAll 根本没机会跑，sidecar 会带着一串后台进程活下来。
    '--parent-pid',
    String(process.pid),
    // **不传 --cwd**：传了就等于把这个仓库登记成项目，而开发时那正是我们不想要的
    // 默认（用户拿到的第一个项目会是 qywork 的源码树）。不传则由服务端决定——
    // 账本里有项目就用最近打开的，一个都没有才建默认工作区。
  ],
  { cwd: ROOT, env, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
)

/** 等它真的能应答再拉外壳——否则 WebView 首屏会先闪一个「未配对」。 */
const deadline = Date.now() + 30_000
while (!(await answers(PORT))) {
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

/*
 * **不设 `QYWORK_WORKSPACE`。**
 *
 * 它在 `resolve_workspace()`（`lib.rs`）里优先级最高，设了就等于每次启动都把
 * 这个仓库钉成当前项目——用户在应用里切走，下次又被拽回来，而且仓库自己成了
 * 那个默认项目。「首次运行挂哪儿」现在由服务端一处决定
 * （`server.ts` 的 `bootstrapWorkspace`）：账本里有项目就用最近打开的，
 * 一个都没有才建默认工作区。
 */
const shell = Bun.spawn([BUN, 'run', '--cwd', join(ROOT, 'apps/desktop'), 'tauri', 'dev'], {
  cwd: ROOT,
  env,
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'inherit',
})

/**
 * 谁先退都把另一个收干净——留下的 qy 会占着端口和 SQLite 的 WAL 锁。
 *
 * 杀的是 `bun --watch` 那个壳，内层的 sidecar 跟着一起走（实测：壳被杀之后内层
 * 进程也没了）。
 *
 * **不杀更深的那一层。** sidecar 底下挂着模型用 `run_command` 起的后台进程
 * （`run.ps1 start` 那类服务），那是用户要的东西，不该因为开发环境退出而被收掉。
 * 代价是它们继承的监听句柄会把端口攥住——那件事由 `pickPort` 让开，不靠杀进程解决。
 */
const stopAll = () => {
  agent.kill()
  shell.kill()
}
process.on('SIGINT', stopAll)
process.on('SIGTERM', stopAll)

const code = await shell.exited
agent.kill()
process.exit(code)
