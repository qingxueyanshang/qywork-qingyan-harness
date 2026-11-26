/** `desktop_act`：在窗口上执行一个动作，把三态回执与动作后的观察合成为结果。 */

import type { ToolContext, ToolOutcome, ToolSpec } from '@qywork/agent'
import type { DesktopAction, DesktopActionKind, ToolVerb } from '@qywork/core'
import {
  ACTION_DEFS,
  ACTIONS,
  MAX_CLICK_COUNT,
  MAX_TEXT_LENGTH,
  MAX_WHEEL_AMOUNT,
  MODIFIERS,
  MODIFIERS_DESCRIPTION,
  MOUSE_BUTTONS,
  SCROLL_DIRECTIONS,
  SCROLL_STEPS,
  TOGGLE_STATES,
  typedReadback,
  unknownAction,
  WINDOW_STATES,
  writes,
} from './actions.ts'
import type { DesktopActResult, DesktopElement } from './port.ts'
import { given, str } from './shared/args.ts'
import { delivered, followResult, isBareWindow, withShot } from './shared/delivery.ts'
import { elementLine, fieldLine, fieldValue, snapshotLine } from './shared/lines.ts'
import { actScope, BASE, onDesktop, windowTarget } from './shared/run.ts'
import { type Aim, inputField, landingLine, planAct } from './shared/target.ts'

/** 定位目标使用的参数。它们适用于每种动作，不参与动作参数的核对。 */
const TARGET_PARAMS = ['windowId', 'action', 'ref', 'automationId', 'name', 'role']

