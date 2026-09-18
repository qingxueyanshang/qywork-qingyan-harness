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
  DesktopPort,
  DesktopSnapshot,
  DesktopWaitCondition,
  ToolContext,
  ToolOutcome,
  ToolSpec,
} from '@qywork/agent'
import type { DesktopNodeAction } from '@qywork/core'

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

const ACTIONS: readonly DesktopNodeAction[] = ['set_value', 'invoke']
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

/** 动作前的前置条件：控件启用，且宿主真的能在它上面执行这个动作。 */
function checkPrecondition(element: DesktopElement, action: DesktopNodeAction): void {
  if (!element.enabled) {
    throw new ArgError(
      `${element.ref} 当前处于禁用状态，没有执行 ${action}。`,
      'desktop_precondition',
    )
  }
  if (!element.actions.includes(action)) {
    const usable = element.actions.length ? element.actions.join(' / ') : '无'
    throw new ArgError(
      `${element.ref} 不支持 ${action}，它可用的动作是：${usable}`,
      'desktop_action_unsupported',
    )
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
function actOutcome(action: DesktopNodeAction, ref: string, r: DesktopActResult): ToolOutcome {
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
    '读一个窗口的控件表：角色、名称、稳定标识、当前值、是否启用，以及宿主能在它上面执行的动作。' +
    '每个控件带 parentRef 与 depth，同名控件靠祖先路径区分。' +
    '返回的 observationId 与控件 ref 是 desktop_act 与 desktop_wait 的前提；' +
    '重新观察即换号，旧号作废。' +
    'query 只返回名称、稳定标识或值包含该文字的控件，role 只返回该角色的控件：' +
    '知道要找什么时用它们，一次拿到全部匹配项，不必读整窗；' +
    'root 只读某个控件底下的子树，用于翻开一个已经看到的容器。' +
    '筛选过的观察里 filteredBy 会列出条件——没列出来的控件是被筛掉了，不是不存在。' +
    'truncated=true 表示被上限截断了，用 maxNodes 或 maxDepth 调整后重读。' +
    'includeValue=false 时不取控件值，读大窗口时省一部分开销。' +
    '本工具只读结构，不截图。',
  parameters: {
    type: 'object',
    properties: {
      windowId: { type: 'string', description: '取自 desktop_windows' },
      maxNodes: { type: 'integer', description: `最多读多少个控件，上限 ${MAX_NODES}` },
      maxDepth: { type: 'integer', description: `最多读多少层，上限 ${MAX_DEPTH}` },
      root: { type: 'string', description: '只读这个控件底下的子树，取自上一份观察的 ref' },
      role: { type: 'string', description: '只返回这个角色的控件' },
      query: { type: 'string', description: '只返回名称、稳定标识或值包含这段文字的控件' },
      includeValue: { type: 'boolean', description: '取不取控件当前值，默认取' },
    },
    required: ['windowId'],
    additionalProperties: false,
  },
  actionKind: 'read',
  summary: '读一个窗口的控件表',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const input = {
        windowId: str(args.windowId, 'windowId'),
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
      }
      const snapshot = await send(() => desktop.observe(input))
      return {
        status: 'success',
        message: `${snapshot.app} · ${snapshot.title || '(无标题)'} · ${snapshotLine(snapshot)}`,
        data: { ...snapshot },
      }
    }),
}

export const desktopActTool: ToolSpec = {
  ...BASE,
  name: 'desktop_act',
  description:
    '在观察到的控件上执行一个动作：set_value 写值（空串是清空），invoke 调用默认动作（按钮、菜单项）。' +
    '目标可以给 ref，也可以给 automationId 或 name（可加 role 收窄）；' +
    '匹配到多个时不执行，结果里按祖先路径列出候选，改用 ref 点名。' +
    '控件被禁用或不支持该动作时同样不执行。' +
    '结果里的 dispatch 有三种：not_dispatched 表示没有执行，submitted 表示调用已被系统接受，' +
    'unknown 表示调用已发出但结果无法确认——遇到 unknown 先 desktop_observe 确认实际状态，不要重放。' +
    '动作之后同次带回目标所在子树的新观察与新的 observationId，据此继续下一步，' +
    '不必再调 desktop_observe；子树之外的旧 ref 在新编号下仍然有效。' +
    '动作弹出模态窗口时整份观察作废，先 desktop_windows 再重新观察。',
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
    },
    required: ['windowId', 'observationId', 'action'],
    additionalProperties: false,
  },
  actionKind: 'call',
  summary: '在桌面控件上写值或调用默认动作',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windowId = str(args.windowId, 'windowId')
      const observationId = str(args.observationId, 'observationId')
      const action = oneOf(args.action, ACTIONS, 'action')
      // set_value 的空串是清空，只有完全不给这个参数才算没提供。
      if (action === 'set_value' && (args.value === undefined || args.value === null)) {
        throw new ArgError('set_value 必须给 value')
      }
      if (action === 'invoke' && given(args.value)) throw new ArgError('invoke 不接受 value')
      const element = resolveTarget(desktop.elements(windowId, observationId), args)
      checkPrecondition(element, action)

      const r = await send(() =>
        action === 'set_value'
          ? desktop.setValue({
              windowId,
              observationId,
              ref: element.ref,
              value: String(args.value),
            })
          : desktop.invoke({ windowId, observationId, ref: element.ref }),
      )
      return actOutcome(action, element.ref, r)
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
