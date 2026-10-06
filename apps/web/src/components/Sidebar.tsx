import { createEffect, createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import { sessionSignal } from '../lib/session.ts'
import { hasAppUpdate } from '../lib/store/app-update.ts'
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
 * 文案只保留标签本身：不写「暂无会话，点击上方新建开始对话」
 * 之类的引导句。空列表保持空白，控件本身已说明可执行的操作。
 *
 * **结构：项目 → 会话，没有分组标题。** 不要添加「工作区」「最近」等分组标题：它们不提供信息（下方
 * 内容已由图标与条目说明），还会让工作区与会话看起来是两类并列的条目，而实际上**会话从属于工作区**
 * （server 的 listConversations 接受 workspaceId，不同根目录对应不同列表）。因此直接列出项目，
 * 会话缩进显示在当前项目下方。
 *
 * **「新建 work」不是「新对话」。** 它打开一个弹窗：项目名称 + 源文件夹（可留空，留空时在数据目录下
 * 新建）。新建会话是另一项操作，因此该按钮位于项目名旁边，位置本身即说明会话所属的项目。
 *
 * **切换项目不重启服务。** 切换只是更换 `?ws=`（见 `activateWorkspace`），因为服务端不保存进程级的
 * 「当前根目录」，而是按会话 / 按请求查表。若把根目录保存为进程级常量，切换项目就需要替换整个
 * sidecar：重启服务、断开连接、中断正在运行的轮次。
 *
 * **单一列表，顺序稳定。** 项目按「置顶 > 添加顺序」排列，**当前项目不移到最上方**：否则每次切换
 * 都会移到顶部，位置跳动比定位当前项目更影响使用。当前项目在原位置展开会话，由高亮与缩进标明当前
 * 所在的项目。
 *
 * 只有当前项目可以展开会话：服务端每次只返回一个项目的会话列表；点击当前项目行可收起，再次点击可展开。
 *
 * **不要在此处添加没有目标的入口。** 判据：**每个可见入口被点击后都必须产生可观察的状态变化**。
 * 没有 `onClick` 的 `<button>` 比没有入口更糟：点击后没有任何反馈，用户只会反复点击。
 *
 * 按此判据不设「分支 / 站点 / 已安装 / 通知」入口：分支属于右侧面板的变更视图（它回答本次
 * 修改了什么，不是导航目标），已安装归入插件页，站点与通知没有数据源。
 */
export function Sidebar(props: { onClose?: () => void }) {
  /**
   * **切换项目与新建项目都不需要桌面外壳**：服务端同时服务多个项目，
   * 切换只是更换 `?ws=`；新建时只填写名称则由服务端创建目录。
   * 只有选择已存在的本机目录需要外壳（浏览器无法调用系统对话框），
   * 因此弹窗中只有该按钮按 `canPickFolder` 隐藏（B5）。
   */
  const desktop = isDesktopShell()
  const [known, { refetch: refetchWorkspaces }] = createResource(loadKnownWorkspaces)
  const [error, setError] = createSignal<string | null>(null)
  const [collapsedPath, setCollapsedPath] = sessionSignal<string | null>(
    'qywork.sidebar.collapsedProject',
    null,
  )

  /*
   * 连接恢复后立即重新获取项目清单。
   *
   * `createResource` 只在挂载时获取一次，而**这一次获取容易失败**：桌面端由外壳先
   * 启动 WebView 再启动 sidecar，首屏的 REST 请求可能发生在服务开始监听之前；
   * 开发时 sidecar 热重载同样会中断进行中的请求。获取失败后不会再次获取：
   * WebSocket 自行重连、界面其他部分正常，只有项目列表始终为空，
   * 而数据库中的记录完好（实测：`workspaces` 表 5 行）。
   *
   * 判定的是**从断开到连通的状态切换**，不是「当前已连通」：后者在连接状态每次波动时都会重新获取。
   * 第二个参数提供初值，避免挂载时已是 ready 仍多获取一次。
   */
  /**
   * 项目清单。**使用 `loaded()` 读取，不要改为 `known()`**：`createResource` 的获取
   * 函数抛出后，读取 `known()` 会再次抛出该错误，且抛出位置在 `<For>` 的响应式计算中：
   * 整个左栏的更新链随之中断，连加载失败的提示也无法渲染（实测：请求被拦截
   * 后，页面只显示 `Failed to fetch`，侧栏不再更新）。
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
      setCollapsedPath(null)
      // 切换经由 upsert 完成，可能新增项目或恢复已移除的项目，因此重新获取项目列表。
      void refetchWorkspaces()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 新建 work 使用弹窗，不直接打开目录选择器。
   *
   * 直接打开选择器时，项目只能对应一个已存在的目录：名称只能取目录名，
   * 也无法先新建空目录。弹窗将两者分开：名称属于项目，路径是项目所在的位置。
   */
  const [creating, setCreating] = createSignal(false)

  return (
    <nav class="sidebar">
      <header class="sidebar-head">
        {/* 品牌标识是静态的，不要添加下拉箭头：箭头表示存在菜单，
            提示一个不存在的交互比没有交互更糟。 */}
        <span class="brand">QyWork</span>
        <div class="head-actions">
          {/* 收起左栏的按钮放在此处：该操作只适合位于左栏内部。 */}
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

      {/* 头部下方的固定区域，不进入滚动区。
          「新建 work」是左栏中唯一的新建项目入口，放入滚动区时，会话增多后
          它会移出视野，用户会误认为该功能已移除。
          切换失败的提示同理：它对应刚点击的按钮，必须与按钮放在一起。 */}
      <div class="sidebar-lead">
        <button class="new-work" type="button" onClick={() => setCreating(true)}>
          <IconPlus size={14} />
          新建 work
        </button>

        {/* 失败要有终态：选目录被拒、切换失败都在此处显示，不静默丢弃。 */}
        <Show when={error()}>{(e) => <div class="side-error">{e()}</div>}</Show>
        {/* 项目清单获取失败时必须显示。**获取失败的空列表与没有任何项目时外观相同**，
            而两者的后续操作完全不同：不显示错误时，用户会认为项目已全部丢失。 */}
        <Show when={known.error}>
          <div class="side-error">
            无法加载项目列表
            <button class="ghost-btn" type="button" onClick={() => void refetchWorkspaces()}>
              重试
            </button>
          </div>
        </Show>
      </div>

      {/* **单一列表，顺序稳定。** 当前项目不移到最上方：否则每次切换都会移到
          顶部，位置跳动比定位当前项目更影响使用。当前项目在原位置展开或收起会话，
          由高亮与缩进标明当前所在的项目。 */}
      <div class="sidebar-scroll">
        <For each={workspaces()}>
          {(w: KnownWorkspace) => {
            const isCurrent = () => w.rootPath === workspace()?.root
            const expanded = () => isCurrent() && collapsedPath() !== w.rootPath
            return (
              <div class="project">
                <ProjectRow
                  workspace={w}
                  current={isCurrent()}
                  expanded={expanded()}
                  onOpen={() => {
                    if (isCurrent()) {
                      setCollapsedPath((path) => (path === w.rootPath ? null : w.rootPath))
                    } else {
                      void go(w.rootPath)
                    }
                  }}
                  onNewChat={() => {
                    setCollapsedPath(null)
                    void newConversation()
                    props.onClose?.()
                  }}
                  onChanged={() => {
                    void refetchWorkspaces()
                    // 归档改变当前项目的会话列表，不重新获取时侧栏仍显示已归档的会话。
                    void loadConversations()
                  }}
                  onError={setError}
                />

                {/* 收起只改变左栏的显示，不取消当前会话，也不停止正在运行的任务。 */}
                <Show when={expanded()}>
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
        {/* **只保留一个入口。**
            不要把定时任务 / 记忆与技能 / 插件 / Agent 团队 / 手机接入并列放在此处：
            它们是「设置」的子项，每增加一项能力就多一行，配置项最终会挤占会话
            列表的空间，而左栏的主要职责是会话。它们是设置弹窗中的五个类目。 */}
        <ul class="nav-list">
          <li>
            <button class="nav-item" type="button" onClick={() => openSettings()}>
              <IconSettings size={15} />
              系统设置
              <Show when={hasAppUpdate()}>
                <span class="app-update-dot" role="img" aria-label="有新版本" />
              </Show>
            </button>
          </li>
        </ul>
      </footer>

      {/* 新建 work：项目名称 + 源文件夹（可留空，留空时新建默认工作区）。 */}
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
