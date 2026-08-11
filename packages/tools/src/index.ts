import type { ToolRegistry } from '@qywork/agent'
import { editFileTool, listDirTool, readFileTool, writeFileTool } from './files.ts'
import { memoryTool } from './memory.ts'
import { updatePlanTool } from './plan.ts'
import { readResourceTool } from './resources.ts'
import { globTool, grepTool } from './search.ts'
import { shellTool } from './shell.ts'
import { listSkillsTool, readSkillTool } from './skills.ts'
import { webFetchTool, webSearchTool } from './web.ts'

export { editFileTool, listDirTool, readFileTool, writeFileTool } from './files.ts'
export * from './memory.ts'
export * from './net-safety.ts'
export * from './paths.ts'
export { PLAN_STATE_KEY, updatePlanTool } from './plan.ts'
export { readResourceTool } from './resources.ts'
export * from './sandbox.ts'
export { globTool, grepTool } from './search.ts'
export * from './secrets.ts'
export { shellTool } from './shell.ts'
export * from './sink.ts'
export * from './skills.ts'
export * from './web.ts'

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
