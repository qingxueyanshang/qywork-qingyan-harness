/**
 * 加载工作区中配置的 MCP server 并注册其工具。
 *
 * 不抛出异常：一个无法连接的 server 不应导致会话无法启动。失败写入返回值交给界面：
 * 静默跳过会使「已配置 MCP 但工具不出现」无法排查。
 */

import type { ToolSpec } from '@qywork/agent'
import {
  McpClient,
  type McpServerCapabilities,
  type McpToolDef,
  SUPPORTED_CAPABILITIES,
} from './client.ts'
import { specFor, toolName, toolNamePrefix } from './register.ts'
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
  /** server 握手时声明的能力，供 `qy mcp` 显示。 */
  capabilities: McpServerCapabilities
  /**
   * server 已声明而 qywork 未实现的能力名。
   *
   * 该字段用于消除一种静默失败：只提供 `prompts` 的 server
   * 会连接成功、握手成功、`tools/list` 返回空、注册 0 个工具，且不报告任何错误。
   * 用户只看到已配置却没有任何效果，日志中也没有任何记录。
   */
  unsupported: string[]
}

export interface McpRegistry {
  servers: LoadedServer[]
  /** 无法连接或握手失败的 server，界面需要显示。 */
  failures: { server: string; reason: string }[]
  /**
   * 产出的工具规格（名称含 `mcp__` 前缀）。与插件相同，只产出、不注册：
   * 注册由会话自行完成，扩展因此可以按工作区缓存，无需每条消息重新连接 server。
   */
  toolSpecs: ToolSpec[]
  stopAll(): Promise<void>
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
      // 静默选择时，用户修改了未被采用的字段，会面对一个没有任何变化的
      // 现象长时间排查。
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

export interface LoadMcpOptions {
  /** 解析工作区相对路径。由调用方注入，以免本包依赖 tools。 */
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
    stopAll: async () => {
      const results = await Promise.allSettled(out.servers.map((s) => s.client.stop()))
      const errors = results.filter((r) => r.status === 'rejected').map((r) => r.reason)
      if (errors.length) throw new AggregateError(errors, 'MCP 连接未全部关闭')
    },
  }

  const entries = Object.entries(config.servers)
    .filter(([, s]) => s.enabled !== false)
    // 按字典序排序：先到先得的资源（工具名）必须在不同机器上得到相同结果。
    .sort(([a], [b]) => (a < b ? -1 : 1))

  // 并行启动。串行启动时，五个 server 各需两秒握手，首屏即需十秒，
  // 而它们之间没有任何依赖。
  const loaded = await Promise.all(
    entries.map(async ([name, spec]) => {
      // HTTP server 没有工作目录。为其解析工作目录只会在配置中
      // 写了 cwd 时报错。
      let client: McpClient | undefined
      try {
        const cwd = isHttpSpec(spec)
          ? workspaceRoot
          : spec.cwd
            ? await (options.resolveCwd?.(spec.cwd) ?? Promise.resolve(workspaceRoot))
            : workspaceRoot
        client = new McpClient({
          name,
          spec,
          cwd,
          ...(options.onLog ? { onLog: options.onLog } : {}),
        })
        await client.start()
        /*
         * `tools/list` 一律调用，失败时再依据声明处理。
         *
         * 两个方向的非规范行为都实际存在，且要求相反的处理：
         *
         * - 声明了 tools 却无法列出：这是真实故障，照常抛出，计入 failures。
         * - 未声明 capabilities 却正常提供 tools：本仓库的两个测试夹具
         *   即是如此（`extensions.test.ts` / `session.test.ts` 的 fixture 只返回
         *   `protocolVersion` 与 `serverInfo`）。若按声明拦截，
         *   它们的工具会被静默全部丢弃，且更难排查：注册 0 个工具不是因为 server 确实没有，
         *   而是因为客户端没有查询。
         *
         * 因此：调用失败时，只有在 server 未声明 tools 时才忽略
         * （说明它本身不提供工具，例如只提供 resource 的 server）。
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
        await client
          ?.stop()
          .catch((error) => options.onLog?.(`[mcp:${name}] 关闭失败：${String(error)}`))
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
      // 重名不能静默覆盖：覆盖会静默丢弃某个 server 的一个工具。
      // （同名只可能来自同一个 server 的重复声明，server 名已包含在前缀中。）
      if (seen.has(full)) {
        out.failures.push({ server: item.name, reason: `工具名重复：${full}` })
        continue
      }
      seen.add(full)
      out.toolSpecs.push(specFor(item.client, def))
    }

    // resource 工具：仅在 server 声明了 capabilities.resources 时存在。
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
        `[mcp:${item.name}] server 声明了 qywork 尚未接入的能力：${unsupported.join('、')}。` +
          `这些能力提供的内容不会出现在工具列表中。`,
      )
    }
    /*
     * 连接成功、握手成功，却没有注册任何工具：必须报告这一情况。
     *
     * 否则用户只看到已配置 MCP 却没有任何效果，
     * 而 failures 为空、日志无记录，无从排查。
     *
     * 判据是产出为零，而不是未声明能力：后者只覆盖其中一种成因，
     * 而用户关心的是结果。原因中附带 server 声明的能力，
     * 以便直接区分「只提供 prompts」与「不提供任何能力」。
     */
    const produced = out.toolSpecs.filter((s) =>
      s.name.startsWith(toolNamePrefix(item.name)),
    ).length
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
 * server 已声明而本仓库未接入的能力。
 *
 * 判据是 `SUPPORTED_CAPABILITIES` 清单，而不是在此处另写一组 if：
 * 另写时，接入 `prompts` 后若忘记修改此处，用户会持续看到
 * 「尚未接入 prompts」的错误警告。
 */
export function unsupportedCapabilities(caps: McpServerCapabilities): string[] {
  const supported = new Set<string>(SUPPORTED_CAPABILITIES)
  return Object.keys(caps ?? {})
    .filter((k) => !supported.has(k))
    .sort()
}
