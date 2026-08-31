import { createEffect, createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import {
  activateWorkspace,
  isDesktopShell,
  type KnownWorkspace,
  loadConversations,
  loadKnownWorkspaces,
  newConversation,
  openSettings,
  selectConversation,
  state,
  toggleSidebar,
  workspace,
} from '../lib/store/index.ts'
import { ConversationRow } from './ConversationRow.tsx'
import { IconPanel, IconPlus, IconSettings } from './Icons.tsx'
import { NewProjectDialog } from './NewProjectDialog.tsx'
import { ProjectRow } from './ProjectRow.tsx'

/**
 * 左侧导航。
 *
 * 文案克制到只剩标签本身（需求 5、14）：没有「暂无会话，点击上方新建开始对话」
 * 这类引导句。空列表就是空的——控件本身已经说明了该做什么。
 *
 * **形状：项目 → 会话，没有分组标题。** 别写「工作区」「最近」这类分组标题：它们不携带信息（下面挂
 * 着什么，图标和内容已经说清楚了），而且制造一个假象——工作区和会话像是两类并列的条目，实际上**
 * 会话是长在工作区里的**（server 的 listConversations 吃 workspaceId，换一个根就是另一份列表）。所
 * 以直接列项目，会话缩进挂在当前项目下面。
 *
 * **「新建 work」不是「新对话」。** 它开一个弹窗：项目名称 + 源文件夹（可留空，留空就在数据目录下建
 * 一个新的）。新建会话是另一件事，所以那个按钮长在项目名旁边——会话属于哪个项目，这个位置本身就
 * 说明了。
 *
 * **切项目不重启。** 切过去只是换一个 `?ws=`（见 `activateWorkspace`），因为服务端不存进程级的
 * 「当前根」，按会话 / 按请求查表。一旦把根存成进程级常量，换项目就要换掉整个
 * sidecar——重启服务、断连、打断正在跑的那一轮。
 *
 * **一条列表，顺序稳定。** 项目按「置顶 > 添加先后」排，**当前项目不被提到最上面**——那样切一次它
 * 就跳到顶部，位置跳动比「当前项目在哪」更难用。它原地展开自己的会话，由高亮和缩进说明现在在哪个
 * 项目里。
 *
 * 只有当前项目展开：服务端一次回一个项目的会话列表，用户同一时刻也只看得见一个。
 *
 * **不要往这里加没有去处的入口。** 判据：**每一个可见入口点下去都必须产生可观察的状态变化**。一个
 * `<button>` 没有 `onClick`，比没有这个入口更糟——点下去没有任何反馈，用户只会反复去点。
 *
 * 「分支 / 站点 / 已安装 / 通知」四个按这条删过：分支归右侧面板的变更视图（它的语境是
 * 「这次改了什么」，不是「要去哪个页面」）、已安装并进插件页，站点与通知没有数据源。
 */
export function Sidebar(props: { onClose?: () => void }) {
  /**
   * **换项目和新建项目都不需要桌面外壳**——服务端一次服务多个项目，
   * 切过去只是换一个 `?ws=`；新建只填名字的话由服务端建目录。
   * 只有「挑一个已存在的本机目录」要外壳（系统对话框浏览器拿不到），
   * 所以弹窗里只有那一颗按钮按 `canPickFolder` 收起来（B5）。
   */
  const desktop = isDesktopShell()
  const [known, { refetch: refetchWorkspaces }] = createResource(loadKnownWorkspaces)
  const [error, setError] = createSignal<string | null>(null)

  /*
   * 连接一恢复就重拉项目清单。
   *
   * `createResource` 只在挂载时取一次，而**那一次很容易取不到**：桌面端是外壳先
   * 起 WebView 再起 sidecar，首屏这一发 REST 可能打在服务还没监听的那半秒里；
   * 开发时 sidecar 会热重载，同样掐断在途请求。取不到之后没有任何人再去取——
   * WebSocket 自己重连、界面其它部分照常，唯独这一栏永远空着。
   * 症状是「项目一个都不剩」，而账本里五条原封不动（实测：`workspaces` 表 5 行）。
   *
   * 判的是**从断到通的那一次翻转**，不是「现在通着」：后者每次连接状态抖动都会重拉。
   * 第二个参数给初值，避免挂载时已经是 ready 还多取一次。
   */
  /**
   * 清单本身。**用 `loaded()` 读，不要换回 `known()`**——`createResource` 的取数
   * 函数一旦抛出，读 `known()` 会把那个错再抛一次，抛在 `<For>` 的响应式计算里：
   * 整棵左栏的更新链从此断掉，连「取不到」那句话都渲染不出来（实测：请求被拦下
   * 之后，页面只剩一个 `Failed to fetch`，侧栏一个字都不再更新）。
   */
  const workspaces = () => loaded(known)?.workspaces ?? []

  createEffect((wasReady: boolean) => {
    const ready = state.connection === 'ready'
    if (ready && !wasReady) void refetchWorkspaces()
    return ready
  }, state.connection === 'ready')

  const go = async (path: string) => {
    if (path === workspace()?.root) return
    setError(null)
    try {
      await activateWorkspace({ path })
      // 列表按「最近打开」排序，切过之后顺序变了，重拉一次。
      void refetchWorkspaces()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 新建 work 是一个弹窗，不是直接开目录选择器。
   *
   * 直接开选择器的话「项目」被迫等于「一个已经存在的目录」——名字只能取目录名，
   * 也没法先建一个空目录再开始。弹窗把两件事分开：名字是项目的，路径是它落在哪。
   */
  const [creating, setCreating] = createSignal(false)

  return (
    <nav class="sidebar">
      <header class="sidebar-head">
        {/* 品牌位是静态的，别给它加下拉箭头：箭头承诺一个菜单，
            而承诺一个不存在的交互比没有交互更坏。 */}
        <span class="brand">QyWork</span>
        <div class="head-actions">
          {/* 放收起左栏——这个动作只有左栏自己这个位置放得下。 */}
          <button
            class="icon-btn"
            type="button"
            aria-label="收起会话面板"
            data-tip="收起会话面板"
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
        <button class="new-work" type="button" onClick={() => setCreating(true)}>
          <IconPlus size={14} />
          新建 work
        </button>

        {/* 失败要有终态：选目录被拒、切换失败，都在这里说出来，不静默吞掉。 */}
        <Show when={error()}>{(e) => <div class="side-error">{e()}</div>}</Show>
        {/* 清单没取到必须说出来。**空列表和「一个项目都没有」长得一模一样**，
            而这两件事该做的下一步完全相反：取不到时用户看到的是项目全没了。 */}
        <Show when={known.error}>
          <div class="side-error">
            项目清单没取到
            <button class="ghost-btn" type="button" onClick={() => void refetchWorkspaces()}>
              重试
            </button>
          </div>
        </Show>
      </div>

      {/* **一条列表，顺序稳定。** 当前项目不被提到最上面——那样切一次它就跳到
          顶部，而位置跳动比「当前项目在哪」更难用。它原地展开自己的会话，
          由高亮和缩进说明「现在在这个项目里」。 */}
      <div class="sidebar-scroll">
        <For each={workspaces()}>
          {(w: KnownWorkspace) => {
            const isCurrent = () => w.rootPath === workspace()?.root
            return (
              <div class="project">
                <ProjectRow
                  workspace={w}
                  current={isCurrent()}
                  onOpen={() => void go(w.rootPath)}
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

                {/* 只有当前项目展开会话：服务端一次回一个项目的列表，
                    而用户同一时刻也只看得见一个。 */}
                <Show when={isCurrent()}>
                  <ul class="nav-list">
                    <For each={state.conversations}>
                      {(c) => (
                        <li>
                          <ConversationRow
                            conversation={c}
                            active={c.id === state.activeConversation}
                            running={state.busyConversations.includes(c.id)}
                            onOpen={() => {
                              void selectConversation(c.id)
                              props.onClose?.()
                            }}
                            onError={setError}
                          />
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
            )
          }}
        </For>
      </div>

      <footer class="sidebar-foot">
        {/* **一个入口。**
            不要把定时任务 / 记忆与技能 / 插件 / Agent 团队 / 手机接入并排放回这里：
            它们是「设置」的子项，每加一个能力就多一行，左栏迟早被配置项挤掉会话
            列表，而左栏的主职责是会话。它们是设置弹窗里的五个类目。 */}
        <ul class="nav-list">
          <li>
            <button class="nav-item" type="button" onClick={() => openSettings()}>
              <IconSettings size={15} />
              系统设置
            </button>
          </li>
        </ul>
      </footer>

      {/* 新建 work：项目名称 + 源文件夹（可留空，留空就建默认工作区）。 */}
      <NewProjectDialog
        open={creating()}
        canPickFolder={desktop}
        onCreate={async (input) => {
          await activateWorkspace(input)
          void refetchWorkspaces()
        }}
        onClose={() => setCreating(false)}
      />
    </nav>
  )
}
