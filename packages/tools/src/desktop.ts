/**
 * 电脑控制的五个工具：窗口发现、结构化观察、动作、有限动作序列、等待。
 *
 * 单个动作一次调用发一条端口命令就返回，由 Agent 循环再决定下一步。序列是同一个
 * `DesktopPort.act` 的有界循环，不重试有副作用的动作——重试一次 invoke 等于在应用里
 * 多提交一次。
 *
 * 六条边界：
 *
 * 1. **端口只从 `ctx.desktop` 取。** 参数里自报的会话、Run、窗口句柄一概不读；
 *    模型手里只有端口发放的不透明 `windowId`。没有端口时这五个工具不注册
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
 * 6. **序列遇到边界即截断后缀，已派发的前缀如实保留。** 后缀不会被补做，
 *    前缀不会被重放。
 */

import type {
  DesktopActResult,
  DesktopBlockingWindowInfo,
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
  DesktopDispatch,
  DesktopModifier,
  DesktopMouseButton,
  DesktopRect,
  DesktopScrollDirection,
  DesktopScrollStep,
  DesktopToggleState,
  DesktopWindowState,
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
  'click',
  'hover',
  'drag',
  'wheel',
  'type_text',
  'press_key',
  'activate',
  'set_window_state',
  'move_window',
  'resize_window',
  'close_window',
]
/**
 * 序列接受的动作：经控件模式发出的那十三种。
 *
 * 其余动作用真实指针与键盘，每一步都会改变前台与焦点，后面那些步骤的前置条件因此
 * 不再独立成立。不要把它们加进来，序列没有重新取得焦点的手段。
 */
const SEQUENCE_ACTIONS: readonly DesktopActionKind[] = [
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
/** 接受图像点落点的那几种。其余动作只能按控件执行。 */
const POINTER_ACTIONS: readonly DesktopActionKind[] = ['click', 'hover', 'drag', 'wheel']
/**
 * 可以不点名控件、直接投给窗口的那几种。
 *
 * 键盘输入去的是系统焦点所在，不是某个被点名的控件。自绘界面不暴露业务控件，
 * 永远给不出一个持有焦点的控件，只认控件等于对这类应用关掉整条键盘路径。
 */
const WINDOW_TARGET_ACTIONS: readonly DesktopActionKind[] = ['type_text', 'press_key']
const MOUSE_BUTTONS: readonly DesktopMouseButton[] = ['left', 'right', 'middle']
const MODIFIERS: readonly DesktopModifier[] = ['ctrl', 'alt', 'shift', 'win']
const WINDOW_STATES: readonly DesktopWindowState[] = ['normal', 'minimized', 'maximized']
/** 一次点击最多连点几下。双击是 2，没有三击。 */
const MAX_CLICK_COUNT = 2
/** 一次滚轮最多滚几格。 */
const MAX_WHEEL_AMOUNT = 20
/** 一次输入最多多少个字。更长的文本分几次发，中途前台变了才停得住。 */
const MAX_TEXT_LENGTH = 4000
/** 拖拽偏移与窗口坐标的取值上界。挡住明显越界的请求，真实上界由屏幕与窗口能力定。 */
const MAX_SCREEN_COORD = 100_000
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
 * 一次序列最多几步。
 *
 * 整组在同一次桌面占用里跑完，期间别的执行者进不来；每一步还带一次动作后重读。
 * 十步的占用时长与 `desktop_wait` 一次的上限同级，再长就该让模型重新观察一次。
 */
const MAX_STEPS = 10
/** 一步的后置条件最多等多久。 */
const MAX_EXPECT_MS = 15_000
/** 调用方没给时长时，一步的后置条件等多久。 */
const DEFAULT_EXPECT_MS = 3_000
/** 序列里一步的后置条件。 */
const EXPECTATIONS = ['value', 'toggle', 'selected', 'gone', 'appears'] as const
type Expectation = (typeof EXPECTATIONS)[number]
/**
 * 后置条件对应的宿主等待条件。**缺席的两种没有宿主等待**：`toggle` 与 `selected`
 * 经 TogglePattern / SelectionItemPattern 同步写入，按动作自己带回的那份观察判一次；
 * 本地不另开轮询，判定只在宿主那一侧做。
 */
const EXPECT_WAITS: Partial<Record<Expectation, DesktopWaitCondition>> = {
  value: 'value',
  gone: 'gone',
  appears: 'appears',
}
/** 后置条件接受的参数。给了不属于这一种的即拒绝，同 `ACTION_PARAMS`。 */
const EXPECT_PARAMS: Record<Expectation, readonly string[]> = {
  value: ['value', 'timeoutMs'],
  toggle: ['state'],
  selected: [],
  gone: ['timeoutMs'],
  appears: ['name', 'role', 'timeoutMs'],
}

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

/**
 * 这个可选参数给了没有。`null` 与空串按缺席算，与浏览器工具同一条判据。
 *
 * **这条判据也管「不属于本动作的参数」那一类检查，不要在那里换成 `!== undefined`。**
 * strict 工具 schema 把每个可选参数都列进 `required` 并在类型里加 `null`
 * （`packages/ai` 的 `strictify`），模型按它为用不上的参数逐个填空位——实测填的是
 * `null` 与空串两种。按 `!== undefined` 判会把一次 `set_value` 附带的二十来个空位
 * 全报成多余参数，动作一次也派发不出去。
 *
 * 空串对这条检查不构成例外：`value` 的清空语义由动作自己的参数表放行，
 * 走不到这条判据。
 */
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
  message: '本次执行没有电脑控制能力，无法操作桌面应用。',
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
 * 五个工具共用的前置判定与终态。
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
    selectedLabel(e) +
    (e.enabled ? '' : ' 已禁用')
  )
}

