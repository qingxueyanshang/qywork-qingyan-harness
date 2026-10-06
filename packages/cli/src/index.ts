#!/usr/bin/env bun
/**
 * qy：qywork 内核 CLI，即发布产物本身。
 *
 * 桌面端不是内置 agent 的独立应用，而是该 CLI 的一个前端：Tauri 只负责
 * spawn `qy serve` 并显示 WebView，Rust 侧不保存任何业务状态。手机端连接的
 * 也是同一个 `qy serve`。因此只有一本账。
 *
 *   qy exec "<任务>"    单次执行，输出供人阅读的格式；--json 输出 JSONL 供 CI 使用
 *   qy serve           本地 HTTP + WebSocket（桌面端与手机端均连接此服务）
 *   qy config          打印当前配置与配置文件路径
 *
 * 无参数时进入交互模式（非 TTY 下打印用法）。`qy team run` 尚未实现，编排目前从图形界面发起。
 */

import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { AgentEvent } from '@qywork/core'
import { formatMoney, log, setLogSink } from '@qywork/core'
import {
  collectResourceGarbage,
  configDir,
  configNotices,
  configPath,
  createOfficeHost,
  dataPath,
  diagnoseConfig,
  diagnoseRunnable,
  fileLogSink,
  importLegacySchedules,
  loadConfig,
  MCP_CONFIG,
  Session,
} from '@qywork/runtime'
import { lanCandidates, processExitObservationFromEnv, serve } from '@qywork/server'
import { ContentStore, contentPathFor, Store } from '@qywork/store'
import {
  detectSandbox,
  runCommandRunner,
  setCommandRunner,
  startCommandRunner,
} from '@qywork/tools'
import { runDoctor } from './doctor.ts'
import { runExport } from './export.ts'
import { runInit } from './init.ts'
import { runMcp } from './mcp.ts'
import { runPlugins } from './plugins.ts'
import { runProbe } from './probe.ts'
import { renderQr } from './qr.ts'
import { runTui } from './tui.ts'
import { runUsage } from './usage.ts'

