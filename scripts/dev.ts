#!/usr/bin/env bun

/**
 * 开发编排：两端都从源码跑，并在同一个安全点一起换代。
 *
 * **为什么要有这个脚本。** 桌面外壳跑的是**预编译的 `bin/qy`**（`externalBin`），因此改了
 * `packages/server` 之后不重编就完全看不出来——而且症状会伪装成前端 bug。实测形状：旧二
 * 进制里没有某条 POST 路由，前端抛出来的是一句 `Cannot read properties of undefined (reading 'id')
 * `。
 *
 * 补一个「启动前先重编」只是把窗口缩小到一次启动之内：改一行 server 还是得重启整个应用。
 * 所以这里换掉那条路——**开发时不用那个二进制**：
 *
 * - sidecar：直接跑 `packages/cli/src/index.ts`，源码变了由本脚本换进程（见下）。
 * - 前端：由本脚本直接起 Vite，桌面协调模式关闭 HMR；源码变化也进入下面同一个监督器。
 *   **不挂在 `beforeDevCommand` 上**：那条命令由 Tauri CLI 派生，会继承外壳的整份环境，
 *   而宿主凭据只能到 sidecar 与外壳为止。
 * - 外壳：devUrl 构建只认 `QYWORK_TOKEN` + `QYWORK_PORT` 指向的 sidecar，不探活、
 *   不 spawn `bin/qy`；缺这两个变量直接报错退出（`apps/desktop/src-tauri/src/lib.rs`）。
 *   端口上暂时没人时由页面的连接层重连，与下面换代 sidecar 时的路径相同。
 *
 * **不能让两端各自热更新。** 当前 run 可能为了不中断而继续留在旧 sidecar；如果
 * Vite 此时先把页面 HMR 成新代码，同一个窗口就会变成「新前端 + 旧后端」。所以所有
 * package 与 web 源码变化都先进入同一个空闲闸门：run 结束后重启 sidecar，客户端
 * 看到新的 streamId 再整页刷新。两端因此只在同一个时刻换代。
 *
 * **换代码的判据是「文件变了，且手上没有 run」。** 不要换回 `bun --watch`：它的判据只有文件 mtime，
 * 对「这个进程手上有没有活」一无所知，因此保存一次源码就把正在跑的那一轮从中间掐断。实测形状：
 * 账本里三条 run 因此中断，其中两条停在工具执行期间，整轮不可信（`recoverStaleRuns` 判
 * `internal_guard`）。agent 改 qywork 自己的源码时更糟：它写完第一个文件就把自己重启了，
 * 剩下的还没写。
 *
 * 判据换成两条之后，两个场景都对：跑着的那一轮跑完才换代码，换完下一轮就是新代码。
 * 代价是「保存到生效」多等一轮，而那正是这条规则要换的结果。
 */

import { Database } from 'bun:sqlite'
import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { dataPath } from '@qywork/runtime'
import { externalBinPath } from './external-bin.ts'
import {
  createReloadSupervisor,
  isConsoleInterrupt,
  isSourceChange,
  isWebSourceChange,
} from './reload-supervisor.ts'
import { watchSource } from './source-watch.ts'
import { handoffSourceUpdate } from './update/handoff.ts'
import { startSourceUpdater } from './update/source.ts'

const ROOT = join(import.meta.dir, '..')
const PORT = Number(process.env.QYWORK_PORT ?? 7717)
/** 每次开发会话现生成一个。不写死在仓库里——那就是一个入库的凭证。 */
const TOKEN = process.env.QYWORK_TOKEN ?? randomBytes(24).toString('hex')
const MODE = process.argv.includes('--web') ? 'web' : 'desktop'
const UPDATE_KEY = randomBytes(24).toString('hex')
/**
 * 原生宿主连接的凭据，同样每次现生成。一份管浏览器与电脑控制两条宿主路径。
 *
 * 只交给 sidecar 与外壳两个进程：拿到它就能注册宿主，而 Vite 既不需要它，
 * 也会把整份环境继续传给它自己派生的进程。
 */
const HOST_KEY = randomBytes(24).toString('hex')

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
 * 但端口仍被它持有。按应答判会认为端口是空的，因此直接走到 `Bun.serve` 抛
 * EADDRINUSE，打印一屏栈；`netstat` 里显示的还是那个已经退出的 PID，看着像
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
 * 端口被占就直接说，不静默换一个——换了 WebView 手里那份 base 就是错的。
 *
 * 两种占用分开说，因为下一步不一样：有 qywork 在跑 → 先停掉那一个（两个进程抢
 * 同一份 SQLite 的 WAL 锁）；绑不上又没人应答 → 是更早留下的后台进程仍持有那份
 * 监听句柄（`qy serve` 现在把命令挂在 runner 底下，不会再产生新的），
 * 收掉它即可。
 */