/** 选择容器此刻选中的那几项。一项都没选中时不写。 */
function selectedLabel(e: DesktopElement): string {
  const names = e.selection?.selected
  if (!names?.length) return ''
  const listed = names.map((n) => JSON.stringify(n)).join('、')
  return ` 选中 ${listed}${e.selection?.truncated === true ? ' 等' : ''}`
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

/** 这次调用点名控件了没有。三种定位条件任一给了就算点名。 */
function targetGiven(args: Record<string, unknown>): boolean {
  return given(args.ref) || given(args.automationId) || given(args.name)
}

/**
 * 这个控件是不是窗口根节点。
 *
 * 判据是 `ref` 的下标路径只有根那一段（`w`）：子树读回来的根带着它在整窗里的下标
 * （`w.3.1`），按「没有 parentRef」判会把子树根一并算进来。
 */
function isWindowRoot(e: DesktopElement): boolean {
  return e.ref.split('#')[0] === 'w'
}

/** 观察里的窗口根节点。整窗观察一定有它；只读过子树的观察没有，那时要求重读整窗。 */
function windowRoot(table: DesktopElement[] | null): DesktopElement {
  if (!table) {
    throw new ArgError(
      '这份观察已经失效，请重新调用 desktop_observe 取新的 observationId。',
      'desktop_observation_stale',
    )
  }
  const root = table.find(isWindowRoot)
  if (!root) {
    throw new ArgError(
      '这份观察里没有窗口根节点，先对整窗调用一次 desktop_observe。',
      'desktop_target_missing',
    )
  }
  return root
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
  click: ['button', 'count'],
  hover: [],
  drag: ['toRef', 'dx', 'dy'],
  wheel: ['direction', 'amount'],
  type_text: ['text'],
  press_key: ['key', 'modifiers'],
  activate: [],
  set_window_state: ['windowState'],
  move_window: ['x', 'y'],
  resize_window: ['width', 'height'],
  close_window: [],
}

/** 定位目标用的参数。它们对每种动作都成立，不参与动作参数的核对。 */
const TARGET_PARAMS = ['windowId', 'observationId', 'action', 'ref', 'automationId', 'name', 'role']
/** 序列里一步认的定位参数。窗口与观察编号是整组给的，不写在步里。 */
const STEP_PARAMS = ['action', 'ref', 'automationId', 'name', 'role', 'expect']
/** 按图定位用的参数。只有指针动作接受它们。 */
const POINT_PARAMS = ['imageRef', 'imageX', 'imageY']

function checkActionParams(
  kind: DesktopActionKind,
  args: Record<string, unknown>,
  target: readonly string[],
): void {
  const allowed = new Set<string>([
    ...target,
    ...(POINTER_ACTIONS.includes(kind) ? POINT_PARAMS : []),
    ...ACTION_PARAMS[kind],
  ])
  const extra = Object.keys(args).filter((key) => !allowed.has(key) && given(args[key]))
  if (extra.length) {
    throw new ArgError(`${kind} 不接受 ${extra.join(' / ')}`)
  }
}

function buildAction(
  table: DesktopElement[],
  element: DesktopElement,
  kind: DesktopActionKind,
  args: Record<string, unknown>,
  target: readonly string[],
): DesktopAction {
  checkActionParams(kind, args, target)
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
    case 'click':
      return {
        kind,
        button: given(args.button) ? oneOf(args.button, MOUSE_BUTTONS, 'button') : 'left',
        count: given(args.count) ? bounded(args.count, 'count', 1, MAX_CLICK_COUNT) : 1,
      }
    case 'hover':
    case 'activate':
    case 'close_window':
      return { kind }
    case 'drag': {
      const byRef = given(args.toRef)
      const byOffset = given(args.dx) || given(args.dy)
      if (byRef && byOffset) throw new ArgError('drag 的终点给 toRef 或 dx/dy，不能都给')
      if (byRef) {
        return { kind, to: { kind: 'ref', ref: str(args.toRef, 'toRef') } }
      }
      if (!byOffset) throw new ArgError('drag 必须给终点：toRef，或 dx 与 dy')
      return {
        kind,
        to: {
          kind: 'offset',
          dx: bounded(args.dx ?? 0, 'dx', -MAX_SCREEN_COORD, MAX_SCREEN_COORD),
          dy: bounded(args.dy ?? 0, 'dy', -MAX_SCREEN_COORD, MAX_SCREEN_COORD),
        },
      }
    }
    case 'wheel':
      return {
        kind,
        direction: oneOf(args.direction, SCROLL_DIRECTIONS, 'direction'),
        amount: given(args.amount) ? bounded(args.amount, 'amount', 1, MAX_WHEEL_AMOUNT) : 1,
      }
    case 'type_text': {
      // 空串没有可输入的内容，与 set_value 的「清空」不是一回事。
      const text = str(args.text, 'text')
      if (text.length > MAX_TEXT_LENGTH) {
        throw new ArgError(`text 最多 ${MAX_TEXT_LENGTH} 个字，给的是 ${text.length} 个`)
      }
      return { kind, text }
    }
    case 'press_key':
      return { kind, key: str(args.key, 'key'), modifiers: modifiersOf(args.modifiers) }
    case 'set_window_state':
      return { kind, state: oneOf(args.windowState, WINDOW_STATES, 'windowState') }
    case 'move_window':
      return {
        kind,
        x: bounded(args.x, 'x', -MAX_SCREEN_COORD, MAX_SCREEN_COORD),
        y: bounded(args.y, 'y', -MAX_SCREEN_COORD, MAX_SCREEN_COORD),
      }
    case 'resize_window':
      return {
        kind,
        width: bounded(args.width, 'width', 1, MAX_SCREEN_COORD),
        height: bounded(args.height, 'height', 1, MAX_SCREEN_COORD),
      }
  }
}

/** 组合键的修饰键。重复的按第一次出现的位置留一份：按两次同一个键没有额外含义。 */
function modifiersOf(raw: unknown): DesktopModifier[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new ArgError('modifiers 必须是数组')
  const out: DesktopModifier[] = []
  for (const item of raw) {
    const modifier = oneOf(item, MODIFIERS, 'modifiers')
    if (!out.includes(modifier)) out.push(modifier)
  }
  return out
}

/** 这个控件在不在标题栏那棵子树里。顺着 `parentRef` 往上走。 */
function inTitleBar(byRef: Map<string, DesktopElement>, element: DesktopElement): boolean {
  const seen = new Set<string>()
  let at: DesktopElement | undefined = element
  while (at && !seen.has(at.ref)) {
    seen.add(at.ref)
    if (at.role === 'title_bar') return true
    at = at.parentRef === undefined ? undefined : byRef.get(at.parentRef)
  }
  return false
}

