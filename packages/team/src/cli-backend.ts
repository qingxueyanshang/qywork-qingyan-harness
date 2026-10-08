/**
 * 外部 CLI 的执行器：替换参数、启动进程、解析输出。
 *
 * 调用哪个 CLI、以何种参数调用由 `cli-detect.ts` 的厂商表决定（该文件也说明了厂商表会过期的代价），
 * 本模块只负责执行。
 *
 * **凭证：透传环境变量，但剥离本仓库自身的凭证。** 此处与 `run_command` 不同：被调度的 CLI **需要其自身的 key
 * 才能执行**（codex 需要 OPENAI_API_KEY，claude 需要 ANTHROPIC_API_KEY），因此不能像 `run_command`
 * 那样按名称一律剥离。
 *
 * qywork 自身配置中的 key 对该后端没有用处，按**值**剥离即可：
 * 用户在 `~/.qywork/config.json` 中配置的 DeepSeek key 没有理由出现在
 * codex 的进程中。剥离的是多余的凭证，不影响后端正常工作。
 *
 * 此外，可被调用的只有厂商表中列出、且用户在设置页允许的 CLI，属于知情同意，
 * 与 MCP server 同一级别。因此此处不做权限裁决，只限制凭证范围。
 */

import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  collectProcess,
  createStreamRedactor,
  MAX_TIMEOUT_MS,
  redactSecrets,
  scrubEnv,
} from '@qywork/tools'
import { createCliOutput } from './cli-output.ts'
import type { CliAgent } from './types.ts'

/** npm 的 Windows 入口经 Node 直接启动，避免 cmd.exe 重新解释多行提示词与特殊字符。 */
async function commandFor(command: string, args: string[]): Promise<string[]> {
  if (process.platform !== 'win32' || !command.toLowerCase().endsWith('.cmd')) {
    return [command, ...args]
  }
  const shim = await readFile(command, 'utf8')
  const entry = shim.match(
    /^endLocal & goto #_undefined_# 2>NUL \|\| title %COMSPEC% & "%_prog%" +"%dp0%\\(node_modules\\[^"\r\n]+)" %\*\r?$/m,
  )?.[1]
  if (!entry || !shim.includes('SET "_prog=node"')) return [command, ...args]
  const base = dirname(command)
  const localNode = join(base, 'node.exe')
  const node = (await stat(localNode).catch(() => null))?.isFile()
    ? localNode
    : Bun.which('node.exe')
  if (!node) throw new Error('该外部 CLI 需要 Node.js，请先安装 Node.js')
  return [node, join(base, entry), ...args]
}

/**
 * 追加在任务之后的输出格式约定。
 *
 * **交付物正文必须在前，回执作为最后一节**：`extract` 取的是最后一个非空目标字段，
 * 回执写在前面时，查询型任务的产出会变成一句状态汇报，而不是答案。
 *
 * 不按回执格式输出只是降级：成败结合退出码、厂商终态与有效正文；回执信息不足时续接会话追问
 * （`runCli` 的 `resume`），该会话保留上一轮上下文。
 */
const REPORT_CONTRACT = `

## 输出格式

先输出交付物正文（任务要求的答案、结论或改动说明），再以下列小节结束。

### 回执
- 变更文件：逐条列出路径及该文件的改动要点；无变更时写「无」
- 实现方式：一至两句
- 未完成项：无则写「无」
`

export interface CliRunResult {
  ok: boolean
  output: string
  exitCode: number
  /** 因静默超时被终止。时限为 `MAX_TIMEOUT_MS`，与总时长无关。 */
  timedOut: boolean
  stderr: string
  /** 已脱敏的失败原因；调度器、节点和回执共用，避免再次按 stderr 推测。 */
  error?: string
  /**
   * 该 CLI 本次会话的 id，用于续接（`runCli` 的 `resume`）。
   *
   * 只有厂商表中声明了 `sessionField` 的 CLI 提供；其余 CLI 没有该键，
   * 调用方只能新建会话。
   */
  session?: string
}

