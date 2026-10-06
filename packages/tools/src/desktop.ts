/**
 * 电脑控制的五个工具：窗口发现、结构化观察、动作、有限动作序列、等待。
 *
 * 单个动作每次调用发送一条端口命令后即返回，由 Agent 循环决定下一步。序列是同一个
 * `DesktopPort.act` 的有界循环，不重试有副作用的动作：重试一次 invoke 等于在应用中
 * 多提交一次。两者的目标解析与动作组装都经由 `planAct`，只有这一处实现。
 *
 * 六条边界：
 *
 * 1. **端口只从 `ctx.desktop` 取得。** 参数中自报的会话、Run、窗口句柄一概不读取；
 *    模型只持有端口发放的不透明 `windowId`。没有端口时这五个工具不注册
 *    （`index.ts` 按通道注册），工具函数中仍检查一次并如实报错。
 * 2. **动作前的唯一匹配与前置条件在此处判定完毕后再调用端口。** 目标不唯一、控件缺失、
 *    动作不可用、控件被禁用，四种情况都在派发之前作为工具结果返回给模型，
 *    `executed` 为假。
 * 3. **判定依据是产生 `ref` 的那一份观察。** 端口按观察编号返回采集时刻的控件表；
 *    编号失效即要求重新观察，不临时采集一份新表替代：那样模型看到的内容与
 *    判定依据分属两个时刻。
 * 4. **三态回执如实透传。** `not_dispatched` 表示未执行，`submitted` 表示调用已被系统
 *    接受，`unknown` 表示可能已经生效。只有第一种允许 `executed:false`。
 * 5. **歧义只列出候选，不打分。** 同名控件按祖先路径区分，由模型选择；
 *    此处不按顺序、不按相似度代为选择。
 * 6. **序列遇到边界即截断后缀，已派发的前缀如实保留。** 后缀不会被补执行，
 *    前缀不会被重放。
 */

