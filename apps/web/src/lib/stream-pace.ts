/**
 * 正文流的匀速呈现。
 *
 * 用途：`text.delta` 的到达节奏取决于网络，而不是阅读节奏。中转站按批转发很常见
 * （2026-08-20 实测一家：约每 960ms 发送一批 37 字），直接写入 transcript 时，
 * 画面随网络断续停顿。成因不是渲染慢，而是到达节奏本身不均匀。
 *
 * 本模块将「收到」与「显示」解耦：收到的文字先进入缓冲，按固定 50ms 一个节拍输出。
 *
 * 每个节拍的输出量由三条规则分段决定。`sliceSize` 为
 * `clamp(估计流速, 积压/(储备×CATCHUP_RATIO), 积压/储备)`，其中储备指缓冲储备的节拍数。
 *
 * - 中间项是主规则：按上游的估计流速恒速输出。速率不随积压变化，
 *   因此一批到达时不会加速、缓冲将空时不会减速，这是输出平稳的唯一来源。
 * - 上界 `积压/储备` 处理积压将尽：积压不足时自动放慢，将剩余部分分摊到
 *   下一批到达之前。缺少上界时，恒速输出遇到较长的间隔会出现一段空白。
 * - 下界 `积压/(储备×CATCHUP_RATIO)` 限制最大落后：显示最多落后这么多节拍，突发也能输出完毕。
 *   缺少下界时，流速一旦估计偏低，积压只增不减。
 *
 * 不要改回单一的「积压 ÷ 常数」比例式：那样速率与积压成正比，
 * 实测序列上每个节拍在 1↔3 字之间跳动（500ms 窗口 10↔28 字），视觉上忽快忽慢。
 *
 * 缓冲储备按实测到达间隔确定，不是常数。稳态落后等于储备的节拍数（积压增长到 `储备×流速` 时上界
 * 才不再限制流速），而这部分落后在终态会一次性输出：储备每多一个节拍，结尾就多一次性输出一个节拍的字数。
 * 储备深度只由一个条件决定：能否维持到下一批到达。因此它随 `gapHold`（近期到达间隔）变化：批量转发的
 * 上游间隔 960ms，储备 10 个节拍；逐 token 到达的上游间隔数十毫秒，储备 2 个节拍即可。2026-08-20 实测
 * （400/1200 字每秒的平稳上游）：固定 10 个节拍时落后 440ms、结尾一次输出 162/486 字；随间隔变化时
 * 落后 134ms、结尾一次输出 34/101 字，而 37 字/960ms 的批量序列每个节拍的输出不变。
 *
 * 停顿不是流速。间隔超过 `STALL_MS` 的那一次不更新速率估计。上游停滞六秒后恢复时，
 * 若将这段时间计入流速，估计值会被拉到极低，之后的文字会逐个缓慢输出。
 * 停顿期间积压输出完毕即停止计时：停滞应显示为停滞，不以放慢正文模拟仍在输出。
 *
 * 终态一律不排队。run 结束、报错、被中断时，都须立即输出全部积压。原因在于顺序正确性：
 * `writeTail` 只处理 transcript 的末项，读数条一旦写入，后续文字会被 push
 * 为排在读数条之后的新一段，形成「残缺正文、读数条、正文末尾」的顺序。
 *
 * 调用方据此遵守一条规则：除 `text.delta` 外，任何事件之前先 flush 一次。
 * 这样缓冲区中只可能存在当前末尾的一段，无需按 step 分别记录。
 */

/** 输出节拍间隔（毫秒）。 */
export const TICK_MS = 50
/**
 * 单个节拍的输出上限。一次网络突发不得在一帧内填满整屏。
 *
 * `MAX_CHARS / TICK_MS` 同时是显示的吞吐上限，因此该值必须高于上游可能的实际
 * 流速：超出部分不会丢失，但会持续积压，到终态 flush 时一次性输出。
 * 2026-08-20 按 1200 字/s 的上游实测：取 40 时显示上限 794 字/s、落后 3.5 秒、
 * 结尾积压 8112 字；取 150 时显示 1176 字/s、落后 440ms、结尾积压 486 字。
 * 批量到达的场景（37 字/960ms）两个取值的每个节拍输出一致：该值只在上游速度接近上限时起作用。
 */