/**
 * 这份观察里有几个可操作的业务控件。
 *
 * 判据只用观察自己：带可执行后台动作、不是窗口根、且不在标题栏子树里。标题栏、
 * 系统菜单与最小化 / 最大化 / 关闭由系统画，任何顶层窗口都有它们，把它们算进来会
 * 把自绘界面判成结构上可操作。**不按应用名判。**
 */
function operableCount(table: DesktopElement[]): number {
  const byRef = new Map(table.map((e) => [e.ref, e]))
  return table.filter(
    (e) =>
      !isWindowRoot(e) &&
      e.actions.some((a) => a.delivery.includes('background')) &&
      !inTitleBar(byRef, e),
  ).length
}

/**
 * 控件树上一个业务控件都没有的窗口，在回执里如实说明并指出下一步。
 *
 * 只在整窗、未截断、未筛选的观察上判：筛出零个控件与「这个窗口没有控件」是两回事，
 * 混起来会让一次 `role=button` 的空结果被说成应用不暴露控件。
 *
 * 前台操作开没开按同一份 delivery 表读：关着时表里一条 `foreground` 都没有。
 */
function bareWindowNote(s: DesktopSnapshot): string {
  if (s.truncated || s.filteredBy.length > 0) return ''
  if (!s.elements.some(isWindowRoot)) return ''
  if (operableCount(s.elements) > 0) return ''
  const foreground = s.elements.some((e) =>
    e.actions.some((a) => a.delivery.includes('foreground')),
  )
  return (
    '；这个窗口没有暴露可操作的控件，只能按图操作：' +
    '用 capture=region_image 或 combined 取图，' +
    '再调 desktop_act 给 imageRef 与 imageX / imageY 点击，' +
    '输入用 action=type_text 且不给控件' +
    (foreground
      ? '。'
      : '。前台操作此刻没有启用，这个窗口点不了也输不了，要用户在设置的「权限 → 电脑控制 → 前台操作」里打开。')
  )
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
 * `type_text` 之后目标控件里有没有这段文字。
 *
 * 判据是「含不含」不是「等不等」：输入落在光标处，控件原本可能已经有内容。
 *
 * 读不回值的目标（窗口本身、不暴露 ValuePattern 的控件）判不了，返回 `unreadable`，
 * **不要按通过算**：输入事件进了系统输入队列不等于目标收下了这段文字，
 * 回执因此只说读不回，由调用方取图核对。
 */
function typedReadback(
  action: DesktopAction,
  target: DesktopElement | undefined,
): 'match' | 'mismatch' | 'unreadable' | null {
  if (action.kind !== 'type_text') return null
  if (target?.value === undefined) return 'unreadable'
  return target.value.includes(action.text) ? 'match' : 'mismatch'
}

/**
 * 三态回执与动作后的新观察合成一个结果。
 *
 * `not_dispatched` 是唯一允许 `executed:false` 的一种；另外两种一律 `executed:true`，
 * 重读缺席也不改这个判定——动作可能已经生效，重发一次等于多做一次。
 *
 * 执行事实与后置条件分列：`dispatch` 说的是事件有没有交给系统，读回说的是目标里现在是
 * 什么，两者可以一个成立一个不成立。
 */
function actOutcome(action: DesktopAction, ref: string, r: DesktopActResult): ToolOutcome {
  const receipt: Record<string, unknown> = { actionId: r.actionId, dispatch: r.dispatch }
  if (r.reason !== undefined) receipt.reason = r.reason
  if (r.dispatch === 'not_dispatched') {
    return {
      status: 'failure',
      executed: false,
      message: `${action.kind} 没有执行：${r.reason ?? '宿主拒绝了这次请求'}`,
      data: receipt,
      errorKind: 'desktop_not_dispatched',
    }
  }
  const unknown = r.dispatch === 'unknown'
  const lead = unknown
    ? `${action.kind} 的结果未知：${r.reason ?? '调用已发出但没有确认'}。`
    : `${action.kind} 已执行。`
  const advice = '先 desktop_observe 确认应用的实际状态，不要重放这个动作。'
  if (r.observation) {
    const target = r.observation.elements.find((e) => e.ref === ref)
    const readback = typedReadback(action, target)
    const mismatch = readback === 'mismatch'
    const failed = unknown || mismatch
    const readbackNote =
      readback === 'mismatch'
        ? '。读回不一致：目标控件里读不到这段文字，按它此刻的内容决定下一步，' +
          '不要重发同一段——重发是在已有内容后面再追加一次'
        : readback === 'unreadable'
          ? '。这个目标读不回控件值，输入结果用 desktop_observe 的 capture 取图核对'
          : ''
    return {
      status: failed ? 'failure' : 'success',
      ...(failed
        ? {
            executed: true,
            errorKind: unknown ? 'desktop_unknown' : 'desktop_readback_mismatch',
          }
        : {}),
      message:
        `${lead}新观察 ${snapshotLine(r.observation)}` +
        (target ? `；目标现在是 ${elementLine(target)}` : '') +
        readbackNote +
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

/** 其余四个工具的目标都是那个窗口。`desktop_windows` 没有窗口可指，见它自己的 spec。 */
function windowTarget(args: Record<string, unknown>): string | null {
  return given(args.windowId) ? String(args.windowId).trim() : null
}

const BASE = {
  category: 'desktop',
  facet: '桌面控件',
  objectLabel: '电脑控制',
  permissionEffect: 'desktop',
} as const

export const desktopWindowsTool: ToolSpec = {
  ...BASE,
  name: 'desktop_windows',
  description:
    '列出本机此刻可操作的顶层窗口。' +
    '**要操作本机上已经开着的应用（聊天、浏览器之外的桌面软件、系统设置）就从这里开始**，' +
    '不要用 run_command 写截图脚本或按坐标点击的脚本——这一组工具直接读控件、采图与投递输入，' +
    '而脚本那条路既看不到控件也拿不到执行事实。' +
    'windowId 是后续观察与动作的唯一入口，由这里给出，无法自己拼出来；' +
    '应用重启或窗口重建之后旧的 windowId 失效，重新调用本工具取新的。' +
    '本工具不截图，也不激活或置前任何窗口。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  actionKind: 'read',
  summary: '列出可操作的桌面窗口',
  targetExtractor: () => '电脑控制',

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
    '回执写着「这个窗口没有暴露可操作的控件」就是自绘界面，' +
    '改用 combined 或 region_image 取图，之后所有动作按图给坐标。' +
    '控件表给出角色、名称、稳定标识、当前值、是否启用，' +
    'actions（每个动作带 delivery 与不可用原因），' +
    '以及控件模式读到的状态：range 数值区间、toggle 复选现态、expand 展开现态、' +
    'selected 这一项选中没有、' +
    'selection 容器的多选与必选约束连同当前选中项的名称 selection.selected——' +
    '收起的组合框也读得到，不用展开它，selection.truncated 为真时名单不是全部；' +
    'scroll 滚动位置百分比、' +
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
      const line =
        `${snapshot.app} · ${snapshot.title || '(无标题)'} · ${snapshotLine(snapshot)}` +
        bareWindowNote(snapshot)
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
  return given(args.around) || given(args.imageRef) || given(args.imageRect)
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
    'delivery=background 的动作经控件接口发出，不动指针、不改焦点、不抢前台；' +
    'delivery=foreground 的动作用真实指针与键盘，会打断用户——' +
    '它们只在用户启用了前台操作时出现在 actions 里，没出现就是没启用，不要改用别的动作代替。' +
    'invoke 调用默认动作（按钮、菜单项）；set_value 写值（空串是清空）；' +
    'set_range_value 按 number 写数值（滑块、微调框），越界与只读一律拒绝；' +
    'select 换成只选这一项，add_to_selection / remove_from_selection 增选与取消，单选容器上不可用；' +
    'set_toggle 按 state 把复选控件设成 off / on / indeterminate——给的是目标态不是切一次；' +
    'expand / collapse 展开或收起菜单、树节点、组合框；' +
    'scroll 按 direction 与 step（line 默认 / page）滚一步；scroll_into_view 把控件滚进可见区；' +
    'realize_item 在虚拟化列表容器上按 itemName 找一项并实例化它，之后重新观察才拿得到它的 ref；' +
    'select_text 按 start 与 length（UTF-16 码元）设选区。' +
    '以下是前台动作：' +
    'click 在控件上点一下，button 选 left / right / middle，count 给 2 就是双击；' +
    'hover 把指针移到控件上；' +
    'drag 从控件按住拖到终点，终点给 toRef（另一个控件）或 dx/dy（相对起点的屏幕像素）；' +
    'wheel 在控件上滚 amount 格，方向由 direction 给；' +
    'type_text 把 text 输进当前持有键盘焦点的控件——它出现在那一个控件的 actions 里，' +
    '要先 click 它取得焦点；' +
    '自绘界面没有这样的控件，那时 type_text 出现在窗口根节点上，' +
    '调用时不给 ref / automationId / name，输入直接投给这个窗口——' +
    '先按图 click 一下输入区把光标放进去，再这样发；' +
    'type_text 的结果按动作后重读的控件值核对：读不到这段文字返回 desktop_readback_mismatch，' +
    '读不回控件值的目标（窗口本身、不暴露值的控件）在回执里说明，改用取图核对；' +
    'press_key 按一个键，key 用 a-z / 0-9 / f1-f24 / ' +
    'enter / tab / escape / space / backspace / delete / insert / home / end / ' +
    'page_up / page_down / up / down / left / right 这些名字，modifiers 给 ctrl / alt / shift / win；' +
    'activate 把窗口切到前台，受系统前台锁限制，被拒时如实返回 not_dispatched；' +
    'set_window_state 按 windowState 设成 normal / minimized / maximized；' +
    'move_window 按 x/y 移动，resize_window 按 width/height 缩放，两者都是屏幕物理像素；' +
    'close_window 请求关闭窗口（不是结束进程），有未保存内容时会弹出提示框，' +
    '那时结果里带 blocking，观察它再由用户或后续判断决定选哪一项。' +
    '指针动作还可以不给控件，改给 imageRef 加 imageX / imageY——' +
    'imageRef 取自上一次 desktop_observe 采图的回执，imageX / imageY 是**那张图里的像素坐标**' +
    '（左上角是 0,0，按回执里 geometry 的 imageWidth × imageHeight 取值），' +
    '不是屏幕坐标、不是百分比，换算与落点归属由服务端与宿主负责核对；' +
    '窗口在采图之后移动过则被拒，重新采图即可。' +
    '目标可以给 ref，也可以给 automationId 或 name（可加 role 收窄）；' +
    '匹配到多个时不执行，结果里按祖先路径列出候选，改用 ref 点名。' +
    '结果里的 dispatch 有三种：not_dispatched 表示没有执行，submitted 表示调用已被系统接受，' +
    'unknown 表示调用已发出但结果无法确认——遇到 unknown 先 desktop_observe 确认实际状态，不要重放。' +
    '动作之后同次带回目标所在子树的新观察与新的 observationId，据此继续下一步，' +
    '不必再调 desktop_observe；子树之外的旧 ref 在新编号下仍然有效。' +
    '动作打开模态对话框时没有新观察，结果里改带 blocking：目标应用此刻的窗口，' +
    'appeared 为真的是这次动作之后冒出来的——直接对它的 windowId 调 desktop_observe。',
  parameters: {
    type: 'object',
    properties: {
      windowId: { type: 'string' },
      observationId: { type: 'string', description: '取自 desktop_observe' },
      action: { type: 'string', enum: ACTIONS },
      ref: {
        type: 'string',
        description: '控件编号，取自同一份观察；type_text / press_key 可以不给，那时目标是窗口',
      },
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
      button: { type: 'string', enum: MOUSE_BUTTONS, description: 'click 按哪个键，默认 left' },
      count: { type: 'integer', description: `click 连点几下，1 或 ${MAX_CLICK_COUNT}，默认 1` },
      amount: { type: 'integer', description: `wheel 滚几格，上限 ${MAX_WHEEL_AMOUNT}，默认 1` },
      toRef: { type: 'string', description: 'drag 的终点控件，取自同一份观察' },
      dx: { type: 'integer', description: 'drag 相对起点的横向屏幕像素' },
      dy: { type: 'integer', description: 'drag 相对起点的纵向屏幕像素' },
      text: { type: 'string', description: `type_text 要输入的文字，上限 ${MAX_TEXT_LENGTH} 字` },
      key: { type: 'string', description: 'press_key 要按的键名' },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: MODIFIERS },
        description: 'press_key 的修饰键',
      },
      windowState: {
        type: 'string',
        enum: WINDOW_STATES,
        description: 'set_window_state 的目标状态',
      },
      x: { type: 'integer', description: 'move_window 的屏幕横坐标' },
      y: { type: 'integer', description: 'move_window 的屏幕纵坐标' },
      width: { type: 'integer', description: 'resize_window 的宽度' },
      height: { type: 'integer', description: 'resize_window 的高度' },
      imageRef: { type: 'string', description: '按图定位：上一次采图返回的 imageRef' },
      imageX: { type: 'integer', description: '按图定位：图像横坐标' },
      imageY: { type: 'integer', description: '按图定位：图像纵坐标' },
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
      // 按图定位没有控件可判：落点归不归目标窗口、前台接管开没开都由宿主在派发前核，
      // 本地只核参数。按控件定位仍然在这里判完再发。
      if (given(args.imageRef)) {
        if (!POINTER_ACTIONS.includes(kind)) {
          throw new ArgError(`${kind} 只能按控件执行，不接受 imageRef`)
        }
        if (given(args.ref) || given(args.automationId) || given(args.name)) {
          throw new ArgError('控件与图像点只能给一个')
        }
        const at = {
          imageRef: str(args.imageRef, 'imageRef'),
          x: bounded(args.imageX, 'imageX', 0, MAX_IMAGE_COORD),
          y: bounded(args.imageY, 'imageY', 0, MAX_IMAGE_COORD),
        }
        const action = buildAction([], pointTarget(), kind, args, TARGET_PARAMS)
        const r = await send(() => desktop.act({ windowId, observationId, at, action }))
        return actOutcome(action, at.imageRef, r)
      }
      const table = desktop.elements(windowId, observationId)
      // 键盘输入不点名控件时目标是窗口本身：观察里窗口根节点上的 type_text /
      // press_key 说的就是「这个窗口此刻收键盘」。点名根节点与不点名是同一件事，
      // 在这里合成同一种请求——两种写法各发一种帧就是两套判定。
      const toWindow = WINDOW_TARGET_ACTIONS.includes(kind)
      const element =
        toWindow && !targetGiven(args) ? windowRoot(table) : resolveTarget(table, args)
      checkPrecondition(element, kind)
      const action = buildAction(table ?? [], element, kind, args, TARGET_PARAMS)

      const byWindow = toWindow && isWindowRoot(element)
      const r = await send(() =>
        desktop.act({
          windowId,
          observationId,
          ...(byWindow ? {} : { ref: element.ref }),
          action,
        }),
      )
      return actOutcome(action, element.ref, r)
    }),
}

/**
 * 按图定位时给 `buildAction` 的替身控件。
 *
 * 它不代表任何真实控件：按图定位时手上没有控件表，而 `buildAction` 的值域与目标态判定
 * 只对按控件定位的动作成立——指针动作一条都不读它。
 */
function pointTarget(): DesktopElement {
  return {
    ref: '',
    depth: 0,
    role: '',
    name: '',
    automationId: '',
    enabled: true,
    offscreen: false,
    actions: [],
  }
}

/** 一步的后置条件，参数按 `until` 收窄。`timeoutMs` 只对有宿主等待的那几种有意义。 */
interface ExpectPlan {
  until: Expectation
  value?: string
  state?: DesktopToggleState
  name?: string
  role?: string
  timeoutMs: number
}

/** 一步解析出来的计划。目标留在 `args` 里，**每一步按轮到它时手上那份控件表解析**。 */
interface StepPlan {
  index: number
  kind: DesktopActionKind
  args: Record<string, unknown>
  expect: ExpectPlan | null
}

/** 一步的回执。`dispatch` 是执行事实，`expect` 是后置条件的判定结果，两者分列。 */
interface StepReceipt {
  index: number
  action: DesktopActionKind
  /** 解析成功时是控件 ref，解析失败时是这一步给的定位条件。 */
  target: string
  actionId?: string
  dispatch: DesktopDispatch
  reason?: string
  expect?: { until: Expectation; met: boolean }
  durationMs: number
}

/** 序列停在哪一步、为什么。`advice` 只有 `unknown` 那一支有。 */
interface Halt {
  index: number
  reason: string
  errorKind: string
  advice?: string
}

/** 动作调用没有带回重读时手上剩下的那点事实。 */
interface Unread {
  blocking?: DesktopBlockingWindowInfo[]
  observationError?: string
}

/**
 * 序列走到此刻的观察。
 *
 * 每一步的动作与等待都换一个观察编号并带回新的控件表，下一步按手上这一份解析目标。
 * `table` 为 `null` 表示这一次没有重读，后面的步骤无从解析，序列到此为止。
 */
interface Cursor {
  observationId: string
  table: DesktopElement[] | null
  last: DesktopSnapshot | null
  unread: Unread
}

/** `unknown` 之后给模型的下一步。与单动作同一句话。 */
const UNKNOWN_ADVICE = '先 desktop_observe 确认应用的实际状态，不要重放这一步。'

/**
 * 把 `steps` 解析成有类型的计划。**一条不合格整组拒绝，一步都不派发。**
 *
 * 目标不在这里解析：第一步之后的控件表由上一步的动作回执带回，解析要用那一份。
 */
function planSteps(raw: unknown): StepPlan[] {
  if (!Array.isArray(raw)) throw new ArgError('steps 必须是数组')
  if (raw.length === 0) throw new ArgError('steps 至少给一步')
  if (raw.length > MAX_STEPS) {
    throw new ArgError(`一次最多 ${MAX_STEPS} 步，给的是 ${raw.length} 步，拆成几次调用。`)
  }
  return raw.map((item, at) => {
    const index = at + 1
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new ArgError(`第 ${index} 步不是一个对象`)
    }
    const args = item as Record<string, unknown>
    const kind = stepKind(args.action, index)
    checkActionParams(kind, args, STEP_PARAMS)
    return { index, kind, args, expect: expectOf(args.expect, index) }
  })
}

/**
 * 这一步的动作。前台动作单独给一句话：它们在 `desktop_act` 上是可用的，
 * 模型要知道换哪个入口，而不只是「这个词不认」。
 */
function stepKind(raw: unknown, index: number): DesktopActionKind {
  const value = String(raw ?? '')
  if (SEQUENCE_ACTIONS.includes(value as DesktopActionKind)) return value as DesktopActionKind
  if (ACTIONS.includes(value as DesktopActionKind)) {
    throw new ArgError(
      `第 ${index} 步的 ${value} 用真实指针或键盘执行，序列不接受，` +
        '它会改变前台与焦点，后面几步的前置条件因此不再成立；用 desktop_act 单独执行它。',
    )
  }
  throw new ArgError(
    `第 ${index} 步的 action 只能是 ${SEQUENCE_ACTIONS.join(' / ')}，收到 ${JSON.stringify(raw)}`,
  )
}

function expectOf(raw: unknown, index: number): ExpectPlan | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArgError(`第 ${index} 步的 expect 不是一个对象`)
  }
  const o = raw as Record<string, unknown>
  const at = `第 ${index} 步的 expect`
  const until = oneOf(o.until, EXPECTATIONS, `${at}.until`)
  const allowed = new Set<string>(['until', ...EXPECT_PARAMS[until]])
  const extra = Object.keys(o).filter((key) => !allowed.has(key) && given(o[key]))
  if (extra.length) throw new ArgError(`${at}.until=${until} 不接受 ${extra.join(' / ')}`)
  if (until === 'value' && (o.value === undefined || o.value === null)) {
    throw new ArgError(`${at}.until=value 必须给 value`)
  }
  if (until === 'appears' && !given(o.name) && !given(o.role)) {
    throw new ArgError(`${at}.until=appears 必须给 name 或 role`)
  }
  return {
    until,
    ...(until === 'value' ? { value: String(o.value) } : {}),
    ...(until === 'toggle' ? { state: oneOf(o.state, TOGGLE_STATES, `${at}.state`) } : {}),
    ...(until === 'appears' && given(o.name) ? { name: str(o.name, `${at}.name`) } : {}),
    ...(until === 'appears' && given(o.role) ? { role: str(o.role, `${at}.role`) } : {}),
    timeoutMs: given(o.timeoutMs)
      ? bounded(o.timeoutMs, `${at}.timeoutMs`, MIN_WAIT_MS, MAX_EXPECT_MS)
      : DEFAULT_EXPECT_MS,
  }
}

