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
 * `sliceSize` 是 `clamp(估计流速, 积压/(蓄水池×CATCHUP_RATIO), 积压/蓄水池)`。
 *
 * - **中间那项是主角**：按上游的估计流速恒速播放。速率不跟着积压走，
 *   所以一批到达不会冲高、快排空不会变慢——这是「平稳」的全部来源。
 * - **上界 `积压/蓄水池` 管见底**：积压不够时自动放慢，把剩下的铺开
 *   撑到下一批。没有它，恒速播放遇到偏长的间隔就是一段空档。
 * - **下界 `积压/(蓄水池×CATCHUP_RATIO)` 管封顶**：显示最多落后这么多档，突发也能排掉。
 *   没有它，流速一旦估低，积压只增不减。
 *
 * **不要把它退回成单一的「积压 ÷ 常数」比例式。** 那样速率正比于积压，
 * 实测序列上是 1↔3 字每档来回跳（500ms 窗口 10↔28 字），肉眼就是忽快忽慢。
 *
 * ## 蓄水池按实测到达间隔定，不是常数
 *
 * 稳态落后就等于蓄水池的档数（积压涨到 `蓄水池×流速` 时上界才不再压着流速），
 * 而这份落后在终态会一次性倒出去——**蓄水池多存一档，结尾就多蹦一档的字**。
 * 存多少只由一件事决定：**撑不撑得到下一批**。所以它跟着 `gapHold`（近期到达间隔）
 * 走：批量转发的上游间隔 960ms，存满 10 档；逐 token 到达的上游间隔几十毫秒，
 * 存 2 档就够。2026-08-20 实测（400/1200 字每秒的平顺上游）：固定 10 档落后 440ms、
 * 结尾倒出 162/486 字；跟着间隔走落后 134ms、结尾倒出 34/101 字，而 37 字/960ms
 * 的批量序列逐档不变。
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
/**
 * 每档硬顶。一次网络突发不许糊满一屏。
 *
 * `MAX_CHARS / TICK_MS` 同时是显示的吞吐天花板，所以**这个数必须高于上游可能的真实
 * 流速**：低了的那部分不会被丢，只会一直积压，到终态 flush 时一次倒出去。
 * 2026-08-20 按 1200 字/s 的上游实测：取 40 时显示封顶 794 字/s、落后 3.5 秒、
 * 结尾积压 8112 字；取 150 时显示 1176 字/s、落后 440ms、结尾积压 486 字。
 * 批量到达的场景（37 字/960ms）两个取值逐档一致——它只在上游快到撞顶时才起作用。
 */
export const MAX_CHARS = 150
/** 蓄水池的上限档数。撑得住批量转发那档间隔（实测 960ms）就够，再多是白付的延迟。 */
export const MAX_RESERVE_TICKS = 10
/** 蓄水池的下限档数。留两档是给到达时刻本身的抖动，不是给上游的。 */
export const MIN_RESERVE_TICKS = 2
/** 显示最多落后蓄水池的几倍。这是延迟上限，也是突发的排空下限。 */
export const CATCHUP_RATIO = 4
/** 流速估计的 EMA 系数。取 0.3：几批之内跟上变化，又不被单批抖动带走。 */
export const RATE_SMOOTH = 0.3
/**
 * 到达间隔变短时蓄水池的收缩系数。**变长时不用系数，直接跟上**——
 * 间隔涨了却没跟上就是一次断档，而断档比多存几档难看得多。
 */
export const GAP_FALL = 0.3
/** 到达间隔超过这个数就是卡顿，不拿它更新流速估计，也不拿它撑大蓄水池。 */
export const STALL_MS = 3_000
/** 还没有间隔可测时按最保守的估：先当成批量转发的上游。 */
export const GAP_HOLD_INIT = MAX_RESERVE_TICKS * TICK_MS

/**
 * 一次 markdown 重解析该占掉多少档。
 *
 * 渲染层按**档数**降频，不按时间。独立的定时器与这里的 50ms 是两个不同步的周期，
 * 串起来会拍频——表现是字一撮一撮往外蹦，不是流出来的；数档数则永远落在同一个节拍上。
 *
 * 判据是**上一次实测的耗时**，不是猜的文本长度。流式期渲染层按 token 边界增量解析
 * （`markdown.ts` 的 `createStreamRenderer`），一档只解析活动区那一两个块，
 * 典型不到 1ms，于是这里恒返回 1——**每档都跟，任何长度的回复都完全匀速**。
 *
 * 它留着是为了兜住推不动边界的文档：整篇是一个松散列表时顶层只有两个 token，
 * 增量退化成每档重解析全文（2026-08-20 实测 Chromium，3492 字最慢 7.2ms 一档），
 * 文档再长下去降频才是对的。
 *
 * 留四成给解析，其余给渲染与布局。
 */
