/**
 * 渲染投影的回归锁。
 *
 * 分组规则是这套 UI 里最容易在优化中被改坏的一块：改动看起来只影响观感，
 * 实际会让用户找不到内容——比如把末尾那段思考卷进工具折叠里，它就消失了。
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
 * 返回值上那个 `as TranscriptItem` 是**刻意保留的**：
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
  /** 复现的失败形状：一张四节点的图被并进「运行 1 个编排…」那一行，图看不见了。 */
  test('派活的那两个不进组，前后的工具照常成组', () => {
    const out = buildRenderItems([
      tool('a.ts'),
      tool('b.ts'),
      tool('图', 'run', { toolName: 'workflow' }),
      tool('c.ts'),
      tool('d.ts'),
    ])
    expect(kinds(out)).toEqual(['group', 'tool', 'group'])
  })

  test('单发也是独立一条', () => {
    const out = buildRenderItems([
      tool('子 agent', 'run', { toolName: 'subagent' }),
      tool('a.ts'),
      tool('b.ts'),
    ])
    expect(kinds(out)).toEqual(['tool', 'group'])
  })

  test('带图片结果的工具不埋进工具组', () => {
    const out = buildRenderItems([
      tool('文件'),
      tool('图片', 'read', {
        outcome: {
          status: 'success',
          executed: true,
          message: '读取 image.png（图片）',
          data: { images: [{ data: 'aGVsbG8=', mime: 'image/png' }] },
        },
      }),
      tool('文件'),
    ])
    expect(kinds(out)).toEqual(['tool', 'tool', 'tool'])
  })

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

describe('workflow 始终是一张卡', () => {
  const nodes = [
    { id: 'a', kind: 'agent', agent: 'dev', task: '查' },
    { id: 'cp', kind: 'checkpoint', label: '主会话审查', needs: ['a'] },
  ]
  const receipt = (output: string) => ({
    nodeId: 'a',
    agent: 'dev',
    label: '开发',
    status: 'done' as const,
    output,
    durationMs: 10,
    conversationId: 'cv_a',
  })
  const workflow = (
    id: string,
    args: Record<string, unknown>,
    data?: Record<string, unknown>,
    status: TranscriptItem['status'] = 'success',
  ): TranscriptItem => ({
    id,
    kind: 'tool',
    text: '',
    toolName: 'workflow',
    args,
    status,
    ...(data ? { outcome: { status: 'success', executed: true, message: 'ok', data } } : {}),
  })

  test('首轮与 revise 只保留同一张卡，并累计次数与原 conversationId', () => {
    const out = buildRenderItems([
      workflow(
        'st_root',
        { goal: '目标', nodes },
        {
          workflowId: 'st_root',
          phase: 'waiting_review',
          checkpointId: 'cp',
          receipts: [receipt('初稿')],
        },
      ),
      item('text', { text: '主会话发现证据不足' }),
      workflow(
        'st_review',
        {
          workflowId: 'st_root',
          checkpointId: 'cp',
          decision: 'revise',
          note: '补证据',
          revisions: [{ nodeId: 'a', instruction: '补证据' }],
        },
        {
          workflowId: 'st_root',
          phase: 'waiting_review',
          checkpointId: 'cp',
          receipts: [receipt('修订稿')],
          review: { checkpointId: 'cp', decision: 'revise', note: '补证据' },
        },
      ),
    ])
    expect(out.map((row) => row.kind)).toEqual(['text', 'tool'])
    const card = out[1]
    expect(card?.id).toBe('st_root')
    if (card?.kind !== 'tool') throw new Error('没有 workflow 卡')
    expect(card.item.workflow?.attempts.a).toBe(2)
    expect(card.item.workflow?.results.a?.output).toBe('修订稿')
    expect(card.item.workflow?.results.a?.conversationId).toBe('cv_a')
  })

  test('下一次 review 刚 started 时也立刻归入原卡，不闪出第二张', () => {
    const out = buildRenderItems([
      workflow(
        'st_root',
        { goal: '目标', nodes },
        {
          workflowId: 'st_root',
          phase: 'waiting_review',
          checkpointId: 'cp',
          receipts: [receipt('初稿')],
        },
      ),
      workflow(
        'st_live',
        {
          workflowId: 'st_root',
          checkpointId: 'cp',
          decision: 'revise',
          note: '补证据',
          revisions: [{ nodeId: 'a', instruction: '补证据' }],
        },
        undefined,
        'running',
      ),
    ])
    expect(out).toHaveLength(1)
    const card = out[0]
    if (card?.kind !== 'tool') throw new Error('没有 workflow 卡')
    expect(card.id).toBe('st_root')
    expect(card.item.workflow?.phase).toBe('running')
    expect(card.item.workflow?.results.a).toBeUndefined()
  })

  test('两张独立 workflow 不会互相吞并', () => {
    const one = workflow(
      'st_one',
      { goal: '一', nodes },
      {
        workflowId: 'st_one',
        phase: 'waiting_review',
        checkpointId: 'cp',
        receipts: [receipt('一')],
      },
    )
    const two = workflow(
      'st_two',
      { goal: '二', nodes },
      {
        workflowId: 'st_two',
        phase: 'waiting_review',
        checkpointId: 'cp',
        receipts: [receipt('二')],
      },
    )
    expect(buildRenderItems([one, two]).map((row) => row.id)).toEqual(['st_one', 'st_two'])
  })

  test('旧版一次性 workflow 没有 transition 时保持原样', () => {
    const old = workflow(
      'st_old',
      { goal: '旧图', nodes: [{ id: 'a', agent: 'dev', task: '查' }] },
      { nodes: [receipt('旧结果')] },
    )
    const out = buildRenderItems([old])
    expect(out).toHaveLength(1)
    if (out[0]?.kind !== 'tool') throw new Error('没有旧卡')
    expect(out[0].item).toBe(old)
    expect(out[0].item.workflow).toBeUndefined()
  })
})

