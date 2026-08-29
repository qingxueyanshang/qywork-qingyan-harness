/**
 * `@qywork/team` 的对外面。**这里列的就是承诺，没列的就是内部实现。**
 * 具名导出，不用 `export *`（B6）；加一行之前先确认它真有包外调用点（B3）。
 */

// 外部 CLI 的执行器：编排器在包内用，server 的派活端口在包外用
export { runCli } from './cli-backend.ts'
// 本机装了哪几家外部 CLI：server 的设置页端点与派活端口按它解析目标
export { type DetectedCli, detectClis, findCli } from './cli-detect.ts'
// 编排器：server 的派活端口（`workflow` 工具那条）是唯一入口
export { type OrchestratorState, TeamOrchestrator } from './orchestrator.ts'
// 配置形状：runtime 解析、server 消费
export type { CliAgent, PlanNode, Role, TeamRules } from './types.ts'
export { CLI_PREFIX } from './types.ts'
