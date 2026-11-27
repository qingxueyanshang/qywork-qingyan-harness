/**
 * MCP server 的配置：两种传输的配置形状与 `mcp.json` 的解析。电脑端加载与写入 MCP 配置、云端校验创作广场中的 MCP
 * 都经由本文件解析。
 */

export interface StdioServerSpec {
  transport?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
  /** 工作目录，相对于工作区。默认为工作区根目录。 */
  cwd?: string
}

export interface HttpServerSpec {
  transport: 'http'
  url: string
  /** 请求头，例如鉴权头。远端 server 通常需要。 */
  headers?: Record<string, string>
}

export type McpServerSpec = StdioServerSpec | HttpServerSpec

export function isHttpSpec(spec: McpServerSpec): spec is HttpServerSpec {
  return (spec as HttpServerSpec).transport === 'http'
}

export interface McpConfig {
  servers: Record<string, McpServerSpec & { enabled?: boolean }>
  /** 配置文件解析失败的原因。 */
  error: string | null
}

export function parseMcpConfig(raw: string): McpConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { servers: {}, error: `mcp.json 解析失败：${String(err)}` }
  }

  const obj = (parsed ?? {}) as Record<string, unknown>
  // 同时接受 `servers` 与 `mcpServers`：后者是其他 MCP 客户端普遍使用的键名，
  // 用户通常从那些客户端整段复制配置。不应为一个键名要求用户重新填写配置。
  const rawServers = (obj.servers ?? obj.mcpServers ?? {}) as Record<string, unknown>

  const servers: McpConfig['servers'] = {}
  const bad: string[] = []
  for (const [name, value] of Object.entries(rawServers)) {
    const s = (value ?? {}) as Record<string, unknown>
    const command = String(s.command ?? '').trim()
    const url = String(s.url ?? '').trim()

    if (url) {
      // 同时提供 `command` 与 `url` 表示配置有歧义。报告该错误而不是任选其一：
      // 静默选择时，修改未被采用的字段不产生任何变化，且无从排查。
      if (command) {
        bad.push(`${name}（同时配置了 command 与 url，无法判断使用哪种传输）`)
        continue
      }
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        bad.push(`${name}（url 不是合法地址：${url}）`)
        continue
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        bad.push(`${name}（url 只支持 http/https，收到 ${parsed.protocol}）`)
        continue
      }
      servers[name] = {
        transport: 'http',
        url,
        ...(s.headers && typeof s.headers === 'object'
          ? { headers: s.headers as Record<string, string> }
          : {}),
        ...(s.enabled === false ? { enabled: false } : {}),
      }
      continue
    }

    if (!command) {
      bad.push(`${name}（既没有 command 也没有 url）`)
      continue
    }
    servers[name] = {
      command,
      ...(Array.isArray(s.args) ? { args: s.args.map(String) } : {}),
      ...(s.env && typeof s.env === 'object' ? { env: s.env as Record<string, string> } : {}),
      ...(s.cwd ? { cwd: String(s.cwd) } : {}),
      ...(s.enabled === false ? { enabled: false } : {}),
    }
  }

  return { servers, error: bad.length ? `已忽略：${bad.join('、')}` : null }
}
