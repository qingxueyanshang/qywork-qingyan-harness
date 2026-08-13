/**
 * `@qywork/mcp` 的对外面。
 *
 * **这里列的就是承诺，没列的就是内部实现。** 之前四个模块走 `export *`，
 * 把二十五个符号推到包外，其中二十个没有任何包外调用点——传输层、JSON-RPC
 * 客户端、resource 工具的构造器全都是内部实现，不该被外面看见。
 *
 * 唯一的装配方是 `runtime/extensions.ts`；CLI 的 `qy mcp` / `qy doctor`
 * 也经它拿工具名前缀，不直接依赖本包。
 *
 * 加新的对外符号时：先确认它真的有包外调用点，再往下面加一行。
 */

// 加载与解析：runtime 读三层的 mcp.json 并把 server 全连上
export { loadMcpServers, type McpConfig, type McpRegistry, parseMcpConfig } from './load.ts'
// 工具名前缀。**必须走它**，别自己拼 `mcp__<name>__`——注册名是消毒过的，
// 拿未消毒的 server 名拼前缀一条都匹配不上（`qy mcp` 的工具计数曾因此恒为 0）。
export { toolNamePrefix } from './register.ts'
