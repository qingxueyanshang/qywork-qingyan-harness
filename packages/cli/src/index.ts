#!/usr/bin/env bun
/**
 * qy：QyWork 内核 CLI，即发布产物本身。
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
import { isatty } from 'node:tty'
import { Ports, provide } from '@qywork/agent'
import type { AgentEvent, ConversationId, FollowUp } from '@qywork/core'
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
  loadConfig,
  MCP_CONFIG,
  resolveModel,
  Session,
} from '@qywork/runtime'
import {
  CommandTaskTable,
  commandPortOf,
  directoryAssets,
  embeddedAssets,
  fileSource,
  processExitObservationOf,
  serve,
  settleAfterRound,
  systemPowerPort,
} from '@qywork/server'
import { ContentStore, contentPathFor, type ProcessExitObservation, Store } from '@qywork/store'
import {
  CommandPort,
  detectSandbox,
  OfficePort,
  runCommandRunner,
  setCommandRunner,
  startCommandRunner,
} from '@qywork/tools'
import { runDoctor } from './doctor.ts'
import { runExport } from './export.ts'
import { runInit } from './init.ts'
import { runLogin, runLogout } from './login.ts'
import { runMcp } from './mcp.ts'
import { runPlugins } from './plugins.ts'
import { runProbe } from './probe.ts'
import { runTui } from './tui.ts'
import { runUsage } from './usage.ts'
import { embeddedWeb } from './web-assets.ts'

const USAGE = `qy —— QyWork 编码 agent

  qy                      交互模式（多轮，同一会话）

  qy init                 生成配置（首次使用时先执行此命令）
    --force               覆盖已有配置

  qy login                以邮箱与密码登录 QyWork 账号，之后可使用内置模型
  qy logout               退出登录并移除本设备

  qy exec "<任务>"        在当前目录执行一次任务
    --cwd <路径>          指定工作区（默认当前目录）
    --model <模型名>      本次使用的模型（默认取配置中的默认模型）
    --json                输出 JSONL 事件流（供 CI 使用）

  qy serve                启动本地服务（桌面端与手机端均连接此服务）
    --port <端口>         默认 7717，0 = 随机可用端口
    --host <地址>         默认 127.0.0.1（手机经云端远程访问，不直接连接本服务）
    --cwd <路径>          指定工作区
    --static <目录>       前端构建产物目录（默认使用编译时嵌入的网页）
    --print-token         将令牌输出到 stdout（供 Tauri 读取）
    --parent-pid <pid>    父进程退出时一并退出，避免留下孤儿服务
    --credentials-stdin   从标准输入读取一行 JSON 凭据与上次退出信息（供桌面外壳传入）

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
  if (cmd === 'login') return runLogin()
  if (cmd === 'logout') return runLogout()
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
     * 当作默认前提是错误的，另一层（`decideCommand` 的静态规则）是文本判断，无法拦截未列举的
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
   * `qy serve` 再次执行本程序，作为「执行命令的父进程」。
   * 原因见 `tools/runner.ts` 的模块注释。
   */
  if (cmd === 'runner') {
    runCommandRunner()
    // 依靠 IPC 通道维持事件循环；父进程退出后经 `runner.ts` 的 `leave` 退出。
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

/** `qy exec` 的任务表中本会话的键。任务表按会话分组，本进程只执行一个会话；该键只在进程内使用，不写入账本。 */
const EXEC_CONVERSATION = 'cv_exec' as ConversationId

/** `qy exec` 执行期间用户不会发来消息：跟进队列恒为空，等待队列变化时只在到期或中止时返回。 */
const NO_FOLLOW_UPS = {
  queueOf: (): FollowUp[] => [],
  changed: (_conversationId: ConversationId, timeoutMs: number, signal: AbortSignal) => {
    if (signal.aborted) return Promise.reject(signal.reason)
    return new Promise<boolean>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal.reason)
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort)
        resolve(false)
      }, timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
    })
  },
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
  // 接口按 `resolveModel` 确定；无法确定（多个非默认接口都配置了该模型）时在此停止，不建库、不发请求。
  if (flags.model && !resolveModel(config, flags.model)) {
    process.stderr.write(
      `\n${RED}✗${RESET} 无法确定模型 ${flags.model} 所属的接口。请在设置中检查模型归属和默认接口。\n`,
    )
    return 2
  }
  // 提醒**不阻断**执行。`mode: "full"` 是用户自己的决定，提示一次即可；
  // 并入上方的 problems 会使「开启完全访问」导致「任何命令都无法执行」。
  for (const n of configNotices(config)) process.stderr.write(`\n${YELLOW}⚠${RESET} ${n}\n`)

  const store = new Store({ path: dataPath(), owner: 'cli' })
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
  // 后台命令与 `qy serve` 使用同一个任务表与端口。命令结束时的回执在本轮结束之后作为下一轮的消息执行，
  // 与 `qy serve` 中会话空闲时收到回执相同。
  const commands = new CommandTaskTable(() => {}, store)
  const receipts: FollowUp[] = []
  const commandPort = commandPortOf(commands, NO_FOLLOW_UPS, EXEC_CONVERSATION, (f) =>
    receipts.push(f),
  )
  const session = new Session({
    store,
    config,
    content,
    workspaceRoot,
    signal: controller.signal,
    ports: new Ports([
      ...(officePort ? [provide(OfficePort, officePort)] : []),
      provide(CommandPort, commandPort),
    ]),
  })
  /** 取出已投递的回执，合为下一轮的消息。 */
  const takeReceipts = () =>
    receipts
      .splice(0)
      .map((r) => r.content)
      .join('\n\n')

  let exitCode = 0
  try {
    const model = flags.model ? { model: flags.model } : {}
    let conversationId: ConversationId | undefined
    let message = prompt
    let origin: { origin?: 'command' } = {}
    for (;;) {
      for await (const ev of session.ask(message, conversationId, { ...model, ...origin })) {
        if (ev.type === 'run.started') conversationId = ev.conversationId
        if (json) {
          process.stdout.write(`${JSON.stringify(ev)}\n`)
        } else {
          renderHuman(ev)
        }
        if (ev.type === 'run.finished' && ev.status === 'failed') exitCode = 1
      }
      if (controller.signal.aborted) break
      origin = { origin: 'command' }
      // 回执作为下一轮的消息执行，与 `qy serve` 中回执发起一轮相同；以 background 启动的命令在退出前停止，其输出与回执进程退出后无人接收。
      const stopped = await settleAfterRound(
        commands,
        EXEC_CONVERSATION,
        () => receipts.length > 0,
        controller.signal,
      )
      if (controller.signal.aborted) break
      if (stopped.length > 0) {
        process.stderr.write(
          `[qy] 已停止仍在运行的后台命令：${stopped.map((c) => `${c.id}（${c.command}）`).join('、')}\n`,
        )
      }
      if (receipts.length === 0) break
      message = takeReceipts()
    }
  } catch (err) {
    process.stderr.write(`\n[qy] ${err instanceof Error ? err.message : String(err)}\n`)
    exitCode = 1
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    commands.stopAll()
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
  const startedAt = performance.now()
  let stageAt = startedAt
  let stage = '读取配置'
  const startupStage = (next: string): void => {
    const now = performance.now()
    log.info('startup', '启动阶段完成', {
      stage,
      durationMs: Math.round(now - stageAt),
      elapsedMs: Math.round(now - startedAt),
      next,
    })
    stage = next
    stageAt = now
  }
  const flags = parseFlags(args)
  // 在启动任何子进程之前读完：继承标准输入的子进程同样能读取这一行。
  let credentials: Credentials = {}
  let shellLines: StdinLines | null = null
  if (flags.credentialsStdin) {
    try {
      if (isatty(0)) throw new Error('--credentials-stdin 需要以管道提供标准输入')
      shellLines = stdinLines()
      credentials = parseCredentials(await shellLines())
    } catch (err) {
      process.stderr.write(`凭据读取失败：${err instanceof Error ? err.message : String(err)}\n`)
      return 2
    }
  }
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
  log.info('startup', '开始启动', { stage, pid: process.pid })
  const die = (kind: string, reason: unknown): void => {
    log.error('process', `${kind}，进程退出`, {
      error: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    })
    process.exit(1)
  }
  process.on('uncaughtException', (err) => die('未捕获异常', err))
  process.on('unhandledRejection', (reason) => die('未处理的 Promise 拒绝', reason))
  const config = await loadConfig()
  startupStage('打开账本')

  // 配置文件无法读取或解析时 `loadConfig` 抛出，serve 停止：以默认配置启动后，设置页的任何一次保存
  // 都会覆盖原文件。
  //
  // 结构问题（未配置 key、引用不存在的接口）仍然启动：桌面外壳无条件 spawn 该命令，此处退出即导致
  // 应用无法打开，而修改这些设置的界面就在应用中。查看旧会话、修改配置都不需要 key，只有实际发起一轮
  // 才需要，届时 buildAdapter 会抛出 no_api_key，前端据此引导用户。两类结构问题都只打印，可以合并。
  const problems = [
    ...diagnoseConfig(config),
    ...diagnoseRunnable(config),
    ...configNotices(config),
  ]

  const store = new Store({ path: dataPath(), owner: 'serve' })
  startupStage('创建命令进程')

  /*
   * **必须在 `serve()` 之前执行**。
   *
   * Windows 上句柄会被继承：端口绑定之后再 spawn 的进程都会继承该监听
   * socket，而命令派生的后台服务存活时间长于 sidecar，因此 sidecar 退出之后
   * 端口仍被占用（实测记录与分析见 `tools/runner.ts` 的模块注释）。
   * runner 在绑定端口之前创建，它及其后代进程都不持有该句柄。
   *
   * `process.execPath` 是 Bun 运行时，入口脚本必须一并传入：源码运行时是 `index.ts`，
   * 安装后是脚本目录中的 `index.js`。
   */
  setCommandRunner(startCommandRunner([process.execPath, Bun.main, 'runner']))
  startupStage('启动服务')

  // 任务运行期间阻止系统睡眠、按定时任务唤醒系统。不按是否由桌面外壳启动区分：经局域网连接的客户端发起的任务同样需要。
  const power = systemPowerPort()
  // 网页来源，二选一：`--static` 指定的目录、编译时嵌入的网页。供本机浏览器打开，也经隧道提供给远程访问
  // （云端按设备缓存入口页与带哈希的文件）。源码运行时由 scripts/dev.ts 以 `--static` 传入构建产物。
  const web = flags.static
    ? fileSource(directoryAssets(resolve(flags.static)))
    : embeddedWeb
      ? fileSource(embeddedAssets(embeddedWeb))
      : null
  const handle = serve({
    store,
    config,
    ...(workspaceRoot ? { workspaceRoot } : {}),
    port: flags.port ?? 7717,
    host: flags.host ?? '127.0.0.1',
    ...(web ? { web } : {}),
    // 桌面外壳经 `--credentials-stdin` 交付令牌，桌面端因此无需扫码配对；恢复重启时交付的是原令牌。
    ...(credentials.token ? { token: credentials.token } : {}),
    /*
     * 原生宿主连接的凭据，同样只经 `--credentials-stdin` 交付。**同一份凭据用于两条宿主路径**
     * （`/native/browser` 与 `/native/desktop`），具体类型由服务端按 URL 路径判定。
     *
     * 没有该凭据时两条路径都不存在：从命令行直接启动的 serve 没有桌面外壳，也就没有原生资源。
     * **不要写入配置文件**：否则一个可以注册宿主的凭据会被写入磁盘。
     */
    ...(credentials.hostKey ? { hostKey: credentials.hostKey } : {}),
    ...(credentials.updateKey ? { updateHostKey: credentials.updateKey } : {}),
    ...(credentials.previousExit ? { previousProcessExit: credentials.previousExit } : {}),
    ...(power ? { power } : {}),
    remote: true,
  })
  startupStage('发送就绪回执')

  // 父进程监视。
  //
  // 桌面外壳只在正常退出路径上停止 sidecar；外壳崩溃或被强制终止（如 `Stop-Process`）时
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
  startupStage('就绪')

  const local = `http://127.0.0.1:${handle.port}`
  log.info('serve', '已启动', {
    version: await version(),
    pid: process.pid,
    port: handle.port,
    host: flags.host ?? '127.0.0.1',
    workspace: handle.workspaceRoot,
  })
  process.stderr.write(`\n${BOLD}qy serve${RESET} 已启动\n`)
  for (const p of problems) process.stderr.write(`\n${YELLOW}⚠${RESET} ${p}\n`)
  process.stderr.write(`  工作区  ${handle.workspaceRoot}\n`)
  process.stderr.write(`  本机    ${local}/#t=${handle.token}\n`)
  process.stderr.write(`${DIM}按 Ctrl-C 停止服务${RESET}\n`)

  await new Promise<void>((done) => {
    let stopping = false
    const stop = async (source: string) => {
      if (stopping) return
      stopping = true
      process.stderr.write('\n正在停止…\n')
      log.info('serve', '收到停止请求，停止服务', { source })
      await handle.stop()
      store.close()
      done()
    }
    process.on('SIGINT', () => stop('SIGINT'))
    process.on('SIGTERM', () => stop('SIGTERM'))
    if (shellLines) void watchStopRequest(shellLines, () => stop('stdin'))
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
  credentialsStdin?: boolean
  model?: string
}

/** 带值的参数。值取下一个不以 `--` 开头的词；缺少时不调用处理器。 */
const VALUE_FLAGS: Record<string, (out: Flags, v: string) => void> = {
  '--cwd': (out, v) => {
    if (v) out.cwd = v
  },
  '--host': (out, v) => {
    if (v) out.host = v
  },
  '--static': (out, v) => {
    if (v) out.static = v
  },
  '--model': (out, v) => {
    if (v) out.model = v
  },
  '--port': (out, v) => {
    out.port = Number(v)
  },
  '--parent-pid': (out, v) => {
    if (Number.isFinite(Number(v))) out.parentPid = Number(v)
  },
}

/** 不带值的参数。 */
const SWITCH_FLAGS: Record<string, (out: Flags) => void> = {
  '--json': (out) => {
    out.json = true
  },
  '--print-token': (out) => {
    out.printToken = true
  },
  '--credentials-stdin': (out) => {
    out.credentialsStdin = true
  },
}

function parseFlags(args: string[]): Flags {
  const out: Flags = { positional: [], unknown: [] }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    const withValue = VALUE_FLAGS[a]
    if (withValue) {
      const v = args[i + 1]
      if (v !== undefined && !v.startsWith('--')) {
        withValue(out, v)
        i++
      }
    } else if (SWITCH_FLAGS[a]) SWITCH_FLAGS[a](out)
    else if (/^--?[A-Za-z][\w-]*$/.test(a)) out.unknown.push(a)
    else out.positional.push(a)
  }
  return out
}

/** 桌面外壳经 `--credentials-stdin` 交付的凭据。缺省的一项按未传入处理。 */
interface Credentials {
  token?: string
  hostKey?: string
  updateKey?: string
  /** 外壳观察到的上一个 serve 进程的退出信息，恢复重启时才有（`processExitObservationOf`）。 */
  previousExit?: ProcessExitObservation
}

const CREDENTIAL_FIELDS = ['token', 'hostKey', 'updateKey'] as const

/** 逐行读取标准输入，每次调用返回下一行（不含换行）；输入结束时返回 null，结束前未换行的内容丢弃。 */
type StdinLines = () => Promise<string | null>

/**
 * 标准输入的行读取器，整个进程只创建一个：`--credentials-stdin` 时第一行是凭据，之后每行是外壳的一条指令
 * （`watchStopRequest`）。外壳在 sidecar 运行期间保持管道打开。
 *
 * 不要在读完凭据后取消读取器再另建一个：同一次读取取得的数据块可能已包含其后的指令行，取消即丢弃。
 */
function stdinLines(): StdinLines {
  const reader = Bun.stdin.stream().getReader()
  const decoder = new TextDecoder()
  let text = ''
  let ended = false
  return async () => {
    for (;;) {
      const at = text.indexOf('\n')
      if (at >= 0) {
        const line = text.slice(0, at)
        text = text.slice(at + 1)
        return line
      }
      if (ended) return null
      const { value, done } = await reader.read()
      if (done) ended = true
      else text += decoder.decode(value, { stream: true })
    }
  }
}

/**
 * 解析标准输入的第一行 JSON 凭据。
 *
 * 凭据不经环境变量交付：环境块由本进程启动的全部子进程继承，Bun 中删除 `process.env` 的键之后，
 * 不传 `env` 启动的子进程仍取得原值。标准输入的这一行只由本进程读取一次。上次退出的信息（`previousExit`）
 * 同样经这一行交付：其中的 stderr 尾部可能含有任意输出。它无法解析时按未传入处理，不阻止启动。
 *
 * 标准输入在换行之前结束、内容不是约定的 JSON 对象时抛出，调用方以非零退出码结束进程。
 */
function parseCredentials(line: string | null): Credentials {
  if (line === null) throw new Error('标准输入在凭据行结束之前关闭')
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    throw new Error('凭据行不是合法的 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('凭据行不是 JSON 对象')
  }
  const out: Credentials = {}
  for (const [name, value] of Object.entries(parsed)) {
    if (name === 'previousExit') {
      const exit = processExitObservationOf(value)
      if (exit) out.previousExit = exit
      continue
    }
    const field = CREDENTIAL_FIELDS.find((f) => f === name)
    if (!field) throw new Error(`未知的凭据字段：${name}`)
    if (typeof value !== 'string' || !value) throw new Error(`凭据字段 ${name} 必须是非空字符串`)
    out[field] = value
  }
  return out
}

/**
 * 读取外壳经标准输入发出的指令，读取到 `stop` 时调用 `onStop`。
 *
 * 外壳退出与安装更新之前写入该指令，限时等待本进程退出，超时才终止进程：直接终止时 `handle.stop()`
 * 不执行，运行中的命令进程树、MCP、插件与外部 CLI 都不会结束。
 * 标准输入结束不视为停止：开发脚本交付凭据后即关闭标准输入，外壳崩溃由 `watchParent` 处理。
 */
async function watchStopRequest(next: StdinLines, onStop: () => void): Promise<void> {
  for (let line = await next(); line !== null; line = await next()) {
    if (line.trim() === 'stop') {
      onStop()
      return
    }
    log.warn('serve', '忽略无法识别的标准输入指令', { line: line.slice(0, 80) })
  }
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
 * 构建期由 `define` 内联 `QYWORK_VERSION`：安装目录中没有 VERSION 文件。
 * 直接从源码运行时改为读取文件。
 */
declare const QYWORK_VERSION: string | undefined

async function version(): Promise<string> {
  if (typeof QYWORK_VERSION === 'string' && QYWORK_VERSION) return QYWORK_VERSION
  const file = Bun.file(new URL('../../../VERSION', import.meta.url))
  return (await file.text().catch(() => 'dev')).trim()
}

process.exit(await main(Bun.argv.slice(2)))
