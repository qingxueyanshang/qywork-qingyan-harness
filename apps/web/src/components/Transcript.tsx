import type { JSX } from 'solid-js'
import { createComputed, createMemo, createSignal, on, onCleanup, Show } from 'solid-js'
import { delegationStatus } from '../lib/render-items.ts'
import { createHeld } from '../lib/resource.ts'
import {
  conversationRunClosed,
  isConversationRunning,
  setState,
  state,
  type TranscriptItem,
  transcript,
  viewOf,
} from '../lib/store/index.ts'
import { ConversationIndex } from './ConversationIndex.tsx'
import { ConversationHistoryBoundary } from './transcript/ConversationHistoryBoundary.tsx'
import { createConversationScroll } from './transcript/conversation-scroll.ts'
import { LiveRunBar } from './transcript/status/LiveRunBar.tsx'
import { TranscriptRows } from './transcript/TranscriptRows.tsx'

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
}) {
  const follow = createConversationScroll(() => props.conversationId)
  const main = () => props.variant === 'main'
  /*
   * 换为另一条会话的正文后，第一帧完整渲染全部条目（`.settling` 取消 `content-visibility`），绘制之后恢复。
   * 不要去掉：新条目尚无记住的高度，按 80px 占位参与布局，底部跟随在同一帧内把视口移到底部，
   * 新露出的条目在这一帧被判为屏幕外而不绘制，正文整屏空白一帧（逐帧录制中每次切换都出现）。
   * 第二个 `requestAnimationFrame` 才移除：第一个在该帧渲染之前执行。
   */
  const [settling, setSettling] = createSignal(false)
  let settleFrame = 0
  createComputed(
    on(
      () => (props.items.length > 0 ? props.conversationId : null),
      (id) => {
        if (id === null) return
        setSettling(true)
        cancelAnimationFrame(settleFrame)
        settleFrame = requestAnimationFrame(() => {
          settleFrame = requestAnimationFrame(() => setSettling(false))
        })
      },
    ),
  )
  onCleanup(() => cancelAnimationFrame(settleFrame))
  const background = createMemo(() =>
    props.live() && props.closed() ? delegationStatus(props.items) : null,
  )

  return (
    <>
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
            settling: settling(),
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
      {/* 索引按 `.main` 定位，与滚动容器并列，不随正文滚动。 */}
      <Show when={main()}>
        <ConversationIndex
          earlier={props.conversationId ? viewOf(props.conversationId).history.earlierTurns : []}
          items={props.items}
          scroller={follow.scroller}
          onJump={(id) => void follow.reveal(id)}
        />
      </Show>
    </>
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
  /*
   * 切换会话时保留上一条会话的正文，新会话的首页历史读取完成后在同一次更新中替换，超过 `SLOW_MS` 时显示
   * 新会话的加载提示；正在显示的正文为空时没有内容可保留，立即切换。离开的会话视图随即被 `syncViews` 移除，
   * 保留的是切换前取得的正文数组本身。会话流中的其余内容（运行状态、错误）都按显示中的会话取值，
   * 不按 `state.activeConversation`。
   */
  const shown = createHeld(
    () => ({ id: state.activeConversation, items: transcript() }),
    (current) => {
      if (current.items.length === 0) return true
      const id = state.activeConversation
      if (!id) return false
      const v = viewOf(id)
      const loading = v.history.loading
      return (
        v.error !== null ||
        v.history.error !== null ||
        (loading !== 'initial' && loading !== 'unloaded')
      )
    },
  )
  const id = () => shown().id
  return (
    <ConversationStream
      conversationId={id()}
      items={shown().items}
      live={() => isConversationRunning(id())}
      closed={() => conversationRunClosed(id())}
      variant="main"
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
          <Show when={viewOf(id()).error}>
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
