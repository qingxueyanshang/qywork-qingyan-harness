/**
 * 动作目标的解析与派发前的判定：按观察解析唯一的控件、判定前置条件，
 * 并组装单动作与序列共用的动作计划。
 */

import type { DesktopAction, DesktopActionKind } from '@qywork/core'
import { ACTION_DEFS, buildAction } from '../actions.ts'
import type { DesktopElement, DesktopImagePoint } from '../port.ts'
import { ArgError, bounded, given, str } from './args.ts'
import { candidateLine } from './lines.ts'

/** 歧义时返回给模型的候选条数上限。列出完整的长清单对消歧没有帮助。 */
const MAX_CANDIDATES = 10

/** 图像坐标的取值上界。图像本身长边不超过 `MAX_EDGE`，该值只用于拦截明显越界的请求。 */
export const MAX_IMAGE_COORD = 100_000

/** 键盘动作指定了不接受按键的控件或提供了图像点时，回执中指明的替代做法。 */
const TO_FOCUS = '省略 ref 即投递给窗口当前的焦点'

/**
 * 本次执行没有该窗口的有效控件表时的拒绝原因：本轮尚未观察该窗口，或上一次动作之后未能重读。
 */
export const STALE = '未执行 · 本轮没有该窗口的有效观察 · 先调用 desktop_observe'

/**
 * 把模型提供的目标解析为本次观察中唯一的控件。
 *
 * 三种写法：直接提供 `ref`、提供 `automationId`、提供 `name`（可再加 `role` 收窄）。
 * 后两种命中多个即为歧义，不按顺序选择第一个：选错会在错误的控件上执行动作，
 * 且不报错。歧义与缺失都作为工具结果返回给模型，由模型补充条件或重新观察。
 */
