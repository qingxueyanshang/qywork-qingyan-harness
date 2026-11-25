/**
 * 文件页中 HTML 文件的预览，用于桌面外壳以外的客户端：在电脑的内置浏览器中打开隐藏页（不列入页签条），显示其远程画面
 * （`RemoteView`）。脚本、样式与同目录的图片与在电脑上打开时相同。
 *
 * 挂载时打开、卸载时关闭；文件被改写（修改时间变化）后重新加载，理由同桌面外壳的 `HtmlPreview`。
 */

import { createEffect, createSignal, on, onCleanup, Show } from 'solid-js'
import { localHtmlUrl } from '../../lib/links.ts'
import {
  absPath,
  closeRemotePage,
  createRemotePage,
  navigateRemotePage,
} from '../../lib/store/index.ts'
import RemoteView from './RemoteView.tsx'

export default function RemoteHtmlPreview(props: { path: string; mtime: number }) {
  const [tabId, setTabId] = createSignal<string | null>(null)
  const [error, setError] = createSignal('')
  let unmounted = false

  const target = localHtmlUrl(absPath(props.path), '/')
  if (target) {
    createRemotePage(target, true).then(
      (tab) => {
        if (unmounted) void closeRemotePage(tab.tabId).catch(() => {})
        else setTabId(tab.tabId)
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    )
  }

  onCleanup(() => {
    unmounted = true
    const opened = tabId()
    if (opened) void closeRemotePage(opened).catch(() => {})
  })

  createEffect(
    on(
      () => props.mtime,
      () => {
        const id = tabId()
        if (id) void navigateRemotePage(id, 'reload').catch(() => {})
      },
      { defer: true },
    ),
  )

  return (
    <div class="html-preview">
      <Show when={error()}>{(e) => <div class="preview-note">{e()}</div>}</Show>
      <Show when={tabId()}>{(id) => <RemoteView tabId={id()} />}</Show>
    </div>
  )
}
