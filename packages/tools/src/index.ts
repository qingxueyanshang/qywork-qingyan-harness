/**
 * `@qywork/tools` 的对外接口。**此处列出的即对外承诺，未列出的均为内部实现。**
 * 使用具名导出，不用 `export *`（B6）：后者会把 `buildBwrapArgv`、`clampBody`
 * 等内部符号一并导出到包边界之外。新增导出前先确认它确有包外调用方（B3）。
 *
 * 包内互相引用与测试使用相对路径，不受本清单约束。
 */

import { Ports, provide, type ToolRegistry, type ToolSpec } from '@qywork/agent'
import { browserTools } from './browser.ts'
import { CanvasPort } from './canvas/port.ts'
import { newConversationTool } from './conversation/new-conversation.ts'
import { desktopTools } from './desktop/tools.ts'
import { editFileTool, listDirTool, readFileTool, writeFileTool } from './files.ts'
import { readGoalTool, updateGoalTool } from './goals.ts'
import { enableMcpServerTool, moveMcpServerTool, writeMcpServerTool } from './mcp-config.ts'
import { deleteMemoryTool, moveMemoryTool, readMemoryTool, writeMemoryTool } from './memory.ts'
import { commandShell } from './process/command-shell.ts'
import { readResourceTool } from './resources.ts'
import { createScheduleTool, deleteScheduleTool, listSchedulesTool } from './schedules.ts'
import { globTool, grepTool } from './search.ts'
import { CommandPort } from './shell/port.ts'
import { backgroundCommandTool, makeShellTool } from './shell.ts'
import { importSkillTool, moveSkillTool, readSkillTool, writeSkillTool } from './skills.ts'
import { writeTodosTool } from './todos.ts'
import { webFetchTool, webSearchTool } from './web.ts'

