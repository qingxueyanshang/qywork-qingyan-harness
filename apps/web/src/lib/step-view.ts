/**
 * 工具步骤的**纯呈现逻辑**——截断、分桶、取值、格式化。
 *
 * 单独一个文件是为了**能被测**：组件文件是 `.tsx`，`bun test` 一加载就去找 JSX
 * runtime 并失败（`lib/slash.ts` 同因拆出）。这些函数每一个都有真实的边界条件，
 * 靠肉眼看渲染结果验不出来。
 *
 * 判据很简单：**不碰 DOM、不读 store 的，都不该待在组件文件里。**
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

/** 只取第一行：卡顶那一格是这次派活的名字，不是任务书，多行会把卡撑高。 */
export function firstLine(text: string): string {
  const cut = text.indexOf(NEWLINE)
  return cut < 0 ? text : text.slice(0, cut)
}

/** 大数收成 12.3K / 1.2M：读数条是一行扫过去的，六位数字读不出量级。 */
export function compact(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** 派活卡上的子会话入口只认迁移后 step 顶层的规范字段。 */
export function delegateConversationId(item: { childConversationId?: string }): string | undefined {
  return item.childConversationId || undefined
}

/** 命中率要用到的那几格。写成结构类型而不是 import `RunUsage`：这个文件要能被单测直接喂数据。 */
interface UsageLike {
  inputTokens: number
  cachedTokens: number | null
  cacheWriteTokens: number | null
  turns: readonly {
    input: number
    cached: number | null
    cacheWrite: number | null
    /** provider = 模型真回报；estimated = 本地估算兜底。 */
    source: 'provider' | 'estimated'
  }[]
}

/**
 * 缓存命中率。
 *
 * **报比例不报绝对值**：绝对值要和输入量对着看才有意义，那个除法不该让用户做。
 *
 * **分母是「这次请求的输入总量」，不是 `inputTokens`。** 三家适配器统一收敛到**排他口径**：
 * `inputTokens` 里只装未命中的那部分（`providers/anthropic.ts` 原生如此，`openai-compat.ts` /
 * `openai-responses.ts` 明确减掉了命中量）。拿它当分母等于把命中的那一大块从分母里抠掉，算出来的比
 * 例恒偏高——命中量大时会超过 100%：794K 命中 / 2K 未命中打印成 39700%。正确的分母是
 * `未命中 + 命中 + 写入`。
 *
 * **看**最后一次**模型调用，不看整轮累计。** 一轮里第一次调用必然没有命中，累计口径把它摊进去，长轮
 * 次的率会被压低；而用户盯着这个数字想知道的是「现在缓存生效了吗」。**不要改成整轮累计**——这一
 * 格的语义就是最新那一次，同一行上其余几格是累计不构成改它的理由。没有逐轮记录（老数据、断流）才回
 * 落到整轮累计，**回落不能显示 `—`**：「有缓存但没逐轮记录」和「没有缓存」是两回事。
 *
 * **最后一次没回报缓存字段就是 `N/A`，而不是 0，更不能往前找。** `null` 表示 provider
 * 没给这个数；把它强转成 0 是编数据，往前找则会把旧命中率冒充成当前命中率。只有 provider
 * 明确回报的 0 才显示 0。
 *
 * 本地估算兜底同样显示 `N/A`：那时命中多少、输入多少都未知。
 */
export function hitRate(usage: UsageLike): string {
  const last = usage.turns[usage.turns.length - 1]
  // 这一次连 usage 都没回来：命中多少、输入多少都不知道，写 0 是编造数据。
  if (last && last.source !== 'provider') return 'N/A'
  const cached = last ? last.cached : usage.cachedTokens
  if (cached === null) return 'N/A'

  const denom = last
    ? last.input + cached + (last.cacheWrite ?? 0)
    : usage.inputTokens + cached + (usage.cacheWriteTokens ?? 0)
  // provider 明确回报 0 就是 0；不能因为这一调用没有 token 又把它改写成未知。
  if (denom <= 0) return cached === 0 ? '0.00%' : 'N/A'
  return `${((cached / denom) * 100).toFixed(2)}%`
}

export const TARGET_MAX = 48

/**
 * 动作行 target 净化：压空白、超长截断。
 *
 * **路径保尾部**（`…/submit/submit_core.py`），其余保头部（长正则、长模式串）。
 * 信息在哪一头就留哪一头——两头都截同一侧，必然有一类会被截掉有用的那半。
 */
export function sanitizeTarget(target: string): string {
  const clean = target.replace(/\s+/g, ' ').trim()
  if (clean.length <= TARGET_MAX) return clean
  return /[/\\]/.test(clean)
    ? `…${clean.slice(-(TARGET_MAX - 1))}`
    : `${clean.slice(0, TARGET_MAX - 1)}…`
}

/**
 * 外置工具的目标去掉 `mcp:` / `plugin:` 前缀。**只在显示时剥。**
 *
 * 后端那份必须带前缀：权限 scope 是 `${effect}:${target}`，target 是它唯一的载体，
 * 剥掉之后一个 id 叫 `github` 的插件的 `search` 和那个 MCP server 的 `search`
 * 会撞出同一个 scope 串。而卡片上对象名已经写着「MCP」/「插件」，
 * 目标里再说一遍就成了「调用 MCP · mcp:github/search」。
 */
export function displayTarget(target: string): string {
  return target.replace(/^(?:mcp|plugin):/, '')
}

/** 终态字样。**成功是空字符串**——一屏几十行全写「成功」等于没有信息。 */
export function statusWord(status: 'running' | 'success' | 'failure' | undefined): string {
  return status === 'failure' ? '失败' : ''
}

/**
 * 一次调用改了多少行：`+N −M`。
 *
 * 两个数随 `ToolOutcome.fileChanges` 落进账本（`tools/src/files.ts` 的 `countDiff`
 * 算的）。一次调用可能动多个文件，所以求和。
 *
 * **两个数都是 0 就不给角标**：`+0 −0` 占着行尾却什么也没说。
 */
export function fileDelta(
  changes: readonly { additions: number; deletions: number }[] | undefined,
): { additions: number; deletions: number } | null {
  if (!changes || changes.length === 0) return null
  let additions = 0
  let deletions = 0
  for (const c of changes) {
    additions += c.additions
    deletions += c.deletions
  }
  return additions === 0 && deletions === 0 ? null : { additions, deletions }
}

/** 列表型结果：目录项、命中行、匹配文件——形状都是 string[]，渲染方式也一样。 */
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
 * 从明确要求展示的工具结果里校验图片字节。
 *
 * 图片字节随结果原样落进 step 账本，供模型视觉输入与历史重建使用；是否展示由
 * `ToolOutcomeWire.presentation` 单独裁决。这里只接受模型接口同样支持的四种栅格格式，
 * 第三方工具塞进任意 data URL 或 SVG 时不替它扩大执行面。
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

/** 参数表：跳过空值与大值——长文本走专用块，塞进键值表会把卡片撑开。 */
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
 * **按形状认，不按工具名认**——同文件的 `listOf` / `diffFrom` 是同一个路子，
 * 展开体里那个 Switch 从来不问「这一步是谁调的」。
 *
 * 认不出就返回 null（不是空数组）：空数组会让调用方渲染出一个空的清单框，
 * 而「没有清单」应该走通用参数表那一支。
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
    // 落库的 args 里没有 id（那是工具补的），行渲染又要一个稳定 key，所以按位置补。
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
 * 把回车符覆盖掉的中间帧丢掉，每行只留最后一帧。
 *
 * 带进度显示的命令（curl、npm、pip、cargo）用裸回车符回到行首重画同一行，
 * 终端里只显示最后一帧。`<pre>` 把它当普通空白，不折叠就会把全部帧一起排出来。
 *
 * **必须先剥掉行尾的回车符**：CRLF 行尾的那个不是覆盖标记，
 * 按覆盖处理会把整行当成残留丢空。
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

/** 超长正文截断并**说清还剩多少**：只截不说，读起来就是文件只有这么长。 */
export function clamp(text: string): string {
  return text.length <= CLAMP
    ? text
    : `${text.slice(0, CLAMP)}${NEWLINE}…（还有 ${text.length - CLAMP} 字）`
}

/**
 * 从编辑参数里取出可以红绿呈现的两段。
 *
 * 先认 old/new 这类成对字段，再回落到整段 patch。都取不到返回 null——
 * 返回一个空 diff 会在界面上画出一个空的红绿框。
 */
export function diffFrom(args: Record<string, unknown>): { removed: string; added: string } | null {
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
 * 停止原因的说法。
 *
 * **住在这里而不是组件里**：会话流的收尾条和运行详情面板都要显示它。
 * 抄第二份的代价是面板那边会把协议停止码直接贴给用户。
 *
 * 协议词只负责传输，界面只显示这张完整映射里的产品文案。认不出的值省略：
 * 把内部枚举直接贴给用户既不能解释问题，也会在前后端短暂错版时制造“新状态”。
 */
export function stopReasonLabel(reason: string): string | null {
  const map: Record<StopReason, string> = {
    completed: '已完成',
    // 当前真正负责制止空转的是进展判据，多给轮数也没有用。
    no_progress: '模型执行出错，多次重复，已暂停',
    user_interrupt: '已中断',
    // 与「已中断」分开说：用户没点过停止，是服务进程退出了（热重载、崩溃、关机）。
    // 两句都说「已中断」的话，用户看到的是一个自己没做过的动作。
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
  visible_output: '已有输出，未重发',
  tool_calls_received: '已有工具调用，未重发',
  limit_exhausted: '重试已用尽',
  context_compaction: '已压缩后重发',
  context_compaction_failed: '压缩失败，未重发',
  process_exit: '服务进程退出，结果不明',
}

interface RequestOutcomeLike {
  status: ProviderRequestStatus
  finishReason: string
  errorCode: string | null
  errorMessage: string | null
  diagnostic: { retry: { decision: ProviderRetryDecision } } | null
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
 * 一次 provider 请求的用户可见结局。
 *
 * provider 原始 finish reason、错误码和重试裁决都保留在账本，但不能直接当 UI 文案；
 * 这一个出口穷举重试裁决，避免结果列与悬浮说明各维护半张映射。
 */
export function requestOutcome(q: RequestOutcomeLike): string {
  if (q.status === 'received') return finishReasonLabel(q.finishReason)
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

// ─────────────────────────────── 派活图 ───────────────────────────────

/**
 * 图上那两个会话端点的 key。用不可打印字符开头，模型自己起的节点 id 撞不上——
 * 撞上的话那个节点会连到端点该在的位置上去。
 */
const ENTRY = `${String.fromCharCode(0)}entry`
const EXIT = `${String.fromCharCode(0)}exit`

/**
 * 派活目标指向外部 CLI 时的前缀。
 *
 * 不从 `@qywork/team` 取：那个包在依赖图上不朝界面这边走，为一个前缀反向引一次
 * 不划算。前端这一侧只有这一处认这个前缀，改的时候两边一起改。
 */
export const CLI_PREFIX = 'cli:'

/** 图上的一格。 */
export interface GraphNode {
  /** 认领进度与连线定位都用它。子 agent 那一格的 key 就是 `team.member` 的 memberId。 */
  key: string
  /** 主行。 */
  title: string
  /** 会话端点不可点开，也没有执行者。 */
  kind: 'session' | 'agent'
  /** 派给谁：角色 id 或 `cli:<id>`，临时子 agent 是空串。会话端点没有这一项。 */
  agent: string
  /**
   * 次行印的执行者。**派一件时缺席**：那一格的主行已经是执行者，
   * 次行再印一遍是同一个词读两遍。
   */
  agentLabel?: string
  needs: string[]
}

export interface DelegateGraph {
  /** 全部格子，含两端。连线按 `needs` 逐条画，所以这一份要带依赖。 */
  nodes: GraphNode[]
  /** 按依赖分层的视图：第 0 层是派出端，最后一层是收回端。 */
  layers: GraphNode[][]
  /**
   * 三格横着摆，中间执行者钉在画布的几何中线。判据是**只派了一件事**，不是工具名
   * ——一个节点的编排与一次派活形状相同，本来就该长得一样。
   *
   * 两侧会话端点使用对称的弹性列，窄面板里共同收缩；不能按三个可见节点的内容宽度
   * 居中整组，否则两端字宽或留白不等时，中间执行者就会偏离画布中心。
   */
  horizontal: boolean
}

/**
 * 一次派活画成什么样。**形状只来自调用参数**——它随 `tool.started` 就到，
 * 所以第一帧就能把整张图画全，等着跑的格子也在图上。状态是另一条路（见 `WorkflowCard`）。
 *
 * 两端那两格是**同一条会话的两个时刻**：交出去、收回来。画成两格而不是一格加一条
 * 返回边，是因为返回边要绕回起点，那条线必然横穿已经分好的层。
 */
export function delegateGraph(item: {
  toolName?: string
  args?: Record<string, unknown>
}): DelegateGraph {
  const kids = childNodes(item)
  // 没有下游的那几格汇进收回端；没有上游的那几格从派出端接出来。
  const leaves = kids.filter((n) => !kids.some((m) => m.needs.includes(n.key))).map((n) => n.key)
  const leafNodes = kids.filter((node) => leaves.includes(node.key))
  const needsExit =
    leafNodes.some((node) => node.kind === 'agent') || (leaves.length === 0 && kids.length > 0)
  const nodes: GraphNode[] = [
    { key: ENTRY, title: '当前会话', kind: 'session', agent: '', needs: [] },
    ...kids.map((n) => (n.needs.length ? n : { ...n, needs: [ENTRY] })),
    ...(needsExit
      ? [{ key: EXIT, title: '当前会话', kind: 'session' as const, agent: '', needs: leaves }]
      : []),
  ]
  return { nodes, layers: layered(nodes), horizontal: kids.length === 1 }
}

function childNodes(item: { toolName?: string; args?: Record<string, unknown> }): GraphNode[] {
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
          agent: '',
          needs,
        }
      }
      const agent = String(o.agent ?? '')
      // 主行是节点 id：一张图里常常四格都是同一个执行者，区分得开的就是它。
      // 次行的执行者**一定要有个字**——节点没点名执行者时它是临时子 agent，
      // 填空串的话次行整行消失，而那一格看起来就像少了半截。
      return {
        key: id,
        title: id,
        kind: 'agent' as const,
        agent,
        agentLabel: agentTitle(agent),
        needs,
      }
    })
  }
  const agent = typeof item.args?.agent === 'string' ? item.args.agent.trim() : ''
  return [{ key: SUBAGENT_NODE_ID, title: agentTitle(agent), kind: 'agent', agent, needs: [] }]
}

/**
 * 派一件那一格的主行。运行期事件带的名字更全（厂商 + CLI 名），这里是刷新之后的回落，
 * 那时只剩调用参数。
 */
function agentTitle(agent: string): string {
  if (!agent) return '临时子 agent'
  return agent.startsWith(CLI_PREFIX) ? agent.slice(CLI_PREFIX.length) : agent
}

/** 按依赖分层：一格落在「它所有上游的最深层 + 1」。 */
function layered(nodes: GraphNode[]): GraphNode[][] {
  const depth = new Map<string, number>()
  const of = (key: string, seen: Set<string>): number => {
    const known = depth.get(key)
    if (known !== undefined) return known
    // 成环时就地断开：模型写出的图由编排器校验，这里只保证画得出来。
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