if (!(await bindable(PORT))) {
  process.stderr.write(
    (await answers(PORT))
      ? `端口 ${PORT} 已被另一个 qywork 实例占用。请先停止该实例，或设置 QYWORK_PORT=<其它端口> 后重试。
`
      : `端口 ${PORT} 被一个不响应的进程占用，通常是此前遗留的后台进程仍持有监听句柄，` +
          `netstat 显示的 PID 可能已经不存在。请结束该进程，或设置 QYWORK_PORT=<其它端口> 后重试。
`,
  )
  process.exit(1)
}

const env = {
  ...process.env,
  QYWORK_TOKEN: TOKEN,
  QYWORK_PORT: String(PORT),
  // QYWORK_* 给 vite.config.ts 关 HMR；VITE_* 给页面接收 sidecar 换代信号后整页刷新。
  QYWORK_COORDINATED_RELOAD: '1',
  VITE_QYWORK_COORDINATED_RELOAD: '1',
}

/** 只有这两个进程拿得到宿主凭据。 */
const privilegedEnv = { ...env, QYWORK_HOST_KEY: HOST_KEY, QYWORK_UPDATE_KEY: UPDATE_KEY }

/**
 * 用**正在跑的这个 bun**，不写裸名 `bun`。
 *
 * Windows 上 npm 装的 bun 在 PATH 上是 `.cmd` shim，而 `Bun.spawn` 不走 shell 解析，
 * 传 `'bun'` 直接 ENOENT。这一条是机器级陷阱，不是本仓的事，但踩上去的是本仓。
 */
const BUN = process.execPath

/**
 * 补齐 `externalBin` 声明的 `qy`。
 *
 * 外壳的构建脚本在编译期检查这个文件存在，缺了就以 101 退出，`tauri dev` 也走这一步。
 * 开发态不执行它（sidecar 由本脚本从源码跑），所以只在缺失时编一次。
 *
 * 另一个 `externalBin`（`qy-computer-host`）不在这里编：它由外壳自己的构建脚本
 * （`apps/desktop/src-tauri/build.rs`）在同一次编译里出，任何入口拿到的都与外壳同源。
 */
async function ensureSidecarBin(): Promise<void> {
  if (await Bun.file(await externalBinPath('qy')).exists()) return
  process.stderr.write('[dev] 编译外部二进制 qy\n')
  const build = Bun.spawn([BUN, 'run', join(ROOT, 'scripts/build-sidecar.ts')], {
    cwd: ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
    stdin: 'ignore',
  })
  if ((await build.exited) !== 0) {
    process.stderr.write('[dev] qy 编译失败，详见上方输出\n')
    process.exit(1)
  }
}

