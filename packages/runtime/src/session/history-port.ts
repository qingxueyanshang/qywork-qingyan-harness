/** 已折叠历史的读取通道（`HistoryPort`）：按地址取回消息与执行记录，以及全文搜索。 */

import { envelopeResult, imagesOf, textsOf, videosOf } from '@qywork/agent'
import type { ConversationId, RunId, Step } from '@qywork/core'
import {
  type ContentStore,
  getConversation,
  listMessages,
  listRuns,
  listSteps,
  loadToolImages,
  type Store,
} from '@qywork/store'
import type { HistoryPort, HistoryStep } from '@qywork/tools'

/**
 * 执行记录的取回形式：图像字节从 outcome 中拆出、作为图像块返回，outcome 文本中不保留 base64。
 * 取回的图片与 `read_file` 写入执行记录时的字节相同。附带文本块（`textsOf`）同样拆出，
 * 取回结果中仍是独立的文本块并带声明的特征计数。
 */
function stepRecord(st: Step): HistoryStep {
  const payload = (st.payload ?? {}) as { args?: unknown; outcome?: Record<string, unknown> }
  const outcome = payload.outcome ?? {}
  const data =
    outcome.data && typeof outcome.data === 'object'
      ? (outcome.data as Record<string, unknown>)
      : undefined
  // 调用方已经 `loadToolImages` 还原字节；正文缺失的图像已移出列表并计入 `imagesMissing`。
  const images = imagesOf(data).flatMap((i) =>
    i.source.kind === 'base64' ? [{ data: i.source.data, mime: i.mime }] : [],
  )
  const videos = videosOf(data)
  const texts = textsOf(data)
  const rest = envelopeResult(data)
  const { data: _dropped, ...withoutData } = outcome
  return {
    tool: st.toolName ?? 'unknown',
    status: st.status,
    args: JSON.stringify(payload.args ?? {}),
    outcome: JSON.stringify(data ? { ...withoutData, ...(rest ? { data: rest } : {}) } : outcome),
    ...(images.length ? { images } : {}),
    ...(videos.length ? { videos } : {}),
    ...(texts.length ? { texts } : {}),
  }
}

/**
 * 一个会话的历史端口。子 agent 的历史使用同一实现、按其会话 id 构造，
 * `forSubagent` 只接受本会话派发的子 agent。
 */
export function historyPortFor(
  store: Store,
  content: ContentStore,
  cid: ConversationId,
): HistoryPort {
  const port: Omit<HistoryPort, 'forSubagent'> = (() => {
    /**
     * 将摘要中的 `<runId>:<stepId>` 解析为对应的 step。
     *
     * 单独的 step id 跨 run 不唯一，而摘要引用的是较早的记录，因此地址必须包含 runId。
     */
    const compositeStep = (id: string): Step | null => {
      const cut = id.indexOf(':')
      if (cut <= 0) return null
      const runId = id.slice(0, cut) as RunId
      const stepId = id.slice(cut + 1)
      // 只接受本会话的 run：其他会话的 step id 返回不存在。
      if (!listRuns(store, cid).some((run) => run.id === runId)) return null
      return listSteps(store, runId).find((x) => String(x.id) === stepId) ?? null
    }
    const userStepOf = (id: string): Step | null => {
      const st = compositeStep(id)
      return st?.kind === 'user' ? st : null
    }
    /**
     * 助手正文的取回地址指向该次生成的第一条 text step（`transcript.ts` 的 `StepUnit.textStep`）。
     * 一次生成的正文可能被思考分隔为多条 text step，按同一个 `providerBatchId` 拼接为完整正文，
     * 与压缩时交给摘要器的内容逐字相同。
     */
    const assistantTextOf = (id: string): string | null => {
      const st = compositeStep(id)
      if (st?.kind !== 'text') return null
      if (!st.providerBatchId) return st.content ?? ''
      return listSteps(store, st.runId)
        .filter((x) => x.kind === 'text' && x.providerBatchId === st.providerBatchId)
        .map((x) => x.content ?? '')
        .join('')
    }
    return {
      message: (id) => {
        const m = listMessages(store, cid, null).find((x) => x.id === id)
        if (m) return { role: m.role, content: m.content }
        /*
         * run 内注入的用户消息不在 `messages` 表中，摘要给出的地址是
         * `<runId>:<stepId>`。缺少此回退时，用户中途调整方向的消息
         * 一旦被折叠进摘要就无法取回：摘要中有地址，取回却报告不存在。
         */
        const st = userStepOf(id)
        if (st) return { role: 'user' as const, content: st.content ?? '' }
        const text = assistantTextOf(id)
        return text === null ? null : { role: 'assistant' as const, content: text }
      },
      step: (id) => {
        const st = compositeStep(id)
        // 注入的用户消息与助手正文由 `message` 取回：此处的返回结构是
        // `{tool,status,args,outcome}`，用于非工具记录时只会返回 `tool:'unknown'`
        // 与两个空 JSON，看似已处理，实际未返回任何内容。
        if (st?.kind !== 'tool_action') return null
        return stepRecord(loadToolImages(store, content, [st])[0]!)
      },
      byCallId: (callId) => {
        for (const run of listRuns(store, cid)) {
          const st = listSteps(store, run.id).find((x) => x.toolCallId === callId)
          if (st) return stepRecord(loadToolImages(store, content, [st])[0]!)
        }
        return null
      },
      search: (query, limit) => {
        const hits: { id: string; kind: 'message' | 'step'; line: string }[] = []
        const needle = query.toLowerCase()
        for (const m of listMessages(store, cid, null)) {
          if (hits.length >= limit) return hits
          if (m.content.toLowerCase().includes(needle)) {
            hits.push({ id: m.id, kind: 'message', line: m.content })
          }
        }
        for (const run of listRuns(store, cid)) {
          for (const st of listSteps(store, run.id)) {
            if (hits.length >= limit) return hits
            /*
             * run 内注入的用户消息按**消息**报告，不按执行记录报告：正文在 `content`
             * 列而不在 payload 中，取回也由 `message` 负责。报告为 step 时，
             * 摘录显示的是空 payload，而模型用该 id 调用 `step` 只会得到 null。
             */
            // 助手正文同理：正文位于 text step 的 `content` 中，按消息报告、由 `message` 取回。
            if (st.kind === 'user' || st.kind === 'text') {
              const text = st.content ?? ''
              if (text.toLowerCase().includes(needle)) {
                hits.push({ id: `${run.id}:${st.id}`, kind: 'message', line: text })
              }
              continue
            }
            const body = `${st.toolName ?? ''} ${JSON.stringify(st.payload ?? {})}`
            if (body.toLowerCase().includes(needle)) {
              hits.push({ id: `${run.id}:${st.id}`, kind: 'step', line: body })
            }
          }
        }
        return hits
      },
    }
  })()
  return {
    ...port,
    forSubagent: (id) => {
      const child = getConversation(store, id as ConversationId)
      return child?.parentConversationId === cid ? historyPortFor(store, content, child.id) : null
    },
  }
}
