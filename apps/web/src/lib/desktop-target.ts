/**
 * 电脑控制那几条动作行行尾显示的目标。
 *
 * `action.target` 存的是协调器发的不透明窗口编号（`dw_N`），只供权限与冲突判定；
 * 显示用这一步自己的结果里带回的窗口标题，没有标题用应用名，两者都没有就不显示。
 * 不要回落到 `action.target`：那个编号用户认不出，也对不上屏幕上的任何窗口。
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
