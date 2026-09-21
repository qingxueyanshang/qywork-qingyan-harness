import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import {
  BLANK_PAGE,
  navigateBrowserPage,
  parkBrowserView,
  placeBrowserView,
  viewRect,
} from '../lib/browser.ts'
import { activePanelTab, browserTab, overlayOpen } from '../lib/store/index.ts'
import { IconChevron, IconRefresh } from './Icons.tsx'

/**
 * 内置浏览器页：工具栏加一块占位容器。
 *
 * **网页不在这个组件里。** 它是挂在主窗口底下的原生子 WebView，由宿主持有；
 * 这里只把占位容器的矩形报给宿主，宿主把子视图摆到那块地方。因此：
 *
 * - **组件卸载不关网页**（收起面板、切页签都会卸载它），只把子视图移出可视区。
 *   真正关掉在页签的 ×，走 store 登记的收尾。
 * - **地址、标题都是投影**，前端不写它们；地址栏提交发的是一条宿主命令，
 *   引擎导航完了地址由 `on_navigation` 事件回投。
 *
 * 原生子视图是窗口的子 HWND，画在所有 DOM 之上：浮层盖上来、翻到别的页签、
 * 矩形量成 0，都必须把它移出可视区，`z-index` 对它无效。
 */

/** 空标签的地址不显示：`about:blank` 对用户没有意义。 */
function shown(url: string): string {
  return url === BLANK_PAGE ? '' : url
}

export default function BrowserPanel(props: { id: string }) {
  const tab = () => browserTab(props.id)
  const [draft, setDraft] = createSignal<string | null>(null)
  const [error, setError] = createSignal('')
  /** 地址栏正在被编辑时显示草稿，否则显示宿主报回来的真实地址。 */
  const address = () => draft() ?? shown(tab()?.url ?? '')

  let slot!: HTMLDivElement

  /** 把占位容器的矩形报给宿主。翻到别的页、浮层盖上来、矩形量不出来时移出可视区。 */
  const layout = () => {
    const rect =
      activePanelTab() === props.id && !overlayOpen()
        ? viewRect(slot.getBoundingClientRect(), window.devicePixelRatio)
        : null
    if (rect) placeBrowserView(props.id, rect)
    else parkBrowserView(props.id)
  }

  // 翻到哪一页、浮层开没开都会改变这一页该不该露出来。
  createEffect(layout)

  onMount(() => {
    // 面板拖宽、放大、窗口改尺寸都走它；缩放比例变了浏览器也会发一次 resize。
    const ro = new ResizeObserver(layout)
    ro.observe(slot)
    window.addEventListener('resize', layout)
    onCleanup(() => {
      ro.disconnect()
      window.removeEventListener('resize', layout)
      // 卸载只是把子视图收回可视区之外，网页留着：收起面板、切页签都会走到这里。
      parkBrowserView(props.id)
    })
  })

  const run = (fn: Promise<void>) => {
    setError('')
    void fn.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }

  const go = () => {
    const next = address().trim()
    if (!next) return
    setDraft(null)
    run(navigateBrowserPage(props.id, 'goto', next))
  }

  return (
    <div class="web-panel">
      <form
        class="web-bar"
        onSubmit={(e) => {
          e.preventDefault()
          go()
        }}
      >
        <button
          class="icon-btn"
          type="button"
          aria-label="后退"
          data-tip="后退"
          onClick={() => run(navigateBrowserPage(props.id, 'back'))}
        >
          <IconChevron size={14} dir="left" />
        </button>
        <button
          class="icon-btn"
          type="button"
          aria-label="前进"
          data-tip="前进"
          onClick={() => run(navigateBrowserPage(props.id, 'forward'))}
        >
          <IconChevron size={14} dir="right" />
        </button>
        <button
          class="icon-btn"
          type="button"
          aria-label="刷新"
          data-tip="刷新"
          onClick={() => run(navigateBrowserPage(props.id, 'reload'))}
        >
          <IconRefresh size={14} />
        </button>
        <input
          class="web-url"
          // **不能用 `type="url"`**：那会开浏览器自带的校验，`localhost:3000`
          // 不带协议直接被判不合法，表单提交被静默拦下，按回车没有任何反应。
          type="text"
          spellcheck={false}
          placeholder="网址或本地文件路径"
          value={address()}
          onInput={(e) => {
            setDraft(e.currentTarget.value)
          }}
          onBlur={() => setDraft(null)}
        />
      </form>

      {/* 网页由宿主摆在这块地方。这里不画内容：这块区域随时会被原生视图盖住，
          画出来的只在让位的那一刻可见。 */}
      <div class="web-view" ref={slot} />

      <Show when={error()}>{(e) => <p class="web-error">{e()}</p>}</Show>
    </div>
  )
}
