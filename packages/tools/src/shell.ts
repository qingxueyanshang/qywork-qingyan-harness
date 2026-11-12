/**
 * shell 工具。
 *
 * 这是权限模型中风险最高的工具：一条命令能做的事没有上界。设计取舍是
 * 不依赖字符串检查保证安全：命令注入的黑名单无法覆盖所有构造方式。
 * 实际的防线是：
 *
 * 1. 每次调用都经过权限检查（`auto` 模式下由硬边界与静态规则裁决，不弹出确认框）。
 * 2. cwd 强制限定在允许的根目录内（工作区 + 显式配置的额外目录）。
 * 3. 凭证不进入子进程，输出中出现的凭证明文也要屏蔽，见下。
 * 4. 前台命令按停滞判定终止，输出经投递限制后交给模型，防止耗尽上下文；转入后台的命令由
 *    服务进程级的任务表持有（`CommandPort`），由模型、用户或应用退出结束，每条输出流只保留最近的一段。
 * 5. 不对 shell 解释符做「安全化」处理，原样执行裁决过的命令。
 * 6. 在有内核沙箱的平台上再加一层（`sandbox.ts`）：这一层不检查命令文本，
 *    它弥补的正是前五条无法覆盖的部分，即未预料到的写法。
 *
 * 第 3 条是一道独立的防线：子进程环境不得是 `env: { ...process.env }`，否则模型生成的命令会继承
 * 完整环境，包括 `ANTHROPIC_API_KEY` / `DEEPSEEK_API_KEY`。模型的输出是不可信输入：它读取的网页、
 * 依赖的 README、`AGENTS.md` 中一句提示注入即可造成泄露。
 *
 * 仅靠操作系统级沙箱不够：沙箱是否存在取决于平台，原生 Windows 上目前没有
 * （`sandbox.ts` 会如实报告）。剥离环境变量在所有平台上都成立，
 * 因此它不是沙箱的替代，而是沙箱之下的保底：无法取得明文，泄露就不会离开本机。
 *
 * 剥离输入的同时输出侧也要屏蔽：只处理输入侧时，一句 `cat .env` 仍会把 key
 * 送进上下文再发给 provider。屏蔽发生在落盘与回传之前：
 * 先落盘再屏蔽，磁盘上的副本仍是明文。
 *
 * agent 使用管道而不是 PTY：交互式终端面板使用 Tauri 的 portable-pty，
 * 面向用户操作，与本文件无关。
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { delimiter, join } from 'node:path'
import {
  type CommandPort,
  deliveredTokens,
  recordBatchSpent,
  type ToolContext,
  type ToolSpec,
} from '@qywork/agent'
import type { FileChange, IntermediateResourceRef } from '@qywork/core'
import { idArg } from './args.ts'
import { classifyAddress } from './net-safety.ts'
import {
  conversationTempDir,
  PROTECTED_DIRS,
  resolveInWorkspace,
  rootsOf,
  workspacePythonBin,
  workspacePythonDir,
  writableRoots,
} from './paths.ts'
import {
  type CollectedProcess,
  type CommandShell,
  collectProcess,
  killTree,
  type SandboxPolicy,
  spawnGuarded,
  treeBusy,
} from './sandbox.ts'
import { createStreamRedactor, scrubEnv } from './secrets.ts'
import { deliver, excerptBytes } from './sink.ts'
import { openChangeWindow } from './workspace-watch.ts'

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * 单条命令运行时长的上限。
 *
 * 导出是因为本机单次工具执行的时长上限只应有一个值。外部 CLI 自身也执行
 * 构建与测试，它一侧的静默时限取同一个值；各写一份必然出现偏差。
 */
export const MAX_TIMEOUT_MS = 600_000

/**
 * 命令已退出，但其派生的后代进程仍持有输出管道。
 *
 * 必须告知模型：模型据此才能知道后台留有进程（启动服务的脚本即属此类），
 * 且该进程此后的输出不会进入本次结果，只能查看它自己的日志。
 * 不告知时，这一事实在结果中完全不可见，而它是这类命令唯一关键的事实。
 */
const BACKGROUND_HELD =
  '。注意：命令已退出，但命令遗留的后台进程仍在运行并持有输出管道；' +
  '本次结果只含命令自身的输出，不含该进程此后的输出。'

/**
 * 工作区观察器收尾时未等到在途事件全部交付、忽略判定执行失败，或收尾扫描达到上限而停止。
 *
 * 必须说明：否则一次未执行完的过滤与一次确实没有改动的执行，在结果中完全相同。
 */
const WATCH_INCOMPLETE =
  '。注意：本次文件改动的观察范围不完整，清单可能有遗漏，也可能混入了被忽略的产物。'

/**
 * 后台命令每条输出流至少保留的字符数，超出后从头部按块丢弃（`RecentOutput`）。
 *
 * 取值依据：本仓库全量测试的完整输出实测约 24 万字节，此值能完整容纳一次长时间构建或测试的输出；
 * 超出它的是持续运行的服务日志，有用的是最近的部分。每次读取都把保留的内容整份写入正文库，此值同时限制单次写入量。
 */
const KEPT_OUTPUT_CHARS = 1 << 20
/** 丢弃的单位：保留量在上限与上限加一块之间，每片输出不触发对整串的切分。 */
const KEPT_BLOCK_CHARS = 1 << 16

/**
 * 一条输出流最近的一段。末块未满时并入末块，去掉首块后仍不少于上限时整块丢弃首块。
 * 收到的文字按块长切分后写入：管道一次交来的文字可以超过上限，整段作为一块时没有可丢弃的首块，保留量不受上限约束。
 */
export class RecentOutput {
  private readonly blocks: string[] = []
  private size = 0
  /** 已从头部丢弃的字符数。 */
  dropped = 0

  push(text: string): void {
    for (let at = 0; at < text.length; at += KEPT_BLOCK_CHARS) {
      this.add(text.slice(at, at + KEPT_BLOCK_CHARS))
    }
  }

  private add(text: string): void {
    const tail = this.blocks.at(-1)
    if (tail !== undefined && tail.length < KEPT_BLOCK_CHARS) {
      this.blocks[this.blocks.length - 1] = tail + text
    } else {
      this.blocks.push(text)
    }
    this.size += text.length
    while (this.blocks.length > 1) {
      const head = this.blocks[0] as string
      if (this.size - head.length < KEPT_OUTPUT_CHARS) break
      this.blocks.shift()
      this.size -= head.length
      this.dropped += head.length
    }
  }

