/**
 * 电脑控制的动作表：每种动作接受的参数、目标方式、回执与请求的组装，以及按表进行的参数核对。
 *
 * 新增动作即在 `ACTION_DEFS` 中加入一个条目。`desktop_act` 与 `desktop_act_sequence` 的说明与
 * 参数定义是发给模型的文字，新增的动作或参数在其中另行写明。
 */

import type {
  DesktopAction,
  DesktopActionKind,
  DesktopModifier,
  DesktopMouseButton,
  DesktopScrollDirection,
  DesktopScrollStep,
  DesktopToggleState,
  DesktopWindowState,
} from '@qywork/core'
import type { DesktopElement } from './port.ts'
import { ArgError, blank, bounded, given, oneOf, str } from './shared/args.ts'

/** 选区偏移的取值上界。用于拦截明显越界的请求，实际上界由文档长度决定。 */
const MAX_TEXT_OFFSET = 10_000_000

export const MOUSE_BUTTONS: readonly DesktopMouseButton[] = ['left', 'right', 'middle']
export const MODIFIERS: readonly DesktopModifier[] = ['ctrl', 'alt', 'shift', 'meta']
/** 修饰键参数的说明。`meta` 在三端对应不同的键，说明中写明对应关系。 */
export const MODIFIERS_DESCRIPTION =
  'press_key 的修饰键；meta 是 Windows 徽标键、macOS 的 Command、Linux 的 Super'
export const WINDOW_STATES: readonly DesktopWindowState[] = ['normal', 'minimized', 'maximized']
/** 一次点击的最大连击次数。双击为 2，不支持三击。 */
export const MAX_CLICK_COUNT = 2
/** 一次滚轮操作的最大格数。 */
export const MAX_WHEEL_AMOUNT = 20
/** 一次输入的最大字数。更长的文本分多次发送，接收窗口在中途变化时才能及时停止。 */
export const MAX_TEXT_LENGTH = 4000
/** 拖拽偏移与窗口坐标的取值上界。用于拦截明显越界的请求，实际上界由屏幕与窗口能力决定。 */
const MAX_SCREEN_COORD = 100_000
export const TOGGLE_STATES: readonly DesktopToggleState[] = ['off', 'on', 'indeterminate']
export const SCROLL_DIRECTIONS: readonly DesktopScrollDirection[] = ['up', 'down', 'left', 'right']
export const SCROLL_STEPS: readonly DesktopScrollStep[] = ['line', 'page']

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

/** add_to_selection 与 remove_from_selection 的前置条件：该项所在的选择容器允许多选。 */
function checkMultiSelect(table: DesktopElement[], element: DesktopElement): void {
  const container = selectionContainer(table, element)
  if (container?.selection?.multiple === false) {
    throw new ArgError(
      `${container.ref} 一次只能选择一项，用 action=select 更改选择。`,
      'desktop_precondition',
    )
  }
}

/** expand 与 collapse 的前置条件：控件有可展开的内容，且不处于目标状态 `already`。 */
function checkExpand(element: DesktopElement, already: 'expanded' | 'collapsed'): void {
  if (element.expand === 'leaf') {
    throw new ArgError(`${element.ref} 没有可展开的内容。`, 'desktop_precondition')
  }
  if (element.expand === already) {
    throw new ArgError(`${element.ref} 已是 ${already}，未执行。`, 'desktop_precondition')
  }
}

/** 一种动作的请求对象。 */
type ActionOf<K extends DesktopActionKind> = Extract<DesktopAction, { kind: K }>

/** 写入之后目标控件中的内容与本次写入的关系。 */
type Readback = 'match' | 'mismatch' | 'unreadable'

/**
 * 动作的目标方式。`control` 经控件接口发出；其余三种经指针、键盘或窗口接口发出，
 * 前台操作关闭时在派发前拒绝。
 *
 * - `control`：按控件执行，派发前判定前置条件。
 * - `pointer`：接受图像点作为落点。其余方式不接受图像点：键盘动作省略 ref 时投递给窗口焦点，
 *   其余按控件执行。
 * - `focus`：可以不指定控件、直接投递给窗口。键盘输入的目标是目标窗口内焦点所在的位置，
 *   不是某个被指定的控件。自绘界面不暴露业务控件，无法提供持有焦点的控件；只接受控件等于对这类应用
 *   关闭整条键盘输入路径。
 * - `window`：作用于窗口本身，未指定控件时取窗口根。宿主执行形变动作时需要读取窗口根控件的
 *   显示状态与矩形，因此发出的请求仍带窗口根的 ref，不要改为像键盘动作那样不带 ref 投递给窗口。
 */
type ActionTarget = 'control' | 'pointer' | 'focus' | 'window'

