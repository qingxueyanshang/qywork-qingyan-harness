import { createEffect, createSignal, onCleanup, onMount } from 'solid-js'
import { readSession, writeSession } from '../../lib/session.ts'
import { loadOlderConversation, viewOf } from '../../lib/store/index.ts'

/**
 * 本次页面加载中已恢复过滚动位置的会话。每个会话只恢复一次：面板放大后还原时正文重新挂载，
 * 此时仍滚动到底部（见 `App.tsx` 中卸载正文的注释）。
 */
const scrollRestored = new Set<string>()

/** 从会话索引定位到一条消息的滚动动画时长。 */
const REVEAL_MS = 260

/** 会话未跟随底部时距底部的距离（像素）的记录键；跟随底部时没有记录。 */
const scrollKey = (id: string) => `qywork.scroll:${id}`

/**
 * 会话流的底部跟随。父会话与右侧子会话共用：正文追加、思考展开、工具卡片补充输出
 * 都会改变实际 DOM 高度，因此按高度变化判断，不按字段逐项列举可能增高的内容。
 */
export function createConversationScroll(conversationId: () => string | null) {
  let scroller!: HTMLDivElement
  let inner!: HTMLDivElement
  const [pinned, setPinned] = createSignal(true)
  // 跟随底部时只经 `writeTop` 定位；回看时让浏览器补偿屏幕外条目完成布局后的高度变化。
  createEffect(() => {
    if (scroller) scroller.style.overflowAnchor = pinned() ? 'none' : 'auto'
  })
  let scrollIntent = false
  let scrollbarDrag = false
  /**
   * 一次触摸手势是否已发生滑动：`touchmove` 置位，下一次 `touchstart` 复位。
   *
   * 不要与 `scrollIntent` 合并为「每个 scroll 事件消耗一次」：触摸滚动开始后 `touchmove` 的派发
   * 被节流，手指离开后的惯性滚动没有 `touchmove`，这些 scroll 事件都没有新的意图标记。
   * 在 `touchstart` 复位，使点击展开 `<details>` 引起的滚动不被视为用户滚动。
   */
  let touchScroll = false
  /** 最近一次已知的 scrollTop：上一个 scroll 事件中的值，或经 `writeTop` 写入后的值。用于判定滚动方向。 */
  let lastTop = -1
  /**
   * `writeTop` 最近一次写入的 scrollTop，取写入后重新读取的值；`-1` 表示尚未写入。
   *
   * 必须在写入后重新读取：浏览器把写入值限制在 `scrollHeight - clientHeight` 以内，
   * 记录未经限制的值时，`onScroll` 中「本次滚动由 `writeTop` 写入」的判定永远不成立。
   */
  let followTop = -1

  /** 写入 scrollTop 并记录浏览器实际采用的值。 */
  const writeTop = (top: number) => {
    scroller.scrollTop = top
    followTop = scroller.scrollTop
    lastTop = followTop
  }

  const stickToBottom = () => writeTop(scroller.scrollHeight)

  /** 在顶部插入一页历史后补偿新增高度，使点击前视口中的第一行保持在原位置。 */
  const loadOlderAnchored = async () => {
    const id = conversationId()
    if (!id) return
    const beforeHeight = scroller.scrollHeight
    const beforeTop = scroller.scrollTop
    setPinned(false)
    const loaded = await loadOlderConversation(id)
    if (!loaded || conversationId() !== id) return
    // Markdown 的 effect 与布局在下一帧才全部完成。只等待一个 microtask 时，
    // ResizeObserver 可能在补偿之后收到后续的高度变化并移动视口。
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    writeTop(beforeTop + (scroller.scrollHeight - beforeHeight))
  }

  /*
   * 是否跟随底部只由用户的滚动手势决定，不由单次 scroll 事件中的几何位置决定。
   *
   * `scroll` 事件不一定来自用户滚动：展开 `<details>` 后，浏览器为保持焦点与滚动锚点会
   * 自行调整 scrollTop；ResizeObserver 回调中的底部跟随写入也会派发 scroll。把这些事件
   * 视为用户向上滚动时，展开思考即关闭跟随，此后的新内容全部位于视口下方。
   *
   * 因此 wheel、滚动键与拖动滚动条先记录一次滚动意图，其后的 scroll 事件才能修改
   * `pinned`；触摸滑动的标记在整个手势及其惯性滚动期间有效（见 `touchScroll`）。
   * 没有手势来源的 scroll 保持原状态，内容增长时继续跟随底部。
   *
   * 实测（真实服务端与前端，测试 provider 驱动一轮四步）：跟随在第 5 秒被关闭，
   * 此后 379 个无变化的帧稳定停在距底部 253px 处，新内容全部位于视口下方，读数条移出屏幕。
   * 不要用 `position: sticky` 固定读数条：被固定的只有读数条，滚动位置仍距底部
   * 两百多像素，正文仍不可见，跳动变为每次内容变矮时回弹一次。
   *
   * 关闭跟随须同时满足：有手势来源、scrollTop 不是 `writeTop` 写入的值、且比上一次已知的值小。
   * 不要只按 `gap > 2` 关闭：scroll 事件晚于写入一帧派发，其间新内容使 scrollHeight 增加，
   * `writeTop` 写入后派发的那次 scroll 读到的 `gap` 已大于 2，而 scrollTop 没有变化。
   * `writeTop` 写入派发的 scroll 不消耗 `scrollIntent`，否则手势自身的 scroll 到达时已没有意图标记，
   * 下一次高度变化把视口写回底部。
   *
   * `followTop` 用于识别 `writeTop` 的写入；用户恰好滚动回该位置时以手势为准，不能
   * 因数值相等而漏掉重新跟随底部。2px 容差仅用于吸收小数像素。
   */
  const onScroll = () => {
    const top = scroller.scrollTop
    const mine = Math.abs(top - followTop) < 1
    const gap = scroller.scrollHeight - top - scroller.clientHeight
    const gesture = scrollIntent || scrollbarDrag || touchScroll
    if (gap <= 2) {
      if (gesture || !mine) setPinned(true)
    } else if (gesture && !mine && top < lastTop) setPinned(false)
    if (!mine) scrollIntent = false
    lastTop = top
    const id = conversationId()
    if (id) writeSession(scrollKey(id), pinned() ? undefined : gap)
    // 回看到顶部时加载更早一页。按位置判定，不要求 `scrollIntent`：平滑滚动时一次滚轮派发
    // 多个 scroll 事件，只有第一个带有滚动意图。跟随底部时位于顶部只说明内容不足一屏，
    // 此时不触发：`loadOlderAnchored` 会关闭跟随，此后的新内容位于视口下方。
    if (!pinned() && scroller.scrollTop <= 2) void loadOlderAnchored()
  }

  /*
   * 刷新前未跟随底部时，恢复到刷新前距底部的距离。在历史首页加载完成后执行；
   * 已加载的内容不足该距离时继续加载更早的记录，全部加载后仍不足时停在顶部。
   * 按距底部的距离而不是 scrollTop 恢复：刷新后只加载最近一页，顶部的内容与刷新前不同。
   */
  const restoreGap = async (id: string, gap: number) => {
    setPinned(false)
    for (;;) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
      if (conversationId() !== id) return
      const top = scroller.scrollHeight - scroller.clientHeight - gap
      if (top >= 0 || viewOf(id).history.nextCursor === null) {
        writeTop(Math.max(0, top))
        return
      }
      if (!(await loadOlderConversation(id))) return
    }
  }
  createEffect(() => {
    const id = conversationId()
    if (!id || scrollRestored.has(id) || viewOf(id).history.loading !== null) return
    scrollRestored.add(id)
    const gap = readSession<number>(scrollKey(id))
    if (gap) void restoreGap(id, gap)
  })

  /**
   * 把指定 id 的用户输入定位到视口顶部（留 16px），并停止跟随底部。
   *
   * 该条尚未加载时逐页加载更早的记录，直到它出现在会话流中；加载失败或已到最早一页仍未出现时不滚动。
   *
   * 位移用 `REVEAL_MS` 的减速动画完成，逐帧经 `writeTop` 写入：不要改用 `scrollTo({ behavior: 'smooth' })`，
   * 浏览器的平滑滚动派发的 scroll 事件不是 `writeTop` 写入的值，`onScroll` 无法把它与用户滚动区分。
   *
   * 目标位置每帧重新读取：屏幕外的条目按占位高度参与布局，进入视口后高度改为实际值，
   * 起始时算出的目标会过期。动画结束后的下一帧再定位一次，原因相同。
   * 用户在动画期间滚动（滚轮、滚动键、拖动滚动条、触摸）时动画终止，位置交还用户。
   */
  let revealRun = 0
  const userRow = (id: string) =>
    [...scroller.querySelectorAll<HTMLElement>('.row.user[data-turn]')].find(
      (el) => el.dataset.turn === id,
    )
  const reveal = async (id: string) => {
    setPinned(false)
    scrollIntent = false
    const run = ++revealRun
    const conversation = conversationId()
    let found = userRow(id)
    while (!found && conversation) {
      if (!(await loadOlderConversation(conversation))) return
      if (run !== revealRun || conversationId() !== conversation) return
      found = userRow(id)
    }
    if (!found) return
    const row = found
    const target = () =>
      scroller.scrollTop +
      row.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      16
    const from = scroller.scrollTop
    const startedAt = performance.now()
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const step = () => {
      if (run !== revealRun || scrollIntent || scrollbarDrag || !row.isConnected) return
      const t = still ? 1 : Math.min(1, (performance.now() - startedAt) / REVEAL_MS)
      writeTop(from + (target() - from) * (1 - (1 - t) ** 3))
      if (t < 1) requestAnimationFrame(step)
      else
        requestAnimationFrame(() => {
          if (run === revealRun && !scrollIntent && !scrollbarDrag && row.isConnected) {
            writeTop(target())
          }
        })
    }
    step()
  }

  const onWheel = () => {
    scrollIntent = true
  }
  const onTouchStart = () => {
    touchScroll = false
    revealRun++
  }
  const onTouchMove = () => {
    touchScroll = true
  }
  const onPointerDown = (event: PointerEvent) => {
    // 点击正文（包括 details 的 summary）不是滚动意图；只有拖动滚动条时事件目标是滚动容器本身。
    if (event.target === scroller) scrollbarDrag = true
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (
      event.key === ' ' &&
      event.target instanceof Element &&
      event.target.closest('summary, button, input, textarea, select, a')
    ) {
      // Space 在这些控件上表示点击或展开，不表示翻页；用键盘展开思考不得关闭底部跟随。
      return
    }
    if (
      event.key === 'ArrowUp' ||
      event.key === 'ArrowDown' ||
      event.key === 'PageUp' ||
      event.key === 'PageDown' ||
      event.key === 'Home' ||
      event.key === 'End' ||
      event.key === ' '
    ) {
      scrollIntent = true
    }
  }

  /*
   * 跟随底部时，滚动位置随新内容移动。触发条件是内容的实际高度变化，而不是 store 中
   * 某些字段变化：工具卡片执行完毕后才填入参数表和输出，图片解码完成后才占据高度，
   * 代码块需等待高亮完成。只监听字段时无法覆盖这些情况，新到达的文字停留在视口下方。
   *
   * ResizeObserver 的回调在布局之后、绘制之前执行，因此补偿在同一帧内完成，
   * 中间状态不会被绘制。
   *
   * 两个容器都需要监听：除内容变高外，滚动区自身变矮（窗口缩小、输入框变高）同样会把
   * 末尾内容推到视口下方，此时 `inner` 的高度不变，只监听 `inner` 会遗漏这种情况。
   *
   * 必须按 border box 监听 `inner`。默认的 content box 不含内边距，而 `inner` 的
   * 下内边距随整轮状态条是否显示而变化（`transcript.css` 的三档留白）：状态条出现时
   * 留白增加而 content box 不变，回调不触发，滚动位置停在原处，状态条遮住读数条，
   * 需手动滚动才能恢复。
   *
   * 本次高度变化之前视口已在底部时同样跟随，并恢复 `pinned`。只按 scroll 事件恢复时，
   * 用户滑回底部的那次 scroll 晚于内容增高派发，读到的距离已大于 2px，跟随不恢复，
   * 此后的新内容全部位于视口下方。`knownMax` 是上一次回调时 scrollTop 的上限。
   */
  onMount(() => {
    let knownMax = Number.POSITIVE_INFINITY
    const ro = new ResizeObserver(() => {
      if (pinned() || scroller.scrollTop >= knownMax - 2) {
        setPinned(true)
        stickToBottom()
      }
      knownMax = scroller.scrollHeight - scroller.clientHeight
    })
    ro.observe(inner, { box: 'border-box' })
    ro.observe(scroller)
    const endScrollbarDrag = () => {
      scrollbarDrag = false
    }
    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('touchstart', onTouchStart, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: true })
    scroller.addEventListener('pointerdown', onPointerDown)
    scroller.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerup', endScrollbarDrag)
    window.addEventListener('pointercancel', endScrollbarDrag)
    onCleanup(() => {
      ro.disconnect()
      scroller.removeEventListener('wheel', onWheel)
      scroller.removeEventListener('touchstart', onTouchStart)
      scroller.removeEventListener('touchmove', onTouchMove)
      scroller.removeEventListener('pointerdown', onPointerDown)
      scroller.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('pointerup', endScrollbarDrag)
      window.removeEventListener('pointercancel', endScrollbarDrag)
    })
  })

  return {
    scrollerRef: (el: HTMLDivElement) => {
      scroller = el
    },
    innerRef: (el: HTMLDivElement) => {
      inner = el
    },
    scroller: () => scroller,
    onScroll,
    loadOlderAnchored,
    reveal,
  }
}
