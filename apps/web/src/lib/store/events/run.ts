/**
 * 一轮的生命周期、模型请求的进度与流式输出：开始、请求、重试、报错、结束、用量、正文、思考、
 * 工具参数生成与上下文压缩。
 *
 * 每条会话的运行读数（用量、请求阶段、静默时刻与重试次数）与正文同样按 cid 归属，主会话与子会话
 * 因此能复用同一个状态条，而不会把父会话的 token、请求阶段或重试次数显示为子会话的读数。
 * `generatingToolCall` 随同一批事件更新：它表示最后一段内容是否为工具参数，与阶段不是同一个问题，
 * 因此保留为独立字段。
 */

import { produce } from 'solid-js/store'
import { client } from '../client.ts'
import {
  type ConversationView,
  LOCAL_ID_PREFIX,
  type RequestProjection,
  setState,
  type TranscriptItem,
} from '../state.ts'
import { refreshLatestChangeTurn } from '../views/changes.ts'
import { latestCompaction } from '../views/history.ts'
import { handlers } from './handler.ts'
import { flushText, flushThinking, pushText, pushThinking } from './pace.ts'

/**
 * 该轮次的结束与报错事件能否改动这条会话的实时读数。已知另一轮正在运行时不能：
 * 较早一轮迟到的收尾不能撤掉当前一轮的运行栏。不知道有运行中的轮次时可以，
 * 未取得 runId 即失败的报错（未配置模型等）由此显示为错误卡。
 */
function ownsLive(v: ConversationView, runId: string): boolean {
  return v.runId === null || v.runId === runId
}

/**
 * 把一条事件折叠进当前请求投影。序号不大于该会话实时读数序号的事件一律丢弃：
 * 快照与实时事件经由同一路径进入，先后只由序号裁决（见 `ConversationView.liveSeq`）。
 *
 * 没有投影可更新的事件不推进序号：它未折叠进投影，推进后在途快照中的请求阶段会被判为旧数据，
 * 本轮输出期间刷新页面时状态停留在「正在请求…」，直到下一次请求开始。
 */
function writeRequest(
  cid: string,
  seq: number,
  next: (prev: RequestProjection | null) => RequestProjection | null,
  generatingToolCall?: boolean,
): void {
  setState(
    produce((s) => {
      const v = s.views[cid]
      if (!v) return
      if (seq <= v.liveSeq) return
      if (generatingToolCall !== undefined) v.generatingToolCall = generatingToolCall
      const request = next(v.request)
      if (request === null && v.request === null) return
      v.liveSeq = seq
      v.request = request
    }),
  )
}

/**
 * 内容事件不带 requestId，因此只更新已有投影的阶段与最后内容时刻。
 * 没有投影时不生成请求阶段：这表示 `run.request` 尚未到达（首屏加载期间），
 * 补充 requestId 与次数属于编造；请求阶段由在途的快照恢复，内容类型仍可供当前思考折叠显示。
 *
 * `visible` 为 false（工具参数、空增量）时不推进最后可见时刻。
 */
function writeContent(
  cid: string,
  seq: number,
  at: number,
  kind: NonNullable<RequestProjection['lastContentKind']>,
  visible: boolean,
): void {
  writeRequest(
    cid,
    seq,
    (prev) =>
      prev
        ? {
            ...prev,
            phase: 'content',
            lastContentAt: at,
            lastContentKind: kind,
            lastVisibleAt: visible ? at : prev.lastVisibleAt,
          }
        : null,
    kind === 'tool_arguments',
  )
}

/** 撤下本轮的请求读数；`finished` 时同时清除轮次身份与用量，并把序号推进到该事件。 */
function clearLive(cid: string, runId: string, seq: number, finished: boolean): void {
  setState(
    produce((s) => {
      const v = s.views[cid]
      if (!v || !ownsLive(v, runId)) return
      if (finished) {
        v.usage = null
        v.runId = null
        v.liveSeq = Math.max(v.liveSeq, seq)
        v.runSeq = Math.max(v.runSeq, seq)
      }
      v.request = null
      v.generatingToolCall = false
    }),
  )
}

