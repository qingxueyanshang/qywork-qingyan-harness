/**
 * 工具步骤的纯呈现逻辑：截断、分类、取值、格式化。
 *
 * 单独成文件是为了可测试：组件文件是 `.tsx`，`bun test` 加载时会查找 JSX
 * runtime 并失败（`lib/slash.ts` 因同一原因拆出）。每个函数都有实际的边界条件，
 * 仅凭目视检查渲染结果无法验证。
 *
 * 判据：不访问 DOM、不读取 store 的函数都不应放在组件文件中。
 */

import {
  type ErrorCode,
  type ProviderRequestStatus,
  type ProviderRetryDecision,
  type StopReason,
  SUBAGENT_NODE_ID,
} from '@qywork/core'

const NEWLINE = String.fromCharCode(10)
const CARRIAGE_RETURN = String.fromCharCode(13)

/** 只取第一行：卡片顶部的标题是本次派发任务的名称，不是任务说明，多行会撑高卡片。 */
export function firstLine(text: string): string {
  const cut = text.indexOf(NEWLINE)
  return cut < 0 ? text : text.slice(0, cut)
}

/** 大数缩写为 12.3K / 1.2M：读数条供快速浏览，六位数字难以直接看出数量级。 */
export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** 命中率需要的字段。写成结构类型而不是 import `RunUsage`：单元测试须能直接传入数据。 */
interface UsageLike {
  inputTokens: number
  cachedTokens: number | null
  cacheWriteTokens: number | null
  turns: readonly {
    input: number
    cached: number | null
    cacheWrite: number | null
    /** provider 表示模型实际回报；estimated 表示本地估算。 */
    source: 'provider' | 'estimated'
  }[]
}

/**
 * 缓存命中率。
 *
 * 报告比例而不是绝对值：绝对值须与输入量对照才有意义，该除法不应由用户计算。
 *
 * 分母是本次请求的输入总量，而不是 `inputTokens`。三家适配器统一采用排他口径：
 * `inputTokens` 只包含未命中部分（`providers/anthropic.ts` 原生如此，`openai-compat.ts` /
 * `openai-responses.ts` 显式减去了命中量）。以它作分母会把命中部分从分母中扣除，计算出的比例
 * 始终偏高，命中量大时会超过 100%：794K 命中、2K 未命中会输出 39700%。正确的分母是
 * `未命中 + 命中 + 写入`。
 *
 * 取最后一次模型调用，而不是整轮累计。一轮中的第一次调用必然未命中，按累计计算会把它平摊进去，
 * 使长轮次的命中率偏低；而用户查看该数值是为了确认缓存当前是否生效。不要改为整轮累计：该字段的
 * 语义就是最近一次调用，同一行其余字段为累计值不构成修改它的理由。只有没有逐轮记录（旧数据、
 * 流中断）时才回落到整轮累计，且回落时不得显示 `—`：「有缓存但没有逐轮记录」与「没有缓存」含义不同。
 *
 * 最后一次调用未回报缓存字段时显示 `N/A`，不显示 0，也不向前查找。`null` 表示 provider
 * 未提供该数值；强制转换为 0 是编造数据，向前查找则会把旧命中率显示为当前命中率。只有 provider
 * 明确回报的 0 才显示 0。
 *
 * 使用本地估算时同样显示 `N/A`：此时命中量与输入量均未知。
 */
export function hitRate(usage: UsageLike): string {
  const last = usage.turns[usage.turns.length - 1]
  // 本次调用没有返回 usage：命中量与输入量均未知，显示 0 是编造数据。
  if (last && last.source !== 'provider') return 'N/A'
  const cached = last ? last.cached : usage.cachedTokens
  if (cached === null) return 'N/A'

  const denom = last
    ? last.input + cached + (last.cacheWrite ?? 0)
    : usage.inputTokens + cached + (usage.cacheWriteTokens ?? 0)
  // provider 明确回报 0 时显示 0；不得因本次调用没有 token 而改写为未知。
  if (denom <= 0) return cached === 0 ? '0.00%' : 'N/A'
  return `${((cached / denom) * 100).toFixed(2)}%`
}

