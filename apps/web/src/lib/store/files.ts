/** 文件打开入口与文件树定位。定位请求只传递一次操作，选中状态仍由文件树持有。 */
import { createSignal } from 'solid-js'
import { openLinkInPanel } from './browser.ts'
import { openCanvasTab, openPanel, setOpenFile, workspace } from './ui.ts'

/** 画布文件的后缀。文件树据此用画布页签打开文件。 */
export const CANVAS_SUFFIX = '.canvas.json'

/**
 * 当前客户端是否可以使用画布。画布的操作均按鼠标设计（滚轮缩放、Shift 框选、悬停显示连接点、从文件树拖入），
 * 主指针不是鼠标时不提供入口，画布文件按文本打开。
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

/** 聊天链接、文件树与画布附件共用的入口。href 仅用于保留本地网页的查询与锚点。 */
export function openFileInPanel(path: string, href?: string): void {
  const ws = workspace()
  if (!ws) return
  setFileRevealRequest({ workspaceId: ws.id, path })
  if (path.toLowerCase().endsWith(CANVAS_SUFFIX) && canvasAvailable()) {
    setOpenFile(null)
    openCanvasTab(path, canvasTitle(path))
  } else if (/\.html?$/i.test(path)) {
    openLinkInPanel(href ?? path.split('/').map(encodeURIComponent).join('/'))
  } else {
    setOpenFile(path)
    openPanel('files')
  }
}
