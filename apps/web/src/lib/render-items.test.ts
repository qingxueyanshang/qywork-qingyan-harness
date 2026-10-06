/**
 * 渲染投影的回归测试。
 *
 * 分组规则是该界面中最容易在优化时被改错的部分：改动看似只影响外观，
 * 实际会使用户无法找到内容，例如末尾的思考被折叠进工具组后不再显示。
 * 此处逐条锁定 `render-items.ts` 文件头列出的四条规则。
 */

import { describe, expect, test } from 'bun:test'
import {
  actionLabel,
  buildRenderItems,
  delegationStatus,
  groupTitle,
  sameRenderItem,
  verb,
} from './render-items.ts'
import type { TranscriptItem } from './store/index.ts'

let seq = 0

/**
 * 夹具的覆盖项。不含 `id` / `kind`：二者由工厂负责，不应被覆盖。
 *
 * 返回值上的 `as TranscriptItem` 是有意保留的：
 * 开启 `exactOptionalPropertyTypes` 后，把可选属性展开到目标对象，结果类型是
 * 「属性存在且为 `undefined`」，而目标要求「属性不存在」，二者在类型层面
 * 不兼容，任何 `{...base, ...partial}` 形式的夹具都无法通过类型检查。
 * 改为逐字段 if 判断可以去掉该断言，但会使 3 行的夹具变为 15 行。
 * 这是测试夹具，不是产品代码中的类型漏洞。
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
  /** 复现的失败形状：一张四节点的图被并入「运行 1 个编排…」所在的工具组，图不再显示。 */
  test('派发任务的两个工具不进入工具组，前后的工具照常成组', () => {
    const out = buildRenderItems([
      tool('a.ts'),
      tool('b.ts'),
      tool('图', 'run', { toolName: 'workflow' }),
      tool('c.ts'),
      tool('d.ts'),
    ])
    expect(kinds(out)).toEqual(['group', 'tool', 'group'])
  })

  test('单次派发同样独立成条', () => {
    const out = buildRenderItems([
      tool('子 agent', 'run', { toolName: 'subagent' }),
      tool('a.ts'),
      tool('b.ts'),
    ])
    expect(kinds(out)).toEqual(['tool', 'group'])
  })

  test('模型视觉输入默认仍是普通工具结果，不显示为会话图片', () => {
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
    expect(kinds(out)).toEqual(['group'])
  })

  test('明确声明 inline 的图片结果不并入工具组', () => {
    const out = buildRenderItems([
      tool('文件'),
      tool('图片', 'read', {
        outcome: {
          status: 'success',
          executed: true,
          message: '生成 image.png',
          data: { images: [{ data: 'aGVsbG8=', mime: 'image/png' }] },
          presentation: { images: 'inline' },
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

  test('少于 2 个工具时不生成工具组卡片，单个工具无需折叠', () => {
    expect(kinds(buildRenderItems([tool('a.ts')]))).toEqual(['tool'])
    expect(kinds(buildRenderItems([tool('a.ts'), tool('b.ts')]))).toEqual(['group'])
  })

  test('thinking 不拆分工具组：位于首尾工具之间的思考进入工具组', () => {
    const out = buildRenderItems([tool('a'), item('thinking', { text: '想' }), tool('b')])
    expect(kinds(out)).toEqual(['group'])
    expect(out[0]).toMatchObject({ kind: 'group' })
    if (out[0]?.kind === 'group') expect(out[0].members).toHaveLength(3)
  })

  test('工具组之前的思考单独成条', () => {
    const out = buildRenderItems([item('thinking'), tool('a'), tool('b')])
    expect(kinds(out)).toEqual(['thinking', 'group'])
  })

  test('工具组之后的思考单独成条，末尾的思考不得并入折叠', () => {
    const out = buildRenderItems([tool('a'), tool('b'), item('thinking', { text: '想完了' })])
    expect(kinds(out)).toEqual(['group', 'thinking'])
    if (out[0]?.kind === 'group') {
      expect(out[0].members.every((m) => m.kind === 'tool')).toBe(true)
    }
  })

  test('只有思考没有工具时，不丢失任何条目', () => {
    expect(kinds(buildRenderItems([item('thinking'), item('thinking')]))).toEqual([
      'thinking',
      'thinking',
    ])
  })

  test('空 transcript 返回空数组', () => {
    expect(buildRenderItems([])).toEqual([])
  })

  /*
   * 收尾读数是本轮的结尾，并入末尾的工具组卡片后无法直接看到：用户需要直接看到
   * 本轮的花费与耗时，而工具组卡片默认收起。
   */
  test('收尾读数独立成条，不并入末尾的工具组', () => {
    const out = buildRenderItems([tool('a'), tool('b'), item('run')])
    expect(kinds(out)).toEqual(['group', 'run'])
  })

  test('任何输入下都不丢失条目：组内成员与组外条目之和等于原长度', () => {
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

describe('workflow 始终是一张卡片', () => {
  const nodes = [
    { id: 'a', kind: 'role', role: 'dev', task: '查' },
    { id: 'cp', kind: 'checkpoint', label: '主会话审查', needs: ['a'] },
  ]
  /** 回执即该节点的终态：卡片按节点状态归并，转移中只保留派发对象。 */
  const cell = (output: string) => ({
    a: {
      phase: 'done' as const,
      label: '开发',
      output,
      durationMs: 10,
      subagentId: 'cv_a' as never,
    },
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

  test('被中断的首次派发按 nodes 归并出节点状态，卡片上的该节点仍可点开', () => {
    const out = buildRenderItems([
      {
        ...workflow('st_root', { goal: '目标', nodes }, undefined, 'failure'),
        outcome: { status: 'failure', executed: true, message: '执行期间被中断，结果未知' },
        nodes: { a: { phase: 'interrupted', label: '开发', subagentId: 'cv_a' as never } },
      },
    ])
    expect(out.map((row) => row.kind)).toEqual(['tool'])
    const card = out[0]
    if (card?.kind !== 'tool') throw new Error('没有 workflow 卡')
    expect(card.item.workflow?.phase).toBe('failed')
    expect(card.item.workflow?.results.a).toMatchObject({
      status: 'failed',
      error: '调用中断',
      subagentId: 'cv_a',
    })
  })

  test('首轮与 revise 只保留同一张卡片，并累计次数、保留原 conversationId', () => {
    const out = buildRenderItems([
      {
        ...workflow(
          'st_root',
          { goal: '目标', nodes },
          {
            workflowId: 'st_root',
            dispatched: ['a'],
          },
        ),
        nodes: cell('初稿'),
      },
      item('text', { text: '主会话发现证据不足' }),
      {
        ...workflow(
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
            dispatched: ['a'],
            review: { checkpointId: 'cp', decision: 'revise', note: '补证据' },
          },
        ),
        nodes: cell('修订稿'),
      },
    ])
    expect(out.map((row) => row.kind)).toEqual(['text', 'tool'])
    const card = out[1]
    expect(card?.id).toBe('st_root')
    if (card?.kind !== 'tool') throw new Error('没有 workflow 卡')
    expect(card.item.workflow?.results.a?.output).toBe('修订稿')
    expect(card.item.workflow?.results.a?.subagentId).toBe('cv_a')
  })

  test('下一次 review 刚进入 started 时即归入原卡片，不出现第二张卡片', () => {
    const out = buildRenderItems([
      {
        ...workflow(
          'st_root',
          { goal: '目标', nodes },
          {
            workflowId: 'st_root',
            dispatched: ['a'],
          },
        ),
        nodes: cell('初稿'),
      },
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

  test('两个独立 workflow 不会互相合并', () => {
    const one = {
      ...workflow('st_one', { goal: '一', nodes }, { workflowId: 'st_one', dispatched: ['a'] }),
      nodes: cell('一'),
    }
    const two = {
      ...workflow('st_two', { goal: '二', nodes }, { workflowId: 'st_two', dispatched: ['a'] }),
      nodes: cell('二'),
    }
    expect(buildRenderItems([one, two]).map((row) => row.id)).toEqual(['st_one', 'st_two'])
  })

  test('outcome.data.nodes 不作为渲染结果来源', () => {
    const old = workflow(
      'st_old',
      { goal: '旧图', nodes },
      {
        nodes: [{ nodeId: 'a', label: '开发', status: 'done', output: '旧结果', durationMs: 10 }],
      },
    )
    const out = buildRenderItems([old])
    expect(out).toHaveLength(1)
    if (out[0]?.kind !== 'tool') throw new Error('没有旧卡')
    expect(out[0].item.workflow?.results).toEqual({})
    expect(out[0].item.workflow?.nodes[0]).toEqual({
      id: 'a',
      kind: 'subagent',
      target: { kind: 'role', role: 'dev' },
      task: '查',
    })
  })
})

describe('后台子任务摘要', () => {
  const task = (phase: 'working' | 'queued' | 'done' | 'failed', label = '开发') =>
    item('tool', {
      toolName: 'subagent',
      nodes: { subagent: { phase, label, subagentId: 'cv_dev' as never } },
    })

  test('同一子会话再次派发时只显示最新状态，旧任务名与失败终态不显示为运行中', () => {
    const first = task('working', '初稿')
    const resumed = task('queued', '修订')
    expect(delegationStatus([first, resumed])).toBe('子任务排队中：修订')
    expect(delegationStatus([first, resumed, task('working', '修订')])).toBe('等待子任务返回：修订')
    expect(delegationStatus([first, resumed, task('done')])).toBeNull()
    expect(delegationStatus([first, resumed, task('failed')])).toBeNull()
  })
})

describe('分组标题文案', () => {
  /**
   * 运行中同样显示摘要，不改为「正在<某一项的动词>…」。
   *
   * 一个工具组通常包含多种动作，以其中一项的动词作为整组标题无法描述整组动作；
   * 且该句与卡片自身的「运行命令 · npm test」只差「正在」二字。
   * 是否在运行由分组标题右侧的加载图标表示。
   */
  test('含运行中的工具时仍显示摘要，不改为「正在…」', () => {
    expect(groupTitle([tool('文件', 'read'), tool('命令', 'run', { status: 'running' })])).toBe(
      '读取 1 个文件，运行 1 次命令',
    )
  })

  /** 计数包含正在运行的工具：工具陆续启动时计数随之增长，不会先显示为空。 */
  test('运行中的工具也计入计数', () => {
    expect(groupTitle([tool('命令', 'run', { status: 'running' })])).toBe('运行 1 次命令')
  })

  test('同类动作的对象一致时使用该名词', () => {
    expect(groupTitle([tool('文件', 'read'), tool('文件', 'read')])).toBe('读取 2 个文件')
  })

  test('同类动作的对象不一致时退化为「动作」，不强行选用误导性的名词', () => {
    expect(groupTitle([tool('a.ts', 'read'), tool('b.ts', 'read')])).toBe('读取 2 个动作')
    // 调用与运行按「次」计数：对象是同一个浏览器或同一条命令，按「个」计数会把一个页面计为三个。
    expect(
      groupTitle([
        tool('浏览器控制', 'call'),
        tool('浏览器控制', 'call'),
        tool('浏览器控制', 'call'),
      ]),
    ).toBe('调用 3 次浏览器控制')
  })

  test('多类动作按首次出现顺序拼接', () => {
    const t = groupTitle([tool('x', 'read'), tool('y', 'write'), tool('x', 'read')])
    expect(t.indexOf('读取')).toBeLessThan(t.indexOf('创建'))
  })

  test('失败工具仍计入动作摘要，失败数由分组标题单独显示', () => {
    expect(groupTitle([tool('文件', 'read'), tool('文件', 'read', { status: 'failure' })])).toBe(
      '读取 2 个文件',
    )
  })

  test('思考条目不参与分组标题统计', () => {
    expect(groupTitle([tool('文件', 'read'), item('thinking'), tool('文件', 'read')])).toBe(
      '读取 2 个文件',
    )
  })
})

describe('动词与单条文案', () => {
  /** 七个动作，每个 kind 对应一个词；缺少任一个时，对应卡片的标题为空。 */
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
   * 不设后备文案。无法拼接出动作的行不存在：名称不在注册表中的调用在 `agent/loop/tool-wave.ts`
   * 已被拦截在执行链之外，不会成为 step；`action` 自第一个提交起一直写入数据库；
   * 已停用的 kind 由迁移 16 转换。这两条断言锁定的是「出现时能识别为缺陷」，
   * 而不是「显示为何种文字」；不要为它编写后备词条。
   */
  test('无法识别的 kind 返回空字符串，不编造词语，也不以原始名称代替', () => {
    expect(actionLabel(tool('命令', 'execute', { toolName: 'run_command' }))).toBe('')
  })

  test('没有 action 的行返回空字符串', () => {
    expect(actionLabel(item('tool', { toolName: 'weird__thing' }))).toBe('')
  })

  test('「运行命令」由动词与对象拼接而成，不是特例', () => {
    expect(actionLabel(tool('命令', 'run'))).toBe('运行命令')
  })

  test('有对象时为动词加对象', () => {
    expect(actionLabel(tool('a.ts', 'read'))).toBe('读取a.ts')
  })

  test('没有对象名时也不以工具名代替', () => {
    expect(actionLabel(item('tool', { toolName: 'grep' }))).toBe('')
  })
})

describe('相等判据：外壳中的信号是否需要更新', () => {
  test('底层仍是同一条 transcript 条目时视为未变化', () => {
    const a = item('user', { text: '问' })
    const [first] = buildRenderItems([a])
    const [second] = buildRenderItems([a])
    expect(sameRenderItem(first!, second!)).toBe(true)
  })

  test('同一 id 指向不同对象时视为已变化', () => {
    const a = item('user', { text: '问' })
    const [first] = buildRenderItems([a])
    const [second] = buildRenderItems([{ ...a, text: '改过了' } as TranscriptItem])
    expect(sameRenderItem(first!, second!)).toBe(false)
  })

  /** 复现的失败形状：运行中展开的工具组卡片，在下一个工具启动、成员增加一个时自动收起。 */
  test('工具组卡片成员增加时视为已变化，成员相同时视为未变化', () => {
    const a = tool('a.ts')
    const b = tool('b.ts')
    const [two] = buildRenderItems([a, b])
    const [twoAgain] = buildRenderItems([a, b])
    const [three] = buildRenderItems([a, b, tool('c.ts')])
    expect(two!.kind).toBe('group')
    expect(sameRenderItem(two!, twoAgain!)).toBe(true)
    expect(sameRenderItem(two!, three!)).toBe(false)
  })

  test('kind 改变时视为已变化', () => {
    const a = tool('a.ts')
    const [single] = buildRenderItems([a])
    const [group] = buildRenderItems([a, tool('b.ts')])
    expect(single!.id).toBe(group!.id)
    expect(sameRenderItem(single!, group!)).toBe(false)
  })
})
