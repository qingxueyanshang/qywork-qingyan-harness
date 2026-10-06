/**
 * 模型侧 MCP 配置动作。
 *
 * 工具只负责参数与动作语义，实际的解析与落盘经由 `ToolContext.mcpConfig`。解析器与作用域路径分别属于两个
 * 同层包，不能在此处复制规则或新增横向依赖。
 */

import type { ToolSpec } from '@qywork/agent'

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
  parallelSafe: false,
  resourceKeys: (a) => [`mcp-config:${String(a.scope ?? 'project')}`],

  async fn(args, ctx) {
    const name = String(args.name ?? '').trim()
    const configJson = String(args.config_json ?? '').trim()
    const scope = writableScope(args.scope)
    if (!name) return { status: 'failure', message: '缺少 name' }
    if (!configJson) return { status: 'failure', message: '缺少 config_json' }
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

function activationMessage(activation: import('@qywork/agent').McpActivation | undefined): string {
  if (!activation) return '配置已保存，尚未取得连接结果'
  if (activation.failures.length)
    return `配置已保存，连接或能力装配失败：${activation.failures.map((f) => `${f.server}：${f.reason}`).join('；')}`
  if (activation.inactive.length) return `配置已保存，服务已禁用：${activation.inactive.join('、')}`
  return `已连接，工具将在本批结束后的下一次模型请求生效：${activation.toolNames.join('、') || '无可用工具'}`
}
