/**
 * 渲染投影：把线性的 transcript 归并为可读的分组。
 *
 * 分组规则共四条，修改前须评估代价：
 *
 * - 只有 assistant 正文（text）打断分组。连续的工具调用，无论 kind，
 *   也无论是否属于同一个 provider batch，都归并为一张工具组卡片。一轮执行几十个工具是常态，
 *   平铺会淹没正文。
 * - thinking 不拆分工具组：位于首尾工具之间的思考进入工具组（展开后按顺序穿插），
 *   工具组之前与之后的思考单独成条。末尾的思考尤其不得并入工具折叠：它是回答正文之前的思考，
 *   折叠后用户无法找到。
 * - 少于 2 个工具时不生成工具组卡片：为单个工具添加折叠只会多一次点击。
 * - 派发任务的两个工具不进入工具组（见 `STANDALONE`）。
 */

import { type ActionKind, foldWorkflow, type NodeState, workflowGroupId } from '@qywork/core'
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
 * 不参与分组的工具：每个都是一整条子会话的入口，不是一次普通调用。
 *
 * `workflow` 的图与 `subagent` 的产出是本轮中最需要首先看到的内容，
 * 并入工具组的折叠后无法直接看到。实测实例：一张四节点的图被并入
 * 「修改 2 个待办，运行 1 个编排，查询 1 个文件」所在的工具组，图的节点全部不可见。
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
      // 回执是交给模型的输入，不渲染：结果显示在卡片的对应节点中。
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
 * 分组标题的动作文案：按动作类型首次出现的顺序分类，每类为「动词 N 个对象」。
 * 同类动作的对象不一致时退化为「N 个动作」：强行选用一个名词会误导用户。
 * 失败计数由分组标题组件单独显示，避免整段摘要显示为失败颜色。
 *
 * 运行中同样显示摘要。不要添加「只要有一个工具在运行，整组标题就改为
 * 『正在<该工具的动词>…』」这类前置分支，原因有二：
 *
 * - 一个工具组通常包含多种动作（读取三个文件后再执行一条命令），以其中一项的动词
 *   作为整组标题，无法描述整组动作。
 * - 该句与卡片自身的「运行命令 · npm test」只差「正在」二字，
 *   而本轮当前所处的阶段已由读数条显示。
 *
 * 是否在运行由分组标题右侧的加载图标表示（`Fold` 的 `running`），文字只描述执行了哪些动作，
 * 计数随工具陆续启动而增长。
 */
export function groupTitle(members: TranscriptItem[]): string {
  const tools = members.filter((m) => m.kind === 'tool')

  const order: ActionKind[] = []
  const byKind = new Map<ActionKind, TranscriptItem[]>()
  for (const s of tools) {
    const k = s.action?.kind
    if (!k || !VERBS[k]) continue
    const bucket = byKind.get(k)
    if (bucket) bucket.push(s)
    else {
      byKind.set(k, [s])
      order.push(k)
    }
  }

  const parts = order.map((k) => {
    const list = byKind.get(k)!
    const objects = new Set(list.map((s) => s.action?.objectLabel ?? ''))
    const noun = objects.size === 1 ? (list[0]!.action?.objectLabel ?? '动作') : '动作'
    return `${VERBS[k]} ${list.length} ${UNITS[k]}${noun}`
  })

  return parts.join('，')
}

/**
 * 动作动词。每个 kind 对应一个词，不多不少。
 *
 * 不设「其他 / 未知」类别，也无需设置：动作由工具在注册时声明，注册表是唯一权威，
 * 本表覆盖全部七个合法值。查不到的情况如何被逐一排除，见 `actionLabel`。
 */
const VERBS: Record<ActionKind, string> = {
  query: '查询',
  read: '读取',
  write: '创建',
  // 「创建、修改、删除」是一组用词；「编辑」描述界面操作，不描述数据变更。
  edit: '修改',
  delete: '删除',
  run: '运行',
  call: '调用',
}

/** 量词按动词区分：对象是实体的用「个」（读取 2 个文件），对象是动作的用「次」（调用 3 次浏览器控制）。 */
const UNITS: Record<ActionKind, string> = {
  query: '个',
  read: '个',
  write: '个',
  edit: '个',
  delete: '个',
  run: '次',
  call: '次',
}

export function verb(kind: ActionKind): string {
  return VERBS[kind]
}

/**
 * 单条工具卡片的完整文案：动词加对象。
 *
 * 此处不设后备文案，因为无法拼出文案的情况不存在。为缺少动作的行补充标题只会
 * 掩盖上游错误。已逐条核实：
 *
 * - 未注册的调用不会成为 step：`agent/loop/tool-wave.ts` 在编排批次之前就将其拦截在执行链之外。
 * - `action` 自版本控制的第一个提交起一直随 step 写入数据库，不存在缺少该字段的历史行。
 * - 已停用的 kind 由 `store` 的迁移 16 一次性转换为合法枚举值。
 *
 * 三条路径均已排除，剩余的空字符串只用于满足类型：一旦出现即为缺陷，
 * 须在界面上可见，而不是被编造的中文文案掩盖。
 */
export function actionLabel(item: TranscriptItem): string {
  const a = item.action
  if (!a || !VERBS[a.kind] || !a.objectLabel) return ''
  return `${VERBS[a.kind]}${a.objectLabel}`
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