export const MAX_CHARS = 150
/** 缓冲储备的节拍数上限。能覆盖批量转发的间隔（实测 960ms）即可，更多只会增加无谓的延迟。 */
export const MAX_RESERVE_TICKS = 10
/** 缓冲储备的节拍数下限。保留两个节拍用于吸收到达时刻本身的抖动，与上游无关。 */
export const MIN_RESERVE_TICKS = 2
/** 显示最多落后储备的倍数。这是延迟上限，也是突发积压的最低输出速率。 */
export const CATCHUP_RATIO = 4
/** 流速估计的 EMA 系数。取 0.3：数批之内跟随变化，又不受单批抖动影响。 */
export const RATE_SMOOTH = 0.3
/**
 * 到达间隔变短时储备的收缩系数。间隔变长时不使用系数，直接跟随：
 * 间隔变长而未跟随会出现一次空节拍，其影响远大于多储备几个节拍。
 */
export const GAP_FALL = 0.3
/** 到达间隔超过该值即视为停顿，不用于更新流速估计，也不用于扩大缓冲储备。 */
export const STALL_MS = 3_000
/** 尚无可测间隔时按最保守的方式估计：视为批量转发的上游。 */
export const GAP_HOLD_INIT = MAX_RESERVE_TICKS * TICK_MS

/**
 * 一次 markdown 重解析应占用的节拍数。
 *
 * 渲染层按节拍数降频，不按时间。独立的定时器与此处的 50ms 是两个不同步的周期，
 * 叠加后产生拍频，正文成批出现而不是连续输出；按节拍计数则始终与同一节拍对齐。
 *
 * 判据是上一次实测的耗时，不是推测的文本长度。流式期间渲染层按 token 边界增量解析
 * （`markdown.ts` 的 `createStreamRenderer`），每个节拍只解析活动区的一两个块，
 * 通常不到 1ms，因此此处通常返回 1：每个节拍都重解析，任何长度的回复都完全匀速。
 *
 * 保留该函数是为了处理增量边界无法推进的文档：整篇是一个松散列表时顶层只有两个 token，
 * 增量解析退化为每个节拍重解析全文（2026-08-20 实测 Chromium，3492 字最慢每个节拍 7.2ms），
 * 文档更长时应降频。
 *
 * 节拍时长的四成留给解析，其余留给渲染与布局。
 */
export function reparseSkip(lastCostMs: number): number {
  return Math.max(1, Math.ceil(lastCostMs / (TICK_MS * 0.4)))
}

export interface PaceState {
  /** 已收到、尚未显示的文字。 */
  pending: string
  /** 估计的上游流速，单位为字每节拍。0 表示尚无第二批可计算间隔。 */
  rate: number
  /** 上一节拍未输出的小数部分。不保留时，每节拍 1.9 字会被始终截断为 1。 */
  carry: number
  /** 上一次收到正文的时刻。`-1` 表示本段尚未收到正文。 */
  lastPushAt: number
  /** 近期的到达间隔（毫秒），缓冲储备按它确定节拍数。 */
  gapHold: number
}

export function freshPace(): PaceState {
  return { pending: '', rate: 0, carry: 0, lastPushAt: -1, gapHold: GAP_HOLD_INIT }
}

/**
 * 收到一批正文：更新流速估计与缓冲储备深度。
 *
 * 时刻由调用方传入，而不是自行读取时钟：测试需要按实测节奏输入，见 `PacerHost.now`。
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

/** 缓冲储备的节拍数。只由下一批的到达时间决定，与积压量无关。 */
export function reserveTicks(gapHoldMs: number): number {
  return Math.min(MAX_RESERVE_TICKS, Math.max(MIN_RESERVE_TICKS, Math.ceil(gapHoldMs / TICK_MS)))
}

/**
 * 当前节拍应输出的字数，可能带小数：调用方用 `carry` 累积，不要在此取整。
 *
 * 三条规则见文件头。`rate` 为 0（尚未得出流速）时使用上界，
 * 即分摊输出现有积压，而不是一次输出完毕。
 */
export function sliceSize(remaining: number, rate: number, reserve: number): number {
  if (remaining <= 0) return 0
  const softCap = remaining / reserve
  const hardFloor = remaining / (reserve * CATCHUP_RATIO)
  const want = rate > 0 ? Math.min(softCap, Math.max(hardFloor, rate)) : softCap
  return Math.min(MAX_CHARS, want)
}

