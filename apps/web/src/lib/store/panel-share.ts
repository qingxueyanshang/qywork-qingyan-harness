/**
 * 右侧面板共享页签（画布、文件预览、插件工作台）与最近查看的文件在电脑上的记录（服务端 `/api/panel`）。
 *
 * - 清单的权威在电脑上，全部客户端显示同一份：本端的记录是 `panel.tabs` 推送的投影（`ui.ts` 的 `syncSharedTabs`）。
 *   客户端离线期间的变化在重新连接后的握手中取得。
 * - 打开与关闭先更新本端的投影，再通知服务端：id 由类型与对象确定，本端先显示的页就是服务端随后推送的页，
 *   打开不等待往返。通知失败时显示回执，下一次推送把本端恢复为电脑上的清单。
 * - 最近查看的文件：本端面板显示画布或文件时上报（`watchViewing`），发送消息时由服务端附上；
 *   面板收起不清空（手机上的面板覆盖全屏，打字前须收起），关闭该页签或关闭文件页中的文件时清空。
 */

import { createEffect, on } from 'solid-js'
import { client } from './client.ts'
import { setState } from './state.ts'
import {
  panelTabs,
  removePanelTab,
  SHARED_KINDS,
  type SharedTabTarget,
  showSharedTab,
  viewingFile,
} from './ui.ts'

/** 通知服务端失败时的回执：本端已显示的变化没有记录到电脑上，其余客户端不显示它。 */
const failed = (what: string) => (e: unknown) => {
  setState('notice', {
    reason: 'panel_sync_failed',
    message: `${what}未能同步到电脑：${e instanceof Error ? e.message : String(e)}`,
  })
}

function share(target: SharedTabTarget): void {
  if (showSharedTab(target) === null) return
  client
    .api('/api/panel/tabs', { method: 'POST', body: JSON.stringify(target) })
    .catch(failed('页签'))
}

/** 打开画布。页签标题是去掉 `.canvas.json` 的文件名，创建后不再修改。 */
export function openCanvasTab(path: string, title: string): void {
  share({ kind: 'canvas', path, title })
}

/** 打开文件预览页。页签标题是文件名，创建后不再修改。 */
export function openFileTab(path: string): void {
  share({ kind: 'file', path, title: path.split('/').pop() ?? path })
}

/** 打开工作台页。 */
export function openWorkbenchTab(key: string, title: string): void {
  share({ kind: 'plugin', workbench: key, title })
}

/** 关闭一页（页签的 ×）。共享页签同时在电脑上关闭，其余客户端随之关闭。 */
export function closePanelTab(id: string): void {
  const tab = panelTabs().find((t) => t.id === id)
  removePanelTab(id)
  if (!tab || !SHARED_KINDS.has(tab.kind)) return
  client
    .api(`/api/panel/tabs?id=${encodeURIComponent(id)}`, { method: 'DELETE' })
    .catch(failed('关闭页签'))
}

/**
 * 本端面板显示画布或文件时上报为最近查看的文件。在组件中调用一次（需要响应式所有者）。
 * 只上报非空值：面板收起或显示其他页不清空，理由见文件头。
 */
export function watchViewing(): void {
  createEffect(
    on(viewingFile, (path) => {
      if (!path) return
      client
        .api('/api/panel/viewing', { method: 'POST', body: JSON.stringify({ path }) })
        .catch(failed('正在查看的文件'))
    }),
  )
}

/** 文件页中的文件被关闭：它是最近查看的文件时清空。 */
export function forgetViewing(path: string): void {
  client
    .api(`/api/panel/viewing?path=${encodeURIComponent(path)}`, { method: 'DELETE' })
    .catch(failed('关闭文件'))
}
