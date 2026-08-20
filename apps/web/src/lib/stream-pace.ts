/**
 * 正文流的匀速呈现。
 *
 * ## 为什么需要它
 *
 * `text.delta` 到达的节奏是网络的节奏，不是阅读的节奏。中转站按批转发是常态
 * （2026-08-20 实测一家：每约 960ms 给 37 字一批），直接写进 transcript 的话，
 * 画面就跟着网络一起一顿一顿。**看起来像卡了，其实是来得太快又停太久。**
 *
 * 这里把「收到」和「显示」解耦：收到的先攒着，按固定 50ms 一档往外放。
 *
 * ## 每档放多少：三条规则各管一段
 *
 * `sliceSize` 是 `clamp(估计流速, 积压/MAX_LAG_TICKS, 积压/RESERVE_TICKS)`。
 *
 * - **中间那项是主角**：按上游的估计流速恒速播放。速率不跟着积压走，
 *   所以一批到达不会冲高、快排空不会变慢——这是「平稳」的全部来源。
 * - **上界 `积压/RESERVE_TICKS` 管见底**：积压不够时自动放慢，把剩下的铺开
 *   撑到下一批。没有它，恒速播放遇到偏长的间隔就是一段空档。
 * - **下界 `积压/MAX_LAG_TICKS` 管封顶**：显示最多落后这么多档，突发也能排掉。
 *   没有它，流速一旦估低，积压只增不减。
 *
 * **不要把它退回成单一的「积压 ÷ 常数」比例式。** 那样速率正比于积压，
 * 实测序列上是 1↔3 字每档来回跳（500ms 窗口 10↔28 字），肉眼就是忽快忽慢。
 *
 * ## 卡顿不是流速
 *
 * 间隔超过 `STALL_MS` 的那一次**不更新速率估计**。上游真卡住六秒再恢复，
 * 若把这段算进流速，估计值会被拉到极低，之后的字是一个一个往外挤的。
 * 卡顿期间积压放完就停表——**卡住就该看起来是卡住**，不靠拖慢正文假装还在流。
 *
 * ## 终态一律不排队
 *
 * run 结束、报错、被中断，都要立刻把积压全放出去。原因不是好看：
 * `writeTail` 只认 transcript 的**末项**，读数条一旦落进去，后续的字会被 push
 * 成新的一段排在读数条后面——正文残缺、读数条、正文尾巴。
 *
 * 调用侧据此有一条简单规则：**除了 `text.delta`，任何事件先冲一次**。
 * 这样缓冲区里永远只可能有当前尾部那一段，不需要按 step 记账。
 */

/** 放行档位间隔（毫秒）。 */
export const TICK_MS = 50
/** 每档硬顶。一次网络突发不许糊满一屏。 */
export const MAX_CHARS = 40
/** 积压见底时至少还要撑这么多档，用放慢换「不断档」。 */
export const RESERVE_TICKS = 10
/** 显示最多落后这么多档。这是延迟上限，也是突发的排空下限。 */
export const MAX_LAG_TICKS = 40
/** 流速估计的 EMA 系数。取 0.3：几批之内跟上变化，又不被单批抖动带走。 */
export const RATE_SMOOTH = 0.3
/** 到达间隔超过这个数就是卡顿，不拿它更新流速估计。 */
export const STALL_MS = 3_000

export interface PaceState {
  /** 已收到、还没显示出去的字。 */
  pending: string
  /** 估计的上游流速，单位是字每档。0 表示还没有第二批可以算间隔。 */
  rate: number
  /** 上一档没放出去的小数部分。不留着的话 1.9 字每档会被恒抹成 1。 */
  carry: number
  /** 上一次收到正文的时刻。`-1` 表示这一段还没收到过。 */
  lastPushAt: number
}

export function freshPace(): PaceState {
  return { pending: '', rate: 0, carry: 0, lastPushAt: -1 }
}

/**
 * 收到一批正文：更新流速估计。
 *
 * 时刻由调用方给而不是自己读时钟——测试要能按实测节奏喂，见 `PacerHost.now`。
 */
