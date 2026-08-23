#!/usr/bin/env bun
/**
 * qy —— qywork 内核 CLI。发布产物本体。
 *
 * 桌面端不是「一个内置了 agent 的应用」，而是这个 CLI 的一个前端：Tauri 只负责
 * spawn `qy serve` 并显示 WebView，业务状态一个字节都不存在 Rust 侧。手机端连的
 * 也是同一个 `qy serve`。这样只有一本账。
 *
 *   qy exec "<任务>"    单次执行，人读格式；--json 出 JSONL 供 CI 消费
 *   qy serve           本地 HTTP + WebSocket（桌面端与手机端都连它）
 *   qy config          打印当前配置与配置文件路径
 *
 * 无参数时进交互式（非 TTY 下打印用法）。`qy team run` 尚未实现——编排目前从图形界面发起。
 */

import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { AgentEvent } from '@qywork/core'
import { formatMoney } from '@qywork/core'
import {
  configDir,
  configNotices,
  configPath,
  dataPath,
  diagnoseConfig,
  loadConfig,
  MCP_CONFIG,
  Session,
} from '@qywork/runtime'
import { lanCandidates, serve } from '@qywork/server'
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

  qy                      交互式（多轮，同一个会话）

  qy init                 生成配置（第一次用先跑这个）
    --force               覆盖已有配置

  qy exec "<任务>"        在当前目录执行一次任务
    --cwd <路径>          指定工作区（默认当前目录）
    --json                输出 JSONL 事件流（CI 用）

  qy serve                启动本地服务（桌面端与手机端都连它）
    --port <端口>         默认 7717，0 = 随机可用端口
    --host <地址>         默认 0.0.0.0（手机可连）；仅本机用 127.0.0.1
    --cwd <路径>          指定工作区
    --static <目录>       前端构建产物目录
    --print-token         把令牌打到 stdout（供 Tauri 读取）
    --parent-pid <pid>    父进程退出时一并退出，避免留下孤儿服务

  qy doctor               一屏体检：配置、shell 沙箱、账本、MCP、插件
    --cwd <路径>          指定工作区
    --json                给脚本用（只有阻断项才退非零）

  qy mcp                  检查 ${MCP_CONFIG} 里的 server 连没连上
    --tools               连带列出每个 server 提供的工具
    --cwd <路径>          指定工作区

  qy plugins              检查装了哪些插件、隔离到什么程度
    --tools               连带列出每个插件提供的工具与启动日志
    --cwd <路径>          指定工作区

  qy usage                本机用量账本（账目不随会话删除而消失）
    --days <n>            统计区间，默认 30
    --by <维度>           model（默认）/ day / workspace / kind
    --json                给脚本用

  qy export [<会话 id>]    导出会话（不给 id 时列出可选的）
    --json                完整 json（不裁剪）；默认 markdown（给人读）
    --thinking            带上思考内容
    -o <文件>             写文件，默认打到 stdout

  qy probe [<档案名>]      实测端点支持什么（思考模式、effort 档位）
    --save                把结论写回配置；不加则只打印

  qy config               显示当前配置
  qy --version
