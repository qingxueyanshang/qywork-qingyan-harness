import { createSignal, lazy, onCleanup, onMount, Show, Suspense } from 'solid-js'
import { Composer } from './components/Composer.tsx'
import { Palette } from './components/Palette.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Tooltip } from './components/Tooltip.tsx'
import { Transcript } from './components/Transcript.tsx'

// 懒加载：这个模块带着 CodeMirror 核心，约 300 kB。
// 只想聊天的用户不该为文件预览付首屏成本。
const SidePanel = lazy(() => import('./components/SidePanel.tsx'))

// 设置弹窗只在真的打开设置时才下载。它下面还挂着十个类目，其中七个各自
// 又是懒加载的——见 SettingsDialog 里的说明。
const SettingsDialog = lazy(() =>
  import('./components/settings/SettingsDialog.tsx').then((m) => ({ default: m.SettingsDialog })),
)

import { IconChevron, IconPanel, IconSearch } from './components/Icons.tsx'
import { WindowControls } from './components/WindowControls.tsx'
import {
  client,
  loadConversations,
  loadWorkspace,
  openBrowserTab,
  PANEL_MIN,
  panelMaximized,
  panelWidth,
  setPaletteOpen,
  settingsPage,
  setWorkspace,
  sidebarCollapsed,
  sidePanel,
  state,
  togglePanel,
  toggleSidebar,
} from './lib/store/index.ts'

/**
 * 正文里的链接落到右侧面板的浏览器页。
 *
 * **挂在根上，不在每个渲染点各接一次**：应用里的 `<a>` 全部由 markdown 渲染产出
 * （模型正文、配置提醒），没有手写的锚点。
 *
 * 桌面外壳里 `target="_blank"` 什么也不会发生——WebView 没有开新窗口这回事，
 * 点了没反应。http(s) 之外的 scheme 不接管：浏览器页只加载得了 http(s)。
 *
 * **外站不一定框得进来**：`X-Frame-Options` / `frame-ancestors` 拒绝时那一页是空白，
 * 而跨源 iframe 的加载结果读不到，这一侧看不出被拒。
 */
