/**
 * 电脑操作的四个工具：窗口发现、结构化观察、动作、等待。
 *
 * 一次调用一个有限动作：发一条端口命令就返回，由 Agent 循环再决定下一步。
 * 这里不自己循环、不重试有副作用的动作——重试一次 invoke 等于在应用里多提交一次。
 *
 * 五条边界：
 *
 * 1. **端口只从 `ctx.desktop` 取。** 参数里自报的会话、Run、窗口句柄一概不读；
 *    模型手里只有端口发放的不透明 `windowId`。没有端口时这四个工具不注册
 *    （`index.ts` 按通道注册），工具体里仍判一次并如实报错。
 * 2. **动作前的唯一匹配与前置条件在这里判完再调端口。** 目标不唯一、控件缺失、
 *    动作不可用、控件被禁用，四种都在派发之前作为工具结果交回模型，
 *    `executed` 为假。
 * 3. **判定用的是产生 `ref` 的那一份观察。** 端口按观察编号交回采集那一刻的控件表；
 *    编号失效即要求重新观察，不现采一份新的顶上——那样「模型看到的」与
 *    「判定依据的」分属两个时刻。
 * 4. **三态回执如实透传。** `not_dispatched` 是没执行，`submitted` 是调用已被系统
 *    接受，`unknown` 是可能已经生效。只有第一种允许 `executed:false`。
 * 5. **歧义只列候选，不打分。** 同名控件按祖先路径区分，选哪一个由模型定；
 *    这里不按顺序、不按相似度替它挑。
 */

import type {
  DesktopActResult,
  DesktopElement,
  DesktopFollowUp,
  DesktopImage,
  DesktopPort,
  DesktopSnapshot,
  DesktopWaitCondition,
  ToolContext,
  ToolOutcome,
  ToolSpec,
} from '@qywork/agent'
import type {
  DesktopAction,
  DesktopActionKind,
  DesktopRect,
  DesktopScrollDirection,
  DesktopScrollStep,
  DesktopToggleState,
} from '@qywork/core'
import { imageSizeOf, MAX_EDGE, shrinkImage } from './image.ts'

/** 一次读树的节点数上限。上限由端口再夹一次，这里挡的是明显越界的请求。 */
const MAX_NODES = 4000
/** 一次读树的深度上限。 */
const MAX_DEPTH = 40
/** 一次等待的上限。超过这个值的请求按它截断。 */
const MAX_WAIT_MS = 60_000
/** 等待时长的下限。更短的请求按它抬上来。 */
const MIN_WAIT_MS = 100
/** 调用方没给时长时等多久。 */
const DEFAULT_WAIT_MS = 10_000
/** 歧义时回给模型的候选条数上限。列全一份长清单对消歧没有帮助。 */
const MAX_CANDIDATES = 10
/** 按控件取景时向外扩的像素数上限。扩过头就成了整窗，不如直接采整窗。 */
const MAX_PAD = 400
/** 图像坐标的取值上界。图像本身长边不超过 `MAX_EDGE`，这个数只是挡住明显越界的请求。 */
const MAX_IMAGE_COORD = 100_000
/** 一次读文本最多要回多少个 UTF-16 码元。超出即截断并标记。 */
const MAX_TEXT_CHARS = 20_000
/** 选区偏移的取值上界。挡住明显越界的请求，真实上界由文档长度定。 */
const MAX_TEXT_OFFSET = 10_000_000
/** 采集模式。`structure` 一个像素都不采，`text` 也不采。 */
const CAPTURES = ['structure', 'region_image', 'combined', 'text'] as const
type CaptureMode = (typeof CAPTURES)[number]

const ACTIONS: readonly DesktopActionKind[] = [
  'invoke',
  'set_value',
  'set_range_value',
  'select',
  'add_to_selection',
  'remove_from_selection',
  'set_toggle',
  'expand',
  'collapse',
  'scroll',
  'scroll_into_view',
  'realize_item',
  'select_text',
]
const TOGGLE_STATES: readonly DesktopToggleState[] = ['off', 'on', 'indeterminate']
const SCROLL_DIRECTIONS: readonly DesktopScrollDirection[] = ['up', 'down', 'left', 'right']
const SCROLL_STEPS: readonly DesktopScrollStep[] = ['line', 'page']
const WAIT_CONDITIONS: readonly DesktopWaitCondition[] = [
  'enabled',
  'value',
  'gone',
  'appears',
  'window',
]
/** 这几种条件盯的是一个已知控件，必须给 `ref` 或者能唯一定位到它的条件。 */
const REF_CONDITIONS: readonly DesktopWaitCondition[] = ['enabled', 'value', 'gone']

/**
 * 调用端口之前判出来的参数错与前置条件不满足。
 *
 * 带 `errorKind` 是为了与端口的执行前拒绝走同一条出口：两者都是判定不是故障，
 * 结果里 `executed` 必须是 `false`。
 */
class ArgError extends Error {
  readonly errorKind: string
  constructor(message: string, errorKind = 'invalid_argument') {
    super(message)
    this.name = 'ArgError'
    this.errorKind = errorKind
  }
}

/** 这个可选参数给了没有。`null` 与空串按缺席算，与浏览器工具同一条判据。 */
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

/** 有限性先判再夹：`NaN` 与 `Infinity` 一旦透传，端口那侧算出来的是一个无界的上限。 */
function bounded(raw: unknown, field: string, low: number, high: number): number {
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    throw new ArgError(`${field} 必须是数字，收到 ${JSON.stringify(raw)}`)
  }
  return Math.min(high, Math.max(low, Math.floor(value)))
}

const NO_PORT = {
  status: 'failure',
  executed: false,
  message: '本次执行没有电脑操作能力，无法操作桌面应用。',
  errorKind: 'unsupported',
} as const