export function resolveTarget(
  table: DesktopElement[] | null,
  args: Record<string, unknown>,
): DesktopElement {
  if (!table) {
    throw new ArgError(STALE, 'desktop_observation_stale')
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
export function isWindowRoot(e: DesktopElement): boolean {
  return e.windowRoot === true
}

/** 观察中的窗口根节点。整窗观察必定包含它；只读取过子树的观察不包含，此时要求重新读取整窗。 */
function windowRoot(table: DesktopElement[] | null): DesktopElement {
  if (!table) {
    throw new ArgError(STALE, 'desktop_observation_stale')
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

export function describeQuery(role?: string, automationId?: string, name?: string): string {
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
    const other = ACTION_DEFS[kind].target === 'focus' ? ` · ${TO_FOCUS}` : ''
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
 * 一次输入实际进入的控件：指定的控件；输入投递给窗口焦点时，是本控件表中持有键盘焦点的
 * 控件（取层级最深者）。未找到时缺失。
 */
export function inputField(
  table: DesktopElement[] | null,
  element: DesktopElement | undefined,
): DesktopElement | undefined {
  return element ?? table?.findLast((e) => e.focused === true && !isWindowRoot(e))
}

/**
 * 一次动作的作用目标，以及回执中对该目标的称呼。
 *
 * `input` 中 `ref` 与 `at` 互斥，两者都不带时目标是窗口焦点。`element` 是解析得到的
 * 控件，按图定位与投递给窗口焦点时缺失：回读核验与后置条件都依赖它，缺少时无法判定。
 */
export interface Aim {
  input: { ref?: string; at?: DesktopImagePoint }
  element?: DesktopElement
  label: string
  landing?: Landing
}

/**
 * 按控件执行的指针动作的落点（屏幕物理像素）与该控件的尺寸。
 *
 * 落点取观察中包围盒的中心，与宿主的取点规则相同。控件比其中的可见内容宽时中心可能是空白处，
 * 回执写明尺寸，据此判断是否改为按图像坐标定位。控件没有包围盒时缺省。
 */
export interface Landing {
  x: number
  y: number
  width: number
  height: number
}

function landingOf(e: DesktopElement): Landing | undefined {
  if (!e.rect) return undefined
  const { x, y, width, height } = e.rect
  return { x: x + Math.floor(width / 2), y: y + Math.floor(height / 2), width, height }
}

export function landingLine(kind: DesktopActionKind, landing: Landing | undefined): string {
  if (!landing) return ''
  const point = ACTION_DEFS[kind].landingLabel ?? '落点'
  return ` · ${point} ${landing.x},${landing.y}（控件 ${landing.width}×${landing.height} 的中心）`
}

/**
 * 解析本次动作的目标并组装动作。单动作与序列的每一步共用此实现。
 *
 * 三种指定方式：`imageRef` 加 `imageX` / `imageY` 表示上一张图像中的一个点，只有指针动作接受；
 * 键盘输入未指定控件时投递给窗口焦点：指定窗口根与不指定控件含义相同，在此处合成为
 * 同一种请求，两种写法各发一种帧会形成两套判定；其余按 `ref` / `automationId` / `name`
 * 定位，并在派发前判定一次前置条件。
 *
 * 按图定位与投递给窗口焦点时不判定前置条件：此时没有控件，落点是否属于目标窗口、窗口能否接收输入、
 * 前台操作是否开启，都由宿主在派发前核对。
 */
export function planAct(
  table: DesktopElement[] | null,
  kind: DesktopActionKind,
  args: Record<string, unknown>,
  params: readonly string[],
  foregroundEnabled: boolean,
): { aim: Aim; action: DesktopAction } {
  const { target } = ACTION_DEFS[kind]
  if (!foregroundEnabled && target !== 'control') {
    throw new ArgError(
      `${kind} 未执行 · 前台操作已关闭 · 用户在设置 → 权限 → 电脑控制开启前台操作后需重新观察；更换 ref 或重试不会启用`,
      'desktop_foreground_disabled',
    )
  }
  if (given(args.imageRef)) {
    if (target !== 'pointer') {
      throw new ArgError(
        target === 'focus'
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
  if (!targetGiven(args) && (given(args.imageX) || given(args.imageY))) {
    throw new ArgError(
      '未执行 · 提供了 imageX / imageY 但缺少 imageRef · imageRef 取自最近一次采图回执中的 imageRef',
    )
  }
  const toWindow = target === 'focus'
  if (toWindow && !targetGiven(args)) return toFocus(kind, args, params)
  const element =
    target === 'window' && !targetGiven(args) ? windowRoot(table) : resolveTarget(table, args)
  if (toWindow && isWindowRoot(element)) return toFocus(kind, args, params)
  checkPrecondition(element, kind)
  const action = buildAction(table ?? [], element, kind, args, params)
  const landing = target === 'pointer' ? landingOf(element) : undefined
  return {
    aim: {
      input: { ref: element.ref },
      element,
      label: element.ref,
      ...(landing ? { landing } : {}),
    },
    action,
  }
}

/**
 * 投递给窗口焦点的键盘输入。
 *
 * 不按控件表判定前置条件，也不要求控件表：只截过图的窗口同样可以按键。本执行者是否观察或截取过
 * 该窗口由协调器核对，窗口能否接收输入由宿主在派发前判定；在此处按窗口根判定等于第三份准入，
 * 且没有控件表时拒绝一次宿主会接受的请求。
 */
function toFocus(
  kind: DesktopActionKind,
  args: Record<string, unknown>,
  params: readonly string[],
): { aim: Aim; action: DesktopAction } {
  return {
    aim: { input: {}, label: '窗口焦点' },
    action: buildAction([], pointTarget(), kind, args, params),
  }
}

/**
 * 按图定位与投递给窗口焦点时传给 `buildAction` 的占位控件。
 *
 * 它不代表任何真实控件：这两种请求不按控件表解析目标，而动作条目 `build` 中的值域与目标状态
 * 判定只适用于按控件定位的动作，指针与键盘动作不读取其中任何字段。
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
