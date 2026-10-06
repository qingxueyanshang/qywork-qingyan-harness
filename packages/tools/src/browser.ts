/**
 * 内置浏览器的七个工具。
 *
 * 每次调用执行一个有限动作：发送一条端口命令即返回，由 Agent 循环决定下一步。
 * 此处不自行循环，也不重试有副作用的动作：重试一次点击等于在网站上多提交一次。
 *
 * 四条边界：
 *
 * 1. **端口只从 `ctx.browser` 获取。** 不读取参数中自行声明的会话、Run 与工作区根目录。
 *    没有端口时不注册这七个工具（`index.ts` 按通道注册），工具内部仍判断一次并如实报错。
 * 2. **注册表不按 schema 校验实参。** 必需参数、取值范围、数值有限性、动作参数的
 *    适用范围都在此处判定，判定完成之前不调用端口。
 * 3. **`null`、空串与字符串 `"null"` 视为缺失。** OpenAI 兼容协议的 strict 改写会将可选字段
 *    标为 nullable，模型因此常将未填写的字段显式写为 `null`，DeepSeek 写为字符串 `"null"`；
 *    若按非法值拒绝，一次正常调用会因一个无意填写的字段被拒绝。例外是
 *    `fill` 与 `select` 的 `text`：
 *    空串分别表示清空输入框与选中值为空的选项，只有 `null` 才视为未提供。
 * 4. **本地预览、上传与下载的路径先裁决再交给端口。** 使用本轮会话的根目录清单（`rootsOf`），
 *    与内置文件工具采用同一套判定；端口只按裁决后的绝对路径操作。
 *
 * `executed` 优先采用端口声明的执行前拒绝；其余异常按是否已进入端口保守判定，
 * 避免将已发出的页面动作标记为未执行。
 */

import { stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  type BrowserActionKind,
  type BrowserExecution,
  type BrowserKeyPhase,
  type BrowserObservation,
  type BrowserOptionsPage,
  type BrowserPathStep,
  type BrowserPoint,
  type BrowserPort,
  type BrowserWaitState,
  checkDuration,
  checkHeldKeys,
  checkKeyPhases,
  checkPath,
  type FollowUpObservation,
  INPUT_LIMITS,
  type ToolContext,
  type ToolOutcome,
  type ToolSpec,
} from '@qywork/agent'
import { browserResult, isOptionsPage, MAX_META_CHARS } from './browser-results.ts'
import { resolveInWorkspace, rootsOf, writableRoots } from './paths.ts'

/** 单次等待的上限。超过该值的请求按上限截断，不接受任意时长。 */
const MAX_WAIT_MS = 60_000
/** 等待时长的下限。更短的请求提升到该值。 */
const MIN_WAIT_MS = 100
/** 调用方未提供时长时的默认等待时长。 */
const DEFAULT_WAIT_MS = 10_000
/** `browser_wait` 的状态取值，含义见 `BrowserWaitState`。 */
const WAIT_STATES: readonly BrowserWaitState[] = [
  'visible',
  'attached',
  'hidden',
  'enabled',
  'text',
  'value',
]

/** 等待条件在 message 中的表述。 */
function stateText(state: BrowserWaitState, expected: string | undefined): string {
  switch (state) {
    case 'attached':
      return '在文档中'
    case 'visible':
      return '可见'
    case 'hidden':
      return '不可见或已移除'
    case 'enabled':
      return '可用'
    case 'text':
      return `文本为 ${JSON.stringify(expected ?? '')}`
    case 'value':
      return `值为 ${JSON.stringify(expected ?? '')}`
  }
}

/** 单次下载从触发到写入磁盘的时限。 */
const DOWNLOAD_TIMEOUT_MS = 120_000
/** 单次上传的文件数上限。 */
const MAX_UPLOAD_FILES = 10
/** `type` 单次输入的 Unicode 码点上限。 */
const MAX_TYPE_POINTS = 2000

/**
 * 调用端口之前判定的参数错误。
 *
 * 带 `errorKind` 是为了与路径拒绝（`PathEscapeError` 等）使用同一个出口：
 * 两者都是判定结果而不是故障，结果中 `executed` 必须为 `false`。
 */
class ArgError extends Error {
  readonly errorKind = 'invalid_argument'
  constructor(message: string) {
    super(message)
    this.name = 'ArgError'
  }
}

/** 判断可选参数是否已提供。`null`、空串与字符串 `"null"` 视为缺失，理由见文件头第 3 条。 */
function given(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false
  const text = String(raw).trim()
  return text !== '' && text.toLowerCase() !== 'null'
}

function str(raw: unknown, field: string): string {
  const value = String(raw ?? '').trim()
  if (!value) throw new ArgError(`缺少 ${field}`)
  return value
}

function oneOf<T extends string>(raw: unknown, allowed: readonly T[], field: string): T {
  const value = String(raw ?? '')
  if (!allowed.includes(value as T)) {
    throw new ArgError(`${field} 只能是 ${allowed.join(' / ')}，收到 ${JSON.stringify(raw)}`)
  }
  return value as T
}

/** 先判断有限性再截断：`NaN` 与 `Infinity` 一旦透传，端口侧计算出的时限没有上限。 */
function finite(raw: unknown, field: string): number {
  const value = Number(raw)
  if (!Number.isFinite(value))
    throw new ArgError(`${field} 必须是数字，收到 ${JSON.stringify(raw)}`)
  return value
}

function nonNegative(raw: unknown, field: string): number {
  const value = finite(raw, field)
  if (value < 0) throw new ArgError(`${field} 必须是非负整数`)
  return Math.floor(value)
}

/**
 * 读取选项模式的实参。缺失时为普通观察。
 *
 * 与 `frame` / `screenshot` / `offset` 互斥：这三个参数指定采集哪一份元素表，而本模式
 * 不采集元素表，同时提供属于参数错误，在调用端口前拒绝。
 */
