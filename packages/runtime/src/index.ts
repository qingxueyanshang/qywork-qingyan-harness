/**
 * `@qywork/runtime` 的对外面。**这里列的就是承诺，没列的就是内部实现。**
 * 具名导出，不用 `export *`（B6）；加一行之前先确认它真有包外调用点（B3）。
 *
 * 这个包是装配层：把 agent / ai / store / tools / mcp / plugins / team 拼成一个
 * `Session`。**下游只该看见装配结果**，不该看见它是怎么拼的。
 */

// 会话导出：`qy export`
export { exportConversation } from './archive.ts'
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
  isWorkspaceTrusted,
  loadConfig,
  type ModelRef,
  type QyConfig,
  resolveModel,
  type StoredCatalogEntry,
  type StoredModel,
  type StoredProvider,
  saveConfig,
  setWorkspaceTrust,
} from './config.ts'
// 上下文面板：按会话现算，切会话/刷新后仍可查
export { type ContextPanel, contextPanel } from './context-panel.ts'
// 扩展装配：插件 + MCP + team。
// `toolNamePrefix` / `pluginToolPrefix` 由这里转出——CLI 不直接依赖 mcp / plugins
// 两个包，但 `qy mcp` / `qy doctor` / `qy plugins` 都要按前缀数工具，
// 而自己拼未消毒的前缀会一条都匹配不上。
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
  releaseExtensions,
  toolNamePrefix,
} from './extensions.ts'
// MCP 配置：server 的导入接口与会话里的模型工具共用同一份写入实现
export { makeMcpConfigPort, mergeMcpServers, type WritableMcpScope } from './mcp-config-store.ts'
// 提示词装配：agent 的前缀审计测试要拿真实的那一份来审（走动态 import）
export { buildSystemPrompt, buildTailNotes } from './prompt.ts'
// 会话：装配的最终产物，CLI 与 server 的唯一入口。
// `makeSummarizer` 一并转出：server 的手动压缩与会话内的自动压缩共用同一份摘要装配。
export { makeSummarizer, Session } from './session.ts'
// 历史投影：`Session.ask` 内部用它装配这一轮的历史，回归测试用它验证
// 「活的 transcript 与跨 run 投影回来的那一份逐条同位」。
export { buildHistory } from './transcript.ts'
