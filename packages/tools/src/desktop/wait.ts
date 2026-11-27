/** `desktop_wait`：等待一个条件成立或一段时长，不派发任何动作。 */

import type { ToolContext, ToolOutcome, ToolSpec } from '@qywork/agent'
import { waitOrAbort } from '@qywork/core'
import { endsOnMessage } from '../shell/detach.ts'
import type {
  DesktopElement,
  DesktopFollowUp,
  DesktopPort,
  DesktopSnapshot,
  DesktopWaitCondition,
} from './port.ts'
import { ArgError, bounded, given, oneOf, str } from './shared/args.ts'
import { delivered, followResult, isBareWindow, withShot } from './shared/delivery.ts'
import { snapshotLine } from './shared/lines.ts'
import { BASE, onDesktop, type PortCall, STOPPED, windowTarget } from './shared/run.ts'
import { resolveTarget } from './shared/target.ts'

/** 单次等待的时长上限。超过该值的请求按上限截断。 */
const MAX_WAIT_MS = 60_000
/** 等待时长的下限。更短的请求提高到该值。 */
export const MIN_WAIT_MS = 100
/** 调用方未提供时长时的默认等待时长。 */
const DEFAULT_WAIT_MS = 10_000

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
 * 按控件树判定的条件。最近一次观察是自绘窗口（`isBareWindow`）时，宿主读取的控件树同样没有业务控件，
 * 这几种条件只能等待至超时。`window` 按顶层窗口标题判定，不读取控件树，不在其中。
 */
const TREE_CONDITIONS: readonly DesktopWaitCondition[] = ['enabled', 'value', 'gone', 'appears']
/** 条件等待使用的参数。按时长等待时提供其中任一项即拒绝：静默忽略时，回执的成功会被理解为条件已经成立。 */
const CONDITION_PARAMS = ['ref', 'automationId', 'name', 'role', 'value']

