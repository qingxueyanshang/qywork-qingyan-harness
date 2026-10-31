/** 输入区 `#` / `@` 补全的候选项类型，以及把技能、项目角色、外部 Agent 与工具转换为候选项的函数。 */

import type { Command } from '../lib/commands.ts'
import type { CliAgentRow, SkillMeta, TeamRoleRow, ToolMeta } from '../lib/store/index.ts'
import { IconMcpSolid, IconPluginSolid, IconUsers } from './Icons.tsx'

export type MentionOption = {
  id: string
  name: string
  label: string
  hint: string
  icon: Command['icon']
}

export function scopeLabel(skill: SkillMeta): string {
  if (skill.scope === 'project') return '项目技能'
  if (skill.scope === 'global') return '全局技能'
  return '内置技能'
}

function toolSource(tool: ToolMeta): string {
  if (tool.source.startsWith('mcp:')) return `MCP · ${tool.source.slice(4)}`
  if (tool.source.startsWith('plugin:')) return `插件 · ${tool.source.slice(7)}`
  return tool.source
}

export function roleOption(role: TeamRoleRow): MentionOption {
  return {
    id: `agent:role:${role.id}`,
    name: role.id,
    label: `子 Agent · ${role.name}`,
    hint: role.description || '项目角色',
    icon: IconUsers,
  }
}

export function cliOption(agent: CliAgentRow): MentionOption {
  return {
    id: `agent:cli:${agent.id}`,
    name: `cli:${agent.id}`,
    label: `外部 Agent · ${agent.vendor}`,
    hint: '已连接',
    icon: IconUsers,
  }
}

export function toolOption(tool: ToolMeta): MentionOption {
  const source = toolSource(tool)
  return {
    id: `tool:${tool.name}`,
    name: tool.name,
    label: source,
    hint: tool.summary,
    icon: tool.source.startsWith('mcp:') ? IconMcpSolid : IconPluginSolid,
  }
}