  text(): string {
    return this.blocks.join('')
  }
}

/** 后台命令丢弃过输出时的说明：模型据此知道读到的不是全文。没有丢弃时为空串。 */
function droppedNote(dropped: { stdout: number; stderr: number }): string {
  const parts = (['stdout', 'stderr'] as const)
    .filter((channel) => dropped[channel] > 0)
    .map((channel) => `${channel} 已丢弃最早的 ${dropped[channel]} 个字符`)
  return parts.length
    ? `。注意：后台命令每条输出流只保留最近的约 ${KEPT_OUTPUT_CHARS} 个字符，${parts.join('，')}`
    : ''
}

/**
 * 本轮已报告的工作区相对路径，存放在 `ctx.state`（run 级，每条消息一个）。
 *
 * 观察器用它对账：删除整个目录时递归 watch 只为目录产生一条事件，其中的文件
 * 在事件与扫描两条来源中都不可见，不对账就停留在最后一次观察到的状态。
 */
const REPORTED_PATHS_KEY = 'shell.reportedPaths'

function turnReported(state: Map<string, unknown>): Set<string> {
  const known = state.get(REPORTED_PATHS_KEY)
  if (known instanceof Set) return known as Set<string>
  const fresh = new Set<string>()
  state.set(REPORTED_PATHS_KEY, fresh)
  return fresh
}

function trackReported(reported: Set<string>, changes: FileChange[]): void {
  for (const c of changes) {
    if (c.changeType === 'deleted') reported.delete(c.path)
    else reported.add(c.path)
  }
}

/**
 * 执行模型代码的子进程所用的环境变量：剥离凭证、加入非交互设置、临时目录指向工作区 `.tmp`。
 *
 * `run_command` 与 `office` 共用此函数：两处各自拼装时，一处遗漏凭证剥离不会产生任何报错。
 * NON_INTERACTIVE_ENV 放在剥离之后：它由本文件注入，不含凭证，也不应被变量名规则误删。
 */
export async function commandEnv(
  ctx: Pick<
    ToolContext,
    'secrets' | 'envAllowList' | 'workspaceRoot' | 'conversationId' | 'unrestrictedPaths'
  >,
): Promise<Record<string, string>> {
  const env = {
    ...scrubEnv(process.env, ctx.secrets ?? { values: [] }, {
      allow: ctx.envAllowList ?? DEFAULT_ENV_ALLOW,
    }),
    ...NON_INTERACTIVE_ENV,
    ...(await tmpEnv(conversationTempDir(ctx.workspaceRoot, ctx.conversationId))),
  }
  return ctx.unrestrictedPaths ? env : withWorkspacePython(env, ctx.workspaceRoot)
}

/**
 * auto 模式下激活工作区 Python 环境：可执行目录放在 PATH 最前并设置 `VIRTUAL_ENV`，命令中的 `python`、`pip`
 * 与装入的命令行工具都取自该环境，包只装入工作区。完全访问模式不调用：装入全局还是工作区由模型选择。
 * 键名沿用环境中原有的写法（Windows 上通常为 `Path`）：变量名不区分大小写，另写一个 `PATH` 会传入两份。
 */
function withWorkspacePython(env: Record<string, string>, workspaceRoot: string) {
  const bin = workspacePythonBin(workspaceRoot)
  if (!existsSync(join(bin, process.platform === 'win32' ? 'python.exe' : 'python'))) return env
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  return {
    ...env,
    [key]: env[key] ? `${bin}${delimiter}${env[key]}` : bin,
    VIRTUAL_ENV: workspacePythonDir(workspaceRoot),
  }
}

/**
 * bash 读入的设置文件与管道各段退出码的记录文件（`bashPrelude`），位于本会话临时目录：
 * 内核沙箱中工作区可写、宿主可读，观察器硬性排除 `.tmp`，两者都不进入变更清单。
 * `read` 取回记录并删除两个文件，命令以任何方式结束后都调用一次；未写入记录时返回 null。
 * shell 不提供 `prelude`（PowerShell）时返回 null，命令照原样执行。
 */
async function pipeStatusFiles(
  shell: CommandShell,
  env: Record<string, string>,
  dir: string,
): Promise<{ env: Record<string, string>; read(): Promise<number[] | null> } | null> {
  if (!shell.prelude) return null
  const base = join(dir, `qy-bash-${randomUUID()}`)
  const preludePath = `${base}.sh`
  const statusPath = `${base}.status`
  await writeFile(preludePath, shell.prelude(statusPath, env.BASH_ENV), 'utf8')
  const bashEnv = process.platform === 'win32' ? preludePath.replaceAll('\\', '/') : preludePath
  return {
    env: { ...env, BASH_ENV: bashEnv },
    async read() {
      const text = (await readFile(statusPath, 'utf8').catch(() => '')).trim()
      await Promise.all([rm(preludePath, { force: true }), rm(statusPath, { force: true })])
      const statuses = text ? text.split(/\s+/).map(Number) : []
      return statuses.length && statuses.every(Number.isInteger) ? statuses : null
    },
  }
}

/**
 * 前段写入已被后段关闭的管道时，python 在 stderr 末行写出的报错：Windows 上为 Errno 22，其他平台为 Errno 32。
 * 行尾不带文件名；打开文件失败的 Errno 22 带文件名，不会命中。
 */
const BROKEN_PIPE_LINE =
  /^(?:BrokenPipeError: \[Errno 32\] Broken pipe|OSError: \[Errno 22\] Invalid argument)$/

/**
 * 按命令最后一条管道各段的退出码确定命令的退出码与附加说明。
 *
 * pipefail 下前段失败即整条失败（`bashPrelude`），此处只处理一种例外：前段被后段提前结束
 * （`| head` 读够即退出）。这时前段的退出码有三种：被 SIGPIPE 终止的 MSYS 与 POSIX 工具为 141；
 * python 退出时刷新 stdout 失败为 120；python 写入时出错为 1，stderr 末行是写入已关闭管道的报错。
 * 最后一段为 0、前段只有这几种退出码时不计为失败，说明中写明 bash 仍按失败处理该管道：
 * 其后以 `&&` 连接的命令没有执行。
 *
 * 其余情况按 pipefail 的结果报告，并列出各段退出码：`crash.py | tail -3` 中 tail 成功、crash.py 失败，
 * 模型据此知道失败的是哪一段。命令的退出码不等于这条管道的 pipefail 结果时（其后还有 `exit 7` 等），
 * 退出码不来自这条管道，按原退出码报告，不附加说明。
 */
