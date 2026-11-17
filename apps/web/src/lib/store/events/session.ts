/**
 * 会话的外围状态：跟进队列与插入的消息、后台命令、待办、目标、上下文、文件变化与分支名。
 *
 * 除插入的消息（写入归属会话的会话流）与其他轮次的文件变化（重新读取归属会话的变更面板）外，
 * 只作用于当前会话。
 */

import { produce } from 'solid-js/store'
import { setState, state } from '../state.ts'
import { workspace } from '../ui.ts'
import { reloadConversationChanges } from '../views/changes.ts'
import { handlers } from './handler.ts'

export const sessionEvents = handlers({
  'queue.changed': {
    active(ev) {
      // 整体替换：服务端发送的是队列的当前完整状态，本地的乐观卡片按相同 id 被覆盖。
      setState('followUps', ev.queue)
    },
  },

  'message.injected': {
    conversation(ev, cid) {
      setState(
        produce((s) => {
          // id 使用 stepId：与刷新后 `stepToItems` 重建的条目同源，不会短暂出现重复。
          // 形态也按 `origin` 区分，与 `stepToItems` 规则相同：只在一处区分时，实时渲染为气泡、
          // 刷新后同一条变为回执行。
          s.views[cid]?.transcript.push(
            ev.origin
              ? { id: ev.stepId, kind: 'receipt', text: ev.content, origin: ev.origin }
              : {
                  id: ev.stepId,
                  kind: 'user',
                  text: ev.content,
                  ...(ev.attachments?.length ? { attachments: ev.attachments } : {}),
                },
          )
        }),
      )
    },
    active(ev) {
      // 移除对应卡片：队列的权威仍是 `queue.changed`，此处提前移除是为了
      // 避免卡片与气泡同时出现（服务端两条事件之间间隔一次落库）。
      setState('followUps', (list) => list.filter((f) => f.id !== ev.followUpId))
    },
  },

  'commands.changed': {
    active(ev) {
      // 整体替换：服务端发送的是该会话后台命令的完整快照。
      setState('backgroundCommands', ev.commands)
    },
  },

  todos: {
    active(ev) {
      // 整表替换而不合并：工具一侧按整表提交，
      // 在此处做增量合并会使两端对待办清单的内容产生两种理解。
      setState('todos', ev.todos)
    },
  },

  goal: {
    active(ev) {
      // 整体替换：事件携带账本更新后的完整快照（revision 单调递增），
      // 按字段合并会在此处形成第二种目标状态。
      setState(
        produce((s) => {
          s.goal = ev.goal
        }),
      )
    },
  },

  context: {
    active(ev) {
      setState(
        produce((s) => {
          s.contextError = null
          s.context = {
            source: ev.source,
            tokens: ev.tokens,
            limit: ev.limit,
            percent: ev.percent,
            compactAt: ev.compactAt,
            breakdown: ev.breakdown,
            omitted: ev.omitted,
          }
        }),
      )
    },
  },

  'file.changed': {
    conversation(ev, cid) {
      // 运行中一轮的写入由 `tool.finished` 追加；其他轮次的写入见 `reloadConversationChanges`。
      const v = state.views[cid]
      if (v && ev.runId !== null && ev.runId !== v.runId && ev.changes.length > 0) {
        void reloadConversationChanges(cid)
      }
    },
    active(ev) {
      setState(
        produce((s) => {
          // 即使 `changes` 为空也要递增版本：空数组表示执行类工具使文件快照失效，
          // 但没有可靠的逐路径增删明细，不能为刷新 UI 伪造一条变更。
          s.fileVersion += 1
          s.fileTouched = ev.changes.length
            ? ev.changes.flatMap((c) => (c.renamedFrom ? [c.path, c.renamedFrom] : [c.path]))
            : null
          // 本轮读数只计本轮的写入：后台命令结束时追加的改动带发起它的那一轮的 runId，计入那一轮。
          if (ev.runId === s.lastRunId) s.fileChanges.push(...ev.changes)
        }),
      )
    },
  },

  /*
   * 工作区级事件，经由全局广播（没有会话可归属，总线对它一律放行），没有归属时按当前会话处理。
   * 同时打开多个项目时，必须丢弃其他项目的分支名：分支名不含所属项目的信息，覆盖后无法从界面上察觉显示的是其他项目的分支。
   *
   * 不 flush 缓冲：服务端在握手时、切换项目时以及 `.git/HEAD` 变化时广播，新连接的客户端只能从该广播
   * 取得分支名。若它触发 flush，正文缓冲中的数十个字会在切换分支时一次性输出，打断匀速呈现。
   */
  'git.state': {
    flush: false,
    active(ev) {
      if (ev.workspaceId !== workspace()?.id) return
      setState('git', { workspaceId: ev.workspaceId, branch: ev.branch })
    },
  },
})