export const runEvents = handlers({
  'run.started': {
    conversation(ev, cid, seq) {
      setState(
        produce((s) => {
          const v = s.views[cid]
          if (!v) return
          /*
           * 对齐本轮回答所对应的用户气泡。
           *
           * 界面上按回车发送的气泡由客户端乐观插入，带有 `local_` 前缀的本地 id；
           * 而目标自动继续、定时触发、跟进消息自动发送三条路径没有客户端动作，气泡只能来自该
           * 事件。两种情况按同一规则处理：末条气泡带有本地 id 且正文一致时才把 id
           * 替换为账本中的真值，否则补充一条；补充后实时状态与刷新后从账本投影的状态
           * id 相同。
           *
           * 本地 id 条件不能省略。只比较正文时，若同一会话中重复发送同一段正文
           * （定时任务每次发送同一句 prompt），第二轮会认领上一轮已落库的
           * 气泡，界面上缺少本轮的用户消息。
           *
           * 由回执发起的轮次不做对齐：它没有乐观插入的气泡可对齐，形态也不是气泡。
           */
          if (ev.userMessage && ev.userMessageId && ev.userMessage.origin) {
            v.transcript.push({
              id: ev.userMessageId,
              kind: 'receipt',
              text: ev.userMessage.content,
              origin: ev.userMessage.origin,
            })
          } else if (ev.userMessage && ev.userMessageId) {
            let last = v.transcript.length - 1
            while (last >= 0 && v.transcript[last]!.kind !== 'user') last--
            const hit = last >= 0 ? v.transcript[last]! : null
            if (hit?.id.startsWith(LOCAL_ID_PREFIX) && hit.text === ev.userMessage.content) {
              hit.id = ev.userMessageId
            } else {
              v.transcript.push({
                id: ev.userMessageId,
                kind: 'user',
                text: ev.userMessage.content,
                ...(ev.userMessage.attachments?.length
                  ? { attachments: ev.userMessage.attachments }
                  : {}),
              })
            }
          }
        }),
      )
      setState(
        produce((s) => {
          const v = s.views[cid]
          // 快照已包含该事件：快照之后迟到的开始事件不得重置计时与读数。
          if (!v || seq <= v.liveSeq) return
          v.liveSeq = seq
          v.runSeq = seq
          v.runId = ev.runId
          /*
           * 本机按下发送时已写入按下的时刻（`sendMessage`），保留它：计时的起止都取本机时钟。
           * 其余情况（其他设备发送、服务端自行发起）把服务端的开始时刻换算为本机时刻。
           * 不要直接写入 `ev.startedAt`：它取服务端时钟，与本机 `Date.now()` 相减时两台设备的时钟差计入耗时。
           */
          v.runStartedAt ??= client.localTime(ev.startedAt)
          v.runUserMessageId = ev.userMessageId
          v.error = null
          v.usage = null
          v.request = null
          v.generatingToolCall = false
        }),
      )
    },
    active(ev) {
      setState(
        produce((s) => {
          s.notice = null
          s.fileChanges = []
          // 不清除待办：它是会话的进度，不是本轮的临时读数，
          // 一轮完成三项、下一轮继续第四项是常态。清除后，中断再继续时
          // 清单会整体消失，直到模型下次整表提交才恢复（`write_todos` 是整表语义，
          // 不一定每轮都调用）。此处清空的都是「执行完毕即失效」的读数
          // （用量、错误、本轮修改的文件），待办不属于此类。
          s.lastRunId = ev.runId
        }),
      )
    },
  },

  'run.request': {
    conversation(ev, cid, seq) {
      writeRequest(
        cid,
        seq,
        (prev) => ({
          requestId: ev.requestId,
          attempt: ev.attempt,
          max: ev.max,
          phase: ev.phase,
          retryReason:
            ev.attempt > 0 && ev.attempt === prev?.attempt ? (prev.retryReason ?? null) : null,
          // 发出即结束等待：清除截止点，保留次数。
          backoffUntil: null,
          sentAt:
            ev.phase === 'sent'
              ? ev.at
              : prev?.requestId === ev.requestId
                ? (prev?.sentAt ?? null)
                : null,
          headersAt: ev.phase === 'headers' ? ev.at : null,
          lastContentAt: null,
          lastContentKind: null,
          lastVisibleAt: null,
        }),
        false,
      )
    },
  },

  'run.retrying': {
    conversation(ev, cid, seq) {
      if (ev.failedThinkingStepIds.length > 0) {
        const failed = new Set<string>(ev.failedThinkingStepIds)
        setState(
          produce((s) => {
            const v = s.views[cid]
            if (!v) return
            // 重发事件携带 AgentLoop 本次尝试实际创建的 step id。不能按「末尾的思考」删除：
            // 同一 run 的前几个工具轮也有已完成的思考，按位置删除会把有效内容一并删除。
            v.transcript = v.transcript.filter(
              (item) => item.kind !== 'thinking' || !failed.has(item.id),
            )
          }),
        )
      }
      writeRequest(
        cid,
        seq,
        () => ({
          requestId: ev.requestId,
          attempt: ev.attempt,
          max: ev.max,
          phase: 'backoff',
          retryReason: ev.reason ?? null,
          backoffUntil: ev.at + ev.backoffMs,
          sentAt: null,
          headersAt: null,
          lastContentAt: null,
          lastContentKind: null,
          lastVisibleAt: null,
        }),
        false,
      )
    },
  },

  // 思考与正文分别合帧，先到达的先写入：正文到达时先写入缓冲中的思考，反之亦然，
  // 否则同一次回复中的「思考 → 正文 → 第二段思考」会以错误顺序写入。
  'text.delta': {
    flush: false,
    conversation(ev, cid, seq) {
      flushThinking()
      pushText(cid, ev.stepId, ev.delta)
      writeContent(cid, seq, ev.at, 'text', ev.delta.length > 0)
    },
  },
  'thinking.delta': {
    flush: false,
    conversation(ev, cid, seq) {
      flushText()
      pushThinking(cid, ev.stepId, ev.delta)
      writeContent(cid, seq, ev.at, 'thinking', ev.delta.length > 0)
    },
  },
  'tool.generating': {
    flush: false,
    conversation(ev, cid, seq) {
      writeContent(cid, seq, ev.at, 'tool_arguments', false)
    },
  },

  usage: {
    conversation(ev, cid) {
      setState('views', cid, 'usage', ev.usage)
    },
  },

  compaction: {
    conversation(ev, cid) {
      setState(
        produce((s) => {
          const items = s.views[cid]?.transcript
          if (!items) return
          const id = `cmp_${ev.runId}_${ev.stepSeq}`
          const existing = items.find((t) => t.id === id)
          const compaction: NonNullable<TranscriptItem['compaction']> = {
            runId: ev.runId,
            phase: ev.phase,
            ...(ev.stage ? { stage: ev.stage } : {}),
            ...(ev.reasonCode ? { reasonCode: ev.reasonCode } : {}),
            ...(ev.summarized === undefined ? {} : { summarized: ev.summarized }),
            ...(ev.manifest
              ? {
                  revision: ev.manifest.revision,
                  compactedMessages: ev.manifest.compactedMessageCount,
                }
              : {}),
          }
          if (existing) {
            existing.compaction = latestCompaction(existing.compaction, compaction)
            return
          }
          items.push({
            id,
            kind: 'compaction',
            text: '',
            compaction,
          })
        }),
      )
    },
  },

  'run.error': {
    conversation(ev, cid, seq) {
      setState(
        produce((s) => {
          const v = s.views[cid]
          if (!v) return
          // 已知另一轮正在运行时不写入：该报错属于较早的一轮，或不属于任何轮次，
          // 写入后会显示在正在运行那一轮的收尾条上。
          if (!ownsLive(v, ev.runId)) return
          v.error = { code: ev.code, message: ev.message }
          /*
           * 不要在此处清除「运行中」。终态由服务端的 `conversation.busy`
           * 给出：loop 之外抛出的错误（未配置 API key、档案解析失败）没有
           * `run.finished`，但 `run-control.ts` 的 finally 必定释放占用，
           * 占位与释放是忙闲的唯一裁决点。在此处补充客户端判断，
           * 会使「哪条会话在运行」形成第二份记录。
           */
        }),
      )
      clearLive(cid, ev.runId, seq, false)
    },
  },

  'run.finished': {
    conversation(ev, cid, seq) {
      setState(
        produce((s) => {
          const v = s.views[cid]
          if (!v) return
          for (const item of v.transcript) {
            if (item.compaction?.runId === ev.runId && item.compaction.phase === 'started') {
              item.compaction = { runId: ev.runId, phase: 'failed', reasonCode: 'aborted' }
            }
          }
          // 较早一轮迟到的收尾仍写入会话流，但不读取、不清空当前一轮的实时读数。
          const owns = ownsLive(v, ev.runId)
          // 收尾读数写入为一个条目，不写入全局字段：每轮一条，
          // 刷新后由 `reloadActiveConversation` 从 run 行原样重建。
          // 历史页已折叠出同一轮的条目时不再追加：快照之前结束的一轮，其事件可能在快照之后才到达。
          if (!v.transcript.some((t) => t.id === `run_${ev.runId}`)) {
            v.transcript.push({
              id: `run_${ev.runId}`,
              kind: 'run',
              text: '',
              run: {
                runId: ev.runId,
                stopReason: ev.stopReason,
                usage: ev.usage,
                startedAt: (owns ? v.runStartedAt : null) ?? Date.now(),
                endedAt: Date.now(),
                // 前一条 `run.error` 的正文（总是在 finished 之前到达），没有时为停止依据
                // （待办受阻的条件、无进展的判据）。服务端按同一顺序写入 `runs.error_message`，
                // 刷新后由投影层原样恢复。
                errorMessage: (owns ? v.error?.message : null) ?? ev.stopDetail ?? null,
              },
            })
          }
          if (!owns) return
          /*
           * 错误正文已交给本轮的条目，须清除会话上的错误。
           *
           * 不清除时同一句话同时显示在读数条与错误卡上，用户会看到两遍。
           * 错误卡只用于没有 run 收尾条可附加的情况（未配置 key、
           * 档案解析失败），这些情况不会执行到此处。
           */
          v.error = null
          v.runStartedAt = null
        }),
      )
      // 本轮执行完毕，重新读取该轮的变更：实时回执逐条追加，无法折叠出整轮的净效果。
      void refreshLatestChangeTurn(cid)
      clearLive(cid, ev.runId, seq, true)
    },
  },
})
