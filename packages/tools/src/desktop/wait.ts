/** `desktop_wait`：等待一个条件成立，不派发任何动作。 */

import type { ToolContext, ToolOutcome, ToolSpec } from '@qywork/agent'
import type { DesktopElement, DesktopFollowUp, DesktopWaitCondition } from './port.ts'
import { ArgError, bounded, given, oneOf, str } from './shared/args.ts'
import { delivered, followResult, isBareWindow, withShot } from './shared/delivery.ts'
import { snapshotLine } from './shared/lines.ts'
import { BASE, onDesktop, windowTarget } from './shared/run.ts'
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

export const desktopWaitTool: ToolSpec = {
  ...BASE,
  name: 'desktop_wait',
  description:
    '等待一个条件成立，不派发任何动作。enabled / value / gone 针对一个已有控件，指定方式与 desktop_act 相同。' +
    '条件取自已经观察到的内容：确认页面跳转或提交生效，用 gone 等待当前页上刚点击过的按钮或链接消失，' +
    '或用 value 等待地址栏、输入框变为某个值；appears 的 name 只用确定会出现的文字，不按常识推测' +
    '（登录后的链接，有的网站称为「退出」，有的称为「注销」）。推测错误的条件只能等待至超时。' +
    '到期如实返回未满足与到期时的控件表。等待结束时窗口无可操作控件，回执附带整窗截图。',
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
    required: ['windowId', 'until'],
    additionalProperties: false,
  },
  actionKind: 'read',
  summary: '等待桌面状态满足指定条件',
  targetExtractor: windowTarget,

  fn: (args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windowId = str(args.windowId, 'windowId')
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
      const before = desktop.elements(windowId)
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
          timeoutMs: given(args.timeoutMs)
            ? bounded(args.timeoutMs, 'timeoutMs', MIN_WAIT_MS, MAX_WAIT_MS)
            : DEFAULT_WAIT_MS,
        }),
      )
      const outcome = waitOutcome(ctx, r.found, r.reason, ref, r, before)
      // 自绘窗口的控件表不含业务控件，等待结束时的状态只能依据图像核对。判据见 `isBareWindow`。
      if (!r.observation || !isBareWindow(r.observation)) return outcome
      return withShot(outcome, true, desktop, send, windowId, ctx)
    }),
}
