/** 文件打开入口与文件树定位。定位请求只传递一次操作，选中状态仍由文件树持有。 */
import { createSignal } from 'solid-js'
import { openCanvasTab, openWorkbenchTab } from './panel-share.ts'
import { openPanel, setOpenFile, workspace } from './ui.ts'

/** 画布文件的后缀。文件树据此用画布页签打开文件。 */
export const CANVAS_SUFFIX = '.canvas.json'

/**
 * 当前客户端是否提供新建画布的入口。画布的编辑操作按鼠标设计（Shift 框选、悬停显示连接点、从文件树拖入），
 * 主指针不是鼠标时不提供新建入口。已有的画布文件在任何客户端都以画布打开：触屏上单指拖动空白处平移、双指缩放。
 */
export function canvasAvailable(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches
}

/** 页签名称：去掉 `.canvas.json` 后缀的文件名。 */
export function canvasTitle(path: string): string {
  const name = path.split('/').pop() ?? path
  return name.toLowerCase().endsWith(CANVAS_SUFFIX) ? name.slice(0, -CANVAS_SUFFIX.length) : name
}

export const [fileRevealRequest, setFileRevealRequest] = createSignal<{
  workspaceId: string
  path: string
} | null>(null)

/** 打开文本文件后选中的一段（位置按 LF 计），如画布摘录卡的段落。文件页执行一次后清除。 */
export const [fileSelectRequest, setFileSelectRequest] = createSignal<{
  path: string
  from: number
  to: number
} | null>(null)

/**
 * `open_in_panel` 成功结果中的打开目标：插件工作台（`workbench`，可带 `title`）或工作区文件（`path`）；
 * 都没有时为 `null`。工具成功后的自动打开与工具卡的「打开」按钮共用。
 */
export function panelTargetOf(data: Record<string, unknown> | undefined): (() => void) | null {
  if (typeof data?.workbench === 'string') {
    const key = data.workbench
    const title = typeof data.title === 'string' ? data.title : key
    return () => openWorkbenchTab(key, title)
  }
  if (typeof data?.path === 'string') {
    const path = data.path
    return () => openFileInPanel(path)
  }
  return null
}

/**
 * 聊天链接、文件树与画布附件共用的入口。HTML 与 Markdown 相同，在文件页中打开，由文件页提供预览与源码。
 */
export function openFileInPanel(path: string): void {
  const ws = workspace()
  if (!ws) return
  setFileRevealRequest({ workspaceId: ws.id, path })
  if (path.toLowerCase().endsWith(CANVAS_SUFFIX)) {
    setOpenFile(null)
    openCanvasTab(path, canvasTitle(path))
  } else {
    setOpenFile(path)
    openPanel('files')
  }
}
