import { For, Show } from 'solid-js'
import {
  newConversation,
  selectConversation,
  setPaletteOpen,
  setSettingsOpen,
  setWorkspaceSheetOpen,
  state,
  workspace,
} from '../lib/store.ts'
import { IconFolder, IconNewChat, IconSearch, IconSettings } from './Icons.tsx'

/**
 * 左侧导航。
 *
 * 文案克制到只剩标签本身（需求 5、14）：没有「暂无会话，点击上方新建开始对话」
 * 这类引导句。空列表就是空的——控件本身已经说明了该做什么。
 *
 * ## 这一版删掉了四个入口，理由是同一条
 *
 * 「分支 / 站点 / 已安装 / 通知」曾经是四个 `<button>` 无 `onClick`——
 * 渲染出来、点下去什么也不发生。这比没有这个入口更糟：用户会反复去点，
 * 并且以为是自己不会用。现在的判据是 ROADMAP §33.0 第 4 条：
 * **每一个可见入口点下去都必须产生可观察的状态变化**。
 *
 * 各自的去向不同，不是一刀切删：
 * - **分支**去了右侧审阅面板的变更视图——git 分支的语境是「这次改了什么」，
 *   不是「我要去哪个页面」，它从来就不该是一个导航项
 * - **站点**删除。这个项目无云端、无账号，没有「站点」这个概念可对应
 * - **已安装**并进插件页；一个只列数量的独立页面不承载任何决策
 * - **通知**删除。没有通知源，一个永远是空的铃铛只是装饰
 *
 * 「搜索」留下了，因为它有真实去处：命令面板（Cmd/Ctrl-K）本来就存在。
 */
export function Sidebar(props: { onClose?: () => void }) {
  /**
   * 扩展一句话摘要。
   *
   * 只在**真的装了**东西时出现：一条恒显示的「0 个插件 · 0 个 MCP」既占地方
   * 又不携带任何信息。数量而不是名字——名字放不下，悬停能看全。
   */
  const extensionSummary = () => {
    const caps = state.capabilities
    if (!caps) return ''
    const parts: string[] = []
    if (caps.plugins.length) parts.push(`${caps.plugins.length} 个插件`)
    if (caps.mcpServers.length) parts.push(`${caps.mcpServers.length} 个 MCP`)
    if (caps.teamBackends.length) parts.push(`${caps.teamBackends.length} 个编排后端`)
    return parts.join(' · ')
  }

  /**
   * 沙箱状态。**与扩展摘要相反：没有的时候更要显示。**
   *
   * 扩展是「装了才说」——一条恒显示的「0 个插件」只占地方。
   * 沙箱是「没有才更要说」：用户以为模型跑的命令被拦得住，而实际上没有，
   * 是这套权限模型最危险的误解，而界面是他唯一看得到的地方
   * （`qy config` 桌面端用户根本不会去跑）。
   *
   * 报后端名不报布尔值，理由同 ServerCapabilities 那条注释。
   */
  const sandboxChip = () => {
    const sb = state.capabilities?.sandbox
    if (!sb) return null
    return {
      active: sb.active,
      label: sb.active ? `沙箱 ${sb.backend}` : '无内核沙箱',
      title: sb.reason,
    }
  }

  return (
    <nav class="sidebar">
      <header class="sidebar-head">
        {/* 品牌位是静态的。它曾经是个带下拉箭头的 button——箭头承诺了一个菜单，
            而那个菜单不存在。承诺一个不存在的交互比没有交互更坏。 */}
        <span class="brand">qywork</span>
        <div class="head-actions">
          <button
            class="icon-btn"
            type="button"
            aria-label="搜索"
            title="搜索（Ctrl/Cmd-K）"
            onClick={() => setPaletteOpen(true)}
          >
            <IconSearch size={15} />
          </button>
        </div>
      </header>

      <div class="sidebar-scroll">
        <ul class="nav-list">
          <li>
            <button
              class="nav-item"
              type="button"
              onClick={() => {
                void newConversation()
                props.onClose?.()
              }}
            >
              <IconNewChat size={15} />
              新对话
            </button>
          </li>
        </ul>

        {/* 工作区。
            会话是**按工作区分表**的（server.ts 的 listConversations 吃 workspaceId），
            而工作区由启动时的 --cwd 决定。桌面端和手动起的 serve 落在两个目录上时，
            同一个人在两个客户端看到两份互不相交的会话，界面上却没有任何线索——
            表现就是「我的对话不见了」。把它显示出来，是这条 bug 的可见性一半。 */}
        <section class="nav-section">
          <div class="section-head static">工作区</div>
          {/* 这一行既是「我在哪」的显示，也是切换入口。
              Web 端点开也有内容——它会说明为什么这里切不了，而不是无反应。 */}
          <button
            class="workspace-row"
            type="button"
            title={workspace()?.root ?? ''}
            onClick={() => setWorkspaceSheetOpen(true)}
          >
            <IconFolder size={15} />
            <span class="truncate">{workspace()?.name ?? '未连接'}</span>
          </button>
        </section>

        <section class="nav-section">
          <div class="section-head static">最近</div>
          <ul class="nav-list">
            <For each={state.conversations}>
              {(c) => (
                <li>
                  <button
                    class="nav-item conv"
                    classList={{ active: c.id === state.activeConversation }}
                    type="button"
                    onClick={() => {
                      void selectConversation(c.id)
                      props.onClose?.()
                    }}
                  >
                    <span class="truncate">{c.title || '新对话'}</span>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </section>
      </div>

      <footer class="sidebar-foot">
        {/* 扩展清单。
            握手里早就带着 plugins / teamBackends / mcpServers，但从来没有任何组件
            读过 state.capabilities——存了不渲染，等于服务端认真算出来的东西
            一路传到前端然后丢掉。装没装上、连没连通，用户在别处无从知道。 */}
        <Show when={sandboxChip()}>
          {(chip) => (
            <div
              class="ext-chip sandbox-chip"
              classList={{ warn: !chip().active }}
              title={chip().title}
            >
              <span class="truncate">
                {chip().active ? '✓' : '⚠'} {chip().label}
              </span>
            </div>
          )}
        </Show>

        <Show when={extensionSummary()}>
          {(text) => (
            <div class="ext-chip" title={text()}>
              <span class="truncate">{text()}</span>
            </div>
          )}
        </Show>

        <button class="nav-item settings-entry" type="button" onClick={() => setSettingsOpen(true)}>
          <IconSettings size={15} />
          设置
        </button>
      </footer>
    </nav>
  )
}
