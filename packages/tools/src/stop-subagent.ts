/**
 * 停止本会话中一个正在执行的子 agent。
 *
 * 只停止本次执行，子 agent 的会话保留：之后用 `subagent` 填写同一 id 再次派发，即在原会话中继续，
 * 停止与续接合起来即暂停与恢复，不另设暂停状态。停止由父会话发起，该子 agent 不再发送回执。
 *
 * 只能停止本会话派出的子 agent：派发端口按本会话查找，其他会话的子 agent 不可见。
 */

import type { ToolContext, ToolSpec } from '@qywork/agent'
import { idArg } from './args.ts'
import { resolveSubagentRef } from './subagent.ts'

export const stopSubagentTool: ToolSpec = {
  name: 'stop_subagent',
  description:
    '停止本会话中一个正在执行的子 agent，用于派发有误、任务重复或需要改派的情形。只停止本次执行，子 agent 的会话保留，' +
    '之后用 subagent 填写同一 id 再次派发即在原会话中继续。停止后不会再收到该子 agent 本次任务的回执；' +
    'workflow 中的节点被停止后记为中断，其余节点照常执行，检查点回执照常送达。',
  parameters: {
    type: 'object',
    properties: {
      subagent: {
        type: 'string',
        description:
          '要停止的子 agent 的 id 或名称：派发时返回的 subagentId，或运行上下文「本会话的子 agent」清单中的 id 与名称。',
      },
    },
    required: ['subagent'],
    additionalProperties: false,
  },
  actionKind: 'edit',
  objectLabel: '子 agent 状态',
  category: 'session',
  facet: '协作',
  summary: '停止子 agent',
  targetExtractor: (a) => (typeof a.subagent === 'string' ? a.subagent : null),
  // 只停止本会话自己派出的执行，没有外部副作用。
  permissionEffect: 'internal_control',
  parallelSafe: false,

  async fn(args: Record<string, unknown>, ctx: ToolContext) {
    const delegate = ctx.delegate
    if (!delegate) {
      // 正常情况下不会执行到此处：没有派发通道时本工具不注册。
      return { status: 'failure' as const, message: '本次执行没有派发通道' }
    }
    const ref = idArg(args.subagent)
    if (!ref) return { status: 'failure' as const, message: '需填写要停止的子 agent 的 id 或名称' }
    const found = await resolveSubagentRef(delegate, ref)
    if ('error' in found) return { status: 'failure' as const, message: found.error }
    const { id } = found
    const res = delegate.stop(id)
    if (!res.ok) return { status: 'failure' as const, message: res.error }
    return {
      status: 'success' as const,
      message: `已停止子 agent ${res.name}（subagentId ${id}）；其会话保留，用 subagent 填写该 id 再次派发即在原会话中继续`,
      data: { subagentId: id },
    }
  },
}