function optionsForArg(
  args: Record<string, unknown>,
): { observationId: string; ref: string; offset?: number } | undefined {
  const raw = args.optionsFor
  if (raw === undefined || raw === null) return undefined
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArgError(`optionsFor 必须是对象，收到 ${JSON.stringify(raw)}`)
  }
  if (given(args.frame) || args.screenshot === true || given(args.offset) || given(args.query)) {
    throw new ArgError('optionsFor 不能与 frame、screenshot、offset、query 同时提供')
  }
  const one = raw as Record<string, unknown>
  return {
    observationId: str(one.observationId, 'optionsFor.observationId'),
    ref: str(one.ref, 'optionsFor.ref'),
    ...(given(one.offset) ? { offset: nonNegative(one.offset, 'optionsFor.offset') } : {}),
  }
}

/**
 * 每个动作适用的可选参数。
 *
 * 提供表外的参数属于参数错误，在调用端口前拒绝：若直接忽略而不报错，`click` 带 `toRef` 会得到
 * 一次成功的点击，而调用方会按拖动已完成继续下一步。
 */
const ACT_FIELDS: Record<BrowserActionKind, readonly string[]> = {
  click: ['ref', 'point', 'keys', 'holdMs'],
  dblclick: ['ref', 'point', 'keys'],
  rightclick: ['ref', 'point', 'keys', 'holdMs'],
  hover: ['ref', 'point'],
  fill: ['ref', 'text'],
  type: ['ref', 'text'],
  select: ['ref', 'text'],
  scroll: ['ref', 'point', 'deltaX', 'deltaY'],
  press: ['ref', 'phases'],
  drag: ['ref', 'point', 'keys', 'path'],
}

const ACT_KINDS = Object.keys(ACT_FIELDS) as BrowserActionKind[]

/** 动作的可选参数全集，逐个按 `ACT_FIELDS` 核对适用范围。 */
const ACT_OPTIONAL = [
  'ref',
  'point',
  'text',
  'phases',
  'keys',
  'holdMs',
  'path',
  'deltaX',
  'deltaY',
] as const

/** 判断值是否为对象（不含数组）。 */
function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw)
}

/** 元素内的落点：相对元素左上角的 CSS 像素偏移，两项都是非负有限数。 */
function pointArg(raw: unknown, field: string): BrowserPoint {
  if (!isRecord(raw)) throw new ArgError(`${field} 必须是 {x, y} 对象，收到 ${JSON.stringify(raw)}`)
  const x = finite(raw.x, `${field}.x`)
  const y = finite(raw.y, `${field}.y`)
  if (x < 0 || y < 0) throw new ArgError(`${field} 的 x、y 不能为负`)
  return { x, y }
}

/**
 * 一组键码。只判断结构，键码与上限由 `@qywork/agent` 的同一张表判定。
 *
 * **不要在此处另写一份键名判定**：端口按同一张表再判定一次，两份表会逐渐不一致，
 * 未知键码因此在预检时放行、到端口才被拒绝，调用方收到的是「动作可能已经发出」。
 */
function keyList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw))
    throw new ArgError(`${field} 必须是键码数组，收到 ${JSON.stringify(raw)}`)
  return raw.map((code) => String(code ?? '').trim())
}

/** `press` 的阶段。整段按同一张表与上限检查完毕后才调用端口。 */
function phasesArg(raw: unknown): BrowserKeyPhase[] {
  if (!Array.isArray(raw)) throw new ArgError(`phases 必须是数组，收到 ${JSON.stringify(raw)}`)
  const phases = raw.map((one, i) => {
    if (!isRecord(one)) throw new ArgError(`phases[${i}] 必须是 {keys, durationMs} 对象`)
    const keys =
      one.keys === undefined || one.keys === null ? [] : keyList(one.keys, `phases[${i}].keys`)
    return {
      keys,
      ...(given(one.durationMs)
        ? { durationMs: finite(one.durationMs, `phases[${i}].durationMs`) }
        : {}),
    }
  })
  const problem = checkKeyPhases(phases)
  if (problem) throw new ArgError(problem)
  return phases
}

/** 指针动作期间按住的键。 */
function heldArg(raw: unknown): string[] {
  const keys = keyList(raw, 'keys')
  const problem = checkHeldKeys(keys, 'keys')
  if (problem) throw new ArgError(problem)
  return keys
}

function holdArg(raw: unknown): number {
  const ms = finite(raw, 'holdMs')
  const problem = checkDuration(ms, 'holdMs')
  if (problem) throw new ArgError(problem)
  return ms
}

/** `drag` 的路径。每段必须有终点 ref；段数与时长按同一张上限表判定。 */
function pathArg(raw: unknown): BrowserPathStep[] {
  if (!Array.isArray(raw)) throw new ArgError(`path 必须是数组，收到 ${JSON.stringify(raw)}`)
  const path = raw.map((one, i): BrowserPathStep => {
    if (!isRecord(one)) throw new ArgError(`path[${i}] 必须是 {ref, point, durationMs} 对象`)
    return {
      ref: str(one.ref, `path[${i}].ref`),
      ...(isRecord(one.point) ? { point: pointArg(one.point, `path[${i}].point`) } : {}),
      ...(given(one.durationMs)
        ? { durationMs: finite(one.durationMs, `path[${i}].durationMs`) }
        : {}),
    }
  })
  const problem = checkPath(path)
  if (problem) throw new ArgError(problem)
  return path
}

/** 判断两个落点是否相同：都缺省（元素中心）或坐标相同。 */
function samePoint(a: BrowserPoint | undefined, b: BrowserPoint | undefined): boolean {
  if (!a || !b) return a === b
  return a.x === b.x && a.y === b.y
}