const STOPPED = {
  status: 'failure',
  executed: false,
  message: '本次执行已停止，不再操作桌面应用。',
  errorKind: 'aborted',
} as const

/** 把端口调用包起来，调用发生的那一刻记下来。 */
type PortCall = <T>(call: () => Promise<T>) => Promise<T>

function declaredKind(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const kind = (err as Error & { errorKind?: unknown }).errorKind
  return typeof kind === 'string' && kind ? kind : undefined
}

/** 端口按 `DesktopRefusal` 声明的执行前拒绝。缺席时由 `send` 有没有被调过来判。 */
function declaredExecuted(err: unknown): boolean | undefined {
  if (!(err instanceof Error)) return undefined
  const executed = (err as Error & { executed?: unknown }).executed
  return typeof executed === 'boolean' ? executed : undefined
}

/**
 * 四个工具共用的前置判定与终态。
 *
 * 停止之后不再发起新动作：等待中的那一次由端口自己拒绝，这里挡的是新来的。
 * 异常的 `executed` 先认端口自己声明的那一份，缺席时取自 `send` 有没有被调过——
 * 不这样判的话，「参数写错」与「动作已发出但连接断了」会得到同一个结果，
 * 而后者禁止重发。判据只能是契约字段，不能匹配错误文案。
 */
async function onDesktop(
  ctx: ToolContext,
  body: (desktop: DesktopPort, send: PortCall) => Promise<ToolOutcome>,
): Promise<ToolOutcome> {
  const desktop = ctx.desktop
  if (!desktop) return NO_PORT
  if (ctx.signal.aborted) return STOPPED

  let entered = false
  const send: PortCall = (call) => {
    entered = true
    return call()
  }
  try {
    return await body(desktop, send)
  } catch (err) {
    const executed = declaredExecuted(err) ?? entered
    return {
      status: 'failure',
      executed,
      message: err instanceof Error ? err.message : String(err),
      errorKind: declaredKind(err) ?? (executed ? 'desktop_failed' : 'invalid_argument'),
    }
  }
}

function elementLine(e: DesktopElement): string {
  return (
    `${e.ref} ${e.role} ${e.name || '(无名称)'}` +
    (e.automationId ? ` #${e.automationId}` : '') +
    (e.value === undefined ? '' : ` = ${JSON.stringify(e.value)}`) +
    (e.enabled ? '' : ' 已禁用')
  )
}

function shortLabel(e: DesktopElement): string {
  return e.name ? `${e.role}「${e.name}」` : e.role
}

/**
 * 一个控件的祖先路径，从最外层往里写。
 *
 * 同名控件只能靠它区分：两个都叫「保存」的按钮，一个在工具栏里、一个在对话框里。
 * 路径顺着 `parentRef` 在同一张控件表里往上走；父控件不在表里就停下，交出已经走到的
 * 那一段——观察被筛过时表里可能只剩一段祖先。
 */
function ancestorPath(table: DesktopElement[], element: DesktopElement): string {
  const byRef = new Map(table.map((e) => [e.ref, e]))
  const parts: string[] = []
  const seen = new Set<string>([element.ref])
  let at = element.parentRef
  while (at !== undefined && !seen.has(at)) {
    seen.add(at)
    const parent = byRef.get(at)
    if (!parent) break
    parts.unshift(shortLabel(parent))
    at = parent.parentRef
  }
  return parts.join(' > ')
}

/**
 * 歧义回执里的一条候选：控件本身加它的祖先路径。
 *
 * 身份弱的控件另说一句：应用没给它稳定标识，界面重排之后这个编号会被拒，要重新观察。
 */
function candidateLine(table: DesktopElement[], e: DesktopElement): string {
  const path = ancestorPath(table, e)
  const weak = e.weakIdentity === true ? '，身份不稳定，重排后需重新观察' : ''
  return path ? `${elementLine(e)}（位于 ${path}${weak}）` : `${elementLine(e)}${weak}`
}

/**
 * 把模型给的目标解析成这一份观察里唯一的那个控件。
 *
 * 三种写法：直接给 `ref`、给 `automationId`、给 `name`（可再加 `role` 收窄）。
 * 后两种命中多个即歧义，**不按顺序挑第一个**：挑错了是在另一个控件上执行动作，
 * 而且不报错。歧义与缺失都作为工具结果交回模型，由它补充条件或重新观察。
 */
function resolveTarget(
  table: DesktopElement[] | null,
  args: Record<string, unknown>,
): DesktopElement {
  if (!table) {
    throw new ArgError(
      '这份观察已经失效，请重新调用 desktop_observe 取新的 observationId 与 ref。',
      'desktop_observation_stale',
    )
  }
  if (given(args.ref)) {
    const ref = str(args.ref, 'ref')
    const hit = table.find((e) => e.ref === ref)
    if (!hit) {
      throw new ArgError(
        `这份观察里没有 ${ref}，请重新调用 desktop_observe。`,
        'desktop_ref_unknown',
      )
    }
    return hit
  }
  const role = given(args.role) ? str(args.role, 'role') : undefined
  const automationId = given(args.automationId) ? str(args.automationId, 'automationId') : undefined
  const name = given(args.name) ? str(args.name, 'name') : undefined
  if (!automationId && !name) throw new ArgError('要操作哪个控件：给 ref、automationId 或 name')
  const hits = table.filter(
    (e) =>
      (automationId === undefined || e.automationId === automationId) &&
      (name === undefined || e.name === name) &&
      (role === undefined || e.role === role),
  )
  const first = hits[0]
  if (!first) {
    throw new ArgError(
      `这份观察里没有匹配的控件：${describeQuery(role, automationId, name)}`,
      'desktop_target_missing',
    )
  }
  if (hits.length > 1) {
    const shown = hits
      .slice(0, MAX_CANDIDATES)
      .map((e) => candidateLine(table, e))
      .join('；')
    throw new ArgError(
      `${describeQuery(role, automationId, name)} 匹配到 ${hits.length} 个控件，` +
        `按 ref 点名其中一个：${shown}`,
      'desktop_target_ambiguous',
    )
  }
  return first
}

