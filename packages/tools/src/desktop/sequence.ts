/**
 * `desktop_act_sequence`：在同一个窗口上依次执行有限个动作。每一步按上一步带回的观察解析目标，
 * 判定后置条件，遇到边界即停止并保留已派发的前缀。
 */

import type { ToolContext, ToolOutcome, ToolSpec } from '@qywork/agent'
import type {
  DesktopAction,
  DesktopActionKind,
  DesktopDispatch,
  DesktopToggleState,
} from '@qywork/core'
import {
  ACTION_DEFS,
  ACTIONS,
  checkActionParams,
  MAX_CLICK_COUNT,
  MAX_TEXT_LENGTH,
  MAX_WHEEL_AMOUNT,
  MODIFIERS,
  MODIFIERS_DESCRIPTION,
  MOUSE_BUTTONS,
  SCROLL_DIRECTIONS,
  SCROLL_STEPS,
  SEQUENCE_ACTIONS,
  TOGGLE_STATES,
  unknownAction,
  writes,
} from './actions.ts'
import type {
  DesktopActResult,
  DesktopBlockingWindowInfo,
  DesktopElement,
  DesktopFollowUp,
  DesktopPort,
  DesktopSnapshot,
  DesktopWaitCondition,
} from './port.ts'
import { ArgError, blank, bounded, given, oneOf, str } from './shared/args.ts'
import { delivered, followResult, isBareWindow, withShot } from './shared/delivery.ts'
import { fieldLine, snapshotLine } from './shared/lines.ts'
import {
  actScope,
  BASE,
  declaredExecuted,
  declaredKind,
  onDesktop,
  type PortCall,
  windowTarget,
} from './shared/run.ts'
import {
  type Aim,
  describeQuery,
  inputField,
  type Landing,
  landingLine,
  planAct,
} from './shared/target.ts'
import { MIN_WAIT_MS } from './wait.ts'

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
/** 后置条件接受的参数。提供了不属于该种条件的参数即拒绝，规则同动作条目的 `params`。 */
const EXPECT_PARAMS: Record<Expectation, readonly string[]> = {
  value: ['value', 'timeoutMs'],
  toggle: ['state'],
  selected: [],
  gone: ['timeoutMs'],
  appears: ['name', 'role', 'timeoutMs'],
}

/** 序列中单步接受的定位参数。窗口与观察编号对整组统一提供，不写在单步中。 */
const STEP_PARAMS = ['action', 'ref', 'automationId', 'name', 'role', 'expect']

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
  /** 按控件执行的指针步骤的落点与控件尺寸，只在动作已发出时记录。 */
  landing?: Landing
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
 * 每一步的动作与等待都会带回新的控件表，下一步按当前这一份解析目标。
 * `table` 为 `null` 表示本次没有重读，后续步骤无法解析，序列在此结束。
 */