/** 工具行的动词。没有对应通用说法的动作（移出选区、加载列表项）显示为「操作」。 */
const ACT_VERBS: Record<DesktopActionKind, ToolVerb> = {
  invoke: '点击',
  set_value: '填写',
  set_range_value: '填写',
  select: '选择',
  add_to_selection: '选择',
  remove_from_selection: '操作',
  set_toggle: '切换',
  expand: '展开',
  collapse: '折叠',
  scroll: '滚动',
  scroll_into_view: '滚动',
  realize_item: '操作',
  select_text: '选择',
  click: '点击',
  hover: '悬停',
  drag: '拖动',
  wheel: '滚动',
  type_text: '输入',
  press_key: '按键',
  activate: '激活',
  set_window_state: '缩放',
  move_window: '拖动',
  resize_window: '缩放',
  close_window: '关闭',
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
  aim: Aim,
  r: DesktopActResult,
  before: readonly DesktopElement[] | null,
  field?: DesktopElement,
): ToolOutcome {
  const ref = aim.element?.ref ?? ''
  const receipt: Record<string, unknown> = { actionId: r.actionId, dispatch: r.dispatch }
  if (r.reason !== undefined) receipt.reason = r.reason
  if (r.dispatch === 'not_dispatched') {
    const lead = `${action.kind} 未执行 · ${r.reason ?? '宿主拒绝'}`
    const parts = r.observation
      ? delivered(
          followResult(ctx, {
            toolName: 'desktop_act',
            snapshot: r.observation,
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
  if (aim.landing) receipt.landing = aim.landing
  const landed = landingLine(action.kind, aim.landing)
  const lead = unknown
    ? `${action.kind} 结果未确认${landed} · ${r.reason ?? '调用已发出未确认'}`
    : `${action.kind} 已提交${landed}${r.reason === undefined ? '' : ` · ${r.reason}`}`
  if (r.observation) {
    // 目标查找与回读核验按端口返回的完整控件表执行，不使用投递给模型的部分。
    const target = r.observation.elements.find((e) => e.ref === ref)
    const typed = field && r.observation.elements.find((e) => e.ref === field.ref)
    const readback = typedReadback(action.kind, action, field ? typed : target)
    const input = ACTION_DEFS[action.kind].input
    const failed = unknown || readback === 'mismatch'
    const parts = followResult(ctx, {
      toolName: 'desktop_act',
      snapshot: r.observation,
      receipt,
      targetRef: ref || null,
      before,
      lead:
        `${lead} · ${snapshotLine(r.observation)}` +
        (target ? ` · 目标 ${elementLine(target)}` : '') +
        // 整体替换的现值已在目标所在行中，只补充原值。
        (field && input === 'value' ? ` · 原值 ${fieldValue(field.value)}` : '') +
        (field && input === 'text' ? fieldLine(field.ref, field.value, typed?.value) : '') +
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
  // 成败只按执行事实判定：已提交即成功。动作后的重读失败只说明控件表已作废，不改变成败；
  // 按 Escape 关闭菜单、关闭窗口之后目标窗口已不存在，重读失败正是动作生效的结果。
  return {
    status: unknown ? 'failure' : 'success',
    ...(unknown ? { executed: true, errorKind: 'desktop_unknown' } : {}),
    message: `${lead} · 无法读取动作后的控件表 · ${r.observationError} · 下一步先重新观察`,
    data: { ...receipt, observationError: r.observationError },
  }
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
    'move_window / resize_window / close_window 使用指针、键盘或窗口接口，要求 foregroundEnabled 为 true；' +
    '指针与键盘动作执行前无需 activate。' +
    'hover 将真实指针移到落点并停留，执行前目标窗口置于前台；悬停时才出现的按钮与菜单项，先 hover 再操作。' +
    '为 false 时用 write_todos 把该项标为 blocked（user_only），由用户开启前台操作；动作表中没有某个动作表示该控件不提供它，不能据此推断开关状态。' +
    '恢复或置前窗口直接使用 activate，它会恢复最小化窗口并将其置前；set_window_state 只用于指定窗口状态，不能据此确认窗口已在前台。' +
    'type_text 指定控件时要求该控件此刻持有键盘焦点，先 click 该控件；自绘界面不提供控件，输入投递给窗口。' +
    '按控件执行的指针动作落在该控件包围盒的中心；控件比其中的可见内容宽时（例如聊天记录中占满整行的一条消息），中心可能是空白处，此时按图像坐标定位到内容上。' +
    '指针动作可使用 imageRef 与 imageX / imageY 定位。指针、按键与激活动作的回执附带操作后的整窗截图，用于核验结果；' +
    '动作后的窗口无可操作控件时，各类动作的回执都附带整窗截图。证据不足或状态尚未确定时，应重新观察。' +
    'dispatch 表示动作派发状态：not_dispatched 未执行，submitted 已提交，unknown 结果未确认。动作提交成功不等于任务完成；结果未确认时应先观察，不得直接重复执行。' +
    '「回读不一致」时同样不要重发同一段文字。' +
    'not_dispatched 只表示请求动作未派发，窗口准备可能已改变界面；有新观察时使用新编号，观察失效时先重新观察。' +
    '动作之后在同一次调用中带回新观察；弹出新窗口时改为带回 blocking，对新窗口继续观察。' +
    '本工具、desktop_act_sequence 与 desktop_wait 带回的观察在多数控件未变化时只提供变化，无可操作控件的窗口除外：' +
    'since 是该窗口上一份整份控件表的 observationId，added 与 changed 整行给出并附带 parentRef，' +
    'removed 是消失的编号；未列出的控件与 since 对应的控件表相同，编号继续有效。' +
    '对同一个窗口连续执行多个动作时用 desktop_act_sequence，一次调用执行完毕。',
  parameters: {
    type: 'object',
    properties: {
      windowId: { type: 'string' },
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
      button: {
        type: 'string',
        enum: MOUSE_BUTTONS,
        description: 'click 使用的鼠标键，默认 left；右键点击为 action=click、button=right',
      },
      count: {
        type: 'integer',
        description: `click 的连击次数，1 或 ${MAX_CLICK_COUNT}，默认 1；双击为 2`,
      },
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
    required: ['windowId', 'action'],
    additionalProperties: false,
  },
  verb: (args) => ACT_VERBS[args.action as DesktopActionKind] ?? '操作',
  object: (args) => {
    const action = args.action as DesktopActionKind
    if (action === 'type_text' && typeof args.text === 'string') return `「${args.text}」`
    if (action === 'press_key' && typeof args.key === 'string') return args.key
    if (ACTION_DEFS[action]?.target === 'window') return '窗口'
    return typeof args.name === 'string' && args.name.trim() ? `「${args.name.trim()}」` : '控件'
  },
  summary: '对桌面控件执行语义操作',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windowId = str(args.windowId, 'windowId')
      if (!ACTIONS.includes(args.action as DesktopActionKind)) {
        throw unknownAction(args.action, ACTIONS, 'action')
      }
      const kind = args.action as DesktopActionKind
      const before = desktop.elements(windowId)
      const table = given(args.imageRef) ? null : before
      const { aim, action } = planAct(table, kind, args, TARGET_PARAMS, desktop.foregroundEnabled())
      const field = writes(action) ? inputField(table, aim.element) : undefined
      const r = await send(() => desktop.act({ windowId, ...aim.input, action, ...actScope(ctx) }))
      const outcome = actOutcome(ctx, action, aim, r, before, field)
      const bare = r.observation ? isBareWindow(r.observation) : false
      if (aim.input.at === undefined && !ACTION_DEFS[kind].shot && !bare) return outcome
      const refresh =
        r.dispatch !== 'not_dispatched' || r.observation !== null || !desktop.elements(windowId)
      return withShot(outcome, refresh, desktop, send, windowId, ctx)
    }),
}