const USAGE = `qy —— qywork 编码 agent

  qy                      交互模式（多轮，同一会话）

  qy init                 生成配置（首次使用时先执行此命令）
    --force               覆盖已有配置

  qy exec "<任务>"        在当前目录执行一次任务
    --cwd <路径>          指定工作区（默认当前目录）
    --json                输出 JSONL 事件流（供 CI 使用）

  qy serve                启动本地服务（桌面端与手机端均连接此服务）
    --port <端口>         默认 7717，0 = 随机可用端口
    --host <地址>         默认 0.0.0.0（允许手机连接）；仅限本机时使用 127.0.0.1
    --cwd <路径>          指定工作区
    --static <目录>       前端构建产物目录
    --print-token         将令牌输出到 stdout（供 Tauri 读取）
    --parent-pid <pid>    父进程退出时一并退出，避免留下孤儿服务

  qy doctor               一屏体检：配置、shell 沙箱、账本、MCP、插件
    --cwd <路径>          指定工作区
    --json                供脚本使用（仅有阻断项时返回非零退出码）

  qy mcp                  检查 ${MCP_CONFIG} 中各 server 的连接状态
    --tools               同时列出每个 server 提供的工具
    --cwd <路径>          指定工作区

  qy plugins              检查已安装的插件及其隔离程度
    --tools               同时列出每个插件提供的工具与启动日志
    --cwd <路径>          指定工作区

  qy usage                本机用量账本（账目不随会话删除而消失）
    --days <n>            统计区间，默认 30
    --by <维度>           model（默认）/ day / workspace / kind
    --json                供脚本使用

  qy export [<会话 id>]    导出会话（未指定 id 时列出可选会话）
    --json                完整 json（不裁剪）；默认 markdown（供阅读）
    --thinking            包含思考内容
    -o <文件>             写入文件，默认输出到 stdout

  qy probe [<模型名>]      检测指定模型；省略时检测当前默认模型
    --save                将结论写回配置；省略时只打印

  qy config               显示当前配置
  qy --version
`

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv

  // 子命令后的 --help 同样只输出用法：若交给 exec，会被当作任务描述，打开数据库并发出一次真实请求。
  if (cmd === '--help' || cmd === '-h' || rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(USAGE)
    return 0
  }
  if (!cmd) {
    // 无参数时进入交互模式，但**非 TTY 下仍只输出用法**：在 `qy | cat` 或 CI 中进入
    // 等待输入的循环会使进程不返回。
    if (!process.stdin.isTTY) {
      process.stdout.write(USAGE)
      return 0
    }
    await mkdir(configDir(), { recursive: true })
    return runTui(resolve(process.cwd()))
  }
  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${await version()}\n`)
    return 0
  }
  if (cmd === 'init') return runInit(rest)
  if (cmd === 'config') {
    const cfg = await loadConfig()
    process.stdout.write(`配置文件：${configPath()}\n账本：${dataPath()}\n\n`)
    process.stdout.write(`${JSON.stringify(cfg, null, 2)}\n`)
    // 体检结果写入 stderr：stdout 中的 JSON 需要能直接通过管道交给 jq，混入提示文字后不再是合法 JSON。
    for (const p of [...diagnoseConfig(cfg), ...diagnoseRunnable(cfg), ...configNotices(cfg)]) {
      process.stderr.write(`\n${YELLOW}⚠${RESET} ${p}\n`)
    }
    /*
     * 沙箱状态**每次都报告**，无论是否具备沙箱。
     *
     * 这是「如实上报」这一要求的落实：在没有内核边界的平台上，把「shell 命令能被拦截」
     * 当作默认前提是错误的，其余两层（静态规则、分类器）都是文本判断，无法拦截未列举的
     * 写法。不报告出来，这一默认前提就不会被质疑。
     */
    const sb = detectSandbox()
    const mark = sb.active ? `${GREEN}✓${RESET}` : `${YELLOW}⚠${RESET}`
    // 报告 WSL 版本：对 Windows 用户的建议是「在 WSL2 中运行 qy」，
    // 而「当前是否为 WSL、是哪个版本」是该建议唯一需要确认的条件。
    // 若不报告版本，WSL1 中显示「没有沙箱」会使该建议显得不成立。
    const where = sb.wsl === null ? sb.platform : `${sb.platform} · WSL${sb.wsl}`
    process.stderr.write(`\n${mark} shell 沙箱：${sb.backend}（${where}）\n  ${sb.reason}\n`)
    return 0
  }
  if (cmd === 'doctor') return runDoctor(rest)
  if (cmd === 'mcp') return runMcp(rest)
  if (cmd === 'plugins') return runPlugins(rest)
  if (cmd === 'usage') return runUsage(rest)
  if (cmd === 'export') return runExport(rest)
  if (cmd === 'probe') return runProbe(rest)
  if (cmd === 'exec') return runExec(rest)
  /*
   * 命令 runner 一侧。**不写入 USAGE**：它不是供用户使用的子命令，而是
   * `qy serve` 再次执行本二进制，作为「执行命令的父进程」。
   * 原因见 `tools/runner.ts` 的模块注释。
   */
  if (cmd === 'runner') {
    runCommandRunner()
    // 依靠 IPC 通道维持事件循环；父进程退出后本进程的 stdin 关闭，随之退出。
    return new Promise<number>(() => {})
  }
  if (cmd === 'serve') return runServe(rest)

  process.stderr.write(`未知命令：${cmd}\n\n${USAGE}`)
  return 2
}

/** 存在未知参数时报错并返回退出码 2；否则返回 null。 */
function rejectUnknown(flags: Flags): number | null {
  if (!flags.unknown.length) return null
  process.stderr.write(`未知参数：${flags.unknown.join(' ')}

