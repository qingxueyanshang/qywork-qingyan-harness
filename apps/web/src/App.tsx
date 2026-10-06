import {
  createEffect,
  createMemo,
  createSignal,
  lazy,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from 'solid-js'
import { Composer } from './components/Composer.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Tooltip } from './components/Tooltip.tsx'
import { Transcript } from './components/Transcript.tsx'
import { ApiError } from './lib/client.ts'
import { localHtmlUrl, workspaceFile } from './lib/links.ts'
import { observeAppUpdate } from './lib/store/app-update.ts'

// 懒加载：该模块包含 CodeMirror 核心，约 300 kB。
// 只使用聊天功能的用户不应为文件预览承担首屏加载成本。
const SidePanel = lazy(() => import('./components/SidePanel.tsx'))

// 设置弹窗仅在打开设置时下载。其下包含十个类目，其中七个各自懒加载，
// 见 SettingsDialog 中的说明。
const SettingsDialog = lazy(() =>
  import('./components/settings/SettingsDialog.tsx').then((m) => ({ default: m.SettingsDialog })),
)

import { IconCheck, IconChevron, IconDownload, IconPanel } from './components/Icons.tsx'
import { WindowControls } from './components/WindowControls.tsx'
import {
  client,
  exportActiveConversation,
  loadConversations,
  loadWorkspace,
  openFileInPanel,
  openLinkInPanel,
  PANEL_MIN,
  panelMaximized,
  panelWidth,
  setOpenFile,
  setState,
  settingsPage,
  setWorkspace,
  sidebarCollapsed,
  sidePanel,
  state,
  togglePanel,
  toggleSidebar,
  view,
  workspace,
} from './lib/store/index.ts'

/**
 * 正文中的链接在右侧面板打开：有内置浏览器时打开真实网页，否则打开网页预览；
 * 工作区中的其他文件（图片、文档等）在文件预览中打开。
 *
 * **注册在根节点上，不在每个渲染位置分别绑定**：应用中的 `<a>` 全部由 markdown 渲染产出
 * （模型正文、配置提醒），没有手写的锚点。
 *
 * 桌面外壳中 `target="_blank"` 不产生任何效果：WebView 不支持打开新窗口。
 * 本地 HTML 链接按工作区解析后交给同一个浏览器入口。
 *
 * **网页预览无法保证嵌入外部站点**：`X-Frame-Options` / `frame-ancestors`
 * 拒绝时该页显示空白，而跨源 iframe 的加载结果无法读取，本侧无法判断是否被拒。
 * 内置浏览器不受此限，它是真实的浏览器页。
 */
export function openLink(e: MouseEvent): void {
  const link = (e.target as Element).closest('a')
  const href = link?.getAttribute('href') ?? ''
  if (/^https?:\/\//i.test(href) || localHtmlUrl(href, '/')) {
    e.preventDefault()
    openLinkInPanel(href)
    return
  }
  // 工作区中的其他文件在右侧文件预览中打开，与工具产物路径使用同一个入口。
  const file = workspaceFile(href, workspace()?.root ?? '')
  if (!file) return
  e.preventDefault()
  openFileInPanel(file)
}

/** 完成状态的停留时长。短于此值时图标切换难以察觉，过长则会延续到下一次点击。 */
const COPY_DONE_MS = 1200

/**
 * 连接恢复后的完整恢复入口。顺序属于协议约定：先恢复项目，再按该项目获取会话。
 *
 * 当前项目（刷新后取自记录）已被移除时，服务端对其 `ws=` 返回 404，此时改为服务端默认的项目；
 * 打开的文件是该项目中的相对路径，一并清空。
 */
export async function restoreWorkspaceSession(): Promise<void> {
  const ws = await loadWorkspace().catch((e: unknown) => {
    if (!(e instanceof ApiError && e.status === 404 && workspace())) throw e
    setWorkspace(null)
    setOpenFile(null)
    return loadWorkspace()
  })
  setWorkspace(ws)
  await loadConversations()
}

/**
 * 代码块右上角的复制按钮。
 *
 * 注册在根节点上，理由同 openLink：按钮由 markdown 渲染产出，正文与配置提醒两处的 HTML
 * 均为整段替换，逐处绑定需要在每次重新渲染后重新绑定。
 *
 * 取 textContent 而不取 innerHTML：高亮会把代码拆分为多个 span。
 */
export function copyCode(e: MouseEvent): void {
  const btn = (e.target as Element).closest('.code-copy')
  const code = btn?.closest('.code-block')?.querySelector('code')
  if (!btn || !code) return
  void navigator.clipboard?.writeText(code.textContent ?? '').then(() => {
    btn.classList.add('done')
    setTimeout(() => btn.classList.remove('done'), COPY_DONE_MS)
  })
}

export function App() {
  // 尚未读取、加载中与加载失败都不能证明会话为空，保持最近一次已确认的布局。
  const emptyLayout = createMemo((previous: boolean) => {
    if (!state.activeConversation) return true
    const current = view()
    if (current.transcript.length > 0) return false
    if (current.history.loading !== null || current.history.error !== null) return previous
    return true
  }, false)
  // 抽屉只在窄屏出现；宽屏下侧栏常驻，该状态不参与布局。
  const [drawer, setDrawer] = createSignal(false)
  const [exportState, setExportState] = createSignal<'idle' | 'working' | 'done'>('idle')
  let exportReceipt: ReturnType<typeof setTimeout> | undefined

  const exportConversation = async () => {
    if (exportState() === 'working') return
    setExportState('working')
    try {
      const result = await exportActiveConversation()
      if (result === 'cancelled') {
        setExportState('idle')
        return
      }
      setExportState('done')
      exportReceipt = setTimeout(() => setExportState('idle'), COPY_DONE_MS)
    } catch (error) {
      setExportState('idle')
      setState('notice', {
        reason: 'export_failed',
        message: `导出失败：${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  onCleanup(() => {
    if (exportReceipt) clearTimeout(exportReceipt)
  })

  /*
   * 每次连接进入可用状态时，从服务端恢复当前项目与会话。
   *
   * 不能只在 `onMount` 中发起这两次 REST 请求：刷新恰好遇到 sidecar 重启时，首次请求会
   * 失败；即使 WebSocket 随后成功重连，页面仍停留在空的「新对话」。此处以
   * `reconnecting -> ready` 的状态变化为触发条件，因此首次握手与异常恢复使用同一条路径。
   *
   * 先获取项目再获取会话。`client.api` 会按当前项目自动附加 `ws=`；顺序相反时，重连后
   * 的第一份会话可能仍按上一个项目查询。失败由下一次连接状态变化重试，不在此处另建
   * 一套定时器：连接是否可用只以 WebSocket 为唯一权威。
   */
  createEffect((wasReady: boolean) => {
    const ready = state.connection === 'ready'
    if (ready && !wasReady) {
      void restoreWorkspaceSession().catch((error) => {
        setState('notice', {
          reason: 'restore_failed',
          message: `恢复项目与会话失败：${error instanceof Error ? error.message : String(error)}`,
        })
      })
    }
    return ready
  }, false)

  onMount(() => {
    client.connect()
    const stopUpdates = observeAppUpdate()
    onCleanup(stopUpdates)

    /*
     * 空闲时预先加载面板模块的代码。
     *
     * 它是首屏之外最可能被打开的模块，而打开它时主线程最繁忙：用户通常
     * 在模型输出期间查看文件或改动，此时主线程被 markdown 重新解析占用，
     * 这一次动态导入会从几十毫秒延长到可察觉的程度。空闲时预先加载可消除这段延迟。
     *
     * 使用 `requestIdleCallback`，不支持时回退到定时器：预加载的时机早晚均可，
     * 只是不能与首屏渲染争用主线程。
     */
    const idle =
      window.requestIdleCallback?.bind(window) ?? ((cb: () => void) => setTimeout(cb, 2000))
    idle(() => void SidePanel.preload())
  })

  return (
    <div
      class="app"
      classList={{
        'drawer-open': drawer(),
        'with-panel': sidePanel() !== null,
        'panel-max': panelMaximized(),
        'sidebar-collapsed': sidebarCollapsed(),
      }}
      // 面板宽度的真源是 `panelWidth`（由用户拖动设定，保存在 localStorage）。
      // 写成 `.app` 上的行内变量：网格对应列本身就是 `var(--panel-w)`，
      // tokens.css 中的定义只作为默认值，布局规则无需修改。
      // 此处不限制取值范围：窗口宽度不足时由网格自行收缩（`.app.with-panel` 的 minmax），
      // 在此再限制一次等于把布局规则复制进 JS，布局调整后两者会不一致。
      style={{ '--panel-w': `${panelWidth()}px`, '--panel-min-w': `${PANEL_MIN}px` }}
      on:click={(e) => {
        openLink(e)
        copyCode(e)
      }}
    >
      <Show when={state.connection !== 'ready'}>
        <div class="conn-bar" classList={{ bad: state.connection === 'unauthorized' }}>
          {connLabel()}
        </div>
      </Show>

      <aside class="sidebar-slot">
        <Sidebar onClose={() => setDrawer(false)} />
      </aside>

      {/* 窄屏下点击遮罩关闭抽屉。宽屏时遮罩由 CSS 隐藏，不遮挡内容。
          使用 button 而不是 div：只有 onClick 的 div 无法通过键盘访问，
          而「关闭」是此处唯一的操作，与 button 的语义一致。 */}
      <button
        class="drawer-scrim"
        type="button"
        aria-label="关闭侧栏"
        onClick={() => setDrawer(false)}
      />

      {/* 顶栏是 .app 网格的第一行，横跨会话区与右侧面板，不属于会话区。
          放在 .main 中时，打开右侧面板会使顶栏随之缩短，窗口按钮被挤到
          窗口中部，右上角被面板的标签页占据。窗口按钮必须固定在窗口右上角。

          整条顶栏是拖拽区。Tauri 判定的是事件目标自身是否带有该属性，
          因此其中的按钮（均不带该属性）可正常点击，无需额外声明「取消拖拽」。
          双击最大化由拖拽区自带，无需另行实现。 */}
      <header class="topbar" data-tauri-drag-region>
        <button
          class="icon-btn drawer-toggle"
          type="button"
          aria-label="打开侧栏"
          onClick={() => setDrawer(true)}
        >
          <IconChevron size={16} dir="right" />
        </button>
        {/* 左栏收起后其自身的开关随之隐藏，展开入口只能放在顶栏。
            仅在收起时显示：左栏已展开时「展开」按钮没有作用。 */}
        <Show when={sidebarCollapsed()}>
          <button
            class="icon-btn sidebar-expand"
            type="button"
            aria-label="展开会话面板"
            data-tip="展开会话面板"
            onClick={toggleSidebar}
          >
            <IconPanel size={15} />
          </button>
        </Show>
        <h1 class="title truncate">{activeTitle()}</h1>
        <span class="spacer" />
        <div class="topbar-tools">
          <button
            class="icon-btn"
            type="button"
            aria-label={exportState() === 'working' ? '正在导出当前会话' : '导出当前会话'}
            data-tip={exportState() === 'done' ? '已导出' : '导出当前会话'}
            disabled={!state.activeConversation || exportState() === 'working'}
            onClick={() => void exportConversation()}
          >
            <Show when={exportState() === 'done'} fallback={<IconDownload size={16} />}>
              <IconCheck size={16} />
            </Show>
          </button>
          {/* 右侧面板只保留一个开关。
              两个按钮各切换一个视图、面板内部再放三个 tab，构成两套并列且不等价的
              机制：顶栏无法打开「协作」，tab 无法关闭面板。
              职责划分：顶栏负责开关，tab 负责选择视图。 */}
          <button
            class="icon-btn"
            type="button"
            aria-label={sidePanel() ? '收起侧面板' : '展开侧面板'}
            aria-expanded={sidePanel() !== null}
            data-tip={sidePanel() ? '收起侧面板' : '展开侧面板'}
            onClick={togglePanel}
          >
            <IconPanel size={15} />
          </button>
        </div>
        <WindowControls />
      </header>

      <main class="main" classList={{ empty: emptyLayout() }}>
        {/* 面板放大时正文整块卸载，而不是用 CSS 隐藏：`display: none` 会把
            滚动容器的 scrollTop 重置为 0，还原时位置回到几百条之前的开头；而
            重新挂载会执行「滚动到底部」的初始化，还原后停在最新一条。 */}
        <Show when={!panelMaximized()}>
          <Transcript />
        </Show>
        <Composer empty={emptyLayout()} />
      </main>

      {/*
       * 每个懒加载组件都需要自己的 `Suspense`。
       *
       * 没有边界时，挂起会逐层传递到根：打开面板时不只面板为空，整棵组件树
       * 都被挂起，正文随之消失，chunk 到达后才恢复。平时几十毫秒难以察觉，
       * 流式输出时主线程被 markdown 重新解析占满，这段空白会延长到可察觉的程度。
       *
       * fallback 是同样尺寸的空占位元素，不是加载动画也不是文案：网格已经按
       * `with-panel` 为该列预留位置，占位元素只需占住该位置，
       * 否则栏宽会先收缩再恢复。
       */}
      <Show when={sidePanel()}>
        <Suspense fallback={<aside class="side-panel" />}>
          <SidePanel />
        </Suspense>
      </Show>
      <Tooltip />
      {/* 设置以弹窗形式打开：修改一项后即可关闭，无需替换整个会话视图。 */}
      <Show when={settingsPage()}>
        <Suspense>
          <SettingsDialog />
        </Suspense>
      </Show>
    </div>
  )
}

function activeTitle(): string {
  const id = state.activeConversation
  return state.conversations.find((c) => c.id === id)?.title || '新对话'
}

function connLabel(): string {
  switch (state.connection) {
    case 'connecting':
      return '正在连接'
    case 'reconnecting':
      return `连接已断开 · ${state.connectionDetail}`
    case 'unauthorized':
      return state.connectionDetail || '未配对'
    case 'closed':
      return '已断开'
    default:
      return ''
  }
}
