/** 文件打开入口与文件树定位。定位请求只传递一次操作，选中状态仍由文件树持有。 */
import { createSignal } from 'solid-js'
import { openLinkInPanel } from './browser.ts'
import { CANVAS_SUFFIX, canvasAvailable, canvasTitle } from './canvas.ts'
import { openCanvasTab, openPanel, setOpenFile, workspace } from './ui.ts'

export const [fileRevealRequest, setFileRevealRequest] = createSignal<{
  workspaceId: string
  path: string
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
