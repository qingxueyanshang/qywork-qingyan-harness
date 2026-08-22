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

import { collectProcess, scrubEnv } from '@qywork/tools'
import type { CliAgent } from './types.ts'

const DEFAULT_TIMEOUT = 10 * 60 * 1000

export interface CliRunResult {
  ok: boolean
  output: string
  exitCode: number
  timedOut: boolean
  stderr: string
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
  },
): Promise<CliRunResult> {
  const args = agent.args.map((a) => a.replaceAll('{prompt}', input.prompt))
  const timeout = agent.timeoutMs ?? DEFAULT_TIMEOUT

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
  const got = await collectProcess(proc, { timeoutMs: timeout, signal: input.signal })

  return {
    ok: got.exitCode === 0 && !got.timedOut,
    output: extract(got.stdout, agent),
    exitCode: got.exitCode,
    timedOut: got.timedOut,
    // stderr 只留尾部：CLI 的进度条能刷出几万行，全留会把上下文撑爆。
    stderr: got.stderr.length > 4000 ? got.stderr.slice(-4000) : got.stderr,
  }
}

/**
 * 从 stdout 提取结果。
 *
 * jsonl 模式取**最后一个**非空的目标字段：agent 类 CLI 的 JSONL 流里，
 * 最终答案总在末尾，中间行是过程事件。取第一个会拿到「我开始干活了」。
 */
function extract(stdout: string, agent: CliAgent): string {
  if (agent.output !== 'jsonl') return stdout.trim()

  const field = agent.resultField ?? 'result'
  let last = ''
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>
      const v = obj[field]
      if (typeof v === 'string' && v.trim()) last = v
    } catch {
      // 不是 JSON 的行直接跳过：很多 CLI 会往 stdout 混入非结构化的横幅。
    }
  }
  // 一行都没解析出来时回退到整段 stdout——返回空字符串会让调用方
  // 以为任务成功但没产出，比给出原始输出更糟。
  return last || stdout.trim()
}