export function reparseSkip(lastCostMs: number): number {
  return Math.max(1, Math.ceil(lastCostMs / (TICK_MS * 0.4)))
}

export interface PaceState {
  /** 已收到、还没显示出去的字。 */
  pending: string
  /** 估计的上游流速，单位是字每档。0 表示还没有第二批可以算间隔。 */
  rate: number
  /** 上一档没放出去的小数部分。不留着的话 1.9 字每档会被恒抹成 1。 */
  carry: number
  /** 上一次收到正文的时刻。`-1` 表示这一段还没收到过。 */
  lastPushAt: number
  /** 近期的到达间隔（毫秒），蓄水池按它定档数。 */
  gapHold: number
}

export function freshPace(): PaceState {
  return { pending: '', rate: 0, carry: 0, lastPushAt: -1, gapHold: GAP_HOLD_INIT }
}

/**
 * 收到一批正文：更新流速估计与蓄水池深度。
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
  state.gapHold = gap > state.gapHold ? gap : state.gapHold + (gap - state.gapHold) * GAP_FALL
}

/** 蓄水池该有多深。**只由「下一批什么时候来」决定**，与积压多少无关。 */
export function reserveTicks(gapHoldMs: number): number {
  return Math.min(MAX_RESERVE_TICKS, Math.max(MIN_RESERVE_TICKS, Math.ceil(gapHoldMs / TICK_MS)))
}

/**
 * 这一档该放多少字，**可能带小数**——调用方用 `carry` 累积，不要在这里取整。
 *
 * 三条规则见文件头。`rate` 为 0（还没算出流速）时退回上界，
 * 那是「把手里的铺开撑住」，不是「一次放完」。
 */
export function sliceSize(remaining: number, rate: number, reserve: number): number {
  if (remaining <= 0) return 0
  const softCap = remaining / reserve
  const hardFloor = remaining / (reserve * CATCHUP_RATIO)
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
  const want =
    sliceSize(state.pending.length, state.rate, reserveTicks(state.gapHold)) + state.carry
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
export interface FrameHost {
  /** 把这一档字写进界面。 */
  write(stepId: string, chunk: string): void
  /** 起一个周期定时器，返回取消函数。 */
  schedule(fn: () => void, ms: number): () => void
}

export interface PacerHost extends FrameHost {
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
      // 换会话了，上一条的流速与到达节奏对新的一条都不作数。
      state.rate = 0
      state.lastPushAt = -1
      state.gapHold = GAP_HOLD_INIT
      stepId = null
    },
  }
}

/**
 * 工具中途输出的合帧。
 *
 * **这不是限速，是合并**：一个字节都不少，只是把同一档里到的若干段并成一次落地。
 * 正文那边解决的是「来得太快又停太久」，这里解决的是另一件事——**来得太密**：
 * `git log --stat -n 400` 实测 273 段 / 744ms = 367 次每秒（2026-08-20），
 * 而每次落地都要重渲染整块 `<pre>` 并写一次 `scrollTop`（强制回流）。
 * 主线程被这个频率占满时，正文那个 50ms 定时器跟着被推迟，表现是正文明明有数据却不动。
 *
 * 用与正文同一个 `TICK_MS`：两个不同步的周期串起来会拍频（`reparseSkip` 那条讲的
 * 就是这件事），同一个节拍则永远落在同一拍上。
 *
 * 按 stepId 分桶而不是只留最后一条：一波并发工具会同时吐字，混成一桶就串卡片了。
 */
export interface Framer {
  /** 收到一段工具输出。 */
  push(stepId: string, delta: string): void
  /** 把攒着的立刻落地。终态、以及任何要读这份 transcript 的事件之前都要调。 */
  flush(): void
  /** 丢掉攒着的。换会话、整段重拉时用。 */
  discard(): void
}

export function createFramer(host: FrameHost): Framer {
  const pending = new Map<string, string>()
  let cancel: (() => void) | null = null

  const stop = () => {
    cancel?.()
    cancel = null
  }

  const commit = () => {
    if (pending.size === 0) {
      stop()
      return
    }
    for (const [id, text] of pending) host.write(id, text)
    pending.clear()
  }

  return {
    push(id, delta) {
      if (!delta) return
      pending.set(id, (pending.get(id) ?? '') + delta)
      if (cancel === null) cancel = host.schedule(commit, TICK_MS)
    },
    flush() {
      commit()
      stop()
    },
    discard() {
      pending.clear()
      stop()
    },
  }
}