/**
 * 后置条件成立没有，判据是**交回模型的那份控件表**。
 *
 * 只有一个判定处：宿主等待只是在有界时间内换一份更新的表，满足与否仍按表读。
 */
function metBy(table: DesktopElement[] | null, ref: string, expect: ExpectPlan): boolean {
  if (!table) return false
  const target = table.find((e) => e.ref === ref)
  switch (expect.until) {
    case 'value':
      return target?.value === expect.value
    case 'toggle':
      return target?.toggle === expect.state
    case 'selected':
      return target?.selected === true
    case 'gone':
      return target === undefined
    case 'appears':
      return table.some((e) => appeared(e, expect))
  }
}

/** `appears` 的匹配：角色相等，名称或稳定标识含那段文字，不分大小写。 */
function appeared(e: DesktopElement, expect: ExpectPlan): boolean {
  if (expect.role !== undefined && e.role !== expect.role) return false
  if (expect.name === undefined) return true
  const needle = expect.name.toLowerCase()
  return e.name.toLowerCase().includes(needle) || e.automationId.toLowerCase().includes(needle)
}

/** 这一步的定位条件，解析失败时的回执按它说得出「是哪一步的哪个目标」。 */
function targetLabel(args: Record<string, unknown>): string {
  if (given(args.ref)) return String(args.ref).trim()
  const query = describeQuery(
    given(args.role) ? String(args.role).trim() : undefined,
    given(args.automationId) ? String(args.automationId).trim() : undefined,
    given(args.name) ? String(args.name).trim() : undefined,
  )
  return query || '(没有给定位条件)'
}