/**
 * 不将代理对切分为两半。
 *
 * `slice` 按 UTF-16 码元切分，一个 emoji 占两个码元，在中间切分会使界面显示一帧
 * U+FFFD 方块。每个节拍只输出一两个字时几乎每个 emoji 都会被切分，因此这一步是必需的，
 * 不是防御性代码。
 *
 * 后半个码元已在缓冲中时一并输出；尚未到达（恰好位于缓冲末尾）时回退一个码元等待下一批。
 * 回退到 0 表示本节拍不输出，这优于输出半个字符。
 */
function alignSurrogate(text: string, n: number): number {
  if (n <= 0) return n
  const code = text.charCodeAt(n - 1)
  if (code < 0xd800 || code > 0xdbff) return n
  return n < text.length ? n + 1 : n - 1
}

/** 取出当前节拍要显示的文字，其余继续缓冲。缓冲为空时返回空串。 */
export function takeSlice(state: PaceState): string {
  const want =
    sliceSize(state.pending.length, state.rate, reserveTicks(state.gapHold)) + state.carry
  let n = Math.floor(want)
  state.carry = want - n
  // 有剩余文字时至少输出一个：否则流速低于每节拍 1 字时，小数会在 carry 中反复累积，
  // 形成一串空节拍，即本模块要消除的停顿。
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

/** 全部取出，用于终态。保留流速估计：同一会话的下一段正文仍按它输出。 */
export function takeAll(state: PaceState): string {
  const out = state.pending
  state.pending = ''
  state.carry = 0
  return out
}

/**
 * 定时器编排。
 *
 * 单独抽出是为了可测试：写在 `connection.ts` 中时，运行需要 solid 的 store
 * 与真实定时器，因此只有纯函数部分有测试、编排部分没有，而实际容易出错的是
 * 编排（应 flush 时未 flush、切换会话时把上一段文字写入新会话）。
 *
 * `schedule` 是注入点：生产路径传入 `setInterval`，测试传入手动步进的模拟调度。
 */
export interface FrameHost {
  /** 将当前节拍的文字写入界面。 */
  write(stepId: string, chunk: string): void
  /** 启动一个周期定时器，返回取消函数。 */
  schedule(fn: () => void, ms: number): () => void
}

export interface PacerHost extends FrameHost {
  /** 当前时刻。与 `schedule` 同为注入点：测试需要按实测节奏输入到达间隔。 */
  now(): number
}

export interface Pacer {
  /** 收到一段正文。 */
  push(stepId: string, delta: string): void
  /** 一次性输出全部积压。终态以及任何非正文事件之前都须调用。 */
  flush(): void
  /** 丢弃积压。切换会话、整段重新拉取时使用：这段文字的归属已不存在。 */
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
      // 切换到另一条 text step：上一条必须先输出完毕，否则其末段字符会被计入新的一条。
      if (stepId !== id) {
        stop()
        if (stepId) host.write(stepId, takeAll(state))
        stepId = id
      }
      // 流速按到达时刻计算，因此在写入缓冲之前先记录。
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
      // 已切换会话，上一条的流速与到达节奏对新的一条无效。
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
 * 这不是限速，而是合并：不丢失任何字节，只将同一节拍内到达的若干段合并为一次写入。
 * 正文匀速解决的是到达过快后又长时间停顿，此处解决的是到达过于密集：
 * `git log --stat -n 400` 实测 273 段 / 744ms = 每秒 367 次（2026-08-20），
 * 而每次写入都要重新渲染整个 `<pre>` 并写一次 `scrollTop`（强制回流）。
 * 主线程被该频率占满时，正文的 50ms 定时器随之被推迟，结果是正文有数据却不更新。
 *
 * 使用与正文相同的 `TICK_MS`：两个不同步的周期叠加会产生拍频（见 `reparseSkip`），
 * 同一节拍则始终对齐。
 *
 * 按 stepId 分别缓冲而不是只保留最后一条：一批并发工具会同时输出，合并到同一缓冲会使输出写入错误的卡片。
 */
export interface Framer {
  /** 收到一段工具输出。 */
  push(stepId: string, delta: string): void
  /** 立即写入缓冲内容。终态以及任何需要读取该 transcript 的事件之前都须调用。 */
  flush(): void
  /** 丢弃缓冲内容。切换会话、整段重新拉取时使用。 */
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
