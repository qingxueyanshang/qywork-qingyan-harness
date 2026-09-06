/**
 * 外部 CLI 的执行器：替换参数、起进程、解析输出。
 *
 * 调什么、怎么调由 `cli-detect.ts` 的厂商表给（那里也写着表会过期的代价），
 * 这里只负责执行。
 *
 * **凭证：透传但要剥掉**本仓自己的**。** 这里与 `run_command` 不同：被调度的 CLI **需要它自己的 key
 * 才能执行** （codex 要 OPENAI_API_KEY，claude 要 ANTHROPIC_API_KEY），所以不能像 `run_command` 那
 * 样按名字一律剥掉。
 *
 * 但 qywork 自己配置里那些 key 它一把都用不上——按**值**剥掉即可：
 * 用户在 `~/.qywork/config.json` 里配的 DeepSeek key 没有任何理由出现在
 * codex 的进程里。这条剥的是「多余的凭证」，不影响后端正常工作。
 *
 * 另外，能被调起的只有厂商表里那几家、且用户在设置页允许的那几家，属于知情同意——
 * 与 MCP server 同一档。所以这里不加裁决，只做凭证收敛。
 */

import { collectProcess, MAX_TIMEOUT_MS, scrubEnv } from '@qywork/tools'
import type { CliAgent } from './types.ts'

/**
 * 追加在任务后面的输出格式约定。
 *
 * **交付物正文必须在前、回执作尾节**：`extract` 取的是最后一个非空目标字段，
 * 回执写在前面时，查询型任务的产出会变成一句状态汇报，而不是它的答案。
 *
 * 不照格式输出只是降级，不是失败：成败以退出码为准；回执信息不足时续接会话追问
 * （`runCli` 的 `resume`），该会话保留上一轮上下文。
 */
const REPORT_CONTRACT = `

## 输出格式

先输出交付物正文（任务要求的答案、结论或改动说明），再以下列小节收尾。

### 回执
- 变更文件：逐条列出路径及该文件的改动要点；无变更时写「无」
- 实现方式：一至两句
- 未完成项：无则写「无」
`

