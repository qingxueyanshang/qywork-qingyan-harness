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
 * 4. 硬性超时与输出上限，防止耗尽内存与上下文。
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

import { mkdir } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { deliveredTokens, recordBatchSpent, type ToolContext, type ToolSpec } from '@qywork/agent'
import type { FileChange, IntermediateResourceRef } from '@qywork/core'
import { classifyAddress } from './net-safety.ts'
import { PROTECTED_DIRS, resolveInWorkspace, rootsOf, writableRoots } from './paths.ts'
import {
  type CommandShell,
  collectProcess,
  killTree,
  type SandboxPolicy,
  spawnGuarded,
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
  ctx: Pick<ToolContext, 'secrets' | 'envAllowList' | 'workspaceRoot'>,
): Promise<Record<string, string>> {
  return {
    ...scrubEnv(process.env, ctx.secrets ?? { values: [] }, {
      allow: ctx.envAllowList ?? DEFAULT_ENV_ALLOW,
    }),
    ...NON_INTERACTIVE_ENV,
    ...(await tmpEnv(ctx.workspaceRoot)),
  }
}

/**
 * 子进程的临时目录，即工作区根下的 `.tmp`。
 *
 * 观察器硬性排除此目录，因此模型写入其中的缓存、中间产物、浏览器 profile 不进入变更清单。
 * 必须排在 `scrubEnv` 之后：这三个变量原本就在环境中，不覆盖时仍指向系统临时目录。
 */
async function tmpEnv(workspaceRoot: string): Promise<Record<string, string>> {
  const dir = join(workspaceRoot, '.tmp')
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
 */
export function makeShellTool(shell: CommandShell): ToolSpec {
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
      '读取文件用 read_file，查找文件用 glob/grep：二者更快且更节省上下文，不要用 cat/find/grep 代替。' +
      // 输出限长已由本工具完成，这一句用于消除模型自行追加 `| tail` 的理由：
      // 这类命令要等输入 EOF，而后台进程持有管道时 EOF 永不到达，
      // 顶层 shell 随之不退出，整条命令挂起直至超时，且无法取得任何输出。
      '输出会自动限长，超出部分保存到磁盘并在结果中给出 resource id（用 read_resource 取回），' +
      '因此不要为限长在末尾追加 `| tail` / `| head`：这类命令需读到 EOF 才输出，' +
      '而命令派生的后台进程会持续持有管道，EOF 不到达则命令挂起至超时，且没有任何输出返回。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的完整命令' },
        cwd: { type: 'string', description: '工作目录（工作区相对路径），默认工作区根' },
        timeout_ms: {
          type: 'integer',
          description: `超时时间（毫秒），默认 ${DEFAULT_TIMEOUT_MS}`,
        },
        probe_url: {
          type: 'string',
          description:
            '要验证的本机地址（只接受 localhost / 127.x / ::1，端口任意）。' +
            '提供该参数时，执行流程变为「启动服务 → 等待就绪 → 获取一次响应 → 关闭」：' +
            '命令无需自行退出，探测成功即停止。用于验证 dev server、静态服务器能否启动、页面能否打开。',
        },
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
    // 不并行执行：命令之间的顺序几乎总是携带意图（先安装依赖再构建）。
    parallelSafe: false,
    async fn(args, ctx) {
      const command = String(args.command ?? '').trim()
      if (!command) return { status: 'failure', executed: false, message: '命令为空' }

      const cwd = await resolveInWorkspace(writableRoots(rootsOf(ctx)), String(args.cwd ?? '.'), {
        mustExist: true,
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
      const { proc, sandbox } = await spawnGuarded({ shell, command, cwd, policy, env }).catch(
        async (e: unknown) => {
          await changeWindow.close()
          throw e
        },
      )

      // 每条流使用一个脱敏器：脱敏器各自持有跨分片缓冲，共用会把两条流的末尾混在一起。
      const redactors = {
        stdout: createStreamRedactor(secrets),
        stderr: createStreamRedactor(secrets),
      }
      // 回传发生在脱敏之后：先回传再脱敏等于先发出明文再补救。
      const emit = (channel: 'stdout' | 'stderr', text: string): string => {
        if (text) ctx.emit(channel, text)
        return text
      }

      // 等待与收尾的规则集中在 `collectProcess` 中：完成判据是进程退出而不是管道 EOF，
      // 超时与中断都终止进程树。此处只负责把字节转换为结果。
      const collecting = collectProcess(proc, {
        timeoutMs: timeout,
        signal: ctx.signal,
        onText: (channel, text) => emit(channel, redactors[channel].push(text)),
        // 不调用 flush 会静默丢弃输出末尾，这比泄露更难发现，因为无人逐字节核对。
        onEnd: (channel) => emit(channel, redactors[channel].flush()),
      })

      if (probeUrl !== null) {
        const probe = await probeThenKill(probeUrl, proc, timeout, ctx.signal)
        const got = await collecting
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

      const got = await collecting
      const watched = await closeWindow()
      const delivered = deliverStreams(ctx, command, got.stdout, got.stderr)
      const watchNote = watched.incomplete ? WATCH_INCOMPLETE : ''

      if (got.timedOut) {
        return {
          status: 'failure',
          message: `命令超时（${timeout}ms）已终止${got.backgroundHeld ? BACKGROUND_HELD : ''}${watchNote}`,
          data: { ...delivered.data, timedOut: true },
          ...(watched.changes.length ? { fileChanges: watched.changes } : {}),
          ...(delivered.resources.length ? { resources: delivered.resources } : {}),
          errorKind: 'timeout',
        }
      }

      return {
        // 非零退出码是事实而不是异常：模型需要看到失败输出才能修复。
        status: got.exitCode === 0 ? 'success' : 'failure',
        message:
          (got.exitCode === 0
            ? '命令执行成功'
            : `命令退出码 ${got.exitCode}${sandboxHint(sandbox.active, got.stderr)}`) +
          (got.backgroundHeld ? BACKGROUND_HELD : '') +
          watchNote,
        data: { exitCode: got.exitCode, ...delivered.data },
        ...(watched.changes.length ? { fileChanges: watched.changes } : {}),
        ...(delivered.resources.length ? { resources: delivered.resources } : {}),
      }
    },
  }
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
 * 此操作必须是原子的：`run_command` 是同步的，启动一个不会自行退出的服务器会阻塞直至超时。
 * 「启动服务 → 检查页面能否打开」是编码 agent 的常规操作，仅靠 `run_command` 无法完成；
 * 原因不是权限拦截，而是执行方式本身不支持（实测：用户开启完全访问后仍只能等到 `output_truncated`）。
 *
 * 不采用「后台运行 + 另一个工具读取输出」：那需要一张跨调用存在的进程表，而 Session
 * 每条消息创建一个（见 `server/src/run-control.ts`），进程表挂在其上时生命周期不超过这条
 * 消息；放在别处则新增一套与 run 并列的生命周期，这是 A2 默认否决的第一条。
 *
 * 因此收敛为一次调用内的原子操作：进程生命周期不超出本函数，没有 id、没有进程表、
 * 没有 dispose 依赖。代价是无法验证「修改代码 → 热重载 → 再次查看」这类交互式调试，
 * 该边界已写入工具描述。
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
