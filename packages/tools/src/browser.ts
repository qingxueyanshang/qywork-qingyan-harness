/**
 * 内置浏览器的七个工具。
 *
 * 一次调用一个有限动作：发一条端口命令就返回，由 Agent 循环再决定下一步。
 * 这里不自己循环、不重试有副作用的动作——重试一次点击等于在网站上多提交一次。
 *
 * 四条边界：
 *
 * 1. **端口只从 `ctx.browser` 取。** 参数里自报的会话、Run、工作区根一概不读。
 *    没有端口时这七个工具不注册（`index.ts` 按通道注册），工具体里仍判一次并如实报错。
 * 2. **注册表不按 schema 校验实参。** 必需参数、取值范围、数值有限性、动作的参数
 *    适用范围都在这里判，判完之前不调端口。
 * 3. **`null` 与空串按缺席算。** OpenAI 兼容协议的 strict 改写会把可选字段标成
 *    nullable，模型因此常把没填的字段显式写成 `null`；按「给了一个非法值」拒绝的话，
 *    一次正常调用会被一个没打算填的字段挡下来。例外是 `fill` 与 `select` 的 `text`：
 *    空串分别是清空输入框与选中值为空的选项，只有 `null` 才算未提供。
 * 4. **本地预览、上传下载的路径先裁决再交给端口。** 走这一轮会话的根目录清单（`rootsOf`），
 *    与内置文件工具同一份判定；端口只按裁决后的绝对路径操作。
 *
 * `executed` 优先采用端口声明的执行前拒绝；其余异常按是否进入端口保守判定，
 * 避免把已发出的页面动作标成未执行。
 */

import { stat } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  type BrowserActionKind,
  type BrowserExecution,
  type BrowserObservation,
  type BrowserOptionsPage,
  type BrowserPort,
  type FollowUpObservation,
  KEY_HINT,
  keyStroke,
  type ToolContext,
  type ToolOutcome,
  type ToolSpec,
} from '@qywork/agent'
import { browserResult, isOptionsPage } from './browser-results.ts'
import { resolveInWorkspace, rootsOf } from './paths.ts'

/** 一次等待的上限。超过这个值的请求按它截断，不接受任意时长。 */
const MAX_WAIT_MS = 60_000
/** 等待时长的下限。更短的请求按它抬上来。 */
const MIN_WAIT_MS = 100
/** 调用方没给时长时等多久。 */
const DEFAULT_WAIT_MS = 10_000
/** 一次下载从触发到落盘的上限。 */
const DOWNLOAD_TIMEOUT_MS = 120_000
/** 单次上传的文件数上限。 */
const MAX_UPLOAD_FILES = 10
/** `type` 一次输入的 Unicode 码点上限。 */
const MAX_TYPE_POINTS = 2000

/**
 * 调用端口之前判出来的参数错。
 *
 * 带 `errorKind` 是为了与路径拒绝（`PathEscapeError` 等）走同一条出口：
 * 两者都是判定不是故障，结果里 `executed` 必须是 `false`。
 */
class ArgError extends Error {
  readonly errorKind = 'invalid_argument'
  constructor(message: string) {
    super(message)
    this.name = 'ArgError'
  }
}

/** 这个可选参数给了没有。`null` 与空串按缺席算，理由见文件头第 3 条。 */
function given(raw: unknown): boolean {
  return raw !== undefined && raw !== null && String(raw).trim() !== ''
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

/** 有限性先判再截断：`NaN` 与 `Infinity` 一旦透传，端口那侧算出来的是一个无界的时限。 */
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
 * 读选项模式的实参。缺席即普通观察。
 *
 * 与 `frame` / `screenshot` / `offset` 互斥：那三个说的是采哪一份元素表，而本模式
 * 不采元素表，两者同时给即是写错，在调端口前拒绝。
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
    throw new ArgError('optionsFor 不能与 frame、screenshot、offset、query 同时给')
  }
  const one = raw as Record<string, unknown>
  return {
    observationId: str(one.observationId, 'optionsFor.observationId'),
    ref: str(one.ref, 'optionsFor.ref'),
    ...(given(one.offset) ? { offset: nonNegative(one.offset, 'optionsFor.offset') } : {}),
  }
}

/**
 * 每个动作用得上的可选参数。
 *
 * 表外的参数给了就是写错，在调端口前拒绝：静默忽略的话，`click` 带 `toRef` 会得到
 * 一次成功的点击，而调用方按拖动已完成继续下一步。
 */