describe('组头文案', () => {
  /**
   * **跑着也是摘要**，不换成「正在<某一个的动词>…」。
   *
   * 一组里常混着好几种动作，拿其中一个的动词当整组标题说的不是这一组在干什么；
   * 而且那句话和卡片自己的「运行命令 · npm test」只差一个「正在」。
   * 在不在跑由组头右边的转圈说。
   */
  test('有正在跑的也是摘要，不换成「正在…」', () => {
    expect(groupTitle([tool('文件', 'read'), tool('命令', 'run', { status: 'running' })])).toBe(
      '读取 1 个文件，运行 1 个命令',
    )
  })

  /** 计数把正在跑的那条也算进去：工具陆续启动时数字自然增长，不会先空着。 */
  test('正在跑的工具也进计数', () => {
    expect(groupTitle([tool('命令', 'run', { status: 'running' })])).toBe('运行 1 个命令')
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
  /** 七个真动作，一个 kind 一个词——缺一个，卡片标题就掉回原始工具名。 */
  test('七个动作各有动词', () => {
    expect(verb('query')).toBe('查询')
    expect(verb('read')).toBe('读取')
    expect(verb('write')).toBe('创建')
    expect(verb('edit')).toBe('修改')
    expect(verb('delete')).toBe('删除')
    expect(verb('run')).toBe('运行')
    expect(verb('call')).toBe('调用')
  })

  /**
   * **没有兜底文案。** 拼不出动作的行不存在——名字不在注册表里的调用在 `loop.ts`
   * 就被挡在执行链外、不会变成 step；`action` 从第一个提交起就一直落库；
   * 退役的 kind 由迁移 16 转掉。这两条断言锁的是「真出现了要看得出来是 bug」，
   * 不是「要显示成什么中文」——别再给它编兜底词条。
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
   * 因此每 push 一条就整列重建 DOM——展开着的 `<details>` 随之合上。
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
