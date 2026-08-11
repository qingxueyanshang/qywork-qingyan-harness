/**
 * 渲染投影的回归锁。
 *
 * 分组规则是这套 UI 里最容易被「顺手优化」改坏的一块：改动看起来只影响观感，
 * 实际会让用户找不到东西——比如把末尾那段思考卷进工具折叠里，它就消失了。
 * 这里把文件头列的四条规则逐条钉死。
 */

import { describe, expect, test } from 'bun:test'
import { actionLabel, buildRenderItems, groupTitle, verb } from './render-items.ts'
import type { TranscriptItem } from './store/index.ts'

let seq = 0

/**
 * 夹具的覆盖项。不含 `id` / `kind`——那两个由工厂负责，不该被盖掉。
 *
 * 返回值上那个 `as TranscriptItem` 是**故意留的**，不是偷懒：
 * `exactOptionalPropertyTypes` 打开后，把一个可选属性展开进目标对象，结果类型是
 * 「属性存在且为 `undefined`」，而目标要的是「属性缺席」——这两件事在类型层面
 * 不兼容，任何 `{...base, ...partial}` 的夹具写法都过不去。
 * 换成逐字段 if 判断能去掉这个断言，但会让一个 3 行的夹具变成 15 行。
 * 这是测试夹具，不是产品代码里的类型漏洞。
 */
type ItemOverrides = { text?: string } & {
  [K in Exclude<keyof TranscriptItem, 'id' | 'kind' | 'text'>]?: TranscriptItem[K] | undefined
}

const item = (kind: TranscriptItem['kind'], extra: ItemOverrides = {}): TranscriptItem =>
  ({
    id: `i${++seq}`,
    kind,
    text: '',
    ...extra,
  }) as TranscriptItem
const tool = (objectLabel: string, actionKind = 'read', extra: ItemOverrides = {}) =>
  item('tool', {
    toolName: 'read_file',
    status: 'success',
    action: { kind: actionKind, objectLabel } as TranscriptItem['action'],
    ...extra,
  })

const kinds = (items: ReturnType<typeof buildRenderItems>) => items.map((r) => r.kind)

describe('分组规则', () => {
  test('只有 assistant 正文打断分组', () => {
    const out = buildRenderItems([
      tool('a.ts'),
      tool('b.ts'),
      item('text', { text: '说点什么' }),
      tool('c.ts'),
      tool('d.ts'),
    ])
    expect(kinds(out)).toEqual(['group', 'text', 'group'])
  })

  test('user 与 compaction 同样打断分组', () => {
    expect(kinds(buildRenderItems([tool('a'), tool('b'), item('user')]))).toEqual(['group', 'user'])
    expect(kinds(buildRenderItems([tool('a'), tool('b'), item('compaction')]))).toEqual([
      'group',
      'compaction',
    ])
  })

  test('少于 2 个工具不组卡 —— 给一个工具套折叠纯属添乱', () => {
    expect(kinds(buildRenderItems([tool('a.ts')]))).toEqual(['tool'])
    expect(kinds(buildRenderItems([tool('a.ts'), tool('b.ts')]))).toEqual(['group'])
  })

  test('thinking 不切组：夹在首尾工具之间的进组', () => {
    const out = buildRenderItems([tool('a'), item('thinking', { text: '想' }), tool('b')])
    expect(kinds(out)).toEqual(['group'])
    expect(out[0]).toMatchObject({ kind: 'group' })
    if (out[0]?.kind === 'group') expect(out[0].members).toHaveLength(3)
  })

  test('组前的思考单独成条', () => {
    const out = buildRenderItems([item('thinking'), tool('a'), tool('b')])
    expect(kinds(out)).toEqual(['thinking', 'group'])
  })

  test('组后的思考单独成条 —— 末尾那段尤其不能卷进折叠', () => {
    const out = buildRenderItems([tool('a'), tool('b'), item('thinking', { text: '想完了' })])
    expect(kinds(out)).toEqual(['group', 'thinking'])
    if (out[0]?.kind === 'group') {
      expect(out[0].members.every((m) => m.kind === 'tool')).toBe(true)
    }
  })

  test('只有思考没有工具时，一条都不丢', () => {
    expect(kinds(buildRenderItems([item('thinking'), item('thinking')]))).toEqual([
      'thinking',
      'thinking',
    ])
  })

  test('空 transcript 给空数组', () => {
    expect(buildRenderItems([])).toEqual([])
  })

  test('任何输入下条目都不丢 —— 组内成员加组外条目等于原长度', () => {
    const input = [
      item('user'),
      item('thinking'),
      tool('a'),
      tool('b'),
      item('thinking'),
      item('text'),
      tool('c'),
      item('compaction'),
    ]
    const out = buildRenderItems(input)
    const count = out.reduce((n, r) => n + (r.kind === 'group' ? r.members.length : 1), 0)
    expect(count).toBe(input.length)
  })
})

describe('组头文案', () => {
  test('有正在跑的就只说正在做什么', () => {
    expect(groupTitle([tool('a', 'read'), tool('b', 'write', { status: 'running' })])).toBe(
      '正在写入…',
    )
  })

  test('同桶对象一致时用那个名词', () => {
    expect(groupTitle([tool('文件', 'read'), tool('文件', 'read')])).toBe('读取 2 个文件')
  })

  test('同桶对象不一致时退化成「动作」 —— 硬凑名词只会误导', () => {
    expect(groupTitle([tool('a.ts', 'read'), tool('b.ts', 'read')])).toBe('读取 2 个动作')
  })

  test('多桶按首次出现顺序拼', () => {
    const t = groupTitle([tool('x', 'read'), tool('y', 'write'), tool('x', 'read')])
    expect(t.indexOf('读取')).toBeLessThan(t.indexOf('写入'))
  })

  test('有失败要报出失败数', () => {
    expect(
      groupTitle([tool('文件', 'read'), tool('文件', 'read', { status: 'failure' })]),
    ).toContain('1 个失败')
  })

  test('思考条不参与组头统计', () => {
    expect(groupTitle([tool('文件', 'read'), item('thinking'), tool('文件', 'read')])).toBe(
      '读取 2 个文件',
    )
  })
})

describe('动词与单条文案', () => {
  test('认识的 kind 各有动词', () => {
    expect(verb('read')).toBe('读取')
    expect(verb('execute')).toBe('执行')
    expect(verb('delegate')).toBe('委派')
  })

  test('不认识的 kind 落到「操作」，不抛也不显示原始 kind', () => {
    expect(verb('frobnicate')).toBe('操作')
    expect(verb(undefined)).toBe('操作')
  })

  test('execute 不拼对象 —— 命令行本身已经显示在卡片里', () => {
    expect(actionLabel(tool('rm -rf /', 'execute'))).toBe('执行命令')
  })

  test('有对象就动词加对象', () => {
    expect(actionLabel(tool('a.ts', 'read'))).toBe('读取a.ts')
  })

  test('没有 action 时退回工具名，不显示空动词', () => {
    expect(actionLabel(item('tool', { toolName: 'grep' }))).toBe('grep')
  })
})