function stepLine(r: StepReceipt): string {
  const fact =
    r.dispatch === 'not_dispatched' ? '没有执行' : r.dispatch === 'unknown' ? '结果未知' : '已执行'
  const expect =
    r.expect === undefined
      ? ''
      : ` · 后置条件 ${r.expect.until} ${r.expect.met ? '已满足' : '未满足'}`
  return (
    `${r.index} ${r.action} ${r.target} ${fact}` +
    (r.reason === undefined ? '' : `：${r.reason}`) +
    expect
  )
}

/** 句末只留一个句号。拒绝原因有的自带句号，有的没有。 */
function sentence(text: string): string {
  return text.endsWith('。') ? text : `${text}。`
}

/** 最后一份观察的那一行。没有重读时改说目标窗口此刻的窗口清单或读不到的原因。 */
function tailLine(last: DesktopSnapshot | null, unread: Unread): string {
  if (last) return `最后观察 ${snapshotLine(last)}`
  const blocking = unread.blocking ?? []
  if (blocking.length) {
    const appearedWindows = blocking.filter((w) => w.appeared)
    const listed = (appearedWindows.length ? appearedWindows : blocking)
      .map((w) => `${w.windowId} ${w.app} ${w.title || '(无标题)'}`)
      .join('；')
    return appearedWindows.length
      ? `目标窗口此刻在响应这次调用，没有重读它。这个应用新出现了窗口：${listed}。对它 desktop_observe 继续。`
      : `目标窗口此刻在响应这次调用，没有重读它。这个应用当前的窗口：${listed}。`
  }
  return `没有取得最后一份观察：${unread.observationError ?? '宿主没有回传动作之后的读数'}`
}