export const TARGET_MAX = 48

/**
 * 动作行 target 的净化：压缩空白，截断超长内容。
 *
 * 路径保留尾部（`…/submit/submit_core.py`），其余保留头部（长正则、长模式串）。
 * 有效信息在哪一端就保留哪一端：两类都截断同一侧时，必然有一类丢失有效的部分。
 */
export function sanitizeTarget(target: string): string {
  const clean = target.replace(/\s+/g, ' ').trim()
  if (clean.length <= TARGET_MAX) return clean
  return /[/\\]/.test(clean)
    ? `…${clean.slice(-(TARGET_MAX - 1))}`
    : `${clean.slice(0, TARGET_MAX - 1)}…`
}

/**
 * 外置工具的目标去除 `mcp:` / `plugin:` 前缀，只在显示时去除。
 *
 * 后端的值必须带前缀：权限 scope 是 `${effect}:${target}`，target 是前缀的唯一载体，
 * 去除后，id 为 `github` 的插件的 `search` 与同名 MCP server 的 `search`
 * 会得到相同的 scope 字符串，产生冲突。而卡片上的对象名已注明「MCP」/「插件」，
 * 目标中再重复一次会显示为「调用 MCP · mcp:github/search」。
 */
export function displayTarget(target: string): string {
  return target.replace(/^(?:mcp|plugin):/, '')
}

/**
 * `read_file` 实际交付的行号范围（`395-448`），附加在路径之后。
 *
 * 同一文件分段读取时，不带范围的几行显示同一路径，与重复读取无法区分。
 * 读取整个文件、或起始行超出文件末尾（结果为 0 行）时返回 null。
 */
export function readRange(data: unknown): string | null {
  const d = data as { startLine?: unknown; endLine?: unknown; totalLines?: unknown } | undefined
  if (
    typeof d?.startLine !== 'number' ||
    typeof d.endLine !== 'number' ||
    typeof d.totalLines !== 'number'
  ) {
    return null
  }
  if (d.endLine < d.startLine || (d.startLine <= 1 && d.endLine >= d.totalLines)) return null
  return `${d.startLine}-${d.endLine}`
}

/** 终态文字。成功时为空字符串：一屏几十行都显示「成功」不提供任何信息。 */
export function statusWord(status: 'running' | 'success' | 'failure' | undefined): string {
  return status === 'failure' ? '失败' : ''
}

/**
 * 一次调用修改的行数：`+N −M`。
 *
 * 两个数随 `ToolOutcome.fileChanges` 写入账本（由 `tools/src/files.ts` 的 `countDiff`
 * 计算）。一次调用可能修改多个文件，因此求和。
 *
 * 两个数都为 0 时不显示角标：`+0 −0` 占用行尾却不提供信息。
 * 没有行数的写入（由工作区观察器判定的 shell 与外部 CLI 写入）不计入。
 */
export function fileDelta(
  changes: readonly { additions?: number; deletions?: number }[] | undefined,
): { additions: number; deletions: number } | null {
  if (!changes || changes.length === 0) return null
  let additions = 0
  let deletions = 0
  for (const c of changes) {
    additions += c.additions ?? 0
    deletions += c.deletions ?? 0
  }
  return additions === 0 && deletions === 0 ? null : { additions, deletions }
}

/** 列表型结果：目录项、命中行、匹配文件，形状都是 string[]，渲染方式相同。 */
export function listOf(data: Record<string, unknown>): string[] | null {
  for (const key of ['entries', 'matches', 'files']) {
    const v = data[key]
    if (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === 'string')) {
      return v as string[]
    }
  }
  return null
}

export interface ResultImage {
  data: string
  mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
}

/**
 * 校验明确要求展示的工具结果中的图片字节。
 *
 * 图片字节随结果原样写入 step 账本，供模型视觉输入与历史重建使用；是否展示由
 * `ToolOutcomeWire.presentation` 单独裁决。此处只接受模型接口同样支持的四种栅格格式，
 * 第三方工具写入任意 data URL 或 SVG 时不为其扩大执行面。
 */
