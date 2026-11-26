/**
 * 渲染投影：把线性的 transcript 归并为可读的分组。
 *
 * 分组规则共四条，修改前须评估代价：
 *
 * - 只有 assistant 正文（text）打断分组。连续的工具调用，无论 kind，
 *   也无论是否属于同一个 provider batch，都归并为一张工具组卡片。一轮执行数十个工具是常态，
 *   平铺时正文被大量工具行分隔，难以连续阅读。
 * - thinking 不拆分工具组：位于首尾工具之间的思考进入工具组（展开后按顺序穿插），
 *   工具组之前与之后的思考单独成条。末尾的思考尤其不得并入工具折叠：它是回答正文之前的思考，
 *   折叠后用户无法找到。
 * - 少于 2 个工具时不生成工具组卡片：为单个工具添加折叠只会多一次点击。
 * - 派发任务的两个工具不进入工具组（见 `STANDALONE`）。
 */

import { foldWorkflow, type NodeState, workflowGroupId } from '@qywork/core'
import { resultImages } from './step-view.ts'
import type { TranscriptItem } from './store/index.ts'

export type RenderItem =
  | { kind: 'user'; id: string; item: TranscriptItem }
  | { kind: 'text'; id: string; item: TranscriptItem }
  | { kind: 'thinking'; id: string; item: TranscriptItem }
  | { kind: 'tool'; id: string; item: TranscriptItem }
  | { kind: 'compaction'; id: string; item: TranscriptItem }
  | { kind: 'run'; id: string; item: TranscriptItem }
  | { kind: 'group'; id: string; members: TranscriptItem[] }

/**
 * 不参与分组的工具：卡片上有需要直接看到或点击的内容，并入工具组的折叠后不可见。
 *
 * - `workflow` 的图与 `subagent` 的产出：每个都是一整条子会话的入口，是本轮中最需要首先看到的内容。
 *   实测实例：一张四节点的图被并入一个工具组，图的节点全部不可见。
 *
 * 本表只决定是否并入工具组，用哪种卡片渲染由 `ToolCard.tsx` 的 `TOOL_CARDS` 决定，两者互不推导：
 * 工具组的成员同样经 `ToolCard` 渲染，有专用卡片的工具（如 `open_in_panel`）可以位于工具组中。
 */
const STANDALONE = new Set(['subagent', 'workflow'])

/** 只有生产者明确要求内联展示、且结果中确有合法图片时，图片工具才独立成条。 */
function carriesPresentedImages(item: TranscriptItem): boolean {
  return (
    item.outcome?.presentation?.images === 'inline' && resultImages(item.outcome.data).length > 0
  )
}

export function buildRenderItems(transcript: TranscriptItem[]): RenderItem[] {
  transcript = collapseWorkflowItems(transcript)
  const out: RenderItem[] = []
  let segment: TranscriptItem[] = []

  const flush = () => {
    if (segment.length === 0) return

    const toolCount = segment.filter((m) => m.kind === 'tool').length
    if (toolCount < 2) {
      for (const m of segment) {
        out.push({ kind: m.kind === 'tool' ? 'tool' : 'thinking', id: m.id, item: m })
      }
      segment = []
      return
    }

    let first = -1
    let last = -1
    segment.forEach((m, i) => {
      if (m.kind === 'tool') {
        if (first < 0) first = i
        last = i
      }
    })

    // 工具组之前的思考单独成条。
    for (let i = 0; i < first; i++) {
      out.push({ kind: 'thinking', id: segment[i]!.id, item: segment[i]! })
    }
    const middle = segment.slice(first, last + 1)
    out.push({ kind: 'group', id: middle[0]!.id, members: middle })
    // 工具组之后的思考同样单独成条，不并入折叠。
    for (let i = last + 1; i < segment.length; i++) {
      out.push({ kind: 'thinking', id: segment[i]!.id, item: segment[i]! })
    }
    segment = []
  }

  for (const item of transcript) {
    if (item.kind === 'user') {
      flush()
      out.push({ kind: 'user', id: item.id, item })
      continue
    }
    if (item.kind === 'receipt') {
      // 回执是发给模型的输入，不渲染：结果显示在卡片的对应节点中。
      continue
    }
    if (item.kind === 'text') {
      // 只有正文打断分组。
      flush()
      out.push({ kind: 'text', id: item.id, item })
      continue
    }
    if (item.kind === 'compaction') {
      // 压缩是会话级事件，不属于任何工具组，独立成条。
      flush()
      out.push({ kind: 'compaction', id: item.id, item })
      continue
    }
    if (item.kind === 'run') {
      // 收尾读数是本轮的结束标记：必须先 flush，否则它会并入末尾的工具组卡片，
      // 折叠后不可见，而它需要直接可见。
      flush()
      out.push({ kind: 'run', id: item.id, item })
      continue
    }
    if (
      item.kind === 'tool' &&
      (STANDALONE.has(item.toolName ?? '') || carriesPresentedImages(item))
    ) {
      flush()
      out.push({ kind: 'tool', id: item.id, item })
      continue
    }
    segment.push(item)
  }
  flush()
  return out
}

/**
 * 一个 workflow 在 transcript 中可以有多次工具调用，但在界面上始终是一张卡片。
 * 此处只归并已写入现有 tool step 的事实，不保存界面专用状态。
 */
