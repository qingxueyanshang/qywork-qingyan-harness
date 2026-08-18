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
 * - sidecar：直接跑 `packages/cli/src/index.ts`，源码变了由本脚本换进程（见下）。
 * - 前端：vite 自己的 HMR，由 `tauri dev` 的 `beforeDevCommand` 拉起。
 * - 外壳：`sidecar::from_env()` 看见 `QYWORK_TOKEN` + `QYWORK_PORT` 就复用外部
 *   sidecar，不再自己 spawn（`apps/desktop/src-tauri/src/lib.rs`）。
 *
 * 两端都从同一棵源码树跑，「客户端和服务端不是同一批出的」在开发路径上不再可能。
 *
 * ## 换代码的判据是「文件变了 **且** 手上没有 run」
 *
 * **不要换回 `bun --watch`。** 它的判据只有文件 mtime，对「这个进程手上有没有活」
 * 一无所知，于是保存一次源码就把正在跑的那一轮从中间掐断——账本里三条 run 是这么
 * 没的，其中两条停在工具执行期间，结果整轮不可信（`recoverStaleRuns` 判 `internal_guard`）。
 * agent 改 qywork 自己的源码时更糟：它写完第一个文件就把自己重启了，剩下的还没写。
 *
 * 判据换成两条之后，两个场景都对：跑着的那一轮跑完才换代码，换完下一轮就是新代码。
 * 代价是「保存到生效」多等一轮，而那正是这条规则要买的东西。
 */

import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { watch } from 'node:fs'
import { join } from 'node:path'
import { dataPath } from '@qywork/runtime'
import { createReloadSupervisor, isSourceChange } from './reload-supervisor.ts'

const ROOT = join(import.meta.dir, '..')
const PORT = Number(process.env.QYWORK_PORT ?? 7717)
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
 * 端口被占就直接说，不偷偷换一个——换了 WebView 手里那份 base 就是错的。
 *
 * 两种占用分开说，因为下一步不一样：有 qywork 在跑 → 先停掉那一个（两个进程抢
 * 同一份 SQLite 的 WAL 锁）；绑不上又没人应答 → 是**改动之前**留下的后台进程还
 * 攥着那份监听句柄（现在的 `qy serve` 把命令挂在 runner 底下，不会再有新的），
 * 收掉它即可。
 */
if (!(await bindable(PORT))) {
  process.stderr.write(
    (await answers(PORT))
      ? `端口 ${PORT} 上已经有一个 qywork 在跑。先把它停掉，或用 QYWORK_PORT=<别的端口> 重来。
`
      : `端口 ${PORT} 被一个不应答的进程占着——多半是这次改动之前留下的后台进程还攥着监听句柄，` +
          `netstat 里那个 PID 可能已经不在了。把它收掉，或用 QYWORK_PORT=<别的端口> 重来。
`,
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

function spawnAgent(): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    [
      BUN,
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
}

/** 等它真的能应答再往下走——否则 WebView 首屏会先闪一个「未配对」。 */
async function waitReady(): Promise<boolean> {
  const deadline = Date.now() + 30_000
  while (!(await answers(PORT))) {
    if (agent.exitCode !== null || Date.now() > deadline) return false
    await Bun.sleep(200)
  }
  return true
}

/** 收尾中：这时候的退出是我们自己杀的，不该被当成崩溃补起来。 */
let stopping = false
let agent!: ReturnType<typeof Bun.spawn>

/**
 * 起一个 sidecar 并盯着它的退出。
 *
 * **每起一个都要盯**：不盯的话它崩了就没人知道，界面变成一个连不上后端的空壳
 * ——前端只会数「已 N 秒没有新数据」，停止按钮点下去没有对端接，而窗口看起来
 * 一切正常，用户不知道该重启。换代码时是我们自己杀的，supervisor 认得出来
 * （它正在 restart），不会重复补起。
 */
function startAgent(): void {
  agent = spawnAgent()
  void agent.exited.then((code) => {
    if (!stopping) supervisor.onExit(code)
  })
}

process.stderr.write(`[dev] sidecar 从源码跑，:${PORT}\n`)
startAgent()
if (!(await waitReady())) {
  process.stderr.write(
    agent.exitCode !== null
      ? '[dev] sidecar 启动失败，见上面的输出\n'
      : '[dev] sidecar 30 秒内没起来\n',
  )
  agent.kill()
  process.exit(1)
}
process.stderr.write('[dev] sidecar 就绪，拉起桌面外壳\n')

/**
 * 这个 sidecar 手上还有没有没跑完的 run。
 *
 * **账本是唯一真源**，只读打开，不写任何东西——不为这件事新开一条接口或一本账。
 * `owner_pid` 就是 sidecar 自己的 pid（`recoverStaleRuns` 的 `isOrphan` 拿它跟
 * `process.pid` 比），所以这里问的确实是「**这个**进程手上有没有活」，
 * 而不是「机器上有没有人在跑」——那台机器上可能还有别的 qywork。
 *
 * 读不到（账本还没建、正在迁移、被独占）当作没有：那退化成改动之前的行为，不会更差。
 */
function busy(pid: number): boolean {
  try {
    const db = new Database(dataPath(), { readonly: true })
    try {
      const row = db
        .query("SELECT 1 FROM runs WHERE status IN ('running','queued') AND owner_pid = ? LIMIT 1")
        .get(pid)
      return row !== null
    } finally {
      db.close()
    }
  } catch {
    return false
  }
}

const supervisor = createReloadSupervisor({
  busy: () => busy(agent.pid),
  restart: async () => {
    agent.kill()
    await agent.exited
    startAgent()
    if (!(await waitReady())) throw new Error('30 秒内没起来，见上面的输出')
  },
  debounceMs: 300,
  // 跑一轮动辄几分钟，两秒回看一次够密了。
  idlePollMs: 2_000,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  log: (line) => void process.stderr.write(`[dev] ${line}\n`),
})

watch(join(ROOT, 'packages'), { recursive: true }, (_event, file) => {
  if (isSourceChange(file)) supervisor.onChange()
})

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
 * **不杀更深的那一层。** sidecar 底下挂着模型用 `run_command` 起的后台进程
 * （`run.ps1 start` 那类服务），那是用户要的东西，不该因为开发环境退出而被收掉。
 * 它们也不会再把端口攥走——命令现在挂在 runner 底下，那个进程出生在绑端口之前，
 * 手里根本没有监听句柄（`tools/runner.ts`）。
 */
const stopAll = () => {
  stopping = true
  agent.kill()
  shell.kill()
}
process.on('SIGINT', stopAll)
process.on('SIGTERM', stopAll)

const code = await shell.exited
stopping = true
agent.kill()
process.exit(code)