export function resultImages(data: unknown): ResultImage[] {
  if (!data || typeof data !== 'object') return []
  const raw = (data as { images?: unknown }).images
  if (!Array.isArray(raw)) return []

  const allowed = new Set<ResultImage['mime']>([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ])
  const images: ResultImage[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const { data: bytes, mime } = item as { data?: unknown; mime?: unknown }
    if (typeof bytes !== 'string' || bytes.length === 0) continue
    if (typeof mime !== 'string' || !allowed.has(mime as ResultImage['mime'])) continue
    images.push({ data: bytes, mime: mime as ResultImage['mime'] })
  }
  return images
}

/** 参数表：跳过空值与超长值；长文本使用专用块显示，放入键值表会撑大卡片。 */
export function argsRows(args: Record<string, unknown>): [string, string][] {
  const rows: [string, string][] = []
  for (const [k, v] of Object.entries(args)) {
    if (v === undefined || v === null || v === '') continue
    const text = typeof v === 'string' ? v : JSON.stringify(v)
    if (text.length > 400) continue
    rows.push([k, text])
  }
  return rows
}

/**
 * 待办清单型参数：`{ todos: [{ content, status }, …] }`。
 *
 * 按形状识别，不按工具名识别：同文件的 `listOf` / `diffFrom` 采用相同做法，
 * 展开内容中的 Switch 不判断步骤由哪个工具调用。
 *
 * 无法识别时返回 null（而不是空数组）：空数组会使调用方渲染出一个空的清单框，
 * 而没有清单时应使用通用参数表。
 */
export function todosOf(
  args: Record<string, unknown>,
): { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }[] | null {
  const raw = args.todos
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: { id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }[] = []
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i] as Record<string, unknown> | null
    if (!t || typeof t !== 'object') return null
    if (typeof t.content !== 'string') return null
    const status = t.status
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') return null
    // 数据库中的 args 不含 id（id 由工具补充），按行渲染需要稳定的 key，因此按位置补充。
    out.push({ id: typeof t.id === 'string' ? t.id : `todo_${i + 1}`, content: t.content, status })
  }
  return out
}

export function firstString(args: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = args[k]
    if (typeof v === 'string' && v.trim()) return v
  }
  return ''
}

/**
 * 丢弃被回车符覆盖的中间帧，每行只保留最后一帧。
 *
 * 带进度显示的命令（curl、npm、pip、cargo）用单独的回车符回到行首重绘同一行，
 * 终端中只显示最后一帧。`<pre>` 把它当作普通空白，不折叠时会把全部帧依次显示出来。
 *
 * 必须先去除行尾的回车符：CRLF 行尾的回车符不是覆盖标记，
 * 按覆盖处理会把整行当作残留内容丢弃。
 */
export function collapseCarriageReturns(text: string): string {
  if (!text.includes(CARRIAGE_RETURN)) return text
  return text
    .split(NEWLINE)
    .map((line) => {
      const body = line.endsWith(CARRIAGE_RETURN) ? line.slice(0, -1) : line
      return body.slice(body.lastIndexOf(CARRIAGE_RETURN) + 1)
    })
    .join(NEWLINE)
}

export const CLAMP = 20_000

/** 超长正文截断并注明剩余字数：只截断而不注明，会被理解为文件只有这么长。 */
export function clamp(text: string): string {
  return text.length <= CLAMP
    ? text
    : `${text.slice(0, CLAMP)}${NEWLINE}…（剩余 ${text.length - CLAMP} 字）`
}

/**
 * 从编辑参数中取出可按删除与新增两侧呈现的两段内容。
 *
 * 先识别 old/new 这类成对字段，再回落到整段 patch；`edits` 数组逐项识别后按顺序合并。
 * 都无法取得时返回 null：返回空 diff 会在界面上渲染出一个空的差异框。
 */