export interface CliRunResult {
  ok: boolean
  output: string
  exitCode: number
  /** 静默到点被终止。额度是 `MAX_TIMEOUT_MS`，与总时长无关。 */
  timedOut: boolean
  stderr: string
  /**
   * 该 CLI 这条会话的 id，用于续接（`runCli` 的 `resume`）。
   *
   * 只有厂商表里写了 `sessionField` 的那几家有；其余的这个键缺席，
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
     * 新建会话则会把任务重新执行一遍。
     *
     * **只有厂商表里给了 `resumeArgs` 的那几家支持，调用方先判再传。**
     */
    resume?: string
    /**
     * qywork 自己的凭证。按值剥掉——后端用不上，也就没有理由拿到。
     * 不传等于「没有已知凭证」，不等于「不用剥」。
     */
    secrets?: { values: string[] }
    /**
     * 边跑边给一块。**不给这个回调就等于跑完才有输出**——外部 CLI 是本机另一个进程，
     * 它写了什么在结束之前一个字都看不到。
     *
     * 给的是解析出来的正文与工具名，不是原始流：厂商表声明了 `narrate` 的那几家按路径取，
     * `text` 那一档原样过，`json` 那一档流里出不了正文、一片都不给。
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

  // 一律跑在工作区根下：派活给外部 CLI 是「在这个项目里干一件事」，
  // 它自己的工作目录不该由这里的配置面再开一个旋钮。
  const proc = Bun.spawn([agent.command, ...args], {
    cwd: input.workspaceRoot,
    // 关掉 stdin：被调度的 CLI 若想交互提问，这里没有人能回答，
    // 开着只会让它静默等到被终止。
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // 只按**值**剥。名字模式那条会把后端自己要用的
      // ANTHROPIC_API_KEY / OPENAI_API_KEY 一起剥掉，后端直接无法执行，
      // 所以下面把整份环境放进 allow。
      ...scrubEnv(
        process.env,
        { values: input.secrets?.values ?? [] },
        {
          // 名字模式匹配同样会误伤后端需要的 key，这里靠值匹配就够。
          allow: Object.keys(process.env),
        },
      ),
      CI: '1',
      NO_COLOR: '1',
      TERM: 'dumb',
    },
  })

  const narrator = createNarrator(agent)

  // 等待与收尾走同一个收口：完成判据是进程退出而不是管道 EOF，到点与中断都走**树杀**。
  // 被调度的 CLI 自己也在跑一个 agent，必然派生子进程；只杀它一个的话那些仍在运行，
  // 因此用户点了停止、这里却还在等一个永远不会到的 EOF。
  //
  // **判据是静默，不是总时长。** 总时长分不出「仍在执行」与「已经停止响应」，而外部 CLI
  // 在自己跑构建与测试时流本来就是停的，一次审查跑几分钟是常态。
  // 额度取本机一次工具执行的上限（`MAX_TIMEOUT_MS`）：CLI 内部一次工具执行同额。
  // 只要它还在输出就一直等，上界由用户按停止或父会话这一轮结束给。
  const got = await collectProcess(proc, {
    idleMs: MAX_TIMEOUT_MS,
    signal: input.signal,
    // `onText` 的返回值是「真正记进结果的那一段」，所以必须原样回传：
    // 它是脱敏器的挂点，不是给旁观者用的。
    //
    // 解析只在这里做一次，同一段正文给两个消费者：实时页（`onChunk`）与回执
    // （`narrator.narration()`）。**不要在 `extract` 里再解析一遍流**——那会让
    // 实时页看到的和回执里的是两次解析的结果，格式漂移时只有一侧变。
    onText: (channel: 'stdout' | 'stderr', text: string) => {
      if (channel === 'stdout') {
        const narrated = narrator.feed(text)
        if (narrated) input.onChunk?.(narrated)
      }
      return text
    },
  })
  // 末行没有换行符时留在缓冲里，不冲掉就丢了。
  const tail = narrator.flush()
  if (tail) input.onChunk?.(tail)

  const session = agent.sessionField ? field(got.stdout, agent, agent.sessionField) : ''

  return {
    ok: got.exitCode === 0 && !got.timedOut,
    output: extract(got.stdout, agent, narrator.narration()),
    exitCode: got.exitCode,
    timedOut: got.timedOut,
    // stderr 只留尾部：CLI 的进度条能刷出几万行，全留会把上下文撑爆。
    stderr: got.stderr.length > 4000 ? got.stderr.slice(-4000) : got.stderr,
    ...(session ? { session } : {}),
  }
}

/**
 * 按点分路径从 stdout 里取一个字符串。三种输出各有各的取法：
 *
 * - `text`：没有结构可取，回空串（调用方自己回退到整段）。
 * - `jsonl`：逐行 JSON，取**最后一个**非空值——agent 类 CLI 的流里最终答案总在末尾，
 *   取第一个会拿到开跑那条状态行。
 * - `json`：整段 stdout 是**一个**对象（grok 那种，而且是缩进过的多行），
 *   只能整段解析；逐行解析对它一行都取不到。
 *
 * 取路径而不是键名，是因为各家埋的深浅不同：claude 的答案与会话 id 都在顶层，
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
      // 不是 JSON 的行直接跳过：很多 CLI 会往 stdout 混入非结构化的横幅。
    }
  }
  return last
}

/**
 * 按点分路径取值，段尾 `[]` 表示遍历该数组。返回按出现顺序的非空字符串。
 *
 * 各家埋的深浅不同：claude 的答案与会话 id 在顶层、正文在 `message.content[].text`
 * 那个数组里，codex 的答案在 `item.text`。
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
 * jsonl 流的解析点。实时页与回执共用它，正文只解析一次。
 *
 * **必须按行缓冲。** `onText` 交来的是管道切片，一行 JSON 会被切成两片，
 * 逐片解析对被切开的那一行永远失败，而失败的是最长的那几行——正文所在的行。
 *
 * 三种输出各自的形态：`jsonl` 且厂商表声明了 `narrate` 的按路径取；`text` 没有结构，
 * 原样过；`json` 要整段结束才解析得出，流里出不了正文，回空串。
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
      // 不是 JSON 的行直接跳过：很多 CLI 会往 stdout 混入非结构化的横幅。
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
    /** 喂一片 stdout，返回这一片里解析出来的正文。 */
    feed(chunk: string): string {
      if (agent.output === 'text') return chunk
      if (!narrate) return ''
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      return lines.map(take).join('')
    },
    /** 流结束时冲掉缓冲里最后一行。 */
    flush(): string {
      const rest = buffer
      buffer = ''
      return take(rest)
    },
    /** 到此为止解析出的全部正文。`text` 与 `json` 两档恒为空串。 */
    narration: (): string => parts.join(''),
  }
}

/**
 * 从 stdout 提取交付物正文。
 *
 * jsonl 取不到 `resultField` 时用流里解析出的正文，**不回退整段 stdout**：
 * 一份 stream-json 里绝大多数行是计数与状态事件，整段交给模型既不是它的产出，
 * 又能一次把上下文窗口撑满（实测一次被杀的派活留下 261,929 字符、507 行，
 * 其中 480 行是 `thinking_tokens`）。被杀在半路时正文正是它已经说出口的那些话。
 *
 * `json` 解析不出时回空串：那说明退出码非零或格式漂移，由调用方按失败处理。
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
