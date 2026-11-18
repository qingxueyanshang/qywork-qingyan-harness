/**
 * 预览控件放在文件页的标题行中，与路径同一行。图片、Office 与 HTML 的视图经 `usePreviewTools` 提供自己的控件，
 * 由 `FileView` 渲染在路径右侧；视图卸载时收回。
 *
 * 收回时核对是否仍是自己提供的控件：切换视图时新视图可能先于旧视图的清理提供控件，
 * 不核对时旧视图的清理会把新视图的控件一并移除。
 */

import { createContext, type JSX, onCleanup, useContext } from 'solid-js'

export type ToolsRender = () => JSX.Element

export interface PreviewTools {
  show(render: ToolsRender): void
  hide(render: ToolsRender): void
}

export const PreviewToolsContext = createContext<PreviewTools>({ show() {}, hide() {} })

/** 在视图组件的函数体中调用。 */
export function usePreviewTools(render: ToolsRender): void {
  const tools = useContext(PreviewToolsContext)
  tools.show(render)
  onCleanup(() => tools.hide(render))
}
