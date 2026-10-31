/**
 * 模型侧 MCP 配置动作。
 *
 * 工具只负责参数与动作语义，实际的解析与落盘经由 `ToolContext.mcpConfig`。解析器与作用域路径分别属于两个
 * 同层包，不能在此处复制规则或新增横向依赖。
 */

import type { ToolSpec } from '@qywork/agent'
import { jsonArg } from './args.ts'

function scopeProperty(): Record<string, unknown> {
  return {
    type: 'string',
    enum: ['project', 'global'],
    description: '写入层；不传时默认为 project，用户明确要求全局时必须传 global',
  }
}

function writableScope(raw: unknown): 'project' | 'global' | null {
  if (raw === undefined || raw === null || raw === 'project') return 'project'
  if (raw === 'global') return 'global'
  return null
}

export const writeMcpServerTool: ToolSpec = {
  name: 'write_mcp_server',
  description:
    '新增或更新一个 MCP server。config_json 只写单个 server 的配置对象。默认写项目层；用户明确要求全局时 scope 必须传 global。保存后连接并发现工具，回执区分配置保存与连接结果。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'server 名称' },
      config_json: {
        type: 'string',
        description:
          '单个 server 的 JSON 对象；stdio 使用 command/args/env/cwd，HTTP 使用 url/headers，二者不能混用',
      },
      scope: scopeProperty(),
    },
    required: ['name', 'config_json'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: 'MCP 服务',
  category: 'mcp',
  facet: 'MCP',
  summary: '新增或更新一个 MCP 服务',
  targetExtractor: (a) => (typeof a.name === 'string' ? a.name : null),
  permissionEffect: 'write',
  // 写入 stdio 服务即启动其命令：与 `run_command` 经同一个命令判定。HTTP 服务不启动本机进程。
  commandLine: (a) => stdioCommandLine(a.config_json),
  parallelSafe: false,
  resourceKeys: (a) => [`mcp-config:${String(a.scope ?? 'project')}`],

  async fn(args, ctx) {
    const name = String(args.name ?? '').trim()
    const config = jsonArg(args.config_json, 'object', 'config_json')
    const scope = writableScope(args.scope)
    if (!name) return { status: 'failure', message: '缺少 name' }
    if (!config.ok) return { status: 'failure', message: config.error }
    if (config.value === undefined) return { status: 'failure', message: '缺少 config_json' }
    const configJson = JSON.stringify(config.value)
    if (!scope) return { status: 'failure', message: 'scope 只能是 project 或 global' }
    if (!ctx.mcpConfig) return { status: 'failure', message: '本次执行没有 MCP 配置通道' }

    const result = await ctx.mcpConfig.writeServer({ name, configJson, scope })
    if (!result.ok)
      return {
        status: 'failure',
        message: result.error ?? '写入 MCP 配置失败',
        data: { ...result },
      }
    return {
      status: result.activation?.connected ? 'success' : 'failure',
      message: `已${result.replaced ? '更新' : '新增'}${scope === 'global' ? '全局' : '项目'} MCP 服务 ${name}；${activationMessage(result.activation)}${result.activation?.effectiveScopes?.[name] && result.activation.effectiveScopes[name] !== scope ? `；当前生效的是 ${result.activation.effectiveScopes[name]} 层同名服务` : ''}`,
      data: { name, scope, ...result },
    }
  },
}

