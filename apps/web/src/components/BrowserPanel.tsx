import { createEffect, createSignal, Match, on, onCleanup, onMount, Show, Switch } from 'solid-js'
import {
  activateBrowserPage,
  BLANK_PAGE,
  navigateBrowserPage,
  parkBrowserView,
  placeBrowserView,
  viewRect,
  zoomBrowserPage,
} from '../lib/browser.ts'
import {
  activePanelTab,
  browserPresentation,
  browserReady,
  browserTab,
  browserUnavailableText,
  loadRestoredTab,
  overlayOpen,
  restoredBrowserTab,
  workspace,
} from '../lib/store/index.ts'
import { IconChevron, IconRefresh } from './Icons.tsx'
import ZoomControl from './preview/ZoomControl.tsx'

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

/**
 * 地址栏显示的地址。空白页不显示：`about:blank` 对用户没有意义。
 *
 * 本地文件地址中的非 ASCII 字符与空格解码显示，其余转义保持原样，原样提交时打开的是同一个文件。
 * 不要改用 `decodeURI`：它把 `%25` 解码为 `%`，提交时其后的两个字符被当作转义，指向另一个文件。
 */
function shown(url: string): string {
  if (url === BLANK_PAGE) return ''
  if (!url.startsWith('file:')) return url
  return url.replace(/(?:%[89a-f][0-9a-f])+|%20/gi, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}

/** `visible`：面板是否正在显示本页，见 `EmbeddedView`。 */
export default function BrowserPanel(props: { id: string; visible: boolean }) {
  // 一个 id 是否为恢复的页不会改变（见 `PanelTab` 的 `live`），因此只在创建时选择一次。
  if (restoredBrowserTab(workspace()?.id, props.id)) return <RestoredPage id={props.id} />
  const tab = () => browserTab(props.id)
  const [draft, setDraft] = createSignal<string | null>(null)
  const [error, setError] = createSignal('')
  const [manualRefresh, setManualRefresh] = createSignal(0)
  /** 地址栏处于编辑状态时显示草稿，否则显示宿主报告的真实地址。 */
  const address = () => draft() ?? shown(tab()?.url ?? '')
  /** 页面位于独立窗口中的宿主不上报历史，此时后退与前进按钮不禁用。 */
  const historyKnown = () => browserPresentation() === 'embedded'

  const fail = (e: unknown) => setError(e instanceof Error ? e.message : String(e))

  const run = (fn: Promise<void>) => {
    setError('')
    void fn.catch(fail)
  }

  // 页面导航后，上一次操作的错误不再对应当前页面。
  createEffect(
    on(
      () => tab()?.url,
      () => setError(''),
      { defer: true },
    ),
  )

  /** 导航被拒绝时保留输入的文字，供用户改正后再次提交；请求期间用户继续编辑时保留编辑后的文字。 */
  const go = () => {
    const next = address().trim()
    if (!next) return
    setError('')
    navigateBrowserPage(props.id, 'goto', next).then(
      () => setDraft((d) => (d?.trim() === next ? null : d)),
      fail,
    )
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
          // 本按钮与右侧两个按钮的提示显示在上方：地址栏下方是原生子视图，显示在下方的提示被它遮挡。
          data-tip-place="above"
          disabled={historyKnown() && !tab()?.canGoBack}
          onClick={() => run(navigateBrowserPage(props.id, 'back'))}
        >
          <IconChevron size={14} dir="left" />
        </button>
        <button
          class="icon-btn"
          type="button"
          aria-label="前进"
          data-tip="前进"
          data-tip-place="above"
          disabled={historyKnown() && !tab()?.canGoForward}
          onClick={() => run(navigateBrowserPage(props.id, 'forward'))}
        >
          <IconChevron size={14} dir="right" />
        </button>
        <button
          class="icon-btn"
          type="button"
          aria-label="刷新"
          data-tip="刷新"
          data-tip-place="above"
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
        {/* 页面位于独立窗口中时由该窗口自身缩放。比例由宿主上报，页面中按 Ctrl+滚轮缩放时同样更新。
            上下限是外壳缩放档位（`webview2.rs` 的 `ZOOM_LEVELS`）的两端。 */}
        <Show when={browserPresentation() === 'embedded'}>
          <ZoomControl
            ratio={tab()?.zoom ?? 0}
            min={0.25}
            max={5}
            onStep={(direction) => run(zoomBrowserPage(props.id, direction > 0 ? 'in' : 'out'))}
          />
        </Show>
      </form>

      {/* 宿主连接之前显示位置未知，该区域保持空白。 */}
      <Switch>
        <Match when={browserPresentation() === 'embedded'}>
          <EmbeddedView id={props.id} visible={props.visible} />
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
 * 应用启动时恢复、宿主中尚无对应页面的页。该页显示且宿主可用时按记录的地址新建页面（`loadRestoredTab`），
 * 成功后页签换为宿主的页，本组件随之卸载。宿主可用之前保持空白；宿主报告没有可用浏览器或新建失败时显示原因。
 *
 * 只请求一次：失败后不随宿主状态变化自动重试，重新显示该页（收起后再展开面板）时重新挂载并再次请求。
 */
function RestoredPage(props: { id: string }) {
  const [error, setError] = createSignal('')
  let requested = false
  createEffect(() => {
    const wsId = workspace()?.id
    if (requested || !wsId || activePanelTab() !== props.id || !browserReady()) return
    requested = true
    loadRestoredTab(wsId, props.id).catch((e: unknown) =>
      setError(`无法打开页面：${e instanceof Error ? e.message : String(e)}`),
    )
  })
  return (
    <div class="web-panel">
      <Show when={error() || browserUnavailableText()}>
        {(e) => <p class="web-error">{e()}</p>}
      </Show>
    </div>
  )
}

/**
 * 嵌入式宿主的占位容器：把矩形报告给宿主，由宿主将原生子视图摆放到该位置。
 *
 * 原生子视图是窗口的子 HWND，渲染在所有 DOM 之上：浮层覆盖、所在的页未显示、
 * 矩形测量为 0 时，都必须把它移出可视区，`z-index` 对它无效。
 *
 * 是否显示取 `visible`（面板正在显示的页），不取当前页签：切换到固定页签后，本页保持显示到固定页签的内容就绪，
 * 按当前页签判断时网页先移走，该区域空白。也不要只依赖 ResizeObserver 报告的显示与隐藏：它在绘制前一刻才回调，
 * 切换到本页的第一帧中网页尚未摆放，该区域空白一帧。
 *
 * 所在的页隐藏后，网页在其后的第二帧才移走：子视图移动由宿主立即执行，而主界面的新内容要到下一次合成才上屏，
 * 立即移走时露出的是已隐藏的本页，该区域空白一帧。浮层打开时立即移走：网页会遮住浮层。
 */
function EmbeddedView(props: { id: string; visible: boolean }) {
  let slot!: HTMLDivElement
  let parking = 0

  /** 把占位容器的矩形报告给宿主。所在的页未显示、浮层覆盖、矩形无法测量时移出可视区。 */
  const layout = () => {
    cancelAnimationFrame(parking)
    if (!props.visible) {
      parking = requestAnimationFrame(() => {
        parking = requestAnimationFrame(() => parkBrowserView(props.id))
      })
      return
    }
    const rect = overlayOpen()
      ? null
      : viewRect(slot.getBoundingClientRect(), window.devicePixelRatio)
    if (rect) placeBrowserView(props.id, rect)
    else parkBrowserView(props.id)
  }

  // 所在的页是否显示与浮层是否打开共同决定本页是否摆放。
  createEffect(layout)
  onCleanup(() => cancelAnimationFrame(parking))

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
