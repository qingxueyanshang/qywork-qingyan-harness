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
import { collectProcess, MAX_TIMEOUT_MS, scrubEnv } from '@qywork/tools'
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
 * 不按格式输出只是降级，不是失败：成败以退出码为准；回执信息不足时续接会话追问
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

  const narrator = createNarrator(agent)

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
    // `onText` 的返回值是实际写入结果的文本，因此必须原样返回：
    // 它是脱敏器的接入点，不是供观察者使用的。
    //
    // 解析只在此处执行一次，同一段正文交给两个消费者：实时页（`onChunk`）与回执
    // （`narrator.narration()`）。**不要在 `extract` 中再解析一次流**：否则
    // 实时页与回执是两次解析的结果，格式变化时只有一侧随之改变。
    onText: (channel: 'stdout' | 'stderr', text: string) => {
      if (channel === 'stdout') {
        const narrated = narrator.feed(text)
        if (narrated) input.onChunk?.(narrated)
      }
      return text
    },
  })
  // 末行没有换行符时会留在缓冲区中，不清空缓冲区即丢失。
  const tail = narrator.flush()
  if (tail) input.onChunk?.(tail)

  const session = agent.sessionField ? field(got.stdout, agent, agent.sessionField) : ''

  return {
    ok: got.exitCode === 0 && !got.timedOut,
    output: extract(got.stdout, agent, narrator.narration()),
    exitCode: got.exitCode,
    timedOut: got.timedOut,
    // stderr 只留尾部：CLI 的进度条可输出数万行，全部保留会超出上下文预算。
    stderr: got.stderr.length > 4000 ? got.stderr.slice(-4000) : got.stderr,
    ...(session ? { session } : {}),
  }
}

/**
 * 按点分路径从 stdout 中提取一个字符串。三种输出格式的提取方式不同：
 *
 * - `text`：没有结构可提取，返回空串（由调用方回退到整段输出）。
 * - `jsonl`：逐行 JSON，取**最后一个**非空值：agent 类 CLI 的流中最终答案总在末尾，
 *   取第一个会得到开始执行时的状态行。
 * - `json`：整段 stdout 是**一个**对象（如 grok，且缩进为多行），
 *   只能整段解析；逐行解析无法取得任何一行。
 *
 * 使用路径而不是键名，因为各厂商的字段嵌套深度不同：claude 的答案与会话 id 都在顶层，
 * codex 的答案在 `item.text`。
 */
function field(stdout: string, agent: Pick<CliAgent, 'output'>, path: string): string {
  const walk = (root: unknown): string => pick(root, path).at(-1) ?? ''
  if (agent.output === 'text') return ''
  if (agent.output === 'json') {
    try {
      return walk(JSON.parse(stdout))
    } catch {
      return ''
    }
  }
  let last = ''
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const got = walk(JSON.parse(trimmed))
      if (got) last = got
    } catch {
      // 非 JSON 行直接跳过：许多 CLI 会向 stdout 输出非结构化的横幅。
    }
  }
  return last
}

/**
 * 按点分路径取值，段尾 `[]` 表示遍历该数组。按出现顺序返回非空字符串。
 *
 * 各厂商的字段嵌套深度不同：claude 的答案与会话 id 在顶层、正文在 `message.content[].text`
 * 数组中，codex 的答案在 `item.text`。
 */
function pick(root: unknown, path: string): string[] {
  const keys = path.split('.')
  const out: string[] = []
  const walk = (value: unknown, depth: number): void => {
    if (depth === keys.length) {
      if (typeof value === 'string' && value.trim()) out.push(value)
      return
    }
    const key = keys[depth]!
    const array = key.endsWith('[]')
    const name = array ? key.slice(0, -2) : key
    const next =
      value && typeof value === 'object' ? (value as Record<string, unknown>)[name] : undefined
    if (!array) {
      walk(next, depth + 1)
      return
    }
    if (!Array.isArray(next)) return
    for (const item of next) walk(item, depth + 1)
  }
  walk(root, 0)
  return out
}

/**
 * jsonl 流的解析入口。实时页与回执共用它，正文只解析一次。
 *
 * **必须按行缓冲。** `onText` 传入的是管道分片，一行 JSON 可能被切成两个分片，
 * 逐片解析时被切开的行总是失败，而失败的恰是最长的行，即正文所在的行。
 *
 * 三种输出格式的处理：`jsonl` 且厂商表声明了 `narrate` 时按路径提取；`text` 没有结构，
 * 原样交出；`json` 要整段结束才能解析，流中无法取得正文，返回空串。
 */
function createNarrator(agent: Pick<CliAgent, 'output' | 'narrate'>) {
  const narrate = agent.output === 'jsonl' ? agent.narrate : undefined
  const parts: string[] = []
  let buffer = ''

  const take = (line: string): string => {
    if (!narrate || !line.trim()) return ''
    let parsed: unknown
    try {
      parsed = JSON.parse(line.trim())
    } catch {
      // 非 JSON 行直接跳过：许多 CLI 会向 stdout 输出非结构化的横幅。
      return ''
    }
    const pieces = pick(parsed, narrate.text)
    if (narrate.tool) pieces.push(...pick(parsed, narrate.tool).map((name) => `[工具 ${name}]`))
    if (pieces.length === 0) return ''
    const text = `${pieces.join('\n')}\n`
    parts.push(text)
    return text
  }

  return {
    /** 传入一个 stdout 分片，返回从该分片解析出的正文。 */
    feed(chunk: string): string {
      if (agent.output === 'text') return chunk
      if (!narrate) return ''
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      return lines.map(take).join('')
    },
    /** 流结束时处理缓冲区中的最后一行。 */
    flush(): string {
      const rest = buffer
      buffer = ''
      return take(rest)
    },
    /** 截至当前解析出的全部正文。`text` 与 `json` 格式恒为空串。 */
    narration: (): string => parts.join(''),
  }
}

/**
 * 从 stdout 提取交付物正文。
 *
 * jsonl 取不到 `resultField` 时使用流中解析出的正文，**不回退到整段 stdout**：
 * stream-json 中绝大多数行是计数与状态事件，整段交给模型既不是 CLI 的产出，
 * 又会一次性占满上下文窗口（实测一次被终止的派发任务留下 261,929 字符、507 行，
 * 其中 480 行是 `thinking_tokens`）。中途被终止时，正文即其已输出的内容。
 *
 * `json` 无法解析时返回空串：说明退出码非零或输出格式已变化，由调用方按失败处理。
 */
export function extract(
  stdout: string,
  agent: Pick<CliAgent, 'output' | 'resultField'>,
  narration: string,
): string {
  if (agent.output === 'text') return stdout.trim()
  const got = field(stdout, agent, agent.resultField ?? 'result')
  if (got) return got
  return agent.output === 'jsonl' ? narration.trim() : ''
}
