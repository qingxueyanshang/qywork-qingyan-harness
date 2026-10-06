#!/usr/bin/env bun

/**
 * 开发编排：前端与 sidecar 都从源码运行，并在同一个安全点同时换代。
 *
 * **本脚本的用途。** 桌面外壳运行的是**预编译的 `bin/qy`**（`externalBin`），因此修改
 * `packages/server` 之后不重新编译即完全不生效，且症状表现为前端缺陷。实测形状：旧二
 * 进制中没有某条 POST 路由，前端抛出的错误是 `Cannot read properties of undefined (reading 'id')
 * `。
 *
 * 增加「启动前先重新编译」只是把窗口缩小到一次启动之内：修改一行 server 仍需重启整个应用。
 * 因此本脚本替换这条路径，**开发时不使用该二进制**：
 *
 * - sidecar：直接运行 `packages/cli/src/index.ts`，源码变化后由本脚本替换进程（见下）。
 * - 前端：由本脚本直接启动 Vite，桌面协调模式关闭 HMR；源码变化同样进入下文的同一个监督器。
 *   **不配置在 `beforeDevCommand` 中**：该命令由 Tauri CLI 派生，会继承外壳的全部环境变量，
 *   而宿主凭据只能传给 sidecar 与外壳。
 * - 外壳：devUrl 构建只连接 `QYWORK_TOKEN` + `QYWORK_PORT` 指向的 sidecar，不做存活探测、
 *   不 spawn `bin/qy`；缺少这两个变量时直接报错退出（`apps/desktop/src-tauri/src/lib.rs`）。
 *   端口暂时无人监听时由页面的连接层重连，与下文 sidecar 换代时的路径相同。
 *
 * **前端与 sidecar 不得各自热更新。** 当前 run 为避免中断可能继续留在旧 sidecar；此时
 * 若 Vite 先经由 HMR 把页面更新为新代码，同一个窗口会成为「新前端 + 旧后端」。因此所有
 * package 与 web 源码变化都先进入同一个空闲检查：run 结束后重启 sidecar，客户端
 * 收到新的 streamId 后整页刷新。前端与 sidecar 因此只在同一时刻换代。
 *
 * **替换代码的判据是「文件已变化，且没有进行中的 run」。** 不要改为 `bun --watch`：它的判据只有文件 mtime，
 * 不感知进程是否有进行中的任务，因此保存一次源码即会中断正在运行的一轮。实测形状：
 * 账本中三条 run 因此中断，其中两条停在工具执行期间，整轮不可信（`recoverStaleRuns` 判定为
 * `internal_guard`）。agent 修改 qywork 自身源码时问题更严重：写完第一个文件即触发自身重启，
 * 其余文件尚未写入。
 *
 * 采用两条判据后，两个场景均正确：运行中的那一轮执行完毕后才替换代码，替换后的下一轮即为新代码。
 * 代价是从保存到生效多等一轮，这是该规则有意接受的取舍。
 */

import { randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { externalBinPath } from './external-bin.ts'
import {
  createReloadSupervisor,
  isConsoleInterrupt,
  isSourceChange,
  isWebSourceChange,
} from './reload-supervisor.ts'
import { watchSource } from './source-watch.ts'
import { requestUpdateClaim } from './update/claim.ts'
import { handoffSourceUpdate } from './update/handoff.ts'
import { startSourceUpdater } from './update/source.ts'

const ROOT = join(import.meta.dir, '..')
const PORT = Number(process.env.QYWORK_PORT ?? 7717)
/** 每次开发会话重新生成。不写入仓库：写入仓库即成为一个入库的凭证。 */
const TOKEN = process.env.QYWORK_TOKEN ?? randomBytes(24).toString('hex')
const MODE = process.argv.includes('--web') ? 'web' : 'desktop'
const UPDATE_KEY = randomBytes(24).toString('hex')
/**
 * 原生宿主连接的凭据，同样每次重新生成。同一份凭据用于浏览器与电脑控制两条宿主路径。
 *
 * 只交给 sidecar 与外壳两个进程：持有它即可注册宿主，而 Vite 既不需要它，
 * 又会把全部环境变量传给其派生的进程。
 */
const HOST_KEY = randomBytes(24).toString('hex')

/** 判断该端口上是否有**能应答的** qywork。用于等待就绪，不用于判定占用。 */
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
 * 判断端口能否绑定。
 *
 * **判定占用只能依据「能否绑定」，不能依据「是否有进程应答」。** 两者只在一种情况下不同，
 * 而该情况经常出现：上一次运行遗留的子进程**继承了监听句柄**，它不应答任何请求，
 * 但仍持有端口。按应答判定会认为端口空闲，随后在 `Bun.serve` 处抛出
 * EADDRINUSE 并打印整屏调用栈；`netstat` 显示的仍是已退出的 PID，现象为
 * 「端口无人占用却无法启动」。
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
 * 端口被占用时直接报错，不静默更换端口：更换后 WebView 持有的 base 即为错误值。
 *
 * 两种占用分开提示，因为后续处理不同：有 qywork 在运行 → 先停止该实例（两个进程争用
 * 同一份 SQLite 的 WAL 锁）；无法绑定且无应答 → 是更早遗留的后台进程仍持有该
 * 监听句柄（`qy serve` 将命令置于 runner 之下，不会产生新的遗留进程），
 * 结束该进程即可。
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
  // QYWORK_* 供 vite.config.ts 关闭 HMR；VITE_* 供页面在收到 sidecar 换代信号后整页刷新。
  QYWORK_COORDINATED_RELOAD: '1',
  VITE_QYWORK_COORDINATED_RELOAD: '1',
  // Office 执行程序的源码位置；安装版由桌面外壳传入安装资源目录下的 office/。
  QYWORK_OFFICE_DIR: join(ROOT, 'packages', 'runtime', 'office'),
}