`

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv

  if (cmd === '--help' || cmd === '-h') {
    process.stdout.write(USAGE)
    return 0
  }
  if (!cmd) {
    // 无参数：交互式。但**非 TTY 下仍然打用法**——`qy | cat` 或 CI 里
    // 进一个等输入的循环，表现是「命令挂住了」，而那是最难排查的一种。
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
    // 体检结果走 stderr：stdout 那份 JSON 要能直接管道给 jq，掺了中文提示就不是 JSON 了。
    for (const p of [...diagnoseConfig(cfg), ...configNotices(cfg)]) {
      process.stderr.write(`\n${YELLOW}⚠${RESET} ${p}\n`)
    }
    /*
     * 沙箱状态**每次都报**，有没有都报。
     *
     * 这是「如实上报」那条要求的落点：一个没有内核边界的平台上，
     * 用户以为 shell 命令被拦得住，是这套权限模型最危险的误解——
     * 因为剩下两层（静态规则、分类器）都是文本判断，而文本判断挡不住
     * 一个没想到的写法。安静地不说等于默认让人往好处想。
     */
    const sb = detectSandbox()
    const mark = sb.active ? `${GREEN}✓${RESET}` : `${YELLOW}⚠${RESET}`
    // 报出 WSL 版本：给 Windows 用户的建议就是「在 WSL2 里跑 qy」，
    // 而「我已经在 WSL 里了吗、是第几版」是那条建议唯一需要确认的事。
    // 不说的话，用户在 WSL1 里看到「没有沙箱」会以为建议本身没用。
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
   * 命令 runner 那一侧。**不写进 USAGE**：它不是给人用的子命令，是
   * `qy serve` 自己再执行一次这个二进制、把它当作「跑命令的那个父进程」。
   * 理由见 `tools/runner.ts` 的模块注释。
   */
  if (cmd === 'runner') {
    runCommandRunner()
    // 靠 IPC 通道钉住事件循环；父进程一退，这一侧的 stdin 关闭，随之退出。
    return new Promise<number>(() => {})
  }
  if (cmd === 'serve') return runServe(rest)

  process.stderr.write(`未知命令：${cmd}\n\n${USAGE}`)
  return 2
}

async function runExec(args: string[]): Promise<number> {
  const flags = parseFlags(args)
  const prompt = flags.positional.join(' ').trim()
  if (!prompt) {
    process.stderr.write('需要一个任务描述。例：qy exec "把 README 里的安装步骤补上"\n')
    return 2
  }

  const workspaceRoot = resolve(flags.cwd ?? process.cwd())
  const json = flags.json === true

  await mkdir(configDir(), { recursive: true })
  const config = await loadConfig()

  // 配置不可用就在这里停，不建库、不发请求。
  //
  // 让它跑下去的话，用户拿到的是一条 provider 返回的 401——那条消息既不知道
  // 配置文件在哪，也不知道该往里写什么。本地明明全知道。
  const problems = diagnoseConfig(config)
  if (problems.length) {
    for (const p of problems) process.stderr.write(`\n${RED}✗${RESET} ${p}\n`)
    return 2
  }
  // 提醒**不阻断**。`mode: "full"` 是用户自己的决定，说一句就够——
  // 把它并进上面的 problems 会让「开了完全访问」变成「一条命令都跑不了」，
  // 而那正是这条分支刚踩过的坑。
  for (const n of configNotices(config)) process.stderr.write(`\n${YELLOW}⚠${RESET} ${n}\n`)

  const store = new Store({ path: dataPath() })
  // 一次性执行同样需要正文库：超预算的命令输出如果只截断不落盘，
  // 模型在**同一轮里**就没法用 read_resource 把中间那段读回来。
  const content = new ContentStore(contentPathFor(dataPath()))

  const controller = new AbortController()
  const onSignal = () => controller.abort()
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  const session = new Session({
    store,
    config,
    content,
    workspaceRoot,
    signal: controller.signal,
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
    // 插件与 MCP server 都是子进程。不收掉的话 `qy exec` 退出后它们可能还活着，
    // 而 CI 里那表现为「命令跑完了但脚本挂住不返回」。
    session.dispose()
    content.close()
    store.close()
  }
  return exitCode
}

// ───────────────────────── serve ─────────────────────────

async function runServe(args: string[]): Promise<number> {
  const flags = parseFlags(args)
  /*
   * **给没给 `--cwd` 是两种语义，不能合并成一个默认值。**
   *
   * 给了 = 「就用这个目录当项目」，CLI 的正常用法（`qy serve --cwd D:\项目`），
   * 必须照用。没给 = 「我没指定」——这时候把进程的 cwd 登记成项目是错的：
   * 桌面外壳的 cwd 是它自己的安装目录或 `src-tauri`，登记进去就成了一个
   * 谁也没要过的项目（ROADMAP §33.2 那个 `src-tauri` 项目就是这么来的）。
   *
   * 没给的时候交给 `serve()` 自己决定：账本里有项目就用最近打开的那个，
   * 一个都没有才建默认工作区。
   */
  const workspaceRoot = flags.cwd ? resolve(flags.cwd) : null

  await mkdir(configDir(), { recursive: true })
  const config = await loadConfig()

  // serve 与 exec 相反：配置有问题**照样启动**。
  //
  // 桌面外壳是无条件 spawn 这条命令的，这里退出等于应用打不开，而用户唯一能修配置的
  // 界面恰恰在应用里。翻旧会话、改配置都不需要 key，只有真的发起一轮才需要——
  // 那时 buildAdapter 会抛 no_api_key，前端据此引导。
  // serve 本来就不因配置问题退出，所以两者都只是打印，合并即可。
  const problems = [...diagnoseConfig(config), ...configNotices(config)]

  const store = new Store({ path: dataPath() })

  /*
   * **必须在 `serve()` 之前**。
   *
   * Windows 上句柄是继承的：端口绑好之后再 spawn 出去的进程都会拿到那个监听
   * socket，而命令自己派生的后台服务活得比 sidecar 久——于是 sidecar 退出之后
   * 端口仍然被攥着（实测与推理都在 `tools/runner.ts` 的模块注释里）。
   * runner 出生在绑端口之前，它和它的子孙手里都没有那份句柄。
   *
   * 源码直跑时要把入口脚本带上（`bun <入口>.ts runner`），打包之后只有二进制
   * 自己（`qy runner`）——判据是「这个进程是不是 bun 在跑一个脚本」。
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
    // Tauri spawn 时用环境变量把令牌传进来，桌面端就不必再走扫码。
    ...(process.env.QYWORK_TOKEN ? { token: process.env.QYWORK_TOKEN } : {}),
  })

  // 父进程守望。
  //
  // 桌面外壳只在正常退出路径上杀 sidecar；它崩溃或被强杀时（实测 Stop-Process 就会）
  // 那条路径根本不会走到，留下的 qy 会占着端口和 SQLite 的 WAL 锁，
  // 下次启动直接起不来。所以由 sidecar 自己盯着父进程，谁死都不会留孤儿。
  if (flags.parentPid) {
    watchParent(flags.parentPid, () => {
      process.stderr.write('\n父进程已退出，停止服务\n')
      handle.stop()
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
  process.stderr.write(`\n${BOLD}qy serve${RESET} 已启动\n`)
  for (const p of problems) process.stderr.write(`\n${YELLOW}⚠${RESET} ${p}\n`)
  process.stderr.write(`  工作区  ${handle.workspaceRoot}\n`)
  process.stderr.write(`  本机    ${local}/#t=${handle.token}\n`)
  if (flags.host !== '127.0.0.1') {
    const candidates = lanCandidates()
    process.stderr.write(`  局域网  ${handle.lanUrl()}\n`)
    // 装了 VPN / Hyper-V / Docker 的机器上自动判断不一定准，
    // 把备选也列出来，扫不通可以直接手输另一个。
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
    const stop = () => {
      process.stderr.write('\n正在停止…\n')
      handle.stop()
      store.close()
      done()
    }
    process.on('SIGINT', stop)
    process.on('SIGTERM', stop)
  })
  return 0
}

