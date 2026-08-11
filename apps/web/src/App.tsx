import { createSignal, lazy, onCleanup, onMount, Show } from 'solid-js'
import { Composer } from './components/Composer.tsx'
import { Palette } from './components/Palette.tsx'
import { PermissionSheet } from './components/PermissionSheet.tsx'
import { PlanCard } from './components/PlanCard.tsx'
import { Sidebar } from './components/Sidebar.tsx'
import { Transcript } from './components/Transcript.tsx'

// 懒加载：这个模块带着 CodeMirror 核心，约 300 kB。
// 只想聊天的用户不该为文件预览付首屏成本。
const SidePanel = lazy(() => import('./components/SidePanel.tsx'))
// 同理：二维码编码器约 28 kB，只有真要配对时才下载。
const PairSheet = lazy(() => import('./components/PairSheet.tsx'))

const SettingsSheet = lazy(() => import('./components/SettingsSheet.tsx'))
const WorkspaceSheet = lazy(() => import('./components/WorkspaceSheet.tsx'))

import { IconChevron, IconPanel, IconSearch } from './components/Icons.tsx'
import {
  client,
  loadConversations,
  loadWorkspace,
  pairOpen,
  setPaletteOpen,
  settingsOpen,
  setWorkspace,
  setWorkspaceSheetOpen,
  sidePanel,
  state,
  togglePanel,
  workspaceSheetOpen,
} from './lib/store/index.ts'

export function App() {
  // 抽屉只在窄屏出现；宽屏侧栏常驻，这个状态不参与布局。
  const [drawer, setDrawer] = createSignal(false)

  onMount(() => {
    client.connect()
    void loadConversations().catch(() => {
      // 首次拉取失败不阻塞界面——连接层会自己重试，状态条会显示进度。
    })
    // 工作区名要尽早出现：它是「我的会话为什么是空的」唯一的自诊断线索。
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
  })

  return (
    <div class="app" classList={{ 'drawer-open': drawer(), 'with-panel': sidePanel() !== null }}>
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

      {/* 空会话时把输入区居中：底部钉一个孤零零的输入框看起来像没加载完 */}
      <main class="main" classList={{ empty: state.transcript.length === 0 }}>
        <header class="topbar">
          <button
            class="icon-btn drawer-toggle"
            type="button"
            aria-label="打开侧栏"
            onClick={() => setDrawer(true)}
          >
            <IconChevron size={16} dir="right" />
          </button>
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
              这里曾经是两个按钮，各自 toggle 一个视图，而面板内部又有三个 tab——
              两套并列且不等价的机制：顶栏点不出「协作」，tab 点不掉面板。
              于是「怎么关掉它」和「怎么打开协作」都得靠试。
              现在职责分开：顶栏管开关，tab 管看哪个视图。 */}
          <button
            class="icon-btn"
            type="button"
            aria-label={sidePanel() ? '收起侧面板' : '展开侧面板'}
            aria-expanded={sidePanel() !== null}
            title={sidePanel() ? '收起侧面板' : '展开侧面板'}
            onClick={togglePanel}
          >
            <IconPanel size={15} />
          </button>
        </header>

        <PlanCard />
        <Transcript />
        <Composer />
      </main>

      <Show when={sidePanel()}>
        <SidePanel />
      </Show>
      <Palette />
      <PermissionSheet />
      <Show when={pairOpen()}>
        <PairSheet />
      </Show>
      <Show when={settingsOpen()}>
        <SettingsSheet />
      </Show>
      <Show when={workspaceSheetOpen()}>
        <WorkspaceSheet onClose={() => setWorkspaceSheetOpen(false)} />
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
