import { describe, expect, test } from 'bun:test'
import { newMcpPrompt, newMemoryPrompt, newSkillPrompt } from './ScopePrompts.ts'

describe('设置页把当前作用域交给模型', () => {
  test.each([
    ['记忆', newMemoryPrompt, 'write_memory', 'move_memory'],
    ['技能', newSkillPrompt, 'write_skill', 'move_skill'],
    ['MCP', newMcpPrompt, 'write_mcp_server', 'move_mcp_server'],
  ] as const)('%s 新增话头携带选择层和迁移的不留双份约束', (_name, build, write, move) => {
    expect(build('project')).toContain(`调用 ${write} 并明确传 scope=project`)
    const global = build('global')
    expect(global).toContain('全局层（global）')
    expect(global).toContain(`调用 ${write} 并明确传 scope=global`)
    expect(global).toContain(`调用 ${move}`)
    expect(global).toContain('不能在两个作用域各留一份')
  })
})