/** 换行与制表以外的 C0/C1 控制字符。返回第一个命中的字符。 */
function unsupportedControl(text: string): string | undefined {
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x09 || code === 0x0a) continue
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return ch
  }
  return undefined
}

/**
 * `type` 的文本预检。
 *
 * 整段检查完毕才发送第一个事件：发送中途才发现超长时，前半段已输入到页面，
 * 而输入事件无法撤回。CRLF 与单独的 CR 一律归一为换行，以 Enter 发送。
 */
function typeText(raw: unknown): string {
  if (raw === undefined || raw === null || String(raw) === '') {
    throw new ArgError('type 必须提供 text')
  }
  const text = String(raw).replace(/\r\n?/g, '\n')
  const points = [...text].length
  if (points > MAX_TYPE_POINTS) {
    throw new ArgError(`type 的 text 最多 ${MAX_TYPE_POINTS} 个字符，收到 ${points} 个`)
  }
  const bad = unsupportedControl(text)
  if (bad !== undefined) {
    const code = (bad.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')
    throw new ArgError(`type 的 text 含不支持的控制字符 U+${code}`)
  }
  return text
}

/**
 * `text` 的取值。
 *
 * `fill` 与 `select` 的空串分别表示清空输入框与值为空的选项，只有 `null` 才视为未提供；
 * `type` 经过整段预检；其余动作不适用该字段，在此之前已被适用范围检查拒绝。
 */
function textField(action: BrowserActionKind, raw: unknown): { text?: string } {
  if (action === 'type') return { text: typeText(raw) }
  if (action !== 'fill' && action !== 'select') return {}
  if (raw === undefined || raw === null) return {}
  return { text: String(raw) }
}

/**
 * 网页地址直接交给浏览器；本地文件先经过文件工具的路径裁决，再转为 file URL。
 *
 * 本地路径从第一个 `?` 起是查询串（其中从 `#` 起是片段），只有之前的部分参与路径裁决；
 * Windows 文件名不含 `?`。`?` 之前的 `#` 是文件名的一部分，不要按片段拆分：文件名含 `#`
 * 是常见写法。需要为不带查询串的本地路径添加片段时，使用 file URL。
 */
async function browserUrl(raw: unknown, ctx: ToolContext): Promise<string> {
  const value = str(raw, 'url')
  let candidate: string
  let suffix: { search: string; hash: string }
  // Windows 盘符不是 URL 协议；无协议的路径相对当前工作区解析。
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[/\\]/i.test(value)) {
    let parsed: URL
    try {
      parsed = new URL(value)
    } catch {
      throw new ArgError(`地址无法解析：${value}`)
    }
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString()
    if (parsed.protocol !== 'file:') {
      throw new ArgError(`只支持 http、https、本地文件路径与 file URL，收到 ${parsed.protocol}`)
    }
    try {
      candidate = fileURLToPath(parsed)
    } catch {
      throw new ArgError(`本地文件地址无法解析：${value}`)
    }
    suffix = parsed
  } else {
    const cut = value.indexOf('?')
    candidate = cut < 0 ? value : value.slice(0, cut)
    suffix = new URL(cut < 0 ? '' : value.slice(cut), 'file:///')
  }
  const absolute = await resolveInWorkspace(rootsOf(ctx), candidate, {
    mustExist: true,
    literal: true,
  })
  if (!(await stat(absolute)).isFile()) {
    throw new ArgError(`路径不是文件：${candidate}。请指定要预览的 HTML 或其他文件。`)
  }
  const url = pathToFileURL(absolute)
  url.search = suffix.search
  url.hash = suffix.hash
  return url.toString()
}

const NO_PORT = {
  status: 'failure',
  executed: false,
  message: '本次执行没有内置浏览器，无法操作页面。',
  errorKind: 'unsupported',
} as const

const STOPPED = {
  status: 'failure',
  executed: false,
  message: '本次执行已停止，不再操作浏览器。',
  errorKind: 'aborted',
} as const