function describeQuery(role?: string, automationId?: string, name?: string): string {
  return [
    role === undefined ? '' : `role=${role}`,
    automationId === undefined ? '' : `automationId=${automationId}`,
    name === undefined ? '' : `name=${name}`,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * 动作前的前置条件：控件启用、宿主在这个控件上实现了这个动作、且此刻能执行。
 *
 * 三条都能在本地判完，判完再发：拿一次往返换回来的是同一句拒绝。宿主那侧仍然照判，
 * 控件状态可能在观察与动作之间变过。
 */
function checkPrecondition(element: DesktopElement, kind: DesktopActionKind): void {
  if (!element.enabled) {
    throw new ArgError(
      `${element.ref} 当前处于禁用状态，没有执行 ${kind}。`,
      'desktop_precondition',
    )
  }
  const offer = element.actions.find((a) => a.action === kind)
  if (!offer) {
    const usable = element.actions.length ? element.actions.map((a) => a.action).join(' / ') : '无'
    throw new ArgError(
      `${element.ref} 不支持 ${kind}，它可用的动作是：${usable}`,
      'desktop_action_unsupported',
    )
  }
  if (offer.delivery.length === 0) {
    throw new ArgError(
      `${element.ref} 此刻不能执行 ${kind}：${offer.unavailable ?? '宿主没有说明原因'}`,
      'desktop_action_unsupported',
    )
  }
}

/**
 * 这一项所在的选择容器。顺着 `parentRef` 往上找第一个带 `selection` 的控件。
 *
 * 找不到返回 `undefined`：观察被筛过时祖先可能不在表里，那时不在本地拦，交给宿主判。
 */
function selectionContainer(
  table: DesktopElement[],
  element: DesktopElement,
): DesktopElement | undefined {
  const byRef = new Map(table.map((e) => [e.ref, e]))
  const seen = new Set<string>([element.ref])
  let at = element.parentRef
  while (at !== undefined && !seen.has(at)) {
    seen.add(at)
    const parent = byRef.get(at)
    if (!parent) return undefined
    if (parent.selection) return parent
    at = parent.parentRef
  }
  return undefined
}

/**
 * 把模型给的参数拼成一个动作，并按观察里读到的状态判前置条件。
 *
 * 值域、目标态与容器约束都在这里判：观察里已经带着 `range` / `toggle` / `expand` /
 * `selection`，本地判得出的就不发出去换一句拒绝。
 */
/**
 * 每种动作认哪几个参数。**给了不属于这个动作的参数即拒绝**：静默忽略的话，
 * `action=invoke` 带着 `value` 会被读成「写了值」，而那一次写没有发生过。
 */
const ACTION_PARAMS: Record<DesktopActionKind, readonly string[]> = {
  invoke: [],
  set_value: ['value'],
  set_range_value: ['number'],
  select: [],
  add_to_selection: [],
  remove_from_selection: [],
  set_toggle: ['state'],
  expand: [],
  collapse: [],
  scroll: ['direction', 'step'],
  scroll_into_view: [],
  realize_item: ['itemName'],
  select_text: ['start', 'length'],
}

/** 定位目标用的参数。它们对每种动作都成立，不参与动作参数的核对。 */
const TARGET_PARAMS = ['windowId', 'observationId', 'action', 'ref', 'automationId', 'name', 'role']

function checkActionParams(kind: DesktopActionKind, args: Record<string, unknown>): void {
  const allowed = new Set<string>([...TARGET_PARAMS, ...ACTION_PARAMS[kind]])
  const extra = Object.keys(args).filter((key) => !allowed.has(key) && args[key] !== undefined)
  if (extra.length) {
    throw new ArgError(`${kind} 不接受 ${extra.join(' / ')}`)
  }
}

function buildAction(
  table: DesktopElement[],
  element: DesktopElement,
  kind: DesktopActionKind,
  args: Record<string, unknown>,
): DesktopAction {
  checkActionParams(kind, args)
  switch (kind) {
    case 'invoke':
    case 'select':
    case 'scroll_into_view':
      return { kind }
    case 'set_value': {
      // 空串是清空，只有完全不给这个参数才算没提供。
      if (args.value === undefined || args.value === null) {
        throw new ArgError('set_value 必须给 value')
      }
      return { kind, value: String(args.value) }
    }
    case 'set_range_value': {
      const value = Number(args.number)
      if (args.number === undefined || args.number === null || !Number.isFinite(value)) {
        throw new ArgError('set_range_value 必须给 number')
      }
      const range = element.range
      // 越界不夹到边上：夹出来的值看着合法，而它不是调用方要的那一个。
      if (range && (value < range.min || value > range.max)) {
        throw new ArgError(
          `${element.ref} 只接受 ${range.min} 到 ${range.max}，给的是 ${value}。`,
          'desktop_precondition',
        )
      }
      return { kind, value }
    }
    case 'add_to_selection':
    case 'remove_from_selection': {
      const container = selectionContainer(table, element)
      if (container?.selection?.multiple === false) {
        throw new ArgError(
          `${container.ref} 一次只能选一项，用 action=select 换选择。`,
          'desktop_precondition',
        )
      }
      return { kind }
    }
    case 'set_toggle': {
      const state = oneOf(args.state, TOGGLE_STATES, 'state')
      if (element.toggle === state) {
        throw new ArgError(`${element.ref} 已经是 ${state}，没有执行。`, 'desktop_precondition')
      }
      return { kind, state }
    }
    case 'expand':
    case 'collapse': {
      if (element.expand === 'leaf') {
        throw new ArgError(`${element.ref} 没有可展开的内容。`, 'desktop_precondition')
      }
      const already = kind === 'expand' ? 'expanded' : 'collapsed'
      if (element.expand === already) {
        throw new ArgError(`${element.ref} 已经是 ${already}，没有执行。`, 'desktop_precondition')
      }
      return { kind }
    }
    case 'scroll':
      return {
        kind,
        direction: oneOf(args.direction, SCROLL_DIRECTIONS, 'direction'),
        step: given(args.step) ? oneOf(args.step, SCROLL_STEPS, 'step') : 'line',
      }
    case 'realize_item':
      return { kind, name: str(args.itemName, 'itemName') }
    case 'select_text':
      return {
        kind,
        start: bounded(args.start, 'start', 0, MAX_TEXT_OFFSET),
        length: bounded(args.length, 'length', 0, MAX_TEXT_OFFSET),
      }
  }
}

/** 一份观察的一行读数：控件数、截断与筛选各说一次。 */
function snapshotLine(s: DesktopSnapshot): string {
  return (
    `${s.observationId} · ${s.elements.length} 个控件` +
    (s.windowEnabled ? '' : '（窗口被模态窗口挡着，控件都不可操作）') +
    (s.truncated ? `（未读全：${s.truncatedBy.join(' / ')}）` : '') +
    (s.filteredBy.length ? `（已筛选：${s.filteredBy.join(' / ')}）` : '')
  )
}

/**
 * 三态回执与动作后的新观察合成一个结果。
 *
 * `not_dispatched` 是唯一允许 `executed:false` 的一种；另外两种一律 `executed:true`，
 * 重读缺席也不改这个判定——动作可能已经生效，重发一次等于多做一次。
 */
function actOutcome(action: DesktopActionKind, ref: string, r: DesktopActResult): ToolOutcome {
  const receipt: Record<string, unknown> = { actionId: r.actionId, dispatch: r.dispatch }
  if (r.reason !== undefined) receipt.reason = r.reason
  if (r.dispatch === 'not_dispatched') {
    return {
      status: 'failure',
      executed: false,
      message: `${action} 没有执行：${r.reason ?? '宿主拒绝了这次请求'}`,
      data: receipt,
      errorKind: 'desktop_not_dispatched',
    }
  }
  const unknown = r.dispatch === 'unknown'
  const lead = unknown
    ? `${action} 的结果未知：${r.reason ?? '调用已发出但没有确认'}。`
    : `${action} 已执行。`
  const advice = '先 desktop_observe 确认应用的实际状态，不要重放这个动作。'
  if (r.observation) {
    const target = r.observation.elements.find((e) => e.ref === ref)
    return {
      status: unknown ? 'failure' : 'success',
      ...(unknown ? { executed: true, errorKind: 'desktop_unknown' } : {}),
      message:
        `${lead}新观察 ${snapshotLine(r.observation)}` +
        (target ? `；目标现在是 ${elementLine(target)}` : '') +
        (unknown ? `。${advice}` : ''),
      data: { ...receipt, observation: r.observation },
    }
  }
  // 调用还没返回：目标窗口此刻读不动，宿主换成一份窗口清单。下一步观察的是新出现的
  // 那个窗口，不是目标窗口。
  if (r.blocking) {
    const appeared = r.blocking.filter((w) => w.appeared)
    const listed = (appeared.length ? appeared : r.blocking)
      .map((w) => `${w.windowId} ${w.app} ${w.title || '(无标题)'}`)
      .join('；')
    return {
      status: unknown ? 'failure' : 'success',
      ...(unknown ? { executed: true, errorKind: 'desktop_unknown' } : {}),
      message:
        `${lead}目标窗口此刻在响应这次调用，没有重读它。` +
        (appeared.length
          ? `这个应用新出现了窗口：${listed}。对它 desktop_observe 继续。`
          : `这个应用当前的窗口：${listed}。`) +
        (unknown ? advice : ''),
      data: { ...receipt, blocking: r.blocking, observationError: r.observationError },
    }
  }
  return {
    status: 'failure',
    executed: true,
    message: `${lead}没有取得动作之后的读数：${r.observationError}。${advice}`,
    data: { ...receipt, observationError: r.observationError },
    errorKind: unknown ? 'desktop_unknown' : 'desktop_observation_unavailable',
  }
}

/** 等待结果的投递。等待不派发动作，因此失败一律 `executed:false`。 */
function waitOutcome(
  found: boolean,
  reason: string | undefined,
  follow: DesktopFollowUp,
): ToolOutcome {
  const lead = found ? '条件已满足。' : `没等到（${reason ?? 'timeout'}）。`
  if (follow.observation) {
    return {
      status: found ? 'success' : 'failure',
      ...(found ? {} : { executed: false, errorKind: 'desktop_wait_timeout' }),
      message: `${lead}新观察 ${snapshotLine(follow.observation)}`,
      data: { found, ...(reason ? { reason } : {}), observation: follow.observation },
    }
  }
  return {
    status: 'failure',
    executed: false,
    message: `${lead}没有取得当时的控件表：${follow.observationError}`,
    data: { found, ...(reason ? { reason } : {}), observationError: follow.observationError },
    errorKind: 'desktop_observation_unavailable',
  }
}

/**
 * 把一张图接到工具结果的图像通道上。
 *
 * **字节走 `data.images`，不进 `message`**：一串 base64 模型读不懂，留在正文里只照价计费。
 *
 * 过一遍 `shrinkImage` 之后按几何核尺寸：采集端已经按 `MAX_EDGE` 缩好，这里本该一个
 * 字节不动。真缩了或者尺寸对不上，说明几何记的不是模型看到的那一张，按图算出来的屏幕
 * 坐标就是错的——**那时宁可不给图**。
 */
async function imagePayload(
  image: DesktopImage,
): Promise<{ data: Record<string, unknown>; line: string } | { error: string }> {
  const raw = Uint8Array.from(Buffer.from(image.data, 'base64'))
  const fit = await shrinkImage(raw, image.mime)
  const size = imageSizeOf(fit.bytes)
  const g = image.geometry
  if (!size || size.width !== g.imageWidth || size.height !== g.imageHeight) {
    return {
      error:
        `采到的图与它的几何对不上（几何 ${g.imageWidth}×${g.imageHeight}，` +
        `图 ${size ? `${size.width}×${size.height}` : '尺寸读不出'}），这张图不能用来定位。`,
    }
  }
  const hint = image.source === 'print_window' ? '，退路采集，没有重绘的区域是黑的' : ''
  return {
    data: {
      imageRef: image.imageRef,
      geometry: g,
      source: image.source,
      imageCapturedAt: image.capturedAt,
      images: [{ data: Buffer.from(fit.bytes).toString('base64'), mime: fit.mime }],
    },
    line:
      `${image.imageRef} ${g.imageWidth}×${g.imageHeight} 像素，` +
      `对应屏幕 ${g.screen.x},${g.screen.y} ${g.screen.width}×${g.screen.height}，` +
      `显示器 DPI ${g.dpi}${hint}`,
  }
}

/** 当前模型不收图片时的终态。重试永远不会成功，所以话里要带下一步该干什么。 */
const NO_VISION = {
  status: 'failure',
  executed: false,
  message:
    '当前模型不接受图片输入，采图没有意义。改用 capture=structure 读控件表；' +
    '树里找不到目标时说明这一步需要视觉，请换一个支持图片的模型。',
  errorKind: 'unsupported',
} as const

/** 按控件取景：包围盒向外扩若干像素。 */
function padded(rect: DesktopRect, pad: number): DesktopRect {
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  }
}

/** 四个工具的目标都是那个窗口。`desktop_windows` 没有窗口可指，见它自己的 spec。 */
function windowTarget(args: Record<string, unknown>): string | null {
  return given(args.windowId) ? String(args.windowId).trim() : null
}

const BASE = {
  category: 'desktop',
  facet: '桌面控件',
  objectLabel: '电脑操作',
  permissionEffect: 'desktop',
} as const

export const desktopWindowsTool: ToolSpec = {
  ...BASE,
  name: 'desktop_windows',
  description:
    '列出本机此刻可操作的顶层窗口。' +
    'windowId 是后续观察与动作的唯一入口，由这里给出，无法自己拼出来；' +
    '应用重启或窗口重建之后旧的 windowId 失效，重新调用本工具取新的。' +
    '本工具不截图，也不激活或置前任何窗口。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  actionKind: 'read',
  summary: '列出可操作的桌面窗口',
  targetExtractor: () => '电脑操作',

  fn: (_args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windows = await send(() => desktop.windows())
      return {
        status: 'success',
        message: windows.length
          ? `${windows.length} 个窗口：${windows.map((w) => `${w.windowId} ${w.app} ${w.title}`).join('；')}`
          : '没有可操作的窗口',
        data: { windows },
      }
    }),
}

