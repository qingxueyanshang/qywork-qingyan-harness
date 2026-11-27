import { describe, expect, test } from 'bun:test'
import { isSkillDescription, parseSkillFrontmatter } from './skill.ts'

describe('技能前置元信息', () => {
  test('解析 name 与 description', () => {
    expect(parseSkillFrontmatter('---\nname: 发版\ndescription: 发布一个版本\n---\n正文')).toEqual({
      name: '发版',
      description: '发布一个版本',
    })
  })

  test('去除可选引号', () => {
    expect(parseSkillFrontmatter('---\nname: "带引号"\n---').name).toBe('带引号')
    expect(parseSkillFrontmatter("---\nname: '单引号'\n---").name).toBe('单引号')
  })

  test('无前置元信息时返回空，不抛出异常', () => {
    expect(parseSkillFrontmatter('直接是正文')).toEqual({ name: '', description: '' })
  })

  test('未知键被忽略：新增字段时已有技能不会报错', () => {
    const m = parseSkillFrontmatter('---\nname: a\nversion: 3\nauthor: b\n---')
    expect(m.name).toBe('a')
  })

  test('空描述与多行标量的引导符不能作为索引', () => {
    expect(isSkillDescription('')).toBe(false)
    expect(isSkillDescription('|')).toBe(false)
    expect(isSkillDescription('>-')).toBe(false)
    expect(isSkillDescription('发布一个版本')).toBe(true)
  })
})
