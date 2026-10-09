/**
 * `@qywork/tools` 的对外接口。**此处列出的即对外承诺，未列出的均为内部实现。**
 * 使用具名导出，不用 `export *`（B6）：后者会把 `buildBwrapArgv`、`parseFrontmatter`、
 * `clampBody` 等内部符号一并导出到包边界之外。新增导出前先确认它确有包外调用方（B3）。
 *
 * 包内互相引用与测试使用相对路径，不受本清单约束。
 */

import type { ToolRegistry } from '@qywork/agent'
import { browserTools } from './browser.ts'
import { desktopTools } from './desktop.ts'
import { editFileTool, listDirTool, readFileTool, writeFileTool } from './files.ts'
import { readGoalTool, updateGoalTool } from './goals.ts'
import { moveMcpServerTool, writeMcpServerTool } from './mcp-config.ts'
import { deleteMemoryTool, moveMemoryTool, readMemoryTool, writeMemoryTool } from './memory.ts'
import { readResourceTool } from './resources.ts'
import { commandShell } from './sandbox.ts'
import { createScheduleTool, deleteScheduleTool, listSchedulesTool } from './schedules.ts'
import { globTool, grepTool } from './search.ts'
import { makeShellTool } from './shell.ts'
import { importSkillTool, moveSkillTool, readSkillTool, writeSkillTool } from './skills.ts'
import { writeTodosTool } from './todos.ts'
import { webFetchTool, webSearchTool } from './web.ts'

// 生成工具按类别查询：runtime 据此判断本轮快照是否列出该类别的模型。
// 生成的执行路径与任务记录后缀：server 的画布服务与生成工具使用同一个 `generateMedia`
export {
  freeLandingPath,
  type GeneratedFile,
  type GenerateOutcome,
  generateMedia,
  landFiles,
  MEDIA_TOOLS,
  resumeMedia,
  TASK_SUFFIX,
} from './generate.ts'
// 画布按图片文件头的宽高确定节点尺寸。
export { type ImageSize, imageSizeOf, shrinkImage } from './image.ts'
// 记忆：runtime/session.ts 装配提示词时读取索引，server/api/memory.ts 读写单条记忆
export {
  listAllScopedEntries,
  listScopedEntries,
  MAX_ENTRIES,
  MAX_ENTRY_CHARS,
  MEMORY_DIR,
  MEMORY_SUBDIR,
  type MemoryEntry,
} from './memory.ts'
// 网络访问：供 runtime/capabilities.ts 实现插件的 host.net.fetch
export { type SafetyOptions, safeFetch } from './net-safety.ts'
// 路径：工作区边界的唯一判据，runtime 与 server 均使用
export {
  displayPath,
  IGNORED_DIRS,
  normalizeAdditionalDirectories,
  PROTECTED_DIRS,
  resolveInWorkspace,
  resolveWritablePath,
  rootsOf,
} from './paths.ts'
export { renameWithRetry } from './rename.ts'
// 命令运行在先于监听端口启动的子进程中。`qy serve` 在绑定端口前启动该子进程，
// 隐藏的 `runner` 子命令是该子进程的入口。
export {
  type CommandRunner,
  type ProcessLike,
  runCommandRunner,
  startCommandRunner,
} from './runner.ts'
// 沙箱：cli 的 doctor/config 与 server 的握手均报告沙箱状态
// `commandShell` / `probeBash` 一并导出：命令在哪个 shell 中运行由它决定，调用方另行判断 platform 即形成第二本账；
// 握手需报告本机是否有 bash，没有时向用户说明原因
// `collectProcess` 与 `spawnGuarded` 配对使用：启动子进程与等待子进程各有唯一入口。
// 各处自行编写等待逻辑即各自实现一遍完成判据，写错的一处不会报错，只会无限期阻塞。
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
// 作用域：runtime 与 server 按同一规则计算三层的根目录
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
// 脱敏：team/cli-backend.ts 启动外部 CLI 前剥离凭证；runtime 写入诊断前对异常原文脱敏。
export { createStreamRedactor, redactSecrets, scrubEnv } from './secrets.ts'
// 环境变量的默认豁免名单：server/api 下发给设置页，作为留空时的实际值。
// `MAX_TIMEOUT_MS` 是本机单次工具执行的时限：team 用作外部 CLI 的静默上限，
// 执行器据此组装终止说明。
export { DEFAULT_ENV_ALLOW, MAX_TIMEOUT_MS, resolveCommandTimeout } from './shell.ts'
// 子 agent 产出的投递限制：server 的派发通道组装回执时经过同一投递限制，不另设标准。
export { deliverAgentOutput, observationBudget } from './sink.ts'
// 技能：runtime/session.ts 扫描索引，server/api 为设置页列出技能
export { SKILLS_SUBDIR, type SkillMeta, scanAllSkills, scanSkills } from './skills.ts'
// 外部工具按需加载：runtime/session.ts 计量一次，决定全部常驻还是放入工具池；
// server/api 只取静态规格，不建立工具池
export {
  EXTERNAL_SCHEMA_BUDGET_TOKENS,
  externalSchemaTokens,
  LOAD_TOOL_SPEC,
  makeLoadToolTool,
  PendingToolPool,
} from './tool-pool.ts'
export { type ChangeWindow, openChangeWindow } from './workspace-watch.ts'

