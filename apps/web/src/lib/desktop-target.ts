/**
 * 电脑控制动作行行尾显示的目标。
 *
 * `action.target` 存储协调器分配的不透明窗口编号（`dw_N`），仅用于权限与冲突判定；
 * 显示时使用该步骤结果中携带的窗口标题，没有标题时使用应用名，两者都没有时不显示。
 * 不要回落到 `action.target`：该编号用户无法识别，也不对应屏幕上的任何窗口。
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
