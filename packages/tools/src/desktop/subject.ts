import type { ToolSpec } from '@qywork/agent'

/**
 * 电脑控制工具行显示的窗口名称（结果的 `subject`）。
 *
 * 调用时记录的目标是协调器分配的不透明窗口编号（`dw_N`），仅用于权限与冲突判定，不要显示：
 * 该编号用户无法识别，也不对应屏幕上的任何窗口。显示该步骤结果中携带的窗口标题，没有标题时显示应用名，
 * 两者都没有时不写，工具行显示调用时记录的对象。
 */
export function desktopWindowLabel(data: unknown): string | undefined {
  const own = labelOf(data)
  if (own) return own
  if (typeof data !== 'object' || data === null) return undefined
  return labelOf((data as { observation?: unknown }).observation)
}

function labelOf(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const { title, app } = value as { title?: unknown; app?: unknown }
  if (typeof title === 'string' && title.trim()) return title.trim()
  if (typeof app === 'string' && app.trim()) return app.trim()
  return undefined
}

/**
 * 为工具补上窗口名称作为 `subject`。`applies` 返回 false 的调用不写：作用于控件的动作，
 * 对象是控件而不是窗口。
 */
export function withWindowSubject(
  spec: ToolSpec,
  applies: (args: Record<string, unknown>) => boolean = () => true,
): ToolSpec {
  return {
    ...spec,
    fn: async (args, ctx) => {
      const out = await spec.fn(args, ctx)
      if (!applies(args)) return out
      const label = desktopWindowLabel(out.data)
      return label ? { ...out, subject: label } : out
    },
  }
}