export async function runCli(
  agent: CliAgent,
  input: {
    prompt: string
    workspaceRoot: string
    signal: AbortSignal
    /**
     * 续接该 CLI 的既有会话。会话保留上一轮上下文，可直接就其产出追问；
     * 新建会话则会重新执行整个任务。
     *
     * **只有厂商表中提供了 `resumeArgs` 的 CLI 支持续接，调用方须先判断再传入。**
     */
    resume?: string
    /**
     * qywork 自身的凭证，按值剥离：后端用不到这些凭证，也就没有理由取得。
     * 不传入表示没有已知凭证，不表示无需剥离。
     */
    secrets?: { values: string[] }
    /**
     * 运行期间逐块交出输出。**不提供该回调时，执行完毕才有输出**：外部 CLI 是本机的另一个进程，
     * 其输出在结束之前无法获取。
     *
     * 交出的是解析后的正文与工具名，不是原始流：厂商表声明了 `narrate` 的 CLI 按路径提取，
     * `text` 格式原样交出，`json` 格式在流中无法解析出正文，不交出任何内容。
     */
    onChunk?: (text: string) => void
  },
): Promise<CliRunResult> {
  const template = input.resume ? (agent.resumeArgs ?? agent.args) : agent.args
  const args = template.map((a) =>
    a
      .replaceAll('{prompt}', input.prompt + REPORT_CONTRACT)
      .replaceAll('{session}', input.resume ?? ''),
  )

  // 一律在工作区根目录下运行：向外部 CLI 派发任务即在当前项目中完成一项工作，
  // 其工作目录不应在配置中另设选项。
  const proc = Bun.spawn(await commandFor(agent.command, args), {
    cwd: input.workspaceRoot,
    // 关闭 stdin：被调度的 CLI 若发起交互提问，此处无人应答，
    // 保持打开只会使其一直等待直到被终止。
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // 只按**值**剥离。按名称模式剥离会将后端自身需要的
      // ANTHROPIC_API_KEY / OPENAI_API_KEY 一并剥离，使后端无法执行，
      // 因此下方将整个环境放入 allow。
      ...scrubEnv(
        process.env,
        { values: input.secrets?.values ?? [] },
        {
          // 名称模式匹配同样会剥离后端需要的 key，此处只需按值匹配。
          allow: Object.keys(process.env),
        },
      ),
      CI: '1',
      NO_COLOR: '1',
      TERM: 'dumb',
    },
    /*
     * 非 Windows 平台上使其成为独立进程组，`collectProcess` 的进程树终止才能覆盖其派生的后代进程：不设 detached 时
     * 按其 pid 无法找到进程组，只能终止 CLI 本身。Windows 不设置：Windows 由 `taskkill /T`
     * 遍历进程树，detached 在 Windows 上表示脱离控制台。
     */
    ...(process.platform === 'win32' ? {} : { detached: true }),
  })

  const parser = createCliOutput(agent)
  const secrets = input.secrets ?? { values: [] }
  const redactors = {
    stdout: createStreamRedactor(secrets),
    stderr: createStreamRedactor(secrets),
  }
  const publish = (text: string) => {
    if (text) input.onChunk?.(redactSecrets(text, secrets))
  }

  // 等待与收尾使用同一个出口：完成判据是进程退出而不是管道 EOF，超时与中断都执行**进程树终止**。
  // 被调度的 CLI 自身也在运行 agent，必然派生子进程；只终止 CLI 本身时子进程仍在运行，
  // 用户点击停止后，此处仍会等待一个永远不会到达的 EOF。
  //
  // **判据是静默时长，不是总时长。** 总时长无法区分仍在执行与已停止响应，而外部 CLI
  // 执行构建与测试时流中没有输出，一次审查运行几分钟是常见情况。
  // 时限取本机单次工具执行的上限（`MAX_TIMEOUT_MS`），与 CLI 内部单次工具执行的时限相同。
  // 只要仍有输出就持续等待，上限由用户点击停止或父会话本轮结束决定。
  const got = await collectProcess(proc, {
    idleMs: MAX_TIMEOUT_MS,
    signal: input.signal,
    // 跨分片脱敏后才解析，实时页与回执使用同一条解析流。
    onText: (channel: 'stdout' | 'stderr', text: string) => {
      const safe = redactors[channel].push(text)
      if (channel === 'stdout') publish(parser.feed(safe))
      return safe
    },
    onEnd: (channel) => {
      const safe = redactors[channel].flush()
      if (channel === 'stdout') publish(parser.feed(safe))
      return safe
    },
  })
  // 末行没有换行符时会留在缓冲区中，不清空缓冲区即丢失。
  publish(parser.flush())
  const parsed = parser.result()
  const output = redactSecrets(parsed.output, secrets)
  const stderr = redactSecrets(got.stderr, secrets).slice(-4000)
  // 厂商给出的结构化错误优先；原始 stderr 单独保留，避免大量告警淹没原因。
  const detail = parsed.error || stderr.trim()
  const incomplete = parsed.incomplete || (!parsed.hasResult ? 'CLI 没有返回有效结果' : '')
  const error = input.signal.aborted
    ? '已停止'
    : got.timedOut
      ? `${MAX_TIMEOUT_MS / 1000} 秒无输出，已终止${detail ? `：${detail}` : ''}`
      : got.exitCode !== 0
        ? `退出码 ${got.exitCode}：${detail || (agent.output === 'text' ? output : '') || parsed.incomplete || 'CLI 未提供错误详情'}`
        : parsed.error ||
          (incomplete ? `${incomplete}${stderr.trim() ? `：${stderr.trim()}` : ''}` : '')

  return {
    ok: !error,
    output,
    exitCode: got.exitCode,
    timedOut: got.timedOut,
    // stderr 只留尾部：CLI 的进度条可输出数万行，全部保留会超出上下文预算。
    stderr,
    ...(error ? { error: redactSecrets(error, secrets).slice(0, 4000) } : {}),
    ...(parsed.session ? { session: parsed.session } : {}),
  }
}

/** 已收集输出的解析入口，复用执行期间的同一解析器。 */
export function extract(
  stdout: string,
  agent: Pick<CliAgent, 'output' | 'resultField'>,
  narration: string,
): string {
  const parser = createCliOutput(agent)
  parser.feed(stdout)
  parser.flush()
  return parser.result().output || (agent.output === 'jsonl' ? narration.trim() : '')
}