export const desktopObserveTool: ToolSpec = {
  ...BASE,
  name: 'desktop_observe',
  description:
    '观察一个窗口。capture 决定观察什么：' +
    'structure（默认）只读控件表，一个像素都不采；region_image 只采图；combined 两样都要；' +
    'text 读一个控件的文档文本与选区，要给 observationId 与控件（ref / automationId / name）。' +
    '先用 structure——控件表直接给出名称、值与可执行的动作；' +
    '只有树里找不到目标时（画布、无名图标、自绘界面）才采图。' +
    '控件表给出角色、名称、稳定标识、当前值、是否启用，' +
    'actions（每个动作带 delivery 与不可用原因），' +
    '以及控件模式读到的状态：range 数值区间、toggle 复选现态、expand 展开现态、' +
    'selected 这一项选中没有、selection 容器的多选与必选约束、scroll 滚动位置百分比、' +
    'text 能不能读文档文本；' +
    '以及 rect：控件在屏幕上的包围盒，与图用同一套坐标，树与图因此对得上。' +
    '每个控件带 parentRef 与 depth，同名控件靠祖先路径区分。' +
    '返回的 observationId 与控件 ref 是 desktop_act 与 desktop_wait 的前提；重新观察即换号，旧号作废。' +
    'query 只返回名称、稳定标识或值包含该文字的控件，role 只返回该角色的控件；' +
    'root 只读某个控件底下的子树，用于翻开一个已经看到的容器。' +
    '筛选过的观察里 filteredBy 会列出条件——没列出来的控件是被筛掉了，不是不存在。' +
    'truncated=true 表示被上限截断了，用 maxNodes 或 maxDepth 调整后重读。' +
    'includeValue=false 时不取控件当前值，includeState=false 时不取上面那几项状态——' +
    '读大窗口时各省一部分开销，两者都不影响 actions。' +
    '采图默认采整窗；around 指一个控件，只采它的包围盒向外扩 pad 像素的那一块——' +
    'region_image 下它按 observationId 那一份控件表解析，combined 下按这次读到的那一份；' +
    'imageRef 加 imageRect 把上一张图里的那一块放大重采，用于看清一处细节。' +
    '图带回 imageRef 与 geometry；窗口移动、缩放、换显示器之后旧 imageRef 失效，重新采图。' +
    'capturedAt 是控件表的时刻，imageCapturedAt 是图的时刻，两者不是同一刻。',
  parameters: {
    type: 'object',
    properties: {
      windowId: { type: 'string', description: '取自 desktop_windows' },
      capture: { type: 'string', enum: CAPTURES, description: '观察什么，默认 structure' },
      maxNodes: { type: 'integer', description: `最多读多少个控件，上限 ${MAX_NODES}` },
      maxDepth: { type: 'integer', description: `最多读多少层，上限 ${MAX_DEPTH}` },
      root: { type: 'string', description: '只读这个控件底下的子树，取自上一份观察的 ref' },
      role: { type: 'string', description: '只返回这个角色的控件' },
      query: { type: 'string', description: '只返回名称、稳定标识或值包含这段文字的控件' },
      includeValue: { type: 'boolean', description: '取不取控件当前值，默认取' },
      includeState: {
        type: 'boolean',
        description: '取不取 range / toggle / expand / selected / selection / scroll，默认取',
      },
      observationId: {
        type: 'string',
        description:
          'capture=region_image 用 around 取景时要给，capture=text 一定要给，取自 desktop_observe',
      },
      ref: { type: 'string', description: 'capture=text 要读哪个控件，取自同一份观察' },
      automationId: { type: 'string', description: 'capture=text 按稳定标识定位，要求唯一命中' },
      name: { type: 'string', description: 'capture=text 按名称定位，要求唯一命中' },
      maxChars: {
        type: 'integer',
        description: `capture=text 最多要回多少字，上限 ${MAX_TEXT_CHARS}`,
      },
      around: { type: 'string', description: '只采这个控件周围的那一块，控件 ref' },
      pad: { type: 'integer', description: `around 向外扩多少像素，上限 ${MAX_PAD}` },
      imageRef: { type: 'string', description: '要放大的那一张图，取自上一次采图' },
      imageRect: {
        type: 'object',
        description: 'imageRef 那张图里的一块，图像坐标',
        properties: {
          x: { type: 'integer' },
          y: { type: 'integer' },
          width: { type: 'integer' },
          height: { type: 'integer' },
        },
        required: ['x', 'y', 'width', 'height'],
        additionalProperties: false,
      },
    },
    required: ['windowId'],
    additionalProperties: false,
  },
  actionKind: 'read',
  summary: '读一个窗口的控件表或采一张图',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windowId = str(args.windowId, 'windowId')
      const capture: CaptureMode = given(args.capture)
        ? oneOf(args.capture, CAPTURES, 'capture')
        : 'structure'
      if (capture !== 'region_image' && capture !== 'combined' && framingGiven(args)) {
        throw new ArgError('取景参数只在 capture=region_image 或 combined 下有意义')
      }
      if (capture === 'text') {
        const observationId = str(args.observationId, 'observationId')
        const element = resolveTarget(desktop.elements(windowId, observationId), args)
        if (element.text !== true) {
          throw new ArgError(
            `${element.ref} 读不出文档文本；它的当前值在观察的 value 里。`,
            'desktop_action_unsupported',
          )
        }
        const maxChars = given(args.maxChars)
          ? bounded(args.maxChars, 'maxChars', 1, MAX_TEXT_CHARS)
          : MAX_TEXT_CHARS
        const read = await send(() =>
          desktop.readText({ windowId, observationId, ref: element.ref, maxChars }),
        )
        const selection = read.selection.length
          ? read.selection
              .map((s) => `${s.start} 起 ${JSON.stringify(s.text)}${s.truncated ? '（截断）' : ''}`)
              .join('；')
          : '无'
        return {
          status: 'success',
          message:
            `${element.ref} 文本 ${read.text.length} 字${read.truncated ? '（截断）' : ''}` +
            `；选区 ${selection}`,
          data: { ref: element.ref, ...read },
        }
      }
      // combined 的 around 按这次读到的控件表解析：读树会换一个观察编号，
      // 再拿调用方给的那个旧编号去解析，解出来的是一份已经作废的表。
      if (capture === 'combined' && given(args.observationId)) {
        throw new ArgError('capture=combined 时不要给 observationId：around 按这次读到的控件表解析')
      }
      // 不收图片的模型在采集之前就回绝：采一张它看不到的图要付出整条采集与编码的代价。
      if (capture !== 'structure' && ctx.vision === false) return NO_VISION

      if (capture === 'region_image') {
        const image = await captureFor(desktop, send, windowId, args, null)
        const payload = await imagePayload(image)
        if ('error' in payload) {
          return {
            status: 'failure',
            message: payload.error,
            errorKind: 'desktop_image_mismatch',
          }
        }
        return { status: 'success', message: `图 ${payload.line}`, data: payload.data }
      }

      // 参数在进端口之前解析完：解析放进 `send` 的回调里，一次参数错会被记成
      // 「已经交给端口了」，而那意味着不许重发。
      const input = {
        windowId,
        ...(given(args.maxNodes)
          ? { maxNodes: bounded(args.maxNodes, 'maxNodes', 1, MAX_NODES) }
          : {}),
        ...(given(args.maxDepth)
          ? { maxDepth: bounded(args.maxDepth, 'maxDepth', 1, MAX_DEPTH) }
          : {}),
        ...(given(args.root) ? { root: str(args.root, 'root') } : {}),
        ...(given(args.role) ? { role: str(args.role, 'role') } : {}),
        ...(given(args.query) ? { query: str(args.query, 'query') } : {}),
        ...(args.includeValue === false ? { includeValue: false } : {}),
        ...(args.includeState === false ? { includeState: false } : {}),
      }
      const snapshot = await send(() => desktop.observe(input))
      const line = `${snapshot.app} · ${snapshot.title || '(无标题)'} · ${snapshotLine(snapshot)}`
      if (capture === 'structure') {
        return { status: 'success', message: line, data: { ...snapshot } }
      }
      // 控件表已经拿到手：图采不到也要把它交出去，并说清图为什么没有。
      const captured = await captureFor(desktop, send, windowId, args, snapshot.elements).then(
        (image) => imagePayload(image),
        (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
      )
      if ('error' in captured) {
        return {
          status: 'success',
          message: `${line}；没有采到图：${captured.error}`,
          data: { ...snapshot, imageError: captured.error },
        }
      }
      return {
        status: 'success',
        message: `${line}；图 ${captured.line}`,
        data: { ...snapshot, ...captured.data },
      }
    }),
}

