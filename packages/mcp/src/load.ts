/**
 * 加载工作区里配置的 MCP server 并注册它们的工具。
 *
 * **永不抛异常**：一个连不上的 server 不该让会话起不来。失败收进返回值交给 UI——
 * 静默跳过会让「配了 MCP 但工具不出现」变成无法排查的现象。
 */

import type { ToolSpec } from '@qywork/agent'
import {
  McpClient,
  type McpServerCapabilities,
  type McpToolDef,
  SUPPORTED_CAPABILITIES,
} from './client.ts'
import { specFor, toolName } from './register.ts'
import { resourceToolsFor } from './resources.ts'
import { isHttpSpec, type McpServerSpec } from './transport.ts'

export interface McpConfig {
  servers: Record<string, McpServerSpec & { enabled?: boolean }>
  /** 配置文件解析失败的原因。 */
  error: string | null
}

export interface LoadedServer {
  name: string
  client: McpClient
  tools: McpToolDef[]
  serverInfo: { name?: string; version?: string }
  protocolVersion: string
  /** server 握手时声明的能力。`qy mcp` 要显示它。 */
  capabilities: McpServerCapabilities
  /**
   * server 声明了、而 qywork 没有实现的能力名。
   *
   * **这个字段的存在就是为了消灭一种静默失败**：一个只提供 `prompts` 的 server
   * 会连上、握手成功、`tools/list` 返回空、注册 0 个工具，**不报任何错**。
   * 用户看到「配了但什么都没发生」，日志里干干净净。
   */
  unsupported: string[]
}

export interface McpRegistry {
  servers: LoadedServer[]
  /** 连不上或握手失败的 server。UI 要能显示出来。 */
  failures: { server: string; reason: string }[]
  /**
   * 产出的工具规格（名字含 `mcp__` 前缀）。与插件一样**只产出不注册**——
   * 注册由会话自己做，这样扩展能按工作区缓存，不必每条消息重连一遍 server。
   */
  toolSpecs: ToolSpec[]
  stopAll(): void
}

