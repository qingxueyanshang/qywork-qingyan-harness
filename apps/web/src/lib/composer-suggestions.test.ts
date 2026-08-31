import { describe, expect, test } from 'bun:test'
import { matchesMention, mentionQuery, replaceMention } from './composer-suggestions.ts'

describe('输入区引用', () => {
  test('# 检索技能，@ 检索调用目标', () => {
    expect(mentionQuery('#')).toEqual({ kind: 'skill', sigil: '#', query: '', start: 0 })
    expect(mentionQuery('请按 #release')).toEqual({
      kind: 'skill',
      sigil: '#',
      query: 'release',
      start: 3,
    })
    expect(mentionQuery('让@reviewer')).toEqual({
      kind: 'target',
      sigil: '@',
      query: 'reviewer',
      start: 1,
    })
  })

  test('邮箱与已经结束的引用不弹面板', () => {
    expect(mentionQuery('name@example.com')).toBeNull()
    expect(mentionQuery('使用 #release 发版')).toBeNull()
    expect(mentionQuery('普通正文')).toBeNull()
  })

  test('选中只替换末尾引用，保留前文', () => {
    const query = mentionQuery('请用 #rel')!
    expect(replaceMention('请用 #rel', query, 'release')).toBe('请用 #release ')
  })

  test('名称、说明和来源都可命中且忽略大小写', () => {
    expect(matchesMention('GIT', 'mcp__github__search', '搜索仓库', 'MCP · github')).toBe(true)
    expect(matchesMention('仓库', 'mcp__github__search', '搜索仓库', 'MCP · github')).toBe(true)
    expect(matchesMention('figma', 'render', '渲染设计', '插件 · figma')).toBe(true)
    expect(matchesMention('mail', 'render', '渲染设计', '插件 · figma')).toBe(false)
  })
})