/** 这次调用给了取景参数没有。给了就要求 capture 不是 structure。 */
function framingGiven(args: Record<string, unknown>): boolean {
  return given(args.around) || given(args.imageRef) || args.imageRect !== undefined
}

/**
 * 按参数决定采哪一块。
 *
 * 三种取景互斥：整窗、`around` 加 `pad`、`imageRef` 加 `imageRect`。同时给后两种时不挑，
 * 当场拒绝——挑错一种采回来的是另一块界面。
 *
 * `fresh` 是这次调用刚读到的控件表，`combined` 给它、`region_image` 给 `null`。
 * **`around` 只在手上这一份表里解析**：`combined` 读过树之后旧观察编号已经作废，
 * 拿调用方给的那个编号去解析，解出来的是一份已经不存在的表。
 */
async function captureFor(
  desktop: DesktopPort,
  send: PortCall,
  windowId: string,
  args: Record<string, unknown>,
  fresh: DesktopElement[] | null,
): Promise<DesktopImage> {
  const around = given(args.around)
  const byImage = given(args.imageRef)
  if (around && byImage) throw new ArgError('around 与 imageRef 只能给一个')
  if (around) {
    const ref = str(args.around, 'around')
    const table = fresh ?? desktop.elements(windowId, str(args.observationId, 'observationId'))
    if (!table) {
      throw new ArgError(
        '这份观察已经失效，请重新调用 desktop_observe 取新的 observationId 与 ref。',
        'desktop_observation_stale',
      )
    }
    const element = table.find((e) => e.ref === ref)
    if (!element) {
      throw new ArgError(`这份观察里没有 ${ref}。`, 'desktop_ref_unknown')
    }
    const box = element.rect
    if (!box) {
      throw new ArgError(`${ref} 没有包围盒，取不了景；改采整窗或换一个控件。`, 'desktop_no_bounds')
    }
    const pad = given(args.pad) ? bounded(args.pad, 'pad', 0, MAX_PAD) : 0
    const region = padded(box, pad)
    return send(() => desktop.captureImage({ windowId, maxEdge: MAX_EDGE, region }))
  }
  if (byImage) {
    const imageRef = str(args.imageRef, 'imageRef')
    const raw = args.imageRect
    if (!raw || typeof raw !== 'object') throw new ArgError('给了 imageRef 就要给 imageRect')
    const box = raw as Record<string, unknown>
    const imageRect: DesktopRect = {
      x: bounded(box.x, 'imageRect.x', 0, MAX_IMAGE_COORD),
      y: bounded(box.y, 'imageRect.y', 0, MAX_IMAGE_COORD),
      width: bounded(box.width, 'imageRect.width', 1, MAX_IMAGE_COORD),
      height: bounded(box.height, 'imageRect.height', 1, MAX_IMAGE_COORD),
    }
    return send(() => desktop.captureImage({ windowId, maxEdge: MAX_EDGE, imageRef, imageRect }))
  }
  return send(() => desktop.captureImage({ windowId, maxEdge: MAX_EDGE }))
}

