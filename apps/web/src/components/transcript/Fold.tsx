import type { JSX } from 'solid-js'
import { createEffect, createMemo, Show } from 'solid-js'
import { sanitizeTarget } from '../../lib/step-view.ts'
import { foldOpen, setFoldOpen } from '../../lib/store/index.ts'

/** 折叠条目在 `foldOpen` 中的 key：分组卡片与其首个成员的 id 相同，以 kind 区分。 */
export function foldKey(kind: 'tool' | 'thinking' | 'group', id: string): string {
  return `${kind}:${id}`
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
export function Fold(props: {
  id: string
  label: JSX.Element
  /** 终态文字。成功时不显示：一屏数十行都显示「成功」不提供任何信息。 */
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
  /**
   * 双击标题行。提供时按下第二次阻止默认行为，双击不选中标题中的文字。
   * 双击中的两次单击各切换一次折叠，结果与双击前相同。
   */
  onHeadDblClick?: () => void
  children: JSX.Element
}) {
  /*
   * 展开与收起只由用户操作，代码不得自动展开或收起。
   *
   * 不要加 `autoOpen`（思考开始时自动展开、结束时自动收起，工具组同理）：它会使会话流
   * 持续上下跳动。`.fold-pre` 一次展开或收起改变 200px 高度，而一轮中有多段思考与
   * 多组命令，内容高度在执行过程中反复增减。实测一轮四步：会话流高度
   * 降低 5 次，幅度为 58 / 82 / 122 / 146 / 191px。
   * 在底部阅读时视口因此产生数百像素的往返位移，而用户没有进行任何操作。
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
      {/* biome-ignore lint/a11y/noStaticElementInteractions: summary 是可聚焦、可由键盘操作的原生交互元素，该规则未将其识别为交互元素 */}
      <summary
        class="fold-head"
        onMouseDown={(e) => {
          if (props.onHeadDblClick && e.detail > 1) e.preventDefault()
        }}
        onDblClick={() => props.onHeadDblClick?.()}
      >
        <span class="fold-summary">
          <span class="fold-label">{props.label}</span>
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
          {/* 状态词紧跟在对象与增删行数之后，理由同上：它描述的是这一次调用。 */}
          <Show when={props.statusWord}>
            <span class="fold-word">{props.statusWord}</span>
          </Show>
        </span>
      </summary>
      <Show when={mounted()}>
        <div class="fold-body">{props.children}</div>
      </Show>
    </details>
  )
}