// 端口：接口与键定义在使用它的工具所在的目录，装配方（runtime、server、cli）据此提供实现
export { PersonalizationPort, PetPort } from './appearance/port.ts'
export {
  BROWSER_DIALOG_NAMES,
  type BrowserActInput,
  type BrowserActivity,
  type BrowserActReceipt,
  type BrowserActResult,
  type BrowserDownloadResult,
  type BrowserElement,
  type BrowserExecution,
  type BrowserKeyPhase,
  type BrowserObservation,
  type BrowserOptionsPage,
  type BrowserPathStep,
  type BrowserPoint,
  BrowserPort,
  type BrowserRefusal,
  type BrowserSelectOption,
  type BrowserTabInfo,
  type BrowserWaitReceipt,
  type BrowserWaitResult,
  type BrowserWaitState,
  type FollowUpObservation,
  type LocalFileCheck,
} from './browser/port.ts'
export { type CanvasEditResult, CanvasPort, type CanvasRender } from './canvas/port.ts'
export {
  type CloudSkillErrorCode,
  CloudSkillPort,
  type CloudSkillResult,
  type CloudSkillScript,
} from './cloud-skills/port.ts'
export { ConversationPort } from './conversation/port.ts'
export {
  type DesktopActResult,
  type DesktopBlockingWindowInfo,
  type DesktopElement,
  type DesktopFollowUp,
  type DesktopImage,
  type DesktopImagePoint,
  DesktopPort,
  type DesktopRefusal,
  type DesktopSnapshot,
  type DesktopText,
  type DesktopWaitCondition,
  type DesktopWaitResult,
  type DesktopWindowInfo,
} from './desktop/port.ts'
export { FileReadPort } from './files/port.ts'
// 附件说明按读取工具的投递格式写出估算大小，两处共用同一个函数
export { readTokens } from './files/read-size.ts'
export { type MediaCall, type MediaCallResult, MediaPort } from './generate/port.ts'
// 生成工具按类别查询：runtime 据此判断本轮快照是否列出该类别的模型。
// 生成的执行路径与任务记录后缀：server 的画布服务与生成工具使用同一个 `generateMedia`
export {
  freeLandingPath,
  type GeneratedFile,
  type GenerateOutcome,
  type GenerateSuccess,
  generateMedia,
  landFiles,
  MEDIA_TOOLS,
  recordTask,
  resumeMedia,
  taskHeldElsewhere,
} from './generate.ts'
export { GoalPort } from './goals/port.ts'
export { HistoryPort, type HistoryStep } from './history/port.ts'
// 画布按图片文件头的宽高确定节点尺寸。
export {
  downscaleNote,
  type ImageRegion,
  imageAtWidth,
  shrinkImage,
  shrunkSize,
  ZOOM_MAX,
  type ZoomedImage,
  zoomImage,
} from './image.ts'
export { type McpActivation, McpConfigPort } from './mcp-config/port.ts'
// MCP 服务的命令行写法：工具的命令判定与 runtime 列出未启用的项目服务使用同一种写法。
export { formatCommandLine } from './mcp-config.ts'
// 记忆：runtime/session/turn/prepare.ts 装配提示词时读取索引，server/api/memory.ts 读写单条记忆
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
export { safeFetch } from './net-safety.ts'
export { OfficePort } from './office/port.ts'
// 路径：工作区边界的唯一判据，runtime 与 server 均使用
export {
  officeRunDir,
  renderOfficePages,
  type SampledFrame,
  sampleVideoFrames,
  type WorkerScope,
} from './office-worker.ts'
export {
  conversationTempDir,
  displayPath,
  IGNORED_DIRS,
  normalizeAdditionalDirectories,
  PROTECTED_DIRS,
  resolveInWorkspace,
  resolveWritablePath,
  rootsOf,
  workspacePythonBin,
  workspacePythonDir,
} from './paths.ts'
export { PluginPort } from './plugin-install/port.ts'
// `collectProcess` 与 `spawnGuarded` 配对使用：启动子进程与等待子进程各有唯一入口。
// 各处自行编写等待逻辑即各自实现一遍完成判据，写错的一处不会报错，只会无限期阻塞。
export { type CollectedProcess, type CollectOptions, collectProcess } from './process/collect.ts'
// `commandShell` / `probeBash` 一并导出：命令在哪个 shell 中运行由它决定，调用方另行判断 platform 即形成第二本账；
// 握手需报告本机是否有 bash，没有时向用户说明原因
export {
  BASH_PATH_ENV,
  type BashResolution,
  type CommandShell,
  commandShell,
  probeBash,
} from './process/command-shell.ts'
// 沙箱：cli 的 doctor/config 与 server 的握手均报告沙箱状态
export { detectSandbox } from './process/sandbox.ts'
export { setCommandRunner, spawnGuarded } from './process/spawn.ts'
export { renameWithRetry } from './rename.ts'
// 命令运行在先于监听端口启动的子进程中。`qy serve` 在绑定端口前启动该子进程，
// 隐藏的 `runner` 子命令是该子进程的入口。
export {
  type CommandRunner,
  type ProcessLike,
  runCommandRunner,
  startCommandRunner,
} from './runner.ts'
export { SchedulePort } from './schedules/port.ts'
// 作用域：runtime 与 server 按同一规则计算三层的根目录
export {
  AGENTS_DIR,
  type Scope,
  type ScopedItem,
  type ScopeRoots,
  scanAllScopes,
  scanScoped,
  scopeDir,
  scopePaths,
  scopeRoots,
} from './scopes.ts'
// 脱敏：team/cli-backend.ts 启动外部 CLI 前剥离凭证；runtime 写入诊断前对异常原文脱敏，并按名称模式收集请求头与 MCP 配置中的凭证。
export {
  CREDENTIAL_NAME_PATTERN,
  createStreamRedactor,
  redactSecrets,
  scrubEnv,
} from './secrets.ts'
export { CommandPort } from './shell/port.ts'
// 环境变量的默认豁免名单：server/api 下发给设置页，作为留空时的实际值。
// `MAX_TIMEOUT_MS` 是本机单次工具执行的时限：team 用作外部 CLI 的静默上限，
// 执行器据此组装终止说明。`scrubbedEnv`：server 启动 git 时使用与 `run_command` 相同的凭证剥离。
export {
  DEFAULT_ENV_ALLOW,
  MAX_TIMEOUT_MS,
  resolveCommandTimeout,
  scrubbedEnv,
} from './shell.ts'
// 子 agent 产出的投递限制：server 的派发通道组装回执时经过同一投递限制，不另设标准。
export { deliverAgentOutput, observationBudget } from './sink.ts'
export { SkillSourcePaths } from './skills/port.ts'
// 技能：runtime/session/turn/prepare.ts 扫描索引，server/api 为设置页列出技能
export {
  isCloudSkillDir,
  SKILLS_SUBDIR,
  type SkillMeta,
  scanAllSkills,
  scanSkills,
} from './skills.ts'
export { TodoBroadcast } from './todos/port.ts'
// 外部工具按总量分档：runtime/session/extension-tools.ts 计量一次，决定全部常驻还是全部按需
export {
  deferExternal,
  EXTERNAL_SCHEMA_BUDGET_TOKENS,
  externalSchemaTokens,
} from './tool-pool.ts'
export { type ChangeWindow, openChangeWindow, settleEvents } from './workspace-watch.ts'

