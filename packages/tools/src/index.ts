/**
 * `@qywork/tools` 的对外面。**这里列的就是承诺，没列的就是内部实现。**
 * 具名导出，不用 `export *`（B6）：后者会把 `buildBwrapArgv`、`parseFrontmatter`、
 * `clampBody` 这类纯内部符号一并推出包边界。加一行之前先确认它真有包外调用点（B3）。
 *
 * 包内互相引用与测试走相对路径，不受这份清单约束。
 */

import type { ToolRegistry } from '@qywork/agent'
import { editFileTool, listDirTool, readFileTool, writeFileTool } from './files.ts'
import { readGoalTool, updateGoalTool } from './goals.ts'
import { deleteMemoryTool, readMemoryTool, writeMemoryTool } from './memory.ts'
import { readResourceTool } from './resources.ts'
import { commandShell } from './sandbox.ts'
import { createScheduleTool, deleteScheduleTool, listSchedulesTool } from './schedules.ts'
import { globTool, grepTool } from './search.ts'
import { makeShellTool } from './shell.ts'
import { readSkillTool } from './skills.ts'
import { writeTodosTool } from './todos.ts'
import { webFetchTool, webSearchTool } from './web.ts'

// 记忆：runtime/session.ts 装配提示词时要读索引，server/api/memory.ts 要读写单条
export {
  listAllScopedEntries,
  listScopedEntries,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  MEMORY_DIR,
  MEMORY_SUBDIR,
  type MemoryEntry,
} from './memory.ts'
// 联网：runtime/capabilities.ts 给插件的 host.net.fetch 用
export { type SafetyOptions, safeFetch } from './net-safety.ts'
// 路径：工作区边界的唯一判据，runtime 与 server 都要
export {
  displayPath,
  IGNORED_DIRS,
  normalizeAdditionalDirectories,
  PROTECTED_DIRS,
  resolveInWorkspace,
} from './paths.ts'
// 命令跑在一个「先于监听端口出生」的子进程里。`qy serve` 绑端口前起它，
// 隐藏的 `runner` 子命令是它那一侧的入口。
export {
  type CommandRunner,
  type ProcessLike,
  runCommandRunner,
  startCommandRunner,
} from './runner.ts'
// 沙箱：cli 的 doctor/config、server 的握手都要报它
// `commandShell` / `probeBash` 一并出去：命令跑哪个 shell 由它说了算，判 platform 就是第二本账；
// 握手要报「这台机器有没有 bash」，没有时还要把原因说给用户听
// `collectProcess` 与 `spawnGuarded` 是一对：起子进程一个出口，等子进程一个出口。
// 各处自己写等待就是各写一遍完成判据，而写错的那处不报错，只会安静地永远挂着。
export {
  BASH_PATH_ENV,
  type BashResolution,
  type CollectedProcess,
  type CollectOptions,
  type CommandShell,
  collectProcess,
  commandShell,
  detectSandbox,
  probeBash,
  setCommandRunner,
  spawnGuarded,
} from './sandbox.ts'
// 定时任务：server 的调度 tick 与 HTTP 面读写的是同一张表。
// 它落在这个包而不是 runtime，是因为模型侧的三个工具必须在这里，
// 而 tools(L3) 不许依赖 runtime(L5)——理由写在 `schedules.ts` 顶部。
export {
  diagnoseSchedule,
  isDue,
  loadSchedules,
  nextRunAt,
  type Schedule,
  updateSchedules,
} from './schedules.ts'
// 作用域：runtime 与 server 都要按同一份规则算三层的根
export {
  AGENTS_DIR,
  globalScopeRoot,
  type Scope,
  type ScopedItem,
  type ScopeRoots,
  scanAllScopes,
  scanScoped,
  scopeDir,
  scopePaths,
  scopeRoots,
} from './scopes.ts'
// 脱敏：team/cli-backend.ts 起外部 CLI 前要剥凭证
export { scrubEnv } from './secrets.ts'
// 环境变量的默认豁免名单：server/api 下发给设置页当留空时的实际值
export { DEFAULT_ENV_ALLOW, resolveCommandTimeout } from './shell.ts'
// 技能：runtime/session.ts 扫索引，server/api 列给设置页
export { SKILLS_SUBDIR, type SkillMeta, scanAllSkills, scanSkills } from './skills.ts'
// 外部工具按需加载：runtime/session.ts 量一次决定全量常驻还是进池子；
// server/api 只取静态规格，它不建池
export {
  EXTERNAL_SCHEMA_BUDGET_TOKENS,
  externalSchemaTokens,
  LOAD_TOOL_SPEC,
  makeLoadToolTool,
  PendingToolPool,
} from './tool-pool.ts'

import { readHistoryTool } from './history.ts'
import { installPluginTool } from './plugin-install.ts'
import { subagentTool } from './subagent.ts'
import { defineSubagentTool } from './subagent-define.ts'
import { workflowTool } from './workflow.ts'

/**
 * 内置工具集的唯一注册入口。插件工具在此之后追加，不得覆盖同名。
 *
 * **`run_command` 按能力注册**：这台机器上 bash / pwsh / powershell 一个都没有，
 * 就不给模型这个工具，而不是给一个必然失败的工具（B5）。探测每次重新跑，
 * 而这个函数每条消息都会被调一次（`runtime/session.ts`），所以装完 git
 * **下一条消息就有了**，不用重启。
 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  opts: { delegate?: boolean; plugins?: boolean } = {},
): void {
  const shell = commandShell()
  for (const spec of [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    globTool,
    grepTool,
    ...(shell ? [makeShellTool(shell)] : []),
    readResourceTool,
    readHistoryTool,
    writeTodosTool,
    readGoalTool,
    updateGoalTool,
    webFetchTool,
    webSearchTool,
    readMemoryTool,
    writeMemoryTool,
    deleteMemoryTool,
    readSkillTool,
    createScheduleTool,
    listSchedulesTool,
    deleteScheduleTool,
    // 派活与编排**按通道注册**：没有派活通道就没有这两个工具，
    // 而不是给必然回「派不出去」的（B5，同 run_command 那条）。
    ...(opts.delegate ? [defineSubagentTool, subagentTool, workflowTool] : []),
    // 装插件同样按通道注册：装不了插件的装插件工具没有降级形态。
    ...(opts.plugins ? [installPluginTool] : []),
  ]) {
    registry.register(spec)
  }
}
