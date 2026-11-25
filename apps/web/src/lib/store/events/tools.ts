/**
 * 工具卡与派发任务：工具的开始、输出、结束、未送达的图片，以及派发任务中各节点的状态与 CLI 输出。
 */

import { produce } from 'solid-js/store'
import { setPetApply } from '../appearance/pet.ts'
import { panelTargetOf } from '../files.ts'
import { invalidateExtensions } from '../settings.ts'
import { setState, state } from '../state.ts'
import { narrowScreen } from '../ui.ts'
import { appendChange, refreshLatestChangeTurn } from '../views/changes.ts'
import { handlers } from './handler.ts'
import { pushNodeOutput, pushToolOutput } from './pace.ts'

/** 派发任务的节点进入这些状态后不再写入文件。 */
const NODE_SETTLED: ReadonlySet<string> = new Set(['done', 'failed', 'skipped', 'interrupted'])

export const toolEvents = handlers({
  'tool.started': {
    conversation(ev, cid) {
      setState(
        produce((s) => {
          const v = s.views[cid]
          if (!v) return
          v.transcript.push({
            id: ev.stepId,
            kind: 'tool',
            text: '',
            toolName: ev.toolName,
            action: ev.action,
            args: ev.args,
            status: 'running',
            batchId: ev.batchId,
            waveIndex: ev.waveIndex,
          })
          v.generatingToolCall = false
        }),
      )
    },
  },

  // 不 flush 正文：它按 stepId 修改已存在的卡片，不改动 transcript 末项，没有顺序风险，且每秒可达数百条。
  'tool.delta': {
    flush: false,
    conversation(ev, cid) {
      pushToolOutput(cid, ev.stepId, ev.delta)
    },
  },

  'tool.images_undelivered': {
    conversation(ev, cid) {
      const ids = new Set<string>(ev.stepIds)
      setState(
        produce((s) => {
          for (const item of s.views[cid]?.transcript ?? []) {
            if (ids.has(item.id)) item.imagesUndelivered = true
          }
        }),
      )
    },
  },

  'tool.finished': {
    conversation(ev, cid) {
      if (
        [
          'import_skill',
          'write_skill',
          'move_skill',
          'write_mcp_server',
          'move_mcp_server',
          'write_memory',
          'delete_memory',
          'move_memory',
          'install_plugin',
        ].includes(
          state.views[cid]?.transcript.find((item) => item.id === ev.stepId)?.toolName ?? '',
        )
      )
        invalidateExtensions()
      // 只为用户正在查看的会话打开面板：其他会话的工具卡不在屏幕上，面板突然切换会打断用户。
      // 窄屏不自动打开：面板覆盖全屏，替换正在阅读的回复；由工具卡的「打开」按钮打开（`OpenInPanelCard`）。
      if (
        ev.status === 'success' &&
        cid === state.activeConversation &&
        !narrowScreen() &&
        state.views[cid]?.transcript.find((item) => item.id === ev.stepId)?.toolName ===
          'open_in_panel'
      ) {
        panelTargetOf(ev.outcome.data)?.()
      }
      // 切换宠物同理只响应当前会话：`applied` 只出现在 apply 的成功结果中，save 与 read 不带该字段。
      if (
        ev.status === 'success' &&
        cid === state.activeConversation &&
        ev.outcome.data !== undefined &&
        'applied' in ev.outcome.data
      ) {
        const tool = state.views[cid]?.transcript.find((item) => item.id === ev.stepId)?.toolName
        const applied = ev.outcome.data.applied
        const id = typeof applied === 'string' ? applied : null
        if (tool === 'pet') setPetApply((prev) => ({ id, seq: (prev?.seq ?? 0) + 1 }))
      }
      setState(
        produce((s) => {
          const v = s.views[cid]
          const item = v?.transcript.find((t) => t.id === ev.stepId)
          if (!v || !item) return
          item.status = ev.status === 'success' ? 'success' : 'failure'
          item.outcome = ev.outcome
          item.durationMs = ev.durationMs
          // 变更面板已读取过时才追加；未读取过的在打开时从账本整页读取。没有用户消息的轮次
          // 服务端也不计入（`listConversationChangesPage` 只选择有 user_message_id 的 run）。
          if (v.changes && v.runUserMessageId && ev.outcome.fileChanges?.length) {
            const message = v.transcript.find((t) => t.id === v.runUserMessageId)
            appendChange(
              v.changes,
              {
                userMessageId: v.runUserMessageId,
                text: message?.text ?? '',
                origin: message?.kind === 'receipt' ? (message.origin ?? null) : null,
              },
              {
                id: ev.stepId,
                toolName: item.toolName ?? '',
                ...(item.args ? { args: item.args } : {}),
                fileChanges: ev.outcome.fileChanges,
                via: null,
              },
            )
          }
        }),
      )
    },
  },

  'team.member': {
    conversation(ev, cid) {
      setState(
        produce((s) => {
          const card = s.views[cid]?.transcript.find((t) => t.id === ev.stepId)
          if (!card) return
          // 整体替换而不修改字段：卡片按 `nodes` 的引用重新渲染，连线随状态一同更新。
          card.nodes = { ...(card.nodes ?? {}), [ev.nodeId]: ev.state }
        }),
      )
      if (NODE_SETTLED.has(ev.state.phase)) void refreshLatestChangeTurn(cid)
    },
  },
  // 不 flush 正文，理由同 `tool.delta`：经合帧器写入所属图卡的节点，不改动 transcript 末项。
  'team.output': {
    flush: false,
    conversation(ev, cid) {
      pushNodeOutput(cid, ev.stepId, ev.nodeId, ev.delta)
    },
  },
})