function pipelineExit(
  exitCode: number,
  statuses: readonly number[] | null,
  stderr: string,
): { exitCode: number; note: string } {
  if (exitCode === 0 || !statuses || statuses.length < 2) return { exitCode, note: '' }
  if ((statuses.findLast((s) => s !== 0) ?? 0) !== exitCode) return { exitCode, note: '' }
  const lastLine = stderr.trimEnd().split('\n').at(-1)?.trim() ?? ''
  const cutShort = (s: number) =>
    s === 0 || s === 141 || s === 120 || (s === 1 && BROKEN_PIPE_LINE.test(lastLine))
  const segments = statuses.join('、')
  if (statuses.at(-1) === 0 && statuses.slice(0, -1).every(cutShort)) {
    return {
      exitCode: 0,
      note:
        `。注意：管道前段在后段提前结束（如 head 读够即退出）后被中止（各段退出码依次为 ${segments}），不计为失败；` +
        'bash 仍按失败处理这条管道，其后以 && 连接的命令没有执行。',
    }
  }
  return { exitCode, note: `（管道各段退出码依次为 ${segments}）` }
}

/**
 * 子进程的临时目录，即本会话的临时目录（`conversationTempDir`）。
 *
 * 观察器硬性排除 `.tmp`，因此其中的缓存与中间产物不进入变更清单。
 * 必须排在 `scrubEnv` 之后：这三个变量原本就在环境中，不覆盖时仍指向系统临时目录。
 */
async function tmpEnv(dir: string): Promise<Record<string, string>> {
  await mkdir(dir, { recursive: true })
  return { TMP: dir, TEMP: dir, TMPDIR: dir }
}

/**
 * 本次调用实际被强制终止前的毫秒数。
 *
 * 导出是因为裁决层需要使用同一个值。超时到达时无条件终止进程树，且完成判据是进程退出、
 * 而不是管道 EOF（见 `collectProcess`），因此「命令是否会一直挂起」在本工具中有确定的答案。
 * 裁决层得不到这个值时只能按命令文本判定，会把带 3 秒超时的
 * `python -m http.server` 当作不会自行退出的服务器而拒绝。
 *
 * 两处各算一次必然出现偏差，结果是裁决时声明的值与实际生效的值不一致，
 * 这比不提供该值更糟。
 */
export function resolveCommandTimeout(timeoutMs: unknown): number {
  return Math.min(MAX_TIMEOUT_MS, Math.max(1000, Number(timeoutMs ?? DEFAULT_TIMEOUT_MS)))
}

/**
 * `run_command` 的规格。语法提示由传入的 shell 决定，且位于描述的第一句。
 *
 * 写成工厂而不是常量，是因为执行所用的 shell 是一种能力状态（`commandShell()`
 * 三选一或返回 null）：没有 shell 时不应创建此 spec，注册处直接跳过。
 * 参数是 shell 对象本身，而不是在此处重新获取：重新获取会形成两本账，
 * 偏差的结果是说明中的 shell 与实际执行的 shell 不一致。
 *
 * 语法提示位于第一句，bash 也不例外：`run_command` 这个名称不携带语法，模型的默认输出是
 * bash，因此语法信息只能来自描述；放在第三句即失去作用（前两句先说明「执行一条 shell
 * 命令」「用于构建、测试、包管理」，模型读到第三句时已按默认语法生成命令）。
 *
 * 不写成「仅非 bash 时前置」：那是一条按语法分叉的排版规则，分叉的风险是某一档
 * 遗漏前置，且只在对应的机器上才能发现。三档共用同一份排版。
 *
 * `background` 为真时规格带 `background` 参数与后台命令的说明，装配方据此与 `CommandPort`
 * 同时提供：没有端口时该参数无法兑现。
 */