// ───────────────────────── 人读渲染 ─────────────────────────

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
        `\n${DIM}—— ${ev.stopReason} · 入 ${u.inputTokens} 出 ${u.outputTokens} 缓存命中 ${cached} · ${formatMoney(u.cost, u.currency)}${RESET}\n`,
      )
      if (ev.fileChanges.length) {
        const adds = ev.fileChanges.reduce((s, c) => s + c.additions, 0)
        const dels = ev.fileChanges.reduce((s, c) => s + c.deletions, 0)
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

// ───────────────────────── 小工具 ─────────────────────────

interface Flags {
  positional: string[]
  cwd?: string
  json?: boolean
  port?: number
  host?: string
  static?: string
  printToken?: boolean
  parentPid?: number
}

function parseFlags(args: string[]): Flags {
  const out: Flags = { positional: [] }
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
    else out.positional.push(a)
  }
  return out
}

/**
 * 轮询父进程是否还活着。
 *
 * 用 `kill(pid, 0)`——它不发信号，只做存在性与权限检查，是跨平台判断进程存活
 * 最轻的方式。3 秒一次：足够快到不会让残留卡住下次启动，又不会有可感知的开销。
 *
 * 已知限度：PID 会被系统复用，理论上可能误判成「父进程还在」。桌面场景下父进程
 * 存活期通常以小时计、PID 回绕以万计，这个窗口小到不值得为它引入平台专用的
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
  // 不让这个定时器把进程钉住：它只是守望，不该阻止正常退出。
  timer.unref?.()
}

/**
 * 版本号。
 *
 * 编译期由 `--define QYWORK_VERSION` 内联；单文件二进制里读不到打包外的 VERSION
 * 文件（相对路径解析不出来，实测会静默输出 0.0.0）。源码直跑时回落读文件。
 */
declare const QYWORK_VERSION: string | undefined

async function version(): Promise<string> {
  if (typeof QYWORK_VERSION === 'string' && QYWORK_VERSION) return QYWORK_VERSION
  const file = Bun.file(new URL('../../../VERSION', import.meta.url))
  return (await file.text().catch(() => 'dev')).trim()
}

process.exit(await main(Bun.argv.slice(2)))