/** 一种动作的定义：参数、目标方式、回执与请求的组装。 */
interface ActionDef<K extends DesktopActionKind> {
  /**
   * 接受的动作参数。提供了不属于该动作的参数即拒绝：静默忽略时，
   * `action=invoke` 附带的 `value` 会被理解为已写入值，而该写入从未发生。
   */
  readonly params: readonly string[]
  readonly target: ActionTarget
  /**
   * 会改变窗口矩形或使窗口消失。序列不接受这类动作。
   *
   * 窗口变化后，控件包围盒与按图定位使用的窗口几何代际一并失效，后续步骤的 `imageRef` 会被
   * 宿主在派发前逐条拒绝。应使用 `desktop_act` 单独执行这些动作，再重新观察。
   */
  readonly windowShape?: true
  /**
   * 回执附带动作后整窗图，与是否按图定位无关。
   *
   * 这些动作的效果只体现在画面上；控件接口类动作有回读与控件变化可以核验，`type_text` 有回读核验。
   * 不要为 `close_window` 与其余改变窗口的动作设置：窗口消失或几何变化后采集失败或没有依据。
   */
  readonly shot?: true
  /** 回执中对落点的称呼，缺省为「落点」。 */
  readonly landingLabel?: string
  /**
   * 写入类动作写入的方式。带有该字段的动作在派发前记录输入框，回执包含输入框的原值。
   *
   * `value` 整体替换控件值，现值已在目标所在行中，单动作回执只补充原值；`text` 插入在光标处，
   * 单动作回执写明输入框的原值与现值。
   */
  readonly input?: 'value' | 'text'
  /**
   * 把模型提供的参数组装为该动作，并按观察中读取的状态判定前置条件。
   *
   * 值域、目标状态与容器约束都在此处判定：观察中已包含 `range` / `toggle` / `expand` /
   * `selection`，本地能够判定的情况不再发送请求换取拒绝。
   */
  build(
    args: Record<string, unknown>,
    element: DesktopElement,
    table: DesktopElement[],
  ): ActionOf<K>
  /** 写入之后的回读核验。`target` 是动作后控件表中实际接收写入的控件，缺失时无法回读。 */
  readback?(action: ActionOf<K>, target: DesktopElement | undefined): Readback
}

