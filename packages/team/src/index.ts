/**
 * `@qywork/team` 的对外面。
 *
 * **这里列的就是承诺，没列的就是内部实现。** 之前三个模块走 `export *`，
 * 把十五个符号推到包外，其中七个没有任何包外调用点。
 * 现在只导出真实有外部消费者的，逐个核过调用点。
 *
 * 加新的对外符号时：先确认它真的有包外调用点，再往下面加一行。
 */

// 本机装了哪几家外部 CLI：server 的设置页端点与派活工具按它解析目标
export { type DetectedCli, detectClis, findCli } from './cli-detect.ts'
// 编排器：server 的 team.run 指令是唯一入口
export { TeamOrchestrator } from './orchestrator.ts'
// 配置形状：runtime 解析、server 消费
export type { CliAgent, PlanNode, Role, TeamRules } from './types.ts'
export { CLI_PREFIX } from './types.ts'
