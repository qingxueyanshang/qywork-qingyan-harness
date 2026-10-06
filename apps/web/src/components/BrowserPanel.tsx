import { createEffect, createSignal, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import {
  activateBrowserPage,
  BLANK_PAGE,
  navigateBrowserPage,
  parkBrowserView,
  placeBrowserView,
  viewRect,
} from '../lib/browser.ts'
import { activePanelTab, browserPresentation, browserTab, overlayOpen } from '../lib/store/index.ts'
import { IconChevron, IconRefresh } from './Icons.tsx'

/**
 * 内置浏览器页：工具栏与网页显示区域。
 *
 * **网页不在本组件中**，由宿主持有。宿主报告的显示位置决定该区域的内容：
 *
 * - `embedded`：网页是主窗口下的原生子 WebView，此处只把占位容器的矩形报告给宿主，
 *   由宿主把子视图摆放到该区域（`EmbeddedView`）。
 * - `window`：网页位于浏览器自身的窗口中，此处只提供一个将该窗口置于前台的按钮。
 *
 * 两种方式的共同约定：**组件卸载不关闭网页**（收起面板、切换页签都会卸载组件），关闭只由页签的 × 触发，
 * 经由 store 登记的收尾流程；**地址与标题均为宿主的投影**，前端不写入，地址栏提交发送的是一条宿主命令，
 * 引擎导航完成后由宿主回传地址。
 */

/** 空白页的地址不显示：`about:blank` 对用户没有意义。 */
function shown(url: string): string {
  return url === BLANK_PAGE ? '' : url
}

export default function BrowserPanel(props: { id: string }) {
  const tab = () => browserTab(props.id)
  const [draft, setDraft] = createSignal<string | null>(null)
  const [error, setError] = createSignal('')
  const [manualRefresh, setManualRefresh] = createSignal(0)
  /** 地址栏处于编辑状态时显示草稿，否则显示宿主报告的真实地址。 */
  const address = () => draft() ?? shown(tab()?.url ?? '')

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
          onClick={() => {
            setManualRefresh((n) => n + 1)
            run(navigateBrowserPage(props.id, 'reload'))
          }}
        >
          {/* 与文件页一致，每次点击旋转一圈，快速刷新的本地页面也能看到反馈。 */}
          <IconRefresh
            size={14}
            style={{
              transform: `rotate(${manualRefresh() * 360}deg)`,
              transition: 'transform 360ms ease-out',
            }}
          />
        </button>
        <input
          class="web-url"
          // 不能使用 `type="url"`：它会启用浏览器自带的校验，`localhost:3000`
          // 因缺少协议被判定为不合法，表单提交被静默拦截，按回车没有任何反应。
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

      {/* 宿主连接之前显示位置未知，该区域保持空白。 */}
      <Switch>
        <Match when={browserPresentation() === 'embedded'}>
          <EmbeddedView id={props.id} />
        </Match>
        <Match when={browserPresentation() === 'window'}>
          <div class="web-window">
            <button
              class="btn-ghost"
              type="button"
              onClick={() => run(activateBrowserPage(props.id))}
            >
              显示窗口
            </button>
          </div>
        </Match>
      </Switch>

      <Show when={error()}>{(e) => <p class="web-error">{e()}</p>}</Show>
    </div>
  )
}

/**
 * 嵌入式宿主的占位容器：把矩形报告给宿主，由宿主将原生子视图摆放到该位置。
 *
 * 原生子视图是窗口的子 HWND，渲染在所有 DOM 之上：浮层覆盖、切换到其他页签、
 * 矩形测量为 0 时，都必须把它移出可视区，`z-index` 对它无效。
 */
function EmbeddedView(props: { id: string }) {
  let slot!: HTMLDivElement

  /** 把占位容器的矩形报告给宿主。切换到其他页签、浮层覆盖、矩形无法测量时移出可视区。 */
  const layout = () => {
    const rect =
      activePanelTab() === props.id && !overlayOpen()
        ? viewRect(slot.getBoundingClientRect(), window.devicePixelRatio)
        : null
    if (rect) placeBrowserView(props.id, rect)
    else parkBrowserView(props.id)
  }

  // 当前页签与浮层是否打开共同决定本页是否显示。
  createEffect(layout)

  onMount(() => {
    // 面板拖宽、放大、窗口尺寸变化都会触发此回调；缩放比例变化时浏览器也会发出一次 resize。
    const ro = new ResizeObserver(layout)
    ro.observe(slot)
    window.addEventListener('resize', layout)
    onCleanup(() => {
      ro.disconnect()
      window.removeEventListener('resize', layout)
      // 卸载只把子视图移出可视区，网页保留：收起面板、切换页签都会执行到此处。
      parkBrowserView(props.id)
    })
  })

  // 网页由宿主摆放在该区域。此处不渲染内容：该区域随时会被原生视图覆盖，
  // 渲染的内容只在原生视图移出的瞬间可见。
  return <div class="web-view" ref={slot} />
}
