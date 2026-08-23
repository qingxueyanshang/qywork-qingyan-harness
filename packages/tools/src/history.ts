/**
 * `read_history` —— 把被折叠掉的会话历史按需读回来。
 *
 * 这是上下文压缩的另一半。压缩是投影不是删除：`messages` 与 `steps` 一个字节不动，
 * 折掉的只是「这一次请求发什么」。但摘要写好之后模型手里只剩结论，
 * 没有这个工具就回不到原文——数据在库里躺着，没有消费者。
 *
 * 摘要正文里的 `[message:…]` / `[action:…]` 标记就是入口，模型顺着它取回原文。
 *
 * ## 与 `read_resource` 的分界
 *
 * 那条读**工具产出的正文**（超过投递上限落盘的 `rs_xxx`），这条读**会话历史本身**
 * （用户说过什么、模型说过什么、哪一步调了什么工具拿到什么）。
 * 两者不重叠，也**不互相兜底**：`rs_xxx` 在这里查不到，反过来也一样。
 *
 * ## 边界
 *
 * 读回来的量走与 `read_file` 同一个投递预算（`chargeBatchBudget`）。
 * 没有这道闸的话，模型可以把刚折掉的内容整段读回来，压缩当场失效。
 */

import { chargeBatchBudget, type ToolContext, type ToolOutcome, type ToolSpec } from '@qywork/agent'
import { estimateText } from '@qywork/ai'

/** 一次搜索最多回多少条命中。再多模型也读不完，只会把预算烧光。 */
const MAX_HITS = 40

/** 单条命中的摘录长度。够看出「是不是这一条」，不够的用 id 取全文。 */
const HIT_EXCERPT = 200

function excerpt(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim()
  return flat.length <= limit ? flat : `${flat.slice(0, limit)}…`
}

/**
 * 投递预算检查。超了拒绝而不截断，与 `read_file` 同一口径：
 * 拒绝只产生一条约百字节的回执，截断产生的是满额正文而模型往往还得再读一次。
 */
function charged(ctx: ToolContext, text: string): ToolOutcome | null {
  const tokens = estimateText(text)
  const budget = chargeBatchBudget(ctx, tokens)
  if (budget.ok) return null
  return {
    status: 'failure',
    message:
      `这一段约 ${tokens} token，超出单次投递预算 ${budget.perCall}` +
      `（本批还剩 ${budget.batchRemaining}）。改用 query 精确搜，或分几轮取。`,
    errorKind: 'result_too_large',
  }
}

export const readHistoryTool: ToolSpec = {
  name: 'read_history',
  description:
    '读回被压缩折叠掉的会话历史原文。上下文压缩后的摘要里带着 [message:xxx] 与 ' +
    '[action:xxx] 标记，传入标记中的 id 返回该条的完整内容。' +
    'id 未知时传 query 检索（返回命中行与对应 id）。' +
    '被收纳过的工具结果只剩信封，传入信封里的 call_id 返回完整的参数与结果。' +
    '注意它读的是会话历史；工具落盘的大块输出（rs_xxx）用 read_resource。',
  parameters: {
    type: 'object',
    properties: {
      message_id: { type: 'string', description: '消息 id，来自摘要里的 [message:xxx]' },
      step_id: {
        type: 'string',
        description: '执行记录 id，来自摘要里的 [action:xxx]，形如 <runId>:<stepId>',
      },
      call_id: {
        type: 'string',
        description: '工具调用 id，来自被收纳过的工具结果信封里的 call_id 字段',
      },
      query: {
        type: 'string',
        description: '在整条会话历史里搜这个子串，返回命中项与各自的 id。id 未知时使用。',
      },
    },
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '会话历史',
  category: 'session',
  facet: '中间内容',
  summary: '按标记读回被折叠的历史原文',
  targetExtractor: (a) =>
    typeof a.message_id === 'string'
      ? a.message_id
      : typeof a.step_id === 'string'
        ? a.step_id
        : typeof a.query === 'string'
          ? a.query
          : null,
  // 读的是本会话自己的账本，不碰工作区也不出网。
  permissionEffect: 'internal_control',
  parallelSafe: true,

  async fn(args, ctx) {
    const history = ctx.history
    if (!history) {
      // 如实说没有这条通道，不要报「找不到」——那会让模型以为 id 写错了，
      // 然后拿几轮去猜一个根本取不到的东西。
      return {
        status: 'failure',
        message: '本次执行没有会话账本，读不了历史',
        errorKind: 'history_unavailable',
      }
    }

    const messageId = typeof args.message_id === 'string' ? args.message_id.trim() : ''
    const stepId = typeof args.step_id === 'string' ? args.step_id.trim() : ''
    const callId = typeof args.call_id === 'string' ? args.call_id.trim() : ''
    const query = typeof args.query === 'string' ? args.query.trim() : ''

    if (!messageId && !stepId && !callId && !query) {
      return { status: 'failure', message: '给 message_id、step_id、call_id、query 之一' }
    }

    if (messageId) {
      const m = history.message(messageId)
      if (!m) {
        return {
          status: 'failure',
          message: `这条会话里没有消息 ${messageId}`,
          errorKind: 'not_found',
        }
      }
      const text = m.content
      const over = charged(ctx, text)
      if (over) return over
      return {
        status: 'success',
        message: `读回消息 ${messageId}（${m.role === 'user' ? '用户' : '助手'}）`,
        data: { role: m.role, content: text },
      }
    }

    if (stepId || callId) {
      const st = stepId ? history.step(stepId) : history.byCallId(callId)
      const shown = stepId || callId
      if (!st) {
        return {
          status: 'failure',
          message: `这条会话里没有执行记录 ${shown}`,
          errorKind: 'not_found',
        }
      }
      const text = `${st.args}\n${st.outcome}`
      const over = charged(ctx, text)
      if (over) return over
      return {
        status: 'success',
        message: `读回执行记录 ${shown}（${st.tool} · ${st.status}）`,
        data: { tool: st.tool, status: st.status, args: st.args, outcome: st.outcome },
      }
    }

    const hits = history.search(query, MAX_HITS)
    if (hits.length === 0) {
      return { status: 'success', message: `历史里没有「${query}」`, data: { hits: [] } }
    }
    const lines = hits.map(
      (h) =>
        `[${h.kind === 'message' ? 'message' : 'action'}:${h.id}] ${excerpt(h.line, HIT_EXCERPT)}`,
    )
    const text = lines.join('\n')
    const over = charged(ctx, text)
    if (over) return over
    return {
      status: 'success',
      // 命中数达到上限时说出来：模型据此判断要不要把 query 写得更窄，
      // 不说的话它会以为这就是全部。
      message: `命中 ${hits.length} 条${hits.length >= MAX_HITS ? '（已达上限，可能还有更多）' : ''}`,
      data: { hits: lines },
    }
  },
}