export function collapseWorkflowItems(transcript: TranscriptItem[]): TranscriptItem[] {
  const groups = new Map<string, Array<{ item: TranscriptItem; index: number }>>()
  transcript.forEach((item, index) => {
    if (item.kind !== 'tool' || item.toolName !== 'workflow') return
    const id = workflowGroupId({
      stepId: item.id,
      ...(item.args ? { args: item.args } : {}),
      ...(item.outcome ? { outcome: item.outcome } : {}),
    })
    const rows = groups.get(id)
    if (rows) rows.push({ item, index })
    else groups.set(id, [{ item, index }])
  })

  const hidden = new Set<number>()
  const replacements = new Map<number, TranscriptItem>()
  for (const [workflowId, rows] of groups) {
    const records = rows.map(({ item }) => ({
      stepId: item.id,
      ...(item.args ? { args: item.args } : {}),
      ...(item.outcome ? { outcome: item.outcome } : {}),
      ...(item.status ? { status: item.status } : {}),
      ...(item.nodes ? { nodes: item.nodes } : {}),
    }))
    const folded = foldWorkflow(records, workflowId)
    if (!folded.ok) continue
    const first = rows[0]!.item
    const last = rows.at(-1)!
    for (const row of rows.slice(0, -1)) hidden.add(row.index)
    replacements.set(last.index, {
      ...last.item,
      id: workflowId,
      ...(first.args ? { args: first.args } : {}),
      workflow: folded.projection,
    })
  }

  return transcript.flatMap((item, index) => {
    if (hidden.has(index)) return []
    return [replacements.get(index) ?? item]
  })
}

/** 会话流末尾的后台任务摘要与派发任务卡片共用节点状态；再次派发时只取每个子会话的最新状态。 */
export function delegationStatus(transcript: TranscriptItem[]): string | null {
  const states = new Map<string, NodeState>()
  const reviews: string[] = []
  for (const item of collapseWorkflowItems(transcript)) {
    if (item.kind !== 'tool' || !STANDALONE.has(item.toolName ?? '')) continue
    for (const [id, state] of Object.entries(item.workflow?.states ?? item.nodes ?? {})) {
      states.set(state.subagentId ?? `${item.id}:${id}`, state)
    }
    const workflow = item.workflow
    const checkpoint = workflow?.nodes.find((node) => node.id === workflow.checkpointId)
    if (checkpoint?.kind === 'checkpoint') reviews.push(checkpoint.label)
  }
  const active = [...states.values()].filter((state) => state.phase === 'working')
  if (active.length) return `等待子任务返回：${active.map((state) => state.label).join('、')}`
  const queued = [...states.values()].filter((state) => state.phase === 'queued')
  if (queued.length) return `子任务排队中：${queued.map((state) => state.label).join('、')}`
  return reviews.length ? `等待主会话审查：${reviews.join('、')}` : null
}

/**
 * 分组标题：按开头首次出现的顺序，每个开头写「开头 N 次」，以逗号连接。
 * 有问题的调用另由分组标题组件按状态计数，组内文件改动的合计行数显示在行尾。
 *
 * 运行中同样显示摘要。不要添加「只要有一个工具在运行，整组标题就改为『正在…』」这类前置分支：
 * 一个工具组通常包含多类动作，以其中一项作为整组标题无法描述整组；本轮当前所处的阶段已由读数条显示。
 * 计数随工具陆续启动而增长。
 */
export function groupTitle(members: TranscriptItem[]): string {
  const counts = new Map<string, number>()
  for (const m of members) {
    const head = m.kind === 'tool' ? m.action?.head : undefined
    if (head) counts.set(head, (counts.get(head) ?? 0) + 1)
  }
  return [...counts].map(([head, n]) => `${head} ${n} 次`).join('，')
}

/**
 * 单行工具的第二段：动词加对象。对象取执行后确定的名称（`outcome.subject`），没有时取调用时记录的对象；
 * 两者都没有时只显示动词。
 *
 * `action` 随每个 step 写入数据库：未注册的调用不会成为 step（`agent/loop/tool-wave.ts` 在编排批次之前拦截），
 * 历史记录的开头、动词与对象由迁移 81 写入。缺少 `action` 时返回空字符串，使缺陷在界面上可见。
 */
export function actionDetail(item: TranscriptItem): string {
  const a = item.action
  if (!a) return ''
  const object = item.outcome?.subject ?? a.object
  return object ? `${a.verb} ${object}` : a.verb
}

/**
 * 判定两个包装对象是否指向同一份内容：id 与 kind 相同，且底层仍指向同一条 transcript 条目
 * （工具组卡片则要求成员相同且顺序相同）。
 *
 * `<For>` 按引用配对，而 `buildRenderItems` 每轮都产出全新的包装对象。行的 DOM 不能
 * 直接绑定到包装对象：包装对象一旦替换，整行即销毁重建，而 `<details>` 的展开状态是
 * 存储在节点上的原生状态，节点销毁后状态随之丢失。因此 `TranscriptRows` 为每个 id
 * 提供一个固定的外壳，外壳中的信号依据本判据决定是否更新；store 的条目是代理对象，
 * 原地修改字段时引用不变，行内文本由细粒度响应自行更新，无需替换包装对象。
 */
export function sameRenderItem(a: RenderItem, b: RenderItem): boolean {
  if (a.id !== b.id || a.kind !== b.kind) return false
  if (a.kind === 'group' && b.kind === 'group') {
    return a.members.length === b.members.length && a.members.every((m, i) => m === b.members[i])
  }
  if (a.kind === 'group' || b.kind === 'group') return false
  return a.item === b.item
}
