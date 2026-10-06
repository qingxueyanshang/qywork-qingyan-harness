import { describe, expect, test } from 'bun:test'
import { newMcpPrompt, newMemoryPrompt, newSkillPrompt } from './ScopePrompts.ts'

describe('设置页将当前作用域传给模型', () => {
  test.each([
    ['记忆', newMemoryPrompt, 'write_memory', 'move_memory'],
    ['技能', newSkillPrompt, 'write_skill', 'move_skill'],
    ['MCP', newMcpPrompt, 'write_mcp_server', 'move_mcp_server'],
  ] as const)(
    '%s 的新增提示词包含所选作用域与迁移后不同时保留的约束',
    (_name, build, write, move) => {
      expect(build('project')).toContain(`调用 ${write} 并明确传入 scope=project`)
      const global = build('global')
      expect(global).toContain('全局层（global）')
      expect(global).toContain(`调用 ${write} 并明确传入 scope=global`)
      expect(global).toContain(`调用 ${move}`)
      expect(global).toContain('不能在两个作用域中同时保留')
    },
  )
})
