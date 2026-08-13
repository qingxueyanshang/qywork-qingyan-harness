/**
 * `@qywork/tools` 的对外面。
 *
 * **这里列的就是承诺，没列的就是内部实现。** 之前八个模块走 `export *`，
 * 把约五十个符号一并推到包外——包括 `buildBwrapArgv`、`parseFrontmatter`、
 * `clampBody` 这类纯内部的东西。后果不是「用了会坏」，是**看不出这个包对外
 * 承诺了什么**：改任何一个内部函数都得先全仓 grep 一遍才敢动。
 *
 * 现在只导出真实有外部消费者的（实测 13 个，逐个核过调用点）。
 * 包内互相引用照常走相对路径，测试也一样——它们不受这份清单约束。
 *
 * 加新的对外符号时：先确认它真的有包外调用点，再往下面加一行。
 * 「以后可能有人要用」不是理由（见 CLAUDE.md B3）。
 */

import type { ToolRegistry } from '@qywork/agent'
import { editFileTool, listDirTool, readFileTool, writeFileTool } from './files.ts'
import { memoryTool } from './memory.ts'
import { updatePlanTool } from './plan.ts'
import { readResourceTool } from './resources.ts'
import { globTool, grepTool } from './search.ts'
import { shellTool } from './shell.ts'
import { listSkillsTool, readSkillTool } from './skills.ts'
import { webFetchTool, webSearchTool } from './web.ts'

// 记忆：runtime/session.ts 装配提示词时要读索引，server/api/memory.ts 要读写单条
export {
  listScopedEntries,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  MEMORY_DIR,
  MEMORY_SUBDIR,
  type MemoryEntry,
  readScoped,
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
// 沙箱：cli 的 doctor/config、server 的握手都要报它
export { detectSandbox, spawnGuarded } from './sandbox.ts'
// 作用域：runtime 与 server 都要按同一份规则算三层的根
export {
  AGENTS_DIR,
  globalScopeRoot,
  type Scope,
  type ScopeRoots,
  scanScoped,
  scopeDir,
  scopePaths,
  scopeRoots,
} from './scopes.ts'
// 脱敏：team/cli-backend.ts 起外部 CLI 前要剥凭证
export { scrubEnv } from './secrets.ts'
export { resolveCommandTimeout } from './shell.ts'
// 技能：runtime/session.ts 扫索引，server/api 列给设置页
export { SKILLS_SUBDIR, type SkillMeta, scanSkills } from './skills.ts'

/** 内置工具集的唯一注册入口。插件工具在此之后追加，不得覆盖同名。 */
export function registerBuiltinTools(registry: ToolRegistry): void {
  for (const spec of [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    globTool,
    grepTool,
    shellTool,
    readResourceTool,
    updatePlanTool,
    webFetchTool,
    webSearchTool,
    memoryTool,
    listSkillsTool,
    readSkillTool,
  ]) {
    registry.register(spec)
  }
}