if (MODE === 'desktop') await ensureSidecarBin()

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
      // shutdown 没机会跑时，sidecar 必须自行结束。
      '--parent-pid',
      String(process.pid),
      // **不传 --cwd**：传了就等于把这个仓库登记成项目，而开发态不要这个默认
      // （用户拿到的第一个项目会是 qywork 的源码树）。不传则由服务端决定——
      // 账本里有项目就用最近打开的，一个都没有才建默认工作区。
    ],
    { cwd: ROOT, env: privilegedEnv, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
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

/** 收尾中：这时候的退出由本脚本发起，不该被当成崩溃补起来。 */
let stopping = false
/** 初次启动由下方就绪检查收尾，成功后才把退出交给自动重载。 */
let supervising = false
let agent!: ReturnType<typeof Bun.spawn>
let supervisor!: ReturnType<typeof createReloadSupervisor>
let web: ReturnType<typeof Bun.spawn> | undefined
let shell: ReturnType<typeof Bun.spawn> | undefined
let updater: Awaited<ReturnType<typeof startSourceUpdater>> | undefined

/** 先关闭自动恢复入口，再结束子进程；sidecar 只结束自身，保留任务启动的后台服务。 */
function shutdown(code: number): never {
  stopping = true
  updater?.close()
  agent?.kill()
  if (web) killTree(web)
  if (shell) killTree(shell)
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * 起一个 sidecar 并盯着它的退出。
 *
 * **每起一个都要盯**：不盯的话它崩了就没人知道，界面变成一个连不上后端的空壳
 * ——前端只会数「已 N 秒没有新数据」，停止按钮点下去没有对端接，而窗口看起来
 * 一切正常，用户不知道该重启。换代码时的退出由 supervisor 自己发起，它认得出来
 * （它正在 restart），不会重复补起。
 */
function startAgent(): void {
  agent = spawnAgent()
  void agent.exited.then((code) => {
    // 同一控制台的子进程退出通知可能先于父进程的 SIGINT 到达。
    if (!stopping && isConsoleInterrupt(code)) shutdown(0)
    if (!stopping && supervising) supervisor.onExit(code)
  })
}

process.stderr.write(`[dev] 从源码启动 sidecar，端口 ${PORT}\n`)
startAgent()
if (!(await waitReady())) {
  process.stderr.write(
    agent.exitCode !== null
      ? '[dev] sidecar 启动失败，详见上方输出\n'
      : '[dev] sidecar 启动超时（30 秒内未就绪）\n',
  )
  shutdown(1)
}
process.stderr.write(
  `[dev] sidecar 就绪，正在启动${MODE === 'desktop' ? '桌面外壳' : 'Web 界面'}\n`,
)

/**
 * 这个 sidecar 手上还有没有没跑完的 run。
 *
 * **账本是唯一真源**，只读打开，不写任何行——不为这件事新开一条接口或一本账。
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

supervisor = createReloadSupervisor({
  busy: () => busy(agent.pid),
  restart: async () => {
    agent.kill()
    await agent.exited
    startAgent()
    if (!(await waitReady())) throw new Error('启动超时（30 秒内未就绪），详见上方输出')
  },
  debounceMs: 300,
  // 跑一轮动辄几分钟，两秒回看一次够密了。
  idlePollMs: 2_000,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  log: (line) => void process.stderr.write(`[dev] ${line}\n`),
})
supervising = true

watchSource(join(ROOT, 'packages'), isSourceChange, () => supervisor.onChange())

// 前端也必须经过同一条空闲闸门。只盯 packages 会让 Vite 页面先换代，正是
// 「新建 subagent 后状态条消失」的根因；这里只登记变化，不在运行中杀进程。
watchSource(join(ROOT, 'apps/web/src'), isWebSourceChange, () => supervisor.onChange())

/*
 * **不设 `QYWORK_WORKSPACE`。**
 *
 * 它在 `resolve_workspace()`（`lib.rs`）里优先级最高，设了就等于每次启动都把
 * 这个仓库钉成当前项目——用户在应用里切走，下次启动又被切回来，而且仓库自己成了
 * 那个默认项目。「首次运行挂哪儿」现在由服务端一处决定
 * （`server.ts` 的 `bootstrapWorkspace`）：账本里有项目就用最近打开的，
 * 一个都没有才建默认工作区。
 */
/**
 * 按进程树收掉一个子进程。
 *
 * Windows 上 `kill()` 只结束直接子进程，而 vite 真正的开发服务器是它下面那个 node：
 * 只杀外层的话 5180 一直被占着，下一次 `bun run dev` 因为 `strictPort` 直接失败。
 */
function killTree(proc: ReturnType<typeof Bun.spawn>): void {
  if (process.platform === 'win32') {
    Bun.spawnSync(['taskkill', '/PID', String(proc.pid), '/T', '/F'], {
      stdout: 'ignore',
      stderr: 'ignore',
    })
    return
  }
  proc.kill()
}

updater = await startSourceUpdater({
  root: ROOT,
  mode: MODE,
  sidecarPort: PORT,
  hostKey: UPDATE_KEY,
  async apply(target, head) {
    await handoffSourceUpdate(
      { root: ROOT, target, head, mode: MODE, parentPid: process.pid },
      { QYWORK_TOKEN: TOKEN, QYWORK_PORT: String(PORT) },
    )
    setTimeout(() => shutdown(0), 300)
  },
})

web = Bun.spawn([BUN, join(ROOT, 'apps/web/node_modules/vite/bin/vite.js')], {
  cwd: join(ROOT, 'apps/web'),
  env: { ...env, QYWORK_UPDATE_ENDPOINT: JSON.stringify(updater.endpoint) },
  stdout: 'inherit',
  stderr: 'inherit',
  stdin: 'ignore',
})

shell =
  MODE === 'desktop'
    ? Bun.spawn([BUN, join(ROOT, 'apps/desktop/node_modules/@tauri-apps/cli/tauri.js'), 'dev'], {
        cwd: join(ROOT, 'apps/desktop'),
        env: privilegedEnv,
        stdout: 'inherit',
        stderr: 'inherit',
        stdin: 'inherit',
      })
    : undefined

if (MODE === 'web') {
  const url = `http://127.0.0.1:5180/#t=${TOKEN}`
  process.stderr.write(`[dev] ${url}\n`)
  if (!process.argv.includes('--no-open')) {
    const ready = setInterval(async () => {
      try {
        if (!(await fetch('http://127.0.0.1:5180/')).ok) return
        clearInterval(ready)
        Bun.spawn(['powershell.exe', '-NoProfile', '-Command', `Start-Process '${url}'`], {
          stdin: 'ignore',
          stdout: 'ignore',
          stderr: 'ignore',
        })
      } catch {
        /* Vite 尚未就绪。 */
      }
    }, 300)
    ready.unref()
  }
}

const code = await (shell ?? web).exited
shutdown(isConsoleInterrupt(code) ? 0 : code)