const ACT_FIELDS: Record<BrowserActionKind, readonly string[]> = {
  click: ['ref'],
  dblclick: ['ref'],
  rightclick: ['ref'],
  hover: ['ref'],
  fill: ['ref', 'text'],
  type: ['ref', 'text'],
  select: ['ref', 'text'],
  scroll: ['ref', 'deltaY'],
  press: ['ref', 'key'],
  drag: ['ref', 'toRef'],
}

const ACT_KINDS = Object.keys(ACT_FIELDS) as BrowserActionKind[]

/** 动作的可选参数全集，逐个按 `ACT_FIELDS` 核适用范围。 */
const ACT_OPTIONAL = ['ref', 'toRef', 'text', 'key', 'deltaY'] as const

/**
 * `press` 的键名预检：整串按 `@qywork/agent` 的词表解析，主键名一并判。
 *
 * 空段、重复或认不出的修饰键、认不出的主键在这里就是参数错，`executed` 为假。
 * **不要在这里另写一份键名判定**：端口用的是同一个 `keyStroke`，两份表会各自漂移，
 * 未知主键名因此在预检放行、到端口才被拒，调用方拿到的是「动作可能已经发出」。
 * 加号本身写 `Plus`：`Ctrl++` 切出来的空段分不出是主键还是漏写。
 */