/** 每种动作恰好一个条目，缺少或多出种类都无法通过类型检查。条目顺序即 `ACTIONS` 的顺序。 */
export const ACTION_DEFS: { readonly [K in DesktopActionKind]: ActionDef<K> } = {
  invoke: { params: [], target: 'control', build: () => ({ kind: 'invoke' }) },
  set_value: {
    params: ['value'],
    target: 'control',
    input: 'value',
    build(args) {
      // 空串表示清空，只有完全未提供该参数才视为缺失。
      if (args.value === undefined || args.value === null) {
        throw new ArgError('set_value 必须提供 value')
      }
      return { kind: 'set_value', value: String(args.value) }
    },
  },
  set_range_value: {
    params: ['number'],
    target: 'control',
    build(args, element) {
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
      return { kind: 'set_range_value', value }
    },
  },
  select: { params: [], target: 'control', build: () => ({ kind: 'select' }) },
  add_to_selection: {
    params: [],
    target: 'control',
    build(_args, element, table) {
      checkMultiSelect(table, element)
      return { kind: 'add_to_selection' }
    },
  },
  remove_from_selection: {
    params: [],
    target: 'control',
    build(_args, element, table) {
      checkMultiSelect(table, element)
      return { kind: 'remove_from_selection' }
    },
  },
  set_toggle: {
    params: ['state'],
    target: 'control',
    build(args, element) {
      const state = oneOf(args.state, TOGGLE_STATES, 'state')
      if (element.toggle === state) {
        throw new ArgError(`${element.ref} 已是 ${state}，未执行。`, 'desktop_precondition')
      }
      return { kind: 'set_toggle', state }
    },
  },
  expand: {
    params: [],
    target: 'control',
    build(_args, element) {
      checkExpand(element, 'expanded')
      return { kind: 'expand' }
    },
  },
  collapse: {
    params: [],
    target: 'control',
    build(_args, element) {
      checkExpand(element, 'collapsed')
      return { kind: 'collapse' }
    },
  },
  scroll: {
    params: ['direction', 'step'],
    target: 'control',
    build: (args) => ({
      kind: 'scroll',
      direction: oneOf(args.direction, SCROLL_DIRECTIONS, 'direction'),
      step: given(args.step) ? oneOf(args.step, SCROLL_STEPS, 'step') : 'line',
    }),
  },
  scroll_into_view: { params: [], target: 'control', build: () => ({ kind: 'scroll_into_view' }) },
  realize_item: {
    params: ['itemName'],
    target: 'control',
    build: (args) => ({ kind: 'realize_item', name: str(args.itemName, 'itemName') }),
  },
  select_text: {
    params: ['start', 'length'],
    target: 'control',
    build: (args) => ({
      kind: 'select_text',
      start: bounded(args.start, 'start', 0, MAX_TEXT_OFFSET),
      length: bounded(args.length, 'length', 0, MAX_TEXT_OFFSET),
    }),
  },
  click: {
    params: ['button', 'count'],
    target: 'pointer',
    shot: true,
    build: (args) => ({
      kind: 'click',
      button: given(args.button) ? oneOf(args.button, MOUSE_BUTTONS, 'button') : 'left',
      count: given(args.count) ? bounded(args.count, 'count', 1, MAX_CLICK_COUNT) : 1,
    }),
  },
  hover: { params: [], target: 'pointer', shot: true, build: () => ({ kind: 'hover' }) },
  drag: {
    params: ['toRef', 'dx', 'dy'],
    target: 'pointer',
    shot: true,
    // 拖动从落点开始。
    landingLabel: '起点',
    build(args) {
      const byRef = given(args.toRef)
      const byOffset = given(args.dx) || given(args.dy)
      if (byRef && byOffset) throw new ArgError('drag 的终点提供 toRef 或 dx/dy，不能同时提供')
      if (byRef) {
        return { kind: 'drag', to: { kind: 'ref', ref: str(args.toRef, 'toRef') } }
      }
      if (!byOffset) throw new ArgError('drag 必须提供终点：toRef，或 dx 与 dy')
      return {
        kind: 'drag',
        to: {
          kind: 'offset',
          dx: bounded(args.dx ?? 0, 'dx', -MAX_SCREEN_COORD, MAX_SCREEN_COORD),
          dy: bounded(args.dy ?? 0, 'dy', -MAX_SCREEN_COORD, MAX_SCREEN_COORD),
        },
      }
    },
  },
  wheel: {
    params: ['direction', 'amount'],
    target: 'pointer',
    shot: true,
    build: (args) => ({
      kind: 'wheel',
      direction: oneOf(args.direction, SCROLL_DIRECTIONS, 'direction'),
      amount: given(args.amount) ? bounded(args.amount, 'amount', 1, MAX_WHEEL_AMOUNT) : 1,
    }),
  },
  type_text: {
    params: ['text'],
    target: 'focus',
    input: 'text',
    build(args) {
      // 空串没有可输入的内容，与 set_value 的清空含义不同。
      const text = str(args.text, 'text')
      if (text.length > MAX_TEXT_LENGTH) {
        throw new ArgError(`text 最多 ${MAX_TEXT_LENGTH} 个字，收到 ${text.length} 个`)
      }
      return { kind: 'type_text', text }
    },
    /**
     * 目标控件中是否包含输入的文字。
     *
     * 判据是包含而不是相等：输入插入在光标处，控件原本可能已有内容。
     *
     * 无法回读值的目标（窗口本身、不暴露 ValuePattern 的控件）无法判定，返回 `unreadable`，
     * 不要视为通过：字符进入目标的消息队列不等于控件已接收输入的文字，
     * 因此回执只说明无法回读，由调用方采集图像核对。
     */
    readback(action, target) {
      if (target?.value === undefined) return 'unreadable'
      return target.value.includes(action.text) ? 'match' : 'mismatch'
    },
  },
  press_key: {
    params: ['key', 'modifiers'],
    target: 'focus',
    shot: true,
    build: (args) => ({
      kind: 'press_key',
      key: str(args.key, 'key'),
      modifiers: modifiersOf(args.modifiers),
    }),
  },
  activate: { params: [], target: 'window', shot: true, build: () => ({ kind: 'activate' }) },
  set_window_state: {
    params: ['windowState'],
    target: 'window',
    windowShape: true,
    build: (args) => ({
      kind: 'set_window_state',
      state: oneOf(args.windowState, WINDOW_STATES, 'windowState'),
    }),
  },
  move_window: {
    params: ['x', 'y'],
    target: 'window',
    windowShape: true,
    build: (args) => ({
      kind: 'move_window',
      x: bounded(args.x, 'x', -MAX_SCREEN_COORD, MAX_SCREEN_COORD),
      y: bounded(args.y, 'y', -MAX_SCREEN_COORD, MAX_SCREEN_COORD),
    }),
  },
  resize_window: {
    params: ['width', 'height'],
    target: 'window',
    windowShape: true,
    build: (args) => ({
      kind: 'resize_window',
      width: bounded(args.width, 'width', 1, MAX_SCREEN_COORD),
      height: bounded(args.height, 'height', 1, MAX_SCREEN_COORD),
    }),
  },
  close_window: {
    params: [],
    target: 'window',
    windowShape: true,
    build: () => ({ kind: 'close_window' }),
  },
}

