/**
 * `read_history`：按需读取已折叠的会话历史。
 *
 * 本工具与上下文压缩配合。压缩是投影而不是删除：`messages` 与 `steps` 保持不变，
 * 折叠的只是本次请求发送的内容。但摘要生成之后模型只掌握结论，
 * 没有本工具就无法取回原文：数据保存在库中，却没有消费者。
 *
 * 摘要正文中的 `[message:…]` / `[action:…]` 标记是入口，模型据此取回原文。
 *
 * 与 `read_resource` 的分工：`read_resource` 读取工具产出的正文（超过投递上限而落盘的 `rs_xxx`），
 * 本工具读取会话历史本身（用户说过什么、模型说过什么、哪一步调用了什么工具、得到什么结果）。
 * 两者不重叠，也不互为后备：`rs_xxx` 在本工具中无法查询，反之亦然。
 *
 * 边界：读取量使用与 `read_file` 同一份投递额度。单条超出额度时投递头部，
 * 完整内容存入正文库，由 `read_resource` 续读：历史条目没有范围参数，不存储则无法完整读取。
 */

import { chargeBatchBudget, outcomeTokens, recordBatchSpent, type ToolSpec } from '@qywork/agent'
import { deliverReadable } from './sink.ts'

/** 一次搜索最多返回的命中条数。更多的命中模型无法读完，只会耗尽预算。 */
const MAX_HITS = 40

/** 单条命中的摘录长度。足以判断是否为目标条目，需要更多内容时按 id 取全文。 */
const HIT_EXCERPT = 200

