/**
 * 正文流的匀速呈现。
 *
 * ## 为什么需要它
 *
 * `text.delta` 到达的节奏是网络的节奏，不是阅读的节奏。provider 卡一下、
 * 攒一批、然后一次性吐出来——直接写进 transcript 的话，画面就跟着网络一起
 * 一顿一顿，一次突发直接砸出一屏字。**看起来像卡了，其实是来得太快。**
 *
 * 这里把「收到」和「显示」解耦：收到的先攒着，按固定 50ms 一档往外放。
 *
 * ## 三个常数各挡一种坏情况
 *
 * - `MIN_CHARS` 保底：再慢也得往前挪，否则一个字一个字挤出来像死机。
 * - `DRAIN_TICKS` 是软目标：积压按大约这么多档放完，积得多就放得快，
 *   不至于越拖越远。
 * - `MAX_CHARS` 是硬顶：**没有它，一次大突发照样一帧糊出去**——
 *   软目标是「剩余 ÷ 24」，剩余一万字时那也是一次 417 字。
 *
 * ## 终态一律不排队
 *
 * run 结束、报错、被中断，都要立刻把积压全放出去。原因不是好看：
 * 运行读数条、错误卡、重试按钮读的是同一份 transcript，让它们看到一份
 * 放了一半的正文，等于让界面上同时存在两个时刻。
 *
 * 调用侧据此有一条简单规则：**除了 `text.delta`，任何事件先冲一次**。
 * 这样缓冲区里永远只可能有当前尾部那一段，不需要按 step 记账。
 */

/** 放行档位间隔（毫秒）。 */
export const TICK_MS = 50
/** 每档至少放这么多字。 */
export const MIN_CHARS = 6
/** 软目标：积压大约按这么多档放完。 */
export const DRAIN_TICKS = 24
/** 每档硬顶。一次网络突发不许糊满一屏。 */
export const MAX_CHARS = 40

export interface PaceState {
  /** 已收到、还没显示出去的字。 */
  pending: string
}

export function freshPace(): PaceState {
  return { pending: '' }
}

/** 这一档该放多少字。积压越多放得越快，但不超过硬顶。 */
export function sliceSize(remaining: number): number {
  if (remaining <= 0) return 0
  return Math.min(MAX_CHARS, Math.max(MIN_CHARS, Math.ceil(remaining / DRAIN_TICKS)))
}

/** 取走这一档要显示的字，剩下的继续攒着。取完返回空串。 */
export function takeSlice(state: PaceState): string {
  const n = Math.min(state.pending.length, sliceSize(state.pending.length))
  if (n === 0) return ''
  const out = state.pending.slice(0, n)
  state.pending = state.pending.slice(n)
  return out
}

/** 全部取走——终态用。 */
export function takeAll(state: PaceState): string {
  const out = state.pending
  state.pending = ''
  return out
}

/**
 * 定时器编排。
 *
 * 单独抽出来是为了**能测**：它原来直接写在 `connection.ts` 里，跑起来要 solid
 * 的 store 和真实定时器，于是只有纯函数那半有测试、编排这半没有——
 * 而真正会出错的恰恰是编排（该冲的时候没冲、换会话时把上一段字冲进了新会话）。
 *
 * `schedule` 是接缝：生产路径给 `setInterval`，测试给一个手动步进的假调度。
 */
export interface PacerHost {
  /** 把这一档字写进界面。 */
  write(stepId: string, chunk: string): void
  /** 起一个周期定时器，返回取消函数。 */
  schedule(fn: () => void, ms: number): () => void
}

export interface Pacer {
  /** 收到一段正文。 */
  push(stepId: string, delta: string): void
  /** 把积压一次性放完。终态、以及任何非正文事件之前都要调。 */
  flush(): void
  /** 丢掉积压。换会话、整段重拉时用——那段字的归属已经不存在了。 */
  discard(): void
}

export function createPacer(host: PacerHost): Pacer {
  const state = freshPace()
  let stepId: string | null = null
  let cancel: (() => void) | null = null

  const stop = () => {
    cancel?.()
    cancel = null
  }

  const tick = () => {
    const chunk = takeSlice(state)
    if (!chunk) {
      stop()
      return
    }
    if (stepId) host.write(stepId, chunk)
  }

  return {
    push(id, delta) {
      // 换了一条 text step：上一条必须先落干净，否则它的尾巴会被记到新的这条上。
      if (stepId !== id) {
        stop()
        if (stepId) host.write(stepId, takeAll(state))
        stepId = id
      }
      state.pending += delta
      if (cancel === null) cancel = host.schedule(tick, TICK_MS)
    },
    flush() {
      stop()
      if (stepId) host.write(stepId, takeAll(state))
      stepId = null
    },
    discard() {
      stop()
      takeAll(state)
      stepId = null
    },
  }
}