/**
 * 把逐步回执合成一个工具结果。
 *
 * `executed` 与单动作同一条判据：只要有一步的执行事实不是 `not_dispatched`，
 * 这次调用就不是未执行，后缀没做不改变这一点。
 */
function sequenceOutcome(
  plans: StepPlan[],
  done: StepReceipt[],
  halt: Halt | null,
  last: DesktopSnapshot | null,
  unread: Unread,
): ToolOutcome {
  const dispatched = done.filter((r) => r.dispatch !== 'not_dispatched').map((r) => r.index)
  const notExecuted = plans.filter((p) => !dispatched.includes(p.index)).map((p) => p.index)
  const attempted = new Set(done.map((r) => r.index))
  const pending = plans.filter((p) => !attempted.has(p.index))
  const lines = done.map(stepLine)
  const head = halt
    ? `${dispatched.length} 步已派发，${notExecuted.length} 步未执行。`
    : `${plans.length} 步全部执行。`
  const stopped = halt
    ? `停在第 ${halt.index} 步：${sentence(halt.reason)}` +
      (pending.length ? `未执行：${pending.map((p) => `${p.index} ${p.kind}`).join('、')}。` : '') +
      (halt.advice === undefined ? '' : halt.advice)
    : ''
  return {
    status: halt ? 'failure' : 'success',
    executed: dispatched.length > 0,
    message: [head, ...lines, stopped, tailLine(last, unread)].filter(Boolean).join('\n'),
    data: {
      steps: done,
      dispatched,
      notExecuted,
      ...(halt ? { stoppedAt: halt.index, stopReason: halt.reason } : {}),
      ...(last ? { observation: last } : {}),
      ...unread,
    },
    ...(halt ? { errorKind: halt.errorKind } : {}),
  }
}

