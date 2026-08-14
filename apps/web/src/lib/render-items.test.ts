/**
 * 渲染投影的回归锁。
 *
 * 分组规则是这套 UI 里最容易被「顺手优化」改坏的一块：改动看起来只影响观感，
 * 实际会让用户找不到东西——比如把末尾那段思考卷进工具折叠里，它就消失了。
 * 这里把文件头列的四条规则逐条钉死。
 */

import { describe, expect, test } from 'bun:test'
import {
  actionLabel,
  buildRenderItems,
  groupTitle,
  reconcileRenderItems,
  verb,
} from './render-items.ts'
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

  /*
   * 收尾读数是这一轮的句号，被折进末尾那张组卡就等于没有——用户要一眼扫到
   * 「这轮花了多少、跑了多久」，而组卡默认是收起的。
   */
  test('收尾读数独立成条，不被卷进末尾的工具组', () => {
    const out = buildRenderItems([tool('a'), tool('b'), item('run')])
    expect(kinds(out)).toEqual(['group', 'run'])
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
      item('run'),
    ]
    const out = buildRenderItems(input)
    const count = out.reduce((n, r) => n + (r.kind === 'group' ? r.members.length : 1), 0)
    expect(count).toBe(input.length)
  })
})

describe('组头文案', () => {
  test('有正在跑的就只说正在做什么', () => {
    expect(groupTitle([tool('a', 'read'), tool('b', 'write', { status: 'running' })])).toBe(
      '正在创建…',
    )
  })

  /** 说不出动作时说「进行中」。不许借「执行」这类具体词——那是替一次调用编造它在干什么。 */
  test('没有动作的行在跑时说「进行中」，不编一个动词', () => {
    expect(groupTitle([item('tool', { status: 'running', toolName: 'x' })])).toBe('进行中…')
  })

  test('同桶对象一致时用那个名词', () => {
    expect(groupTitle([tool('文件', 'read'), tool('文件', 'read')])).toBe('读取 2 个文件')
  })

  test('同桶对象不一致时退化成「动作」 —— 硬凑名词只会误导', () => {
    expect(groupTitle([tool('a.ts', 'read'), tool('b.ts', 'read')])).toBe('读取 2 个动作')
  })

  test('多桶按首次出现顺序拼', () => {
    const t = groupTitle([tool('x', 'read'), tool('y', 'write'), tool('x', 'read')])
    expect(t.indexOf('读取')).toBeLessThan(t.indexOf('创建'))
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
  /** 六个真动作，一个 kind 一个词，和青研魔盒 `StepCard.ACTION_VERBS` 同一套。 */
  test('六个动作各有动词', () => {
    expect(verb('query')).toBe('查询')
    expect(verb('read')).toBe('读取')
    expect(verb('write')).toBe('创建')
    expect(verb('edit')).toBe('编辑')
    expect(verb('delete')).toBe('删除')
    expect(verb('run')).toBe('运行')
  })

  /**
   * **没有兜底文案。** 拼不出动作的行不存在——名字不在注册表里的调用在 `loop.ts`
   * 就被挡在执行链外、根本不会变成 step；`action` 从第一个提交起就一直落库；
   * 退役的 kind 由迁移 16 转掉。这两条断言锁的是「真出现了要看得出来是 bug」，
   * 不是「要显示成什么中文」——曾经这里先后编过四个版本的兜底词条。
   */
  test('认不出的 kind 给空串，不编词也不拿原始名顶替', () => {
    expect(actionLabel(tool('命令', 'execute', { toolName: 'run_command' }))).toBe('')
  })

  test('没有 action 的行给空串', () => {
    expect(actionLabel(item('tool', { toolName: 'weird__thing' }))).toBe('')
  })

  test('运行命令是动词加对象拼出来的，不是特例', () => {
    expect(actionLabel(tool('命令', 'run'))).toBe('运行命令')
  })

  test('有对象就动词加对象', () => {
    expect(actionLabel(tool('a.ts', 'read'))).toBe('读取a.ts')
  })

  test('没有对象名时也不拿工具名顶替', () => {
    expect(actionLabel(item('tool', { toolName: 'grep' }))).toBe('')
  })
})

describe('对账：没变的行保持同一个引用', () => {
  /**
   * 直接复现原始失败形状：`<For>` 按引用配对，而每次 build 都产出全新包装对象，
   * 于是每 push 一条就整列重建 DOM——展开着的 `<details>` 随之合上。
   * 所以这里断言的是**引用相等**，不是内容相等。
   */
  test('追加一条时，先前的行仍是同一个对象', () => {
    const a = item('user', { text: '问' })
    const b = item('text', { text: '答' })

    const first = buildRenderItems([a, b])
    const second = reconcileRenderItems(
      first,
      buildRenderItems([a, b, item('text', { text: '又' })]),
    )

    expect(second.length).toBe(first.length + 1)
    expect(second[0]).toBe(first[0])
    expect(second[1]).toBe(first[1])
  })

  test('底下那条 transcript 换了对象就不能复用', () => {
    const a = item('user', { text: '问' })
    const first = buildRenderItems([a])
    // 同一个 id、不同对象：内容变了，必须换新包装，否则行内容不刷新。
    const replaced = { ...a, text: '改过了' } as TranscriptItem
    const second = reconcileRenderItems(first, buildRenderItems([replaced]))
    expect(second[0]).not.toBe(first[0])
  })

  test('首次构建原样返回，不做无谓分配', () => {
    const built = buildRenderItems([item('user', { text: '问' })])
    expect(reconcileRenderItems([], built)).toBe(built)
  })
})