function excerpt(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

export const readHistoryTool: ToolSpec = {
  name: 'read_history',
  description:
    '读取被压缩折叠的会话历史原文。上下文压缩后的摘要中带有 [message:xxx] 与 ' +
    '[action:xxx] 标记，传入标记中的 id 返回该条目的完整内容。' +
    'id 未知时传 query 检索（返回命中行与对应 id）。' +
    '已收纳的工具结果只剩信封，传入信封中的 call_id 返回完整的参数与结果；' +
    '信封中带有 images_omitted 时，同样用 call_id 取回该次读取的图片。' +
    '读取范围是本会话与本会话派发的子 agent 的历史，范围外的 id 返回不存在；' +
    '工具保存到磁盘的较长输出（rs_xxx）用 read_resource 读取。' +
    '传 subagent（本会话子 agent 的 id）时读取该子 agent 的历史，其余参数含义不变。',
  parameters: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: '消息 id，来自摘要中的 [message:xxx]' },
      step_id: {
        type: 'string',
        description: '执行记录 id，来自摘要中的 [action:xxx]，形如 <runId>:<stepId>',
      },
      call_id: {
        type: 'string',
        description: '工具调用 id，来自已收纳的工具结果信封中的 call_id 字段',
      },
      query: {
        type: 'string',
        description: '在整条会话历史中搜索该子串，返回命中项与各自的 id。id 未知时使用。',
      },
      subagent: {
        type: 'string',
        description: '本会话子 agent 的 id。填写时读取该子 agent 的历史，不填时读取本会话的历史。',
      },
    },
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '会话历史',
  category: 'session',
  facet: '中间内容',
  summary: '按编号读取已折叠的历史原文',
  targetExtractor: (a) =>
    typeof a.message_id === 'string'
      ? a.message_id
      : typeof a.step_id === 'string'
        ? a.step_id
        : typeof a.query === 'string'
          ? a.query
          : null,
  // 读取的是本会话的账本，不访问工作区，也不访问网络。
  permissionEffect: 'internal_control',
  parallelSafe: true,

  async fn(args, ctx) {
    const subagent = typeof args.subagent === 'string' ? args.subagent.trim() : ''
    const history = subagent ? ctx.history?.forSubagent(subagent) : ctx.history
    if (subagent && ctx.history && !history) {
      return {
        status: 'failure',
        message: `本会话中没有子 agent ${subagent}`,
        errorKind: 'not_found',
      }
    }
    if (!history) {
      // 如实说明没有该通道，不要报告「未找到」：后者会使模型认为 id 写错，
      // 进而用多轮推测一个无法取得的 id。
      return {
        status: 'failure',
        message: '本次执行没有会话账本，无法读取历史',
        errorKind: 'history_unavailable',
      }
    }

    const messageId = typeof args.message_id === 'string' ? args.message_id.trim() : ''
    const stepId = typeof args.step_id === 'string' ? args.step_id.trim() : ''
    const callId = typeof args.call_id === 'string' ? args.call_id.trim() : ''
    const query = typeof args.query === 'string' ? args.query.trim() : ''

    if (!messageId && !stepId && !callId && !query) {
      return { status: 'failure', message: '需提供 message_id、step_id、call_id、query 之一' }
    }

    if (messageId) {
      const m = history.message(messageId)
      if (!m) {
        return {
          status: 'failure',
          message: `本会话中没有消息 ${messageId}`,
          errorKind: 'not_found',
        }
      }
      const message = `读取消息 ${messageId}（${m.role === 'user' ? '用户' : '助手'}）`
      return deliverReadable(ctx, {
        toolName: 'read_history',
        sourceType: 'history:message',
        whole: { message, data: { role: m.role, content: m.content } },
        body: m.content,
        partial: (head, note) => ({
          message: message + note,
          data: { role: m.role, content: head, truncated: true },
        }),
      })
    }

    if (stepId || callId) {
      const st = stepId ? history.step(stepId) : history.byCallId(callId)
      const shown = stepId || callId
      if (!st) {
        return {
          status: 'failure',
          message: `本会话中没有执行记录 ${shown}`,
          errorKind: 'not_found',
        }
      }
      const images = st.images ?? []
      const videos = st.videos ?? []
      const kinds = [images.length ? '图片' : '', videos.length ? '视频' : ''].filter(Boolean)
      const message = `读取执行记录 ${shown}（${st.tool} · ${st.status}${kinds.length ? `，含${kinds.join('与')}` : ''}）`
      // 图片按与 `read_file` 相同的口径计入额度，每张计一份 `MEDIA_TOKENS`（在 `outcomeTokens` 中计算）。
      const media = { ...(images.length ? { images } : {}), ...(videos.length ? { videos } : {}) }
      return deliverReadable(ctx, {
        toolName: 'read_history',
        sourceType: 'history:step',
        whole: {
          message,
          data: { tool: st.tool, status: st.status, args: st.args, outcome: st.outcome, ...media },
        },
        // 超出额度时参数与结果按原文顺序拼接为一段续读内容，头部放入 content。
        body: `${st.args}\n${st.outcome}`,
        partial: (head, note) => ({
          message: message + note,
          data: { tool: st.tool, status: st.status, content: head, truncated: true, ...media },
        }),
      })
    }

    const hits = history.search(query, MAX_HITS)
    if (hits.length === 0) {
      return { status: 'success', message: `历史中没有「${query}」`, data: { hits: [] } }
    }
    const lines = hits.map(
      (h) =>
        `[${h.kind === 'message' ? 'message' : 'action'}:${h.id}] ${excerpt(h.line, HIT_EXCERPT)}`,
    )
    // 命中数达到上限时明确说明：模型据此判断是否缩小 query 的范围；
    // 不说明时该结果会被视为全部命中。
    const found = `命中 ${hits.length} 条${hits.length >= MAX_HITS ? '（已达上限，可能还有更多）' : ''}`
    // 超出额度时从末尾开始减少条数：命中可以用更窄的 query 重新搜索，因此不保存正文。
    const outcomeOf = (kept: number) => ({
      message: kept < lines.length ? `${found}，上下文剩余空间仅能容纳前 ${kept} 条` : found,
      data: { hits: lines.slice(0, kept) },
    })
    for (let kept = lines.length; kept > 1; kept--) {
      const outcome = outcomeOf(kept)
      if (chargeBatchBudget(ctx, outcomeTokens(outcome, ctx.density)).ok) {
        return { status: 'success', ...outcome }
      }
    }
    // 一条都无法容纳时仍返回第一条：报告失败的回合不产出结果，超出的部分由下一次发送前的压缩回收。
    const first = outcomeOf(1)
    if (!chargeBatchBudget(ctx, outcomeTokens(first, ctx.density)).ok) {
      recordBatchSpent(ctx, outcomeTokens(first, ctx.density))
    }
    return { status: 'success', ...first }
  },
}