/** 等待满 `ms` 后返回 `true`；中途取消时立即返回 `false`。 */
function pause(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      resolve(false)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve(true)
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 包装端口调用，记录调用发生的时刻。 */
type PortCall = <T>(call: () => Promise<T>) => Promise<T>

function declaredKind(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const kind = (err as Error & { errorKind?: unknown }).errorKind
  return typeof kind === 'string' && kind ? kind : undefined
}

/** 端口按 `BrowserRefusal` 声明的执行前拒绝。缺失时按 `send` 是否被调用过判定。 */
function declaredExecuted(err: unknown): boolean | undefined {
  if (!(err instanceof Error)) return undefined
  const executed = (err as Error & { executed?: unknown }).executed
  return typeof executed === 'boolean' ? executed : undefined
}

/**
 * 七个工具共用的前置判定与终态。
 *
 * 停止之后不再发起新动作：等待中的调用由端口自行拒绝，此处拒绝的是新发起的调用。
 * 异常的 `executed` 优先采用端口自身声明的值，缺失时按 `send` 是否被调用过判定：
 * 否则「参数写错」与「点击已发出但连接断开」会得到相同的结果，而后者禁止重发。
 * 判据只能是契约字段，不能匹配错误文案。
 */
async function onBrowser(
  ctx: ToolContext,
  body: (browser: BrowserPort, send: PortCall) => Promise<ToolOutcome>,
): Promise<ToolOutcome> {
  const browser = ctx.browser
  if (!browser) return NO_PORT
  if (ctx.signal.aborted) return STOPPED

  let entered = false
  const send: PortCall = (call) => {
    entered = true
    return call()
  }
  try {
    return await body(browser, send)
  } catch (err) {
    const executed = declaredExecuted(err) ?? entered
    return {
      status: 'failure',
      executed,
      message: err instanceof Error ? err.message : String(err),
      errorKind: declaredKind(err) ?? (executed ? 'browser_failed' : 'invalid_argument'),
    }
  }
}

/**
 * message 中页面标题与网址各自显示的最大字数。
 *
 * 与视图中页面元数据的上限是同一个数（`MAX_META_CHARS`）。页面自报的标题与网址长度没有上限
 * （data URL 可达数万字），而 message 不参与视图裁剪：一段长标题或一条长网址会耗尽整条
 * 结果的上限，元素表因此无法投递任何元素。原值仍在 `data` 中。
 */
const MAX_TITLE_CHARS = MAX_META_CHARS
const MAX_URL_CHARS = MAX_META_CHARS

/** 超过上限时显示前缀加省略号。网址的前缀是 origin 加路径前段，仍可识别打开的站点。 */
function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

function observationLine(ob: BrowserObservation): string {
  return (
    `${ob.title ? clip(ob.title, MAX_TITLE_CHARS) : '(无标题)'} · ${clip(ob.url, MAX_URL_CHARS)} · ${ob.elements.length} 个元素` +
    (ob.truncated ? '（还有更多，用 offset 继续获取）' : '') +
    (ob.framesPending?.length
      ? `（${ob.framesPending.length} 个 iframe 尚未就位，需重新观察）`
      : '')
  )
}

function optionsLine(page: BrowserOptionsPage): string {
  const shown = page.items.length
  return (
    `${page.ref} 的选项 ${shown === 0 ? 0 : page.offset + 1}-${page.offset + shown}/${page.total}` +
    (page.nextOffset === undefined ? '' : `（还有更多，optionsFor.offset=${page.nextOffset}）`)
  )
}

/**
 * 将动作回执与后续观察合成为一个结果。
 *
 * 有观察时展开到 `data` 顶层，其中的 `observationId` 可直接用于下一次动作；
 * 观察缺失时结果为失败而 `executed` 为真：动作已发送到网站，重复一次等于多提交一次。
 * 缺失时不沿用旧的 `observationId`。
 */
function withFollowUp(
  ctx: ToolContext,
  toolName: string,
  receipt: Record<string, unknown>,
  follow: FollowUpObservation,
  opts: { lead: string; ok: boolean; advice: string },
): ToolOutcome {
  if (follow.observation) {
    const ob = follow.observation
    return {
      status: opts.ok ? 'success' : 'failure',
      ...(opts.ok ? {} : { executed: true }),
      ...browserResult({
        ctx,
        toolName,
        page: ob,
        receipt,
        ...(follow.settle ? { settle: follow.settle } : {}),
        lead: `${opts.lead}${observationLine(ob)}`,
      }),
    }
  }
  return {
    status: 'failure',
    executed: true,
    message: `${opts.lead}未取得新的观察：${follow.observationError}。${opts.advice}`,
    data: { ...receipt, observationError: follow.observationError },
    errorKind: 'browser_observation_unavailable',
  }
}

/** 后续观察的三个键由 `withFollowUp` 单独投递，不属于回执字段。 */
const FOLLOW_KEYS = new Set(['observation', 'observationError', 'settle'])

/**
 * 端口回执原样写入结果。
 *
 * 若逐个字段挑选，动作侧新增的字段（规范化后的值、约束不满足的原因）无法到达
 * 调用方，结果中只剩一次没有原因的失败。
 */
function receiptOf(result: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(result).filter(([key, value]) => !FOLLOW_KEYS.has(key) && value !== undefined),
  )
}

/**
 * 部分完成与结果未知的投递。
 *
 * 动作命令已发送到网站，重放一次等于在网站上重复执行一次，因此一律为失败且
 * `executed` 为真。有观察时展开，供调用方据此判断实际执行到哪一步。
 */
function incompleteAct(
  ctx: ToolContext,
  action: BrowserActionKind,
  execution: BrowserExecution,
  receipt: Record<string, unknown>,
  follow: FollowUpObservation,
): ToolOutcome {
  const partial = execution.state === 'partial'
  const units =
    execution.confirmedUnits === undefined ? '' : `，已确认 ${execution.confirmedUnits} 个单元`
  const reason = execution.reason ? `（${execution.reason}）` : ''
  const unreleased = execution.unreleased?.length
    ? `未确认松开：${execution.unreleased.join('、')}。`
    : ''
  const lead =
    (partial ? `${action} 已部分发出${units}${reason}。` : `${action} 的结果未知${reason}。`) +
    unreleased
  const advice = '先 browser_observe 确认页面实际状态，不要重放该动作。'
  const errorKind = partial ? 'browser_partial' : 'browser_unknown'
  if (follow.observation) {
    return {
      status: 'failure',
      executed: true,
      ...browserResult({
        ctx,
        toolName: 'browser_act',
        page: follow.observation,
        receipt,
        ...(follow.settle ? { settle: follow.settle } : {}),
        lead: `${lead}${observationLine(follow.observation)}。${advice}`,
      }),
      errorKind,
    }
  }
  return {
    status: 'failure',
    executed: true,
    message: `${lead}未取得新的观察：${follow.observationError}。${advice}`,
    data: { ...receipt, observationError: follow.observationError },
    errorKind,
  }
}

/** 六个页面工具的目标是所操作的页面；`browser_tabs` 的 list 与 create 没有目标页面，见各自的 spec。 */
function tabTarget(args: Record<string, unknown>): string | null {
  return given(args.tabId) ? String(args.tabId).trim() : null
}

/** 元素内落点的参数形状，`point` 与 `path[].point` 共用。 */
const POINT_SCHEMA = {
  type: 'object',
  description: '元素内的落点：相对元素左上角的 CSS 像素偏移，缺省为元素中心',
  properties: { x: { type: 'number' }, y: { type: 'number' } },
  required: ['x', 'y'],
  additionalProperties: false,
} as const

