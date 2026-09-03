/**
 * 原地打转的判定。
 *
 * **它挡的是什么。** 模型重复同一个无副作用周期：既包括用一模一样的参数调工具、
 * 拿到一模一样的结果，也包括在同一份未完成待办前反复只结束响应、不采取动作。
 * 不挡的话它会无限重复 provider 往返。这个问题不是「步数不够」，而是它在原地打转，
 * 加任何固定回合上限都只会把真正的错误换成一个含糊的终态。
 *
 * **判据：动作、模型可见结果或状态快照、副作用三样都没变。** 一次 provider 决策只留一个
 * 周期指纹；工具名、参数与结果共同进入该指纹，响应结束动作则与未完成待办快照共同进入。
 *
 * 只有周期指纹逐项相同、而且这些周期**都确凿没有产生副作用**
 * 时才算一个空转周期。这三条缺一不可：
 *
 * - 只看动作不看结果：轮询类调用（等构建、等文件出现）会被误判——
 *   同样的命令返回不同的输出，那是有进展的。
 * - 不看副作用：反复写同一个文件、每次内容不同，那也算有进展。
 *   `changed` 取的是执行器给出的事实（`fileChanges`），不是猜的。
 * - 失败本身不算证据：一次报错不能证明副作用没发生（写了一半再抛也是错），
 *   所以只有明确的「没变更」才参与判定。
 *
 * **为什么是三次不是两次。** 连着两次一模一样，在真实使用里可能是正常的——模型重新定位时再看一眼同
 * 一个目录、确认一遍同一个文件，都会留下两条相同证据。**三次就没有良性解释了。**
 *
 * 代价是多跑一个周期，收益是几乎不会误砍正常流程。这个方向的误判要特别小心：
 * 用户看到的是「它自己停了、活没干完」，而且没有任何线索指向这条规则。
 *
 * **支持短周期，不只是 A,A,A。** `A,B,A,B,A,B` 和 `A,A,A` 是同一件事。宽度上限 3——再宽的重复肉眼
 * 都看不出来是循环，而且误判代价（砍掉一个正常的长流程）远大于收益。
 *
 * **判在批次跑完之后，不在下发之前。** 工具是整批下发的，提前中断会在 transcript 里留下一条「有
 * tool_calls 但没有 tool 结果」的 assistant 消息——下一轮请求发给 provider 会直接 400。代价是晚一
 * 轮才停，比起继续空转仍然是数量级的差别。
 */

/** 一次执行动作或响应结束留下的进展证据。 */
export interface ProgressEvidence {
  /** 足以判断这个周期是否变化的指纹（定长摘要）。 */
  cycle: string
  /**
   * 这次调用是否**确凿地**没有产生副作用。
   *
   * 工具证据只有明确事实才置 true：调用没有进入执行器（`executed: false`），
   * 或工具在注册期声明为纯 `read` 且没有报告文件变更。正常 end_turn 本身没有
   * 副作用，由调用方把未完成待办快照写进 `cycle`。含糊的一律留 false，
   * 让它继续可重试，而不是被算进空转。
   */
  noProgress: boolean
}

/** 稳定序列化：对象键排序，保证同样的内容得到同样的串。 */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  const rec = value as Record<string, unknown>
  const keys = Object.keys(rec).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(rec[k])}`).join(',')}}`
}

/**
 * 指纹一律是定长摘要，不保留原串：参数可能含整份文件内容，结果可能含图片
 * base64，原串会在证据数组里常驻整个 run。判等语义与稳定序列化一致；
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
    data?: unknown
    resources?: readonly { resourceId: string }[]
  },
): string {
  return digest(
    stable({
      tool: toolName,
      arguments: args,
      status: outcome.status,
      executed: outcome.executed ?? null,
      summary: outcome.message ?? '',
      resources: outcome.resources?.map((r) => r.resourceId) ?? [],
      result: outcome.data ?? null,
    }),
  )
}

/** 宽度上限。见文件头：再宽的重复不像循环，误判代价更大。 */
export const MAX_CYCLE_WIDTH = 3

/** 判定要求的重复次数。见文件头「为什么是三次不是两次」。 */
export const REQUIRED_REPEATS = 3

/**
 * 历史的末尾是不是一个已被事实确认的空转周期。
 *
 * 找最近的三个等宽周期：逐项周期指纹相同，且其中每一次调用都确凿没有副作用。
 * 任何一项参数、结果、状态或文件变更不同都会打断循环——**这是设计意图**，
 * 不是漏判：变了就说明还在往前走。
 */
export function repeatsNoProgress(
  history: readonly ProgressEvidence[],
  maxWidth = MAX_CYCLE_WIDTH,
): boolean {
  if (history.length < REQUIRED_REPEATS) return false
  const upper = Math.min(Math.max(1, maxWidth), Math.floor(history.length / REQUIRED_REPEATS))
  for (let w = 1; w <= upper; w++) {
    const windows: ProgressEvidence[][] = []
    for (let k = REQUIRED_REPEATS; k >= 1; k--) {
      windows.push(history.slice(history.length - k * w, history.length - (k - 1) * w))
    }
    if (!windows.flat().every((e) => e.noProgress)) continue
    const first = windows[0]!
    if (windows.every((win) => win.every((e, i) => e.cycle === first[i]?.cycle))) return true
  }
  return false
}
