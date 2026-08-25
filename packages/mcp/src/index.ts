/**
 * `@qywork/mcp` 的对外面。**这里列的就是承诺，没列的就是内部实现。**
 * 具名导出，不用 `export *`（B6）；加一行之前先确认它真有包外调用点（B3）。
 *
 * 唯一的装配方是 `runtime/extensions.ts`；CLI 的 `qy mcp` / `qy doctor` 也经它拿
 * 工具名前缀，不直接依赖本包。
 */

// 加载与解析：runtime 读三层的 mcp.json 并把 server 全连上
export { loadMcpServers, type McpConfig, type McpRegistry, parseMcpConfig } from './load.ts'
// 工具名前缀。**必须走它**，别自己拼 `mcp__<name>__`——注册名是消毒过的，
// 拿未消毒的 server 名拼前缀一条都匹配不上，`qy mcp` 的工具计数会恒为 0。
export { toolNamePrefix } from './register.ts'
