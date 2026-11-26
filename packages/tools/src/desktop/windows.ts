/** `desktop_windows`：列出可操作的顶层窗口与前台操作开关。 */

import type { ToolSpec } from '@qywork/agent'
import { BASE, onDesktop } from './shared/run.ts'

export const desktopWindowsTool: ToolSpec = {
  ...BASE,
  name: 'desktop_windows',
  description:
    '列出用户桌面上当前打开的顶层窗口。操作本机应用应使用桌面工具，不得通过 run_command 截图或注入鼠标、键盘事件。' +
    'title 为系统窗口标题，可能与当前页面或会话不一致；操作目标应依据最新截图或控件确认。' +
    'windowId 是后续调用的入口，窗口重建后失效。' +
    'foregroundEnabled 是当前前台操作开关；为 false 时只能使用 background 动作，' +
    '需要前台操作的任务用 write_todos 把该项标为 blocked（user_only），由用户开启，不要重试或更换目标绕过。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  verb: '列出',
  object: () => '窗口',
  summary: '列出可操作的桌面窗口',
  targetExtractor: () => '电脑控制',

  fn: (_args, ctx) =>
    onDesktop(ctx, async (desktop, send) => {
      const windows = await send(() => desktop.windows())
      return {
        status: 'success',
        message: windows.length
          ? `${windows.length} 个窗口 · ${windows.map((w) => `${w.windowId} ${w.app} ${w.title}`).join(' · ')}`
          : '0 个窗口',
        data: { windows, foregroundEnabled: desktop.foregroundEnabled() },
      }
    }),
}