${USAGE}`)
  return 2
}

async function runExec(args: string[]): Promise<number> {
  const flags = parseFlags(args)
  const bad = rejectUnknown(flags)
  if (bad !== null) return bad
  const prompt = flags.positional.join(' ').trim()
  if (!prompt) {
    process.stderr.write('缺少任务描述。示例：qy exec "把 README 里的安装步骤补上"\n')
    return 2
  }

  const workspaceRoot = resolve(flags.cwd ?? process.cwd())
  const json = flags.json === true

  await mkdir(configDir(), { recursive: true })
  const config = await loadConfig()

  // 配置不可用时在此停止，不建库、不发请求。
  //
  // 若继续执行，用户得到的是 provider 返回的 401，该消息既不含配置文件路径，
  // 也不含缺失的字段名，而这两项本地都已掌握。未配置 key 属于运行前置条件（`diagnoseRunnable`），
  // 在这条确实要发送请求的路径上，与配置格式问题一样在此拦截。
  const problems = [...diagnoseConfig(config), ...diagnoseRunnable(config)]
  if (problems.length) {
    for (const p of problems) process.stderr.write(`\n${RED}✗${RESET} ${p}\n`)
    return 2
  }
  // 提醒**不阻断**执行。`mode: "full"` 是用户自己的决定，提示一次即可；
  // 并入上方的 problems 会使「开启完全访问」导致「任何命令都无法执行」。
  for (const n of configNotices(config)) process.stderr.write(`\n${YELLOW}⚠${RESET} ${n}\n`)

  const store = new Store({ path: dataPath(), owner: 'cli' })
  // 此处同样需要导入定时任务的旧文件：本次会话注入了定时任务端口，若不导入，在 `qy serve`
  // 运行之前 `list_schedules` 无法读取已排定的任务。文件不合法时抛出，与 serve 的行为相同。
  importLegacySchedules(store)
  // 单次执行同样需要正文库：超出预算的命令输出若只截断而不落盘，
  // 模型在**同一轮中**无法通过 read_resource 读取被截去的中间部分。
  const content = new ContentStore(contentPathFor(dataPath()))
  /*
   * 正文回收。两个库都打开之后、执行本轮之前回收一次：清理上一个进程在登记引用之前
   * 退出所遗留的孤儿正文，与 `qy serve` 使用同一个协调器。
   *
   * 失败时只向 stderr 写一行，不阻止本轮执行：回收影响的是磁盘空间，不影响正确性。
   */
  try {
    collectResourceGarbage(store, content)
  } catch (err) {
    process.stderr.write(`[qy] 正文回收失败：${err instanceof Error ? err.message : String(err)}\n`)
  }

  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  // 单次执行同样提供 `office`：探测完成后再开始本轮，与 `qy serve` 使用同一个宿主实现。
  const office = createOfficeHost(() => config)
  await office.refresh()
  const officePort = office.port()
  const session = new Session({
    store,
    config,
    content,
    workspaceRoot,
    signal: controller.signal,
    ...(officePort ? { office: officePort } : {}),
  })

  let exitCode = 0
  try {
    for await (const ev of session.ask(prompt)) {
      if (json) {
        process.stdout.write(`${JSON.stringify(ev)}\n`)
      } else {
        renderHuman(ev)
      }
      if (ev.type === 'run.finished' && ev.status === 'failed') exitCode = 1
    }
  } catch (err) {
    process.stderr.write(`\n[qy] ${err instanceof Error ? err.message : String(err)}\n`)
    exitCode = 1
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    // 插件与 MCP server 都是子进程。若不回收，`qy exec` 退出后它们可能仍在运行，
    // 导致 CI 中命令已执行完毕而脚本阻塞不返回。
    await session.dispose()
    content.close()
    store.close()
  }
  return exitCode
}

// ───────────────────────── serve ─────────────────────────

async function runServe(args: string[]): Promise<number> {
  const flags = parseFlags(args)
  /*
   * **是否给出 `--cwd` 对应两种语义，不能合并为一个默认值。**
   *
   * 给出时表示「以该目录作为项目」，这是 CLI 的正常用法（`qy serve --cwd D:\项目`），
   * 必须照此使用。未给出表示未指定，此时把进程的 cwd 登记为项目是错误的：
   * 桌面外壳的 cwd 是其安装目录或 `src-tauri`，登记后会产生一个用户从未
   * 打开过的项目。
   *
   * 未给出时由 `serve()` 决定：账本中有项目时使用最近打开的项目，
   * 没有任何项目时才创建默认工作区。
   */
  const workspaceRoot = flags.cwd ? resolve(flags.cwd) : null

  await mkdir(configDir(), { recursive: true })
  /*
   * 日志落盘必须在读取配置之前安装：配置解析失败与迁移提示都经由 `log.*` 输出。
   *
   * 进程级异常处理只记录一行日志，随后仍然退出，不屏蔽异常。Bun 对未捕获异常与未处理拒绝的默认行为
   * 即以退出码 1 退出；这里保留该终态，只补充退出原因：发布版没有控制台，
   * 这一行是 sidecar 退出后唯一记录原因的日志。
   */
  setLogSink(fileLogSink(join(configDir(), 'logs')))
  const die = (kind: string, reason: unknown): void => {
    log.error('process', `${kind}，进程退出`, {
      error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    })
    process.exit(1)
  }
  process.on('uncaughtException', (err) => die('未捕获异常', err))
  process.on('unhandledRejection', (reason) => die('未处理的 Promise 拒绝', reason))
  const config = await loadConfig()

  // serve 与 exec 相反：配置有问题时**仍然启动**。
  //
  // 桌面外壳无条件 spawn 该命令，此处退出即导致应用无法打开，而用户唯一能修改配置的
  // 界面就在应用中。查看旧会话、修改配置都不需要 key，只有实际发起一轮才需要，
  // 届时 buildAdapter 会抛出 no_api_key，前端据此引导用户。
  // serve 不因配置问题退出，因此两类问题都只打印，可以合并。
  const problems = [
    ...diagnoseConfig(config),
    ...diagnoseRunnable(config),
    ...configNotices(config),
  ]

  const store = new Store({ path: dataPath(), owner: 'serve' })
  const previousProcessExit = processExitObservationFromEnv(process.env)
  // 上次退出的现场信息只使用一次。runner 与之后的命令都不需要继承这段 stderr。
  for (const name of [
    'QYWORK_PREVIOUS_EXIT_KIND',
    'QYWORK_PREVIOUS_EXIT_AT_MS',
    'QYWORK_PREVIOUS_EXIT_CODE',
    'QYWORK_PREVIOUS_EXIT_SIGNAL',
    'QYWORK_PREVIOUS_STDERR_TAIL',
  ]) {
    delete process.env[name]
  }

  /*
   * **必须在 `serve()` 之前执行**。
   *
   * Windows 上句柄会被继承：端口绑定之后再 spawn 的进程都会继承该监听
   * socket，而命令派生的后台服务存活时间长于 sidecar，因此 sidecar 退出之后
   * 端口仍被占用（实测记录与分析见 `tools/runner.ts` 的模块注释）。
   * runner 在绑定端口之前创建，它及其后代进程都不持有该句柄。
   *
   * 直接从源码运行时需要带上入口脚本（`bun <入口>.ts runner`），打包之后只有二进制
   * 本身（`qy runner`）：判据是「当前进程是否为 bun 在运行一个脚本」。
   */
  const runnerArgv = Bun.main.endsWith('.ts')
    ? [process.execPath, Bun.main, 'runner']
    : [process.execPath, 'runner']
  setCommandRunner(startCommandRunner(runnerArgv))

  const handle = serve({
    store,
    config,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    port: flags.port ?? 7717,
    host: flags.host ?? '0.0.0.0',
    ...(flags.static ? { staticDir: resolve(flags.static) } : {}),
    // Tauri spawn 时通过环境变量传入令牌，桌面端因此无需扫码配对。
    ...(process.env.QYWORK_TOKEN ? { token: process.env.QYWORK_TOKEN } : {}),
    /*
     * 原生宿主连接的凭据，同样只从环境变量读取。**同一份凭据用于两条宿主路径**
     * （`/native/browser` 与 `/native/desktop`），具体类型由服务端按 URL 路径判定。
     *
     * 没有该凭据时两条路径都不存在：从命令行直接启动的 serve 没有桌面外壳，也就没有原生资源。
     * **不要写入配置文件**：否则一个可以注册宿主的凭据会被写入磁盘。
     */
    ...(process.env.QYWORK_HOST_KEY ? { hostKey: process.env.QYWORK_HOST_KEY } : {}),
    ...(process.env.QYWORK_UPDATE_KEY ? { updateHostKey: process.env.QYWORK_UPDATE_KEY } : {}),
    ...(previousProcessExit ? { previousProcessExit } : {}),
  })

  // 父进程监视。
  //
  // 桌面外壳只在正常退出路径上终止 sidecar；外壳崩溃或被强制终止时（实测 Stop-Process 即如此）
  // 不会执行该路径，残留的 qy 会占用端口和 SQLite 的 WAL 锁，
  // 导致下次启动直接失败。因此由 sidecar 自行监视父进程，任何一方退出都不会遗留孤儿进程。
  if (flags.parentPid) {
    watchParent(flags.parentPid, async () => {
      log.info('serve', '父进程已退出，停止服务', { parentPid: flags.parentPid })
      await handle.stop()
      store.close()
      process.exit(0)
    })
  }

  if (flags.printToken) {
    // 供父进程（Tauri）按行读取。必须在任何装饰性输出之前，且格式稳定。
    process.stdout.write(`QYWORK_TOKEN=${handle.token}\n`)
    process.stdout.write(`QYWORK_PORT=${handle.port}\n`)
  }

  const local = `http://127.0.0.1:${handle.port}`
  log.info('serve', '已启动', {
    version: await version(),
    pid: process.pid,
    port: handle.port,
    host: flags.host ?? '0.0.0.0',
    workspace: handle.workspaceRoot,
  })
  process.stderr.write(`\n${BOLD}qy serve${RESET} 已启动\n`)
  for (const p of problems) process.stderr.write(`\n${YELLOW}⚠${RESET} ${p}\n`)
  process.stderr.write(`  工作区  ${handle.workspaceRoot}\n`)
  process.stderr.write(`  本机    ${local}/#t=${handle.token}\n`)
  if (flags.host !== '127.0.0.1') {
    const candidates = lanCandidates()
    process.stderr.write(`  局域网  ${handle.lanUrl()}\n`)
    // 安装了 VPN / Hyper-V / Docker 的机器上自动选择的地址不一定正确，
    // 因此同时列出备选地址，扫码无法连接时可手动输入其他地址。
    for (const c of candidates.slice(1)) {
      process.stderr.write(
        `${DIM}          备选 http://${c.address}:${handle.port}  (${c.name})${RESET}\n`,
      )
    }
    process.stderr.write(`\n${DIM}手机扫码接入：${RESET}\n`)
    process.stderr.write(`${await renderQr(handle.pairingUrl())}\n`)
  }
  process.stderr.write(`${DIM}按 Ctrl-C 停止服务${RESET}\n`)

  await new Promise<void>((done) => {
    const stop = async () => {
      process.stderr.write('\n正在停止…\n')
      log.info('serve', '收到停止信号，停止服务')
      await handle.stop()
      store.close()
      done()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
  return 0
}

// ───────────────────────── 可读输出 ─────────────────────────

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const RED = '\x1b[31m'
const GREEN = '\x1b[32m'
const YELLOW = '\x1b[33m'

function renderHuman(ev: AgentEvent): void {
  switch (ev.type) {
    case 'text.delta':
      process.stdout.write(ev.delta)
      break
    case 'tool.started':
      process.stdout.write(
        `\n${DIM}▸ ${ev.toolName}${ev.action?.target ? ` ${ev.action.target}` : ''}${RESET}\n`,
      )
      break
    case 'tool.finished': {
      const ok = ev.status === 'success'
      process.stdout.write(
        `${ok ? GREEN : RED}${ok ? '✓' : '✗'}${RESET} ${DIM}${ev.outcome.message}${RESET}\n`,
      )
      break
    }
    case 'run.error':
      process.stderr.write(`\n${RED}错误 [${ev.code}]${RESET} ${ev.message}\n`)
      break
    case 'run.finished': {
      const u = ev.usage
      const cached = u.cachedTokens === null ? '未回报' : String(u.cachedTokens)
      process.stdout.write(
        `\n${DIM}—— ${ev.stopReason} · 输入 ${u.inputTokens} 输出 ${u.outputTokens} 缓存命中 ${cached} · ${formatMoney(u.cost, u.currency)}${RESET}\n`,
      )
      if (ev.fileChanges.length) {
        const adds = ev.fileChanges.reduce((s, c) => s + (c.additions ?? 0), 0)
        const dels = ev.fileChanges.reduce((s, c) => s + (c.deletions ?? 0), 0)
        process.stdout.write(
          `${BOLD}${ev.fileChanges.length} 个文件已更改${RESET} ${GREEN}+${adds}${RESET} ${RED}-${dels}${RESET}\n`,
        )
      }
      break
    }
    default:
      break
  }
}

// ───────────────────────── 辅助函数 ─────────────────────────

interface Flags {
  positional: string[]
  /** 形如参数但不在本表中的词。exec 遇到时报错退出，不作为任务描述发出请求。 */
  unknown: string[]
  cwd?: string
  json?: boolean
  port?: number
  host?: string
  static?: string
  printToken?: boolean
  parentPid?: number
}

function parseFlags(args: string[]): Flags {
  const out: Flags = { positional: [], unknown: [] }
  const takeValue = (i: number): [string | undefined, number] => {
    const v = args[i + 1]
    return v !== undefined && !v.startsWith('--') ? [v, i + 1] : [undefined, i]
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--cwd') {
      const [v, ni] = takeValue(i)
      if (v) out.cwd = v
      i = ni
    } else if (a === '--host') {
      const [v, ni] = takeValue(i)
      if (v) out.host = v
      i = ni
    } else if (a === '--static') {
      const [v, ni] = takeValue(i)
      if (v) out.static = v
      i = ni
    } else if (a === '--port') {
      const [v, ni] = takeValue(i)
      if (v !== undefined) out.port = Number(v)
      i = ni
    } else if (a === '--parent-pid') {
      const [v, ni] = takeValue(i)
      if (v !== undefined && Number.isFinite(Number(v))) out.parentPid = Number(v)
      i = ni
    } else if (a === '--json') out.json = true
    else if (a === '--print-token') out.printToken = true
    else if (/^--?[A-Za-z][\w-]*$/.test(a)) out.unknown.push(a)
    else out.positional.push(a)
  }
  return out
}

/**
 * 轮询父进程是否仍在运行。
 *
 * 使用 `kill(pid, 0)`：它不发送信号，只做存在性与权限检查，是跨平台判断进程存活
 * 开销最小的方式。每 3 秒检查一次：足够及时，残留进程不会阻塞下次启动，且开销可以忽略。
 *
 * 已知局限：PID 会被系统复用，理论上可能误判为「父进程仍在运行」。桌面场景下父进程
 * 存活期通常以小时计、PID 回绕以万计，该窗口很小，不值得为此引入平台专用的
 * Job Object / prctl。
 */
function watchParent(pid: number, onGone: () => void): void {
  const timer = setInterval(() => {
    try {
      process.kill(pid, 0)
    } catch {
      clearInterval(timer)
      onGone()
    }
  }, 3000)
  // 该定时器只用于监视，不得阻止进程正常退出。
  timer.unref?.()
}

/**
 * 版本号。
 *
 * 编译期由 `--define QYWORK_VERSION` 内联；单文件二进制无法读取打包范围外的 VERSION
 * 文件（相对路径无法解析，实测会静默输出 0.0.0）。直接从源码运行时改为读取文件。
 */
declare const QYWORK_VERSION: string | undefined

async function version(): Promise<string> {
  if (typeof QYWORK_VERSION === 'string' && QYWORK_VERSION) return QYWORK_VERSION
  const file = Bun.file(new URL('../../../VERSION', import.meta.url))
  return (await file.text().catch(() => 'dev')).trim()
}

process.exit(await main(Bun.argv.slice(2)))