export function openLink(e: MouseEvent): void {
  const link = (e.target as Element).closest('a')
  const href = link?.getAttribute('href') ?? ''
  if (!/^https?:\/\//i.test(href)) return
  e.preventDefault()
  openBrowserTab(href)
}

export function App() {
  // 抽屉只在窄屏出现；宽屏侧栏常驻，这个状态不参与布局。
  const [drawer, setDrawer] = createSignal(false)

  onMount(() => {
    client.connect()
    void loadConversations().catch(() => {
      // 首次拉取失败不阻塞界面——连接层会自己重试，状态条会显示进度。
    })
    // 首屏的活动项目 = 服务端「最近打开」的那个。名字要尽早出现：
    // 它是「会话列表为什么是空的」唯一的自诊断线索。
    void loadWorkspace()
      .then(setWorkspace)
      .catch(() => {})

    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPaletteOpen((v) => !v)
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))

    /*
     * 空闲时先把面板那块代码取回来。
     *
     * 它是首屏之外最可能被点开的一块，而**点开它的时机主线程最忙**——用户通常是
     * 在模型正输出时想看文件或改动，那时主线程被 markdown 重解析占着，
     * 这一次动态导入会从几十毫秒拉长到肉眼可见。空闲时取回来就没有这一下。
     *
     * 用 `requestIdleCallback`，没有就退到定时器：这只是提前量，早晚都行，
     * 唯独不能和首屏抢。
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
      // 面板宽度的真源是 `panelWidth`（用户拖出来的，记在 localStorage）。
      // 写成 `.app` 上的行内变量：网格那一列本来就是 `var(--panel-w)`，
      // tokens.css 里那条只当默认值，布局规则一行不用改。
      // 这里**不夹**：窗口放不下由网格自己收（`.app.with-panel` 的 minmax），
      // 在这儿再夹一次就是把布局知识抄进 JS，而它只在写的那一刻是对的。
      style={{ '--panel-w': `${panelWidth()}px`, '--panel-min-w': `${PANEL_MIN}px` }}
      on:click={openLink}
    >
      <Show when={state.connection !== 'ready'}>
        <div class="conn-bar" classList={{ bad: state.connection === 'unauthorized' }}>
          {connLabel()}
        </div>
      </Show>

      <aside class="sidebar-slot">
        <Sidebar onClose={() => setDrawer(false)} />
      </aside>

      {/* 窄屏下点遮罩关抽屉。宽屏时它被 CSS 隐藏，不会挡住内容。
          用 button 而不是 div：只有 onClick 的 div 键盘用户根本够不着，
          而「关闭」是这里唯一的操作，button 的语义正好对上。 */}
      <button
        class="drawer-scrim"
        type="button"
        aria-label="关闭侧栏"
        onClick={() => setDrawer(false)}
      />

      {/* 顶栏是 .app 网格的第一行，横跨会话区与右侧面板——它不属于会话区。
          放在 .main 里的后果是：一开右侧面板，顶栏跟着缩短，窗口按钮被挤到
          窗口中间，右上角让给了面板的标签页。窗口按钮必须钉在窗口右上角。

          整条是拖拽区。Tauri 判定的是**事件目标身上有没有这个属性**，
          所以里面的按钮（都没有它）照常可点，不需要额外「取消拖拽」的声明。
          双击最大化由拖拽区自带，不用自己接。 */}
      <header class="topbar" data-tauri-drag-region>
        <button
          class="icon-btn drawer-toggle"
          type="button"
          aria-label="打开侧栏"
          onClick={() => setDrawer(true)}
        >
          <IconChevron size={16} dir="right" />
        </button>
        {/* 左栏收起之后它自己身上的开关也跟着不在了，展开的入口只能长在顶栏。
            只在收起时出现——左栏已经展开时再放一个「展开」按钮没有作用。 */}
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
        <button
          class="icon-btn"
          type="button"
          aria-label="命令面板"
          onClick={() => setPaletteOpen(true)}
        >
          <IconSearch size={15} />
        </button>
        {/* 右侧面板只留**一个**开关。
            两个按钮各 toggle 一个视图、面板内部再放三个 tab，是两套并列且不等价的
            机制：顶栏点不出「协作」，tab 点不掉面板。
            职责分开：顶栏管开关，tab 管看哪个视图。 */}
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
        <WindowControls />
      </header>

      {/* 空会话时把输入区居中：只在底部钉一个输入框看起来像没加载完 */}
      <main class="main" classList={{ empty: state.transcript.length === 0 }}>
        {/* 面板放大时正文整块卸载，不是用 CSS 藏起来：`display: none` 会把
            滚动容器的 scrollTop 清成 0，还原时用户落在几百条之前的开头，而
            重新挂载会走一遍「贴底」的初始态，还原就停在最新那条上。 */}
        <Show when={!panelMaximized()}>
          <Transcript />
        </Show>
        <Composer />
      </main>

      {/*
       * **每个懒加载都要自己的 `Suspense`。**
       *
       * 不给边界的话，挂起会逐层冒到根：打开面板那一下不只是面板空着，整棵树
       * 都被挂起，正文跟着一起消失，等 chunk 到了才恢复。平时几十毫秒看不出来，
       * 流式输出时主线程被 markdown 重解析占满，这一下就拉长到肉眼可见。
       *
       * fallback 是一个**同样尺寸的空壳**，不是转圈也不是文案：网格已经按
       * `with-panel` 给这一列留好了位置，占位块只要把那块位置占住，
       * 否则会看到栏宽先塌一下再弹回来。
       */}
      <Show when={sidePanel()}>
        <Suspense fallback={<aside class="side-panel" />}>
          <SidePanel />
        </Suspense>
      </Show>
      <Palette />
      <Tooltip />
      {/* 设置是弹窗：改一格就走，不必把会话整个换掉。 */}
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