const BASE = {
  category: 'browser',
  facet: '页面',
  objectLabel: '浏览器控制',
  permissionEffect: 'browser',
} as const

export const browserTabsTool: ToolSpec = {
  ...BASE,
  name: 'browser_tabs',
  description:
    '列出内置浏览器的标签页，或新建、接管、关闭一个标签页。' +
    'create 打开的页归本会话，后续消息可直接对其 observe 与 act；' +
    '简单 HTML 可直接传入本地路径或 file URL，无需启动服务；依赖开发服务器、模块加载或接口的项目使用 http/https 地址。' +
    'tabId 由 create 的返回值给出，同一轮中无法预知；create 已按 url 加载页面，无需再 navigate。' +
    '打开页面不附带观察，先 browser_observe 或 browser_wait 再操作。' +
    'list 返回的 controlled=false 是用户手动打开的页，' +
    '只有用户明确要求使用该页时才用 action=bind 接管。其他会话的页不在列表内。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['list', 'create', 'bind', 'close'] },
      url: {
        type: 'string',
        description:
          'action=create 时的 http/https 地址、file URL 或本地文件路径（相对工作区或绝对路径）',
      },
      tabId: {
        type: 'string',
        description: 'action=bind 要接管、action=close 要关闭的标签页',
      },
    },
    required: ['action'],
    additionalProperties: false,
  },
  // list 只读取清单；create / bind / close 改变本会话持有的页面。
  actionKind: (args) => (args.action === 'list' ? 'read' : 'call'),
  summary: '列出、新建、接管或关闭浏览器标签页',
  // list 与 create 没有目标页面，授权预览回退为「browser」而不是留空。
  targetExtractor: (args) => tabTarget(args) ?? 'browser',

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const action = oneOf(args.action, ['list', 'create', 'bind', 'close'] as const, 'action')

      if (action === 'create') {
        const url = await browserUrl(args.url, ctx)
        const tab = await send(() => browser.open(url))
        return {
          status: 'success',
          message: `已打开 ${tab.tabId}：${clip(tab.url, MAX_URL_CHARS)}。先 browser_observe 或 browser_wait 再操作。`,
          data: { tab },
        }
      }

      if (action === 'bind') {
        const tabId = str(args.tabId, 'tabId')
        const tab = await send(() => browser.bind(tabId))
        return {
          status: 'success',
          message: `已接管 ${tab.tabId}：${clip(tab.url, MAX_URL_CHARS)}`,
          data: { tab },
        }
      }

      if (action === 'close') {
        const tabId = str(args.tabId, 'tabId')
        await send(() => browser.close(tabId))
        return { status: 'success', message: `已关闭 ${tabId}`, data: { tabId } }
      }

      const tabs = await send(() => browser.tabs())
      const mine = tabs.filter((t) => t.controlled).length
      const user = tabs.length - mine
      return {
        status: 'success',
        message:
          `${tabs.length} 个标签页，其中 ${mine} 个归本会话（可直接操作）` +
          (user ? `，${user} 个是用户打开的（用户指定后可 bind 接管）` : ''),
        data: { tabs },
      }
    }),
}

export const browserNavigateTool: ToolSpec = {
  ...BASE,
  name: 'browser_navigate',
  description:
    '在已控制的标签页里跳转、后退、前进或重新加载。' +
    '简单 HTML 可直接打开本地路径或 file URL；需要服务的项目使用 http/https 地址。' +
    '取得新观察时结果中直接返回元素表与 observationId，据此继续下一步，不必再调用 browser_observe。' +
    'observationId 与元素 ref 属于产生它们的那次观察及其文档，文档更换后须使用新的观察。' +
    '未取得观察时结果为失败，先 browser_observe 确认当前页面，不要重复跳转。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      action: { type: 'string', enum: ['goto', 'back', 'forward', 'reload'] },
      url: {
        type: 'string',
        description:
          'action=goto 时的 http/https 地址、file URL 或本地文件路径（相对工作区或绝对路径）',
      },
    },
    required: ['tabId', 'action'],
    additionalProperties: false,
  },
  actionKind: 'call',
  summary: '在标签页里跳转、后退、前进或重新加载',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const tabId = str(args.tabId, 'tabId')
      const action = oneOf(args.action, ['goto', 'back', 'forward', 'reload'] as const, 'action')
      const input = {
        tabId,
        action,
        ...(action === 'goto' ? { url: await browserUrl(args.url, ctx) } : {}),
      }
      const follow = await send(() => browser.navigate(input))
      return withFollowUp(ctx, 'browser_navigate', {}, follow, {
        lead: `${action} 已发出。`,
        ok: true,
        advice: '先 browser_observe 确认当前页面，不要重复跳转。',
      })
    }),
}

