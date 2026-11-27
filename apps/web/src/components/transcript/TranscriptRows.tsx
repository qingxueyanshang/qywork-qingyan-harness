import type { Accessor, Component, Setter } from 'solid-js'
import { createMemo, createSignal, For } from 'solid-js'
import { Dynamic } from 'solid-js/web'
import { buildRenderItems, type RenderItem, sameRenderItem } from '../../lib/render-items.ts'
import { isRunning, type TranscriptItem } from '../../lib/store/index.ts'
import { Prose } from './Prose.tsx'
import { RowStream } from './row-stream.ts'
import { CompactionCard } from './status/CompactionCard.tsx'
import { RunCard } from './status/RunCard.tsx'
import { ThinkingFold } from './ThinkingFold.tsx'
import { ToolCard } from './tools/ToolCard.tsx'
import { ToolGroup } from './tools/ToolGroup.tsx'
import { UserRow } from './UserRow.tsx'

/**
 * 每种行对应的组件。键是 `RenderItem['kind']` 的全集，缺少一种时类型检查失败；
 * 组件收到该种行的投影对象（`id` 与 `item`，工具组为 `id` 与 `members`）。
 */
const ROW_VIEWS: { [K in RenderItem['kind']]: Component<Extract<RenderItem, { kind: K }>> } = {
  user: UserRow,
  text: Prose,
  thinking: ThinkingFold,
  tool: ToolCard,
  compaction: CompactionCard,
  run: RunCard,
  group: ToolGroup,
}

/** 一行的固定行对象：`<For>` 按它匹配，内容从 `node` 读取；同一 id 只对应一个行对象。 */
interface RenderRow {
  node: Accessor<RenderItem>
}

interface RowCell {
  row: RenderRow
  set: Setter<RenderItem>
  /** 该行的首个会话条目。 */
  source: TranscriptItem
}

const sourceOf = (item: RenderItem): TranscriptItem =>
  item.kind === 'group' ? item.members[0]! : item.item

/**
 * 把每轮新生成的投影转换为按 id 固定的行对象。行对象中的信号以 `sameRenderItem` 为相等判据，
 * 内容未变时不通知。不要把 `buildRenderItems` 的结果直接交给 `<For>`：`<For>` 按引用匹配，
 * 分组卡片每增加一个成员、workflow 折叠项每收到一个进度事件都会生成新对象，整行 DOM 被销毁
 * 重建，已展开的折叠条目被收起，连线的虚线动画从头开始。
 *
 * 按 id 未找到时按首个会话条目沿用原行：乐观插入的消息在 `run.started` 到达后原地改写 id，
 * 条目对象不变。整行重建时新元素先按 `content-visibility` 的 80px 占位参与布局，贴底的会话流
 * 随之被浏览器收紧滚动位置；最终高度不变，ResizeObserver 不触发，刚发送的消息停在输入框下方。
 */
function keyedRows(source: () => RenderItem[]): Accessor<RenderRow[]> {
  let cells = new Map<string, RowCell>()
  return createMemo(() => {
    const bySource = new Map<TranscriptItem, RowCell>()
    for (const cell of cells.values()) bySource.set(cell.source, cell)
    const next = new Map<string, RowCell>()
    const rows = source().map((item) => {
      let cell = cells.get(item.id) ?? bySource.get(sourceOf(item))
      if (cell) {
        cell.set(item)
        cell.source = sourceOf(item)
      } else {
        const [node, set] = createSignal(item, { equals: sameRenderItem })
        cell = { row: { node }, set, source: sourceOf(item) }
      }
      next.set(item.id, cell)
      return cell.row
    })
    cells = next
    return rows
  })
}

/**
 * 会话流的正文行。父会话与右侧面板中的只读子会话共用同一实现：
 * 分别渲染时，新增一种条目必然遗漏其中一处。
 *
 * 滚动跟随不在行组件中：父页与子页各自的滚动容器都调用 `createConversationScroll`。
 */
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
        {({ node }) => <Dynamic component={ROW_VIEWS[node().kind]} {...node()} />}
      </For>
    </RowStream.Provider>
  )
}