import type { MediaOutput } from '@qywork/core'
import { personalizeTool } from './appearance/personalize.ts'
import { petTool } from './appearance/pet.ts'
import {
  cancelCanvasTool,
  captureCanvasFrameTool,
  createCanvasTool,
  editCanvasTool,
  exportTimelineTool,
  readCanvasTool,
  retrieveCanvasTool,
  runCanvasTool,
} from './canvas.ts'
import { defineRoleTool } from './define-role.ts'
import { MEDIA_TOOLS, retrieveMediaTool } from './generate.ts'
import { readHistoryTool } from './history.ts'
import { OfficePort } from './office/port.ts'
import { officeTools } from './office.ts'
import { openInPanelTool } from './panel.ts'
import { installPluginTool } from './plugin-install.ts'
import { stopSubagentTool } from './stop-subagent.ts'
import { subagentTool } from './subagent.ts'
import { makeLoadToolTool } from './tool-pool.ts'
import { waitSubagentsTool } from './wait-subagents.ts'
import { workflowTool } from './workflow.ts'

/**
 * 内置工具集的唯一注册入口。插件工具在此之后追加，不得覆盖同名。
 *
 * 工具在 `ToolSpec.requires` 中声明必需的端口，`ports` 缺少其中任一时不注册：没有该端口时工具调用必然失败（B5），
 * 例如宿主未连接时浏览器工具无法取得 `BrowserPort`。缺失时仍能降级工作的端口不写入 `requires`。
 * 端口之外的注册条件只有 `opts` 中的会话事实与本机能力。
 *
 * `run_command` 按能力注册：本机没有 bash / pwsh / powershell 中的任何一个时，
 * 不向模型提供该工具，而不是提供一个必然失败的工具（B5）。探测每次重新执行，
 * 而本函数每条消息调用一次（`runtime/session.ts`），因此安装 git 后
 * 下一条消息即可使用，无需重启。
 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  ports: Ports = new Ports(),
  opts: {
    /**
     * 已配置模型的生成类别。各类别的生成工具只在该类别有模型时注册。
     * null 表示生成与画布已关闭（配置 `mediaEnabled: false`），画布工具同样不注册。
     */
    media?: readonly MediaOutput[] | null
    /**
     * Agent Team 成员与子 agent 的会话。只注册 `read_memory`：记忆的写入时机来自用户本人的纠正与说明，
     * 成员会话收到的消息是主会话的派发正文。个性化、宠物与面板同样不注册：成员会话不代替用户修改界面，
     * 其工具卡也不显示在当前会话中。
     */
    member?: boolean
  } = {},
): void {
  for (const spec of builtinCandidates(ports, opts)) {
    if (spec.requires?.every((key) => ports.has(key)) ?? true) registry.register(spec)
  }
  // 读取按需工具的定义。始终注册：按需工具也可能由其后追加的外部工具提供（`deferExternal`）。
  registry.register(makeLoadToolTool(registry))
}