/** 只有这两个进程能取得宿主凭据。 */
const privilegedEnv = { ...env, QYWORK_HOST_KEY: HOST_KEY, QYWORK_UPDATE_KEY: UPDATE_KEY }

/**
 * 使用**当前运行的 bun**，不使用裸名 `bun`。
 *
 * Windows 上 npm 安装的 bun 在 PATH 上是 `.cmd` shim，而 `Bun.spawn` 不经过 shell 解析，
 * 传入 `'bun'` 直接报 ENOENT。这是机器级问题，并非本仓库的缺陷，但在本仓库中触发。
 */
const BUN = process.execPath

/**
 * 补齐 `externalBin` 声明的 `qy`。
 *
 * 外壳的构建脚本在编译期检查该文件是否存在，缺失时以 101 退出，`tauri dev` 同样经过这一步。
 * 开发态不执行它（sidecar 由本脚本从源码运行），因此只在缺失时编译一次。
 *
 * 另一个 `externalBin`（`qy-computer-host`）不在这里编译：它由外壳自身的构建脚本
 * （`apps/desktop/src-tauri/build.rs`）在同一次编译中产出，任何入口取得的都与外壳同源。
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
      // 只绑定本机：局域网接入由应用内显式开启，开发脚本不替用户做此决定。
      '--host',
      '127.0.0.1',
      // 本脚本被强制关闭（关闭窗口、任务管理器）时 sidecar 随之退出：
      // shutdown 没有机会执行时，sidecar 必须自行结束。
      '--parent-pid',
      String(process.pid),
      // **不传入 --cwd**：传入即把本仓库登记为项目，而开发态不需要该默认值
      // （否则用户的第一个项目会是 qywork 的源码树）。不传时由服务端决定：
      // 账本中有项目则使用最近打开的项目，没有任何项目时才创建默认工作区。
    ],
    { cwd: ROOT, env: privilegedEnv, stdout: 'inherit', stderr: 'inherit', stdin: 'ignore' },
  )
}

/** 等待 sidecar 能够应答后再继续：否则 WebView 首屏会先短暂显示「未配对」。 */
async function waitReady(): Promise<boolean> {
  const deadline = Date.now() + 30_000
  while (!(await answers(PORT))) {
    if (agent.exitCode !== null || Date.now() > deadline) return false
    await Bun.sleep(200)
  }
  return true
}

/** 正在关闭：此时的退出由本脚本发起，不应视为崩溃而重新启动。 */
let stopping = false
/** 初次启动由下方的就绪检查处理，成功后才把退出交给自动重载处理。 */
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
 * 启动一个 sidecar 并监视其退出。
 *
 * **每次启动都必须监视**：不监视时 sidecar 崩溃无人察觉，界面无法连接后端，
 * 前端只显示「已 N 秒没有新数据」，停止按钮没有响应方，而窗口
 * 看似正常，用户不知道需要重启。换代时的退出由 supervisor 自身发起，它能够识别
 * （它正在 restart），不会重复启动。
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

supervisor = createReloadSupervisor({
  // 由服务端同时检查对话、子任务与画布生成，并阻止占位之后再启动任务。
  busy: async () => !(await requestUpdateClaim(PORT, UPDATE_KEY, 'claim')).claimed,
  restart: async () => {
    agent.kill()
    await agent.exited
    startAgent()
    if (!(await waitReady())) throw new Error('启动超时（30 秒内未就绪），详见上方输出')
  },
  debounceMs: 300,
  // 一轮执行通常需要几分钟，每两秒检查一次已足够频繁。
  idlePollMs: 2_000,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  log: (line) => void process.stderr.write(`[dev] ${line}\n`),
})
supervising = true

watchSource(join(ROOT, 'packages'), isSourceChange, () => supervisor.onChange())

// 前端也必须经过同一个空闲检查。只监视 packages 会使 Vite 页面先换代，这正是
// 「新建 subagent 后状态条消失」的根因；此处只登记变化，不在运行期间终止进程。
watchSource(join(ROOT, 'apps/web/src'), isWebSourceChange, () => supervisor.onChange())

/*
 * **不设置 `QYWORK_WORKSPACE`。**
 *
 * 它在 `resolve_workspace()`（`lib.rs`）中优先级最高，设置后每次启动都会把
 * 本仓库固定为当前项目：用户在应用中切换到其他项目后，下次启动又会切回本仓库，且仓库本身成为
 * 默认项目。首次运行使用哪个项目由服务端一处决定
 * （`server.ts` 的 `bootstrapWorkspace`）：账本中有项目则使用最近打开的项目，
 * 没有任何项目时才创建默认工作区。
 */
/**
 * 按进程树结束一个子进程。
 *
 * Windows 上 `kill()` 只结束直接子进程，而 vite 实际的开发服务器是其下的 node 子进程：
 * 只结束外层进程时 5180 端口持续被占用，下一次 `bun run dev` 因 `strictPort` 直接失败。
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