import type { MediaOutput } from '@qywork/core'
import {
  createCanvasTool,
  editCanvasTool,
  readCanvasTool,
  retrieveCanvasTool,
  runCanvasTool,
} from './canvas.ts'
import { defineRoleTool } from './define-role.ts'
import { MEDIA_TOOLS, retrieveMediaTool } from './generate.ts'
import { readHistoryTool } from './history.ts'
import { officeTools } from './office.ts'
import { installPluginTool } from './plugin-install.ts'
import { subagentTool } from './subagent.ts'
import { workflowTool } from './workflow.ts'

/**
 * 内置工具集的唯一注册入口。插件工具在此之后追加，不得覆盖同名。
 *
 * `run_command` 按能力注册：本机没有 bash / pwsh / powershell 中的任何一个时，
 * 不向模型提供该工具，而不是提供一个必然失败的工具（B5）。探测每次重新执行，
 * 而本函数每条消息调用一次（`runtime/session.ts`），因此安装 git 后
 * 下一条消息即可使用，无需重启。
 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  opts: {
    delegate?: boolean
    plugins?: boolean
    mcpConfig?: boolean
    browser?: boolean
    desktop?: boolean
    /** 有画布通道（服务端注入了 `CanvasPort`）。 */
    canvas?: boolean
    /** 有 Office 执行程序（宿主注入了 `OfficePort`）。 */
    office?: boolean
    /** 已配置模型的生成类别。各类别的生成工具只在该类别有模型时注册。 */
    media?: readonly MediaOutput[]
  } = {},
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
    // 浏览器同样按通道注册：宿主未连接、版本不满足要求、成员会话三种情况均无法取得端口，
    // 此时注册的将是七个必然报错的工具。
    ...(opts.browser ? browserTools : []),
    // 电脑控制同样按通道注册：未启用、宿主未连接、worker 未就绪、系统未授权，
    // 四种情况均无法取得端口，此时注册的将是四个必然报错的工具。
    ...(opts.desktop ? desktopTools : []),
    // Office 同样按通道注册：没有 Python 与文档库时调用必然失败。
    ...(opts.office ? officeTools : []),
    readMemoryTool,
    writeMemoryTool,
    deleteMemoryTool,
    moveMemoryTool,
    importSkillTool,
    readSkillTool,
    writeSkillTool,
    moveSkillTool,
    ...(opts.mcpConfig ? [writeMcpServerTool, moveMcpServerTool] : []),
    // 生成工具按类别注册：没有图像模型时，图像生成工具的调用必然失败（B5）。
    ...(opts.media ?? []).map((output) => MEDIA_TOOLS[output]),
    ...(opts.media?.some((type) => type === 'video' || type === 'image')
      ? [retrieveMediaTool]
      : []),
    // 画布按通道注册：没有服务端（CLI 会话）时没有画布服务，工具调用必然失败。
    ...(opts.canvas
      ? [createCanvasTool, readCanvasTool, editCanvasTool, runCanvasTool, retrieveCanvasTool]
      : []),
    createScheduleTool,
    listSchedulesTool,
    deleteScheduleTool,
    // 派发任务与编排按通道注册：没有派发通道时不注册这些工具，
    // 而不是注册必然返回「无法派发」的工具（B5，与 run_command 相同）。
    ...(opts.delegate ? [defineRoleTool, subagentTool, workflowTool] : []),
    // 安装插件的工具同样按通道注册：无法安装插件时该工具没有降级形态。
    ...(opts.plugins ? [installPluginTool] : []),
  ]) {
    registry.register(spec)
  }
}

export { withFileLocks } from './file-lock.ts'
export { importSkills } from './skills/install.ts'