export const desktopActTool: ToolSpec = {
  ...BASE,
  name: 'desktop_act',
  description:
    '在观察到的控件上执行一个动作。每个控件的 actions 列出它此刻能做什么：' +
    'delivery 非空才能执行，为空时 unavailable 说明原因（只读、叶节点、滚不动）。' +
    'invoke 调用默认动作（按钮、菜单项）；set_value 写值（空串是清空）；' +
    'set_range_value 按 number 写数值（滑块、微调框），越界与只读一律拒绝；' +
    'select 换成只选这一项，add_to_selection / remove_from_selection 增选与取消，单选容器上不可用；' +
    'set_toggle 按 state 把复选控件设成 off / on / indeterminate——给的是目标态不是切一次；' +
    'expand / collapse 展开或收起菜单、树节点、组合框；' +
    'scroll 按 direction 与 step（line 默认 / page）滚一步；scroll_into_view 把控件滚进可见区；' +
    'realize_item 在虚拟化列表容器上按 itemName 找一项并实例化它，之后重新观察才拿得到它的 ref；' +
    'select_text 按 start 与 length（UTF-16 码元）设选区。' +
    '目标可以给 ref，也可以给 automationId 或 name（可加 role 收窄）；' +
    '匹配到多个时不执行，结果里按祖先路径列出候选，改用 ref 点名。' +
    '结果里的 dispatch 有三种：not_dispatched 表示没有执行，submitted 表示调用已被系统接受，' +
    'unknown 表示调用已发出但结果无法确认——遇到 unknown 先 desktop_observe 确认实际状态，不要重放。' +
    '动作之后同次带回目标所在子树的新观察与新的 observationId，据此继续下一步，' +
    '不必再调 desktop_observe；子树之外的旧 ref 在新编号下仍然有效。' +
    '动作打开模态对话框时没有新观察，结果里改带 blocking：目标应用此刻的窗口，' +
    'appeared 为真的是这次动作之后冒出来的——直接对它的 windowId 调 desktop_observe。' +
    '本工具不移动鼠标、不按键、不置前台，也不设焦点。',
  parameters: {
    type: 'object',
    properties: {
      windowId: { type: 'string' },
      observationId: { type: 'string', description: '取自 desktop_observe' },
      action: { type: 'string', enum: ACTIONS },
      ref: { type: 'string', description: '控件编号，取自同一份观察' },
      automationId: { type: 'string', description: '按稳定标识定位，要求唯一命中' },
      name: { type: 'string', description: '按名称定位，要求唯一命中' },
      role: { type: 'string', description: '与 automationId 或 name 一起收窄匹配' },
      value: { type: 'string', description: 'set_value 要写入的值，空串是清空' },
      number: { type: 'number', description: 'set_range_value 要写入的数值' },
      state: { type: 'string', enum: TOGGLE_STATES, description: 'set_toggle 的目标态' },
      direction: { type: 'string', enum: SCROLL_DIRECTIONS, description: 'scroll 的方向' },
      step: { type: 'string', enum: SCROLL_STEPS, description: 'scroll 一步滚多少，默认 line' },
      itemName: { type: 'string', description: 'realize_item 要实例化的那一项的名称' },
      start: { type: 'integer', description: 'select_text 的起点，UTF-16 码元' },
      length: { type: 'integer', description: 'select_text 的长度，UTF-16 码元' },
    },
    required: ['windowId', 'observationId', 'action'],
    additionalProperties: false,
  },
  actionKind: 'call',
  summary: '在桌面控件上执行一个语义动作',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windowId = str(args.windowId, 'windowId')
      const observationId = str(args.observationId, 'observationId')
      const kind = oneOf(args.action, ACTIONS, 'action')
      const table = desktop.elements(windowId, observationId)
      const element = resolveTarget(table, args)
      checkPrecondition(element, kind)
      const action = buildAction(table ?? [], element, kind, args)

      const r = await send(() => desktop.act({ windowId, observationId, ref: element.ref, action }))
      return actOutcome(kind, element.ref, r)
    }),
}