export function makeShellTool(shell: CommandShell, opts: { background?: boolean } = {}): ToolSpec {
  return {
    name: 'run_command',
    description:
      `${shell.hint}` +
      // 这一句放在此处而不是三档 hint 中：它与 shell 种类无关，
      // 三档各写一遍必然出现偏差。bash 直接执行 `.ps1`、PowerShell 直接执行 `.sh`、
      // 两者直接执行 `.py`，都会失败并报告命令未找到。
      '执行其他解释器的脚本需显式调用对应解释器。' +
      '在工作区中执行一条命令并返回 stdout/stderr 与退出码。' +
      '用于构建、测试、包管理、git 等操作。命令会流式回传输出。' +
      (opts.background
        ? '未指定 background 时等待命令结束；等待期间用户发来消息时，命令转入后台继续运行，本次结果给出任务编号与已产生的输出。' +
          '后台命令结束时结果作为回执消息送达；用 background_command 按任务编号读取至今的输出、等待命令结束或停止命令。'
        : '') +
      '读取文件用 read_file，查找文件用 glob/grep：二者更快且更节省上下文，不要用 cat/find/grep 代替。' +
      // 输出限长已由本工具完成，这一句用于消除模型自行追加 `| tail` 的理由：
      // 这类命令要等输入 EOF，而后台进程持有管道时 EOF 永不到达，
      // 顶层 shell 随之不退出，整条命令挂起直至超时，且无法取得任何输出。
      '输出会自动限长，超出部分保存到磁盘并在结果中给出 resource id（用 read_resource 取回），' +
      '因此不要为限长在末尾追加 `| tail` / `| head`：这类命令需读到 EOF 才输出，' +
      '而命令派生的后台进程会持续持有管道，EOF 不到达则命令挂起至超时，且没有任何输出返回。' +
      // 固定时长的 `sleep` 不感知任务是否完成：`sleep 580; ls …` 在任务一分钟内完成时仍阻塞 580 秒。
      // 带退出条件的循环在任务结束时返回。
      '等待后台任务时不要 sleep 固定的长时间，用带退出条件的循环' +
      '（如 `for i in $(seq 60); do [ -f 完成标志 ] && break; sleep 10; done`），任务结束即返回。' +
      (opts.background
        ? '等待本工具转入后台的命令时优先用 background_command 的 wait_seconds，命令结束即返回。'
        : ''),
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的完整命令' },
        cwd: { type: 'string', description: '工作目录（工作区相对路径），默认工作区根' },
        timeout_ms: {
          type: 'integer',
          description:
            `无输出时限（毫秒），默认 ${DEFAULT_TIMEOUT_MS}，上限 ${MAX_TIMEOUT_MS}，超过按上限执行。` +
            '命令连续这么久没有输出时检查它的进程树：仍在占用 CPU 或读写磁盘就继续等待，' +
            '都没有才判定为停滞并终止。不限总时长',
        },
        probe_url: {
          type: 'string',
          description:
            '要验证的本机地址（只接受 localhost / 127.x / ::1，端口任意）。' +
            '提供该参数时，执行流程变为「启动服务 → 等待就绪 → 获取一次响应 → 关闭」：' +
            '命令无需自行退出，探测成功即停止。用于验证 dev server、静态服务器能否启动、页面能否打开。',
        },
        ...(opts.background
          ? {
              background: {
                type: 'boolean',
                description:
                  '为 true 时命令启动后立即返回任务编号，命令在后台继续运行。' +
                  '用于开发服务器、监听进程等不自行退出的命令，以及之后再查看结果的长时间命令。' +
                  '后台命令不按 timeout_ms 判定停滞。不能与 probe_url 同时使用',
              },
            }
          : {}),
      },
      required: ['command'],
      additionalProperties: false,
    },
    actionKind: 'run',
    objectLabel: '命令',
    category: 'code',
    facet: '执行',
    summary: '在工作区中执行一条命令',
    targetExtractor: (a) => (typeof a.command === 'string' ? a.command : null),
    permissionEffect: 'execute',
    commandLine: (a) => String(a.command ?? ''),
    // 不并行执行：命令之间的顺序几乎总是携带意图（先安装依赖再构建）。
    parallelSafe: false,
    async fn(args, ctx) {
      const command = String(args.command ?? '').trim()
      if (!command) return { status: 'failure', executed: false, message: '命令为空' }

      const cwd = await resolveInWorkspace(writableRoots(rootsOf(ctx)), String(args.cwd ?? '.'), {
        mustExist: true,
        param: 'cwd',
      })
      const timeout = resolveCommandTimeout(args.timeout_ms)

      /*
       * 探测地址只允许回环地址，无法确定时按未提供处理。
       *
       * 这是本仓库第二条能发起出站请求的路径；第一条 `web_fetch` 有意拒绝本机地址
       * （见 `net-safety.ts` 文件头：127.0.0.1 上可能运行 qy 自身的 API）。
       * 此处方向相反、边界也相反：只允许回环地址，其余一律拒绝。
       * 任何放宽都会使它成为绕开 SSRF 防护的第二条网络访问通道。
       */
      const probeRaw = typeof args.probe_url === 'string' ? args.probe_url.trim() : ''
      let probeUrl: URL | null = null
      if (probeRaw) {
        const checked = loopbackTarget(probeRaw)
        if (!checked.ok)
          return {
            status: 'failure',
            executed: false,
            message: checked.why,
            errorKind: 'bad_request',
          }
        probeUrl = checked.url
      }

      // 没有端口时规格中不含 `background`，参数即使出现也按前台执行。转入后台之后的文件改动归属本次调用的 step，
      // 没有 step id（直接构造 ToolContext 的测试夹具）时同样只能前台执行。
      const owner =
        ctx.commands && ctx.stepId !== undefined ? { port: ctx.commands, stepId: ctx.stepId } : null
      const background = owner !== null && args.background === true
      if (background && probeUrl !== null) {
        return {
          status: 'failure',
          executed: false,
          message: 'background 与 probe_url 不能同时使用：probe_url 在获取一次响应后结束命令',
          errorKind: 'bad_request',
        }
      }

      // 缺少 secrets 时按空集合处理：含义是没有已知凭证，而不是无需剥离。
      const secrets = ctx.secrets ?? { values: [] }

      /*
       * 沙箱策略与路径层使用同一份根目录清单。
       *
       * 两处分别计算时，若一条 `additionalDirectories` 只接入路径层，结果是
       * 工具参数被放行而内核拒绝，模型收到一条 EACCES，
       * 会把它当作文件权限问题并尝试 chmod。反之只接入沙箱层时，
       * 参数在工具层被拒绝，而内核实际允许。
       * 两种情况都表现为配置不生效，且错误信息彼此无关。
       */
      const policy: SandboxPolicy = {
        workspaceRoot: ctx.workspaceRoot,
        ...(ctx.additionalDirectories?.length ? { writableRoots: ctx.additionalDirectories } : {}),
        readOnlySubdirs: PROTECTED_DIRS,
        ...(ctx.denyNetwork ? { denyNetwork: true } : {}),
      }

      const env = await commandEnv(ctx)
      const pipe = await pipeStatusFiles(
        shell,
        env,
        conversationTempDir(ctx.workspaceRoot, ctx.conversationId),
      )

      // 命令修改了哪些文件由工作区观察器提供：shell 没有精确明细，路径与变更类型是能取得的全部信息。
      // 必须先打开观察窗口再启动进程：窗口起点之前写入的文件无法判定为本命令新建。
      const reported = turnReported(ctx.state)
      const changeWindow = openChangeWindow(ctx.workspaceRoot, { reported })
      const closeWindow = async () => {
        const observed = await changeWindow.close()
        trackReported(reported, observed.changes)
        return observed
      }

      // spawn 抛错时关闭观察窗口：不关闭则它始终排在最前，此后的窗口收不到任何事件。
      const { proc, sandbox } = await spawnGuarded({
        shell,
        command,
        cwd,
        policy,
        env: pipe?.env ?? env,
      }).catch(async (e: unknown) => {
        await changeWindow.close()
        await pipe?.read()
        throw e
      })

      // 每条流使用一个脱敏器：脱敏器各自持有跨分片缓冲，共用会把两条流的末尾混在一起。
      const redactors = {
        stdout: createStreamRedactor(secrets),
        stderr: createStreamRedactor(secrets),
      }
      /*
       * 命令的中止信号。前台等待期间随本轮的停止而中止（结束进程树）；转入后台之后与本轮解除关联，
       * 只由任务表中止。不要把 `ctx.signal` 直接交给 `collectProcess`：那样本轮停止时后台命令也被结束。
       */
      const halt = new AbortController()
      const haltWithRun = () => halt.abort()
      ctx.signal.addEventListener('abort', haltWithRun, { once: true })
      // 转入后台之后：输出不再回传到本次调用的工具卡，也不再按停滞终止。
      let detached = false
      // 至今的输出（已脱敏），每条流只保留最近的一段；转入后台时随结果交出，之后按任务编号读取。
      const recent = { stdout: new RecentOutput(), stderr: new RecentOutput() }
      const keptOutput = () => ({
        stdout: recent.stdout.text(),
        stderr: recent.stderr.text(),
        dropped: { stdout: recent.stdout.dropped, stderr: recent.stderr.dropped },
      })
      // 回传发生在脱敏之后：先回传再脱敏等于先发出明文再补救。转入后台之后返回空串：
      // `collectProcess` 不再累加第二份，读取与回执使用 `recent`。
      const emit = (channel: 'stdout' | 'stderr', text: string): string => {
        if (!text) return text
        recent[channel].push(text)
        if (detached) return ''
        ctx.emit(channel, text)
        return text
      }

      // 等待与收尾的规则集中在 `collectProcess` 中：完成判据是进程退出而不是管道 EOF，
      // 超时与中断都终止进程树。此处只负责把字节转换为结果。
      //
      // 判据是「停滞」而不是「运行太久」：按总时长判定时，一条仍在逐页处理的长任务与一条停滞的
      // 命令在 600 秒时被同样终止，已完成的输出随之丢失（实测一套 25 页 PPT 的重建需要
      // 15–20 分钟，模型连续四次在 600 秒被终止后改为放到后台轮询，又重复启动一份）。
      // 没有输出满 `timeout` 时检查进程树是否仍在占用 CPU 或读写磁盘，都没有才终止。不设总时长：
      // 仍在工作的命令没有理由被终止，持续输出却不会结束的命令由用户停止。
      // 后台命令（服务进程、监听进程）长时间无输出是常态：转入后台之后不按停滞终止，
      // 检查进程树期间转入后台的同样不终止。
      const collecting = collectProcess(proc, {
        idleMs: timeout,
        busy: async () => detached || (await treeBusy(proc.pid)) || detached,
        signal: halt.signal,
        onText: (channel, text) => emit(channel, redactors[channel].push(text)),
        // 不调用 flush 会静默丢弃输出末尾，这比泄露更难发现，因为无人逐字节核对。
        onEnd: (channel) => emit(channel, redactors[channel].flush()),
      })

      if (probeUrl !== null) {
        const probe = await probeThenKill(probeUrl, proc, timeout, ctx.signal)
        const got = await collecting
        ctx.signal.removeEventListener('abort', haltWithRun)
        await pipe?.read()
        const watched = await closeWindow()
        const delivered = deliverStreams(ctx, command, got.stdout, got.stderr)
        return {
          status: probe.ok ? 'success' : 'failure',
          message:
            probe.message +
            (got.backgroundHeld ? BACKGROUND_HELD : '') +
            (watched.incomplete ? WATCH_INCOMPLETE : ''),
          data: { ...probe.data, ...delivered.data },
          ...(watched.changes.length ? { fileChanges: watched.changes } : {}),
          ...(delivered.resources.length ? { resources: delivered.resources } : {}),
          ...(probe.ok ? {} : { errorKind: 'probe_failed' as const }),
        }
      }

      /*
       * 等待在三种情况下结束：命令退出；`background` 为真（不等待）；等待期间本会话收到用户的
       * 「调整方向」消息。后两种命令继续运行，句柄交给任务表，本次结果写明任务编号与已产生的输出。
       */
      const handOff = owner !== null && (background || (await steeredFirst(owner.port, collecting)))
      if (owner !== null && handOff) {
        ctx.signal.removeEventListener('abort', haltWithRun)
        detached = true
        // 观察窗口转为后台观察：至今的改动随本次结果交出，之后的改动在命令结束时追加到本次调用的 step。
        // 不要改为关闭窗口：关闭后转入后台之后的改动不进入任何清单。后台观察不占用队列，之后打开的窗口照常收到事件。
        const { observed: watched, background: lateWindow } = await changeWindow.detach()
        trackReported(reported, watched.changes)
        const id = owner.port.adopt({
          command,
          stepId: owner.stepId,
          output: keptOutput,
          stop: () => halt.abort(),
          settled: collecting.then(async (got) => {
            const late = await lateWindow.close()
            trackReported(reported, late.changes)
            const statuses = (await pipe?.read()) ?? null
            if (halt.signal.aborted) return { receipt: null, fileChanges: late.changes }
            // `got` 只含转入后台之前的输出，判定与回执使用保留的那份：`pipelineExit` 与 `sandboxHint` 读取 stderr 的末尾。
            const out = keptOutput()
            const kept = { ...got, stdout: out.stdout, stderr: out.stderr }
            const summary = settledSummary(kept, statuses, sandbox.active, timeout, args.timeout_ms)
            const notes = droppedNote(out.dropped) + (late.incomplete ? WATCH_INCOMPLETE : '')
            return {
              receipt: receiptBody(ctx, command, summary.message + notes, kept),
              fileChanges: late.changes,
            }
          }),
        })
        const now = keptOutput()
        const delivered = deliverStreams(ctx, command, now.stdout, now.stderr)
        return {
          status: 'success',
          message:
            (background ? '命令已在后台启动' : '等待期间用户发来消息，命令转入后台继续运行') +
            `，任务编号 ${id}；结束时结果作为回执消息送达，已产生的输出见 stdout / stderr` +
            droppedNote(now.dropped) +
            (watched.incomplete ? WATCH_INCOMPLETE : ''),
          data: { taskId: id, ...delivered.data },
          ...(watched.changes.length ? { fileChanges: watched.changes } : {}),
          ...(delivered.resources.length ? { resources: delivered.resources } : {}),
        }
      }

      // 前台等待期间保持与本轮停止的关联，命令退出之后才解除。
      const got = await collecting
      ctx.signal.removeEventListener('abort', haltWithRun)
      const statuses = (await pipe?.read()) ?? null
      const watched = await closeWindow()
      const delivered = deliverStreams(ctx, command, got.stdout, got.stderr)
      const watchNote = watched.incomplete ? WATCH_INCOMPLETE : ''
      const summary = settledSummary(got, statuses, sandbox.active, timeout, args.timeout_ms)
      return {
        // 非零退出码是事实而不是异常：模型需要看到失败输出才能修复。
        status: summary.ok ? 'success' : 'failure',
        message: summary.message + watchNote,
        data: got.timedOut
          ? { ...delivered.data, timedOut: true }
          : { exitCode: summary.exitCode, ...delivered.data },
        ...(watched.changes.length ? { fileChanges: watched.changes } : {}),
        ...(delivered.resources.length ? { resources: delivered.resources } : {}),
        ...(got.timedOut ? { errorKind: 'timeout' } : {}),
      }
    },
  }
}