type BuiltinOptions = NonNullable<Parameters<typeof registerBuiltinTools>[2]>

/**
 * 工具目录：各通道的端口都提供时，一个顶层会话注册的内置工具。设置页的 `/api/tools` 使用它。
 *
 * 与 `registerBuiltinTools` 使用同一份候选与同一组条件，端口取候选声明的全部 `requires`，只判定是否注册、
 * 不调用端口；Office 端口按已安装视频解码库提供。不要在调用方另列端口清单：另列的清单遗漏新端口时，
 * 目录缺少该端口的工具而不会报错。
 */
export function registerToolCatalog(
  registry: ToolRegistry,
  media: readonly MediaOutput[] | null,
): void {
  const keys = new Set(builtinCandidates(new Ports(), { media }).flatMap((s) => s.requires ?? []))
  const ports = new Ports(
    [...keys].map((key) => provide(key, key === OfficePort ? { videoDecoder: true } : {})),
  )
  registerBuiltinTools(registry, ports, { media })
}

/** 内置工具的候选：已按会话事实与本机能力筛选，尚未按 `requires` 筛选。 */
function builtinCandidates(ports: Ports, opts: BuiltinOptions): ToolSpec[] {
  const shell = commandShell()
  const media = opts.media === undefined ? [] : opts.media
  const user = opts.member !== true
  return [
    readFileTool,
    writeFileTool,
    editFileTool,
    listDirTool,
    globTool,
    grepTool,
    // 没有后台命令端口时 `background` 无法兑现，`background_command` 也没有读取与停止的对象。
    ...(shell
      ? [makeShellTool(shell, { background: ports.has(CommandPort) }), backgroundCommandTool]
      : []),
    readResourceTool,
    readHistoryTool,
    writeTodosTool,
    readGoalTool,
    updateGoalTool,
    webFetchTool,
    webSearchTool,
    ...browserTools,
    ...desktopTools,
    ...officeTools,
    readMemoryTool,
    ...(user ? [writeMemoryTool, deleteMemoryTool, moveMemoryTool] : []),
    importSkillTool,
    readSkillTool,
    writeSkillTool,
    moveSkillTool,
    writeMcpServerTool,
    moveMcpServerTool,
    enableMcpServerTool,
    // 生成工具按类别注册：没有图像模型时，图像生成工具的调用必然失败（B5）。
    ...(media ?? []).map((output) => MEDIA_TOOLS[output]),
    ...(media?.some((type) => type === 'video' || type === 'image') ? [retrieveMediaTool] : []),
    ...(media
      ? [
          createCanvasTool,
          readCanvasTool,
          editCanvasTool,
          runCanvasTool,
          retrieveCanvasTool,
          cancelCanvasTool,
          exportTimelineTool,
        ]
      : []),
    // 取帧还需要视频解码库：缺少时调用必然失败（B5）。
    ...(media && ports.get(OfficePort)?.videoDecoder === true ? [captureCanvasFrameTool] : []),
    // 面板由界面打开：没有界面呈现本会话时调用没有效果（B5）。画布端口只由服务端提供给有界面的会话。
    ...(user && ports.has(CanvasPort) ? [openInPanelTool] : []),
    ...(user ? [personalizeTool, petTool] : []),
    createScheduleTool,
    listSchedulesTool,
    deleteScheduleTool,
    defineRoleTool,
    newConversationTool,
    subagentTool,
    stopSubagentTool,
    waitSubagentsTool,
    workflowTool,
    installPluginTool,
  ]
}

export { withFileLocks } from './file-lock.ts'
export { importSkills } from './skills/install.ts'