function pressKey(raw: unknown): string {
  const key = str(raw, 'key')
  const trimmed = key
    .split('+')
    .map((part) => part.trim())
    .join('+')
  if (!keyStroke(trimmed)) {
    throw new ArgError(`不支持的按键：${JSON.stringify(key)}（${KEY_HINT}）`)
  }
  return trimmed
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
 * 整段检完才发第一个事件：发到一半再发现超长的话，前半段已经输入到页面，
 * 而输入事件不能撤回。CRLF 与单独的 CR 一律归一为换行，按 Enter 发出。
 */
function typeText(raw: unknown): string {
  if (raw === undefined || raw === null || String(raw) === '') {
    throw new ArgError('type 必须给 text')
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
 * `fill` 与 `select` 的空串是清空输入框与值为空的选项，只有 `null` 才算未提供；
 * `type` 走整段预检；其余动作用不上这个字段，到这里已被适用范围挡下。
 */
function textField(action: BrowserActionKind, raw: unknown): { text?: string } {
  if (action === 'type') return { text: typeText(raw) }
  if (action !== 'fill' && action !== 'select') return {}
  if (raw === undefined || raw === null) return {}
  return { text: String(raw) }
}

/**
 * 网页地址直接交给浏览器；本地文件先走文件工具的路径裁决，再转成 file URL。
 */
async function browserUrl(raw: unknown, ctx: ToolContext): Promise<string> {
  const value = str(raw, 'url')
  let candidate = value
  let suffix: URL | undefined
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
  }
  const absolute = await resolveInWorkspace(rootsOf(ctx), candidate, {
    mustExist: true,
    literal: true,
  })
  if (!(await stat(absolute)).isFile()) {
    throw new ArgError(`路径不是文件：${candidate}。请指定要预览的 HTML 或其他文件。`)
  }
  const url = pathToFileURL(absolute)
  if (suffix) {
    url.search = suffix.search
    url.hash = suffix.hash
  }
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

/** 把端口调用包起来，调用发生的那一刻记下来。 */
type PortCall = <T>(call: () => Promise<T>) => Promise<T>

function declaredKind(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const kind = (err as Error & { errorKind?: unknown }).errorKind
  return typeof kind === 'string' && kind ? kind : undefined
}

/** 端口按 `BrowserRefusal` 声明的执行前拒绝。缺席时由 `send` 有没有被调过来判。 */
function declaredExecuted(err: unknown): boolean | undefined {
  if (!(err instanceof Error)) return undefined
  const executed = (err as Error & { executed?: unknown }).executed
  return typeof executed === 'boolean' ? executed : undefined
}

/**
 * 七个工具共用的前置判定与终态。
 *
 * 停止之后不再发起新动作：等待中的那一次由端口自己拒绝，这里挡的是新来的。
 * 异常的 `executed` 先认端口自己声明的那一份，缺席时取自 `send` 有没有被调过——
 * 不这样判的话，「参数写错」与「点击已发出但连接断了」会得到同一个结果，而后者禁止重发。
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

function observationLine(ob: BrowserObservation): string {
  return (
    `${ob.title || '(无标题)'} · ${ob.url} · ${ob.elements.length} 个元素` +
    (ob.truncated ? '（还有更多，用 offset 继续取）' : '') +
    (ob.framesPending?.length ? `（${ob.framesPending.length} 个 iframe 还没就位，重新观察）` : '')
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
 * 把动作回执与后续观察合成一个结果。
 *
 * 观察在就展开到 `data` 顶层，其中的 `observationId` 可直接用于下一次动作；
 * 观察缺席时结果是失败而 `executed` 为真——动作已经发到网站，重复一次等于多提交一次。
 * 缺席时不沿用旧的 `observationId`。
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
    message: `${opts.lead}没有取得新的观察：${follow.observationError}。${opts.advice}`,
    data: { ...receipt, observationError: follow.observationError },
    errorKind: 'browser_observation_unavailable',
  }
}

/** 动作回执里那一格元素标签印进 message 的字数上限。 */
const MAX_ACTED_LABEL_CHARS = 200

/**
 * 动作行里的目标那一格。
 *
 * 标签取自页面自报的 `aria-label`，长度无界，超过上限只印字数：message 不参与视图裁剪，
 * 一段长标签会把整条结果的上限吃满，元素表因此一个都投不出去。原文仍在回执的
 * `element` 字段里。
 */
function actedLabel(element: string | undefined): string {
  if (!element) return ''
  if (element.length <= MAX_ACTED_LABEL_CHARS) return `：${element}`
  return `：标签 ${element.length} 字，见结果里的 element`
}

/** 后续观察的三个键由 `withFollowUp` 单独投递，不算回执字段。 */
const FOLLOW_KEYS = new Set(['observation', 'observationError', 'settle'])

/**
 * 端口回执原样进结果。
 *
 * 逐个字段挑的话，动作那侧新增的字段（规范化后的值、约束不满足的原因）到不了
 * 调用方，结果里只剩一次没有下文的失败。
 */
function receiptOf(result: object): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(result).filter(([key, value]) => !FOLLOW_KEYS.has(key) && value !== undefined),
  )
}

/**
 * 部分完成与结果未知的投递。
 *
 * 动作命令已经发到网站，重放一次等于在网站上多做一次，所以一律是失败且
 * `executed` 为真。观察在就展开，让调用方据此判断实际做到了哪一步。
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
  const lead = partial ? `${action} 已部分发出${units}。` : `${action} 的结果未知。`
  const advice = '先 browser_observe 确认页面实际状态，不要重放这个动作。'
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
    message: `${lead}没有取得新的观察：${follow.observationError}。${advice}`,
    data: { ...receipt, observationError: follow.observationError },
    errorKind,
  }
}

/** 六个页面工具的目标是那一页；`browser_tabs` 的 list 与 create 没有页可指，见各自的 spec。 */
function tabTarget(args: Record<string, unknown>): string | null {
  return given(args.tabId) ? String(args.tabId).trim() : null
}

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
    '列出内置浏览器的标签页，或新建、接管、关闭一页。' +
    'create 打开的页归本会话，后续消息可直接对它 observe 与 act；' +
    '简单 HTML 可直接传本地路径或 file URL，无需启动服务；依赖开发服务器、模块加载或接口的项目使用 http/https 地址。' +
    'tabId 由 create 的返回值给出，同一轮里无法预知；create 已按 url 加载页面，不需要再 navigate。' +
    '开页不附带观察，先 browser_observe 或 browser_wait 再操作。' +
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
  // list 只读一份清单；create / bind / close 改变本会话手里有哪些页。
  actionKind: (args) => (args.action === 'list' ? 'read' : 'call'),
  summary: '列出、新建、接管或关闭浏览器标签页',
  // list 与 create 没有可指的页，授权预览退回「browser」而不是留空。
  targetExtractor: (args) => tabTarget(args) ?? 'browser',

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const action = oneOf(args.action, ['list', 'create', 'bind', 'close'] as const, 'action')

      if (action === 'create') {
        const url = await browserUrl(args.url, ctx)
        const tab = await send(() => browser.open(url))
        return {
          status: 'success',
          message: `已打开 ${tab.tabId}：${tab.url}。先 browser_observe 或 browser_wait 再操作。`,
          data: { tab },
        }
      }

      if (action === 'bind') {
        const tabId = str(args.tabId, 'tabId')
        const tab = await send(() => browser.bind(tabId))
        return { status: 'success', message: `已接管 ${tab.tabId}：${tab.url}`, data: { tab } }
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
          (user ? `，${user} 个是用户开的（用户点名后可 bind 接管）` : ''),
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
    '取得新观察时结果里直接带回元素表与 observationId，据此继续下一步，不必再调 browser_observe。' +
    'observationId 与元素 ref 属于产生它的那一份观察与那一份文档，换文档后要用新的一份。' +
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
    'query 只返回名称、正文或值包含该文字的元素，知道要找什么时优先用它。' +
    'truncated=true 时用 offset 取后续元素。' +
    '元素多时结果里只带前面一部分，delivery 写明给了多少、本次采到多少；' +
    '其余元素按结果里的 resource id 用 read_resource 读，页面其他范围仍用 offset 或 query。' +
    'screenshot=true 才截图，仅在元素表不足以判断版面时使用。' +
    'frame 只看某个 iframe，取自元素的 frame 字段。' +
    '元素上的 expanded 与 selected 缺席表示这个角色没有这一项，不表示收起或未选中；' +
    'options 是 select 的选项摘要，按当前页面现读。' +
    '元素上的 optionsTruncated=true 表示这个 select 的选项没有列全：' +
    '用 optionsFor 按该元素继续读，返回的是选项页而不是新观察，' +
    'observationId 与 ref 沿用原来那一份；optionsFor 不能与 frame、screenshot、offset 同时给。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      frame: { type: 'string', description: '只看某个 iframe，取自元素的 frame 字段' },
      screenshot: { type: 'boolean' },
      offset: { type: 'integer', description: '从第几个元素开始返回' },
      query: { type: 'string', description: '只返回名称、正文或值包含这段文字的元素，不分大小写' },
      optionsFor: {
        type: 'object',
        description: '读一个 select 的选项，不产生新观察也不移动页面',
        properties: {
          observationId: { type: 'string', description: '这个 ref 所属的那一份观察' },
          ref: { type: 'string', description: 'select 元素的编号' },
          offset: { type: 'integer', description: '从第几个选项开始读，默认 0' },
        },
        required: ['observationId', 'ref'],
        additionalProperties: false,
      },
    },
    required: ['tabId'],
    additionalProperties: false,
  },
  actionKind: 'read',
  summary: '读一页的地址、标题与可操作元素',
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
    'fill 覆盖输入框内容、type 在当前光标处逐字输入、select 选下拉项、scroll 滚动、' +
    'press 按键、drag 从 ref 拖到 toRef。' +
    'observationId 取自 observe、act、navigate 或 wait 返回的那一份。' +
    '动作之后取得新观察时结果里直接带回新的元素表与 observationId，据此继续下一步，' +
    '不必再调 browser_observe；settle=quiet 只表示页面短暂没有变化，不代表网站业务已完成，' +
    '后续目标还没出现时用 browser_wait。' +
    '页面没有跳转时先前观察的元素编号仍然有效，同一个 observationId 可以在同一轮里发出多个动作，' +
    '按发出顺序依次执行；同一轮里前一个动作失败不会阻止后面的动作执行。' +
    '输入后页面重建了节点时，后面的动作按编号失效被拒绝，用最新的 observationId 重发。' +
    'hover 之后的观察是采集那一刻的页面，延时展开的层可能还没出现，用 browser_wait 等它。' +
    'type 的非键盘字符按文本插入，不产生完整的键盘与输入法事件。' +
    'drag 只覆盖指针事件驱动的拖动，不支持 HTML5 原生拖放。' +
    '日期一类输入框的 fill 按该类型的格式写入，格式非法时不改动原值。' +
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
      toRef: { type: 'string', description: 'drag 的终点元素编号，与 ref 不能相同' },
      text: {
        type: 'string',
        description:
          'fill 覆盖输入框原有内容；type 在当前光标处逐字输入，换行按 Enter，单行控件可能因此提交；select 是要选中的选项',
      },
      key: {
        type: 'string',
        description:
          '功能键或组合键：Enter、Tab、Escape 等，或 Ctrl+A、Shift+Tab、Ctrl+Shift+Enter；主键可为单个字母数字标点，加号写 Plus；按 US 布局解释',
      },
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
      // 用不上的参数是写错，不是可以忽略的多余项；判在调端口之前。
      for (const field of ACT_OPTIONAL) {
        if (!ACT_FIELDS[action].includes(field) && given(args[field])) {
          throw new ArgError(`${action} 不接受 ${field}`)
        }
      }
      const ref = given(args.ref) ? str(args.ref, 'ref') : undefined
      // 元素动作没有 ref 就无从定位，drag 少一端就不知道拖到哪里：都在调端口前判，
      // 否则一次必然失败的调用会被记成「动作已发出」，而那是禁止重试的一侧。
      if (ref === undefined && action !== 'scroll' && action !== 'press') {
        throw new ArgError(`${action} 必须给 ref`)
      }
      const toRef = action === 'drag' ? str(args.toRef, 'toRef') : undefined
      if (toRef !== undefined && toRef === ref) {
        throw new ArgError('drag 的 ref 与 toRef 不能是同一个元素')
      }

      const input = {
        tabId: str(args.tabId, 'tabId'),
        observationId: str(args.observationId, 'observationId'),
        action,
        ...(ref !== undefined ? { ref } : {}),
        ...(toRef !== undefined ? { toRef } : {}),
        ...textField(action, args.text),
        ...(action === 'press' ? { key: pressKey(args.key) } : {}),
        ...(given(args.deltaY) ? { deltaY: finite(args.deltaY, 'deltaY') } : {}),
      }
      const r = await send(() => browser.act(input))
      const receipt = receiptOf(r)
      if (r.execution && r.execution.state !== 'completed') {
        return incompleteAct(ctx, action, r.execution, receipt, r)
      }
      return withFollowUp(ctx, 'browser_act', receipt, r, {
        lead: `${action} 已发出${actedLabel(r.element)}。`,
        ok: true,
        advice: '动作已发出，先 browser_observe 确认页面状态，不要重复动作。',
      })
    }),
}