/** 动作或等待带回的重读接到 `cursor` 上。没有重读时控件表整份作废，序列到此为止。 */
function advance(
  cursor: Cursor,
  follow: DesktopFollowUp & { blocking?: DesktopBlockingWindowInfo[] },
): void {
  if (follow.observation) {
    cursor.observationId = follow.observation.observationId
    cursor.table = follow.observation.elements
    cursor.last = follow.observation
    cursor.unread = {}
    return
  }
  cursor.table = null
  cursor.last = null
  cursor.unread = {
    ...(follow.blocking ? { blocking: follow.blocking } : {}),
    ...(follow.observationError === undefined ? {} : { observationError: follow.observationError }),
  }
}

/**
 * 执行一步，回它的回执与该不该停。
 *
 * 目标解析、前置条件与动作组装都按 `cursor` 手上那份控件表做，与单动作同一套判定。
 * **这里不抛异常**：异常会把已派发的前缀一起丢掉，而那些动作已经发生了。
 */
async function runStep(
  desktop: DesktopPort,
  send: PortCall,
  windowId: string,
  cursor: Cursor,
  plan: StepPlan,
): Promise<{ receipt: StepReceipt; halt: Halt | null }> {
  let element: DesktopElement
  let action: DesktopAction
  // 目标解析成功之后回执改记 ref：前置条件与值域那几条拒绝说的是一个已经定位到的控件。
  let target = targetLabel(plan.args)
  try {
    element = resolveTarget(cursor.table, plan.args)
    target = element.ref
    checkPrecondition(element, plan.kind)
    action = buildAction(cursor.table ?? [], element, plan.kind, plan.args, STEP_PARAMS)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      receipt: {
        index: plan.index,
        action: plan.kind,
        target,
        dispatch: 'not_dispatched',
        reason,
        durationMs: 0,
      },
      halt: { index: plan.index, reason, errorKind: declaredKind(err) ?? 'invalid_argument' },
    }
  }

  const started = Date.now()
  let result: DesktopActResult
  try {
    result = await send(() =>
      desktop.act({ windowId, observationId: cursor.observationId, ref: element.ref, action }),
    )
  } catch (err) {
    // 端口自己声明了执行前拒绝才算没发出去；其余一律按可能已生效收尾。
    const refused = declaredExecuted(err) === false
    const reason = err instanceof Error ? err.message : String(err)
    return {
      receipt: {
        index: plan.index,
        action: plan.kind,
        target: element.ref,
        dispatch: refused ? 'not_dispatched' : 'unknown',
        reason,
        durationMs: Date.now() - started,
      },
      halt: {
        index: plan.index,
        reason,
        errorKind: declaredKind(err) ?? (refused ? 'invalid_argument' : 'desktop_unknown'),
        ...(refused ? {} : { advice: UNKNOWN_ADVICE }),
      },
    }
  }

  const receipt: StepReceipt = {
    index: plan.index,
    action: plan.kind,
    target: element.ref,
    actionId: result.actionId,
    dispatch: result.dispatch,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    durationMs: Date.now() - started,
  }
  advance(cursor, result)
  if (result.dispatch === 'not_dispatched') {
    return {
      receipt,
      halt: {
        index: plan.index,
        reason: result.reason ?? '宿主拒绝了这次请求',
        errorKind: 'desktop_not_dispatched',
      },
    }
  }
  if (result.dispatch === 'unknown') {
    return {
      receipt,
      halt: {
        index: plan.index,
        reason: result.reason ?? '调用已发出但没有确认',
        errorKind: 'desktop_unknown',
        advice: UNKNOWN_ADVICE,
      },
    }
  }
  if (!result.observation) {
    return {
      receipt,
      halt: {
        index: plan.index,
        reason: cursor.unread.blocking
          ? '动作调用还没有返回，目标窗口此刻读不动'
          : `没有取得动作之后的读数：${cursor.unread.observationError}`,
        errorKind: cursor.unread.blocking ? 'desktop_blocked' : 'desktop_observation_unavailable',
      },
    }
  }
  if (!plan.expect) return { receipt, halt: null }

  const settled = await settle(desktop, send, windowId, cursor, element.ref, plan.expect)
  receipt.expect = { until: plan.expect.until, met: settled.met }
  if (settled.met) return { receipt, halt: null }
  return {
    receipt,
    halt: {
      index: plan.index,
      reason:
        settled.error ?? `后置条件 ${plan.expect.until} 在 ${plan.expect.timeoutMs} 毫秒内没有成立`,
      errorKind: 'desktop_postcondition',
    },
  }
}

/**
 * 判这一步的后置条件，必要时在有界时间内等一次。
 *
 * 动作自己带回的那份观察先判一次；不成立且这一种有宿主等待条件时等一次换一份更新的表，
 * 再按同一条判据判。等待发不出去不改变已派发的事实，按未满足收尾。
 */