import type {
  DesktopActResult,
  DesktopBlockingWindowInfo,
  DesktopElement,
  DesktopFollowUp,
  DesktopImage,
  DesktopImagePoint,
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
import { type DesktopResultParts, desktopResult, MAX_TITLE_CHARS } from './desktop-results.ts'
import { imageSizeOf, MAX_EDGE, shrinkImage } from './image.ts'

/** 一次读取控件树的节点数上限。端口会再截断一次，此处拦截明显越界的请求。 */
const MAX_NODES = 4000
/** 一次读取控件树的深度上限。 */
const MAX_DEPTH = 40
/** 单次等待的时长上限。超过该值的请求按上限截断。 */
const MAX_WAIT_MS = 60_000
/** 等待时长的下限。更短的请求提高到该值。 */
const MIN_WAIT_MS = 100
/** 调用方未提供时长时的默认等待时长。 */
const DEFAULT_WAIT_MS = 10_000
/** 歧义时返回给模型的候选条数上限。列出完整的长清单对消歧没有帮助。 */
const MAX_CANDIDATES = 10
/** 按控件确定采集区域时向外扩展的像素数上限。扩展过大即接近整窗，不如直接采集整窗。 */
const MAX_PAD = 400
/** 图像坐标的取值上界。图像本身长边不超过 `MAX_EDGE`，该值只用于拦截明显越界的请求。 */
const MAX_IMAGE_COORD = 100_000
/** 一次读取文本最多返回的 UTF-16 码元数。超出即截断并标记。 */
const MAX_TEXT_CHARS = 20_000
/**
 * message 中控件值最多输出的字数。
 *
 * 取 200，与浏览器观察对名称、值的采集上限同一量级。超过时只输出字数：message 与控件表
 * 同时输出同一份长文本会使整条结果超出投递上限，而控件表中已包含该值。
 */
const MAX_LINE_VALUE_CHARS = 200
/** 选区偏移的取值上界。用于拦截明显越界的请求，实际上界由文档长度决定。 */
const MAX_TEXT_OFFSET = 10_000_000
/** 采集模式。`structure` 与 `text` 均不采集图像。 */
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
 * 序列不接受的动作：会改变窗口矩形或使窗口消失的四种动作。
 *
 * 窗口变化后，控件包围盒与按图定位使用的窗口几何代际一并失效，后续步骤的 `imageRef` 会被
 * 宿主在派发前逐条拒绝。应使用 `desktop_act` 单独执行这些动作，再重新观察。
 */
const WINDOW_SHAPE_ACTIONS: readonly DesktopActionKind[] = [
  'set_window_state',
  'move_window',
  'resize_window',
  'close_window',
]
/**
 * 序列接受的动作。
 *
 * 包括指针与键盘动作：worker 在每次派发前把目标窗口切回前台，因此后续步骤的前台前置条件
 * 仍然成立。指定控件的 `type_text` 要求该控件持有键盘焦点，焦点由前一步的 click
 * 取得：激活窗口不改变控件焦点。
 */
const SEQUENCE_ACTIONS: readonly DesktopActionKind[] = ACTIONS.filter(
  (kind) => !WINDOW_SHAPE_ACTIONS.includes(kind),
)
/** 接受图像点作为落点的动作。其余动作不接受图像点：键盘动作省略 ref 时投递给窗口焦点，其余按控件执行。 */
const POINTER_ACTIONS: readonly DesktopActionKind[] = ['click', 'hover', 'drag', 'wheel']
/**
 * 可以不指定控件、直接投递给窗口的动作。
 *
 * 键盘输入的目标是系统焦点所在位置，不是某个被指定的控件。自绘界面不暴露业务控件，
 * 无法提供持有焦点的控件；只接受控件等于对这类应用关闭整条键盘输入路径。
 */
const WINDOW_TARGET_ACTIONS: readonly DesktopActionKind[] = ['type_text', 'press_key']
/** 键盘动作指定了不接受按键的控件或提供了图像点时，回执中指明的替代做法。 */
const TO_FOCUS = '省略 ref 即投递给窗口当前的焦点'
/**
 * 作用于窗口本身的动作：未指定控件时取窗口根。
 *
 * 宿主执行形变动作时需要读取窗口根控件的显示状态与矩形，因此发出的请求仍带窗口根的 ref，
 * 不要改为像键盘动作那样不带 ref 投递给窗口。
 */
const WINDOW_ACTIONS: readonly DesktopActionKind[] = ['activate', ...WINDOW_SHAPE_ACTIONS]
const MOUSE_BUTTONS: readonly DesktopMouseButton[] = ['left', 'right', 'middle']
const MODIFIERS: readonly DesktopModifier[] = ['ctrl', 'alt', 'shift', 'meta']
/** 修饰键参数的说明。`meta` 在三端对应不同的键，说明中写明对应关系。 */
const MODIFIERS_DESCRIPTION =
  'press_key 的修饰键；meta 是 Windows 徽标键、macOS 的 Command、Linux 的 Super'
const WINDOW_STATES: readonly DesktopWindowState[] = ['normal', 'minimized', 'maximized']
/** 一次点击的最大连击次数。双击为 2，不支持三击。 */
const MAX_CLICK_COUNT = 2
/** 一次滚轮操作的最大格数。 */
const MAX_WHEEL_AMOUNT = 20
/** 一次输入的最大字数。更长的文本分多次发送，前台在中途变化时才能及时停止。 */
const MAX_TEXT_LENGTH = 4000
/** 拖拽偏移与窗口坐标的取值上界。用于拦截明显越界的请求，实际上界由屏幕与窗口能力决定。 */
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
/** 这几种条件针对一个已知控件，必须提供 `ref` 或能唯一定位该控件的条件。 */
const REF_CONDITIONS: readonly DesktopWaitCondition[] = ['enabled', 'value', 'gone']

/**
 * 一次序列的最大步数。
 *
 * 整组在同一次桌面占用内执行完毕，期间其他执行者无法进入；每一步还包含一次动作后重读。
 * 十步的占用时长与 `desktop_wait` 单次上限同一量级，更长的操作应改为让模型重新观察。
 */
const MAX_STEPS = 10
/** 单步后置条件的最长等待时间。 */
const MAX_EXPECT_MS = 15_000
/** 调用方未提供时长时，单步后置条件的默认等待时间。 */
const DEFAULT_EXPECT_MS = 3_000
/** 序列中单步的后置条件。 */
const EXPECTATIONS = ['value', 'toggle', 'selected', 'gone', 'appears'] as const
type Expectation = (typeof EXPECTATIONS)[number]
/**
 * 后置条件对应的宿主等待条件。表中缺少的两种没有宿主等待：`toggle` 与 `selected`
 * 经 TogglePattern / SelectionItemPattern 同步写入，按动作自身带回的观察判定一次；
 * 本地不另行轮询，等待判定只在宿主一侧执行。
 */
const EXPECT_WAITS: Partial<Record<Expectation, DesktopWaitCondition>> = {
  value: 'value',
  gone: 'gone',
  appears: 'appears',
}
/** 后置条件接受的参数。提供了不属于该种条件的参数即拒绝，规则同 `ACTION_PARAMS`。 */
const EXPECT_PARAMS: Record<Expectation, readonly string[]> = {
  value: ['value', 'timeoutMs'],
  toggle: ['state'],
  selected: [],
  gone: ['timeoutMs'],
  appears: ['name', 'role', 'timeoutMs'],
}

/**
 * 调用端口之前判定出的参数错误与前置条件不满足。
 *
 * 携带 `errorKind` 是为了与端口的执行前拒绝经由同一出口：两者都是判定而不是故障，
 * 结果中的 `executed` 必须为 `false`。
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
 * 判断该可选参数是否已提供。`null`、空串与字符串 `"null"` 视为未提供，与浏览器工具使用同一判据。
 *
 * 该判据同样用于「不属于本动作的参数」检查，不要在那里改为 `!== undefined`。
 * strict 工具 schema 把每个可选参数都列入 `required` 并在类型中加入 `null`
 * （`packages/ai` 的 `strictify`），模型据此为无关参数逐个填写空值：约束解码的端点填写
 * `null` 与空串，DeepSeek 无论 schema 是否 strict 都会填写字符串 `"null"`。按 `!== undefined`
 * 判断会把一次 `set_value` 附带的约二十个空值全部报告为多余参数，动作始终无法派发。
 *
 * 空串与 `"null"` 在该检查中不构成例外：`value`、`text` 的原文由动作自身的参数表读取，
 * 不经过该判据，输入字面量 null 不受影响。
 */
function given(raw: unknown): boolean {
  if (raw === undefined || raw === null) return false
  const text = String(raw).trim()
  return text !== '' && text.toLowerCase() !== 'null'
}

/** 不属于本动作的参数取 0 与 false 时同样视为空值：它们不表达任何意图。 */
function blank(raw: unknown): boolean {
  return raw === false || String(raw).trim() === '0'
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

/** 先判断有限性再截断：`NaN` 与 `Infinity` 若透传给端口，端口计算出的上限将没有边界。 */
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
  message: '未执行 · 没有电脑控制能力',
  errorKind: 'unsupported',
} as const

const STOPPED = {
  status: 'failure',
  executed: false,
  message: '未执行 · 本次执行已停止',
  errorKind: 'aborted',
} as const

/** 封装端口调用，并记录调用发生的时刻。 */
type PortCall = <T>(call: () => Promise<T>) => Promise<T>

function declaredKind(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const kind = (err as Error & { errorKind?: unknown }).errorKind
  return typeof kind === 'string' && kind ? kind : undefined
}

/** 端口按 `DesktopRefusal` 声明的执行前拒绝。缺失时按 `send` 是否被调用过判定。 */
function declaredExecuted(err: unknown): boolean | undefined {
  if (!(err instanceof Error)) return undefined
  const executed = (err as Error & { executed?: unknown }).executed
  return typeof executed === 'boolean' ? executed : undefined
}

/**
 * 五个工具共用的前置判定与终态。
 *
 * 停止之后不再发起新动作：正在等待的请求由端口自行拒绝，此处拦截新请求。
 * 异常的 `executed` 优先采用端口自行声明的值，缺失时取决于 `send` 是否被调用过：
 * 否则「参数错误」与「动作已发出但连接中断」会得到相同结果，
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

/**
 * message 中描述一个控件的行。动作回执的目标与歧义候选清单共用该格式。
 *
 * 长值只输出字数，原文不进入 message：原文在同一条结果的控件表中，视图经过裁剪时该控件带有
 * `valueOmittedChars`。回读核验按完整值判定，不读取该行。
 */
function elementLine(e: DesktopElement): string {
  return (
    `${e.ref} ${e.role} ${e.name || '(无名称)'}` +
    (e.automationId ? ` #${e.automationId}` : '') +
    valueLabel(e.value) +
    selectedLabel(e) +
    (e.enabled ? '' : ' 已禁用')
  )
}

function valueLabel(value: string | undefined): string {
  if (value === undefined) return ''
  if (value.length <= MAX_LINE_VALUE_CHARS) return ` = ${JSON.stringify(value)}`
  return ` · 值 ${value.length} 字，见控件表`
}

/** 选择容器当前的选中项。没有选中项时不输出。 */
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
 * 一个控件的祖先路径，由外层向内层书写。
 *
 * 同名控件只能依靠祖先路径区分：两个都名为「保存」的按钮，一个在工具栏中、一个在对话框中。
 * 路径沿 `parentRef` 在同一张控件表中向上查找；父控件不在表中时停止，返回已找到的
 * 部分：观察只读取了一棵子树时，范围根以上的祖先不在表中。
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
 * 歧义回执中的一条候选：控件本身及其祖先路径。
 *
 * 身份不稳定的控件另加说明：应用未提供稳定标识，界面重排后该编号会被拒绝，需要重新观察。
 */
function candidateLine(table: DesktopElement[], e: DesktopElement): string {
  const path = ancestorPath(table, e)
  const weak = e.weakIdentity === true ? ' 身份不稳定' : ''
  return path ? `${elementLine(e)}（位于 ${path}）${weak}` : `${elementLine(e)}${weak}`
}

/**
 * 把模型提供的目标解析为本次观察中唯一的控件。
 *
 * 三种写法：直接提供 `ref`、提供 `automationId`、提供 `name`（可再加 `role` 收窄）。
 * 后两种命中多个即为歧义，不按顺序选择第一个：选错会在错误的控件上执行动作，
 * 且不报错。歧义与缺失都作为工具结果返回给模型，由模型补充条件或重新观察。
 */
function resolveTarget(
  table: DesktopElement[] | null,
  args: Record<string, unknown>,
): DesktopElement {
  if (!table) {
    throw new ArgError('未执行 · 观察已失效 · 先重新观察', 'desktop_observation_stale')
  }
  if (given(args.ref)) {
    const ref = str(args.ref, 'ref')
    const hit = table.find((e) => e.ref === ref)
    if (!hit) {
      throw new ArgError(`未执行 · 本次观察中没有 ${ref} · 先重新观察`, 'desktop_ref_unknown')
    }
    return hit
  }
  const role = given(args.role) ? str(args.role, 'role') : undefined
  const automationId = given(args.automationId) ? str(args.automationId, 'automationId') : undefined
  const name = given(args.name) ? str(args.name, 'name') : undefined
  if (!automationId && !name)
    throw new ArgError('未执行 · 未指定目标 · 需提供 ref、automationId 或 name 之一')
  const hits = table.filter(
    (e) =>
      (automationId === undefined || e.automationId === automationId) &&
      (name === undefined || e.name === name) &&
      (role === undefined || e.role === role),
  )
  const first = hits[0]
  if (!first) {
    throw new ArgError(
      `未执行 · 没有匹配的控件 · ${describeQuery(role, automationId, name)}`,
      'desktop_target_missing',
    )
  }
  if (hits.length > 1) {
    const shown = hits
      .slice(0, MAX_CANDIDATES)
      .map((e) => candidateLine(table, e))
      .join(' · ')
    throw new ArgError(
      `未执行 · ${describeQuery(role, automationId, name)} 匹配 ${hits.length} 个 · ${shown}`,
      'desktop_target_ambiguous',
    )
  }
  return first
}

/** 本次调用是否指定了控件。提供三种定位条件中的任一种即视为已指定。 */
function targetGiven(args: Record<string, unknown>): boolean {
  return given(args.ref) || given(args.automationId) || given(args.name)
}

/**
 * 判断该控件是否为窗口根节点。按端口标记的 `windowRoot` 判定：子树读取的根同样 `depth` 为 0、
 * 没有 `parentRef`，按这两个字段判定会把子树根一并计入。
 */
function isWindowRoot(e: DesktopElement): boolean {
  return e.windowRoot === true
}

/** 观察中的窗口根节点。整窗观察必定包含它；只读取过子树的观察不包含，此时要求重新读取整窗。 */
function windowRoot(table: DesktopElement[] | null): DesktopElement {
  if (!table) {
    throw new ArgError('未执行 · 观察已失效 · 先重新观察', 'desktop_observation_stale')
  }
  const root = table.find(isWindowRoot)
  if (!root) {
    throw new ArgError(
      '未执行 · 本次观察没有窗口根节点 · 先对整窗观察一次',
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
 * 动作前的前置条件：控件已启用、宿主在该控件上实现了该动作，且此刻可以执行。
 *
 * 三条均可在本地判定，判定通过后再发送：发送一次往返得到的是同一条拒绝。宿主一侧仍会判定，
 * 因为控件状态可能在观察与动作之间发生变化。
 */
function checkPrecondition(element: DesktopElement, kind: DesktopActionKind): void {
  if (!element.enabled) {
    throw new ArgError(`${kind} 未执行 · ${element.ref} 已禁用`, 'desktop_precondition')
  }
  const offer = element.actions.find((a) => a.action === kind)
  if (!offer) {
    const usable = element.actions.length ? element.actions.map((a) => a.action).join(' / ') : '无'
    const other =
      WINDOW_TARGET_ACTIONS.includes(kind) && !isWindowRoot(element) ? ` · ${TO_FOCUS}` : ''
    throw new ArgError(
      `${kind} 未执行 · ${element.ref} 不支持 · 可用 ${usable}${other}`,
      'desktop_action_unsupported',
    )
  }
  if (offer.delivery.length === 0) {
    throw new ArgError(
      `${kind} 未执行 · ${element.ref} ${offer.unavailable ?? '此刻不可用'}`,
      'desktop_action_unsupported',
    )
  }
}

/**
 * 该项所在的选择容器。沿 `parentRef` 向上查找第一个带 `selection` 的控件。
 *
 * 未找到时返回 `undefined`：观察只读取了一棵子树时祖先可能不在表中，此时不在本地拦截，交给宿主判定。
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
 * 把模型提供的参数组装为一个动作，并按观察中读取的状态判定前置条件。
 *
 * 值域、目标状态与容器约束都在此处判定：观察中已包含 `range` / `toggle` / `expand` /
 * `selection`，本地能够判定的情况不再发送请求换取拒绝。
 */
/**
 * 每种动作接受的参数。提供了不属于该动作的参数即拒绝：静默忽略时，
 * `action=invoke` 附带的 `value` 会被理解为已写入值，而该写入从未发生。
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

/** 定位目标使用的参数。它们适用于每种动作，不参与动作参数的核对。 */
const TARGET_PARAMS = ['windowId', 'observationId', 'action', 'ref', 'automationId', 'name', 'role']
/** 序列中单步接受的定位参数。窗口与观察编号对整组统一提供，不写在单步中。 */
const STEP_PARAMS = ['action', 'ref', 'automationId', 'name', 'role', 'expect']
/** 按图定位使用的参数。只有指针动作接受这些参数。 */
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
  const extra = Object.keys(args).filter(
    (key) => !allowed.has(key) && given(args[key]) && !blank(args[key]),
  )
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
      // 空串表示清空，只有完全未提供该参数才视为缺失。
      if (args.value === undefined || args.value === null) {
        throw new ArgError('set_value 必须提供 value')
      }
      return { kind, value: String(args.value) }
    }
    case 'set_range_value': {
      const value = Number(args.number)
      if (args.number === undefined || args.number === null || !Number.isFinite(value)) {
        throw new ArgError('set_range_value 必须提供 number')
      }
      const range = element.range
      // 越界时不截断到边界：截断后的值看似合法，但不是调用方要求的值。
      if (range && (value < range.min || value > range.max)) {
        throw new ArgError(
          `${element.ref} 只接受 ${range.min} 到 ${range.max}，收到 ${value}。`,
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
          `${container.ref} 一次只能选择一项，用 action=select 更改选择。`,
          'desktop_precondition',
        )
      }
      return { kind }
    }
    case 'set_toggle': {
      const state = oneOf(args.state, TOGGLE_STATES, 'state')
      if (element.toggle === state) {
        throw new ArgError(`${element.ref} 已是 ${state}，未执行。`, 'desktop_precondition')
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
        throw new ArgError(`${element.ref} 已是 ${already}，未执行。`, 'desktop_precondition')
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
      if (byRef && byOffset) throw new ArgError('drag 的终点提供 toRef 或 dx/dy，不能同时提供')
      if (byRef) {
        return { kind, to: { kind: 'ref', ref: str(args.toRef, 'toRef') } }
      }
      if (!byOffset) throw new ArgError('drag 必须提供终点：toRef，或 dx 与 dy')
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
      // 空串没有可输入的内容，与 set_value 的清空含义不同。
      const text = str(args.text, 'text')
      if (text.length > MAX_TEXT_LENGTH) {
        throw new ArgError(`text 最多 ${MAX_TEXT_LENGTH} 个字，收到 ${text.length} 个`)
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

/** 组合键的修饰键。重复项按首次出现的位置保留一份：同一个键按两次没有额外含义。 */
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

/** 判断该控件是否位于标题栏子树中。沿 `parentRef` 向上查找。 */
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
 * 本次观察中可操作的业务控件数量。
 *
 * 判据只使用观察本身：带可执行的后台动作、不是窗口根，且不在标题栏子树中。标题栏、
 * 系统菜单与最小化 / 最大化 / 关闭由系统绘制，任何顶层窗口都有，计入它们会
 * 把自绘界面判定为结构上可操作。不按应用名判定。
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
 * 控件树上没有任何业务控件的窗口。自绘界面属于此类，只能依据图像按坐标操作。
 *
 * 只在整窗、未截断、未筛选的观察上判定：筛选结果为零个控件与窗口没有控件含义不同，
 * 混为一谈会使一次 `role=button` 的空结果被描述为应用不暴露控件。
 *
 * 这是「是否附图」与「回执是否输出该说明」的共同判据，两处不要各自判定。
 */
function isBareWindow(s: DesktopSnapshot): boolean {
  if (s.truncated || s.filteredBy.length > 0) return false
  if (!s.elements.some(isWindowRoot)) return false
  return operableCount(s.elements) === 0
}

/**
 * 在回执中注明自绘窗口。
 *
 * 前台操作状态由端口读取配置得到，不能从控件是否支持前台动作推断。
 */
function bareWindowNote(s: DesktopSnapshot, foregroundEnabled: boolean): string {
  if (!isBareWindow(s)) return ''
  return ` · 无可操作控件${foregroundEnabled ? '' : ' · 前台操作已关闭'}`
}

/** 一份观察的单行读数：控件数、截断与筛选各说明一次。 */
function snapshotLine(s: DesktopSnapshot): string {
  return (
    `${s.observationId} · ${s.elements.length} 个控件` +
    (s.windowEnabled ? '' : ' · 被模态窗口遮挡') +
    (s.windowCovered ? ' · 窗口被遮挡或已最小化' : '') +
    (s.truncated ? ` · 未读取完整 ${s.truncatedBy.join(' / ')}` : '') +
    (s.filteredBy.length ? ` · 已筛选 ${s.filteredBy.join(' / ')}` : '')
  )
}

/**
 * `type_text` 之后目标控件中是否包含输入的文字。
 *
 * 判据是包含而不是相等：输入插入在光标处，控件原本可能已有内容。
 *
 * 无法回读值的目标（窗口本身、不暴露 ValuePattern 的控件）无法判定，返回 `unreadable`，
 * 不要视为通过：字符进入目标的消息队列不等于控件已接收输入的文字，
 * 因此回执只说明无法回读，由调用方采集图像核对。
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
 * 一次输入实际进入的控件：指定的控件；输入投递给窗口时，是本控件表中持有键盘焦点的
 * 控件（取层级最深者）。未找到时缺失。
 */
function inputField(
  table: DesktopElement[] | null,
  element: DesktopElement | undefined,
): DesktopElement | undefined {
  if (!element) return undefined
  if (!isWindowRoot(element)) return element
  return table?.findLast((e) => e.focused === true && !isWindowRoot(e))
}

/** 回执中一个输入框的值，与 `valueLabel` 使用同一长度规则：超长时只输出字数，原文在控件表中。 */
function fieldValue(value: string | undefined): string {
  if (value === undefined) return '无法回读'
  if (value.length <= MAX_LINE_VALUE_CHARS) return JSON.stringify(value)
  return `${value.length} 字`
}

/** 输入框在输入前后的值：模型据此了解输入之前框中的内容。 */
function fieldLine(ref: string, before: string | undefined, after: string | undefined): string {
  return ` · ${ref} 原值 ${fieldValue(before)} → 现值 ${fieldValue(after)}`
}

/** 写入类动作：`type_text` 与 `set_value`。它们的回执包含输入框的原值。 */
function writes(action: DesktopAction): boolean {
  return action.kind === 'type_text' || action.kind === 'set_value'
}

/** message 中的窗口标题。标题由应用自行报告，长度无上限，超过上限时输出前缀；`data` 中的标题按结果生成的规则处理。 */
function windowTitle(title: string): string {
  if (!title) return '(无标题)'
  return title.length <= MAX_TITLE_CHARS ? title : `${title.slice(0, MAX_TITLE_CHARS)}…`
}

/** 把结果生成返回的字段附加到 `ToolOutcome` 上。没有落盘时不写入 `resources` 键。 */
function delivered(parts: DesktopResultParts): Pick<ToolOutcome, 'message' | 'data' | 'resources'> {
  return {
    message: parts.message,
    data: parts.data,
    ...(parts.resources ? { resources: parts.resources } : {}),
  }
}

/**
 * 把三态回执与动作后的新观察合成为一个结果。
 *
 * `not_dispatched` 是唯一允许 `executed:false` 的状态；另外两种一律 `executed:true`，
 * 重读缺失也不改变该判定：动作可能已经生效，重发一次等于多执行一次。
 *
 * 执行事实与后置条件分别列出：`dispatch` 表示事件是否已交给系统，回读表示目标中当前的
 * 内容，两者可以一个成立而另一个不成立。
 */
function actOutcome(
  ctx: ToolContext,
  action: DesktopAction,
  ref: string,
  r: DesktopActResult,
  field?: DesktopElement,
): ToolOutcome {
  const receipt: Record<string, unknown> = { actionId: r.actionId, dispatch: r.dispatch }
  if (r.reason !== undefined) receipt.reason = r.reason
  if (r.dispatch === 'not_dispatched') {
    const lead = `${action.kind} 未执行 · ${r.reason ?? '宿主拒绝'}`
    const parts = r.observation
      ? delivered(
          desktopResult({
            ctx,
            toolName: 'desktop_act',
            snapshot: r.observation,
            place: 'observation',
            incremental: true,
            receipt,
            targetRef: ref || null,
            lead: `${lead} · ${snapshotLine(r.observation)}`,
          }),
        )
      : {
          message: `${lead}${r.observationError ? ` · ${r.observationError}` : ''}`,
          data: { ...receipt, observationError: r.observationError },
        }
    return {
      status: 'failure',
      executed: false,
      ...parts,
      errorKind: 'desktop_not_dispatched',
    }
  }
  const unknown = r.dispatch === 'unknown'
  const lead = unknown
    ? `${action.kind} 结果未确认 · ${r.reason ?? '调用已发出未确认'}`
    : `${action.kind} 已提交${r.reason === undefined ? '' : ` · ${r.reason}`}`
  if (r.observation) {
    // 目标查找与回读核验按端口返回的完整控件表执行，不使用投递给模型的部分。
    const target = r.observation.elements.find((e) => e.ref === ref)
    const typed = field && r.observation.elements.find((e) => e.ref === field.ref)
    const readback = typedReadback(action, field ? typed : target)
    const failed = unknown || readback === 'mismatch'
    const parts = desktopResult({
      ctx,
      toolName: 'desktop_act',
      snapshot: r.observation,
      place: 'observation',
      incremental: true,
      receipt,
      targetRef: ref || null,
      lead:
        `${lead} · ${snapshotLine(r.observation)}` +
        (target ? ` · 目标 ${elementLine(target)}` : '') +
        // set_value 的现值已在目标所在行中，只补充原值。
        (field && action.kind === 'set_value' ? ` · 原值 ${fieldValue(field.value)}` : '') +
        (field && action.kind === 'type_text'
          ? fieldLine(field.ref, field.value, typed?.value)
          : '') +
        (readback === 'mismatch' ? ' · 回读不一致' : '') +
        (readback === 'unreadable' ? ' · 无法回读控件值' : ''),
    })
    return {
      status: failed ? 'failure' : 'success',
      ...(failed
        ? {
            executed: true,
            errorKind: unknown ? 'desktop_unknown' : 'desktop_readback_mismatch',
          }
        : {}),
      ...delivered(parts),
    }
  }
  // 调用尚未返回：目标窗口此刻无法读取，宿主改为返回窗口清单。下一步观察的是新出现的
  // 窗口，不是目标窗口。
  if (r.blocking) {
    const appeared = r.blocking.filter((w) => w.appeared)
    const listed = (appeared.length ? appeared : r.blocking)
      .map((w) => `${w.windowId} ${w.app} ${w.title || '(无标题)'}`)
      .join(' · ')
    return {
      status: unknown ? 'failure' : 'success',
      ...(unknown ? { executed: true, errorKind: 'desktop_unknown' } : {}),
      message: `${lead} · 调用未返回 · ${appeared.length ? '新窗口' : '当前窗口'} ${listed}`,
      data: { ...receipt, blocking: r.blocking, observationError: r.observationError },
    }
  }
  return {
    status: 'failure',
    executed: true,
    message: `${lead} · 无法读取动作后的控件表 · ${r.observationError}`,
    data: { ...receipt, observationError: r.observationError },
    errorKind: unknown ? 'desktop_unknown' : 'desktop_observation_unavailable',
  }
}

/** 等待结果的投递。等待不派发动作，因此失败一律 `executed:false`。 */
function waitOutcome(
  ctx: ToolContext,
  found: boolean,
  reason: string | undefined,
  ref: string | undefined,
  follow: DesktopFollowUp,
): ToolOutcome {
  // `target_gone`：等待值或可用状态时目标控件已不存在，宿主停止轮询。回执写明原因，不写为超时。
  const gone = !found && reason === 'target_gone'
  const lead = found
    ? '已满足'
    : gone
      ? `未满足 · ${ref ?? '目标控件'} 已不在窗口中，条件不会再成立`
      : `未满足 · ${reason ?? 'timeout'}`
  if (follow.observation) {
    const parts = desktopResult({
      ctx,
      toolName: 'desktop_wait',
      snapshot: follow.observation,
      place: 'observation',
      incremental: true,
      receipt: { found, ...(reason ? { reason } : {}) },
      targetRef: ref ?? null,
      lead: `${lead} · ${snapshotLine(follow.observation)}`,
    })
    return {
      status: found ? 'success' : 'failure',
      ...(found
        ? {}
        : {
            executed: false,
            errorKind: gone ? 'desktop_wait_target_gone' : 'desktop_wait_timeout',
          }),
      ...delivered(parts),
    }
  }
  return {
    status: 'failure',
    executed: false,
    message: `${lead} · 无法读取控件表 · ${follow.observationError}`,
    data: { found, ...(reason ? { reason } : {}), observationError: follow.observationError },
    errorKind: 'desktop_observation_unavailable',
  }
}

/**
 * 把一张图像附加到工具结果的图像通道上。
 *
 * 字节经由 `data.images` 传递，不进入 `message`：模型无法理解 base64 字符串，留在正文中只会按长度计费。
 *
 * 经过 `shrinkImage` 之后按几何核对尺寸：采集端已按 `MAX_EDGE` 缩放，此处预期不修改任何
 * 字节。若实际发生缩放或尺寸不一致，说明几何记录的不是模型看到的图像，按图计算的屏幕
 * 坐标是错误的，此时不提供图像。
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
        `图与几何不一致 · 几何 ${g.imageWidth}×${g.imageHeight} · ` +
        `图 ${size ? `${size.width}×${size.height}` : '无法读取尺寸'}`,
    }
  }
  const hint = image.source === 'print_window' ? ' · 备用方式采集，未重绘的区域为黑色' : ''
  return {
    data: {
      app: image.app,
      title: image.title,
      imageRef: image.imageRef,
      geometry: g,
      source: image.source,
      imageCapturedAt: image.capturedAt,
      images: [{ data: Buffer.from(fit.bytes).toString('base64'), mime: fit.mime }],
    },
    line:
      `${image.imageRef} ${g.imageWidth}×${g.imageHeight} 像素 · ` +
      `屏幕 ${g.screen.x},${g.screen.y} ${g.screen.width}×${g.screen.height} · ` +
      `DPI ${g.dpi}${hint}`,
  }
}

/**
 * 按图定位的动作在回执上附一张动作后的整窗图。
 *
 * 在动作回执返回后立即采集；控件重读不保证异步界面状态已稳定，任务结果仍需依据观察核验。
 * 请求动作或窗口准备使旧观察失效时附图；纯拒绝且旧观察仍有效时不附图。
 * 采集失败不改变动作派发事实。
 */
async function withShot(
  outcome: ToolOutcome,
  refresh: boolean,
  desktop: DesktopPort,
  send: PortCall,
  windowId: string,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (!refresh || ctx.vision === false) return outcome
  const shot = await send(() => desktop.captureImage({ windowId, maxEdge: MAX_EDGE })).then(
    (image) => imagePayload(image),
    (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
  )
  if ('error' in shot) {
    return { ...outcome, message: `${outcome.message} · 未采集到图像 · ${shot.error}` }
  }
  return {
    ...outcome,
    message: `${outcome.message} · ${shot.line}`,
    data: { ...outcome.data, ...shot.data },
  }
}

/** 当前模型不接受图片时的终态。重试必然失败，因此消息中必须给出下一步操作。 */
const NO_VISION = {
  status: 'failure',
  executed: false,
  message: '未执行 · 当前模型不接受图片 · 改用 capture=structure',
  errorKind: 'unsupported',
} as const

/** 按控件确定采集区域：包围盒向外扩展若干像素。 */
function padded(rect: DesktopRect, pad: number): DesktopRect {
  return {
    x: rect.x - pad,
    y: rect.y - pad,
    width: rect.width + pad * 2,
    height: rect.height + pad * 2,
  }
}

/** 其余四个工具的目标均为指定窗口。`desktop_windows` 没有目标窗口，见其自身的 spec。 */
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
    '列出用户桌面上当前打开的顶层窗口。操作本机应用应使用桌面工具，不得通过 run_command 截图或注入鼠标、键盘事件。' +
    'title 为系统窗口标题，可能与当前页面或会话不一致；操作目标应依据最新截图或控件确认。' +
    'windowId 是后续调用的入口，窗口重建后失效。' +
    'foregroundEnabled 是当前前台操作开关；为 false 时只能使用 background 动作，' +
    '需要前台操作的任务应说明限制并等待用户开启，不要重试或更换目标绕过。',
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
          ? `${windows.length} 个窗口 · ${windows.map((w) => `${w.windowId} ${w.app} ${w.title}`).join(' · ')}`
          : '0 个窗口',
        data: { windows, foregroundEnabled: desktop.foregroundEnabled() },
      }
    }),
}

export const desktopObserveTool: ToolSpec = {
  ...BASE,
  name: 'desktop_observe',
  description:
    '观察一个窗口。capture=structure（默认）读取控件表，region_image 采图，combined 两者兼有，text 读取文档文本与选区。' +
    '先用 structure，控件树中未找到目标时才采图。' +
    'capture=text 只读取标有 text:true 的控件；读取容器内部控件用 structure 并将 root 设为容器 ref。' +
    'around、imageRef、imageRect 只用于采图；不采图时省略，必须填写时使用 null，imageRect 不要填 {}。' +
    '控件表提供角色、名称、automationId、value、enabled、depth 与控件状态，includeRect 为真时另提供 rect；' +
    '没有名称、值与状态的 pane / group / custom 容器不列出；' +
    '控件按前序排列，depth 按列出的祖先计算，父控件是前面最近的、depth 小一层的控件；' +
    '每个控件的 actionSet 是 actionSets 的下标，该项按投递方式列出控件此刻可执行的动作：' +
    'background 经控件接口发出，foreground 使用真实指针与键盘，unavailable 是此刻无法执行的动作与原因；' +
    '控件上缺失的 enabled、offscreen、automationId 取 defaults 的值。' +
    '回执中的「无可操作控件」表示自绘界面，本次调用已附带整窗图，动作按图提供坐标，无需再次采图；' +
    '「未读取完整」表示控件树采集不完整，调整 maxNodes 或 maxDepth 后重读；' +
    'foregroundEnabled 表示当前前台操作开关，与控件支持哪些动作分别判断；为 false 时不能激活窗口或注入鼠标与键盘事件。' +
    '「窗口被遮挡或已最小化」时应用可能未提供内部内容；仅在 foregroundEnabled 为 true 且窗口提供 activate 时激活后再观察。' +
    '浏览器自动填充的账号密码在页面上发生点击或按键之前无法读取，输入框 value 为空不代表框中未填写，点击输入框后再读取；' +
    '「已投递 N/M 个控件」表示本次只返回了其中一部分，完整控件表已按结果中的 resource id 保存，' +
    '用 read_resource 读取，无需重读。' +
    '返回的 observationId 与 ref 是 desktop_act 与 desktop_wait 的前提；每次重新观察都会更换 observationId，' +
    'ref 按控件分配，同一个控件在新观察中编号不变；窗口移动后旧 imageRef 失效。',
  parameters: {
    type: 'object',
    properties: {
      windowId: { type: 'string', description: '取自 desktop_windows' },
      capture: { type: 'string', enum: CAPTURES, description: '观察内容，默认 structure' },
      maxNodes: { type: 'integer', description: `最多读取的控件数，上限 ${MAX_NODES}` },
      maxDepth: { type: 'integer', description: `最多读取的层数，上限 ${MAX_DEPTH}` },
      root: {
        type: 'string',
        description: '只读取该控件下的子树，取自上一份观察的 ref；之后的动作按该范围重读',
      },
      role: { type: 'string', description: '结果只列出该角色的控件，其余控件仍在本次观察中' },
      query: {
        type: 'string',
        description: '结果只列出名称、稳定标识或值包含这段文字的控件，其余控件仍在本次观察中',
      },
      includeValue: { type: 'boolean', description: '是否读取控件当前值，默认读取' },
      includeRect: {
        type: 'boolean',
        description:
          '控件表是否包含 rect（屏幕物理像素包围盒），默认不包含；仅在按位置判断布局或计算拖拽偏移时需要',
      },
      includeState: {
        type: 'boolean',
        description: '是否读取 range / toggle / expand / selected / selection / scroll，默认读取',
      },
      observationId: {
        type: 'string',
        description:
          'capture=region_image 使用 around 时必填，capture=text 时必填，取自 desktop_observe',
      },
      ref: {
        type: 'string',
        description: 'capture=text 要读取的控件，取自同一份观察且标有 text:true',
      },
      automationId: { type: 'string', description: 'capture=text 按稳定标识定位，要求唯一命中' },
      name: { type: 'string', description: 'capture=text 按名称定位，要求唯一命中' },
      maxChars: {
        type: 'integer',
        description: `capture=text 最多返回的字数，上限 ${MAX_TEXT_CHARS}`,
      },
      around: { type: 'string', description: '只采集该控件周围的区域，值为控件 ref' },
      pad: { type: 'integer', description: `around 向外扩展的像素数，上限 ${MAX_PAD}` },
      imageRef: { type: 'string', description: '要放大的图像，取自上一次采图' },
      imageRect: {
        type: 'object',
        description: 'imageRef 所指图像中的一块区域，图像坐标；不采图时省略或填 null，不要填 {}',
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
  summary: '读取窗口的控件列表或截取窗口图像',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windowId = str(args.windowId, 'windowId')
      const capture: CaptureMode = given(args.capture)
        ? oneOf(args.capture, CAPTURES, 'capture')
        : 'structure'
      if (capture !== 'region_image' && capture !== 'combined' && framingGiven(args)) {
        throw new ArgError(
          `未执行 · capture=${capture} 不接受采集区域参数 around / imageRef / imageRect；` +
            '不采图时省略这些参数，必须填写时使用 null，imageRect 不要填 {}',
        )
      }
      if (capture === 'text') {
        const observationId = str(args.observationId, 'observationId')
        const elements = desktop.elements(windowId, observationId)
        const element = resolveTarget(elements, args)
        if (element.text !== true) {
          const hint =
            element.value !== undefined
              ? '当前值已在观察的 value 中，空字符串表示值为空'
              : elements?.some((item) => item.parentRef === element.ref)
                ? `要查看内部控件，请用 capture=structure、root=${element.ref} 读取子树`
                : '当前观察也未提供 value，请查看控件表中已有的名称和状态'
          throw new ArgError(
            `未执行 · ${element.ref} 不支持文档文本读取 · ${hint}`,
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
              .map((s) => `${s.start} 起 ${JSON.stringify(s.text)}${s.truncated ? ' 截断' : ''}`)
              .join(' · ')
          : '无'
        return {
          status: 'success',
          message:
            `${element.ref} 文本 ${read.text.length} 字${read.truncated ? ' 截断' : ''}` +
            ` · 选区 ${selection}`,
          data: { ref: element.ref, ...read },
        }
      }
      // combined 的 around 按本次读取的控件表解析：读取控件树会更换观察编号，
      // 用调用方提供的旧编号解析时，依据的是一份已经作废的表。
      if (capture === 'combined' && given(args.observationId)) {
        throw new ArgError('未执行 · capture=combined 不接受 observationId')
      }
      // 不接受图片的模型在采集之前即拒绝：采集模型无法查看的图像需要付出完整的采集与编码开销。
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
        return { status: 'success', message: payload.line, data: payload.data }
      }

      // 参数在交给端口之前解析完毕：解析放入 `send` 的回调中时，一次参数错误会被记为
      // 已交给端口，而这意味着不允许重发。
      const input = {
        windowId,
        ...(given(args.maxNodes)
          ? { maxNodes: bounded(args.maxNodes, 'maxNodes', 1, MAX_NODES) }
          : {}),
        ...(given(args.maxDepth)
          ? { maxDepth: bounded(args.maxDepth, 'maxDepth', 1, MAX_DEPTH) }
          : {}),
        ...(given(args.root) ? { root: str(args.root, 'root') } : {}),
        ...(args.includeValue === false ? { includeValue: false } : {}),
        ...(args.includeState === false ? { includeState: false } : {}),
      }
      const filter =
        given(args.role) || given(args.query)
          ? {
              ...(given(args.role) ? { role: str(args.role, 'role') } : {}),
              ...(given(args.query) ? { query: str(args.query, 'query') } : {}),
            }
          : undefined
      const snapshot = await send(() => desktop.observe(input))
      const line =
        `${snapshot.app} · ${windowTitle(snapshot.title)} · ${snapshotLine(snapshot)}` +
        bareWindowNote(snapshot, desktop.foregroundEnabled())
      // 自绘窗口的 structure 观察直接附带整窗图：控件表中没有任何业务控件，调用方
      // 只能依据图像按坐标操作，两次往返之间没有可执行的判断。判据与「无可操作控件」
      // 说明相同，见 `isBareWindow`。
      const alsoImage = capture === 'combined' || (isBareWindow(snapshot) && ctx.vision !== false)
      const parts = desktopResult({
        ctx,
        toolName: 'desktop_observe',
        snapshot,
        place: 'top',
        targetRef: null,
        ...(filter ? { filter } : {}),
        ...(args.includeRect === true ? { includeRect: true } : {}),
        lead: line,
      })
      if (!alsoImage) {
        return { status: 'success', ...delivered(parts) }
      }
      // 控件表已经取得：图像采集失败时也必须返回控件表，并说明缺少图像的原因。
      const captured = await captureFor(desktop, send, windowId, args, snapshot.elements).then(
        (image) => imagePayload(image),
        (err: unknown) => ({ error: err instanceof Error ? err.message : String(err) }),
      )
      // 图像字节经由 `data.images` 传递，不计入投递上限：它不是文本，也不进入存盘正文。
      if ('error' in captured) {
        return {
          status: 'success',
          ...delivered({
            ...parts,
            message: `${parts.message} · 未采集到图像 · ${captured.error}`,
            data: { ...parts.data, imageError: captured.error },
          }),
        }
      }
      return {
        status: 'success',
        ...delivered({
          ...parts,
          message: `${parts.message} · ${captured.line}`,
          data: { ...parts.data, ...captured.data },
        }),
      }
    }),
}

/** 本次调用是否提供了采集区域参数。提供时要求 capture 不是 structure。 */
function framingGiven(args: Record<string, unknown>): boolean {
  return given(args.around) || given(args.imageRef) || given(args.imageRect)
}

/**
 * 按参数决定采集区域。
 *
 * 三种采集区域互斥：整窗、`around` 加 `pad`、`imageRef` 加 `imageRect`。同时提供后两种时不选择其一，
 * 立即拒绝：选错时采集到的是另一块界面。
 *
 * `fresh` 是本次调用刚读取的控件表，`combined` 传入该表，`region_image` 传入 `null`。
 * `around` 只在本次读取的控件表中解析：`combined` 读取控件树之后旧观察编号已经作废，
 * 用调用方提供的编号解析时，依据的是一份已不存在的表。
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
  if (around && byImage) throw new ArgError('around 与 imageRef 只能提供一个')
  if (around) {
    const ref = str(args.around, 'around')
    const table = fresh ?? desktop.elements(windowId, str(args.observationId, 'observationId'))
    if (!table) {
      throw new ArgError(
        '该观察已经失效，请重新调用 desktop_observe 获取新的 observationId 与 ref。',
        'desktop_observation_stale',
      )
    }
    const element = table.find((e) => e.ref === ref)
    if (!element) {
      throw new ArgError(`该观察中没有 ${ref}。`, 'desktop_ref_unknown')
    }
    const box = element.rect
    if (!box) {
      throw new ArgError(
        `${ref} 没有包围盒，无法确定采集区域；改为采集整窗或更换控件。`,
        'desktop_no_bounds',
      )
    }
    const pad = given(args.pad) ? bounded(args.pad, 'pad', 0, MAX_PAD) : 0
    const region = padded(box, pad)
    return send(() => desktop.captureImage({ windowId, maxEdge: MAX_EDGE, region }))
  }
  if (byImage) {
    const imageRef = str(args.imageRef, 'imageRef')
    const raw = args.imageRect
    if (!raw || typeof raw !== 'object') throw new ArgError('提供 imageRef 时必须提供 imageRect')
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
    '在观察到的控件上执行一个动作，动作与参数取自该控件 actionSet 指向的动作表。' +
    '目标用 ref 指定，或用 automationId / name 指定（可加 role 收窄），要求唯一命中。' +
    '后台动作 invoke / set_value / set_range_value / select / add_to_selection / remove_from_selection / ' +
    'set_toggle / expand / collapse / scroll / scroll_into_view / realize_item / select_text 经控件接口发出。' +
    '前台动作 click / hover / drag / wheel / type_text / press_key / activate / set_window_state / ' +
    'move_window / resize_window / close_window 使用真实输入或窗口接口，要求 foregroundEnabled 为 true。' +
    '为 false 时应说明前台操作已关闭并等待用户开启；动作表中没有某个动作表示该控件不提供它，不能据此推断开关状态。' +
    '恢复或置前窗口直接使用 activate，它会恢复最小化窗口并将其置前；set_window_state 只用于指定窗口状态，不能据此确认窗口已在前台。' +
    'type_text 指定控件时要求该控件此刻持有键盘焦点，先 click 该控件；自绘界面不提供控件，输入投递给窗口。' +
    '指针动作可使用 imageRef 与 imageX / imageY 定位；回执附带操作后的整窗截图，用于核验结果。证据不足或状态尚未确定时，应重新观察。' +
    'dispatch 表示动作派发状态：not_dispatched 未执行，submitted 已提交，unknown 结果未确认。动作提交成功不等于任务完成；结果未确认时应先观察，不得直接重复执行。' +
    '「回读不一致」时同样不要重发同一段文字。' +
    'not_dispatched 只表示请求动作未派发，窗口准备可能已改变界面；有新观察时使用新编号，观察失效时先重新观察。' +
    '动作之后在同一次调用中带回新观察与新的 observationId；弹出新窗口时改为带回 blocking，对新窗口继续观察。' +
    '本工具、desktop_act_sequence 与 desktop_wait 带回的观察在多数控件未变化时只提供变化：' +
    'since 是该窗口上一份整份控件表的 observationId，added 与 changed 整行给出并附带 parentRef，' +
    'removed 是消失的编号；未列出的控件与 since 对应的控件表相同，编号继续有效，下一步动作使用本次结果的 observationId。' +
    '对同一个窗口连续执行多个动作时用 desktop_act_sequence，一次调用执行完毕。',
  parameters: {
    type: 'object',
    properties: {
      windowId: { type: 'string' },
      observationId: { type: 'string', description: '取自 desktop_observe' },
      action: { type: 'string', enum: ACTIONS },
      ref: {
        type: 'string',
        description:
          '控件编号，取自同一份观察；type_text / press_key 省略时投递给窗口当前的焦点，activate 与改变窗口的动作省略时作用于窗口本身',
      },
      automationId: { type: 'string', description: '按稳定标识定位，要求唯一命中' },
      name: { type: 'string', description: '按名称定位，要求唯一命中' },
      role: { type: 'string', description: '与 automationId 或 name 一起收窄匹配' },
      value: { type: 'string', description: 'set_value 要写入的值，空串表示清空' },
      number: { type: 'number', description: 'set_range_value 要写入的数值' },
      state: { type: 'string', enum: TOGGLE_STATES, description: 'set_toggle 的目标态' },
      direction: { type: 'string', enum: SCROLL_DIRECTIONS, description: 'scroll 的方向' },
      step: { type: 'string', enum: SCROLL_STEPS, description: 'scroll 每一步的滚动量，默认 line' },
      itemName: { type: 'string', description: 'realize_item 要实例化的项的名称' },
      start: { type: 'integer', description: 'select_text 的起点，UTF-16 码元' },
      length: { type: 'integer', description: 'select_text 的长度，UTF-16 码元' },
      button: { type: 'string', enum: MOUSE_BUTTONS, description: 'click 使用的鼠标键，默认 left' },
      count: { type: 'integer', description: `click 的连击次数，1 或 ${MAX_CLICK_COUNT}，默认 1` },
      amount: {
        type: 'integer',
        description: `wheel 滚动的格数，上限 ${MAX_WHEEL_AMOUNT}，默认 1`,
      },
      toRef: { type: 'string', description: 'drag 的终点控件，取自同一份观察' },
      dx: { type: 'integer', description: 'drag 相对起点的横向屏幕像素' },
      dy: { type: 'integer', description: 'drag 相对起点的纵向屏幕像素' },
      text: { type: 'string', description: `type_text 要输入的文字，上限 ${MAX_TEXT_LENGTH} 字` },
      key: {
        type: 'string',
        description:
          '键名：a-z / 0-9 / f1-f24 / enter / tab / escape / space / backspace / delete / insert / ' +
          'home / end / page_up / page_down / up / down / left / right',
      },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: MODIFIERS },
        description: MODIFIERS_DESCRIPTION,
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
      imageX: { type: 'integer', description: '按图定位：图内像素横坐标，左上角是 0,0' },
      imageY: { type: 'integer', description: '按图定位：图内像素纵坐标，左上角是 0,0' },
    },
    required: ['windowId', 'observationId', 'action'],
    additionalProperties: false,
  },
  actionKind: 'call',
  summary: '对桌面控件执行语义操作',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windowId = str(args.windowId, 'windowId')
      const observationId = str(args.observationId, 'observationId')
      const kind = oneOf(args.action, ACTIONS, 'action')
      const table = given(args.imageRef) ? null : desktop.elements(windowId, observationId)
      const { aim, action } = planAct(table, kind, args, TARGET_PARAMS, desktop.foregroundEnabled())
      const field = writes(action) ? inputField(table, aim.element) : undefined
      const r = await send(() => desktop.act({ windowId, observationId, ...aim.input, action }))
      const outcome = actOutcome(ctx, action, aim.element?.ref ?? '', r, field)
      if (aim.input.at === undefined) return outcome
      const refresh =
        r.dispatch !== 'not_dispatched' ||
        r.observation !== null ||
        !desktop.elements(windowId, observationId)
      return withShot(outcome, refresh, desktop, send, windowId, ctx)
    }),
}

/**
 * 一次动作的作用目标，以及回执中对该目标的称呼。
 *
 * `input` 中 `ref` 与 `at` 互斥，两者都不带时目标是窗口本身。`element` 是解析得到的
 * 控件，按图定位时缺失：回读核验与后置条件都依赖它，缺少时无法判定。
 */
interface Aim {
  input: { ref?: string; at?: DesktopImagePoint }
  element?: DesktopElement
  label: string
}

/**
 * 解析本次动作的目标并组装动作。单动作与序列的每一步共用此实现。
 *
 * 三种指定方式：`imageRef` 加 `imageX` / `imageY` 表示上一张图像中的一个点，只有指针动作接受；
 * 键盘输入未指定控件时目标是窗口根节点：指定根节点与不指定控件含义相同，在此处合成为
 * 同一种请求，两种写法各发一种帧会形成两套判定；其余按 `ref` / `automationId` / `name`
 * 定位，并在派发前判定一次前置条件。
 *
 * 按图定位时不判定前置条件：此时没有控件，落点是否属于目标窗口、前台操作是否开启，都由宿主在
 * 派发前核对。
 */
function planAct(
  table: DesktopElement[] | null,
  kind: DesktopActionKind,
  args: Record<string, unknown>,
  params: readonly string[],
  foregroundEnabled: boolean,
): { aim: Aim; action: DesktopAction } {
  if (
    !foregroundEnabled &&
    (POINTER_ACTIONS.includes(kind) ||
      WINDOW_TARGET_ACTIONS.includes(kind) ||
      WINDOW_ACTIONS.includes(kind))
  ) {
    throw new ArgError(
      `${kind} 未执行 · 前台操作已关闭 · 用户在设置 → 权限 → 电脑控制开启前台操作后需重新观察；更换 ref 或重试不会启用`,
      'desktop_foreground_disabled',
    )
  }
  if (given(args.imageRef)) {
    if (!POINTER_ACTIONS.includes(kind)) {
      throw new ArgError(
        WINDOW_TARGET_ACTIONS.includes(kind)
          ? `${kind} 不接受 imageRef · ${TO_FOCUS}`
          : `${kind} 只能按控件执行，不接受 imageRef`,
      )
    }
    if (targetGiven(args)) throw new ArgError('控件与图像点只能提供一个')
    const at = {
      imageRef: str(args.imageRef, 'imageRef'),
      x: bounded(args.imageX, 'imageX', 0, MAX_IMAGE_COORD),
      y: bounded(args.imageY, 'imageY', 0, MAX_IMAGE_COORD),
    }
    return {
      aim: { input: { at }, label: `${at.imageRef} ${at.x},${at.y}` },
      action: buildAction([], pointTarget(), kind, args, params),
    }
  }
  const toWindow = WINDOW_TARGET_ACTIONS.includes(kind)
  const onWindow = toWindow || WINDOW_ACTIONS.includes(kind)
  const element = onWindow && !targetGiven(args) ? windowRoot(table) : resolveTarget(table, args)
  checkPrecondition(element, kind)
  const action = buildAction(table ?? [], element, kind, args, params)
  const byWindow = toWindow && isWindowRoot(element)
  return {
    aim: { input: byWindow ? {} : { ref: element.ref }, element, label: element.ref },
    action,
  }
}

/**
 * 按图定位时传给 `buildAction` 的占位控件。
 *
 * 它不代表任何真实控件：按图定位时没有控件表，而 `buildAction` 的值域与目标状态判定
 * 只适用于按控件定位的动作，指针动作不读取其中任何字段。
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

/** 单步的后置条件，参数按 `until` 收窄。`timeoutMs` 只对有宿主等待的几种条件有效。 */
interface ExpectPlan {
  until: Expectation
  value?: string
  state?: DesktopToggleState
  name?: string
  role?: string
  timeoutMs: number
}

/** 单步解析得到的计划。目标保留在 `args` 中，每一步在执行时按当前控件表解析。 */
interface StepPlan {
  index: number
  kind: DesktopActionKind
  args: Record<string, unknown>
  expect: ExpectPlan | null
}

/** 单步的回执。`dispatch` 是执行事实，`expect` 是后置条件的判定结果，两者分别列出。 */
interface StepReceipt {
  index: number
  action: DesktopActionKind
  /** 解析成功时为控件 ref，解析失败时为该步骤提供的定位条件。 */
  target: string
  actionId?: string
  dispatch: DesktopDispatch
  reason?: string
  expect?: { until: Expectation; met: boolean }
  /** 写入类步骤的输入框及其在输入前后的值。 */
  input?: { ref: string; before?: string; after?: string }
  durationMs: number
}

/** 序列停止的步骤与原因。 */
interface Halt {
  index: number
  reason: string
  errorKind: string
}

/** 动作调用未带回重读时仍可用的事实。 */
interface Unread {
  blocking?: DesktopBlockingWindowInfo[]
  observationError?: string
}

/**
 * 序列执行到当前步骤时的观察。
 *
 * 每一步的动作与等待都会更换观察编号并带回新的控件表，下一步按当前这一份解析目标。
 * `table` 为 `null` 表示本次没有重读，后续步骤无法解析，序列在此结束。
 */
interface Cursor {
  observationId: string
  table: DesktopElement[] | null
  last: DesktopSnapshot | null
  unread: Unread
}

/**
 * 把 `steps` 解析为有类型的计划。任一步不合格即整组拒绝，不派发任何一步。
 *
 * 目标不在此处解析：第一步之后的控件表由上一步的动作回执带回，解析必须使用该控件表。
 */
function planSteps(raw: unknown): StepPlan[] {
  if (!Array.isArray(raw)) throw new ArgError('steps 必须是数组')
  if (raw.length === 0) throw new ArgError('steps 至少包含一步')
  if (raw.length > MAX_STEPS) {
    throw new ArgError(`一次最多 ${MAX_STEPS} 步，收到 ${raw.length} 步，拆分为多次调用。`)
  }
  return raw.map((item, at) => {
    const index = at + 1
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new ArgError(`第 ${index} 步不是对象`)
    }
    const args = item as Record<string, unknown>
    const kind = stepKind(args.action, index)
    checkActionParams(kind, args, STEP_PARAMS)
    const expect = expectOf(args.expect, index)
    // 后置条件按控件判定，按图定位的步骤没有控件。
    if (expect && given(args.imageRef)) {
      throw new ArgError(`第 ${index} 步按图定位，没有可判定 expect 的控件`)
    }
    return { index, kind, args, expect }
  })
}

/**
 * 该步骤的动作。窗口形变动作单独给出说明：它们在 `desktop_act` 中可用，
 * 模型需要知道应改用哪个入口，而不只是得知该动作名无法识别。
 */
function stepKind(raw: unknown, index: number): DesktopActionKind {
  const value = String(raw ?? '')
  if (SEQUENCE_ACTIONS.includes(value as DesktopActionKind)) return value as DesktopActionKind
  if (WINDOW_SHAPE_ACTIONS.includes(value as DesktopActionKind)) {
    throw new ArgError(
      `第 ${index} 步的 ${value} 会改变窗口矩形，后续步骤的控件包围盒与 imageRef 随之失效；` +
        '用 desktop_act 单独执行该动作，再重新观察。',
    )
  }
  throw new ArgError(
    `第 ${index} 步的 action 只能是 ${SEQUENCE_ACTIONS.join(' / ')}，收到 ${JSON.stringify(raw)}`,
  )
}

function expectOf(raw: unknown, index: number): ExpectPlan | null {
  if (raw === undefined || raw === null) return null
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ArgError(`第 ${index} 步的 expect 不是对象`)
  }
  const o = raw as Record<string, unknown>
  const at = `第 ${index} 步的 expect`
  const until = oneOf(o.until, EXPECTATIONS, `${at}.until`)
  const allowed = new Set<string>(['until', ...EXPECT_PARAMS[until]])
  const extra = Object.keys(o).filter((key) => !allowed.has(key) && given(o[key]))
  if (extra.length) throw new ArgError(`${at}.until=${until} 不接受 ${extra.join(' / ')}`)
  if (until === 'value' && (o.value === undefined || o.value === null)) {
    throw new ArgError(`${at}.until=value 必须提供 value`)
  }
  if (until === 'appears' && !given(o.name) && !given(o.role)) {
    throw new ArgError(`${at}.until=appears 必须提供 name 或 role`)
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
 * 后置条件是否成立，判据是交给模型的控件表。
 *
 * 只有一处判定：宿主等待只是在有限时间内取得一份更新的表，是否满足仍按表判定。
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

/** `appears` 的匹配：角色相等，名称或稳定标识包含该段文字，不区分大小写。 */
function appeared(e: DesktopElement, expect: ExpectPlan): boolean {
  if (expect.role !== undefined && e.role !== expect.role) return false
  if (expect.name === undefined) return true
  const needle = expect.name.toLowerCase()
  return e.name.toLowerCase().includes(needle) || e.automationId.toLowerCase().includes(needle)
}

/** 该步骤的定位条件，解析失败时回执据此说明是哪一步的哪个目标。 */
function targetLabel(args: Record<string, unknown>): string {
  if (given(args.imageRef)) return String(args.imageRef).trim()
  if (given(args.ref)) return String(args.ref).trim()
  const query = describeQuery(
    given(args.role) ? String(args.role).trim() : undefined,
    given(args.automationId) ? String(args.automationId).trim() : undefined,
    given(args.name) ? String(args.name).trim() : undefined,
  )
  return query || '(未提供定位条件)'
}

function stepLine(r: StepReceipt): string {
  const fact =
    r.dispatch === 'not_dispatched' ? '未执行' : r.dispatch === 'unknown' ? '结果未确认' : '已提交'
  const expect =
    r.expect === undefined
      ? ''
      : ` · 后置条件 ${r.expect.until} ${r.expect.met ? '已满足' : '未满足'}`
  return (
    `${r.index} ${r.action} ${r.target} ${fact}` +
    (r.reason === undefined ? '' : ` · ${r.reason}`) +
    (r.input ? fieldLine(r.input.ref, r.input.before, r.input.after) : '') +
    expect
  )
}

/**
 * 最后一份观察的读数行。
 *
 * 没有重读时分三种情况：调用未返回时输出当前的窗口清单；控件表仍然有效时说明当前编号
 * 仍然有效（第一步即未派发时属于此情况，该步骤未发出任何系统调用）；其余情况说明无法读取的原因。
 */
function tailLine(cursor: Cursor): string {
  if (cursor.last) return `最后观察 ${snapshotLine(cursor.last)}`
  const blocking = cursor.unread.blocking ?? []
  if (blocking.length) {
    const appearedWindows = blocking.filter((w) => w.appeared)
    const listed = (appearedWindows.length ? appearedWindows : blocking)
      .map((w) => `${w.windowId} ${w.app} ${w.title || '(无标题)'}`)
      .join(' · ')
    return `调用未返回 · ${appearedWindows.length ? '新窗口' : '当前窗口'} ${listed}`
  }
  if (cursor.table) return `观察 ${cursor.observationId} 仍然有效`
  return `无法读取最后一份控件表 · ${cursor.unread.observationError ?? '宿主未回传动作之后的观察'}`
}

/**
 * 把逐步回执合成为一个工具结果。
 *
 * `executed` 与单动作使用同一判据：只要有一步的执行事实不是 `not_dispatched`，
 * 本次调用就不是未执行，后缀未执行不改变这一点。
 */
function sequenceOutcome(
  ctx: ToolContext,
  plans: StepPlan[],
  done: StepReceipt[],
  halt: Halt | null,
  cursor: Cursor,
): ToolOutcome {
  const dispatched = done.filter((r) => r.dispatch !== 'not_dispatched').map((r) => r.index)
  const notExecuted = plans.filter((p) => !dispatched.includes(p.index)).map((p) => p.index)
  const attempted = new Set(done.map((r) => r.index))
  const pending = plans.filter((p) => !attempted.has(p.index))
  const lines = done.map(stepLine)
  const head = halt
    ? `${dispatched.length} 步已派发 · ${notExecuted.length} 步未执行`
    : `${plans.length} 步全部提交`
  const stopped = halt
    ? `停在第 ${halt.index} 步 · ${halt.reason}` +
      (pending.length ? ` · 未执行 ${pending.map((p) => `${p.index} ${p.kind}`).join('、')}` : '')
    : ''
  const lead = [head, ...lines, stopped, tailLine(cursor)].filter(Boolean).join('\n')
  const receipt: Record<string, unknown> = {
    steps: done,
    dispatched,
    notExecuted,
    ...(halt ? { stoppedAt: halt.index, stopReason: halt.reason } : {}),
  }
  const status = halt ? 'failure' : 'success'
  // 逐步回执、停止点与 `notExecuted` 原样保留，只有最后一份观察按上限处理。
  if (!cursor.last) {
    return {
      status,
      executed: dispatched.length > 0,
      message: lead,
      data: { ...receipt, ...cursor.unread },
      ...(halt ? { errorKind: halt.errorKind } : {}),
    }
  }
  const parts = desktopResult({
    ctx,
    toolName: 'desktop_act_sequence',
    snapshot: cursor.last,
    place: 'observation',
    incremental: true,
    receipt,
    targetRef: done.at(-1)?.target ?? null,
    lead,
  })
  return {
    status,
    executed: dispatched.length > 0,
    ...delivered(parts),
    ...(halt ? { errorKind: halt.errorKind } : {}),
  }
}

/** 把动作或等待带回的重读写入 `cursor`。没有重读时整份控件表作废，序列在此结束。 */
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
 * 执行一步，返回其回执以及是否应停止。
 *
 * 目标解析、前置条件与动作组装都按 `cursor` 当前的控件表执行，与单动作使用同一套判定。
 * 此处不抛出异常：异常会使已派发前缀的回执一并丢失，而这些动作已经发生。
 */
async function runStep(
  desktop: DesktopPort,
  send: PortCall,
  windowId: string,
  cursor: Cursor,
  plan: StepPlan,
): Promise<{ receipt: StepReceipt; halt: Halt | null }> {
  let aim: Aim
  let action: DesktopAction
  // 目标解析成功之后，回执改为记录解析得到的目标：前置条件与值域相关的拒绝针对的是
  // 已经定位的控件。
  let target = targetLabel(plan.args)
  try {
    const planned = planAct(
      cursor.table,
      plan.kind,
      plan.args,
      STEP_PARAMS,
      desktop.foregroundEnabled(),
    )
    aim = planned.aim
    action = planned.action
    target = aim.label
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

  const field = writes(action) ? inputField(cursor.table, aim.element) : undefined
  const started = Date.now()
  let result: DesktopActResult
  try {
    result = await send(() =>
      desktop.act({ windowId, observationId: cursor.observationId, ...aim.input, action }),
    )
  } catch (err) {
    // 只有端口自行声明执行前拒绝时才视为未发出；其余情况一律按可能已生效收尾。
    const refused = declaredExecuted(err) === false
    const reason = err instanceof Error ? err.message : String(err)
    return {
      receipt: {
        index: plan.index,
        action: plan.kind,
        target: aim.label,
        dispatch: refused ? 'not_dispatched' : 'unknown',
        reason,
        durationMs: Date.now() - started,
      },
      halt: {
        index: plan.index,
        reason,
        errorKind: declaredKind(err) ?? (refused ? 'invalid_argument' : 'desktop_unknown'),
      },
    }
  }

  const receipt: StepReceipt = {
    index: plan.index,
    action: plan.kind,
    target: aim.label,
    actionId: result.actionId,
    dispatch: result.dispatch,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
    durationMs: Date.now() - started,
  }
  if (result.dispatch === 'not_dispatched') {
    // 请求动作未发出，但前台准备可能已改变窗口。是否还能保留旧观察由端口统一判定。
    if (result.observation || !desktop.elements(windowId, cursor.observationId)) {
      advance(cursor, result)
    }
    return {
      receipt,
      halt: {
        index: plan.index,
        reason: result.reason ?? '宿主拒绝',
        errorKind: 'desktop_not_dispatched',
      },
    }
  }
  advance(cursor, result)
  if (field) {
    const after = cursor.table?.find((e) => e.ref === field.ref)?.value
    receipt.input = {
      ref: field.ref,
      ...(field.value === undefined ? {} : { before: field.value }),
      ...(after === undefined ? {} : { after }),
    }
  }
  if (result.dispatch === 'unknown') {
    return {
      receipt,
      halt: {
        index: plan.index,
        reason: result.reason ?? '调用已发出未确认',
        errorKind: 'desktop_unknown',
      },
    }
  }
  if (!result.observation) {
    return {
      receipt,
      halt: {
        index: plan.index,
        reason: cursor.unread.blocking
          ? '调用未返回'
          : `无法读取动作后的控件表 · ${cursor.unread.observationError}`,
        errorKind: cursor.unread.blocking ? 'desktop_blocked' : 'desktop_observation_unavailable',
      },
    }
  }
  // 后置条件按控件判定，按图定位的步骤没有可判定的控件，`planSteps` 已经拦截。
  if (!plan.expect || !aim.element) return { receipt, halt: null }

  const settled = await settle(desktop, send, windowId, cursor, aim.element.ref, plan.expect)
  receipt.expect = { until: plan.expect.until, met: settled.met }
  if (settled.met) return { receipt, halt: null }
  return {
    receipt,
    halt: {
      index: plan.index,
      reason: settled.error ?? `${plan.expect.until} 未满足 · 已等待 ${plan.expect.timeoutMs} 毫秒`,
      errorKind: 'desktop_postcondition',
    },
  }
}

/**
 * 判定该步骤的后置条件，必要时在有限时间内等待一次。
 *
 * 先按动作自身带回的观察判定一次；不成立且该条件有宿主等待时，等待一次以取得更新的表，
 * 再按同一判据判定。等待请求无法发出时不改变已派发的事实，按未满足收尾。
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
    `在同一个窗口上按顺序执行一组动作，一次最多 ${MAX_STEPS} 步，参数与 desktop_act 的同名参数一致；` +
    'set_window_state / move_window / resize_window / close_window 不接受，它们会使后续步骤的 imageRef 失效。' +
    '自绘界面的「点击输入框 → type_text → press_key」这类连续操作使用本工具，一次调用执行完毕。' +
    '第一步按 observationId 对应的控件表解析目标，之后每一步按上一步带回的新观察解析；' +
    '按图定位的步骤使用 imageRef 与 imageX / imageY，序列包含此类步骤时，回执附带操作后的整窗截图，用于核验结果。证据不足或状态尚未确定时，应重新观察。' +
    '全部提交仅表示动作已提交，不代表任务完成；expect 仅表示所指定的后置条件是否满足。' +
    '某步未执行、结果未确认、后置条件未满足、调用未返回或本次执行被停止，即停在该步并放弃后续步骤。' +
    '结果中 dispatched 与 notExecuted 分别列出；停止后按最后一份观察重新规划，不要重发整组。',
  parameters: {
    type: 'object',
    properties: {
      windowId: { type: 'string' },
      observationId: { type: 'string', description: '第一步按该观察的控件表解析目标' },
      steps: {
        type: 'array',
        description: `按顺序执行的动作，最多 ${MAX_STEPS} 步`,
        items: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: SEQUENCE_ACTIONS },
            ref: { type: 'string', description: '控件编号，取自对应时刻的观察' },
            automationId: { type: 'string', description: '按稳定标识定位，要求唯一命中' },
            name: { type: 'string', description: '按名称定位，要求唯一命中' },
            role: { type: 'string', description: '与 automationId 或 name 一起收窄匹配' },
            value: { type: 'string', description: 'set_value 要写入的值，空串表示清空' },
            number: { type: 'number', description: 'set_range_value 要写入的数值' },
            state: { type: 'string', enum: TOGGLE_STATES, description: 'set_toggle 的目标态' },
            direction: { type: 'string', enum: SCROLL_DIRECTIONS, description: 'scroll 的方向' },
            step: {
              type: 'string',
              enum: SCROLL_STEPS,
              description: 'scroll 每一步的滚动量，默认 line',
            },
            itemName: { type: 'string', description: 'realize_item 要实例化的项的名称' },
            start: { type: 'integer', description: 'select_text 的起点，UTF-16 码元' },
            length: { type: 'integer', description: 'select_text 的长度，UTF-16 码元' },
            button: {
              type: 'string',
              enum: MOUSE_BUTTONS,
              description: 'click 使用的鼠标键，默认 left',
            },
            count: {
              type: 'integer',
              description: `click 的连击次数，1 或 ${MAX_CLICK_COUNT}，默认 1`,
            },
            amount: {
              type: 'integer',
              description: `wheel 滚动的格数，上限 ${MAX_WHEEL_AMOUNT}，默认 1`,
            },
            toRef: { type: 'string', description: 'drag 的终点控件，取自对应时刻的观察' },
            dx: { type: 'integer', description: 'drag 相对起点的横向屏幕像素' },
            dy: { type: 'integer', description: 'drag 相对起点的纵向屏幕像素' },
            text: {
              type: 'string',
              description: `type_text 要输入的文字，上限 ${MAX_TEXT_LENGTH} 字`,
            },
            key: {
              type: 'string',
              description:
                '键名：a-z / 0-9 / f1-f24 / enter / tab / escape / space / backspace / delete / ' +
                'insert / home / end / page_up / page_down / up / down / left / right',
            },
            modifiers: {
              type: 'array',
              items: { type: 'string', enum: MODIFIERS },
              description: MODIFIERS_DESCRIPTION,
            },
            imageRef: { type: 'string', description: '按图定位：上一次采图返回的 imageRef' },
            imageX: { type: 'integer', description: '按图定位：图内像素横坐标，左上角是 0,0' },
            imageY: { type: 'integer', description: '按图定位：图内像素纵坐标，左上角是 0,0' },
            expect: {
              type: 'object',
              description: '该步骤的后置条件，不满足即停在该步骤',
              properties: {
                until: {
                  type: 'string',
                  enum: EXPECTATIONS,
                  description:
                    'value 值等于 value，toggle 复选状态等于 state，selected 该项被选中，' +
                    'gone 控件从树上消失，appears 出现名称含 name 的控件',
                },
                value: { type: 'string', description: 'until=value 要等待的值' },
                state: {
                  type: 'string',
                  enum: TOGGLE_STATES,
                  description: 'until=toggle 的目标态',
                },
                name: { type: 'string', description: 'until=appears 要出现的控件名称中的一段文字' },
                role: { type: 'string', description: 'until=appears 的角色' },
                timeoutMs: {
                  type: 'integer',
                  description:
                    `until=value / gone / appears 的最长等待时间，默认 ${DEFAULT_EXPECT_MS} 毫秒，` +
                    `上限 ${MAX_EXPECT_MS}；toggle 与 selected 不接受`,
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
  summary: '在窗口中依次执行一组操作',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windowId = str(args.windowId, 'windowId')
      const observationId = str(args.observationId, 'observationId')
      // 参数错误在派发之前抛出，`onDesktop` 记为未执行：此时尚未发送任何帧。
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

      const outcome = sequenceOutcome(ctx, plans, done, halt, cursor)
      // 该组中有按图定位的步骤，说明调用方依据图像而非控件表：末尾补充一张动作后的
      // 整窗图，判据与单动作相同，见 `withShot`。
      const byImage = plans.some((p) => given(p.args.imageRef))
      const dispatched = done.some((r) => r.dispatch !== 'not_dispatched')
      if (!byImage) return outcome
      const refresh = dispatched || cursor.last !== null || cursor.table === null
      return withShot(outcome, refresh, desktop, send, windowId, ctx)
    }),
}

export const desktopWaitTool: ToolSpec = {
  ...BASE,
  name: 'desktop_wait',
  description:
    '等待一个条件成立，不派发任何动作。enabled / value / gone 针对一个已有控件，指定方式与 desktop_act 相同。' +
    '条件取自已经观察到的内容：确认页面跳转或提交生效，用 gone 等待当前页上刚点击过的按钮或链接消失，' +
    '或用 value 等待地址栏、输入框变为某个值；appears 的 name 只用确定会出现的文字，不按常识推测' +
    '（登录后的链接，有的网站称为「退出」，有的称为「注销」）。推测错误的条件只能等到超时。' +
    '到期如实返回未满足与到期时的控件表。',
  parameters: {
    type: 'object',
    properties: {
      windowId: { type: 'string' },
      observationId: { type: 'string' },
      until: {
        type: 'string',
        enum: WAIT_CONDITIONS,
        description:
          'enabled 控件变为可用，value 控件值变为 value，gone 控件从树上消失，' +
          'appears 窗口中出现满足 role 与 name 的控件，window 出现标题含 name 的新窗口' +
          '（条件满足后先用 desktop_windows 获取该窗口）',
      },
      ref: { type: 'string' },
      automationId: { type: 'string' },
      name: {
        type: 'string',
        description:
          'enabled / value / gone 时按名称定位控件；appears 时是要出现的控件名称中的一段文字，只用确定会出现的；window 时是新窗口标题的子串',
      },
      role: { type: 'string' },
      value: { type: 'string', description: 'until=value 时要等待的值' },
      timeoutMs: {
        type: 'integer',
        description: `最长等待时间，默认 ${DEFAULT_WAIT_MS} 毫秒，上限 ${MAX_WAIT_MS}`,
      },
    },
    required: ['windowId', 'observationId', 'until'],
    additionalProperties: false,
  },
  actionKind: 'read',
  summary: '等待桌面状态满足指定条件',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windowId = str(args.windowId, 'windowId')
      const observationId = str(args.observationId, 'observationId')
      const until = oneOf(args.until, WAIT_CONDITIONS, 'until')
      if (until === 'value' && (args.value === undefined || args.value === null)) {
        throw new ArgError('until=value 必须提供 value')
      }
      if (until === 'window' && !given(args.name)) {
        throw new ArgError('until=window 必须提供 name：要等待的新窗口标题中的一段文字')
      }
      if (until === 'appears' && !given(args.name) && !given(args.role)) {
        throw new ArgError('until=appears 必须提供 name 或 role')
      }
      // 针对已知控件的三种条件先在本地解析为唯一目标；另外两种等待的是尚未出现的控件或窗口。
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
      return waitOutcome(ctx, r.found, r.reason, ref, r)
    }),
}

/** 注册顺序在此处确定，`index.ts` 按通道整组注册或整组不注册。 */
export const desktopTools: ToolSpec[] = [
  desktopWindowsTool,
  desktopObserveTool,
  desktopActTool,
  desktopActSequenceTool,
  desktopWaitTool,
]