/**
 * 前台等待：命令退出时兑现为 false；等待期间本会话收到用户的「调整方向」消息时兑现为 true。
 *
 * `steered` 只因本函数的中止而拒绝；其他原因的拒绝同样按 false 处理，即继续等待命令退出，
 * 命令不因端口故障失去持有方。
 */
async function steeredFirst(port: CommandPort, collecting: Promise<unknown>): Promise<boolean> {
  const done = new AbortController()
  try {
    return await Promise.race([
      collecting.then(() => false),
      port.steered(done.signal).then(
        () => true,
        () => false,
      ),
    ])
  } finally {
    done.abort()
  }
}

/**
 * 命令结束后的判定与说明：前台结果与后台回执共用。观察范围与输出丢弃的说明不在此处，由两处各自附加。
 * `requestedTimeout` 是调用参数中的 `timeout_ms` 原值。
 */
function settledSummary(
  got: CollectedProcess,
  statuses: readonly number[] | null,
  sandboxActive: boolean,
  timeout: number,
  requestedTimeout: unknown,
): { ok: boolean; message: string; exitCode: number } {
  const held = got.backgroundHeld ? BACKGROUND_HELD : ''
  if (got.timedOut) {
    // 请求的时限超过上限时必须说明：实测模型传 2400000 后在 600 秒被终止，
    // 不说明时它无从得知是上限所致，会按「命令出错」处理。
    const requested = Number(requestedTimeout)
    const capped =
      requested > MAX_TIMEOUT_MS
        ? `；请求的 ${requested}ms 超过上限，按 ${MAX_TIMEOUT_MS}ms 执行`
        : ''
    return {
      ok: false,
      exitCode: got.exitCode,
      message:
        `命令连续 ${timeout / 1000} 秒没有输出，检查时它的进程树也没有占用 CPU、没有读写磁盘，` +
        `判定为停滞，已终止${capped}。常见原因：等待输入、等待网络、后台进程未结束${held}`,
    }
  }
  const exit = pipelineExit(got.exitCode, statuses, got.stderr)
  return {
    ok: exit.exitCode === 0,
    exitCode: exit.exitCode,
    message:
      (exit.exitCode === 0
        ? `命令执行成功${exit.note}`
        : `命令退出码 ${exit.exitCode}${exit.note}${sandboxHint(sandboxActive, got.stderr)}`) +
      held,
  }
}