export const desktopWaitTool: ToolSpec = {
  ...BASE,
  name: 'desktop_wait',
  description:
    '等一个后置条件成立，判定在宿主那一侧做，不派发任何动作。' +
    'until=enabled 等某个控件变成可用，until=value 等它的值变成 value，until=gone 等它消失——' +
    '这三种要给目标控件，给法与 desktop_act 相同。' +
    'until=appears 等窗口里出现满足 role 与 name 的控件，until=window 等出现标题包含 name 的新窗口——' +
    '这两种不需要已有的控件编号，等到之后 until=window 要先 desktop_windows 取新窗口。' +
    `默认 ${DEFAULT_WAIT_MS} 毫秒，上限 ${MAX_WAIT_MS} 毫秒；到期如实返回未满足与当时的控件表。` +
    '结果里同样带回新的 observationId，据此继续下一步。',
  parameters: {
    type: 'object',
    properties: {
      windowId: { type: 'string' },
      observationId: { type: 'string' },
      until: { type: 'string', enum: WAIT_CONDITIONS },
      ref: { type: 'string' },
      automationId: { type: 'string' },
      name: {
        type: 'string',
        description:
          'enabled / value / gone 时按名称定位控件；appears 时是要出现的控件名称；window 时是新窗口标题的子串',
      },
      role: { type: 'string' },
      value: { type: 'string', description: 'until=value 时要等到的值' },
      timeoutMs: { type: 'integer' },
    },
    required: ['windowId', 'observationId', 'until'],
    additionalProperties: false,
  },
  actionKind: 'read',
  summary: '等一个桌面后置条件成立',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windowId = str(args.windowId, 'windowId')
      const observationId = str(args.observationId, 'observationId')
      const until = oneOf(args.until, WAIT_CONDITIONS, 'until')
      if (until === 'value' && (args.value === undefined || args.value === null)) {
        throw new ArgError('until=value 必须给 value')
      }
      if (until === 'window' && !given(args.name)) {
        throw new ArgError('until=window 必须给 name：要等的新窗口标题里的一段文字')
      }
      if (until === 'appears' && !given(args.name) && !given(args.role)) {
        throw new ArgError('until=appears 必须给 name 或 role')
      }
      // 盯已知控件的那三种先在本地解析成唯一目标；另外两种等的是还没出现的控件或窗口。
      const ref = REF_CONDITIONS.includes(until)
        ? resolveTarget(desktop.elements(windowId, observationId), args).ref
        : undefined
      const r = await send(() =>
        desktop.wait({
          windowId,
          observationId,
          until,
          ...(ref !== undefined ? { ref } : {}),
          ...(until === 'value' ? { value: String(args.value) } : {}),
          ...(until === 'appears' && given(args.role) ? { role: str(args.role, 'role') } : {}),
          ...(until === 'appears' && given(args.name) ? { query: str(args.name, 'name') } : {}),
          ...(until === 'window' && given(args.name) ? { title: str(args.name, 'name') } : {}),
          timeoutMs: given(args.timeoutMs)
            ? bounded(args.timeoutMs, 'timeoutMs', MIN_WAIT_MS, MAX_WAIT_MS)
            : DEFAULT_WAIT_MS,
        }),
      )
      return waitOutcome(r.found, r.reason, r)
    }),
}

/** 注册顺序在这里定，`index.ts` 按通道整组注册或整组不注册。 */
export const desktopTools: ToolSpec[] = [
  desktopWindowsTool,
  desktopObserveTool,
  desktopActTool,
  desktopWaitTool,
]
