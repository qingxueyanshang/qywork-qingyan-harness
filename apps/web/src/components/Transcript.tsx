import type { RunUsage, StopReason, SubagentKind } from '@qywork/core'
import {
  formatCosts,
  retryAttemptText,
  retryCauseText,
  runCosts,
  SUBAGENT_KIND_LABEL,
} from '@qywork/core'
import type { Accessor, JSX, Setter } from 'solid-js'
import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  createUniqueId,
  For,
  Index,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
  untrack,
  useContext,
} from 'solid-js'
import { desktopWindowLabel } from '../lib/desktop-target.ts'
import { createStreamRenderer, renderMarkdown } from '../lib/markdown.ts'
import {
  actionLabel,
  buildRenderItems,
  delegationStatus,
  groupTitle,
  type RenderItem,
  sameRenderItem,
} from '../lib/render-items.ts'
import { readSession, writeSession } from '../lib/session.ts'
import {
  argsRows,
  clamp,
  collapseCarriageReturns,
  compact,
  delegateGraph,
  diffFrom,
  displayTarget,
  fileDelta,
  firstLine,
  firstString,
  type GraphNode,
  hitRate,
  listOf,
  readRange,
  resultImages,
  sanitizeTarget,
  statusWord,
  stopReasonLabel,
  todosOf,
} from '../lib/step-view.ts'
import {
  browserTabLabel,
  composerStackAbove,
  foldOpen,
  fontScale,
  hasRunStatus,
  isConversationRunning,
  isRunning,
  loadOlderConversation,
  retryConversationHistory,
  runClosed,
  seedFoldOpen,
  setFoldOpen,
  setState,
  state,
  type TranscriptItem,
  transcript,
  view,
  viewOf,
} from '../lib/store/index.ts'
import { openCliTab, openConversationTab } from '../lib/store/ui.ts'
import { reparseSkip } from '../lib/stream-pace.ts'
import { AttachmentThumb } from './AttachmentThumb.tsx'
import { IconChevron, IconSpinner } from './Icons.tsx'
import { TodoList } from './TodoList.tsx'

/** 会话历史的加载状态：首次加载提示、失败重试，以及按需加载更早的轮次。 */
export function ConversationHistoryBoundary(props: {
  conversationId: string
  onLoadOlder?: () => void | Promise<void>
}) {
  const history = () => viewOf(props.conversationId).history
  const loadOlder = () =>
    props.onLoadOlder ? props.onLoadOlder() : loadOlderConversation(props.conversationId)

  return (
    <Show
      when={
        (history().loading !== 'unloaded' && history().loading !== null) ||
        history().error !== null ||
        history().nextCursor !== null
      }
    >
      <div class="history-boundary" aria-live="polite">
        <Show when={history().loading === 'initial'}>
          <span class="history-note">
            <IconSpinner size={13} />
            正在加载会话…
          </span>
        </Show>
        <Show when={history().loading === 'older'}>
          <button class="history-button" type="button" disabled>
            <IconSpinner size={13} />
            正在加载更早记录…
          </button>
        </Show>
        <Show when={history().error}>
          {(error) => (
            <div class="history-error" role="alert">
              <span>历史记录加载失败：{error().message}</span>
              <button
                class="btn-ghost sm"
                type="button"
                onClick={() => void retryConversationHistory(props.conversationId)}
              >
                重试
              </button>
            </div>
          )}
        </Show>
        <Show
          when={
            history().loading === null && history().error === null && history().nextCursor !== null
          }
        >
          <button class="history-button" type="button" onClick={() => void loadOlder()}>
            加载更早记录
          </button>
        </Show>
      </div>
    </Show>
  )
}

/**
 * 本次页面加载中已恢复过滚动位置的会话。每个会话只恢复一次：面板放大后还原时正文重新挂载，
 * 此时仍滚动到底部（见 `App.tsx` 中卸载正文的注释）。
 */
