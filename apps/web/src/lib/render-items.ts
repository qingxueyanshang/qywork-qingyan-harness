/**
 * 渲染投影：把线性的 transcript 折成可读的分组。
 *
 * 移植自原版 `RunRenderer.buildRenderItems`。分组规则是这套 UI 里最有价值的一条
 * 经验，照搬不改：
 *
 * - **只有 assistant 正文（text）打断分组。** 连续的工具调用——不管什么 kind、
 *   不管属不属于同一个 provider batch——折成一张组卡。一轮跑几十个工具是常态，
 *   平铺会把正文淹没。
 * - **thinking 不切组**：夹在首尾工具之间的进组（展开后按顺序穿插），
 *   组前/组后的单独成条。末尾那段思考尤其不能卷进工具折叠里——它属于「想完了准备说话」，
 *   卷进去用户就找不到了。
 * - **少于 2 个工具不组卡**：为一个工具套一层折叠纯属添乱。
 */

import type { TranscriptItem } from './store/index.ts'

export type RenderItem =
  | { kind: 'user'; id: string; item: TranscriptItem }
  | { kind: 'text'; id: string; item: TranscriptItem }
  | { kind: 'thinking'; id: string; item: TranscriptItem }
  | { kind: 'tool'; id: string; item: TranscriptItem }
  | { kind: 'compaction'; id: string; item: TranscriptItem }
  | { kind: 'group'; id: string; members: TranscriptItem[] }

export function buildRenderItems(transcript: TranscriptItem[]): RenderItem[] {
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
    segment.push(item)
  }
  flush()
  return out
}

/**
 * 组头文案：按动作类型首次出现顺序分桶，每桶「动词 N 个对象」。
 * 同桶对象不一致时退化成「N 个动作」——硬凑一个名词只会误导。
 */
export function groupTitle(members: TranscriptItem[]): string {
  const tools = members.filter((m) => m.kind === 'tool')
  const running = tools.find((s) => s.status === 'running')
  if (running) return `正在${verb(running.action?.kind)}…`

  const order: string[] = []
  const byKind = new Map<string, TranscriptItem[]>()
  for (const s of tools) {
    const k = s.action?.kind ?? 'execute'
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
    return `${verb(k)} ${list.length} 个${noun}`
  })

  const failed = tools.filter((s) => s.status === 'failure').length
  const base = parts.join('，')
  return failed > 0 ? `${base}，${failed} 个失败` : base
}

export function verb(kind: string | undefined): string {
  switch (kind) {
    case 'read':
      return '读取'
    case 'write':
      return '写入'
    case 'edit':
      return '编辑'
    case 'delete':
      return '删除'
    case 'execute':
      return '执行'
    case 'search':
      return '搜索'
    case 'fetch':
      return '获取'
    case 'plan':
      return '规划'
    case 'delegate':
      return '委派'
    default:
      return '操作'
  }
}

/** 单条工具卡的完整文案：动词 + 对象。 */
export function actionLabel(item: TranscriptItem): string {
  const kind = item.action?.kind
  if (kind === 'execute') return '执行命令'
  const obj = item.action?.objectLabel
  return obj ? `${verb(kind)}${obj}` : (item.toolName ?? '操作')
}
