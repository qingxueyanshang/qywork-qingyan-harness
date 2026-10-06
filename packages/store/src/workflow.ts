/**
 * workflow 的恢复权威：同一父会话中已写入数据库的 workflow 工具 step。
 *
 * 没有第二份运行表。图的结构、每一次审查、每一批回执都在这些 step 的
 * args 与 outcome 中，由 `foldWorkflow` 折叠为投影。本模块只负责按时间顺序读取它们。
 */

import {
  type ConversationId,
  type NodePhase,
  parseWorkflowCall,
  type StepId,
  type WorkflowCallRecord,
} from '@qywork/core'
import type { Store } from './db.ts'
import { listRuns, listSteps } from './repos.ts'

/**
 * 会话中的全部 workflow 调用记录，按 run 与 seq 排序。
 *
 * `exclude` 是正在执行的 step：它尚无结果，读取它等于将请求当作事实。
 * 续接调用必须传入自身的 stepId；只读快照不传。
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
        ...(payload.nodes ? { nodes: payload.nodes } : {}),
        status:
          step.status === 'running' ? 'running' : step.status === 'success' ? 'success' : 'failure',
      })
    }
  }
  return records
}

/**
 * 会话派发的每个子 agent 最后一次出现在卡片上时的状态，键是子 agent 的会话 id。
 * 单个派发与工作流图的节点使用同一来源（step payload 的 `nodes`），按 step 顺序后者覆盖前者。
 */
export function latestSubagentPhases(
  store: Store,
  conversationId: ConversationId,
): Map<string, NodePhase> {
  const out = new Map<string, NodePhase>()
  for (const run of listRuns(store, conversationId)) {
    for (const step of listSteps(store, run.id)) {
      if (step.kind !== 'tool_action') continue
      if (step.toolName !== 'workflow' && step.toolName !== 'subagent') continue
      const payload = step.payload
      if (payload?.kind !== 'tool_call' && payload?.kind !== 'tool_result') continue
      for (const state of Object.values(payload.nodes ?? {})) {
        if (state.subagentId) out.set(state.subagentId, state.phase)
      }
    }
  }
  return out
}

/**
 * 会话中每张工作流图首次派发的 stepId。首次派发 step 的 id 即 workflowId
 * （`runGraph` 以它作为图的标识），因此只选取 args 能解析为首次派发的 step。
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