const scrollRestored = new Set<string>()

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
  // 跟随底部时只由本组件定位；回看时让浏览器补偿屏幕外条目完成布局后的高度变化。
  createEffect(() => {
    if (scroller) scroller.style.overflowAnchor = pinned() ? 'none' : 'auto'
  })
  let scrollIntent = false
  let scrollbarDrag = false
  /**
   * 本组件最近一次写入的 scrollTop，取写入后重新读取的值；`-1` 表示尚未写入。
   *
   * 必须在写入后重新读取：浏览器把写入值限制在 `scrollHeight - clientHeight` 以内，
   * 记录未经限制的值时，`onScroll` 中「本次滚动由本组件写入」的判定永远不成立。
   */
  let followTop = -1

  const stickToBottom = () => {
    scroller.scrollTop = scroller.scrollHeight
    followTop = scroller.scrollTop
  }

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
    scroller.scrollTop = beforeTop + (scroller.scrollHeight - beforeHeight)
    followTop = scroller.scrollTop
  }

  /*
   * 是否跟随底部只由用户的滚动手势决定，不由单次 scroll 事件中的几何位置决定。
   *
   * `scroll` 事件不一定来自用户滚动：展开 `<details>` 后，浏览器为保持焦点与滚动锚点会
   * 自行调整 scrollTop；ResizeObserver 回调中的底部跟随写入也会派发 scroll。把这些事件
   * 视为用户向上滚动时，展开思考即关闭跟随，此后的新内容全部位于视口下方。
   *
   * 因此 wheel、touch、滚动键与拖动滚动条先记录一次滚动意图，其后的 scroll 事件才能修改
   * `pinned`。没有手势来源的 scroll 保持原状态，内容增长时继续跟随底部。
   *
   * 实测（真实服务端与前端，测试 provider 驱动一轮四步）：跟随在第 5 秒被关闭，
   * 此后 379 个无变化的帧稳定停在距底部 253px 处，新内容全部位于视口下方，读数条移出屏幕。
   * 不要用 `position: sticky` 固定读数条：被固定的只有读数条，滚动位置仍距底部
   * 两百多像素，正文仍不可见，跳动变为每次内容变矮时回弹一次。
   *
   * `followTop` 仍用于识别本组件自身的写入；用户恰好滚动回该位置时以手势为准，不能
   * 因数值相等而漏掉重新跟随底部。2px 容差仅用于吸收小数像素。
   */
  const onScroll = () => {
    const mine = Math.abs(scroller.scrollTop - followTop) < 1
    const gap = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight
    if (scrollIntent || scrollbarDrag) setPinned(gap <= 2)
    else if (!mine && gap <= 2) setPinned(true)
    scrollIntent = false
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
        scroller.scrollTop = Math.max(0, top)
        followTop = scroller.scrollTop
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

  const onWheel = () => {
    scrollIntent = true
  }
  const onTouchMove = () => {
    scrollIntent = true
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
   */
  onMount(() => {
    const ro = new ResizeObserver(() => {
      if (pinned()) stickToBottom()
    })
    ro.observe(inner, { box: 'border-box' })
    ro.observe(scroller)
    const endScrollbarDrag = () => {
      scrollbarDrag = false
    }
    scroller.addEventListener('wheel', onWheel, { passive: true })
    scroller.addEventListener('touchmove', onTouchMove, { passive: true })
    scroller.addEventListener('pointerdown', onPointerDown)
    scroller.addEventListener('keydown', onKeyDown)
    window.addEventListener('pointerup', endScrollbarDrag)
    window.addEventListener('pointercancel', endScrollbarDrag)
    onCleanup(() => {
      ro.disconnect()
      scroller.removeEventListener('wheel', onWheel)
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
    onScroll,
    loadOlderAnchored,
  }
}

/**
 * 一条会话的完整视口。主会话与右侧子会话只在宽度、留白与附加提示上不同；历史、
 * 正文、流式判定、滚动状态机与运行条都在此渲染，避免两处实现不一致。
 */
export function ConversationStream(props: {
  conversationId: string | null
  items: TranscriptItem[]
  live: () => boolean
  closed: () => boolean
  variant: 'main' | 'panel'
  leading?: JSX.Element
  trailing?: JSX.Element
  stacked?: boolean
  hasRunStatus?: boolean
}) {
  const follow = createConversationScroll(() => props.conversationId)
  const main = () => props.variant === 'main'
  const background = createMemo(() =>
    props.live() && props.closed() ? delegationStatus(props.items) : null,
  )

  return (
    <div
      class="conversation-scroll"
      classList={{ transcript: main(), 'child-cv': !main() }}
      ref={follow.scrollerRef}
      onScroll={follow.onScroll}
    >
      <div
        class="conversation-stream-inner"
        classList={{
          'transcript-inner': main(),
          'child-cv-inner': !main(),
          'with-stack': !!props.stacked,
          'with-run-status': !!props.hasRunStatus,
        }}
        ref={follow.innerRef}
      >
        {props.leading}
        <Show when={props.conversationId}>
          {(id) => (
            <ConversationHistoryBoundary
              conversationId={id()}
              onLoadOlder={follow.loadOlderAnchored}
            />
          )}
        </Show>
        <TranscriptRows
          items={props.items}
          live={props.live}
          generatingToolCall={() =>
            props.conversationId ? viewOf(props.conversationId).generatingToolCall : false
          }
        />
        {props.trailing}
        {/* 本轮用量显示在收尾条中，后台任务只显示节点进度。 */}
        <Show when={background()}>
          {(status) => <output class="delegation-status">{status()}</output>}
        </Show>
        <Show when={props.live() && !props.closed() && props.conversationId}>
          <LiveRunBar conversationId={props.conversationId!} />
        </Show>
      </div>
    </div>
  )
}

/**
 * 会话流。
 *
 * 读数条（`LiveRunBar`）是会话流的最后一项内容，随会话流一起滚动，向上滚动时移出视口，
 * 不固定在底边。它与输入框之间的固定间距由 `.transcript-inner` 的下内边距提供。
 * 内容增长时读数条保持可见，依靠共享的底部跟随实现，而不是 CSS 固定定位。
 */
export function Transcript() {
  return (
    <ConversationStream
      conversationId={state.activeConversation}
      items={transcript()}
      live={isRunning}
      closed={runClosed}
      variant="main"
      stacked={composerStackAbove()}
      hasRunStatus={hasRunStatus()}
      trailing={
        <>
          {/*
           * 没有对应 run 收尾条的错误。
           *
           * 错误正文通常显示在读数条中（`run.finished` 时合并进该轮的条目），每条信息只显示一处。
           * 此处只显示其余情况：`run.error` 之后没有 `run.finished` 的错误，即未配置 key、
           * 档案解析失败、会话已有任务在运行、未找到项目目录。
           * 这些错误没有 run 行，不在此处显示就完全不可见。
           *
           * 不提供引导文案与重试按钮：正文已说明下一步操作
           * （`ai/src/errors.ts` 的分类文案按用户的下一步操作编写），
           * 再加一句即为重复；需要重新发送时使用输入框。
           */}
          <Show when={view().error}>
            {(e) => (
              <div class="error-card" role="alert">
                {e().message}
              </div>
            )}
          </Show>

          {/* 指令被拒绝的回执。按 fail-closed 原则，拒绝必须在界面上显示。
            使用 <output> 而不是 div + role="status"：两者隐含语义相同，前者少一个属性。 */}
          <Show when={state.notice}>
            {(n) => (
              <output class="notice-card">
                <span>{n().message}</span>
                <button class="btn-ghost sm" type="button" onClick={() => setState('notice', null)}>
                  关闭
                </button>
              </output>
            )}
          </Show>
        </>
      }
    />
  )
}

/**
 * 无新增内容超过该时长后，状态文字由「正在回复…」改为显示无新增内容的时长。
 *
 * 该值是保守取值，不是测量结果。账本中有整轮往返耗时的分布（p90 约 32 秒），
 * 但它衡量的是整轮，不是两个事件之间的间隔，不能用作间隔阈值。
 *
 * 取值偏大只推迟该提示出现的时间；静默期间「正在回复…」始终不属实，
 * 因此即使提示出现较晚，也必须替换该文字。
 */
const SILENT_MS = 30_000

/**
 * 本轮当前所处的阶段。
 *
 * 阶段只有一个来源：会话的当前请求投影（`store/state.ts` 的 `RequestProjection`）。
 * 实时事件与刷新快照按同一规则写入它，因此刷新前后该字段显示相同的文字。
 *
 * 该字段描述阶段，不描述动作。工具分组标题描述这一批工具的动作
 * （查询 / 读取 / 创建 / 修改 / 删除 / 运行 / 调用），两者粒度不同、内容不重复；
 * 动作词表中没有「执行」，两者不会冲突。
 *
 * 「正在执行」必须检查 `status`。只检查 `kind === 'tool'` 时，从工具执行完毕到模型返回响应的
 * 整段时间都显示「正在执行…」，而该时段最容易出错（实测一次连接中断发生在其后 262 秒内）。
 * 工具卡片有终态，据此判定：运行中表示正在执行，执行完毕表示正在等待响应。工具运行期间
 * 不显示静默时长：一次构建持续十分钟属于正常情况，且构建本身会输出 stdout。
 *
 * 等待时长按阶段取各自的起始时刻：已产出内容时取 `lastContentAt`，尚未产出内容时取
 * 该阶段的 `sentAt` / `headersAt`。把阶段等待显示为「无新增内容」，会对一次从未产出内容的
 * 请求报告一个不存在的内容间隔。缺少时刻时不显示秒数，不以页面加载时刻或首个内容时刻代替。
 */
function liveStatus(now: number, conversationId: string): string {
  const current = viewOf(conversationId)
  const items = current.transcript
  const last = items[items.length - 1]

  /*
   * 连接状态不是 ready 时，该字段不显示内容。
   *
   * 下方「已 N 秒…」的文字在字面上仍然成立，但会把服务端断开表述为响应缓慢：
   * 用户会继续等待，而此时服务端已不可用，停止按钮也无法生效。
   * 连接状态由顶部的连接横幅显示（含重试倒计时）；此处再显示一次即形成两份文案，
   * 日后会出现不一致。
   */
  if (state.connection !== 'ready') return ''
  if (last?.kind === 'tool' && last.status === 'running') return '正在执行…'

  const req = current.request
  if (!req) return '正在请求…'
  const waiting = (message: string): string =>
    req.attempt > 0
      ? [
          retryAttemptText(req),
          message,
          ...(req.retryReason ? [retryCauseText(req.retryReason)] : []),
        ].join(' · ')
      : message
  switch (req.phase) {
    case 'backoff': {
      if (req.backoffUntil === null) return waiting('等待重试…')
      // 倒计时仅用于显示：重发由服务端按同一截止时刻发起，前端在倒计时归零时不执行任何操作。
      return waiting(`等待重试，${Math.max(0, Math.ceil((req.backoffUntil - now) / 1000))} 秒后…`)
    }
    case 'sent':
    case 'headers': {
      const since = req.phase === 'sent' ? req.sentAt : req.headersAt
      if (since !== null && now - since >= SILENT_MS) {
        return waiting(`已 ${Math.round((now - since) / 1000)} 秒没有响应`)
      }
      if (req.phase === 'headers' || req.attempt > 0) return waiting('等待响应…')
      return '正在请求…'
    }
    case 'content': {
      if (req.lastContentAt !== null && now - req.lastContentAt >= SILENT_MS) {
        return waiting(`已 ${Math.round((now - req.lastContentAt) / 1000)} 秒无新增内容`)
      }
      // 上游仍在发送工具参数时，用户长时间看不到新内容的情况同样需要显示。
      // 旧快照中的请求没有 `lastVisibleAt`，不以首个内容时刻推测可见进展。
      const visibleSince = req.lastVisibleAt ?? req.headersAt ?? req.sentAt
      if (req.lastContentKind != null && visibleSince !== null && now - visibleSince >= SILENT_MS) {
        return waiting(`等待响应，已 ${Math.round((now - visibleSince) / 1000)} 秒无可见进展`)
      }
      // 内容类别取自请求投影；旧快照没有类别时，回退为按最后一条 transcript 判定。
      if (req.lastContentKind === 'tool_arguments' || req.lastContentKind === 'other')
        return waiting('等待响应…')
      if (req.lastContentKind === 'thinking') return '正在思考…'
      if (req.lastContentKind === 'text') return '正在回复…'
      if (current.generatingToolCall) return '等待响应…'
      if (last?.kind === 'thinking') return '正在思考…'
      if (last?.kind === 'text') return '正在回复…'
      return '等待响应…'
    }
  }
}

/**
 * assistant 正文。
 *
 * 只有运行中的最后一条按流式渲染（`createStreamRenderer`）；
 * 定稿后整段重新渲染一次，纠正增量解析的已知偏差。
 *
 * 不要在此处再加一层限速。正文写入 store 的节奏已由 `stream-pace.ts` 确定：每 50ms 一档，
 * 每档按上游流速释放若干字符。在此之上再加一个定时器时，两级叠加的结果是：首次变化设置
 * 60ms 的 timer，期间的变化被合并，执行后 timer 清空，下一次变化再设置 60ms，稳态变为
 * 每 100ms 更新一次、每次包含两档的内容。20Hz 的匀速更新降为 10Hz 的跳变，正文成批出现，
 * 而不是连续输出。
 *
 * DOM 只更新活动区。已定稿的块插入容器后不再修改，每档只删除其后的节点并重新插入活动区。
 * 不要把两个区各包一层 `<div>`：`transcript.css` 的 `.markdown > :first-child` /
 * `:last-child` / `p:last-child` 按容器的直接子元素编写，多包一层后这三条规则全部失效
 * （首尾外边距无法折叠，两个区之间出现多余间距）。
 *
 * 整段替换 `innerHTML` 的代价不止重建节点：33KB 的 HTML 实测 7.8ms、66KB 为 15.5ms
 * （2026-08-20，真实 Chromium），且流式输出期间用户选中的文字每档被清除一次，无法复制。
 */
function Prose(props: { item: TranscriptItem }) {
  const row = useContext(RowStream)
  /*
   * 必须使用 memo，不能使用普通取值函数。
   *
   * 它读取的两个值都随本列增长而变化：该流是否在运行，以及末项 id。每追加一条
   * （每次工具启动、每条用户消息、每条收尾读数）两者都会通知一次，而 effect 依据
   * 依赖是否通知决定是否重新执行，不比较取值是否变化。使用普通取值函数时，会话中每一段
   * 已定稿的正文都会在每次追加时重新执行 `renderMarkdown` 并整段替换 innerHTML。
   * 逐帧实测（真实服务端与前端，两轮四步）：一段 80 个节点的正文定稿后又被整段
   * 重建 9 次，其中 5 次集中在收尾的同一毫秒内。memo 按值去重，只在从流式转为定稿时通知。
   */
  const streaming = createMemo(() => row.live() && row.items().at(-1)?.id === props.item.id)

  // 重新解析的频率由 `reparseSkip` 决定，判据与理由见该函数。
  const [gate, setGate] = createSignal(0)
  let sinceParse = 0
  let lastCost = 0

  createEffect(() => {
    const text = props.item.text
    if (!streaming()) {
      // 定稿时立即更新到全文，否则最后几档内容会一直停留在上一帧。
      sinceParse = 0
      setGate(text.length)
      return
    }
    sinceParse++
    if (sinceParse >= reparseSkip(lastCost)) {
      sinceParse = 0
      setGate(text.length)
    }
  })

  let host: HTMLDivElement | undefined
  const stream = createStreamRenderer()
  /** 已定稿区占用的容器开头子节点数。活动区始终是其后的节点。 */
  let settledNodes = 0

  createEffect(() => {
    gate()
    /*
     * `streaming()` 必须被订阅，不能放入下方的 `untrack`。
     *
     * 定稿时文本长度通常不变：末档的文字在 `run.finished` 之前已写入 store，
     * 因此 `gate` 写入相同的值，信号不通知。只依赖 `gate` 时整段重新渲染不会发生，
     * 而增量渲染已知偏差的纠正依赖这次重新渲染。
     * `streaming()` 不会每档变化：它读取末项 id，向末项追加文本不改变 id。
     */
    const live = streaming()
    // 只依赖 `gate`：直接读取 text 会使该 effect 依赖 text，降频随之失效。
    const text = untrack(() => props.item.text)
    if (!host) return

    const t0 = performance.now()
    if (live) {
      const chunk = stream.push(text)
      if (chunk.reset) {
        host.textContent = ''
        settledNodes = 0
      }
      for (let extra = host.childNodes.length; extra > settledNodes; extra--) {
        host.lastChild?.remove()
      }
      // 内容经 markdown.ts 净化后才写入 DOM：模型输出不可信。
      if (chunk.settled) {
        host.insertAdjacentHTML('beforeend', chunk.settled)
        settledNodes = host.childNodes.length
      }
      if (chunk.live) host.insertAdjacentHTML('beforeend', chunk.live)
    } else {
      host.innerHTML = renderMarkdown(text)
      settledNodes = host.childNodes.length
    }
    lastCost = performance.now() - t0
  })

  return (
    <div class="row assistant">
      <div class="prose markdown" ref={host} />
    </div>
  )
}

/**
 * 折叠条目：思考、工具与工具组共用同一种样式。
 *
 * 不要分成三种样式（思考使用左边框、工具使用卡片、工具组使用更大的卡片）：
 * 三种样式会在同一列中交替出现，而它们在语义上属于同一类条目，即本轮中发生的、
 * 可以展开查看的事件。
 *
 * 使用原生 `<details>` 而不是自行管理 open 状态：键盘语义、`Enter` / `Space` 展开、
 * 屏幕阅读器的展开状态播报都由元素提供，自行实现 button + signal 时每一项都需补齐。
 */
/** 折叠条目在 `foldOpen` 中的 key：分组卡片与其首个成员的 id 相同，以 kind 区分。 */
function foldKey(kind: 'tool' | 'thinking' | 'group', id: string): string {
  return `${kind}:${id}`
}

function Fold(props: {
  id: string
  label: JSX.Element
  /** 终态文字。成功时不显示：一屏几十行都显示「成功」不提供任何信息。 */
  statusWord?: string
  target?: string
  /**
   * 增删的行数。不放入文本槽：文本槽负责单行省略，
   * 目标较长时这两个数会被一并截断，而它们是定宽信息。
   */
  changes?: { additions: number; deletions: number }
  /** 思考等背景信息降低一级亮度，hover 时恢复。 */
  dim?: boolean
  failed?: boolean
  /** 首次或再次展开且 DOM 挂载完成后调用；用于把仍在增长的内层内容滚动到最新位置。 */
  onOpen?: () => void
  children: JSX.Element
}) {
  /*
   * 展开与收起只由用户操作，代码不得自动展开或收起。
   *
   * 不要加 `autoOpen`（思考开始时自动展开、结束时自动收起，工具组同理）：它会使会话流
   * 持续上下跳动。`.fold-pre` 一次展开或收起改变 200px 高度，而一轮中有多段思考与
   * 多组命令，内容高度在执行过程中反复增减。实测一轮四步：会话流高度
   * 降低 5 次，幅度为 58 / 82 / 122 / 146 / 191px。
   * 停留在底部阅读的用户因此经历数百像素的往返位移，而用户没有进行任何操作。
   *
   * 收起状态并不缺少信息：思考条目的标签中含实时更新的正文摘要，工具组的标题列出
   * 执行了哪些操作。需要查看全文时由用户展开，展开后不会被自动收起。
   *
   * 展开状态的权威是 `foldOpen(id)`：`open` 绑定它，`toggle` 写回它。不要改为不绑定、
   * 由 `<details>` 自行记录：节点的生命周期由渲染投影决定，单条工具合并进分组卡片时
   * 节点被替换，记录在节点上的展开状态随之丢失。`mounted` 只记录正文是否展开过，
   * 首次展开后保持为 true，收起后再次展开不重建正文。
   */
  const open = () => foldOpen(props.id)
  const mounted = createMemo<boolean>((was) => was || open(), false)
  createEffect(() => {
    if (!open()) return
    // 正文由 mounted 在本次更新中挂载；等待 Solid 完成 DOM 更新后再交给调用方定位。
    queueMicrotask(() => props.onOpen?.())
  })
  return (
    <details
      class="fold"
      classList={{ 'fold-dim': props.dim, failed: props.failed }}
      open={open()}
      onToggle={(e) => setFoldOpen(props.id, e.currentTarget.open)}
    >
      {/* 整行不换行：文本槽负责省略，右侧的标记不收缩。 */}
      <summary class="fold-head">
        <span class="fold-summary">
          <span class="fold-label">{props.label}</span>
          <Show when={props.statusWord}>
            <span class="fold-word">{props.statusWord}</span>
          </Show>
          <Show when={props.target}>
            <span class="fold-target" data-tip={props.target}>
              · {sanitizeTarget(props.target!)}
            </span>
          </Show>
          {/* 增删行数紧跟在文件名之后，不固定在行尾：它描述的是该文件，
              隔着半行空白放在最右侧时，需要横向扫视才能把两者对应起来。
              路径较长时截断的是路径（`.fold-target` 自身收缩），这两个数不收缩。 */}
          <Show when={props.changes}>
            {(c) => (
              <span class="fold-delta">
                <span class="fold-add">+{c().additions}</span>
                <span class="fold-del">−{c().deletions}</span>
              </span>
            )}
          </Show>
        </span>
      </summary>
      <Show when={mounted()}>
        <div class="fold-body">{props.children}</div>
      </Show>
    </details>
  )
}

function ThinkingFold(props: { item: TranscriptItem }) {
  const row = useContext(RowStream)
  // 使用 memo 而不是取值函数，理由同 `Prose`：读取的两个值每追加一条就通知一次。
  const streaming = createMemo(
    () => row.live() && !row.generatingToolCall() && row.items().at(-1)?.id === props.item.id,
  )
  // 流仍在增长时显示「思考中」，停止后显示「已思考」，
  // 避免标签显示「已思考」而旁边的加载动画仍表示正在思考。
  const verb = () => (streaming() ? '思考中' : '已思考')
  // 只取开头一段再合并空白：整段思考可达数万字，每帧扫描全文会使耗时随长度增长。
  const preview = () => props.item.text.slice(0, 240).replace(/\s+/g, ' ').trim().slice(0, 80)

  /*
   * 思考块自行滚动到底部。
   *
   * `.fold-pre` 是内层滚动容器（max-height 200px），会话流的底部跟随只作用于外层。
   * 用户在思考仍在流式输出时展开它，若不跟随，它停留在第一屏，
   * 新到达的文字持续追加在视口之外，看起来像已停滞。
   *
   * 只在流式输出期间跟随：输出停止后用户向上滚动时，不应被强制滚回底部，外层同样避免这种行为。
   */
  let pre: HTMLPreElement | undefined
  const stickPreToBottom = () => {
    if (streaming() && pre) pre.scrollTop = pre.scrollHeight
  }
  createEffect(() => {
    void props.item.text
    stickPreToBottom()
  })

  return (
    <Fold
      id={foldKey('thinking', props.item.id)}
      dim
      label={preview() ? `${verb()} — ${preview()}` : verb()}
      onOpen={stickPreToBottom}
    >
      <pre class="fold-pre" ref={pre}>
        {props.item.text}
      </pre>
    </Fold>
  )
}

/**
 * 运行中的中途输出。
 *
 * 只在工具运行时出现；执行完毕后由展开内容的终态分支接替，两者不会同时存在。
 *
 * 自行滚动到底部的理由与思考块相同：`.fold-live` 是内层滚动容器，
 * 会话流的底部跟随只作用于外层，不跟随时新到达的行持续追加在视口之外。
 */
function LiveOutput(props: { item: TranscriptItem }) {
  let pre: HTMLPreElement | undefined
  createEffect(() => {
    void props.item.stdout
    if (pre) pre.scrollTop = pre.scrollHeight
  })
  return (
    <pre class="fold-live" ref={pre}>
      {collapseCarriageReturns(props.item.stdout ?? '')}
    </pre>
  )
}

/**
 * Run 收尾条：停止原因、实际用量与耗时，每轮一条。
 *
 * 数据由 props 传入，而不是读取运行中的 view：读取 `ConversationView.usage` /
 * `runStartedAt` 等会话级字段时，整个会话只有一条，第二轮执行完毕会覆盖第一轮的读数，
 * 刷新后一条也不保留。这些数字逐轮保存在 `runs` 表中，每轮一个条目、由投影层从 run 行重建。
 *
 * 执行完毕的轮次使用 `props.run`；运行中的轮次没有 run 行可读，
 * 由 `<LiveRunBar />` 读取实时状态渲染同一外壳。
 *
 * 必须遵守三条口径：
 * - 正常完成不另外显示「已完成」；只有异常停止与错误正文占用该字段。
 * - 缓存命中未知或未报告时都显示 `N/A`；provider 明确报告 0 时才显示 0。
 *   只取最后一次调用，不以上一轮的数值填补当前缺失。
 * - 计价为 0 时不显示金额，不显示 $0.0000：把未知计价显示为免费更具误导性。
 */
function RunStatusBar(props: {
  usage: RunUsage | null
  stopReason: StopReason | null
  /** 单位为秒。null 表示没有可信的起止时刻，不显示该字段。 */
  elapsed: number | null
  running: boolean
  /**
   * 运行时该字段显示的内容。
   *
   * 由调用方传入而不在此处计算：静默判定需要按当前时刻计算，而只有 `LiveRunBar`
   * 持有逐秒更新的定时器；在此处读取 `Date.now()` 时，界面不会自动更新。
   */
  liveNote?: string
  /** 错误正文或停止依据（`stopDetail`），没有时为 null。显示时它替代停止原因，而不是与停止原因并列显示。 */
  errorMessage?: string | null
}) {
  const normal = () => !props.stopReason || props.stopReason === 'completed'
  /**
   * 停止原因的文字。
   *
   * 有错误正文时显示正文：「模型服务出错」只说明了出错方，而「网络不可达：检查接口
   * 地址与代理」说明了下一步操作；两句同时显示即为重复，且该字段位于读数条末位，
   * 用途就是说明停止原因。
   *
   * 正文在读数条中单行显示、超出部分省略，悬停提示显示全文。读数条只有一行，整段换行显示会撑高该行；
   * 而报错的后半段（对端原文、故障编号、request id）在其他位置都看不到，不能只取首行。
   *
   * 以等待用户回复或完成结束的一轮，正文是待办中受阻项的条件与失败项的原因（`agent/loop/turn-end.ts` 的 `stopDetail`），
   * 待办清单每一行下方已显示同一内容：读数条不显示该正文，等待用户回复只显示停止原因的名称，完成不显示。
   */
  const detail = () =>
    props.stopReason === 'awaiting_user' || props.stopReason === 'completed'
      ? null
      : props.errorMessage?.trim() || null
  const reason = () => detail() ?? (props.stopReason ? stopReasonLabel(props.stopReason) : null)
  const showReason = () =>
    !props.running && Boolean(reason()) && (props.stopReason !== 'completed' || Boolean(detail()))

  return (
    <div class="run-strip" classList={{ done: !props.running, abnormal: !normal() }}>
      {/* 运行指示条：运行时星点流动、五段依次提亮，执行完毕后暂停动画并降低亮度。
          「运行中」与「已执行完毕」必须在视野边缘即可区分，仅靠文字变化无法做到。
          五段分别编写：每段各有一条错开延时的动画与各自的星点数。 */}
      <span class="run-galaxy" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <span />
      </span>

      <span class="run-readout">
        {/* 本轮开始的确认到达前保留耗时列，避免确认到达时后续读数发生位移。 */}
        <Show when={props.running || props.elapsed !== null}>
          <span
            class="run-metric run-elapsed"
            data-tip={props.elapsed === null ? undefined : '本轮耗时'}
            aria-hidden={props.elapsed === null}
          >
            {props.elapsed === null ? '' : `${props.elapsed.toFixed(1)}s`}
          </span>
        </Show>
        <Show when={props.usage}>
          {(usage) => (
            <>
              <span class="run-metric" data-tip="输入 / 输出 token">
                ↓{compact(usage().inputTokens)} ↑{compact(usage().outputTokens)}
              </span>
              {/* 模型调用与生成的花费合并显示，不同币种并列。计价为 0 时不显示金额：把未知计价显示为免费更具误导性。 */}
              <Show when={Object.keys(runCosts(usage())).length > 0}>
                <span class="run-metric run-cost">{formatCosts(runCosts(usage()))}</span>
              </Show>
            </>
          )}
        </Show>
        {/* 模型在 usage 生成前报错时，同样必须明确显示为未知。
            口径（取最后一次调用、区分 null 与 0）只由 `hitRate` 维护。 */}
        <span class="run-metric" data-tip="最后一次模型调用的缓存命中占输入总量的比例">
          命中 {props.usage ? hitRate(props.usage) : 'N/A'}
        </span>
        {/*
         * 「正在思考…」等运行状态位于金额之后，与停止原因占用同一字段。
         *
         * 不要把它悬浮在输入区上方：那里没有预留位置，它出现与消失会推动整个输入框，
         * 即尺寸随内容变化。该字段的用途是显示本轮状态：运行时说明正在进行的操作，
         * 执行完毕后说明停止原因，位置与语义一致。
         */}
        <Show when={props.running && props.liveNote}>
          <span class="run-live" data-tip={props.liveNote}>
            {props.liveNote}
          </span>
        </Show>
        {/* 停止原因排在末位：它长度不定，排在最前会把后续读数整体右移，
            出错的轮次与正常轮次的列无法对齐。排在末位时，前面各字段的位置固定。 */}
        <Show when={showReason()}>
          <span class="run-reason" data-tip={detail() ?? undefined}>
            {reason()}
          </span>
        </Show>
      </span>
    </div>
  )
}

/**
 * 运行中的轮次。
 *
 * 只有它需要每 100ms 更新一次的计时器，因此单独成一层：执行完毕的条目不应
 * 各自持有定时器，几十轮的会话会产生几十个持续触发的 interval，
 * 每次触发都使整个会话流重新计算。
 *
 * 停止原因恒为 null：本轮尚未停止。
 */
export function LiveRunBar(props: { conversationId: string }) {
  const [now, setNow] = createSignal(Date.now())
  // 开始时刻到达时同步时钟，避免上一帧的 now 早于新的开始时刻。
  createEffect(
    on(
      [
        () => isConversationRunning(props.conversationId),
        () => viewOf(props.conversationId).runStartedAt,
      ],
      ([running]) => {
        setNow(Date.now())
        if (!running) return
        const t = setInterval(() => setNow(Date.now()), 100)
        onCleanup(() => clearInterval(t))
      },
    ),
  )

  const elapsed = () => {
    const from = viewOf(props.conversationId).runStartedAt
    return from === null ? null : (now() - from) / 1000
  }
  return (
    <RunStatusBar
      usage={viewOf(props.conversationId).usage}
      stopReason={null}
      elapsed={elapsed()}
      running={true}
      liveNote={liveStatus(now(), props.conversationId)}
    />
  )
}

/** 执行完毕的轮次条目。耗时按落库的起止时刻计算，与实时条目的含义相同。 */
function RunCard(props: { item: TranscriptItem }) {
  const run = () => props.item.run
  const elapsed = () => {
    const r = run()
    return r?.endedAt == null ? null : (r.endedAt - r.startedAt) / 1000
  }

  return (
    <Show when={run()}>
      {(r) => (
        <RunStatusBar
          usage={r().usage}
          stopReason={r().stopReason}
          elapsed={elapsed()}
          running={false}
          errorMessage={r().errorMessage}
        />
      )}
    </Show>
  )
}

/**
 * 上下文压缩事件。
 *
 * 压缩不能静默发生：用户需要能据此判断模型为何不再记得之前的内容。
 * 失败必须醒目：压缩失败意味着上下文仍然已满，下一轮很可能直接报错。
 */
function CompactionCard(props: { item: TranscriptItem }) {
  const c = () => props.item.compaction
  const label = () => {
    const phase = c()?.phase
    if (phase === 'started') return '正在压缩上下文'
    if (c()?.reasonCode === 'aborted') return '压缩已停止'
    if (phase === 'skipped') return compactionSkipLabel(c()?.reasonCode)
    if (phase === 'failed') return compactionFailureLabel(c()?.reasonCode)
    // 必须区分三种结果：只收纳（未调用模型）、压缩完成、已收纳但摘要未完成。
    // 都显示为「已压缩」时，未调用模型的收纳与完整压缩在界面上无法区分。
    if (c()?.summarized === false) {
      return c()?.reasonCode ? '上下文已收纳，摘要未完成' : '上下文已收纳，未调用模型'
    }
    const n = c()?.compactedMessages
    return n ? `上下文已压缩，折叠 ${n} 轮` : '上下文已压缩'
  }
  return (
    <div
      class="compaction"
      classList={{ failed: c()?.phase === 'failed' && c()?.reasonCode !== 'aborted' }}
    >
      <span>{label()}</span>
      <Show when={c()?.phase === 'started'}>
        <div class="compaction-progress" role="progressbar" aria-label="正在压缩上下文">
          <For each={['preparing', 'summarizing', 'saving']}>
            {(stage, index) => (
              <span
                classList={{
                  complete:
                    index() < (c()?.stage === 'saving' ? 2 : c()?.stage === 'summarizing' ? 1 : 0),
                  active: stage === (c()?.stage ?? 'preparing'),
                }}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

/** 没有可压缩的内容。这不是失败，因此不以红色显示，措辞也不含「失败」。 */
function compactionSkipLabel(code: string | undefined): string {
  const map: Record<string, string> = { nothing_to_fold: '无可压缩内容' }
  return (code && map[code]) || '无可压缩内容'
}

/**
 * 压缩失败的文字。未知的原因码不显示：`reasonCode` 是供日志使用的英文标识，
 * 在括号中显示 `empty_summary` 不向用户提供有效信息。
 */
function compactionFailureLabel(code: string | undefined): string {
  const map: Record<string, string> = {
    summary_empty: '压缩失败：摘要为空',
    summary_error: '压缩失败：摘要调用出错',
    no_headroom: '压缩失败：没有可用空间',
    not_smaller: '压缩失败：摘要未比原内容更短',
    over_budget: '压缩失败：摘要过长',
  }
  return (code && map[code]) || '压缩失败'
}

/**
 * 会话流的正文行。父会话与右侧面板中的只读子会话共用同一实现：
 * 分别渲染时，新增一种条目必然遗漏其中一处。
 *
 * 滚动跟随不在行组件中：父页与子页各自的滚动容器都调用 `createConversationScroll`。
 */
/**
 * 本列正文所属的流，以及该流是否仍在增长。
 *
 * `Prose` 与 `ThinkingFold` 判定某一条是否仍在流式输出时，必须与本列的末项比较。默认是
 * 当前会话的列；右侧子会话页传入子会话自身的列。与当前会话的末项比较时，子会话的每一段
 * 正文都会被判定为已定稿，每到达一批文字就整段重新排版一次。
 */
const RowStream = createContext<{
  items: () => TranscriptItem[]
  live: () => boolean
  generatingToolCall: () => boolean
}>({
  items: transcript,
  live: isRunning,
  generatingToolCall: () => false,
})

/**
 * 六行用户正文在默认字体大小下的高度：`--fs-prose` 13.5px × 1.55 行高 × 6，取整为 126px。
 * 修改 `.bubble` 的字号或行高时必须同步修改此值。实际高度随字体大小设置按比例变化。
 */
const USER_MESSAGE_PREVIEW_HEIGHT = 126
const userMessagePreviewHeight = () => Math.round(USER_MESSAGE_PREVIEW_HEIGHT * fontScale())

/**
 * 用户消息只在实际渲染高度超过六行时折叠。正文仍是 transcript 的原投影；此处的
 * `expanded` 只决定该气泡的显示高度，不修改消息、不截断文字，也不参与同步或持久化。
 */
function UserBubble(props: { text: string }) {
  let copy!: HTMLDivElement
  const copyId = `user-message-${createUniqueId()}`
  const [collapsible, setCollapsible] = createSignal(false)
  const [expanded, setExpanded] = createSignal(false)

  onMount(() => {
    // 观察未裁剪正文的布局结果，避免挂载每条消息时同步读取高度并强制布局。
    const observer = new ResizeObserver(([entry]) => {
      if (!entry) return
      const next = entry.contentRect.height > userMessagePreviewHeight() + 1
      setCollapsible(next)
      if (!next) setExpanded(false)
    })
    observer.observe(copy)
    onCleanup(() => observer.disconnect())
  })

  const size = () => Array.from(props.text).length

  return (
    <div
      class="bubble"
      classList={{ collapsible: collapsible(), expanded: expanded() }}
      style={{ '--user-message-preview-height': `${userMessagePreviewHeight()}px` }}
    >
      <div id={copyId} class="user-bubble-viewport">
        <div class="user-bubble-copy" ref={copy}>
          {props.text}
        </div>
      </div>
      <Show when={collapsible()}>
        <button
          class="user-bubble-toggle"
          type="button"
          aria-expanded={expanded()}
          aria-controls={copyId}
          on:click={() => setExpanded((value) => !value)}
        >
          <span>{expanded() ? '收起' : '展开全部'}</span>
          <span class="user-bubble-size">· {size()} 字</span>
          <IconChevron size={12} dir={expanded() ? 'up' : 'down'} />
        </button>
      </Show>
    </div>
  )
}

/** 一行的固定行对象：`<For>` 按它匹配，内容从 `node` 读取；同一 id 只对应一个行对象。 */
interface RenderRow {
  id: string
  node: Accessor<RenderItem>
}

/**
 * 把每轮新生成的投影转换为按 id 固定的行对象。行对象中的信号以 `sameRenderItem` 为相等判据，
 * 内容未变时不通知。不要把 `buildRenderItems` 的结果直接交给 `<For>`：`<For>` 按引用匹配，
 * 分组卡片每增加一个成员、workflow 折叠项每收到一个进度事件都会生成新对象，整行 DOM 被销毁
 * 重建，已展开的折叠条目被收起，连线的虚线动画从头开始。
 */
function keyedRows(source: () => RenderItem[]): Accessor<RenderRow[]> {
  let cells = new Map<string, { row: RenderRow; set: Setter<RenderItem> }>()
  return createMemo(() => {
    const next = new Map<string, { row: RenderRow; set: Setter<RenderItem> }>()
    const rows = source().map((item) => {
      let cell = cells.get(item.id)
      if (cell) cell.set(item)
      else {
        const [node, set] = createSignal(item, { equals: sameRenderItem })
        cell = { row: { id: item.id, node }, set }
      }
      next.set(item.id, cell)
      return cell.row
    })
    cells = next
    return rows
  })
}

export function TranscriptRows(props: {
  items: TranscriptItem[]
  live?: () => boolean
  generatingToolCall?: () => boolean
}) {
  const rows = keyedRows(() => buildRenderItems(props.items))
  return (
    <RowStream.Provider
      value={{
        items: () => props.items,
        live: props.live ?? isRunning,
        generatingToolCall: props.generatingToolCall ?? (() => false),
      }}
    >
      <For each={rows()}>
        {({ node }) => (
          <Switch>
            <Match when={node().kind === 'user'}>
              <div class="row user">
                <div class="user-col">
                  {/* 附件位于气泡上方：附件是该消息的上下文，阅读顺序应为先看附件再看文字。 */}
                  <Show when={(node() as { item: TranscriptItem }).item.attachments?.length}>
                    <div class="attach-row sent">
                      <For each={(node() as { item: TranscriptItem }).item.attachments}>
                        {(a) => (
                          <span class="attach-chip" data-tip={a.path}>
                            <AttachmentThumb path={a.path} name={a.name} box={44} />
                            <span class="truncate">{a.name}</span>
                          </span>
                        )}
                      </For>
                    </div>
                  </Show>
                  <Show when={(node() as { item: TranscriptItem }).item.text}>
                    <UserBubble text={(node() as { item: TranscriptItem }).item.text} />
                  </Show>
                </div>
              </div>
            </Match>
            <Match when={node().kind === 'text'}>
              <Prose item={(node() as { item: TranscriptItem }).item} />
            </Match>
            <Match when={node().kind === 'thinking'}>
              <ThinkingFold item={(node() as { item: TranscriptItem }).item} />
            </Match>
            <Match when={node().kind === 'tool'}>
              <ToolCard item={(node() as { item: TranscriptItem }).item} />
            </Match>
            <Match when={node().kind === 'compaction'}>
              <CompactionCard item={(node() as { item: TranscriptItem }).item} />
            </Match>
            <Match when={node().kind === 'run'}>
              <RunCard item={(node() as { item: TranscriptItem }).item} />
            </Match>
            <Match when={node().kind === 'group'}>
              <ToolGroup
                id={node().id}
                members={(node() as { members: TranscriptItem[] }).members}
              />
            </Match>
          </Switch>
        )}
      </For>
    </RowStream.Provider>
  )
}

function ToolGroup(props: { id: string; members: TranscriptItem[] }) {
  const failed = () =>
    props.members.filter((m) => m.kind === 'tool' && m.status === 'failure').length
  /*
   * 分组卡片创建时的展开状态取决于其成员在创建时是否已展开。用户正在查看一个展开的单条
   * 工具时，下一个工具启动会把它合并进分组卡片；分组卡片以收起状态创建会隐藏正在查看的
   * 内容。该值只写入一次，此后分组卡片与成员的展开状态均由用户控制。
   */
  seedFoldOpen(
    foldKey('group', props.id),
    props.members.some(
      (m) => (m.kind === 'tool' || m.kind === 'thinking') && foldOpen(foldKey(m.kind, m.id)),
    ),
  )

  // 失败计数单独着色，普通操作摘要保持默认颜色。
  return (
    <Fold
      id={foldKey('group', props.id)}
      label={
        <>
          {groupTitle(props.members)}
          <Show when={failed() > 0}>
            ，<span class="fold-failure-count">{failed()} 个失败</span>
          </Show>
        </>
      }
    >
      <div class="fold-group">
        <For each={props.members}>
          {(m) => (
            <Show when={m.kind === 'tool'} fallback={<ThinkingFold item={m} />}>
              <ToolCard item={m} />
            </Show>
          )}
        </For>
      </div>
    </Fold>
  )
}

const WF_NODE_MAX = 160
const WF_LAYER_GAP = 12
/**
 * 节点的最小宽度：左右内边距与边框 26px + 四个汉字的名称 48px + 8px 间距 +
 * 最长的种类名称「外部 CLI」44px。
 */
const WF_NODE_MIN = 128

/** 相邻两条竖向通道的间距，也是最靠近节点的通道与节点边缘的距离。 */
const WF_TRACK = 6
/** 同一层间空白中相邻两条横线的间距。 */
const WF_LANE = 8
/** 换行的层中，连线在节点上方或下方转向处与节点边缘的距离。必须小于层间空白中最近一条横线与节点的距离 13px。 */
const WF_HOOK = 8
/** 换行的层中，连线进入节点上边、离开节点下边的位置与节点左、右边缘的距离。 */
const WF_PORT = 14
/** 两条不相连的连线相交处，竖线在横线上下各断开的长度。必须小于 `WF_LANE` 的一半：相邻横线的断口不相接。 */
const WF_JUMP = 3

interface WorkflowWireNode {
  key: string
  needs: readonly string[]
}

/** 一个节点在图中的位置与它使用的通道。通道编号从最靠近节点的一条起算，-1 表示该项不适用。 */
interface WorkflowWirePlace {
  layer: number
  /** 节点上方有同层其他行时，输入线经节点左侧的通道下行；否则为 -1，输入线进入节点上边中点。 */
  inTrack: number
  /** 节点下方有同层其他行时，输出线经节点右侧的通道下行；否则为 -1，输出线由节点下边中点引出。 */
  outTrack: number
}

/** 图的排列与连线分配。只由图的结构与图宽决定，不依赖测量。 */
export interface WorkflowWirePlan {
  layers: {
    /** 每行的节点数。小于该层节点数时该层换行。 */
    cols: number
    wrapped: boolean
    /** 一列节点左侧、右侧通道数的最大值，决定列间距与两侧留白。 */
    inTracks: number
    outTracks: number
  }[]
  places: Map<string, WorkflowWirePlace>
  /** 依赖集合相同的同层节点共用一组连线：`sources` 全部连接到 `targets`。 */
  nets: { sources: string[]; targets: string[]; layer: number }[]
  /**
   * 共用一条输出线的上游：换行的层中同一列、下游完全相同的节点，其余情况为单个节点。
   * `feeds` 是它通向的各组连线在 `nets` 中的下标；`rails` 与之一一对应，
   * 是通向不相邻的层时在图右侧占用的通道编号，相邻层为 -1。
   */
  bundles: { sources: string[]; layer: number; feeds: number[]; rails: number[] }[]
  /** 图右侧为跨层连线留出的通道数。 */
  rails: number
}

/** 换行的层的列间距与两侧留白：列间容纳左列的输出通道与右列的输入通道。 */
function workflowChannels(layer: { wrapped: boolean; inTracks: number; outTracks: number }) {
  if (!layer.wrapped) return { gap: WF_LAYER_GAP, left: 0, right: 0 }
  return {
    // 左列的输出通道与右列的输入通道之间多留一条通道的宽度，两组竖线不显示为双线。
    gap: Math.max(WF_LAYER_GAP, (layer.inTracks + layer.outTracks + 2) * WF_TRACK),
    left: layer.inTracks ? (layer.inTracks + 1) * WF_TRACK : 0,
    right: layer.outTracks ? (layer.outTracks + 1) * WF_TRACK : 0,
  }
}

/** 图右侧为跨层连线留出的宽度。 */
export const workflowRailWidth = (rails: number) => (rails ? (rails + 1) * WF_TRACK : 0)

/**
 * 决定每层的列数，并为换行的层分配节点两侧的通道。
 *
 * 图宽不足以按 `WF_NODE_MIN` 并排一层的全部节点时，该层分为多行，各行节点数尽量相等，
 * 各行按同一组列对齐：列间空白是连线下行的通道，行与行错开后通道被节点阻断。
 * `width` 为 0 表示尚未测量，此时不换行。
 *
 * 同一列的节点共用一条通道的条件是依赖完全相同（输入）或下游完全相同（输出）；否则每个节点
 * 各用一条。输入通道按行自上而下由近到远排列，输出通道相反：转向节点的横线只越过已经结束或
 * 尚未开始的通道，不与其他连线相交。
 */
export function layoutWorkflowGraph(
  layers: readonly (readonly WorkflowWireNode[])[],
  width: number,
): WorkflowWirePlan {
  const layerOf = new Map<string, number>()
  for (const [li, layer] of layers.entries()) for (const n of layer) layerOf.set(n.key, li)

  const nets: WorkflowWirePlan['nets'] = []
  const netOf = new Map<string, number>()
  const feeds = new Map<string, number[]>()
  const netIds = new Map<string, number>()
  for (const [li, layer] of layers.entries()) {
    for (const n of layer) {
      const sources = n.needs.filter((key) => (layerOf.get(key) ?? li) < li).sort()
      if (sources.length === 0) continue
      const id = `${li}:${JSON.stringify(sources)}`
      let index = netIds.get(id)
      if (index === undefined) {
        index = nets.length
        netIds.set(id, index)
        nets.push({ sources, targets: [], layer: li })
        for (const s of sources) feeds.set(s, [...(feeds.get(s) ?? []), index])
      }
      nets[index]!.targets.push(n.key)
      netOf.set(n.key, index)
    }
  }
  const far = (key: string, net: number) => nets[net]!.layer > layerOf.get(key)! + 1
  // 右侧通道按「每个上游的每组跨层下游一条」留出宽度：实际分配不多于该数，且该数与列数无关。
  let rails = 0
  for (const [key, list] of feeds) rails += list.filter((net) => far(key, net)).length

  const assign = (layer: readonly WorkflowWireNode[], cols: number) => {
    const inTrack = new Map<string, number>()
    const outTrack = new Map<string, number>()
    let inTracks = 0
    let outTracks = 0
    for (let col = 0; col < cols; col += 1) {
      const column = layer.filter((_, i) => i % cols === col)
      // 每列最上方的节点由上边中点直接进入，最下方的节点由下边中点直接引出，两者不占用通道。
      const fed = column.slice(1).filter((n) => netOf.has(n.key))
      const sameIn = fed.every((n) => netOf.get(n.key) === netOf.get(fed[0]!.key))
      for (const [i, n] of fed.entries()) inTrack.set(n.key, sameIn ? 0 : i)
      inTracks = Math.max(inTracks, sameIn ? Math.min(fed.length, 1) : fed.length)
      const feeding = column.slice(0, -1).filter((n) => feeds.has(n.key))
      const downstream = (n: WorkflowWireNode) => feeds.get(n.key)!.join(',')
      const sameOut = feeding.every((n) => downstream(n) === downstream(feeding[0]!))
      for (const [i, n] of feeding.entries()) {
        outTrack.set(n.key, sameOut ? 0 : feeding.length - 1 - i)
      }
      outTracks = Math.max(outTracks, sameOut ? Math.min(feeding.length, 1) : feeding.length)
    }
    return { inTrack, outTrack, inTracks, outTracks }
  }

  const columns = (layer: readonly WorkflowWireNode[]) => {
    const size = layer.length
    if (size <= 1 || width <= 0) return Math.max(size, 1)
    const fits = (cols: number) => {
      if (cols === 1) return true
      const { gap, left, right } = workflowChannels({
        wrapped: cols < size,
        ...assign(layer, cols),
      })
      const needed = cols * WF_NODE_MIN + (cols - 1) * gap + left + right
      return needed <= width - workflowRailWidth(rails)
    }
    let cols = size
    while (!fits(cols)) cols -= 1
    const even = Math.ceil(size / Math.ceil(size / cols))
    return fits(even) ? even : cols
  }

  const plan: WorkflowWirePlan = { layers: [], places: new Map(), nets, bundles: [], rails }
  let rail = 0
  for (const [li, layer] of layers.entries()) {
    const cols = columns(layer)
    const wrapped = cols < layer.length
    const tracks = assign(layer, cols)
    const shared = new Map<string, WorkflowWirePlan['bundles'][number]>()
    for (const [i, n] of layer.entries()) {
      const outTrack = wrapped ? (tracks.outTrack.get(n.key) ?? -1) : -1
      plan.places.set(n.key, {
        layer: li,
        inTrack: wrapped ? (tracks.inTrack.get(n.key) ?? -1) : -1,
        outTrack,
      })
      const list = feeds.get(n.key)
      if (!list) continue
      // 共用一条输出通道的节点下游相同，属于同一条输出线。
      const id = wrapped ? `${i % cols}:${outTrack}` : n.key
      const known = shared.get(id)
      if (known) {
        known.sources.push(n.key)
        continue
      }
      const bundle = {
        sources: [n.key],
        layer: li,
        feeds: list,
        rails: list.map((net) => (far(n.key, net) ? rail++ : -1)),
      }
      shared.set(id, bundle)
      plan.bundles.push(bundle)
    }
    plan.layers.push({ cols, wrapped, inTracks: tracks.inTracks, outTracks: tracks.outTracks })
  }
  return plan
}

/**
 * 一层的列、列间距、两侧留白与上方空白的高度。宽度充足时节点宽度不超过 `WF_NODE_MAX`。
 * `lanes` 是该层上方空白中的横线数，由 `routeWorkflowWires` 按测得的位置给出。
 */
export function workflowLayerStyle(layer: WorkflowWirePlan['layers'][number], lanes: number) {
  const { gap, left, right } = workflowChannels(layer)
  return {
    'grid-template-columns': `repeat(${layer.cols}, minmax(0, 1fr))`,
    'column-gap': `${gap}px`,
    'padding-inline': `${left}px ${right}px`,
    'max-width': `${layer.cols * WF_NODE_MAX + (layer.cols - 1) * gap + left + right}px`,
    'margin-top': `${Math.max(0, lanes - 1) * WF_LANE}px`,
  }
}

interface WorkflowEdgeSegment {
  axis: 'horizontal' | 'vertical'
  fixed: number
  from: number
  to: number
  live: boolean
}

/** 节点测得的矩形，坐标相对于图的左上角。 */
export interface WorkflowNodeRect {
  left: number
  right: number
  top: number
  bottom: number
}

/**
 * 自上而下排列一组横线：每次从余下各条中取出放在最上方时相交次数最少的一条。
 * `crossings(upper, lower)` 是两条横线按该上下次序放置时的相交次数。
 */
function arrangeWorkflowLanes<T>(items: readonly T[], crossings: (upper: T, lower: T) => number) {
  const rest = [...items]
  const ordered: T[] = []
  while (rest.length > 0) {
    const cost = (item: T) =>
      rest.reduce((sum, other) => (other === item ? sum : sum + crossings(item, other)), 0)
    const next = rest.reduce((best, item) => (cost(item) < cost(best) ? item : best))
    rest.splice(rest.indexOf(next), 1)
    ordered.push(next)
  }
  return ordered
}

/**
 * 按 `layoutWorkflowGraph` 的分配与测得的节点位置生成连线的线段，并给出每层上方空白中的横线数。
 * 图宽以内无法容纳全部竖线时，多出的竖线画在图的右边界之外，`overflow` 是越出的宽度。
 *
 * 不变量：每条线段只属于一条输出线或一组连线，不同归属的线段只相交、不重合也不相接。
 * 违反时图上会多出一条不存在的依赖。因此：
 * - 一个上游通向多组连线时，输出线先到达它独占的分线横线，再由各条分支分别下行到一组连线；
 *   不要让输出线依次经过多组连线的横线，上方一组的其他上游会沿它到达下方一组。
 * - 一组连线在层间空白中分为三部分：汇集各上游的上横线、一条下行竖线、分发到各目标的下横线。
 *   上游的竖线只在上横线以上，目标的竖线只在下横线以下，两者横坐标相同也不重合。
 * - 分支与下行竖线的横坐标在空白中选取：与其他竖线的距离不小于 `WF_TRACK`，
 *   或与同一组连线自己的竖线完全重合（此时对应的横线长度为零，不占位置）。
 * - 空白中只有一组连线且各上游都不需要分线时，上、下横线合为一条，没有下行竖线。
 *
 * 换行的层中，引出与进入都经节点旁的通道，连线不穿过同层其他行的节点。上游与目标不在相邻层时，
 * 分支经图右侧的通道下行，不穿过中间各层。
 *
 * 每个目标输出通向它的完整路径，重合部分由 `mergeWorkflowEdgeSegments` 合并。
 * 坐标偏移半像素：1px 的描边绘制在整数坐标上会跨越两个物理像素，显示为两条颜色减半的线。
 */
export function routeWorkflowWires(
  plan: WorkflowWirePlan,
  rects: ReadonlyMap<string, WorkflowNodeRect>,
  width: number,
): {
  segments: (Omit<WorkflowEdgeSegment, 'live'> & { target: string })[]
  lanes: number[]
  /** 图宽以内无法容纳全部竖线时，连线越出图右边界的宽度；否则为 0。 */
  overflow: number
} {
  type Piece = Omit<WorkflowEdgeSegment, 'live'>
  const at = (v: number) => Math.round(v) + 0.5
  const vertical = (list: Piece[], x: number, from: number, to: number) =>
    list.push({ axis: 'vertical', fixed: x, from, to })
  const horizontal = (list: Piece[], y: number, from: number, to: number) =>
    list.push({ axis: 'horizontal', fixed: y, from, to })
  const within = (x: number, xs: readonly number[]) => x > Math.min(...xs) && x < Math.max(...xs)

  const tops: number[] = []
  const bottoms: number[] = []
  for (const [key, r] of rects) {
    const layer = plan.places.get(key)?.layer
    if (layer === undefined) continue
    tops[layer] = Math.min(tops[layer] ?? r.top, r.top)
    bottoms[layer] = Math.max(bottoms[layer] ?? r.bottom, r.bottom)
  }
  const railX = (rail: number) => at(width - (rail + 1) * WF_TRACK)

  /** 每条输出线离开所在层的部分：横坐标、起点，以及换行的层中从节点到通道的转折。 */
  const trunks = plan.bundles.map((bundle) => {
    const pieces: Piece[] = []
    let x: number | undefined
    let top = Number.POSITIVE_INFINITY
    for (const key of bundle.sources) {
      const r = rects.get(key)
      const place = plan.places.get(key)
      if (!r || !place) continue
      if (place.outTrack < 0) {
        x = at((r.left + r.right) / 2)
        top = Math.min(top, at(r.bottom))
        continue
      }
      const port = at(r.right - WF_PORT)
      const hook = at(r.bottom + WF_HOOK)
      x = at(r.right + (place.outTrack + 1) * WF_TRACK)
      vertical(pieces, port, at(r.bottom), hook)
      horizontal(pieces, hook, port, x)
      top = Math.min(top, hook)
    }
    return { x, top, pieces }
  })
  /** 目标的输入线离开下横线的横坐标。 */
  const entryOf = (key: string) => {
    const r = rects.get(key)
    const place = plan.places.get(key)
    if (!r || !place) return undefined
    return at(place.inTrack < 0 ? (r.left + r.right) / 2 : r.left - (place.inTrack + 1) * WF_TRACK)
  }

  /** 每组连线：各上游竖线到达上横线的横坐标、下行竖线的横坐标、上横线与下横线的纵坐标。 */
  const wires = plan.nets.map((net, index) => ({
    net,
    index,
    feeders: [] as number[],
    entries: net.targets.map(entryOf).filter((x): x is number => x !== undefined),
    drop: undefined as number | undefined,
    upper: 0,
    lower: 0,
  }))
  /** 每条需要分线的输出线：分线横线的纵坐标，以及通向各组连线的分支的横坐标。 */
  const forks = plan.bundles.map(() => ({ y: 0, branches: [] as number[] }))
  const forked = (b: number) => {
    const bundle = plan.bundles[b]!
    return bundle.feeds.length > 1 || bundle.rails[0]! >= 0
  }
  const lanes = plan.layers.map(() => 0)
  let overflow = 0

  for (let layer = 1; layer < plan.layers.length; layer += 1) {
    const top = bottoms[layer - 1]
    const bottom = tops[layer]
    if (top === undefined || bottom === undefined) continue
    const here = wires.filter((wire) => wire.net.layer === layer)
    const above = plan.bundles.flatMap((bundle, b) =>
      bundle.layer === layer - 1 && trunks[b]!.x !== undefined ? [b] : [],
    )

    // 空白中已确定的竖线。`id` 标明归属：新选取的横坐标只允许与自己的竖线完全重合。
    const pins: { x: number; id: string }[] = []
    for (let rail = 0; rail < plan.rails; rail += 1) pins.push({ x: railX(rail), id: `r${rail}` })
    for (const b of above) pins.push({ x: trunks[b]!.x!, id: `t${b}` })
    for (const wire of here) for (const x of wire.entries) pins.push({ x, id: `e${wire.index}` })
    const free = (x: number, own: readonly string[]) =>
      pins.every((pin) => (pin.x === x ? own.includes(pin.id) : Math.abs(pin.x - x) >= WF_TRACK))
    const choose = (prefer: readonly number[], around: number, own: readonly string[]) => {
      for (const x of prefer) if (free(x, own)) return x
      for (let step = 1; step * WF_TRACK < width; step += 1) {
        for (const x of [around + step * WF_TRACK, around - step * WF_TRACK]) {
          if (x > 0 && x < width && free(x, own)) return x
        }
      }
      // 图宽以内没有空位时取图右侧之外的位置，并上报越出的宽度：卡片据此横向滚动。
      let x = at(width) + WF_TRACK
      while (!free(x, own)) x += WF_TRACK
      overflow = Math.max(overflow, Math.ceil(x - width) + WF_TRACK)
      return x
    }

    // 各组连线的上游：不需要分线的相邻层输出线与经右侧通道到达的分支已有确定的横坐标。
    const sources = here.map((wire) => {
      const index = wire.index
      const fixed: { x: number; id: string }[] = []
      const branching: number[] = []
      for (const [b, bundle] of plan.bundles.entries()) {
        const slot = bundle.feeds.indexOf(index)
        if (slot < 0 || trunks[b]!.x === undefined) continue
        if (bundle.rails[slot]! >= 0) {
          fixed.push({ x: railX(bundle.rails[slot]!), id: `r${bundle.rails[slot]}` })
        } else if (forked(b)) branching.push(b)
        else fixed.push({ x: trunks[b]!.x!, id: `t${b}` })
      }
      return { wire, index, fixed, branching }
    })
    const merged = sources.length === 1 && sources[0]!.branching.length === 0

    // 输出线直行到一组连线时，它本身就是通向该组的分支；每条输出线只有一组连线可以这样连接。
    const straight = new Map<number, number>()
    for (const { wire, index, fixed, branching } of sources) {
      wire.feeders = fixed.map((pin) => pin.x)
      if (merged) continue
      const own = [...fixed.map((pin) => pin.id), `e${wire.index}`]
      const known = [...wire.feeders, ...wire.entries]
      const middle = known.reduce((sum, x) => sum + x, 0) / Math.max(known.length, 1)
      const prefer: number[] = []
      const only = fixed.length + branching.length === 1
      if (only && fixed.length === 1) prefer.push(fixed[0]!.x)
      const direct = only && branching.length === 1 && !straight.has(branching[0]!)
      if (direct) {
        prefer.push(trunks[branching[0]!]!.x!)
        own.push(`t${branching[0]}`)
      }
      if (new Set(wire.entries).size === 1) prefer.push(wire.entries[0]!)
      prefer.push(...[...known].sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle)))
      const drop = choose(prefer, at(middle), own)
      wire.drop = drop
      if (direct && drop === trunks[branching[0]!]!.x) straight.set(branching[0]!, index)
      pins.push({ x: drop, id: `d${index}` })
    }
    for (const { wire, index, fixed, branching } of sources) {
      for (const b of branching) {
        const trunk = trunks[b]!.x!
        const slot = plan.bundles[b]!.feeds.indexOf(index)
        let x: number
        if (straight.get(b) === index) x = trunk
        else if (fixed.length + branching.length === 1) x = wire.drop!
        else if (!straight.has(b)) {
          x = trunk
          straight.set(b, index)
        } else {
          x = choose([], trunk, [])
          pins.push({ x, id: `b${b}` })
        }
        forks[b]!.branches[slot] = x
        wire.feeders.push(x)
      }
    }
    for (const b of above) {
      const bundle = plan.bundles[b]!
      for (const [slot, rail] of bundle.rails.entries()) {
        if (rail >= 0) forks[b]!.branches[slot] = railX(rail)
      }
    }

    // 自上而下：分线横线、各组连线的上横线、各组连线的下横线。长度为零的横线不占位置。
    const splitting = arrangeWorkflowLanes(above.filter(forked), (upper, lower) => {
      const span = [trunks[upper]!.x!, ...forks[upper]!.branches]
      const below = [trunks[lower]!.x!, ...forks[lower]!.branches]
      return (
        (within(trunks[lower]!.x!, span) ? 1 : 0) +
        forks[upper]!.branches.filter((x) => within(x, below)).length
      )
    })
    const collecting = arrangeWorkflowLanes(
      here.filter((wire) => merged || wire.feeders.some((x) => x !== wire.drop)),
      (upper, lower) =>
        lower.feeders.filter((x) => within(x, [...upper.feeders, upper.drop!])).length +
        (within(upper.drop!, [...lower.feeders, lower.drop!]) ? 1 : 0),
    )
    const spreading = arrangeWorkflowLanes(
      here.filter((wire) => !merged && wire.entries.some((x) => x !== wire.drop)),
      (upper, lower) =>
        upper.entries.filter((x) => within(x, [...lower.entries, lower.drop!])).length +
        (within(lower.drop!, [...upper.entries, upper.drop!]) ? 1 : 0),
    )
    const count = splitting.length + collecting.length + spreading.length
    lanes[layer] = count
    /** 第 `slot` 条横线的纵坐标：全部横线作为一组在空白中居中。 */
    const laneY = (slot: number) => at((top + bottom) / 2 + (slot - (count - 1) / 2) * WF_LANE)
    for (const [slot, b] of splitting.entries()) forks[b]!.y = laneY(slot)
    for (const wire of here) {
      const up = collecting.indexOf(wire)
      const down = spreading.indexOf(wire)
      const upper = up < 0 ? undefined : laneY(splitting.length + up)
      const lower = down < 0 ? undefined : laneY(splitting.length + collecting.length + down)
      // 两条横线都不存在时上游竖线直达目标：不要在空白中部设端点，端点落在其他连线的横线上即与之相连。
      wire.upper = upper ?? lower ?? at(bottom)
      wire.lower = lower ?? wire.upper
    }
  }

  // 每组连线中各目标共用的部分：各上游到上横线、上横线、下行竖线。
  const shared: Piece[][] = wires.map(() => [])
  for (const [b, bundle] of plan.bundles.entries()) {
    const trunk = trunks[b]!
    if (trunk.x === undefined) continue
    for (const [slot, index] of bundle.feeds.entries()) {
      const wire = wires[index]!
      const list = shared[index]!
      list.push(...trunk.pieces)
      if (!forked(b)) {
        vertical(list, trunk.x, trunk.top, wire.upper)
        continue
      }
      const branch = forks[b]!.branches[slot]
      if (branch === undefined) continue
      vertical(list, trunk.x, trunk.top, forks[b]!.y)
      horizontal(list, forks[b]!.y, trunk.x, branch)
      vertical(list, branch, forks[b]!.y, wire.upper)
    }
  }
  const segments: (Omit<WorkflowEdgeSegment, 'live'> & { target: string })[] = []
  for (const [index, wire] of wires.entries()) {
    const list = shared[index]!
    if (wire.drop !== undefined) {
      for (const x of wire.feeders) horizontal(list, wire.upper, x, wire.drop)
      vertical(list, wire.drop, wire.upper, wire.lower)
    }
    for (const target of wire.net.targets) {
      const t = rects.get(target)
      const place = plan.places.get(target)
      const entry = entryOf(target)
      if (!t || !place || entry === undefined) continue
      const own: Piece[] = []
      if (wire.drop !== undefined) horizontal(own, wire.lower, wire.drop, entry)
      else for (const x of wire.feeders) horizontal(own, wire.lower, x, entry)
      if (place.inTrack < 0) vertical(own, entry, wire.lower, at(t.top))
      else {
        const turn = at(t.top - WF_HOOK)
        const port = at(t.left + WF_PORT)
        vertical(own, entry, wire.lower, turn)
        horizontal(own, turn, entry, port)
        vertical(own, port, turn, at(t.top))
      }
      for (const piece of [...list, ...own]) segments.push({ ...piece, target })
    }
  }
  return { segments, lanes, overflow }
}

/**
 * 多条依赖共享入口或出口时会产生共线区间。先按坐标切分为最小区间，再合并相邻且状态
 * 相同的区间，保证每一段像素只绘制一次；共享区间中只要有一条活动依赖就显示活动状态。
 *
 * 竖线与横线相交而没有任何线段在交点结束时，两者属于不同的依赖：竖线在交点上下断开，
 * 表示从横线下方穿过。有线段在交点结束时两者相连，不断开。
 */
export function mergeWorkflowEdgeSegments(
  segments: readonly WorkflowEdgeSegment[],
): { d: string; live: boolean }[] {
  const groups = new Map<
    string,
    { axis: WorkflowEdgeSegment['axis']; fixed: number; parts: WorkflowEdgeSegment[] }
  >()
  for (const segment of segments) {
    const from = Math.min(segment.from, segment.to)
    const to = Math.max(segment.from, segment.to)
    if (from === to) continue
    const normalized = { ...segment, from, to }
    const key = `${segment.axis}:${segment.fixed}`
    const group = groups.get(key)
    if (group) group.parts.push(normalized)
    else groups.set(key, { axis: segment.axis, fixed: segment.fixed, parts: [normalized] })
  }

  const paths: { d: string; live: boolean }[] = []
  for (const group of groups.values()) {
    const jumps: number[] = []
    if (group.axis === 'vertical') {
      for (const other of groups.values()) {
        if (other.axis !== 'horizontal') continue
        const across = other.parts.filter((p) => p.from <= group.fixed && p.to >= group.fixed)
        const down = group.parts.filter((p) => p.from <= other.fixed && p.to >= other.fixed)
        if (across.length === 0 || down.length === 0) continue
        const joined =
          across.some((p) => p.from === group.fixed || p.to === group.fixed) ||
          down.some((p) => p.from === other.fixed || p.to === other.fixed)
        if (!joined) jumps.push(other.fixed)
      }
    }
    const points = [
      ...new Set([
        ...group.parts.flatMap((part) => [part.from, part.to]),
        ...jumps.flatMap((y) => [y - WF_JUMP, y + WF_JUMP]),
      ]),
    ].sort((a, b) => a - b)
    let run: { from: number; to: number; live: boolean } | null = null
    const flush = () => {
      if (!run) return
      paths.push({
        d:
          group.axis === 'horizontal'
            ? `M${run.from} ${group.fixed}H${run.to}`
            : `M${group.fixed} ${run.from}V${run.to}`,
        live: run.live,
      })
      run = null
    }
    for (let i = 0; i < points.length - 1; i += 1) {
      const from = points[i]!
      const to = points[i + 1]!
      const covering = group.parts.filter((part) => part.from <= from && part.to >= to)
      const cut = jumps.some((y) => from >= y - WF_JUMP && to <= y + WF_JUMP)
      if (covering.length === 0 || cut) {
        flush()
        continue
      }
      const live = covering.some((part) => part.live)
      if (run && run.to === from && run.live === live) run.to = to
      else {
        flush()
        run = { from, to, live }
      }
    }
    flush()
  }
  return paths
}

/**
 * 任务派发的图卡片。派发单个任务与派发工作流图共用该卡片：单个任务即只有一个节点的图，
 * 两种渲染方式并存会使同一类操作在会话流中呈现两种样式。
 *
 * 结构取自参数，状态只有一个来源。参数随 `tool.started` 到达，因此第一帧即可渲染
 * 完整的图，等待执行的节点也显示在图中；状态是 `item.nodes`（工作流图折叠为 `workflow.states`），
 * 流式输出期间由 `team.member` 逐个节点替换，刷新后从 step payload 整体恢复。
 *
 * 按依赖分层排列：同一层的节点并排（它们并行执行），层与层之间用竖线连接。
 * 这已表达全部依赖关系，不绘制箭头：节点较多时，箭头会使连线难以分辨。
 */
function DelegateCard(props: { item: TranscriptItem }) {
  /**
   * 图的结构只由 `toolName` 与 `args` 决定，一次派发中两者不变。不要写成
   * `() => delegateGraph(props.item)`：折叠后的 workflow 条目随每个进度事件重新生成，
   * `props.item` 每次都是新对象，图随之重新计算，每个节点按钮的 DOM 被替换，连线重新测量。
   */
  const shape = createMemo(
    () => ({ toolName: props.item.toolName, args: props.item.args }),
    undefined,
    { equals: (a, b) => a.toolName === b.toolName && a.args === b.args },
  )
  const graph = createMemo(() => delegateGraph(shape()))

  /**
   * 节点的当前状态。会话端点没有状态，它代表当前会话本身；检查点节点的状态由审查记录决定。
   * agent 节点只读取 `nodes`：工作流图读取折叠后的 `workflow.states`，单个任务读取该 step 自身的状态。
   */
  const stateOf = (n: GraphNode): NodeView | null => {
    if (n.kind === 'session') {
      const checkpoint = props.item.workflow?.nodes.find(
        (node) => node.kind === 'checkpoint' && node.id === n.key,
      )
      if (!checkpoint || checkpoint.kind !== 'checkpoint') return null
      const approved = props.item.workflow?.approvals[n.key]
      // `checkpointId` 只在上游全部到达终态且未批准时有值，它标识等待父会话审查的节点。
      const current = props.item.workflow?.checkpointId === n.key
      const states = props.item.workflow?.states ?? {}
      const upstreamRunning = checkpoint.needs.some((id) => {
        const phase = states[id]?.phase
        return phase === 'working' || phase === 'queued' || phase === 'waiting'
      })
      return {
        phase: approved
          ? 'done'
          : current
            ? 'waiting_review'
            : upstreamRunning
              ? 'working'
              : 'waiting',
        label: checkpoint.label,
      }
    }
    const state = props.item.workflow
      ? props.item.workflow.states[n.key]
      : props.item.nodes?.[n.key]
    return {
      phase: state?.phase ?? 'waiting',
      label: state?.label ?? '',
      ...(state?.kind ? { kind: state.kind } : {}),
      ...(state?.durationMs ? { durationMs: state.durationMs } : {}),
      ...(state?.subagentId ? { conversationId: state.subagentId } : {}),
    }
  }

  /**
   * 各层的列数与连线分配。列数不变时保持同一引用：分配只由图的结构与各层列数决定，
   * 图宽每变化一个像素都重新生成时，拖动面板期间各层的样式被反复改写。
   */
  const [width, setWidth] = createSignal(0)
  const planned = createMemo<{ graph: ReturnType<typeof delegateGraph>; plan: WorkflowWirePlan }>(
    (prev) => {
      const g = graph()
      const next = layoutWorkflowGraph(g.layers, width())
      const same =
        prev?.graph === g &&
        prev.plan.layers.every((layer, i) => layer.cols === next.layers[i]!.cols)
      return same ? prev : { graph: g, plan: next }
    },
  )
  const plan = () => planned().plan

  /**
   * 位置只能通过测量取得：节点宽度随名称与耗时变化，无法计算。测量时机由
   * `ResizeObserver` 决定：它在布局之后、绘制之前回调，因此连线与节点在同一帧完成渲染，
   * 不会先显示错位的图再修正。连线是绝对定位的 SVG，不参与布局，
   * 因此测量后绘制不会再次触发布局（不构成观察循环）。
   *
   * 绘制时用 `<Index>` 按位置复用 `<path>`：每次测量都生成新数组，`<For>` 会替换
   * 全部节点，虚线动画随之从头开始；进度事件较多时连线持续闪动。
   */
  const [segments, setSegments] = createSignal<
    (Omit<WorkflowEdgeSegment, 'live'> & { node: GraphNode })[]
  >([])
  const edges = createMemo(() =>
    mergeWorkflowEdgeSegments(
      segments().map(({ node, ...segment }) => ({
        ...segment,
        live: stateOf(node)?.phase === 'working',
      })),
    ),
  )
  let box!: HTMLDivElement
  const refs = new Map<string, HTMLElement>()

  const measure = (): number[] | undefined => {
    if (!box) return undefined
    const b = box.getBoundingClientRect()
    // 偏移半像素：1px 的描边绘制在整数坐标上会跨越两个物理像素，显示为两条颜色减半的线。
    const at = (v: number) => Math.round(v) + 0.5
    const g = graph()
    if (g.horizontal) {
      const measured: (Omit<WorkflowEdgeSegment, 'live'> & { node: GraphNode })[] = []
      for (const n of g.nodes) {
        const to = refs.get(n.key)
        const from = n.needs[0] ? refs.get(n.needs[0]) : undefined
        if (!to || !from) continue
        // 三个节点横向排列时，每条边只连接一对节点：从左侧节点右边缘中点到右侧节点左边缘中点的直线。
        const t = to.getBoundingClientRect()
        const r = from.getBoundingClientRect()
        measured.push({
          axis: 'horizontal',
          fixed: at(t.top + t.height / 2 - b.top),
          from: at(r.right - b.left),
          to: at(t.left - b.left),
          node: n,
        })
      }
      setSegments(measured)
      return undefined
    }
    const rects = new Map<string, WorkflowNodeRect>()
    const nodes = new Map<string, GraphNode>()
    for (const n of g.nodes) {
      const el = refs.get(n.key)
      if (!el) continue
      const r = el.getBoundingClientRect()
      nodes.set(n.key, n)
      rects.set(n.key, {
        left: r.left - b.left,
        right: r.right - b.left,
        top: r.top - b.top,
        bottom: r.bottom - b.top,
      })
    }
    const routed = routeWorkflowWires(plan(), rects, b.width)
    setSegments(
      routed.segments.map(({ target, ...segment }) => ({ ...segment, node: nodes.get(target)! })),
    )
    setOverflow(routed.overflow)
    return routed.lanes
  }

  /**
   * 各层上方空白中的横线数，决定该空白的高度。它由连线的横坐标决定，只能在测量后取得；
   * 写入后节点下移而横坐标不变，因此第二次测量给出相同的结果。
   */
  const [lanes, setLanes] = createSignal<number[]>([], {
    equals: (a, b) => a.length === b.length && a.every((v, i) => v === b[i]),
  })
  /** 连线越出图右边界的宽度。连线层按它加宽，卡片随之横向滚动；图本身的宽度不变，不触发重新排列。 */
  const [overflow, setOverflow] = createSignal(0)
  // 先更新图宽再测量：行数变化后节点位置随之改变，连线须使用换行后的坐标。
  // 横线数变化时在同一次回调中重新测量：节点只是移动、尺寸不变，不会再次触发观察。
  const ro = new ResizeObserver(() => {
    if (box) setWidth(box.getBoundingClientRect().width)
    const next = measure()
    if (!next) return
    const before = lanes()
    setLanes(next)
    if (lanes() !== before) measure()
  })
  onCleanup(() => ro.disconnect())
  // 几何位置只在排版完成后测量；执行状态直接更新连线样式，不触发同步布局。

  /**
   * 容器本身也需要观察。拖动面板时节点随等宽列一同缩放，容器与节点的观察结果
   * 共同触发重新计算，使连线始终使用当前帧的实际坐标。
   */
  const holdBox = (el: HTMLDivElement) => {
    box = el
    ro.observe(el)
  }

  const hold = (id: string) => (el: HTMLElement) => {
    refs.set(id, el)
    ro.observe(el)
  }

  return (
    <div
      class="wf-card"
      classList={{
        failed: props.item.workflow
          ? props.item.workflow.phase === 'failed'
          : props.item.status === 'failure',
      }}
    >
      {/* 只有工作流图有整体目标；单个任务的指令显示在其节点的第二行。 */}
      <Show when={props.item.toolName === 'workflow'}>
        <div class="wf-goal truncate">{cardTitle(props.item)}</div>
      </Show>
      <div
        class="wf-graph"
        classList={{ across: graph().horizontal }}
        style={{ 'padding-right': `${workflowRailWidth(plan().rails)}px` }}
        ref={holdBox}
      >
        <svg
          class="wf-edges"
          aria-hidden="true"
          style={overflow() ? { width: `calc(100% + ${overflow()}px)` } : undefined}
        >
          <Index each={edges()}>{(e) => <path d={e().d} classList={{ live: e().live }} />}</Index>
        </svg>
        <For each={graph().layers}>
          {(nodes, layer) => (
            <div
              class="wf-layer"
              classList={{ wrapped: plan().layers[layer()]?.wrapped === true }}
              style={
                graph().horizontal
                  ? undefined
                  : workflowLayerStyle(plan().layers[layer()]!, lanes()[layer()] ?? 0)
              }
            >
              <For each={nodes}>
                {(n) => {
                  const st = () => stateOf(n)
                  /*
                   * 点击节点即打开其内容。两种节点打开的内容不同：内置子 agent 打开对应的
                   * 子会话；外部 CLI 是本机的另一个进程，打开的是它的输出流。
                   * 两者都不存在时（尚未执行）无法打开。
                   *
                   * 种类只依据状态判定。继续派发时调用参数只有一个子 agent id，据此推测种类会把
                   * 外部 CLI 误判为内置子 agent，打开的是一条没有正文的子会话。
                   */
                  const cli = () => st()?.kind === 'cli'
                  // 第一行显示节点名称。单个任务没有节点 id，节点名称即执行者，
                  // 因此运行期间取得更完整的名称（厂商 + CLI 名称）时使用该名称。
                  const name = () => st()?.label || n.title
                  const open = () => {
                    const cid = st()?.conversationId
                    if (cli()) openCliTab(props.item.id, n.key, name())
                    else if (cid) openConversationTab(cid, name())
                  }
                  return (
                    <Show
                      when={n.kind === 'agent'}
                      fallback={
                        // 两端节点代表当前会话本身，分别表示派发与收回。不可点击：它就是用户正在查看的页面。
                        <div
                          class="wf-node session"
                          classList={{ [st()?.phase ?? 'waiting']: true }}
                          ref={hold(n.key)}
                        >
                          <span class="wf-node-name truncate">{n.title}</span>
                        </div>
                      }
                    >
                      <button
                        type="button"
                        class="wf-node"
                        classList={{ [st()?.phase ?? 'waiting']: true }}
                        disabled={cli() ? st()?.phase === 'waiting' : !st()?.conversationId}
                        onClick={open}
                        ref={hold(n.key)}
                      >
                        {/* 第一行显示节点名称与种类，第二行显示指令与耗时；两种卡片使用同一规则。 */}
                        <span class="wf-node-head">
                          <span class="wf-node-name">{name()}</span>
                          <Show when={st()?.kind}>
                            {(kind) => (
                              <span class="wf-node-kind">{SUBAGENT_KIND_LABEL[kind()]}</span>
                            )}
                          </Show>
                        </span>
                        <span class="wf-node-who">
                          <Show when={n.task}>
                            <span class="wf-node-task">{n.task}</span>
                          </Show>
                          <Show when={st()?.durationMs}>
                            {(ms) => <span class="wf-node-time">{(ms() / 1000).toFixed(1)}s</span>}
                          </Show>
                        </span>
                      </button>
                    </Show>
                  )
                }}
              </For>
            </div>
          )}
        </For>
      </div>
      {/* 失败原因只显示在此处：边框已表示失败，这一行说明原因。 */}
      <Show
        when={
          (props.item.workflow
            ? props.item.workflow.phase === 'failed'
            : props.item.status === 'failure') && props.item.outcome?.message
        }
      >
        {(msg) => <div class="wf-error">{msg()}</div>}
      </Show>
    </div>
  )
}

/** 节点的显示状态：agent 节点取自 `NodeState`，检查点节点取自审查记录。 */
interface NodeView {
  phase: string
  label: string
  /** 派发给哪一种子 agent；检查点节点与尚无状态的节点没有该字段。 */
  kind?: SubagentKind
  durationMs?: number
  conversationId?: string
}

/** 卡片顶部一行：本次派发的整体目标，取 `args.goal` 的第一行。 */
function cardTitle(item: TranscriptItem): string {
  const raw = item.args?.goal
  return firstLine(typeof raw === 'string' ? raw.trim() : '')
}

/**
 * 动作行末尾显示的目标。浏览器工具的 `action.target` 是宿主的 tabId（打开新页面时是占位字符串），
 * 仅用于权限与冲突判定；界面显示该页面的标签页标题，页面已关闭时显示参数中的地址，两者都没有时不显示。
 * 电脑控制工具同理：`action.target` 是不透明的窗口编号，界面显示结果中返回的窗口标题。
 * 分段读取文件时在路径后附加实际读取的行号范围。
 */
function shownTarget(item: TranscriptItem): string | undefined {
  if (item.toolName === 'write_file' && item.status === 'success') {
    const actualPath = item.outcome?.fileChanges?.[0]?.path
    if (actualPath) return displayTarget(actualPath)
  }
  const target = item.action?.target
  if (!target) return undefined
  if (item.toolName === 'read_file') {
    const range = readRange(item.outcome?.data)
    return range ? `${displayTarget(target)}:${range}` : displayTarget(target)
  }
  if (item.toolName?.startsWith('desktop_')) return desktopWindowLabel(item.outcome?.data)
  if (!item.toolName?.startsWith('browser_')) return displayTarget(target)
  const url = item.args?.url
  return browserTabLabel(target) ?? (typeof url === 'string' ? url : undefined)
}

function ToolCard(props: { item: TranscriptItem }) {
  const changes = () => fileDelta(props.item.outcome?.fileChanges)
  const images = () =>
    props.item.outcome?.presentation?.images === 'inline'
      ? resultImages(props.item.outcome.data)
      : []
  // 派发任务的两个工具渲染为图，不使用折叠条目：它们各自是一条子会话的入口，
  // 产出的正文已在该子会话（或该 CLI 进程的输出流）中。
  if (props.item.toolName === 'workflow' || props.item.toolName === 'subagent') {
    return <DelegateCard item={props.item} />
  }
  return (
    <>
      <Fold
        id={foldKey('tool', props.item.id)}
        failed={props.item.status === 'failure'}
        label={actionLabel(props.item)}
        statusWord={statusWord(props.item.status, props.item.imagesUndelivered)}
        {...(shownTarget(props.item) ? { target: shownTarget(props.item)! } : {})}
        {...(changes() ? { changes: changes()! } : {})}
      >
        <StepBody item={props.item} />
      </Fold>
      {/* 模型的视觉输入默认不在会话流中显示。只有工具结果明确声明 inline 时，才把账本中的
          同一份图片渲染到会话流；read_file 读取的图片因此不会显示为用户附件。 */}
      <Show when={images().length > 0}>
        <div class="tool-images">
          <For each={images()}>
            {(img, index) => (
              <img
                src={`data:${img.mime};base64,${img.data}`}
                alt={`${props.item.action?.target ?? '工具结果'} 图片 ${index() + 1}`}
                loading="lazy"
              />
            )}
          </For>
        </div>
      </Show>
    </>
  )
}

/**
 * 展开内容。必须提供标题行之外的信息，且每种动作对应一种主体内容，
 * 而不是罗列所有可能的块。
 *
 * 只渲染 `outcome.message` 等于复述标题行：「读取 packages/server/src/git.ts」
 * 展开后显示「读取 packages/server/src/git.ts（278 行）」，用户展开后没有获得新信息。
 * 有信息量的是参数：修改的 diff、执行的命令、读取的范围都在 `args` 中。
 *
 * 划分方式：
 *   待办：清单逐行（勾选 / 加载动画 / 空心圆点）
 *   编辑：diff →（分隔线）→ 结果
 *   运行：命令原文 →（分隔线）→「输出」标签 + 输出
 *   创建：新内容全文 → 结果
 *   其余：参数表 →（分隔线）→ 结果
 *
 * 失败时错误正文排在最前，之后用分隔线隔开，其下是与成功时相同的主体。不要为失败另写一套主体：
 * 失败时最需要核对的是执行了什么，而参数表跳过超过 400 字的值，长命令与修改内容会因此不显示。
 *
 * 「结果」字段取 `outcome.data`（`content` / `stdout` / `entries` / `matches`），
 * 无法取得时才回退到 `message`：message 只是一句摘要，不是正文。
 *
 * 自带主体块的分支一律使用 `noMessage`。编辑与创建的 message 是
 * 「编辑 x（1 处）」「创建 x」，与标题行的「修改文件 · x」内容重复，
 * 回退时会在正文下方再显示一个复述标题的灰色块。没有主体块的「其余」分支
 * 保留回退：搜索无匹配时，「匹配 0 个文件」是展开内容中唯一的结论。
 */
function StepBody(props: { item: TranscriptItem }) {
  const args = () => props.item.args ?? {}
  const kind = () => props.item.action?.kind

  return (
    <>
      <Show when={props.item.status === 'failure'}>
        <pre class="fold-out err">{props.item.outcome?.message || '（无错误正文）'}</pre>
        <div class="fold-divider" />
      </Show>
      <Switch fallback={<Generic item={props.item} />}>
        {/*
         * 中途输出排在最前。运行时 `outcome` 尚不存在，进入下方任何分支
         * 都只显示空卡片；该分支只在 `status === 'running'` 时成立，
         * 到达终态后自动让位，无需额外清理。
         */}
        <Match when={props.item.status === 'running' && props.item.stdout}>
          <LiveOutput item={props.item} />
        </Match>

        {/*
         * 待办清单。不能交给通用参数表分支处理：整个清单的 JSON 位于一个单元格中，
         * 状态位于 `"status":"in_progress"` 的引号之间，判断哪些条目已完成
         * 需要逐个辨认。该分支提供标题行没有的信息，即每一条的状态。
         *
         * 使用 `noMessage`：回执是「第 3/4 步：编写 main.js」，而清单中该条目已带有
         * 加载动画标记，再显示回执即为重复。
         */}
        <Match when={todosOf(args()) !== null}>
          <div class="fold-todos">
            <TodoList todos={todosOf(args())!} />
          </div>
        </Match>

        <Match when={kind() === 'edit' && diffFrom(args()) !== null}>
          {(() => {
            const d = diffFrom(args())!
            return (
              <pre class="fold-diff">
                <Show when={d.removed}>
                  <span class="del">{d.removed}</span>
                </Show>
                <Show when={d.added}>
                  <span class="add">{d.added}</span>
                </Show>
              </pre>
            )
          })()}
          <Result item={props.item} withDivider noMessage />
        </Match>

        {/* 没有命令原文的运行类调用（批量运行画布）按「其余」显示参数表：
            失败时只有参数能说明本次执行的对象。 */}
        <Match when={kind() === 'run' && firstString(args(), 'command', 'script', 'code')}>
          {(cmd) => (
            <>
              <pre class="fold-code">{cmd()}</pre>
              <Result item={props.item} label="输出" withDivider />
            </>
          )}
        </Match>

        <Match when={kind() === 'write' && firstString(args(), 'content', 'text') !== ''}>
          <pre class="fold-code">{clamp(firstString(args(), 'content', 'text'))}</pre>
          <Result item={props.item} noMessage />
        </Match>
      </Switch>
    </>
  )
}

function Generic(props: { item: TranscriptItem }) {
  const rows = () => argsRows(props.item.args ?? {})
  return (
    <>
      <Show when={rows().length > 0}>
        <ArgsTable rows={rows()} />
      </Show>
      <Result item={props.item} withDivider={rows().length > 0} />
    </>
  )
}

/**
 * 「结果」字段。
 *
 * 取值顺序：`data.content` → `data.stdout` → `data.stderr` → `data.output` → 列表型 →
 * `outcome.message`。`output` 键供 MCP 与插件工具使用：它们的 data 结构由第三方
 * 决定，`output` 是其中的常见键；内置工具不产生该键（派发任务的两个工具渲染为图卡片，不经过此处）。
 *
 * 失败时把 `stderr` 提到最前：错误信息通常只写入错误流，而 stdout 往往另有内容
 * （测试的进度输出、服务器的启动日志），按成功时的顺序取值会取得 stdout，实际的
 * 错误信息被排在后面。内容为空时整个字段不渲染：空 `<pre>` 只会在展开内容中留下
 * 一个没有内容的边框。
 */
function Result(props: {
  item: TranscriptItem
  label?: string
  withDivider?: boolean
  /**
   * 无法取得正文时不回退到 `outcome.message`：message 只是标题行的复述（编辑、创建）。
   * 失败时同样不回退，message 已作为错误正文显示在展开内容的最上方。
   */
  noMessage?: boolean
}) {
  const text = () => {
    const data = (props.item.outcome?.data ?? {}) as Record<string, unknown>
    const keys =
      props.item.status === 'failure'
        ? ['stderr', 'content', 'stdout', 'output']
        : ['content', 'stdout', 'stderr', 'output']
    for (const k of keys) {
      if (typeof data[k] === 'string' && (data[k] as string).trim()) return data[k] as string
    }
    const list = listOf(data)
    if (list) return list.join(NEWLINE)
    return props.noMessage || props.item.status === 'failure'
      ? ''
      : (props.item.outcome?.message ?? '')
  }

  return (
    <Show when={text().trim()}>
      {(body) => (
        <>
          <Show when={props.withDivider}>
            <div class="fold-divider" />
          </Show>
          <Show when={props.label}>
            <div class="fold-tag">{props.label}</div>
          </Show>
          <pre class="fold-out">{clamp(collapseCarriageReturns(body()))}</pre>
        </>
      )}
    </Show>
  )
}

const NEWLINE = String.fromCharCode(10)

function ArgsTable(props: { rows: [string, string][] }) {
  return (
    <table class="args-table">
      <tbody>
        <For each={props.rows}>
          {([k, v]) => (
            <tr>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}