export const moveMcpServerTool: ToolSpec = {
  name: 'move_mcp_server',
  description:
    '把一个 MCP server 从项目层迁移到全局层，或从全局层迁回项目层。成功后只保留目标层配置；目标层已有同名服务时拒绝且不修改来源层。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'server 名称' },
      from_scope: scopeProperty(),
      to_scope: scopeProperty(),
    },
    required: ['name', 'from_scope', 'to_scope'],
    additionalProperties: false,
  },
  actionKind: 'edit',
  objectLabel: 'MCP 服务',
  category: 'mcp',
  facet: 'MCP',
  summary: '在项目层与全局层之间迁移 MCP 服务',
  targetExtractor: (a) => (typeof a.name === 'string' ? a.name : null),
  permissionEffect: 'delete',
  // 迁入另一层即在该层启动它：迁入全局层的服务不再需要项目层的启动确认，因此同样经命令判定。
  commandLine: async (a, ctx) =>
    (await ctx.mcpConfig?.commandLineOf({
      name: String(a.name ?? '').trim(),
      scope: writableScope(a.from_scope) ?? 'project',
    })) ?? null,
  parallelSafe: false,
  resourceKeys: () => ['mcp-config:project', 'mcp-config:global'],

  async fn(args, ctx) {
    const name = String(args.name ?? '').trim()
    const from = writableScope(args.from_scope)
    const to = writableScope(args.to_scope)
    if (!name) return { status: 'failure', message: '缺少 name' }
    if (!from || !to) return { status: 'failure', message: '作用域只能是 project 或 global' }
    if (from === to) return { status: 'failure', message: '迁移的来源层和目标层不能相同' }
    if (!ctx.mcpConfig) return { status: 'failure', message: '本次执行没有 MCP 配置通道' }

    const result = await ctx.mcpConfig.moveServer({ name, fromScope: from, toScope: to })
    if (!result.ok)
      return {
        status: 'failure',
        message: result.error ?? '迁移 MCP 配置失败',
        data: { ...result },
      }
    return {
      status: result.activation?.connected ? 'success' : 'failure',
      message: `已把 MCP 服务 ${name} 从 ${from} 层迁移到 ${to} 层，只保留目标配置；${activationMessage(result.activation)}`,
      data: { name, from_scope: from, to_scope: to, ...result },
    }
  },
}

export const enableMcpServerTool: ToolSpec = {
  name: 'enable_mcp_server',
  description:
    '启用项目配置（.agents/mcp.json）中尚未启用的 MCP 服务。项目文件中的服务经用户确认后才启动；启用即以用户权限运行其命令，因此先向用户列出该命令并取得同意，再调用本工具。服务内容此后被修改时回到未启用。',
  parameters: {
    type: 'object',
    properties: { name: { type: 'string', description: 'server 名称' } },
    required: ['name'],
    additionalProperties: false,
  },
  actionKind: 'write',
  objectLabel: 'MCP 服务',
  category: 'mcp',
  facet: 'MCP',
  summary: '启用项目配置中的 MCP 服务',
  targetExtractor: (a) => (typeof a.name === 'string' ? a.name : null),
  permissionEffect: 'write',
  // 启用即启动该服务的命令：与 `run_command` 经同一个命令判定。
  commandLine: async (a, ctx) =>
    (await ctx.mcpConfig?.commandLineOf({ name: String(a.name ?? '').trim(), scope: 'project' })) ??
    null,
  parallelSafe: false,
  resourceKeys: () => ['mcp-config:project'],

  async fn(args, ctx) {
    const name = String(args.name ?? '').trim()
    if (!name) return { status: 'failure', message: '缺少 name' }
    if (!ctx.mcpConfig) return { status: 'failure', message: '本次执行没有 MCP 配置通道' }
    const result = await ctx.mcpConfig.enableServer({ name })
    if (!result.ok)
      return {
        status: 'failure',
        message: result.error ?? '启用 MCP 服务失败',
        data: { ...result },
      }
    return {
      status: result.activation?.connected ? 'success' : 'failure',
      message: `已启用项目 MCP 服务 ${name}；${activationMessage(result.activation)}`,
      data: { name, ...result },
    }
  },
}

/** 命令与参数按 shell 的写法拼接，含空白或特殊字符的参数加双引号。用于命令判定与向用户显示。 */
export function formatCommandLine(command: string, args: readonly string[]): string {
  return [command, ...args]
    .map((p) => (/^[\w@%+=:,./-]+$/.test(p) ? p : JSON.stringify(p)))
    .join(' ')
}

/**
 * stdio 服务配置将启动的命令行。不是 stdio 配置（HTTP 服务或无法解析）时返回 null；
 * 无法解析的配置由工具本身报告。
 */
export function stdioCommandLine(raw: unknown): string | null {
  const parsed = jsonArg(raw, 'object', 'config_json')
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') return null
  const { command, args } = parsed.value as { command?: unknown; args?: unknown }
  if (typeof command !== 'string' || !command.trim()) return null
  return formatCommandLine(command, Array.isArray(args) ? args.map(String) : [])
}

function activationMessage(activation: import('@qywork/agent').McpActivation | undefined): string {
  if (!activation) return '配置已保存，尚未取得连接结果'
  if (activation.failures.length)
    return `配置已保存，连接或能力装配失败：${activation.failures.map((f) => `${f.server}：${f.reason}`).join('；')}`
  if (activation.inactive.length) return `配置已保存，服务已禁用：${activation.inactive.join('、')}`
  return `已连接，工具将在本批结束后的下一次模型请求生效：${activation.toolNames.join('、') || '无可用工具'}`
}