/** 全部动作种类，即工具参数 `action` 的取值。 */
export const ACTIONS: readonly DesktopActionKind[] = Object.keys(ACTION_DEFS) as DesktopActionKind[]
/**
 * 序列接受的动作：`windowShape` 以外的全部动作。
 *
 * 包括指针与键盘动作：worker 在每次派发前按目标窗口的投递方式重新准备窗口，因此后续步骤的
 * 前置条件仍然成立。指定控件的 `type_text` 要求该控件持有键盘焦点，焦点由前一步的 click
 * 取得：激活窗口不改变控件焦点。
 */
export const SEQUENCE_ACTIONS: readonly DesktopActionKind[] = ACTIONS.filter(
  (kind) => !ACTION_DEFS[kind].windowShape,
)

/** 按图定位使用的参数。只有指针动作接受这些参数。 */
const POINT_PARAMS = ['imageRef', 'imageX', 'imageY']

/** 取值有限的动作参数及其取值。回执中写明取值，模型无需再查工具定义即可改对。 */
const PARAM_VALUES: Record<string, string> = {
  button: MOUSE_BUTTONS.join(' / '),
  count: `1 或 ${MAX_CLICK_COUNT}`,
  direction: SCROLL_DIRECTIONS.join(' / '),
  step: SCROLL_STEPS.join(' / '),
  state: TOGGLE_STATES.join(' / '),
  windowState: WINDOW_STATES.join(' / '),
}

/** 一个动作的正确写法：它接受的动作参数及取值，指针动作另注明按图定位的参数。 */
function actionUsage(kind: DesktopActionKind): string {
  const params = ACTION_DEFS[kind].params.map((p) =>
    PARAM_VALUES[p] ? `${p}（${PARAM_VALUES[p]}）` : p,
  )
  const own = params.length ? `${kind} 的参数：${params.join('、')}` : `${kind} 没有动作参数`
  return ACTION_DEFS[kind].target === 'pointer'
    ? `${own}；按图定位用 imageRef 与 imageX / imageY`
    : own
}

/**
 * 无法识别的动作名。动作名包含某个动作的全名时（`rightclick`、`double_click` 包含 click），
 * 回执给出该动作及其参数，取包含的最长一个；否则列出全部动作名。
 *
 * 只按「包含全名」匹配，不按相似度推测：推测错误的建议会把模型引向另一个动作。
 */
export function unknownAction(
  raw: unknown,
  allowed: readonly DesktopActionKind[],
  field: string,
): ArgError {
  const flat = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z]/g, '')
  const nearest = allowed
    .filter((kind) => flat.includes(kind.replace(/_/g, '')))
    .sort((a, b) => b.length - a.length)[0]
  return new ArgError(
    nearest
      ? `${field} 没有 ${JSON.stringify(raw)} · 最接近的是 ${nearest}，${actionUsage(nearest)}`
      : `${field} 只能是 ${allowed.join(' / ')}，收到 ${JSON.stringify(raw)}`,
  )
}

export function checkActionParams(
  kind: DesktopActionKind,
  args: Record<string, unknown>,
  target: readonly string[],
): void {
  const allowed = new Set<string>([
    ...target,
    ...(ACTION_DEFS[kind].target === 'pointer' ? POINT_PARAMS : []),
    ...ACTION_DEFS[kind].params,
  ])
  const extra = Object.keys(args).filter(
    (key) => !allowed.has(key) && given(args[key]) && !blank(args[key]),
  )
  if (extra.length) {
    throw new ArgError(`${kind} 不接受 ${extra.join(' / ')} · ${actionUsage(kind)}`)
  }
}

/** 核对该动作接受的参数，再按条目组装动作。 */
export function buildAction(
  table: DesktopElement[],
  element: DesktopElement,
  kind: DesktopActionKind,
  args: Record<string, unknown>,
  target: readonly string[],
): DesktopAction {
  checkActionParams(kind, args, target)
  return ACTION_DEFS[kind].build(args, element, table)
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

/**
 * 写入之后的回读核验，由动作条目的 `readback` 判定；条目不提供时为 `null`。
 *
 * `kind` 与 `action` 分开传入：按泛型 `K` 取出的条目与 `ActionOf<K>` 对应，条目的 `readback`
 * 才能以本种类的请求类型调用。
 */
export function typedReadback<K extends DesktopActionKind>(
  kind: K,
  action: ActionOf<K>,
  target: DesktopElement | undefined,
): Readback | null {
  return ACTION_DEFS[kind].readback?.(action, target) ?? null
}

/** 写入类动作：条目带有 `input` 的动作。它们的回执包含输入框的原值。 */
export function writes(action: DesktopAction): boolean {
  return ACTION_DEFS[action.kind].input !== undefined
}