export function parseMcpConfig(raw: string): McpConfig {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    return { servers: {}, error: `mcp.json 解析失败：${String(err)}` }
  }

  const obj = (parsed ?? {}) as Record<string, unknown>
  // 同时认 `servers` 和 `mcpServers`：后者是 Claude Desktop / Cursor 的键名，
  // 用户多半是从那边复制过来的。为一个键名让人重打一遍配置不值得。
  const rawServers = (obj.servers ?? obj.mcpServers ?? {}) as Record<string, unknown>

  const servers: McpConfig['servers'] = {}
  const bad: string[] = []
  for (const [name, value] of Object.entries(rawServers)) {
    const s = (value ?? {}) as Record<string, unknown>
    const command = String(s.command ?? '').trim()
    const url = String(s.url ?? '').trim()

    if (url) {
      // `command` 和 `url` 同时给 = 配置有歧义。**报出来而不是挑一个**：
      // 静默挑一个的话，用户改了没被采用的那个字段，然后对着一个没有任何变化的
      // 现象查半天。
      if (command) {
        bad.push(`${name}（同时配了 command 与 url，无法判断走哪种传输）`)
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

export interface LoadMcpOptions {
  /** 解析工作区相对路径。由调用方注入，避免本包依赖 tools。 */
  resolveCwd?: (relative: string) => Promise<string>
  onLog?: (line: string) => void
}

export async function loadMcpServers(
  config: McpConfig,
  workspaceRoot: string,
  options: LoadMcpOptions = {},
): Promise<McpRegistry> {
  const out: McpRegistry = {
    servers: [],
    failures: [],
    toolSpecs: [],
    stopAll: () => {
      for (const s of out.servers) s.client.stop()
    },
  }

  const entries = Object.entries(config.servers)
    .filter(([, s]) => s.enabled !== false)
    // 字典序：先到先得的资源（工具名）必须在不同机器上得到相同结果。
    .sort(([a], [b]) => (a < b ? -1 : 1))

  // 并行启动。串行的话五个 server 各花两秒握手就是十秒首屏——
  // 而它们之间没有任何依赖。
  const loaded = await Promise.all(
    entries.map(async ([name, spec]) => {
      // HTTP server 没有工作目录这回事。给它解析一个只会在配置里
      // 写了 cwd 时白白报错。
      const cwd = isHttpSpec(spec)
        ? workspaceRoot
        : spec.cwd
          ? await (options.resolveCwd?.(spec.cwd) ?? Promise.resolve(workspaceRoot))
          : workspaceRoot
      const client = new McpClient({
        name,
        spec,
        cwd,
        ...(options.onLog ? { onLog: options.onLog } : {}),
      })
      try {
        await client.start()
        /*
         * `tools/list` **一律去调**，失败与否再看声明。
         *
         * 两个方向的非规范行为都真实存在，而它们要求相反的处置：
         *
         * - **声明了 tools 却列不出来** → 这是真故障，照常抛，进 failures。
         * - **没声明 capabilities 却正常提供 tools** → 本仓库自己的两个测试夹具
         *   就是这样（`extensions.test.ts` / `session.test.ts` 的 fixture 只回
         *   `protocolVersion` 和 `serverInfo`）。按声明去卡的话，
         *   它们的工具会被**静默丢光**——那正是这次要修的那类失败，
         *   只是换了个方向，而且更难查：原来至少注册了 0 个工具是因为
         *   server 真的没有，现在是因为我们没问。
         *
         * 所以：调用失败时，只有在 server **没有**声明 tools 的情况下才咽下去
         * （那说明它本来就不提供工具，比如一个 resource-only 的 server）。
         */
        let tools: McpToolDef[] = []
        try {
          tools = await client.listTools()
        } catch (err) {
          if (client.capabilities.tools !== undefined) throw err
          options.onLog?.(
            `[mcp:${name}] server 未声明 tools 能力，tools/list 也没有响应，按「不提供工具」处理`,
          )
        }
        return { name, client, tools, ok: true as const }
      } catch (err) {
        client.stop()
        return {
          name,
          ok: false as const,
          reason: err instanceof Error ? err.message : String(err),
        }
      }
    }),
  )

  for (const item of loaded) {
    if (!item.ok) {
      out.failures.push({ server: item.name, reason: item.reason })
      continue
    }
    const seen = new Set(out.toolSpecs.map((s) => s.name))
    for (const def of item.tools) {
      const full = toolName(item.name, def.name)
      // 重名不能静默覆盖——覆盖会无声吞掉一整个 server 的某个工具。
      // （同名只可能来自同一个 server 重复声明，server 名已经在前缀里了。）
      if (seen.has(full)) {
        out.failures.push({ server: item.name, reason: `工具名重复：${full}` })
        continue
      }
      seen.add(full)
      out.toolSpecs.push(specFor(item.client, def))
    }

    // resource 工具：只在 server 声明了 capabilities.resources 时才有。
    for (const spec of resourceToolsFor(item.client)) {
      if (seen.has(spec.name)) {
        out.failures.push({ server: item.name, reason: `工具名重复：${spec.name}` })
        continue
      }
      seen.add(spec.name)
      out.toolSpecs.push(spec)
    }

    const unsupported = unsupportedCapabilities(item.client.capabilities)
    if (unsupported.length > 0) {
      options.onLog?.(
        `[mcp:${item.name}] server 声明了 qywork 尚未接的能力：${unsupported.join('、')}。` +
          `这些能力提供的东西不会出现在工具列表里。`,
      )
    }
    /*
     * 连上了、握手成功了、一个工具都没注册出来——**这件事必须说出来**。
     *
     * 这就是要修的那个静默失败：用户看到的是「配了 MCP 但什么都没发生」，
     * 而 failures 是空的、日志是干净的，无从下手。
     *
     * 判据是「产出为零」而不是「没声明能力」：后者只覆盖其中一种成因，
     * 而用户关心的是结果。理由里带上 server 声明了什么，
     * 这样「它只提供 prompts」和「它什么都不提供」一眼能分开。
     */
    const produced = out.toolSpecs.filter((s) => s.name.startsWith(`mcp__${item.name}__`)).length
    if (produced === 0) {
      const declared = Object.keys(item.client.capabilities)
      out.failures.push({
        server: item.name,
        reason:
          '握手成功但没有注册任何工具。' +
          (declared.length === 0
            ? 'server 没有声明任何能力，也没有响应 tools/list。'
            : `server 声明的能力是：${declared.join('、')}${
                unsupported.length ? `，其中 ${unsupported.join('、')} qywork 尚未支持` : ''
              }。`),
      })
    }

    out.servers.push({
      name: item.name,
      client: item.client,
      tools: item.tools,
      serverInfo: item.client.serverInfo,
      protocolVersion: item.client.protocolVersion,
      capabilities: item.client.capabilities,
      unsupported,
    })
  }

  return out
}

/**
 * server 声明了、我们没接的能力。
 *
 * 判据是 `SUPPORTED_CAPABILITIES` 这份清单，而不是在这里另写一遍 if——
 * 另写一遍的话，将来接了 `prompts` 却忘了改这里，用户会一直看到
 * 一句「尚未接 prompts」的假警告。
 */
export function unsupportedCapabilities(caps: McpServerCapabilities): string[] {
  const supported = new Set<string>(SUPPORTED_CAPABILITIES)
  return Object.keys(caps ?? {})
    .filter((k) => !supported.has(k))
    .sort()
}