export const browserWaitTool: ToolSpec = {
  ...BASE,
  name: 'browser_wait',
  description:
    '等待一个 CSS 选择器在当前主文档出现，用于替代反复 observe 轮询。' +
    `默认 ${DEFAULT_WAIT_MS} 毫秒，上限 ${MAX_WAIT_MS} 毫秒。` +
    '取得新观察时结果里直接带回元素表与 observationId，据此继续下一步，不必再调 browser_observe；' +
    '未取得观察时先 browser_observe 确认页面状态。' +
    '选择器只查主文档，iframe 里的元素用 browser_observe 的 frame 参数。',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'string' },
      selector: { type: 'string' },
      timeoutMs: { type: 'integer' },
    },
    required: ['tabId', 'selector'],
    additionalProperties: false,
  },
  actionKind: 'read',
  summary: '等一个 CSS 选择器出现',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const selector = str(args.selector, 'selector')
      const input = {
        tabId: str(args.tabId, 'tabId'),
        selector,
        timeoutMs: given(args.timeoutMs)
          ? Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, finite(args.timeoutMs, 'timeoutMs')))
          : DEFAULT_WAIT_MS,
      }
      const r = await send(() => browser.wait(input))
      return withFollowUp(
        ctx,
        'browser_wait',
        { found: r.found, ...(r.reason ? { reason: r.reason } : {}) },
        r,
        {
          lead: r.found
            ? `${selector} 已出现。`
            : `没等到 ${selector}（${r.reason ?? 'timeout'}）。`,
          ok: r.found,
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
    '结果不附带观察，需要读页面状态时再调 browser_observe。',
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
  summary: '把工作区文件交给页面的文件输入框',
  targetExtractor: tabTarget,

  fn: (args, ctx) =>
    onBrowser(ctx, async (browser, send) => {
      const raw = Array.isArray(args.paths) ? args.paths : [args.paths]
      if (raw.length === 0 || raw.length > MAX_UPLOAD_FILES) {
        throw new ArgError(`一次最多上传 ${MAX_UPLOAD_FILES} 个文件`)
      }
      // 全部裁决完再调端口：逐个边裁边交的话，第三个越界时前两个已经进了输入框。
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
        message: `已交给文件输入框 ${r.files.length} 个文件`,
        data: { files: r.files },
      }
    }),
}

