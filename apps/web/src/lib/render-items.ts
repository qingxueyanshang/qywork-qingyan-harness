/**
 * 渲染投影：把线性的 transcript 折成可读的分组。
 *
 * 分组规则三条，改动前先想清楚代价：
 *
 * - **只有 assistant 正文（text）打断分组。** 连续的工具调用——不管什么 kind、
 *   不管属不属于同一个 provider batch——折成一张组卡。一轮跑几十个工具是常态，
 *   平铺会把正文淹没。
 * - **thinking 不切组**：夹在首尾工具之间的进组（展开后按顺序穿插），
 *   组前/组后的单独成条。末尾那段思考尤其不能卷进工具折叠里——它属于「想完了准备说话」，
 *   卷进去用户就找不到了。
 * - **少于 2 个工具不组卡**：为一个工具套一层折叠只多一次点击。
 * - **派活的那两个不进组**（见 `STANDALONE`）。
 */

import { type ActionKind, foldWorkflow, workflowGroupId, workflowTransitionOf } from '@qywork/core'
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
 * 不参与分组的工具：它们各自是一整条子会话的入口，不是一次普通调用。
 *
 * `workflow` 那张图和 `subagent` 那段产出正是这一轮里最该先看到的内容，
 * 卷进工具组的折叠里就等于没有——实测过一次：一张四节点的图被并进
 * 「修改 2 个待办，运行 1 个编排，查询 1 个文件」那一行，图一个节点都看不见。
 */
const STANDALONE = new Set(['subagent', 'workflow'])

/** 只有生产者明确要求内联展示、且结果里确有合法图片时，图片工具才独立成条。 */
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

    // 组前的思考单独成条。
    for (let i = 0; i < first; i++) {
      out.push({ kind: 'thinking', id: segment[i]!.id, item: segment[i]! })
    }
    const middle = segment.slice(first, last + 1)
    out.push({ kind: 'group', id: middle[0]!.id, members: middle })
    // 组后的思考同样单独成条——不卷进折叠。
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
      // 收尾读数是这一轮的句号：**必须先 flush**，否则它会被卷进末尾那张工具组卡里，
      // 折叠起来就看不见了——而它是要一眼扫到的那一行。
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
 * 一个 workflow 可以在 transcript 里有多次工具调用，但界面语义始终是一张卡。
 * 这里只折叠已落在现有 tool step 里的事实，不保存 UI 专用状态。
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
    }))
    const folded = foldWorkflow(records, workflowId)
    if (!folded.ok) continue
    const isCheckpointWorkflow = folded.projection.nodes.some((node) => node.kind === 'checkpoint')
    const hasTransition = rows.some(({ item }) => workflowTransitionOf(item.outcome))
    // 迁移前的一次性 workflow 没有 transition，保持原卡原样，不能伪装成运行中。
    if (!isCheckpointWorkflow && !hasTransition && rows.length === 1) continue

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

/**
 * 组头文案：按动作类型首次出现顺序分桶，每桶「动词 N 个对象」。
 * 同桶对象不一致时退化成「N 个动作」——硬凑一个名词只会误导。
 *
 * **恒为摘要，跑着也是。** 别加「只要有一个工具在跑，整组标题就变成
 * 『正在<那一个的动词>…』」这种前置分支，两个毛病——
 *
 * - 一组里常常混着好几种动作（读三个文件、再跑一条命令），拿**其中一个**的动词
 *   当整组的标题，说的不是这一组在干什么。
 * - 它和卡片自己的「运行命令 · npm test」是同一句话加了个「正在」，
 *   而「这一轮此刻在哪个阶段」读数条已经说过一次了。
 *
 * 现在在不在跑由组头右边那个转圈说（`Fold` 的 `running`），文字只管「干了什么」，
 * 计数随工具陆续启动自然增长。
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
    return `${VERBS[k]} ${list.length} 个${noun}`
  })

  const failed = tools.filter((s) => s.status === 'failure').length
  const base = parts.join('，')
  return failed > 0 ? `${base}，${failed} 个失败` : base
}

/**
 * 动作动词。**一个 kind 一个词，一个不多。**
 *
 * 没有「其他 / 未知」这一档，也不需要有：动作由工具在注册期声明，注册表是唯一权威，
 * 这张表覆盖全部七个合法值。查不到的情况怎么被逐条堵死，见 `actionLabel`。
 */
const VERBS: Record<ActionKind, string> = {
  query: '查询',
  read: '读取',
  write: '创建',
  // 「创建 — 修改 — 删除」是一套；「编辑」是 UI 操作的说法，不是数据变更的说法。
  edit: '修改',
  delete: '删除',
  run: '运行',
  call: '调用',
}

export function verb(kind: ActionKind): string {
  return VERBS[kind]
}

/**
 * 单条工具卡的完整文案：**动词 + 对象**。
 *
 * **这里没有兜底文案，因为拼不出来的情况不存在。** 给缺失动作的行补标题只会
 * 掩盖上游错误。逐条核过：
 *
 * - 未注册调用**不会变成一条 step**：`loop.ts` 在编排波次之前就把它挡在执行链外。
 * - `action` 从版本控制的第一个提交起就一直随 step 落库，**没有缺它的历史行**。
 * - 退役的 kind 由 `store` 的迁移 16 一次性转成六枚举。
 *
 * 所以三条路各自堵死，剩下的空串只是类型上的收口：真出现了那是 bug，
 * 要在界面上看得出来，而不是被一句编出来的中文盖住。
 */
export function actionLabel(item: TranscriptItem): string {
  const a = item.action
  if (!a || !VERBS[a.kind] || !a.objectLabel) return ''
  return `${VERBS[a.kind]}${a.objectLabel}`
}

/**
 * 让没变的行保持**同一个对象引用**。
 *
 * `<For>` 是按引用配对的（不是按 id），而 `buildRenderItems` 每次都产出全新的包装
 * 对象——因此 transcript 每 push 一条（每个工具启动、每段思考、每次收尾），
 * 整列 DOM 全部销毁重建。两个后果：长会话里每来一条就重建一次全表；
 * 更严重的是**展开着的折叠会自己合上**——`<details>` 的 open 是原生状态，
 * 存在 DOM 节点上，节点没了状态就没了。运行中点开一张工具卡，
 * 下一个工具启动的瞬间它就关了。
 *
 * 这里不改 `buildRenderItems`（它是纯的、有测试），只在它之后补一次对账：
 * id 与 kind 相同、且底下指的还是同一条 transcript 条目，就沿用上一轮那个包装。
 * 正文增量不影响——store 的条目是代理对象，原地改字段时引用不变，
 * 行内的文本靠细粒度响应自己更新。
 */
export function reconcileRenderItems(prev: RenderItem[], next: RenderItem[]): RenderItem[] {
  if (prev.length === 0) return next
  const byId = new Map(prev.map((p) => [p.id, p]))

  return next.map((n) => {
    const old = byId.get(n.id)
    if (!old || old.kind !== n.kind) return n
    if (n.kind === 'group') {
      const o = old as Extract<RenderItem, { kind: 'group' }>
      const same =
        o.members.length === n.members.length && o.members.every((m, i) => m === n.members[i])
      return same ? o : n
    }
    const o = old as Exclude<RenderItem, { kind: 'group' }>
    return o.item === n.item ? o : n
  })
}