export const browserObserveTool: ToolSpec = {
  ...BASE,
  name: 'browser_observe',
  description:
    '返回页面的实际地址、标题、可操作元素与正文。返回的 observationId 与元素 ref 是 act 的前提。' +
    'query 只返回名称、正文或值包含该文字的元素，已知查找目标时优先使用。' +
    'truncated=true 时用 offset 获取后续元素。' +
    '元素较多时结果中只包含前一部分，delivery 注明返回了多少、本次采集了多少；' +
    '其余元素按结果中的 resource id 用 read_resource 读取，页面其他范围仍用 offset 或 query。' +
    'screenshot=true 才截图，仅在元素表不足以判断版面时使用。' +
    'frame 仅观察某个 iframe，取自元素的 frame 字段。' +
    '元素上缺少 expanded 与 selected 表示该角色不具备这一属性，不表示收起或未选中；' +
    'options 是 select 的选项摘要，按当前页面实时读取。' +
    '浏览器自动填充的账号密码在页面上发生点击或按键之前无法读取，输入框 value 为空不代表未填写，点击输入框后再读取。' +
    '元素上的 optionsTruncated=true 表示该 select 的选项未列全：' +
    '用 optionsFor 按该元素继续读取，返回的是选项页而不是新观察，' +
    'observationId 与 ref 沿用原观察；optionsFor 不能与 frame、screenshot、offset 同时提供。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      frame: { type: 'string', description: '仅观察某个 iframe，取自元素的 frame 字段' },
      screenshot: { type: 'boolean' },
      offset: { type: 'integer', description: '从第几个元素开始返回' },
      query: { type: 'string', description: '只返回名称、正文或值包含这段文字的元素，不分大小写' },
      optionsFor: {
        type: 'object',
        description: '读取一个 select 的选项，不产生新观察，也不移动页面',
        properties: {
          observationId: { type: 'string', description: '该 ref 所属的观察' },
          ref: { type: 'string', description: 'select 元素的编号' },
          offset: { type: 'integer', description: '从第几个选项开始读取，默认 0' },
        },
        required: ['observationId', 'ref'],
        additionalProperties: false,
      },
    },
    required: ['tabId'],
    additionalProperties: false,
  },
  actionKind: 'read',
  summary: '读取页面的地址、标题与可操作元素',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const optionsFor = optionsForArg(args)
      const input = {
        tabId: str(args.tabId, 'tabId'),
        ...(given(args.frame) ? { frame: str(args.frame, 'frame') } : {}),
        ...(args.screenshot === true ? { screenshot: true } : {}),
        ...(given(args.offset) ? { offset: nonNegative(args.offset, 'offset') } : {}),
        ...(given(args.query) ? { query: str(args.query, 'query') } : {}),
        ...(optionsFor ? { optionsFor } : {}),
      }
      const r = await send(() => browser.observe(input))
      return {
        status: 'success',
        ...browserResult({
          ctx,
          toolName: 'browser_observe',
          page: r,
          lead: isOptionsPage(r) ? optionsLine(r) : observationLine(r),
        }),
      }
    }),
}

