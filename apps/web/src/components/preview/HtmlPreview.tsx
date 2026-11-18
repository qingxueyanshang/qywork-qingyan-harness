/**
 * 文件页中 HTML 文件的预览：由内置浏览器的引擎显示，脚本、样式与同目录的图片与在浏览器中打开时相同。
 *
 * - 页面是宿主中的隐藏页（不列入页签条），由本组件打开、摆放与关闭：挂载时打开，卸载时关闭。
 *   原生子视图渲染在所有 DOM 之上：占位区域不可见（所在页签隐藏，测得尺寸为 0）或有浮层时移出可视区。
 * - 文件被改写（修改时间变化）后重新加载。只按本文件的修改时间判断：按文件页的失效序号判断时，
 *   工作区中任何文件的写入都会使页面重新加载，动画随之重新开始。
 * - 页面位于浏览器独立窗口中的宿主（macOS 与 Linux）无法嵌入文件页，只提供在浏览器中打开的按钮。
 */

import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js'
import {
  closeBrowserPage,
  navigateBrowserPage,
  openBrowserPage,
  parkBrowserView,
  placeBrowserView,
  viewRect,
  zoomBrowserPage,
} from '../../lib/browser.ts'
import { localHtmlUrl } from '../../lib/links.ts'
import {
  absPath,
  browserPresentation,
  browserTab,
  openLinkInPanel,
  overlayOpen,
  workspace,
} from '../../lib/store/index.ts'
import { usePreviewTools } from './tools.ts'
import ZoomControl from './ZoomControl.tsx'
import { bindZoomInputs } from './zoom-input.ts'

/** 缩放比例的两端，与外壳的页面缩放档位两端相同。 */
const MIN_ZOOM = 0.25
const MAX_ZOOM = 5

export default function HtmlPreview(props: { path: string; mtime: number }) {
  const url = () => localHtmlUrl(absPath(props.path), '/')
  const [tabId, setTabId] = createSignal<string | null>(null)
  const [error, setError] = createSignal('')
  let slot!: HTMLDivElement

  const zoom = (action: 'in' | 'out' | 'reset') => {
    const id = tabId()
    if (id) void zoomBrowserPage(id, action).catch(() => {})
  }

  let unmounted = false
  let opening = false
  // 宿主的显示方式在其连接服务端后才取得，可能晚于挂载：取得后打开一次。
  createEffect(
    on(browserPresentation, (presentation) => {
      const ws = workspace()?.id
      const target = url()
      if (presentation !== 'embedded' || opening || !ws || !target) return
      opening = true
      openBrowserPage(target, ws, true).then(
        (tab) => {
          if (unmounted) {
            void closeBrowserPage(tab.tabId).catch(() => {})
            return
          }
          setTabId(tab.tabId)
        },
        (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
      )
    }),
  )

  onMount(() => {
    // 页面内的 Ctrl+滚轮由引擎处理；焦点在文件树等界面元素上时，按键经此缩放页面。
    const unbind = bindZoomInputs(
      slot,
      {
        ready: () => tabId() !== null,
        zoomBy: (factor) => zoom(factor > 1 ? 'in' : 'out'),
        reset: () => zoom('reset'),
      },
      { wheel: false },
    )
    const ro = new ResizeObserver(layout)
    ro.observe(slot)
    window.addEventListener('resize', layout)
    onCleanup(() => {
      unmounted = true
      unbind()
      ro.disconnect()
      window.removeEventListener('resize', layout)
      const opened = tabId()
      if (opened) {
        parkBrowserView(opened)
        void closeBrowserPage(opened).catch(() => {})
      }
    })
  })

  /** 把占位区域的矩形交给宿主；区域不可见或有浮层时移出可视区。 */
  const layout = () => {
    const id = tabId()
    if (!id) return
    const rect = overlayOpen() ? null : viewRect(slot.getBoundingClientRect(), devicePixelRatio)
    if (rect) placeBrowserView(id, rect)
    else parkBrowserView(id)
  }
  createEffect(layout)

  createEffect(
    on(
      () => props.mtime,
      () => {
        const id = tabId()
        if (id) void navigateBrowserPage(id, 'reload').catch(() => {})
      },
      { defer: true },
    ),
  )

  usePreviewTools(() => (
    <Show when={browserPresentation() === 'embedded'}>
      <ZoomControl
        ratio={browserTab(tabId() ?? '')?.zoom ?? 0}
        min={MIN_ZOOM}
        max={MAX_ZOOM}
        onStep={(direction) => zoom(direction > 0 ? 'in' : 'out')}
      />
    </Show>
  ))

  return (
    <div class="html-preview">
      <Show when={error()}>{(e) => <div class="preview-note">{e()}</div>}</Show>
      <Show when={browserPresentation() === 'window'}>
        <div class="html-preview-window">
          <button class="btn-ghost" type="button" onClick={() => openLinkInPanel(url() ?? '')}>
            在浏览器中打开
          </button>
        </div>
      </Show>
      {/* 网页由宿主摆放在该区域。此处不渲染内容：该区域随时会被原生视图覆盖。 */}
      <div class="html-preview-view" ref={slot} />
    </div>
  )
}