/**
 * 后台命令结束时的回执正文：判定说明、命令原文与两条输出流的摘录。
 *
 * 摘录尺寸与前台结果的默认摘录相同，超出部分写入正文库，正文中保留定位符。
 * 不计入投递额度（不调用 `recordBatchSpent`）：回执在任何一次决策之外产生，理由同 `deliverAgentOutput`。
 */
function receiptBody(
  ctx: ToolContext,
  command: string,
  summary: string,
  got: CollectedProcess,
): string {
  const encoder = new TextEncoder()
  const lines = [summary, `命令：${command}`]
  for (const [channel, text] of [
    ['stdout', got.stdout],
    ['stderr', got.stderr],
  ] as const) {
    if (!text) continue
    const landed = deliver(ctx.sink, {
      toolName: 'run_command',
      sourceType: `shell:${channel}`,
      body: encoder.encode(text),
      mimeType: 'text/plain',
      query: command,
    })
    lines.push(`${channel}：\n${landed.text}`)
  }
  return lines.join('\n')
}

/** `wait_seconds` 的上限（秒）。等待期间本轮保持运行，到达上限后由模型决定继续等待还是先做其他工作。 */
const MAX_WAIT_SECONDS = 1800

/**
 * 在本轮内等待一条后台命令结束：命令结束、用户发来「调整方向」消息、到达 `timeoutMs` 三者中最先发生的一项。
 * `signal` 中止时以中止原因拒绝。端口的 `steered` 因其他原因拒绝时继续等待其余两项。
 */
