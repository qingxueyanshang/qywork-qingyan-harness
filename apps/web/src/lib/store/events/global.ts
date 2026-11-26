/**
 * 不属于任何会话的事件：会话列表、进程级能力、本机数据与画布。
 *
 * 这些事件在归属判定之前处理：按信封归属会把后台会话与工作区级的事件整帧丢弃。
 */

import { produce } from 'solid-js/store'
import { loadAnnouncements } from '../announcements.ts'
import { setPersonalizationChange } from '../appearance/personalization.ts'
import { setPetsChange } from '../appearance/pet.ts'
import { receivePreferences } from '../appearance/preferences.ts'
import { projectRemoteTabs } from '../browser.ts'
import { setExportRequests } from '../canvas.ts'
import { openFileInPanel } from '../files.ts'
import { setConfigChange } from '../settings.ts'
import { setState, settleBusy } from '../state.ts'
import { supportChanged } from '../support.ts'
import { syncSharedTabs, workspace } from '../ui.ts'
import { handlers } from './handler.ts'
import { flushText } from './pace.ts'

export const globalEvents = handlers({
  /*
   * 服务端创建的会话：列表中尚无该会话，按信封归属路由必然整帧丢弃，
   * 而该事件的作用正是让左栏显示这条会话。
   *
   * 丢弃其他项目的会话：插入后它在列表中外观正常，无法看出它属于另一个项目。
   */
  'conversation.created': {
    process(ev) {
      if (ev.conversation.workspaceId !== workspace()?.id) return
      setState(
        produce((s) => {
          if (s.conversations.some((c) => c.id === ev.conversation.id)) return
          s.conversations.unshift(ev.conversation)
        }),
      )
    },
  },

  /*
   * 会话属性变更与忙闲修改的是左栏的会话列表，不是某条会话的内容，对后台会话同样有意义
   * （标题、模型、忙闲）。按当前会话丢弃会使后台会话的标题始终停留在「新对话」。
   * 它们自身携带 `conversationId`，按 id 精确路由。
   */
  'conversation.updated': {
    process(ev) {
      flushText()
      setState(
        produce((s) => {
          const conv = s.conversations.find((c) => c.id === ev.conversationId)
          if (conv) {
            conv.provider = ev.provider
            conv.model = ev.model
            conv.title = ev.title
            conv.mode = ev.mode
            conv.updatedAt = ev.updatedAt
          }
        }),
      )
    },
  },
  'conversation.busy': {
    process(ev) {
      settleBusy(ev.conversationId, ev.busy)
    },
  },

  /*
   * 内置浏览器能力：进程级事件，与握手中的 `capabilities.browser` 是同一份投影。
   *
   * 原生宿主在应用启动之后才连接，只依赖握手中的那一份时，界面要等到下一次重连
   * 才能显示浏览器入口。
   */
  'browser.state': {
    process(ev) {
      setState('capabilities', (caps) => (caps ? { ...caps, browser: ev.browser } : caps))
    },
  },

  /* 内置浏览器的页签清单：只有桌面外壳以外的客户端采用，见 `projectRemoteTabs`。 */
  'browser.tabs': {
    process(ev) {
      projectRemoteTabs(ev.tabs)
    },
  },

  /* 共享页签（画布、文件预览、插件工作台）的完整清单：权威在电脑上，全部客户端照此显示。 */
  'panel.tabs': {
    process(ev) {
      syncSharedTabs(ev.tabs)
    },
  },

  /*
   * 电脑控制能力与桌面占用快照：全局接收，目标快照自带所属会话。切换到后台会话时
   * 可以立即读取它的目标，运行条只使用当前会话的那一份。
   *
   * 目标应用以服务端推送的值为准，前端不自行推断何时清空：执行者释放、
   * 宿主断开、能力下线三条路径服务端都会推送移除后的列表，前后端各自判定必然在某条路径上不一致。
   */
  'desktop.state': {
    process(ev) {
      setState('capabilities', (caps) => (caps ? { ...caps, desktop: ev.desktop } : caps))
    },
  },
  'desktop.target': {
    process(ev) {
      setState('desktopTargets', ev.targets)
    },
  },

  // 个性化、界面偏好、配置与宠物库是本机级数据，不属于任何会话或项目。
  'personalization.changed': {
    process(_ev, seq) {
      setPersonalizationChange(seq)
    },
  },
  'preferences.changed': {
    process(ev) {
      receivePreferences(ev.preferences)
    },
  },
  'config.changed': {
    process(_ev, seq) {
      setConfigChange(seq)
    },
  },
  // 云端经隧道推送的变化（本机服务转为全局事件）：公告列表与客服对话重新读取。
  'announcements.changed': {
    process() {
      void loadAnnouncements()
    },
  },
  'support.changed': {
    process() {
      void supportChanged()
    },
  },
  'pets.changed': {
    process(ev, seq) {
      setPetsChange({ id: ev.id, removed: ev.removed, seq })
    },
  },

  // 画布卡片的运行状态：工作区级事件，与 `git.state` 相同，丢弃其他项目的事件。
  'canvas.run': {
    process(ev) {
      if (ev.workspaceId === workspace()?.id) setState('canvasVersion', (n) => n + 1)
    },
  },
  // 大模型请求导出时间线：登记请求并打开该画布，画布页签读取完成后取走请求、执行与「导出」按钮相同的导出。
  'canvas.export': {
    process(ev) {
      if (ev.workspaceId !== workspace()?.id) return
      setExportRequests((all) => [...all, { path: ev.path, nodeId: ev.nodeId }])
      openFileInPanel(ev.path)
    },
  },
})