export function observe(state: PaceState, chars: number, atMs: number): void {
  const last = state.lastPushAt
  state.lastPushAt = atMs
  if (last < 0) return
  const gap = atMs - last
  if (gap <= 0 || gap > STALL_MS) return
  const observed = (chars / gap) * TICK_MS
  state.rate = state.rate === 0 ? observed : state.rate + (observed - state.rate) * RATE_SMOOTH
}

/**
 * 这一档该放多少字，**可能带小数**——调用方用 `carry` 累积，不要在这里取整。
 *
 * 三条规则见文件头。`rate` 为 0（还没算出流速）时退回上界，
 * 那是「把手里的铺开撑住」，不是「一次放完」。
 */
export function sliceSize(remaining: number, rate: number): number {
  if (remaining <= 0) return 0
  const softCap = remaining / RESERVE_TICKS
  const hardFloor = remaining / MAX_LAG_TICKS
  const want = rate > 0 ? Math.min(softCap, Math.max(hardFloor, rate)) : softCap
  return Math.min(MAX_CHARS, want)
}

/**
 * 别把代理对切成两半。
 *
 * `slice` 按 UTF-16 码元切，一个 emoji 占两个码元，切在中间那一刀会让界面闪一帧
 * U+FFFD 方块。每档只放一两个字时几乎每个 emoji 都会中招，所以这一步是必须的，
 * 不是防御性代码。
 *
 * 后半个已经在缓冲里就一起放出去；还没到（正好是缓冲末尾）就退一格等下一批——
 * 退到 0 就是这一档不出字，比出半个字符对。
 */
function alignSurrogate(text: string, n: number): number {
  if (n <= 0) return n
  const code = text.charCodeAt(n - 1)
  if (code < 0xd800 || code > 0xdbff) return n
  return n < text.length ? n + 1 : n - 1
}

/** 取走这一档要显示的字，剩下的继续攒着。取完返回空串。 */
export function takeSlice(state: PaceState): string {
  const want = sliceSize(state.pending.length, state.rate) + state.carry
  let n = Math.floor(want)
  state.carry = want - n
  // 还有字就至少放一个：不然流速低于 1 字每档时，小数会在 carry 里反复累积，
  // 表现成一串空档——那正是要消除的顿挫。
  if (n === 0 && state.pending.length > 0) {
    n = 1
    state.carry = 0
  }
  n = alignSurrogate(state.pending, Math.min(n, state.pending.length))
  if (n <= 0) return ''
  const out = state.pending.slice(0, n)
  state.pending = state.pending.slice(n)
  return out
}

/** 全部取走——终态用。流速估计留着：同一条会话的下一段正文还按它放。 */
export function takeAll(state: PaceState): string {
  const out = state.pending
  state.pending = ''
  state.carry = 0
  return out
}

/**
 * 定时器编排。
 *
 * 单独抽出来是为了**能测**：写在 `connection.ts` 里的话，跑起来要 solid 的 store
 * 和真实定时器，于是只有纯函数那半有测试、编排这半没有——而真正会出错的恰恰是
 * 编排（该冲的时候没冲、换会话时把上一段字冲进了新会话）。
 *
 * `schedule` 是接缝：生产路径给 `setInterval`，测试给一个手动步进的假调度。
 */
export interface PacerHost {
  /** 把这一档字写进界面。 */
  write(stepId: string, chunk: string): void
  /** 起一个周期定时器，返回取消函数。 */
  schedule(fn: () => void, ms: number): () => void
  /** 当前时刻。和 `schedule` 一样是接缝：测试要按实测节奏喂到达间隔。 */
  now(): number
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
      // 流速按**到达**算，所以在攒进缓冲之前先记一笔。
      observe(state, delta.length, host.now())
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
      // 换会话了，上一条的流速对新的一条不作数。
      state.rate = 0
      state.lastPushAt = -1
      stepId = null
    },
  }
}