export function diffFrom(args: Record<string, unknown>): { removed: string; added: string } | null {
  if (Array.isArray(args.edits)) {
    const parts = args.edits
      .map((e) => (e && typeof e === 'object' ? diffFrom(e as Record<string, unknown>) : null))
      .filter((d) => d !== null)
    if (parts.length === 0) return null
    return {
      removed: parts.map((p) => p.removed).join(''),
      added: parts
        .map((p) => p.added)
        .filter(Boolean)
        .join(NEWLINE),
    }
  }
  const removed = firstString(args, 'old_string', 'old', 'old_text', 'before')
  const added = firstString(args, 'new_string', 'new', 'new_text', 'after')
  if (removed || added) {
    return { removed: removed ? `- ${removed}${NEWLINE}` : '', added: added ? `+ ${added}` : '' }
  }
  const patch = firstString(args, 'patch', 'diff')
  if (!patch) return null
  const lines = patch.split(NEWLINE)
  return {
    removed: lines.filter((l) => l.startsWith('-')).join(NEWLINE),
    added: lines.filter((l) => l.startsWith('+')).join(NEWLINE),
  }
}

/**
 * 停止原因的文案。
 *
 * 放在此处而不是组件中：会话流的收尾条与运行详情面板都要显示它。
 * 复制第二份会使面板把协议停止码直接显示给用户。
 *
 * 协议值只用于传输，界面只显示这张完整映射中的产品文案。无法识别的值省略：
 * 把内部枚举直接显示给用户既不能解释问题，也会在前后端版本短暂不一致时显示不存在的状态。
 */
export function stopReasonLabel(reason: string): string | null {
  const map: Record<StopReason, string> = {
    completed: '已完成',
    // 当前负责在连续无进展时终止的是进展判据，增加轮数无助于恢复。
    no_progress: '模型执行出错，多次重复，已暂停',
    awaiting_user: '等待用户回复',
    user_interrupt: '已中断',
    // 与「已中断」区分：用户未点击停止，是服务进程退出（热重载、崩溃、关机）。
    // 若两者都显示「已中断」，界面会显示一个用户未执行过的操作。
    process_exit: '服务进程退出',
    output_truncated: '输出被截断',
    provider_error: '模型服务出错',
    internal_guard: '进程中途退出，结果不可信',
  }
  return map[reason as StopReason] ?? null
}

const ERROR_LABELS: Record<ErrorCode, string> = {
  no_api_key: '未配置 API Key',
  auth_failed: '鉴权失败',
  rate_limited: '触发限速',
  insufficient_quota: '账户额度不足',
  context_overflow: '上下文超出模型窗口',
  model_not_found: '模型不存在',
  no_model: '未配置模型',
  invalid_request: '请求不合法',
  provider_unavailable: '模型服务暂不可用',
  network_error: '网络连接失败',
  stream_idle_timeout: '模型响应中断',
  tool_execution_failed: '工具执行失败',
  workspace_unavailable: '工作区不可用',
  internal_error: '内部错误',
}

const RETRY_LABELS: Record<ProviderRetryDecision, string> = {
  resend: '已自动重发',
  interrupted: '已中断，结果不明',
  not_retryable: '未重发',
  limit_exhausted: '重试已用尽',
  context_compaction: '已压缩后重发',
  context_compaction_failed: '压缩失败，未重发',
  process_exit: '服务进程退出，结果不明',
  run_ended: '本轮已结束，未取得完整的请求结果',
}

interface RequestOutcomeLike {
  status: ProviderRequestStatus
  /** 未提供时按主请求处理。摘要请求的产出是压缩摘要，结果列显示该项。 */
  purpose?: 'turn' | 'summary'
  finishReason: string
  errorCode: string | null
  errorMessage: string | null
  diagnostic: { retry: { decision: ProviderRetryDecision } } | null
  /** 响应头之前补发的第二份请求；未提供时按未补发处理。 */
  hedge?: { won: boolean } | null
}