export const browserDownloadTool: ToolSpec = {
  ...BASE,
  name: 'browser_download',
  description:
    '点击下载链接或按钮，把文件保存到工作区内的指定路径。目标文件已存在时拒绝。' +
    '结果带 blocked 表示下载被宿主拦截，原因随结果给出。' +
    '结果不附带观察，需要读页面状态时再调 browser_observe。',
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
      // 先裁决路径再触发：授权按这个绝对路径登记，顺序反过来就成了
      // 「先让网站开始下载，再看它能不能落盘」。
      const absolutePath = await resolveInWorkspace(rootsOf(ctx), str(args.path, 'path'), {
        mustExist: false,
      })
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
          message: `下载被拦下：${r.blocked}${r.suggestedName ? `（${r.suggestedName}）` : ''}`,
          data: { ...r },
          errorKind: 'download_blocked',
        }
      }
      return { status: 'success', message: `已保存到 ${r.path}，${r.bytes} 字节`, data: { ...r } }
    }),
}

/** 注册顺序在这里定，`index.ts` 按通道整组注册或整组不注册。 */
export const browserTools: ToolSpec[] = [
  browserTabsTool,
  browserNavigateTool,
  browserObserveTool,
  browserActTool,
  browserWaitTool,
  browserUploadTool,
  browserDownloadTool,
]
