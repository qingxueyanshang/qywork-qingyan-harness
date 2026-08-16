/**
 * 原地打转的判定。
 *
 * ## 它挡的是什么
 *
 * 模型调一个工具、拿到结果、没解决问题，于是**用一模一样的参数再调一遍**，
 * 拿到一模一样的结果。今天这种情况会一路烧到 `max_steps`——几十轮 provider
 * 往返，钱花了，最后报一个「已达步数上限」。那个终止原因是错的：
 * 它不是步数不够，是它在原地打转，多给一百步也一样。
 *
 * ## 判据：动作、结果、副作用三样都没变
 *
 * 一次调用留下两个指纹：
 *
 * - **动作指纹** = 工具名 + 参数。同样的动作。
 * - **周期指纹** = 动作 + 状态 + 结果正文。同样的动作**且**同样的回答。
 *
 * 只有周期指纹逐项相同、而且这些调用**都没有产生任何副作用**（没有文件变更）
 * 时才算一个空转周期。这三条缺一不可：
 *
 * - 只看动作不看结果：轮询类调用（等构建、等文件出现）会被误判——
 *   同样的命令返回不同的输出，那是有进展的。
 * - 不看副作用：反复写同一个文件、每次内容不同，那也是在干活。
 *   `changed` 取的是执行器给出的事实（`fileChanges`），不是猜的。
 * - 失败本身不算证据：一次报错不能证明副作用没发生（写了一半再抛也是错），
 *   所以只有明确的「没变更」才参与判定。
 *
 * ## 为什么是三次不是两次
 *
 * 连着两次一模一样，在真实使用里可能是正常的——模型重新定位时再看一眼同一个
 * 目录、确认一遍同一个文件，都会留下两条相同证据。**三次就没有良性解释了。**
 *
 * 代价是多跑一个周期，收益是几乎不会误砍正常流程。这个方向的误判要特别小心：
 * 用户看到的是「它自己停了、活没干完」，而且没有任何线索指向这条规则。
 *
 * ## 支持短周期，不只是 A,A,A
 *
 * `A,B,A,B,A,B` 和 `A,A,A` 是同一件事。宽度上限 3——再宽的重复肉眼都看不出来是循环，
 * 而且误判代价（砍掉一个正常的长流程）远大于收益。
 *
 * ## 判在批次跑完之后，不在下发之前
 *
 * 工具是整批下发的，提前中断会在 transcript 里留下一条「有 tool_calls 但没有
 * tool 结果」的 assistant 消息——下一轮请求发给 provider 会直接 400。
 * 代价是晚一轮才停，比起烧满 max_steps 仍然是数量级的差别。
 */

/** 一次工具调用留下的进展证据。 */
export interface ProgressEvidence {
  /** 工具名 + 参数。 */
  action: string
  /** 动作 + 状态 + 结果正文。 */
  cycle: string
  /**
   * 这次调用是否**确凿地**没有产生副作用。
   *
   * 只有执行器明说「没有文件变更」才是 true。含糊的失败留 false，
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

export function actionFingerprint(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}|${stable(args)}`
}

export function cycleFingerprint(
  toolName: string,
  args: Record<string, unknown>,
  outcome: { status: string; message?: string; data?: unknown; errorKind?: string },
): string {
  return [
    actionFingerprint(toolName, args),
    outcome.status,
    outcome.errorKind ?? '',
    outcome.message ?? '',
    stable(outcome.data ?? null),
  ].join('|')
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