function finishReasonLabel(reason: string): string {
  const normalized = reason.trim().toLowerCase()
  if (!normalized) return '已回报'
  if (/tool_calls|tool_use/.test(normalized)) return '调用工具'
  if (/max_(?:output_)?tokens|length|output_truncated/.test(normalized)) return '输出被截断'
  if (/pause_turn/.test(normalized)) return '已暂停，继续生成'
  if (/refusal|content_filter/.test(normalized)) return '请求被拒绝'
  if (/stop|end_turn|completed|success/.test(normalized)) return '已完成'
  return '已回报'
}

function errorLabel(code: string | null): string | null {
  return code ? (ERROR_LABELS[code as ErrorCode] ?? null) : null
}

function appendFact(base: string, fact: string): string {
  return `${base.replace(/[，。,.;；]+$/u, '')}，${fact}`
}

/**
 * 一次 provider 请求的用户可见结果。
 *
 * provider 原始 finish reason、错误码与重试裁决都保留在账本中，但不能直接作为界面文案；
 * 由这一个出口穷举重试裁决，避免结果列与悬浮说明各自维护一部分映射。
 * 补发过第二份请求时追加一项：两份请求都已发出，都可能计费，逐请求表须能与服务商账单对照。
 */
export function requestOutcome(q: RequestOutcomeLike): string {
  const base = outcomeText(q)
  return q.hedge ? appendFact(base, q.hedge.won ? '采用补发的一份' : '已补发') : base
}

function outcomeText(q: RequestOutcomeLike): string {
  if (q.status === 'received') {
    const label = finishReasonLabel(q.finishReason)
    // 截断与拒绝仍显示原有文案：它们正是摘要未生成的原因。
    if (q.purpose === 'summary' && (label === '已完成' || label === '已回报')) return '上下文压缩'
    return label
  }
  if (q.status === 'in_flight') return '进行中'
  if (q.status === 'pending') return '未发出'

  const decision = q.diagnostic?.retry.decision
  if (decision === 'interrupted' || decision === 'process_exit') return RETRY_LABELS[decision]

  const message = q.errorMessage ? firstLine(q.errorMessage).trim() : ''
  const base =
    message ||
    errorLabel(q.errorCode) ||
    (q.status === 'uncertain' ? '结果不明' : q.status === 'rejected' ? '被拒绝' : '请求失败')
  return decision ? appendFact(base, RETRY_LABELS[decision]) : base
}

// ────────────────────────────── 派发任务图 ──────────────────────────────

/**
 * 图上两个会话端点的 key。以不可打印字符开头，模型自行命名的节点 id 不会与之冲突；
 * 发生冲突时，该节点会连接到端点所在的位置。
 */
const ENTRY = `${String.fromCharCode(0)}entry`
const EXIT = `${String.fromCharCode(0)}exit`

/** 图上的一个节点。 */
export interface GraphNode {
  /** 用于认领进度与定位连线。子 agent 节点的 key 即 `team.member` 的 nodeId。 */
  key: string
  /** 主行。 */
  title: string
  /** 会话端点不可点开，也没有执行者。 */
  kind: 'session' | 'agent'
  /** 次行显示的指令内容：任务的第一行。 */
  task?: string
  needs: string[]
}

export interface DelegateGraph {
  /** 全部节点，含两端。连线按 `needs` 逐条绘制，因此须包含依赖。 */
  nodes: GraphNode[]
  /** 按依赖分层的视图：第 0 层是派出端，最后一层是收回端。 */
  layers: GraphNode[][]
  /**
   * 三个节点横向排列，中间的执行者固定在画布的几何中线。判据是只派发了一项任务，而不是工具名：
   * 只有一个节点的编排与一次派发任务形状相同，应呈现相同样式。
   *
   * 两侧会话端点使用对称的弹性列，在窄面板中同时收缩；不能按三个可见节点的内容宽度
   * 使整组居中，否则两端字宽或留白不等时，中间执行者会偏离画布中心。
   */
  horizontal: boolean
}