export const browserActTool: ToolSpec = {
  ...BASE,
  name: 'browser_act',
  description:
    '对观察返回的元素执行动作：click 点击、dblclick 双击、rightclick 右键、hover 悬停、' +
    'fill 覆盖输入框内容、type 在当前光标处逐字输入、select 选择下拉项、scroll 滚动、' +
    'press 按键、drag 拖动。' +
    '文字引用（包括 StaticText）也支持指针动作，按文字实际位置命中；fill、type、select 仍要求对应控件。' +
    'observationId 取自 observe、act、navigate 或 wait 的返回结果。' +
    'press 用 phases 表达有时序的按键：每个阶段是该时段内按住的完整键集合与持续毫秒数，' +
    '切换阶段时只按下新增的键、松开移除的键，最后全部松开，按住期间不自动重复。' +
    '例如按住 W 1.2 秒并在其间轻点空格：' +
    '[{"keys":["KeyW"],"durationMs":1200},{"keys":["KeyW","Space"]},{"keys":["KeyW"],"durationMs":300}]。' +
    '键名是物理键码，如 KeyW、Space、ArrowUp、Enter、ShiftLeft、ControlLeft；' +
    '组合键写在同一阶段里，如 ["ControlLeft","KeyA"]；durationMs 缺省为 0，即按下后立刻进入下一阶段。' +
    `一次最多 ${INPUT_LIMITS.phases} 个阶段、同时按 ${INPUT_LIMITS.keys} 个键，` +
    `单段不超过 ${INPUT_LIMITS.phaseMs} 毫秒、合计不超过 ${INPUT_LIMITS.totalMs} 毫秒；` +
    '更长的操作分多次调用，每次查看结果后再继续。' +
    'point 是元素内相对左上角的 CSS 像素偏移，用于 canvas 等同一元素内的不同位置，' +
    '范围见元素的 size，缺省为元素中心，文本节点取实际文字片段中心。' +
    'holdMs 是 click / rightclick 的按住时长；keys 是指针动作期间按住的键，如 ["ShiftLeft"]。' +
    'drag 在 ref（与 point）处按下，沿 path 逐段移动后松开，每段指定终点 ref、可选的 point 与 durationMs。' +
    'scroll 的 deltaY 向下为正、deltaX 向右为正。' +
    'execution.state=completed 只表示输入已全部发出并确认，不代表网站业务完成；' +
    'partial 或 unknown 时查看 reason 与 unreleased，先观察确认，不要重放。' +
    '动作之后取得新观察时，结果中直接返回新的元素表与 observationId，据此继续下一步，' +
    '不必再调用 browser_observe；settle=quiet 只表示页面短暂没有变化，不代表网站业务已完成，' +
    '后续目标尚未出现时用 browser_wait。' +
    '页面未跳转时先前观察的元素编号仍然有效，同一个 observationId 可以在同一轮中发出多个动作，' +
    '按发出顺序依次执行；同一轮中前一个动作失败不会阻止后续动作执行。' +
    '输入后页面重建了节点时，后续动作因编号失效被拒绝，用最新的 observationId 重发。' +
    'hover 之后的观察是采集时刻的页面，延时展开的层可能尚未出现，用 browser_wait 等待其出现。' +
    'type 的非键盘字符按文本插入，不产生完整的键盘与输入法事件。' +
    'drag 只覆盖指针事件驱动的拖动，不支持 HTML5 原生拖放。' +
    '日期类输入框的 fill 按该类型的格式写入，格式非法时不改动原值。' +
    '未取得观察时结果为失败而动作可能已经发出，先 browser_observe 确认，不要重复同一个动作。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      observationId: { type: 'string' },
      action: { type: 'string', enum: ACT_KINDS },
      ref: {
        type: 'string',
        description: '元素编号，drag 时是起点。scroll 与 press 可省略，作用于整页',
      },
      point: POINT_SCHEMA,
      text: {
        type: 'string',
        description:
          'fill 覆盖输入框原有内容；type 在当前光标处逐字输入，换行按 Enter，单行控件可能因此提交；select 是要选中的选项',
      },
      phases: {
        type: 'array',
        description: 'press 的按键阶段，按顺序执行',
        items: {
          type: 'object',
          properties: {
            keys: {
              type: 'array',
              items: { type: 'string' },
              description: '该阶段按住的物理键码，空数组表示全部松开',
            },
            durationMs: { type: 'integer', description: '该阶段的持续时长，缺省 0' },
          },
          required: ['keys'],
          additionalProperties: false,
        },
      },
      keys: {
        type: 'array',
        items: { type: 'string' },
        description: 'click / rightclick / dblclick / drag 期间按住的物理键码',
      },
      holdMs: { type: 'integer', description: 'click / rightclick 按下后到松开前的保持时长' },
      path: {
        type: 'array',
        description: 'drag 的路径，至少一段',
        items: {
          type: 'object',
          properties: {
            ref: { type: 'string', description: '该段终点所在的元素' },
            point: POINT_SCHEMA,
            durationMs: { type: 'integer', description: '该段移动的时长，缺省 0' },
          },
          required: ['ref'],
          additionalProperties: false,
        },
      },
      deltaX: { type: 'number', description: 'scroll 的横向滚动量，向右为正' },
      deltaY: { type: 'number', description: 'scroll 的滚动量，向下为正' },
    },
    required: ['tabId', 'observationId', 'action'],
    additionalProperties: false,
  },
  actionKind: 'call',
  summary: '在观察到的元素上点击、悬停、输入、选择、滚动、按键或拖动',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const action: BrowserActionKind = oneOf(args.action, ACT_KINDS, 'action')
      // 不适用的参数属于参数错误，不是可忽略的多余项；在调用端口之前判定。
      for (const field of ACT_OPTIONAL) {
        if (!ACT_FIELDS[action].includes(field) && given(args[field])) {
          throw new ArgError(`${action} 不接受 ${field}`)
        }
      }
      const ref = given(args.ref) ? str(args.ref, 'ref') : undefined
      // 元素动作缺少 ref 时无法定位，drag 缺少路径时无法确定终点：均在调用端口前判定，
      // 否则一次必然失败的调用会被记为「动作已发出」，而该状态禁止重试。
      if (ref === undefined && action !== 'scroll' && action !== 'press') {
        throw new ArgError(`${action} 必须提供 ref`)
      }
      if (given(args.point) && ref === undefined) throw new ArgError('point 必须与 ref 一起提供')
      const point = given(args.point) ? pointArg(args.point, 'point') : undefined
      const path = action === 'drag' ? pathArg(args.path) : undefined
      const only = path?.length === 1 ? path[0] : undefined
      if (only && only.ref === ref && samePoint(only.point, point)) {
        throw new ArgError('drag 的起点与终点是同一个点')
      }

      const input = {
        tabId: str(args.tabId, 'tabId'),
        observationId: str(args.observationId, 'observationId'),
        action,
        ...(ref !== undefined ? { ref } : {}),
        ...(point ? { point } : {}),
        ...textField(action, args.text),
        ...(action === 'press' ? { phases: phasesArg(args.phases) } : {}),
        ...(given(args.keys) ? { keys: heldArg(args.keys) } : {}),
        ...(given(args.holdMs) ? { holdMs: holdArg(args.holdMs) } : {}),
        ...(path ? { path } : {}),
        ...(given(args.deltaX) ? { deltaX: finite(args.deltaX, 'deltaX') } : {}),
        ...(given(args.deltaY) ? { deltaY: finite(args.deltaY, 'deltaY') } : {}),
      }
      const r = await send(() => browser.act(input))
      const receipt = receiptOf(r)
      if (r.execution && r.execution.state !== 'completed') {
        return incompleteAct(ctx, action, r.execution, receipt, r)
      }
      return withFollowUp(ctx, 'browser_act', receipt, r, {
        // `element` 已由采集侧按标签上限截断，此处直接输出，不要再增加长度检查。
        lead: `${action} 已发出${r.element ? `：${r.element}` : ''}。`,
        ok: true,
        advice: '动作已发出，先 browser_observe 确认页面状态，不要重复动作。',
      })
    }),
}