interface Cursor {
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
 * 模型需要得知应改用哪个入口，而不只是得知该动作名无法识别。
 */
function stepKind(raw: unknown, index: number): DesktopActionKind {
  const value = String(raw ?? '')
  if (SEQUENCE_ACTIONS.includes(value as DesktopActionKind)) return value as DesktopActionKind
  if (
    ACTIONS.includes(value as DesktopActionKind) &&
    ACTION_DEFS[value as DesktopActionKind].windowShape
  ) {
    throw new ArgError(
      `第 ${index} 步的 ${value} 会改变窗口矩形，后续步骤的控件包围盒与 imageRef 随之失效；` +
        '用 desktop_act 单独执行该动作，再重新观察。',
    )
  }
  throw unknownAction(raw, SEQUENCE_ACTIONS, `第 ${index} 步的 action`)
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
  // 空值判据与动作参数相同（`checkActionParams`）：取 0 与 false 的参数不表达任何意图。
  const extra = Object.keys(o).filter((key) => !allowed.has(key) && given(o[key]) && !blank(o[key]))
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
    landingLine(r.action, r.landing) +
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
  if (cursor.table) return '控件表仍然有效'
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
  before: readonly DesktopElement[] | null,
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
  const parts = followResult(ctx, {
    toolName: 'desktop_act_sequence',
    snapshot: cursor.last,
    receipt,
    targetRef: done.at(-1)?.target ?? null,
    before,
    lead,
  })
  return {
    status,
    executed: dispatched.length > 0,
    ...delivered(parts),
    ...(halt ? { errorKind: halt.errorKind } : {}),
  }
}

/**
 * 上一步之后没有可用的控件表时的停止点。
 *
 * 在下一步开始前判定，而不是在产生它的那一步判定：那一步已经提交，是否失败只取决于执行事实；
 * 无法继续的是其后的步骤。最后一步之后没有重读不构成失败。
 */
function unreadHalt(index: number, cursor: Cursor): Halt {
  const blocked = cursor.unread.blocking !== undefined
  return {
    index,
    reason: blocked
      ? '调用未返回'
      : `无法读取动作后的控件表 · ${cursor.unread.observationError ?? '宿主未回传动作之后的观察'}`,
    errorKind: blocked ? 'desktop_blocked' : 'desktop_observation_unavailable',
  }
}

/** 把动作或等待带回的重读写入 `cursor`。没有重读时整份控件表作废，序列在下一步之前结束。 */
function advance(
  cursor: Cursor,
  follow: DesktopFollowUp & { blocking?: DesktopBlockingWindowInfo[] },
): void {
  if (follow.observation) {
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
  scope: ReturnType<typeof actScope>,
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
    result = await send(() => desktop.act({ windowId, ...aim.input, action, ...scope }))
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
    ...(aim.landing && result.dispatch !== 'not_dispatched' ? { landing: aim.landing } : {}),
    durationMs: Date.now() - started,
  }
  if (result.dispatch === 'not_dispatched') {
    // 请求动作未发出，但前台准备可能已改变窗口。是否还能保留旧观察由端口统一判定。
    if (result.observation || !desktop.elements(windowId)) {
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
  // 后置条件按控件判定，按图定位的步骤没有可判定的控件，`planSteps` 已经拦截。
  if (!plan.expect || !aim.element) return { receipt, halt: null }
  // 后置条件需要动作后的控件表；没有重读时无法核验，按未满足停止。
  if (!result.observation) return { receipt, halt: unreadHalt(plan.index, cursor) }

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
    '第一步按本轮对该窗口最近一份观察解析目标，之后每一步按上一步带回的新观察解析；' +
    '按图定位的步骤使用 imageRef 与 imageX / imageY。序列包含按图定位的步骤、已执行指针、按键与激活动作，' +
    '或最后一份观察中的窗口无可操作控件时，回执附带操作后的整窗截图，用于核验结果。证据不足或状态尚未确定时，应重新观察。' +
    '全部提交仅表示动作已提交，不代表任务完成；expect 仅表示所指定的后置条件是否满足。' +
    '某步未执行、结果未确认、后置条件未满足、调用未返回或本次执行被停止，即停在该步并放弃后续步骤。' +
    '结果中 dispatched 与 notExecuted 分别列出；停止后按最后一份观察重新规划，不要重发整组。',
  parameters: {
    type: 'object',
    properties: {
      windowId: { type: 'string' },
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
    required: ['windowId', 'steps'],
    additionalProperties: false,
  },
  actionKind: 'call',
  summary: '在窗口中依次执行一组操作',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windowId = str(args.windowId, 'windowId')
      // 参数错误在派发之前抛出，`onDesktop` 记为未执行：此时尚未发送任何帧。
      const plans = planSteps(args.steps)

      const before = desktop.elements(windowId)
      const cursor: Cursor = {
        table: before,
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
        if (done.length > 0 && !cursor.table) {
          halt = unreadHalt(plan.index, cursor)
          break
        }
        const outcome = await runStep(desktop, send, windowId, cursor, plan, actScope(ctx))
        done.push(outcome.receipt)
        ctx.emit('progress', `${stepLine(outcome.receipt)}\n`)
        if (outcome.halt) {
          halt = outcome.halt
          break
        }
      }

      const outcome = sequenceOutcome(ctx, plans, done, halt, cursor, before)
      // 该组中有按图定位的步骤、已派发条目带有 `shot` 的动作，或最后一份观察是自绘窗口：
      // 末尾补充一张动作后的整窗图，判据与单动作相同，见 `withShot`。
      const byImage = plans.some((p) => given(p.args.imageRef))
      const dispatched = done.some((r) => r.dispatch !== 'not_dispatched')
      const onScreen = done.some(
        (r) => r.dispatch !== 'not_dispatched' && ACTION_DEFS[r.action].shot === true,
      )
      const bare = cursor.last ? isBareWindow(cursor.last) : false
      if (!byImage && !onScreen && !bare) return outcome
      const refresh = dispatched || cursor.last !== null || cursor.table === null
      return withShot(outcome, refresh, desktop, send, windowId, ctx)
    }),
}
