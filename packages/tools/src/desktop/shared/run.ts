/**
 * 五个电脑控制工具共用的入口：取得端口、停止之后拒绝新请求、异常的终态，以及共用的规格字段。
 */

import type { ToolContext, ToolOutcome } from '@qywork/agent'
import { DesktopPort } from '../port.ts'
import { given } from './args.ts'

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
export type PortCall = <T>(call: () => Promise<T>) => Promise<T>

export function declaredKind(err: unknown): string | undefined {
  if (!(err instanceof Error)) return undefined
  const kind = (err as Error & { errorKind?: unknown }).errorKind
  return typeof kind === 'string' && kind ? kind : undefined
}

/** 端口按 `DesktopRefusal` 声明的执行前拒绝。缺失时按 `send` 是否被调用过判定。 */
export function declaredExecuted(err: unknown): boolean | undefined {
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
export async function onDesktop(
  ctx: ToolContext,
  body: (desktop: DesktopPort, send: PortCall) => Promise<ToolOutcome>,
): Promise<ToolOutcome> {
  const desktop = ctx.port(DesktopPort)
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
 * 动作请求中的权限范围：本次调用的裁决为「完全访问」时，动作可以作用于本应用自身的窗口。
 *
 * 取自本次调用的裁决（`ctx.unrestrictedPaths`，`full` 下由 `decide` 给出），不缓存：
 * 运行中切换模式后，下一次调用即按新模式判定。
 */
export function actScope(ctx: Pick<ToolContext, 'unrestrictedPaths'>): { allowSelfWindow?: true } {
  return ctx.unrestrictedPaths ? { allowSelfWindow: true } : {}
}

/** 其余四个工具的目标均为指定窗口。`desktop_windows` 没有目标窗口，见其自身的 spec。 */
export function windowTarget(args: Record<string, unknown>): string | null {
  return given(args.windowId) ? String(args.windowId).trim() : null
}

export const BASE = {
  category: 'desktop',
  facet: '桌面控件',
  permissionEffect: 'desktop',
  requires: [DesktopPort],
} as const