/** 等待结果的投递。等待不派发动作，因此失败一律 `executed:false`。 */
function waitOutcome(
  ctx: ToolContext,
  found: boolean,
  reason: string | undefined,
  ref: string | undefined,
  follow: DesktopFollowUp,
  before: readonly DesktopElement[] | null,
): ToolOutcome {
  // `target_gone`：等待值或可用状态时目标控件已不存在，宿主停止轮询。回执写明原因，不写为超时。
  const gone = !found && reason === 'target_gone'
  const lead = found
    ? '已满足'
    : gone
      ? `未满足 · ${ref ?? '目标控件'} 已不在窗口中，条件不会再成立`
      : `未满足 · ${reason ?? 'timeout'}`
  if (follow.observation) {
    const parts = followResult(ctx, {
      toolName: 'desktop_wait',
      snapshot: follow.observation,
      receipt: { found, ...(reason ? { reason } : {}) },
      targetRef: ref ?? null,
      before,
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
 * 等待 `ms` 毫秒，到时按最近一次观察的读取范围重新读取。停止信号在等待期间到达时返回 `null`，不再读取。
 *
 * `desktop_wait` 的按时长等待与 `desktop_act_sequence` 的等待步骤共用此实现。重读经由 `observe`，与其余观察
 * 使用同一条读取与编号路径；本次执行没有该窗口的有效观察时读取整窗。
 */
export async function pauseThenRead(
  signal: AbortSignal,
  desktop: DesktopPort,
  send: PortCall,
  windowId: string,
  ms: number,
): Promise<DesktopSnapshot | null> {
  const stopped = await waitOrAbort(ms, signal).then(
    () => false,
    () => true,
  )
  if (stopped) return null
  const latest = desktop.observation(windowId)
  return send(() =>
    desktop.observe({ windowId, ...(latest?.scope !== undefined ? { root: latest.scope } : {}) }),
  )
}

/** 按时长等待：到时重新读取并附带整窗截图。结果为成功：到时返回即是该请求的全部含义。 */
async function waitFor(
  ctx: ToolContext,
  desktop: DesktopPort,
  send: PortCall,
  windowId: string,
  ms: number,
): Promise<ToolOutcome> {
  const latest = desktop.observation(windowId)
  const snapshot = await pauseThenRead(ctx.signal, desktop, send, windowId, ms)
  if (!snapshot) return STOPPED
  const parts = followResult(ctx, {
    toolName: 'desktop_wait',
    snapshot,
    receipt: { waitedMs: ms },
    targetRef: null,
    before: latest?.elements ?? null,
    lead: `已等待 ${ms} 毫秒 · ${snapshotLine(snapshot)}`,
  })
  return withShot({ status: 'success', ...delivered(parts) }, true, desktop, send, windowId, ctx)
}

export const desktopWaitTool: ToolSpec = endsOnMessage(
  {
    ...BASE,
    name: 'desktop_wait',
    description:
      '等待一个条件成立，或等待一段时长，不派发任何动作。enabled / value / gone 针对一个已有控件，指定方式与 desktop_act 相同。' +
      '条件取自已经观察到的内容：确认页面跳转或提交生效，用 gone 等待当前页上刚点击过的按钮或链接消失，' +
      '或用 value 等待地址栏、输入框变为某个值；appears 的 name 只用确定会出现的文字，不按常识推测' +
      '（登录后的链接，有的网站称为「退出」，有的称为「注销」）。推测错误的条件只能等待至超时。' +
      '到期如实返回未满足与到期时的控件表。等待结束时窗口无可操作控件，回执附带整窗截图。' +
      '不提供 until 时等待 timeoutMs 后重新读取控件表并附带整窗截图，用于等待界面中的动画、加载或计时。' +
      `默认 ${DEFAULT_WAIT_MS} 毫秒，上限 ${MAX_WAIT_MS} 毫秒。` +
      '最近一次观察为「无可操作控件」的窗口不接受 enabled / value / gone / appears：这类窗口的控件树没有业务控件，' +
      '条件不会成立；改为按时长等待后依据截图核对，等待新窗口仍用 window。',
    parameters: {
      type: 'object',
      properties: {
        windowId: { type: 'string' },
        until: {
          type: 'string',
          enum: WAIT_CONDITIONS,
          description:
            'enabled 控件变为可用，value 控件值变为 value，gone 控件从树上消失，' +
            'appears 窗口中出现满足 role 与 name 的控件（name 与 role 至少提供一个），window 出现标题含 name 的新窗口' +
            '（条件满足后先用 desktop_windows 获取该窗口）；不提供时按 timeoutMs 等待',
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
          description: `最长等待时间，不提供 until 时为等待时长；默认 ${DEFAULT_WAIT_MS} 毫秒，上限 ${MAX_WAIT_MS}`,
        },
      },
      required: ['windowId'],
      additionalProperties: false,
    },
    verb: '等待',
    object: () => '窗口',
    summary: '等待桌面状态满足指定条件，或等待指定时长',
    targetExtractor: windowTarget,

    fn: (args, ctx) =>
      onDesktop(ctx, async (desktop, send) => {
        const windowId = str(args.windowId, 'windowId')
        const timeoutMs = given(args.timeoutMs)
          ? bounded(args.timeoutMs, 'timeoutMs', MIN_WAIT_MS, MAX_WAIT_MS)
          : DEFAULT_WAIT_MS
        if (!given(args.until)) {
          const extra = CONDITION_PARAMS.filter((key) => given(args[key]))
          if (extra.length) {
            throw new ArgError(
              `${extra.join(' / ')} 须与 until 一起提供；按时长等待只提供 timeoutMs`,
            )
          }
          return waitFor(ctx, desktop, send, windowId, timeoutMs)
        }
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
        const latest = desktop.observation(windowId)
        if (TREE_CONDITIONS.includes(until) && latest && isBareWindow(latest)) {
          throw new ArgError(
            `未执行 · 该窗口最近一次观察无可操作控件，until=${until} 按控件树判定，不会成立 · ` +
              '不提供 until 即按 timeoutMs 等待，结束时附带整窗截图',
            'desktop_precondition',
          )
        }
        // 针对已知控件的三种条件先在本地解析为唯一目标；另外两种等待的是尚未出现的控件或窗口。
        const before = latest?.elements ?? null
        const ref = REF_CONDITIONS.includes(until) ? resolveTarget(before, args).ref : undefined
        const r = await send(() =>
          desktop.wait({
            windowId,
            until,
            ...(ref !== undefined ? { ref } : {}),
            ...(until === 'value' ? { value: String(args.value) } : {}),
            ...(until === 'appears' && given(args.role) ? { role: str(args.role, 'role') } : {}),
            ...(until === 'appears' && given(args.name) ? { query: str(args.name, 'name') } : {}),
            ...(until === 'window' && given(args.name) ? { title: str(args.name, 'name') } : {}),
            timeoutMs,
          }),
        )
        const outcome = waitOutcome(ctx, r.found, r.reason, ref, r, before)
        // 自绘窗口的控件表不含业务控件，等待结束时的状态只能依据图像核对。判据见 `isBareWindow`。
        if (!r.observation || !isBareWindow(r.observation)) return outcome
        return withShot(outcome, true, desktop, send, windowId, ctx)
      }),
  },
  '先用 desktop_observe 确认窗口状态',
)