async function settle(
  desktop: DesktopPort,
  send: PortCall,
  windowId: string,
  cursor: Cursor,
  ref: string,
  expect: ExpectPlan,
): Promise<{ met: boolean; error?: string }> {
  if (metBy(cursor.table, ref, expect)) return { met: true }
  const until = EXPECT_WAITS[expect.until]
  if (!until) return { met: false }
  try {
    const waited = await send(() =>
      desktop.wait({
        windowId,
        observationId: cursor.observationId,
        until,
        ...(until === 'appears' ? {} : { ref }),
        ...(expect.value === undefined ? {} : { value: expect.value }),
        ...(expect.role === undefined ? {} : { role: expect.role }),
        ...(expect.name === undefined ? {} : { query: expect.name }),
        timeoutMs: expect.timeoutMs,
      }),
    )
    advance(cursor, waited)
  } catch (err) {
    return { met: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { met: metBy(cursor.table, ref, expect) }
}

export const desktopActSequenceTool: ToolSpec = {
  ...BASE,
  name: 'desktop_act_sequence',
  description:
    '在同一个窗口上按顺序执行一组已经确定的后台动作，逐项执行、逐项留回执，' +
    `一次最多 ${MAX_STEPS} 步。用它替代连续多次 desktop_act，省的是模型往返，不是核验。` +
    '只接受经控件接口发出的后台动作：' +
    'invoke / set_value / set_range_value / select / add_to_selection / remove_from_selection / ' +
    'set_toggle / expand / collapse / scroll / scroll_into_view / realize_item / select_text。' +
    '参数与 desktop_act 的同名参数一致。' +
    '真实指针与键盘的动作（click、type_text、press_key、close_window 这些）不接受——' +
    '它们每一步都会改变前台与焦点，后面几步的前置条件因此不再成立，用 desktop_act 一次一个。' +
    '每一步的目标给 ref，或给 automationId / name（可加 role 收窄），要求在当时那份控件表里唯一命中；' +
    '第一步按 observationId 那份表解析，之后每一步按上一步动作带回的新观察解析——' +
    '动作只重读目标所在的子树，子树之外的 ref 在新编号下仍然有效，' +
    '目标可能被重建的步骤用 automationId / name 更稳。' +
    '每一步可以给 expect 作为后置条件，不满足即停在这一步：' +
    'until=value 值等于 value，until=toggle 复选态等于 state，until=selected 这一项被选中，' +
    'until=gone 这个控件从树上消失，until=appears 窗口里出现名称含 name（可加 role）的控件。' +
    `value / gone / appears 在有界时间内等（timeoutMs，默认 ${DEFAULT_EXPECT_MS} 毫秒，上限 ${MAX_EXPECT_MS}）；` +
    'toggle 与 selected 按动作自己带回的那份观察判一次，不接受 timeoutMs。' +
    '以下任一条命中即停在该步并放弃后面的步骤：' +
    '某步没有执行（目标歧义、缺失、失效，或前置条件不满足）、结果未知、后置条件没等到、' +
    '动作调用没有返回（弹出模态窗口或新窗口）、本次执行被停止。' +
    '结果里 dispatched 是已派发的步号，notExecuted 是没有执行的步号，两者分开列；' +
    '停下来之后不要重发整组，按回执里最后那份观察重新规划；' +
    '某一步结果未知时先 desktop_observe 确认实际状态，不要重放那一步。',
  parameters: {
    type: 'object',
    properties: {
      windowId: { type: 'string' },
      observationId: { type: 'string', description: '第一步按它那份控件表解析目标' },
      steps: {
        type: 'array',
        description: `按顺序执行的动作，最多 ${MAX_STEPS} 步`,
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: SEQUENCE_ACTIONS },
            ref: { type: 'string', description: '控件编号，取自当时那份观察' },
            automationId: { type: 'string', description: '按稳定标识定位，要求唯一命中' },
            name: { type: 'string', description: '按名称定位，要求唯一命中' },
            role: { type: 'string', description: '与 automationId 或 name 一起收窄匹配' },
            value: { type: 'string', description: 'set_value 要写入的值，空串是清空' },
            number: { type: 'number', description: 'set_range_value 要写入的数值' },
            state: { type: 'string', enum: TOGGLE_STATES, description: 'set_toggle 的目标态' },
            direction: { type: 'string', enum: SCROLL_DIRECTIONS, description: 'scroll 的方向' },
            step: {
              type: 'string',
              enum: SCROLL_STEPS,
              description: 'scroll 一步滚多少，默认 line',
            },
            itemName: { type: 'string', description: 'realize_item 要实例化的那一项的名称' },
            start: { type: 'integer', description: 'select_text 的起点，UTF-16 码元' },
            length: { type: 'integer', description: 'select_text 的长度，UTF-16 码元' },
            expect: {
              type: 'object',
              description: '这一步的后置条件，不满足即停在这一步',
              properties: {
                until: { type: 'string', enum: EXPECTATIONS },
                value: { type: 'string', description: 'until=value 要等到的值' },
                state: {
                  type: 'string',
                  enum: TOGGLE_STATES,
                  description: 'until=toggle 的目标态',
                },
                name: { type: 'string', description: 'until=appears 要出现的控件名称的一段文字' },
                role: { type: 'string', description: 'until=appears 的角色' },
                timeoutMs: {
                  type: 'integer',
                  description: `until=value / gone / appears 最多等多久，上限 ${MAX_EXPECT_MS}`,
                },
              },
              required: ['until'],
              additionalProperties: false,
            },
          },
          required: ['action'],
          additionalProperties: false,
        },
      },
    },
    required: ['windowId', 'observationId', 'steps'],
    additionalProperties: false,
  },
  actionKind: 'call',
  summary: '在一个窗口上按顺序执行一组后台动作',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windowId = str(args.windowId, 'windowId')
      const observationId = str(args.observationId, 'observationId')
      // 参数错在派发之前抛出去，`onDesktop` 记成未执行——此时一帧都还没发。
      const plans = planSteps(args.steps)

      const cursor: Cursor = {
        observationId,
        table: desktop.elements(windowId, observationId),
        last: null,
        unread: {},
      }
      const done: StepReceipt[] = []
      let halt: Halt | null = null

      for (const plan of plans) {
        if (ctx.signal.aborted) {
          halt = { index: plan.index, reason: '本次执行已停止', errorKind: 'aborted' }
          break
        }
        const outcome = await runStep(desktop, send, windowId, cursor, plan)
        done.push(outcome.receipt)
        ctx.emit('progress', `${stepLine(outcome.receipt)}\n`)
        if (outcome.halt) {
          halt = outcome.halt
          break
        }
      }

      return sequenceOutcome(plans, done, halt, cursor.last, cursor.unread)
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
  desktopActSequenceTool,
  desktopWaitTool,
]
