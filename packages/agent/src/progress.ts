/**
 * 连续无进展的判定。
 *
 * 拦截对象：模型重复同一个无副作用周期，既包括用完全相同的参数调用工具并
 * 取得完全相同的结果，也包括面对同一份未完成待办反复只结束响应而不采取动作。
 * 不拦截时 provider 往返会无限重复。该问题的成因不是步数不足，而是没有进展，
 * 任何固定回合上限都只会把真正的错误替换为一个含义模糊的终态。
 *
 * 判据：动作、模型可见的结果或状态快照、副作用三项均未变化。一次 provider 决策只保留一个
 * 周期指纹；工具名、参数与结果共同进入该指纹，响应结束动作则与未完成待办快照共同进入。
 * 执行前被拒的参数校验失败只比较工具与校验结果：改变参数却没有解决同一错误，不是进展。
 *
 * 只有周期指纹逐项相同，且这些周期都确定没有产生副作用
 * 时，才计为一个无进展周期。三项缺一不可：
 *
 * - 只比较动作而不比较结果时，轮询类调用（等待构建、等待文件出现）会被误判：
 *   相同的命令返回不同的输出，属于有进展。
 * - 不考虑副作用时会误判：反复写入同一个文件且每次内容不同，同样属于有进展。
 *   `changed` 取自执行器给出的事实（`fileChanges`），不是推测值。
 * - 失败本身不构成证据：一次报错不能证明副作用未发生（写入一半后抛出同样是错误），
 *   因此只有明确的「无变更」才参与判定。
 *
 * 判定需要三次而不是两次：连续两次完全相同在实际使用中可能是正常的，模型重新定位时再次查看同
 * 一个目录、再次确认同一个文件，都会留下两条相同证据；三次则没有正常的解释。
 *
 * 代价是多执行一个周期，收益是几乎不会误停正常流程。这一方向的误判必须避免：
 * 用户只看到任务自行停止且未完成，没有任何线索指向本规则。
 *
 * 支持短周期，不限于 A,A,A：`A,B,A,B,A,B` 与 `A,A,A` 属于同一情况。宽度上限为 3：更宽的重复
 * 无法直接确认为循环，且误判代价（中止一个正常的长流程）远大于收益。
 *
 * 判定在批次执行完毕之后进行，而不在下发之前：工具整批下发，提前中断会在 transcript 中留下一条「有
 * tool_calls 但没有 tool 结果」的 assistant 消息，下一轮请求会被 provider 以 400 拒绝。代价是晚一
 * 轮停止，与持续无进展相比仍相差一个数量级。
 */

/** 一次执行动作或响应结束留下的进展证据。 */
export interface ProgressEvidence {
  /** 足以判断该周期是否变化的指纹（定长摘要）。 */
  cycle: string
  /**
   * 本次调用是否确定没有产生副作用。
   *
   * 工具证据只有明确事实才置 true：调用没有进入执行器（`executed: false`），
   * 或工具在注册期声明为纯 `read` 且没有报告文件变更。正常 end_turn 本身没有
   * 副作用，由调用方把未完成待办快照写入 `cycle`。不明确的情况一律为 false，
   * 使其保持可重试，而不是计入无进展。
   */
  noProgress: boolean
}

/** 稳定序列化：对象键排序，保证相同内容得到相同字符串。 */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const rec = value as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(rec[k])}`).join(',')}}`
}

/**
 * 指纹一律为定长摘要，不保留原始字符串：参数可能包含整份文件内容，结果可能包含图片
 * base64，原始字符串会在证据数组中保留整个 run。判等语义与稳定序列化一致；
 * 非加密哈希，不承担安全语义。
 */
function digest(payload: string): string {
  return Bun.hash(payload).toString(36)
}

export function cycleFingerprint(
  toolName: string,
  args: Record<string, unknown>,
  outcome: {
    status: string
    executed?: boolean
    message?: string
    errorKind?: string
    data?: unknown
    resources?: readonly { resourceId: string }[]
  },
): string {
  // 只有明确未执行的参数校验失败可以忽略参数。缺参项或其他结果变化仍会改变指纹，
  // 修正后真正执行的调用也重新按完整参数比较；权限拒绝、外部执行失败等保持原口径。
  const rejectedArguments =
    outcome.status === 'failure' &&
    outcome.executed === false &&
    outcome.errorKind === 'invalid_tool_arguments'
  return digest(
    stable({
      tool: toolName,
      arguments: rejectedArguments ? null : args,
      status: outcome.status,
      executed: outcome.executed ?? null,
      errorKind: outcome.errorKind ?? null,
      summary: outcome.message ?? '',
      resources: outcome.resources?.map((r) => r.resourceId) ?? [],
      result: outcome.data ?? null,
    }),
  )
}

/** 宽度上限。见文件头：更宽的重复难以确认为循环，误判代价更大。 */
export const MAX_CYCLE_WIDTH = 3

/** 判定要求的重复次数。理由见文件头关于三次判定的说明。 */
export const REQUIRED_REPEATS = 3

/**
 * 历史末尾是否为一个已由事实确认的无进展周期。
 *
 * 查找最近的三个等宽周期：逐项周期指纹相同，且其中每一次调用都确定没有副作用。
 * 校验失败按工具与错误结果比较，其余调用仍比较完整参数；结果、状态或文件变更
 * 任一不同即不构成循环。
 */
export function repeatsNoProgress(
  history: readonly ProgressEvidence[],
  maxWidth = MAX_CYCLE_WIDTH,
  /** 要求的重复次数。停止按 3 次判定；按 2 次判定一次，用于在停止之前把重复这一事实告知模型。 */
  repeats = REQUIRED_REPEATS,
): boolean {
  if (history.length < repeats) return false
  const upper = Math.min(Math.max(1, maxWidth), Math.floor(history.length / repeats))
  for (let w = 1; w <= upper; w++) {
    const windows: ProgressEvidence[][] = []
    for (let k = repeats; k >= 1; k--) {
      windows.push(history.slice(history.length - k * w, history.length - (k - 1) * w))
    }
    if (!windows.flat().every((e) => e.noProgress)) continue
    const first = windows[0]!
    if (windows.every((win) => win.every((e, i) => e.cycle === first[i]?.cycle))) return true
  }
  return false
}
