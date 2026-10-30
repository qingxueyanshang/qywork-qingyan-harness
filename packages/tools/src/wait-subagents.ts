/**
 * 在本轮内等待子 agent 的回执。
 *
 * 子 agent 与工作流节点完成后，回执排入本会话的队列，在下一个 step 边界作为一条消息注入。
 * 本工具只等待到回执进入队列为止，返回等待结果而不返回回执内容：同一条回执只经由队列送达，
 * 工具结果中再写一份时模型会收到两次。等待期间不调用模型。
 */

import type { ToolContext, ToolSpec } from '@qywork/agent'

/** 未指定时的等待上限（秒）。 */
const DEFAULT_TIMEOUT = 600
/** 单次等待的上限（秒）。等待期间本轮保持运行，超过上限后由模型决定继续等待还是先做其他工作。 */
const MAX_TIMEOUT = 1800

export const waitSubagentsTool: ToolSpec = {
  name: 'wait_subagents',
  description:
    '在本轮内等待本会话正在执行的子 agent 或工作流节点送回下一条回执，回执作为下一条消息送达；等待期间不调用模型。' +
    '收到回执、用户发来消息、到达 timeout_seconds 或本会话没有正在执行的子 agent 时返回。' +
    '一次只等到一条回执；还在等其他子 agent 时，读完这条回执后再次调用。',
  parameters: {
    type: 'object',
    properties: {
      timeout_seconds: {
        type: 'number',
        description: `最长等待秒数，默认 ${DEFAULT_TIMEOUT}，上限 ${MAX_TIMEOUT}`,
      },
    },
    additionalProperties: false,
  },
  actionKind: 'read',
  objectLabel: '子 agent 回执',
  category: 'session',
  facet: '协作',
  summary: '等待子 agent 的回执',
  targetExtractor: () => null,
  // 只读取本会话的派发状态，没有外部副作用。
  permissionEffect: 'internal_control',
  parallelSafe: false,

  async fn(args: Record<string, unknown>, ctx: ToolContext) {
    const delegate = ctx.delegate
    if (!delegate) {
      // 正常情况下不会执行到此处：没有派发通道时本工具不注册。
      return { status: 'failure' as const, message: '本次执行没有派发通道' }
    }
    const raw = args.timeout_seconds ?? DEFAULT_TIMEOUT
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      return { status: 'failure' as const, message: 'timeout_seconds 必须是正数' }
    }
    const seconds = Math.min(raw, MAX_TIMEOUT)
    const result = await delegate.awaitReceipt(seconds * 1000, ctx.signal)
    if (result === 'received') {
      return { status: 'success' as const, message: '已收到回执，内容见下一条消息' }
    }
    if (result === 'message') {
      return { status: 'success' as const, message: '用户发来消息，内容见下一条消息' }
    }
    if (result === 'queued') {
      return {
        status: 'success' as const,
        message: '用户有一条排在本轮之后的消息，本轮结束后才会送达；继续等待会推迟它',
      }
    }
    if (result === 'idle') {
      return {
        status: 'success' as const,
        message: '本会话没有正在执行的子 agent，也没有待送达的回执',
      }
    }
    const running = delegate.inflight().map((s) => s.name)
    return {
      status: 'success' as const,
      message: `等待 ${seconds} 秒未收到回执；仍在执行：${running.join('、') || '无'}`,
    }
  },
}
