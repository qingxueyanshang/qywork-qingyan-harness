/**
 * 设置页保存角色：表单没有的字段不能被静默清掉。
 */
import { describe, expect, test } from 'bun:test'
import { nextRole } from './role-form.ts'

describe('保存角色', () => {
  const form = {
    id: 'reviewer',
    name: '审查员',
    description: '看代码',
    systemPrompt: '只审不改',
    model: 'm2',
  }

  test('原对象上表单没有的字段原样保留', () => {
    const existing = {
      id: 'reviewer',
      name: '旧名',
      provider: 'p',
      model: 'm1',
      effort: 'high',
      allowedTools: ['read_file'],
    } as never
    expect(nextRole(existing, form) as unknown).toEqual({
      id: 'reviewer',
      name: '审查员',
      description: '看代码',
      systemPrompt: '只审不改',
      provider: 'p',
      model: 'm2',
      effort: 'high',
      allowedTools: ['read_file'],
    })
  })

  test('模型清空时 provider 一并去掉', () => {
    const existing = { id: 'reviewer', provider: 'p', model: 'm1' }
    expect(nextRole(existing, { ...form, model: '' })).toEqual({
      id: 'reviewer',
      name: '审查员',
      description: '看代码',
      systemPrompt: '只审不改',
    })
  })

  test('新建时没有原对象', () => {
    expect(nextRole(undefined, form)).toEqual({
      id: 'reviewer',
      name: '审查员',
      description: '看代码',
      systemPrompt: '只审不改',
      model: 'm2',
    })
  })
})
