/**
 * `@qywork/runtime` 的对外接口。此处列出的即对外承诺，未列出的均为内部实现。
 * 使用具名导出，不用 `export *`（B6）；新增导出前先确认它确有包外调用方（B3）。
 *
 * 本包是装配层：将 agent / ai / store / tools / mcp / plugins / team 组装为
 * `Session`。下游只应看到装配结果，不应依赖装配过程。
 */

// 会话导出：`qy export`
export { exportConversation, exportConversationDiagnostics } from './archive.ts'
// Art 页面可用的 three.js 附加模块：sidecar 按同一份清单提供库文件
export { ART_ADDONS } from './art.ts'
// 压缩端口：server 的手动压缩与 loop 的自动压缩共用
export { RuntimeCompaction } from './compaction.ts'
// 配置：CLI 与 server 的配置读写、诊断、脱敏
export {
  catalogKey,
  collectSecrets,
  configDir,
  configNotices,
  configPath,
  dataPath,
  diagnoseConfig,
  diagnoseRunnable,
  listMediaModels,
  loadConfig,
  type MediaModelEntry,
  type ModelRef,
  NO_MODEL_MESSAGE,
  type QyConfig,
  type ResolvedMediaModel,
  resolveMediaModel,
  resolveModel,
  type StoredCatalogEntry,
  type StoredMediaModel,
  type StoredModel,
  type StoredProvider,
  saveConfig,
} from './config.ts'
// 上下文面板：按会话实时计算，切换会话或刷新后仍可查询
export { type ContextPanel, contextPanel } from './context-panel.ts'
// 扩展装配：插件、MCP 与 team。
// `toolNamePrefix` / `pluginToolPrefix` 由此转出：CLI 不直接依赖 mcp / plugins 两个包，
// 而 `qy mcp` / `qy doctor` / `qy plugins` 需要按前缀统计工具；
// 自行拼接未经清洗的前缀将无法匹配任何工具。
export {
  acquireExtensions,
  globalPluginsDir,
  loadExtensions,
  loadScopedMcpConfig,
  loadTeamConfig,
  loadWorkspaceMcp,
  MCP_CONFIG,
  MCP_FILE,
  pluginToolPrefix,
  refreshExtensions,
  releaseExtensions,
  toolNamePrefix,
} from './extensions.ts'
// 日志文件 sink：`qy serve` 启动时安装，此后各包的 `log.*` 写入 `<configDir>/logs/`
export { type FileLogSink, fileLogSink, LOG_FILE } from './log-file.ts'
// MCP 配置：server 的导入接口与会话里的模型工具共用同一份写入实现
export { makeMcpConfigPort, mergeMcpServers, type WritableMcpScope } from './mcp-config-store.ts'
// 生成端口：会话中的生成工具与 server 的画布（界面发起的生成）共用同一份模型选择、校验与计价
export { cancelMediaTask, makeMediaPort } from './media.ts'
// Office 执行程序的宿主侧：服务端与 CLI 各创建一个，会话按其提供的端口注册 `office`。
export {
  createOfficeHost,
  findPython,
  type OfficeHost,
  type OfficeStatus,
  officeDir,
} from './office.ts'
// 提示词装配：agent 的前缀审计测试经动态 import 取得真实实现进行审计
export { buildSystemPrompt, buildTailNotes } from './prompt.ts'
// 主请求与摘要请求共用的持久化边界。
export { requestPersistence } from './request-persistence.ts'
// 全机任务文件导入账本：server 在开始服务之前调用一次
export { importLegacySchedules } from './schedules.ts'
// 会话：装配的最终产物，CLI 与 server 的唯一入口。
// `makeSummarizer` 一并转出：server 的手动压缩与会话内的自动压缩共用同一份摘要装配。
export { makeSummarizer, Session } from './session.ts'
// 正文落盘：会话内的工具产出与服务端的子 agent 回执共用同一份实现。
// `collectResourceGarbage` 与它遵循同一锁顺序，在删除会话之后与打开数据库之后各调用一次。
export { collectResourceGarbage, RuntimeSink } from './sink.ts'
// 历史投影：`Session.ask` 用它装配本轮历史，回归测试用它验证
// 运行中的 transcript 与跨 run 投影出的历史逐条位置一致。
export { buildHistory } from './transcript.ts'
