import { createResource, createSignal, For, Show } from 'solid-js'
import {
  activateWorkspace,
  isDesktopShell,
  type KnownWorkspace,
  loadConversations,
  loadKnownWorkspaces,
  newConversation,
  openSettings,
  pickWorkspace,
  selectConversation,
  state,
  toggleSidebar,
  workspace,
} from '../lib/store/index.ts'
import { IconPanel, IconPlus, IconSettings } from './Icons.tsx'
import { ProjectRow } from './ProjectRow.tsx'

/**
 * 左侧导航。
 *
 * 文案克制到只剩标签本身（需求 5、14）：没有「暂无会话，点击上方新建开始对话」
 * 这类引导句。空列表就是空的——控件本身已经说明了该做什么。
 *
 * ## 这一版的形状：项目 → 会话，没有分组标题
 *
 * 上一版把「工作区」和「最近」写成两个分组标题，中间夹一行工作区名。
 * 那两个标题不携带信息：下面挂着什么，图标和内容已经说清楚了；
 * 而它们制造了一个假象——工作区和会话像是两类并列的东西，
 * 实际上**会话是长在工作区里的**（server 的 listConversations 吃 workspaceId，
 * 换一个根就是另一份列表）。所以现在直接列项目，会话缩进挂在当前项目下面。
 *
 * ## 「新建 work」不是「新对话」
 *
 * 它开系统目录选择器，指一个**另外的本机目录**当项目。新建会话是另一件事，
 * 所以它的按钮长在项目名旁边：会话属于哪个项目，这个位置本身就说明了。
 *
 * ## 切项目不重启
 *
 * 换项目曾经要换掉整个 sidecar——重启服务、断连、打断正在跑的那一轮。
 * 根因是服务端把「哪个根」存成了进程级常量；那份常量已经删了，
 * 现在按会话 / 按请求查表，切过去只是换一个 `?ws=`（见 `activateWorkspace`）。
 *
 * ## 只有当前项目展开会话
 *
 * 服务端一次回一个项目的会话列表，而用户同一时刻也只看得见一个。
 * 所以其他项目是一行可点的文件夹，点下去就是切过去，而不是画一个
 * 永远展不开的箭头。
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
   * **换项目不需要桌面外壳**——服务端一次服务多个项目，切过去只是换一个 `?ws=`。
   * 只有「挑一个本机目录」要外壳：那是系统对话框，浏览器拿不到。
   * 所以 Web 端照样能在已知项目之间切，只是加不了新的（B5：能力不存在就不显示入口）。
   */
  const desktop = isDesktopShell()
  const [known, { refetch: refetchWorkspaces }] = createResource(loadKnownWorkspaces)
  const [error, setError] = createSignal<string | null>(null)

  /**
   * 当前项目在账本里的那一行。
   *
   * 从同一份 `/api/workspaces` 里挑，而不是另拿 `workspace()` 拼一个——
   * 菜单要用到 `id`（置顶 / 归档都按 id 发）和会话数，而那两样只有账本里有。
   * 拼一个假的等于第二份数据源。
   */
  const currentRow = () => (known()?.workspaces ?? []).find((w) => w.rootPath === workspace()?.root)

  /** 当前项目已经在上面单独一行，不在这里重复。 */
  const others = () => (known()?.workspaces ?? []).filter((w) => w.rootPath !== workspace()?.root)

  const go = async (path: string) => {
    if (path === workspace()?.root) return
    setError(null)
    try {
      await activateWorkspace(path)
      // 列表按「最近打开」排序，切过之后顺序变了，重拉一次。
      void refetchWorkspaces()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const newWork = async () => {
    setError(null)
    try {
      const picked = await pickWorkspace()
      // 取消不是错误，什么也不做。
      if (picked) await go(picked)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 扩展一句话摘要。
   *
   * 只在**真的装了**东西时出现：一条恒显示的「0 个插件 · 0 个 MCP」既占地方
   * 又不携带任何信息。数量而不是名字——名字放不下，悬停能看全。
   */
  const extensionSummary = () => {
    const ext = state.extensions
    if (!ext) return ''
    const parts: string[] = []
    if (ext.plugins.length) parts.push(`${ext.plugins.length} 个插件`)
    if (ext.mcpServers.length) parts.push(`${ext.mcpServers.length} 个 MCP`)
    if (ext.teamBackends.length) parts.push(`${ext.teamBackends.length} 个编排后端`)
    return parts.join(' · ')
  }

  return (
    <nav class="sidebar">
      <header class="sidebar-head">
        {/* 品牌位是静态的。它曾经是个带下拉箭头的 button——箭头承诺了一个菜单，
            而那个菜单不存在。承诺一个不存在的交互比没有交互更坏。 */}
        <span class="brand">QyWork</span>
        <div class="head-actions">
          {/* 这里原先是第二个搜索入口——顶栏上就有一个，命令面板还有 Ctrl/Cmd-K。
              同一个动作在同一屏出现两次，用户得先判断这俩是不是一回事。
              换成收起左栏：这个动作只有左栏自己这个位置放得下。 */}
          <button
            class="icon-btn"
            type="button"
            aria-label="收起会话面板"
            title="收起会话面板"
            onClick={toggleSidebar}
          >
            <IconPanel size={15} />
          </button>
        </div>
      </header>

      {/* 头部下方的固定块，不进滚动区。
          「新建 work」是这一栏唯一一个「开一个新项目」的入口，会话攒多之后
          它会被滚出视野——用户找不到它时的合理推断是「这个功能没了」。
          切换失败的提示同理：它解释的是刚按下去的那个按钮，得和按钮待在一起。 */}
      <div class="sidebar-lead">
        <Show when={desktop}>
          <button class="new-work" type="button" onClick={() => void newWork()}>
            <IconPlus size={14} />
            新建 work
          </button>
        </Show>

        {/* 失败要有终态：选目录被拒、切换失败，都在这里说出来，不静默吞掉。 */}
        <Show when={error()}>{(e) => <div class="side-error">{e()}</div>}</Show>
      </div>

      <div class="sidebar-scroll">
        <div class="project">
          {/* 当前项目也用同一个行组件：菜单四项对它全都成立（移除之后服务端会
              指好切去哪个）。两处各写一遍的话，菜单迟早会长得不一样。 */}
          <Show when={currentRow()} fallback={<div class="project-head empty">未连接</div>}>
            {(w) => (
              <ProjectRow
                workspace={w()}
                current
                onNewChat={() => {
                  void newConversation()
                  props.onClose?.()
                }}
                onChanged={() => {
                  void refetchWorkspaces()
                  // 归档动的是当前项目的会话列表，不重拉的话侧栏还显示着已归档的那些。
                  void loadConversations()
                }}
                onError={setError}
              />
            )}
          </Show>

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
        </div>

        {/* 别的项目。点一下就切过去——不重启、不断连、别的项目里正在跑的那一轮
            也不受影响。只有当前项目展开会话：服务端一次回一个项目的列表，
            而用户同一时刻也只看得见一个。 */}
        <For each={others()}>
          {(w: KnownWorkspace) => (
            <ProjectRow
              workspace={w}
              onOpen={() => void go(w.rootPath)}
              onChanged={() => void refetchWorkspaces()}
              onError={setError}
            />
          )}
        </For>
      </div>

      <footer class="sidebar-foot">
        {/* 扩展清单。**按项目拉**（`/api/capabilities?ws=`）：三份清单都配在项目
            目录下，握手报一份就成了「A 项目的插件显示在 B 项目上」。 */}
        <Show when={extensionSummary()}>
          {(text) => (
            <div class="ext-chip" title={text()}>
              <span class="truncate">{text()}</span>
            </div>
          )}
        </Show>

        {/* **一个入口。**
            这里曾经是六个并排的 `nav-item`：定时任务 / 记忆与技能 / 插件 /
            Agent 团队 / 手机接入 / 设置。前五个其实是「设置」的子项，却和它
            并排——每加一个能力就在这里多一行，左栏迟早被配置项挤掉会话列表，
            而左栏的主职责是会话。它们现在是设置整页里的五个类目。 */}
        <ul class="nav-list">
          <li>
            <button class="nav-item" type="button" onClick={() => openSettings()}>
              <IconSettings size={15} />
              通用设置
            </button>
          </li>
        </ul>
      </footer>
    </nav>
  )
}