async function endedFirst(
  port: CommandPort,
  ended: Promise<boolean>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<'receipt' | 'stopped' | 'message' | 'timeout'> {
  signal.throwIfAborted()
  const done = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort = () => {}
  try {
    return await Promise.race([
      ended.then((receipt) => (receipt ? ('receipt' as const) : ('stopped' as const))),
      port.steered(done.signal).then(
        () => 'message' as const,
        () => new Promise<never>(() => {}),
      ),
      new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs)
      }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason)
        signal.addEventListener('abort', onAbort, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    done.abort()
  }
}

/**
 * 读取、等待或停止本会话的一条后台命令。
 *
 * 只经由端口访问本会话的任务表：其他会话的后台命令不可见，无法读取或停止。
 * 读取到的是至今保留的输出（每条流最近的一段），经过与 `run_command` 相同的投递限制。
 * 等待只报告命令已结束，不返回回执内容：回执只经由队列送达，工具结果中再写一份时模型会收到两次。
 */
export const backgroundCommandTool: ToolSpec = {
  name: 'background_command',
  description:
    '读取本会话一条后台命令至今的输出（stdout / stderr）；stop 为 true 时结束该命令的进程树，返回停止前的输出。' +
    '后台命令由 run_command 转入后台，任务编号见其结果。命令结束时结果作为回执消息送达，被停止的命令不发送回执。' +
    '本轮后续工作需要该命令的结果时，用 wait_seconds 在本轮内等待它结束；等待期间不调用模型。',
  parameters: {
    type: 'object',
    properties: {
      task_id: { type: 'string', description: 'run_command 结果中的任务编号' },
      stop: { type: 'boolean', description: '为 true 时停止该命令' },
      wait_seconds: {
        type: 'number',
        description:
          `最长等待秒数，上限 ${MAX_WAIT_SECONDS}。提供时等待该命令结束后返回，回执作为下一条消息送达；` +
          '用户发来消息或到达该秒数时返回至今的输出，命令继续运行。不能与 stop 同时使用',
      },
    },
    required: ['task_id'],
    additionalProperties: false,
  },
  actionKind: (a) => (a.stop === true ? 'edit' : 'read'),
  objectLabel: '后台命令',
  category: 'code',
  facet: '执行',
  summary: '读取、等待或停止后台命令',
  targetExtractor: (a) => (typeof a.task_id === 'string' ? a.task_id : null),
  // 只读取或停止本会话自己转入后台的命令；命令启动时已经过权限判定。
  permissionEffect: 'internal_control',
  parallelSafe: false,

  async fn(args, ctx) {
    const port = ctx.commands
    if (!port) {
      // 正常情况下不会执行到此处：没有后台命令通道时本工具不注册。
      return { status: 'failure', message: '本次执行没有后台命令通道' }
    }
    const id = idArg(args.task_id)
    const found = id ? port.output(id) : null
    if (!found) {
      const running = port.list().map((c) => `${c.id}（${c.command}）`)
      return {
        status: 'failure',
        message: `本会话没有运行中的后台命令 ${id}；运行中：${running.join('、') || '无'}`,
      }
    }
    const stopping = args.stop === true
    const wait = args.wait_seconds
    if (wait !== undefined) {
      if (stopping) {
        return {
          status: 'failure',
          executed: false,
          message: 'wait_seconds 与 stop 不能同时使用',
          errorKind: 'bad_request',
        }
      }
      if (typeof wait !== 'number' || !Number.isFinite(wait) || wait <= 0) {
        return {
          status: 'failure',
          executed: false,
          message: 'wait_seconds 必须是正数',
          errorKind: 'bad_request',
        }
      }
    }
    let state = '仍在运行，输出为至今的内容'
    let latest = found
    if (typeof wait === 'number') {
      const seconds = Math.min(wait, MAX_WAIT_SECONDS)
      const ended = port.ended(id)
      const result = ended ? await endedFirst(port, ended, seconds * 1000, ctx.signal) : 'receipt'
      if (result === 'receipt') {
        return {
          status: 'success',
          message: `后台命令 ${id} 已结束，结果见下一条回执消息`,
          data: { taskId: id },
        }
      }
      if (result === 'stopped') {
        return {
          status: 'success',
          message: `后台命令 ${id} 已被停止，没有回执`,
          data: { taskId: id },
        }
      }
      latest = port.output(id) ?? found
      state =
        result === 'message'
          ? '仍在运行，用户发来消息，内容见下一条消息；输出为至今的内容'
          : `在等待的 ${seconds} 秒内没有结束，仍在运行，输出为至今的内容`
    }
    if (stopping) port.stop(id)
    const delivered = deliverStreams(ctx, latest.command, latest.stdout, latest.stderr)
    return {
      status: 'success',
      message:
        (stopping
          ? `已停止后台命令 ${id}（${found.command}），输出为停止前的内容`
          : `后台命令 ${id}（${found.command}）${state}`) + droppedNote(latest.dropped),
      data: { taskId: id, ...delivered.data },
      ...(delivered.resources.length ? { resources: delivered.resources } : {}),
    }
  },
}

/**
 * 为沙箱造成的失败附加明确说明。
 *
 * 内核拒绝写入时报错为 `Read-only file system` / `EROFS` / `Permission denied`，
 * 模型看到这些会尝试 `chmod`、`sudo`，或换用另一个同样位于工作区外的路径，
 * 连续重试多轮，而每一次尝试都会被同一道边界拒绝。
 *
 * 这是「沙箱是否生效」这一事实唯一的消费方：不附加说明时，
 * 边界确实生效，但代价是一轮无意义的重试。只在失败且沙箱确实生效时附加，
 * 否则每条成功命令的结果都会带上一段与它无关的文字。
 */
function sandboxHint(active: boolean, stderr: string): string {
  if (!active) return ''
  if (!/read-only file system|EROFS|permission denied|EACCES/i.test(stderr)) return ''
  return (
    '。注意：shell 命令运行在内核沙箱中：工作区（及显式配置的额外目录）之外只读，' +
    '凭证目录不可见。这不是文件权限问题，chmod / sudo 无法解除。' +
    '如需写入工作区外的路径，请说明用途，由用户将该目录加入 additionalDirectories。'
  )
}

/**
 * 默认放行的环境变量名。
 *
 * `SSH_AUTH_SOCK` 命中变量名规则（含 `AUTH`）会被剥离，剥离后 `git push` 直接失败。
 * 这是极常见的操作，一旦失败，用户会倾向于关闭整套剥离机制。
 *
 * 从威胁模型看放行它也成立：它是套接字路径，不是可外泄的明文。
 * 把它发给他人没有任何用途，风险只在本机滥用，而本机滥用的前提是
 * 命令能够运行，这由裁决层负责，不由脱敏层负责。
 *
 * 脱敏层防范的是离开本机的泄露，按此标准 `SSH_AUTH_SOCK` 不在范围内。
 */
export const DEFAULT_ENV_ALLOW = ['SSH_AUTH_SOCK']

/** 使常见 CLI 不输出进度条、不启用分页器、不发起交互询问。 */
const NON_INTERACTIVE_ENV: Record<string, string> = {
  CI: '1',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_TERMINAL_PROMPT: '0',
  NO_COLOR: '1',
  TERM: 'dumb',
  npm_config_yes: 'true',
  DEBIAN_FRONTEND: 'noninteractive',
  /*
   * python 的 stdout 编码。
   *
   * 不设置时 Windows 上按系统代码页编码（实测本机为 GBK），模型编写的脚本中
   * 一个 `✓` 就会抛出 `UnicodeEncodeError` 使整条命令失败，该步骤的产出全部丢失，
   * 而不只是显示异常。此项只影响 python 写入 stdout 的编码，不涉及 argv 语义。
   *
   * 不要额外设置 `LC_ALL=C.UTF-8`：它改变的是 MSYS 把 argv 转给原生程序时使用的字符集，
   * 设为 UTF-8 会使 `cmd /c type 中文.txt` 这类调用收到原生程序无法解析的字节。
   */
  PYTHONIOENCODING: 'utf-8',
  /*
   * python 的 UTF-8 模式：`open()` 未指定 encoding 时按 UTF-8 读写。
   *
   * 不设置时 Windows 上按系统代码页读取（实测本机为 GBK），模型脚本中常见的 `json.load(open(p))`
   * 读取 UTF-8 文件即抛出 `UnicodeDecodeError: 'gbk' codec`；`PYTHONIOENCODING` 只作用于 stdout，不作用于文件。
   * 放在这里而不是 `withWorkspacePython`：auto 与完全访问两种模式都需要，Office worker 经 `commandEnv` 同样取得。
   */
  PYTHONUTF8: '1',
  /*
   * python 输出不缓冲。
   *
   * stdout 接到管道时 python 按 8 KB 整块输出：逐页打印进度的脚本运行十分钟也可能一个字节都
   * 没有送出，`timeout_ms` 按无输出判定，会把它当作停滞终止。界面上的流式输出也因此停在原处。
   */
  PYTHONUNBUFFERED: '1',
}

/**
 * 把两条输出流交给投递入口。
 *
 * 不能只用 `clamp()`（超长时丢弃中间部分）：命令输出不可重放，
 * 一次 `npm test` 的失败详情丢失后无法恢复，模型只能凭首尾推测，
 * 或请用户重新运行。
 *
 * 超出预算的部分写入正文库，模型取得 resource id 后可以用 `read_resource`
 * 读取中间部分。stdout 和 stderr 分别落盘：合并后会丢失
 * 「某一行是错误输出还是正常输出」这一信息，而它是排查时最关键的区分。
 */
function deliverStreams(
  ctx: ToolContext,
  command: string,
  out: string,
  err: string,
): { data: Record<string, unknown>; resources: IntermediateResourceRef[] } {
  const encoder = new TextEncoder()
  const resources: IntermediateResourceRef[] = []
  const data: Record<string, unknown> = {}

  for (const [channel, text] of [
    ['stdout', out],
    ['stderr', err],
  ] as const) {
    if (!text) {
      data[channel] = ''
      continue
    }
    const landed = deliver(ctx.sink, {
      toolName: 'run_command',
      sourceType: `shell:${channel}`,
      body: encoder.encode(text),
      mimeType: 'text/plain',
      query: command,
      budget: excerptBytes(ctx),
    })

    // 摘录计入本次决策的额度：`deliver` 已把它限制在 8 KB 与剩余额度之内，一次决策中多次执行合计仍为一笔。
    // 必须使用 `recordBatchSpent` 而不是 `chargeBatchBudget`：命令已执行、摘录已投递，
    // 超额时后者不累加，同一决策中其余读取工具会按不存在的余额准入。
    recordBatchSpent(ctx, deliveredTokens(landed.text, ctx.density))
    data[channel] = landed.text
    // 覆盖事实必须写入 data：模型读取 message 和 data，缺少 coverage 时无法知道自己看到的是全文的多少。
    if (landed.coverage.truncated) data[`${channel}Coverage`] = landed.coverage
    if (landed.resourceId) {
      resources.push({
        resourceId: landed.resourceId as never,
        status: landed.status,
        contentHash: null,
        sizeBytes: landed.coverage.totalBytes ?? 0,
        mimeType: 'text/plain',
        coverage: landed.coverage,
      })
    }
  }

  return { data, resources }
}

/**
 * 只接受本机回环地址。
 *
 * 主机名一律不做 DNS 解析。解析等于把名称的指向交给外部决定：
 * `dev.example.com` 今天解析到 127.0.0.1、明天可能解析到公网，而是否放行在解析时
 * 才确定，等于没有边界。因此只接受字面量：`localhost`（含子域）与回环 IP。
 *
 * IP 判定复用 `classifyAddress`，不另写匹配：`::ffff:127.0.0.1` 与
 * `::ffff:7f00:1` 是同一个地址，按写法枚举总会遗漏某种写法（该函数的注释中有同一结论）。
 */
function loopbackTarget(raw: string): { ok: true; url: URL } | { ok: false; why: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { ok: false, why: `probe_url 不是合法 URL：${raw}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, why: `probe_url 只支持 http/https，收到 ${url.protocol}` }
  }
  // URL 会把 IPv6 主机放在方括号中，判定前先去除方括号。
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const named = host === 'localhost' || host.endsWith('.localhost')
  const loop = isIP(host) !== 0 && classifyAddress(host)?.reason === 'loopback'
  if (!named && !loop) {
    return {
      ok: false,
      why:
        `probe_url 只接受本机回环地址（localhost / 127.x / ::1），收到 ${host}。` +
        '访问外部地址用 web_fetch，该工具有独立的 SSRF 检查。',
    }
  }
  return { ok: true, url }
}

/** 两次探测之间的间隔：短到用户无法察觉，长到不会使刚启动的服务过载。 */
const PROBE_INTERVAL_MS = 200

/**
 * 轮询直到服务就绪，获取一次响应，然后无条件终止进程树。
 *
 * 这是一次调用内完成的操作：进程生命周期不超出本函数，探测结束即终止，因此与 `background` 互斥。
 * 「启动服务 → 检查页面能否打开」只需一次响应时使用本流程。需要服务持续运行（修改代码 → 热重载
 * → 再次查看）时由 `background` 启动：进程交给服务进程级的后台命令任务表持有（见 `CommandPort`），
 * 不随本轮或 Session 结束，由模型、用户或应用退出结束。
 *
 * 失败时也要带回进程输出。探测失败时最有用的信息通常在服务器自己的 stderr 中（端口被占用、
 * 模块缺失）。调用方收到 `ok:false` 后仍会把 out/err 拼入结果，因此此处只返回判定。
 */
async function probeThenKill(
  url: URL,
  proc: { pid: number; kill(): void },
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ ok: boolean; message: string; data: Record<string, unknown> }> {
  const deadline = Date.now() + timeoutMs
  let attempts = 0
  let lastError = ''
  try {
    while (Date.now() < deadline && !signal.aborted) {
      attempts += 1
      try {
        // 单次请求也需要上限，否则一个不响应的端口会耗尽全部等待时间。
        const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' })
        const body = await res.text().catch(() => '')
        return {
          // 状态码不参与成败判定：4xx/5xx 说明服务已启动并返回了响应，
          // 这正是需要告知模型的事实。只有无法连接时才判定失败。
          ok: true,
          message: `服务已就绪：${url.href} 返回 ${res.status}（等待约 ${attempts * PROBE_INTERVAL_MS}ms），已获取响应并关闭进程`,
          data: {
            probe: { url: url.href, status: res.status, body: clipBody(body) },
          },
        }
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
      }
      await Bun.sleep(PROBE_INTERVAL_MS)
    }
    return {
      ok: false,
      message:
        `${timeoutMs}ms 内未能连接 ${url.href}（最后一次：${lastError || '无响应'}）。` +
        '进程输出附在下方，端口被占用、依赖缺失等原因通常记录在其中。',
      data: { probe: { url: url.href, status: null, attempts } },
    }
  } finally {
    // 无论成败都终止全部进程：本工具保证进程不超出本次调用。
    killTree(proc)
  }
}

/** 探测响应只保留开头部分。需要全文时由模型调用 web_fetch，该工具支持分页与落盘。 */
function clipBody(body: string): string {
  const LIMIT = 2000
  return body.length <= LIMIT ? body : `${body.slice(0, LIMIT)}…（剩余 ${body.length - LIMIT} 字）`
}