export const browserWaitTool: ToolSpec = {
  ...BASE,
  name: 'browser_wait',
  description:
    '等待当前主文档里一个 CSS 选择器达到指定状态，用于替代反复 observe 轮询。' +
    'state 按选择器命中的第一个元素判定：visible（默认）有尺寸且可见；attached 存在于文档中即可；' +
    'hidden 未命中或不可见；enabled 可见且未禁用；' +
    'text / value 是文本（空白归一）或控件值与 expected 完全相等，这两种必须提供 expected。' +
    '不提供 selector 时等待 timeoutMs 后再观察，用于等待页面中的动画、计时或脚本运行一段时间。' +
    `默认 ${DEFAULT_WAIT_MS} 毫秒，上限 ${MAX_WAIT_MS} 毫秒。` +
    '取得新观察时结果中直接返回元素表与 observationId，据此继续下一步，不必再调用 browser_observe；' +
    '未取得观察时先 browser_observe 确认页面状态。' +
    '选择器只查询主文档，iframe 中的元素用 browser_observe 的 frame 参数。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      selector: { type: 'string' },
      state: { type: 'string', enum: WAIT_STATES },
      expected: { type: 'string', description: 'state 为 text 或 value 时等待的目标值' },
      timeoutMs: { type: 'integer' },
    },
    required: ['tabId'],
    additionalProperties: false,
  },
  actionKind: 'read',
  summary: '等待一个 CSS 选择器达到指定状态，或等待指定时长',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const tabId = str(args.tabId, 'tabId')
      const timeoutMs = given(args.timeoutMs)
        ? Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, finite(args.timeoutMs, 'timeoutMs')))
        : DEFAULT_WAIT_MS
      if (!given(args.selector)) {
        if (given(args.state) || given(args.expected)) {
          throw new ArgError('state 与 expected 须与 selector 一起提供')
        }
        if (!(await pause(timeoutMs, ctx.signal))) return STOPPED
        const r = await send(() => browser.observe({ tabId }))
        return {
          status: 'success',
          ...browserResult({
            ctx,
            toolName: 'browser_wait',
            page: r,
            receipt: { waitedMs: timeoutMs },
            lead: `已等待 ${timeoutMs} 毫秒。${isOptionsPage(r) ? optionsLine(r) : observationLine(r)}`,
          }),
        }
      }
      const selector = str(args.selector, 'selector')
      const state = given(args.state) ? oneOf(args.state, WAIT_STATES, 'state') : 'visible'
      const wantsValue = state === 'text' || state === 'value'
      // expected 为空串表示等待文本或值为空，只有 null 视为未提供。
      const expected =
        args.expected === undefined || args.expected === null ? undefined : String(args.expected)
      if (wantsValue && expected === undefined)
        throw new ArgError(`state=${state} 必须提供 expected`)
      if (!wantsValue && given(expected)) throw new ArgError(`state=${state} 不接受 expected`)
      const input = {
        tabId,
        selector,
        state,
        ...(wantsValue && expected !== undefined ? { expected } : {}),
        timeoutMs,
      }
      const r = await send(() => browser.wait(input))
      const target = `${selector} ${stateText(state, expected)}`
      return withFollowUp(
        ctx,
        'browser_wait',
        { met: r.met, state, ...(r.reason ? { reason: r.reason } : {}) },
        r,
        {
          lead: r.met ? `${target}，已达到。` : `未等到 ${target}（${r.reason ?? 'timeout'}）。`,
          ok: r.met,
          advice: '先 browser_observe 确认页面状态。',
        },
      )
    }),
}

export const browserUploadTool: ToolSpec = {
  ...BASE,
  name: 'browser_upload',
  description:
    '把工作区内的文件交给页面上的文件输入框，ref 必须指向 input[type=file]。' +
    `路径按工作区规则裁决，越界拒绝。一次最多 ${MAX_UPLOAD_FILES} 个文件。` +
    '结果不附带观察，需要读取页面状态时再调用 browser_observe。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      observationId: { type: 'string' },
      ref: { type: 'string' },
      paths: { type: 'array', items: { type: 'string' } },
    },
    required: ['tabId', 'observationId', 'ref', 'paths'],
    additionalProperties: false,
  },
  actionKind: 'call',
  summary: '将工作区文件上传到页面的文件输入框',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const raw = Array.isArray(args.paths) ? args.paths : [args.paths]
      if (raw.length === 0 || raw.length > MAX_UPLOAD_FILES) {
        throw new ArgError(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件`)
      }
      // 全部裁决完成后再调用端口：逐个裁决并传递时，第三个文件越界时前两个已进入输入框。
      const paths: string[] = []
      for (const one of raw) {
        paths.push(await resolveInWorkspace(rootsOf(ctx), String(one ?? ''), { mustExist: true }))
      }
      const input = {
        tabId: str(args.tabId, 'tabId'),
        observationId: str(args.observationId, 'observationId'),
        ref: str(args.ref, 'ref'),
        paths,
      }
      const r = await send(() => browser.upload(input))
      return {
        status: 'success',
        message: `已将 ${r.files.length} 个文件交给文件输入框`,
        data: { files: r.files },
      }
    }),
}

export const browserDownloadTool: ToolSpec = {
  ...BASE,
  name: 'browser_download',
  description:
    '点击下载链接或按钮，把文件保存到工作区内的指定路径。目标文件已存在时拒绝。' +
    '结果含 blocked 表示下载被宿主拦截，原因随结果返回。' +
    '结果不附带观察，需要读取页面状态时再调用 browser_observe。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      observationId: { type: 'string' },
      ref: { type: 'string', description: '触发下载的元素编号' },
      path: { type: 'string', description: '工作区内的目标路径' },
    },
    required: ['tabId', 'observationId', 'ref', 'path'],
    additionalProperties: false,
  },
  actionKind: 'call',
  summary: '触发下载并保存到工作区路径',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      // 先裁决路径再触发：授权按该绝对路径登记；顺序颠倒时，网站会先开始下载，
      // 之后才判断能否写入磁盘。
      const absolutePath = await resolveInWorkspace(
        writableRoots(rootsOf(ctx)),
        str(args.path, 'path'),
        { mustExist: false },
      )
      const input = {
        tabId: str(args.tabId, 'tabId'),
        observationId: str(args.observationId, 'observationId'),
        ref: str(args.ref, 'ref'),
        absolutePath,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
      }
      const r = await send(() => browser.download(input))
      if (r.blocked) {
        return {
          status: 'failure',
          message: `下载被拦截：${r.blocked}${r.suggestedName ? `（${r.suggestedName}）` : ''}`,
          data: { ...r },
          errorKind: 'download_blocked',
        }
      }
      return { status: 'success', message: `已保存到 ${r.path}，${r.bytes} 字节`, data: { ...r } }
    }),
}

/** 注册顺序在此处确定，`index.ts` 按通道整组注册或整组不注册。 */
export const browserTools: ToolSpec[] = [
  browserTabsTool,
  browserNavigateTool,
  browserObserveTool,
  browserActTool,
  browserWaitTool,
  browserUploadTool,
  browserDownloadTool,
]
