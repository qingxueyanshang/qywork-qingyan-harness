/**
 * workflow 的恢复权威：同一父会话里已经落库的 workflow 工具 step。
 *
 * **没有第二份运行表。** 图的形状、每一次审查、每一批回执全在这些 step 的
 * args 与 outcome 里，`foldWorkflow` 把它们折成投影。这里只负责把它们按时间取出来。
 */

import {
  type ConversationId,
  parseWorkflowCall,
  type StepId,
  type WorkflowCallRecord,
} from '@qywork/core'
import type { Store } from './db.ts'
import { listRuns, listSteps } from './repos.ts'

/**
 * 这条会话里全部 workflow 调用记录，按 run 与 seq 的顺序。
 *
 * `exclude` 是正在执行的那一步：它还没有结果，取进来等于把请求当成事实。
 * 续接调用必须传它自己的 stepId；只读快照不传。
 */
export function listWorkflowRecords(
  store: Store,
  conversationId: ConversationId,
  exclude?: StepId,
): WorkflowCallRecord[] {
  const records: WorkflowCallRecord[] = []
  for (const run of listRuns(store, conversationId)) {
    for (const step of listSteps(store, run.id)) {
      if (step.id === exclude || step.kind !== 'tool_action' || step.toolName !== 'workflow') {
        continue
      }
      const payload = step.payload
      if (payload?.kind !== 'tool_call' && payload?.kind !== 'tool_result') continue
      records.push({
        stepId: step.id,
        ...(payload.args ? { args: payload.args } : {}),
        ...(payload.kind === 'tool_result' ? { outcome: payload.outcome } : {}),
        status:
          step.status === 'running' ? 'running' : step.status === 'success' ? 'success' : 'failure',
      })
    }
  }
  return records
}

/**
 * 这条会话里每一张图的首派记录 stepId。首派 step 的 id 就是 workflowId
 * （`runGraph` 用它当图的身份），所以只认「args 能解析成首派」的那些。
 */
export function workflowIdsOf(records: readonly WorkflowCallRecord[]): string[] {
  return records
    .filter((record) => {
      if (!record.args) return false
      const parsed = parseWorkflowCall(record.args)
      return parsed.ok && parsed.call.kind === 'start'
    })
    .map((record) => record.stepId)
}
