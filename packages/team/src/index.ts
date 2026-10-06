/**
 * `@qywork/team` 的对外接口。**此处列出的即对外承诺，未列出的均为内部实现。**
 * 使用具名导出，不用 `export *`（B6）；新增导出前先确认它确有包外调用方（B3）。
 */

// 外部 CLI 的执行器：编排器在包内使用，server 的派发端口在包外使用
export { runCli } from './cli-backend.ts'
// 本机已安装的外部 CLI：server 的设置页端点与派发端口据此解析目标
export { type DetectedCli, detectClis, findCli } from './cli-detect.ts'
// 推进器：server 的派发端口（`workflow` 工具对应的端口）是唯一入口
export {
  type AdvanceInput,
  type AdvanceResult,
  advance,
  type NodeDispatch,
  type OrchestratorReview,
  type PlanKnown,
  validatePlan,
} from './orchestrator.ts'
// 配置结构：runtime 解析、server 消费
export type { CliAgent, PlanNode, Role, TeamRules } from './types.ts'
