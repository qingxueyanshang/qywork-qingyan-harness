/**
 * 外部 CLI 的执行器：替换参数、起进程、解析输出。
 *
 * 调什么、怎么调由 `cli-detect.ts` 的厂商表给（那里也写着表会过期的代价），
 * 这里只负责执行。
 *
 * ## 凭证：透传但要剥掉**我们自己的**
 *
 * 这里与 `run_command` 不同：被调度的 CLI **需要它自己的 key 才能干活**
 * （codex 要 OPENAI_API_KEY，claude 要 ANTHROPIC_API_KEY），所以不能像
 * `run_command` 那样按名字一律剥掉。
 *
 * 但 qywork 自己配置里那些 key 它一把都用不上——按**值**剥掉即可：
 * 用户在 `~/.qywork/config.json` 里配的 DeepSeek key 没有任何理由出现在
 * codex 的进程里。这条剥的是「多余的凭证」，不影响后端正常工作。
 *
 * 另外，能被调起的只有厂商表里那几家、且用户在设置页允许的那几家，属于知情同意——
 * 与 MCP server 同一档。所以这里不加裁决，只做凭证收敛。
 */

import type { FileChange } from '@qywork/core'
import { collectProcess, scrubEnv } from '@qywork/tools'
import { beginProbe, endProbe, UNMEASURABLE } from './changes.ts'
import type { CliAgent } from './types.ts'

const DEFAULT_TIMEOUT = 10 * 60 * 1000

/**
 * 追加在任务后面的输出格式约定。
 *
 * **交付物正文必须在前、回执作尾节**：`extract` 取的是最后一个非空目标字段，
 * 回执写在前面时，查询型任务的产出会变成一句状态汇报，而不是它的答案。
 *
 * 不照格式报只是降级，不是失败：改了哪些文件由这一侧自己量（`changes.ts`），
 * 成没成看退出码，两样都不依赖它的自述。
 */
const REPORT_CONTRACT = `

## 输出格式

先给交付物正文——任务要的答案、结论或改动说明。然后另起一节收尾：

### 回执
- 改了哪些文件：逐个列路径，每个一句话说明改了什么；没改就写「没有」
- 怎么解决的：一两句
- 还剩什么没做：没有就写「没有」
`

export interface CliRunResult {
  ok: boolean
  output: string
  exitCode: number
  timedOut: boolean
  stderr: string
  /**
   * 这一次它改了哪些文件——**由这一侧量出来的一手事实**，不是它自己说的。
   *
   * `files` 只列改得最多的前几个，`total` 说的是全部，**两者必须同行**。
   * `total: 0` 是「确定没改」；**量不了时整个字段缺席**，那时看 `changesUnmeasured`。
   */
  changes?: { files: FileChange[]; total: number }
  /**
   * 量不了的原因。**与 `changes` 互斥**，两者恰好有一个。
   *
   * 缺了它，「没量到」在界面和模型眼里都长得跟「没有改动」一样，
   * 而那是一个具体而错误的结论。
   */
  changesUnmeasured?: string
}

export async function runCli(
  agent: CliAgent,
  input: {
    prompt: string
    workspaceRoot: string
    signal: AbortSignal
    /**
     * qywork 自己的凭证。按值剥掉——后端用不上，也就没有理由拿到。
     * 不传等于「没有已知凭证」，不等于「不用剥」。
     */
    secrets?: { values: string[] }
    /**
     * 边跑边给一块。**不给这个回调就等于跑完才有输出**——外部 CLI 是本机另一个进程，
     * 它写了什么在结束之前一个字都看不到。
     */
    onChunk?: (text: string) => void
  },
): Promise<CliRunResult> {
  const args = agent.args.map((a) => a.replaceAll('{prompt}', input.prompt + REPORT_CONTRACT))
  const timeout = agent.timeoutMs ?? DEFAULT_TIMEOUT

  // 基线必须在起进程之前照：晚一步照就把它已经改过的那部分吃进基线了。
  const probe = await beginProbe(input.workspaceRoot)

  // 一律跑在工作区根下：派活给外部 CLI 是「在这个项目里干一件事」，
  // 它自己的工作目录不该由这里的配置面再开一个旋钮。
  const proc = Bun.spawn([agent.command, ...args], {
    cwd: input.workspaceRoot,
    // 关掉 stdin：被调度的 CLI 若想交互提问，这里没有人能回答，
    // 开着只会让它挂到超时。
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      // 只按**值**剥。名字模式那条会把后端自己要用的
      // ANTHROPIC_API_KEY / OPENAI_API_KEY 一起剥掉，后端直接不能干活，
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

  // 等待与收尾走同一个收口：完成判据是进程退出而不是管道 EOF，超时与中断都走**树杀**。
  // 被调度的 CLI 自己也在跑一个 agent，必然派生子进程；只杀它一个的话那些还活着，
  // 于是用户点了停止、这里却还在等一个永远不会到的 EOF。
  const got = await collectProcess(proc, {
    timeoutMs: timeout,
    signal: input.signal,
    // `onText` 的返回值是「真正记进结果的那一段」，所以必须原样回传：
    // 它是脱敏器的挂点，不是给旁观者用的。这里只顺手抄一份出去。
    ...(input.onChunk
      ? {
          onText: (_channel: 'stdout' | 'stderr', text: string) => {
            input.onChunk?.(text)
            return text
          },
        }
      : {}),
  })

  const changed = probe ? await endProbe(probe, input.workspaceRoot) : null

  return {
    ok: got.exitCode === 0 && !got.timedOut,
    output: extract(got.stdout, agent),
    exitCode: got.exitCode,
    timedOut: got.timedOut,
    // stderr 只留尾部：CLI 的进度条能刷出几万行，全留会把上下文撑爆。
    stderr: got.stderr.length > 4000 ? got.stderr.slice(-4000) : got.stderr,
    ...(changed ? { changes: changed } : { changesUnmeasured: UNMEASURABLE }),
  }
}

/**
 * 从 stdout 提取结果。
 *
 * jsonl 模式取**最后一个**非空的目标字段：agent 类 CLI 的 JSONL 流里，
 * 最终答案总在末尾，中间行是过程事件。取第一个会拿到「我开始干活了」。
 *
 * `resultField` 是**点分路径**，因为各家把答案埋的深浅不同：claude 在顶层 `result`，
 * codex 在 `item.text`（那种行还带着 `item.type: agent_message`，而 `command_execution`
 * 那类项根本没有 `text`，所以按路径取已经足够精确）。只按顶层键取的代价实测付过：
 * codex 一行都取不到，回退成整段 stdout，父会话拿到的是一坨 JSONL，
 * 而模型会把它当成任务产出。
 */
export function extract(stdout: string, agent: Pick<CliAgent, 'output' | 'resultField'>): string {
  if (agent.output !== 'jsonl') return stdout.trim()

  const path = (agent.resultField ?? 'result').split('.')
  let last = ''
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      let v: unknown = JSON.parse(trimmed)
      for (const key of path) {
        v = v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined
      }
      if (typeof v === 'string' && v.trim()) last = v
    } catch {
      // 不是 JSON 的行直接跳过：很多 CLI 会往 stdout 混入非结构化的横幅。
    }
  }
  // 一行都没解析出来时回退到整段 stdout——返回空字符串会让调用方
  // 以为任务成功但没产出，比给出原始输出更糟。
  return last || stdout.trim()
}