/**
 * 一次派发任务绘制为何种形状。形状只来自调用参数：参数随 `tool.started` 到达，
 * 因此第一帧即可绘制完整的图，等待执行的节点也显示在图上。状态经由另一条路径提供（见 `WorkflowCard`）。
 *
 * 两端的两个节点是同一条会话的两个时刻：派出与收回。绘制为两个节点，而不是一个节点加一条
 * 返回边，是因为返回边须绕回起点，必然横穿已分好的层。
 */
export function delegateGraph(item: {
  toolName?: string | undefined
  args?: Record<string, unknown> | undefined
}): DelegateGraph {
  const kids = childNodes(item)
  // 没有下游的节点汇入收回端；没有上游的节点从派出端连出。
  const leaves = kids.filter((n) => !kids.some((m) => m.needs.includes(n.key))).map((n) => n.key)
  const leafNodes = kids.filter((node) => leaves.includes(node.key))
  const needsExit =
    leafNodes.some((node) => node.kind === 'agent') || (leaves.length === 0 && kids.length > 0)
  const nodes: GraphNode[] = [
    { key: ENTRY, title: '当前会话', kind: 'session', needs: [] },
    ...kids.map((n) => (n.needs.length ? n : { ...n, needs: [ENTRY] })),
    ...(needsExit
      ? [{ key: EXIT, title: '当前会话', kind: 'session' as const, needs: leaves }]
      : []),
  ]
  return { nodes, layers: layered(nodes), horizontal: kids.length === 1 }
}

function childNodes(item: {
  toolName?: string | undefined
  args?: Record<string, unknown> | undefined
}): GraphNode[] {
  if (item.toolName === 'workflow') {
    const raw = item.args?.nodes
    if (!Array.isArray(raw)) return []
    return raw.map((n) => {
      const o = (n ?? {}) as Record<string, unknown>
      const id = String(o.id ?? '')
      const needs = Array.isArray(o.needs) ? o.needs.map(String) : []
      if (o.kind === 'checkpoint') {
        return {
          key: id,
          title: typeof o.label === 'string' && o.label.trim() ? o.label.trim() : '当前会话审查',
          kind: 'session' as const,
          needs,
        }
      }
      // 主行是节点名称，次行是其指令；节点 id 只用于连线与认领进度。
      return {
        key: id,
        title: targetTitle(o),
        kind: 'agent' as const,
        task: firstLine(typeof o.task === 'string' ? o.task : ''),
        needs,
      }
    })
  }
  const args = item.args ?? {}
  return [
    {
      key: SUBAGENT_NODE_ID,
      title: targetTitle(args),
      kind: 'agent',
      task: firstLine(typeof args.task === 'string' ? args.task : ''),
      needs: [],
    },
  ]
}

/**
 * 节点名称，仅凭调用参数即可计算：刷新后回放、进度事件到达之前都使用它。
 * 临时子 agent 为创建时指定的名称，角色为角色 id（状态到达后替换为角色名），外部 CLI 为 CLI id。
 */
function targetTitle(o: Record<string, unknown>): string {
  const pick = (key: string) => (typeof o[key] === 'string' ? (o[key] as string).trim() : '')
  return pick('subagent') || pick('name') || pick('role') || pick('cli') || '子 agent'
}

/** 按依赖分层：节点位于其全部上游中最深一层的下一层。 */
function layered(nodes: GraphNode[]): GraphNode[][] {
  const depth = new Map<string, number>()
  const of = (key: string, seen: Set<string>): number => {
    const known = depth.get(key)
    if (known !== undefined) return known
    // 成环时就地断开：模型生成的图由编排器校验，此处只保证能够绘制。
    if (seen.has(key)) return 0
    seen.add(key)
    const n = nodes.find((x) => x.key === key)
    const d = n?.needs.length ? Math.max(...n.needs.map((p) => of(p, seen))) + 1 : 0
    depth.set(key, d)
    return d
  }
  const out: GraphNode[][] = []
  for (const n of nodes) {
    const d = of(n.key, new Set())
    const layer = out[d] ?? []
    layer.push(n)
    out[d] = layer
  }
  return out.filter(Boolean)
}
