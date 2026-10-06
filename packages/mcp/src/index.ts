/**
 * `@qywork/mcp` 的对外接口。此处列出的即对外承诺，未列出的均为内部实现。
 * 使用具名导出，不用 `export *`（B6）；新增导出前先确认它确有包外调用方（B3）。
 *
 * 唯一的装配方是 `runtime/extensions.ts`；CLI 的 `qy mcp` / `qy doctor` 也经由它取得
 * 工具名前缀，不直接依赖本包。
 */

// 加载与解析：runtime 读取三层 mcp.json 并连接全部 server
export { loadMcpServers, type McpConfig, type McpRegistry, parseMcpConfig } from './load.ts'
// 工具名前缀。必须使用该函数，不要自行拼接 `mcp__<name>__`：注册名经过清洗，
// 用未清洗的 server 名拼接前缀将无法匹配任何工具，`qy mcp` 的工具计数会恒为 0。
export { toolNamePrefix } from './register.ts'
