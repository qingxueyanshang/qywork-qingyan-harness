/**
 * 工具步骤呈现逻辑的口径。覆盖 `lib/step-view.ts`。
 *
 * 这些函数原本待在 `Transcript.tsx` 里，测不了——`bun test` 加载 `.tsx`
 * 会去找 JSX runtime 然后炸。它们每一个都有真实的边界条件，
 * 靠肉眼看渲染结果验不出来，所以先拆再测。
 */

import { describe, expect, test } from 'bun:test'
import {
  argsRows,
  CLAMP,
  clamp,
  collapseCarriageReturns,
  compact,
  delegateGraph,
  diffFrom,
  displayTarget,
  fileDelta,
  firstLine,
  firstString,
  hitRate,
  listOf,
  requestOutcome,
  resultImages,
  sanitizeTarget,
  statusWord,
  stopReasonLabel,
  TARGET_MAX,
  todosOf,
} from './step-view.ts'

test('重复失败的停止原因使用标准短句', () => {
  expect(stopReasonLabel('no_progress')).toBe('模型执行出错，多次重复，已暂停')
})

test('未知停止码不把内部枚举贴到界面', () => {
  expect(stopReasonLabel('future_internal_reason')).toBeNull()
})

describe('请求结果只显示产品文案', () => {
  const outcome = (over: {
    status?: 'pending' | 'in_flight' | 'received' | 'uncertain' | 'rejected'
    finishReason?: string
    errorCode?: string | null
    errorMessage?: string | null
    decision?:
      | 'resend'
      | 'interrupted'
      | 'not_retryable'
      | 'visible_output'
      | 'tool_calls_received'
      | 'limit_exhausted'
      | 'context_compaction'
      | 'context_compaction_failed'
      | 'process_exit'
  }) =>
    requestOutcome({
      status: over.status ?? 'rejected',
      finishReason: over.finishReason ?? '',
      errorCode: over.errorCode ?? null,
      errorMessage: over.errorMessage ?? null,
      diagnostic: over.decision ? { retry: { decision: over.decision } } : null,
    })

  test('provider 停止码归一化，不显示 stop/tool_calls 等协议值', () => {
    expect(outcome({ status: 'received', finishReason: 'stop' })).toBe('已完成')
    expect(outcome({ status: 'received', finishReason: 'tool_calls' })).toBe('调用工具')
    expect(outcome({ status: 'received', finishReason: 'completed:max_output_tokens' })).toBe(
      '输出被截断',
    )
    expect(outcome({ status: 'received', finishReason: 'provider_new_value' })).toBe('已回报')
  })

  test('没有 provider 原文时把错误码翻译成用户文案', () => {
    expect(outcome({ status: 'uncertain', errorCode: 'network_error' })).toBe('网络连接失败')
    expect(outcome({ errorCode: 'internal_error' })).toBe('内部错误')
    expect(outcome({ errorCode: 'future_internal_code' })).toBe('被拒绝')
  })

  test('九种重试裁决全部有唯一结果文案', () => {
    const decisions = [
      ['resend', '请求失败，已自动重发'],
      ['interrupted', '已中断，结果不明'],
      ['not_retryable', '请求失败，未重发'],
      ['visible_output', '请求失败，已有输出，未重发'],
      ['tool_calls_received', '请求失败，已有工具调用，未重发'],
      ['limit_exhausted', '请求失败，重试已用尽'],
      ['context_compaction', '请求失败，已压缩后重发'],
      ['context_compaction_failed', '请求失败，压缩失败，未重发'],
      ['process_exit', '服务进程退出，结果不明'],
    ] as const
    for (const [decision, expected] of decisions) {
      expect(outcome({ errorMessage: '请求失败。', decision })).toBe(expected)
    }
  })

  test('错误正文只取第一行，重试说明不会被会话栏截到第二行', () => {
    expect(outcome({ errorMessage: '第一行原因\n第二行详情', decision: 'limit_exhausted' })).toBe(
      '第一行原因，重试已用尽',
    )
  })
})

describe('target 截断方向', () => {
  test('短的原样返回，空白压成单个空格', () => {
    expect(sanitizeTarget('src/lib.ts')).toBe('src/lib.ts')
    expect(sanitizeTarget('  a   b\nc ')).toBe('a b c')
  })

  /**
   * 这条是这个函数存在的全部理由：**路径的信息在末尾，模式串的信息在开头**。
   * 两类都截同一侧，必然有一类被截掉有用的那半。
   */
  test('路径保尾部，非路径保头部', () => {
    const long = `packages/server/src/${'x'.repeat(60)}/git.ts`
    const cut = sanitizeTarget(long)
    expect(cut.length).toBe(TARGET_MAX)
    expect(cut.startsWith('…')).toBe(true)
    expect(cut.endsWith('git.ts')).toBe(true)

    const pattern = `${'8'.repeat(60)}|abc`
    const cut2 = sanitizeTarget(pattern)
    expect(cut2.length).toBe(TARGET_MAX)
    expect(cut2.endsWith('…')).toBe(true)
    expect(cut2.startsWith('8888')).toBe(true)
  })
})

describe('外置工具的目标剥前缀', () => {
  test('只剥开头那一段，路径里的冒号不动', () => {
    expect(displayTarget('mcp:github/search')).toBe('github/search')
    expect(displayTarget('plugin:demo/count')).toBe('demo/count')
    // 剥的是前缀不是子串：文件名里带 `mcp:` 的不该被削掉。
    expect(displayTarget('src/mcp:notes.ts')).toBe('src/mcp:notes.ts')
    expect(displayTarget('bun test')).toBe('bun test')
    // 只剥一层——`mcp:` 开头的 server 名本身仍要留在目标里。
    expect(displayTarget('mcp:mcp:x')).toBe('mcp:x')
  })
})

describe('改了多少行', () => {
  test('多个文件求和，两个数都是 0 就不给角标', () => {
    expect(fileDelta(undefined)).toBeNull()
    expect(fileDelta([])).toBeNull()
    expect(fileDelta([{ additions: 0, deletions: 0 }])).toBeNull()
    expect(fileDelta([{ additions: 1, deletions: 2 }])).toEqual({ additions: 1, deletions: 2 })
    expect(
      fileDelta([
        { additions: 1, deletions: 2 },
        { additions: 3, deletions: 0 },
      ]),
    ).toEqual({ additions: 4, deletions: 2 })
  })

  /** 删空一个文件：加了 0 行，但角标必须出现，否则那次调用看起来什么都没做。 */
  test('只有一侧非零也要出角标', () => {
    expect(fileDelta([{ additions: 0, deletions: 12 }])).toEqual({ additions: 0, deletions: 12 })
  })
})

/** 命中率的入参只用到这几格，其余字段测里一律不造。 */
function usage(over: {
  inputTokens?: number
  cachedTokens?: number | null
  cacheWriteTokens?: number | null
  turns?: {
    input: number
    cached: number | null
    cacheWrite: number | null
    source?: 'provider' | 'estimated'
  }[]
}) {
  return {
    inputTokens: over.inputTokens ?? 0,
    cachedTokens: over.cachedTokens === undefined ? 0 : over.cachedTokens,
    cacheWriteTokens: over.cacheWriteTokens ?? null,
    turns: (over.turns ?? []).map((t) => ({ source: 'provider' as const, ...t })),
  }
}

describe('读数格式', () => {
  test('大数收成 K / M，小数不动', () => {
    expect(compact(999)).toBe('999')
    expect(compact(1234)).toBe('1.2K')
    expect(compact(86_800)).toBe('87K')
    expect(compact(1_430_000)).toBe('1.43M')
  })

  /** 没有逐轮记录时回落到整轮累计；`null` 在那条路上仍然是未知。 */
  test('命中率：null 与 0 必须区分', () => {
    expect(hitRate(usage({ cachedTokens: null }))).toBe('N/A')
    expect(hitRate(usage({ inputTokens: 1000, cachedTokens: 0 }))).toBe('0.00%')
    // 分母是输入总量：277 未命中 + 723 命中 = 1000。
    expect(hitRate(usage({ inputTokens: 277, cachedTokens: 723 }))).toBe('72.30%')
    // 一个 token 都没有但 provider 明确回报了 0，仍然显示真实的 0。
    expect(hitRate(usage({ inputTokens: 0, cachedTokens: 0 }))).toBe('0.00%')
  })

  /*
   * 三家适配器的 `inputTokens` 都是**排他**的（只装未命中部分），拿它当分母
   * 会把命中那一大块从分母里抠掉。这个形状照着用户截图的量级来：
   * 794K 命中、2K 未命中——旧公式打印 39700%，一眼假。
   */
  test('命中率：分母含命中与写入，不会超过 100%', () => {
    const s = hitRate(usage({ inputTokens: 2_000, cachedTokens: 794_000 }))
    expect(s).toBe('99.75%')
    expect(Number.parseFloat(s)).toBeLessThanOrEqual(100)
    // 写入也占输入总量，同样进分母。
    expect(hitRate(usage({ inputTokens: 100, cachedTokens: 800, cacheWriteTokens: 100 }))).toBe(
      '80.00%',
    )
  })

  /*
   * 一轮里第一次调用必然未命中，累计口径会把它摊进去，长轮次的率被压低。
   * 用户看这个数字是想知道「现在缓存生效了吗」，所以取最后一次调用。
   */
  test('命中率：有逐轮记录时取最后一次调用', () => {
    const u = usage({
      inputTokens: 1_100,
      cachedTokens: 900,
      turns: [
        { input: 1_000, cached: 0, cacheWrite: 1_000 },
        { input: 100, cached: 900, cacheWrite: 0 },
      ],
    })
    // 累计是 900/2000 = 45%，最后一次是 900/1000 = 90%。
    expect(hitRate(u)).toBe('90.00%')
  })

  /*
   * 复现原始失败形状：会话 `cv_0mt10yhy20000vace5y`，最后一次调用的回包里
   * 连 `cached_tokens` 字段都没有。跳过它去找更早那条报过的（第 10 次，
   * 37376/(18056+37376)），屏幕上就挂着 67.43%；强转成 0 又会把「未知」
   * 冒充成「确认未命中」。这一格只能显示 N/A。
   */
  test('命中率：最后一次没回报缓存字段显示 N/A，不往前找', () => {
    const u = usage({
      inputTokens: 74_220,
      cachedTokens: 37_376,
      turns: [
        { input: 18_056, cached: 37_376, cacheWrite: null },
        { input: 56_164, cached: null, cacheWrite: null },
      ],
    })
    expect(hitRate(u)).toBe('N/A')
  })

  /** 这一次连 usage 都没到（估算兜底）时不能写 0——那是编的。 */
  test('命中率：最后一次没有 usage 显示 N/A', () => {
    const u = usage({
      inputTokens: 1_000,
      cachedTokens: 900,
      turns: [
        { input: 100, cached: 900, cacheWrite: null },
        { input: 900, cached: null, cacheWrite: null, source: 'estimated' },
      ],
    })
    expect(hitRate(u)).toBe('N/A')
  })

  /** 老数据没有逐轮记录。回落到累计，**不能显示 `—`**——那读起来像「没有缓存」。 */
  test('命中率：没有逐轮记录时回落到整轮累计', () => {
    expect(hitRate(usage({ inputTokens: 250, cachedTokens: 750, turns: [] }))).toBe('75.00%')
  })

  test('成功不写字，只有失败写', () => {
    expect(statusWord('success')).toBe('')
    expect(statusWord('running')).toBe('')
    expect(statusWord(undefined)).toBe('')
    expect(statusWord('failure')).toBe('失败')
  })
})

describe('结果取值', () => {
  test('按 entries / matches / files 的顺序认列表，非全字符串不算', () => {
    expect(listOf({ entries: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(listOf({ matches: ['x'] })).toEqual(['x'])
    // 空数组不算——渲染出来是一个空块。
    expect(listOf({ entries: [] })).toBeNull()
    // 混入非字符串就不是「一行一条」那种形状。
    expect(listOf({ files: ['a', 1] })).toBeNull()
    expect(listOf({ other: ['a'] })).toBeNull()
  })

  test('图片结果只接受落盘协议里的四种栅格格式', () => {
    expect(
      resultImages({
        images: [
          { data: 'aGVsbG8=', mime: 'image/png' },
          { data: 'd29ybGQ=', mime: 'image/webp' },
          { data: '<svg/>', mime: 'image/svg+xml' },
          { data: '', mime: 'image/jpeg' },
          { data: 42, mime: 'image/gif' },
        ],
      }),
    ).toEqual([
      { data: 'aGVsbG8=', mime: 'image/png' },
      { data: 'd29ybGQ=', mime: 'image/webp' },
    ])
    expect(resultImages(undefined)).toEqual([])
    expect(resultImages({ images: 'not-an-array' })).toEqual([])
  })

  test('截断要说清还剩多少', () => {
    const short = 'x'.repeat(10)
    expect(clamp(short)).toBe(short)
    const long = 'y'.repeat(CLAMP + 25)
    const cut = clamp(long)
    expect(cut.startsWith('y'.repeat(100))).toBe(true)
    expect(cut).toContain('还有 25 字')
  })
  test('回车覆盖只留每行最后一帧', () => {
    const cr = String.fromCharCode(13)
    const nl = String.fromCharCode(10)
    expect(collapseCarriageReturns('没有回车')).toBe('没有回车')
    expect(collapseCarriageReturns(`${cr}第一帧${cr}第二帧${cr}末帧`)).toBe('末帧')
    // CRLF 行尾不是覆盖标记，按覆盖处理会把整行丢空。
    expect(collapseCarriageReturns(`甲${cr}${nl}乙${cr}${nl}`)).toBe(`甲${nl}乙${nl}`)
    expect(collapseCarriageReturns(`头${nl}${cr}旧${cr}新${cr}${nl}尾`)).toBe(`头${nl}新${nl}尾`)
  })
})

describe('参数表', () => {
  test('跳过空值，对象序列化，超长的走专用块不进表', () => {
    expect(
      argsRows({ path: 'a.ts', empty: '', nothing: null, gone: undefined, opts: { deep: 1 } }),
    ).toEqual([
      ['path', 'a.ts'],
      ['opts', '{"deep":1}'],
    ])
    // 长文本进表会把卡片撑爆，它该走代码块。
    expect(argsRows({ content: 'z'.repeat(401) })).toEqual([])
    expect(argsRows({ content: 'z'.repeat(400) })).toHaveLength(1)
  })

  test('firstString 按给定顺序取第一个非空字符串', () => {
    expect(firstString({ a: '', b: '  ', c: 'hit' }, 'a', 'b', 'c')).toBe('hit')
    expect(firstString({ a: 1 }, 'a')).toBe('')
    expect(firstString({}, 'a')).toBe('')
  })
})

describe('diff 提取', () => {
  test('成对字段优先，红绿各带前缀', () => {
    const d = diffFrom({ old_string: 'a', new_string: 'b' })
    expect(d?.removed.startsWith('- a')).toBe(true)
    expect(d?.added).toBe('+ b')
  })

  test('只有一侧也成立——新建与删除都是合法的编辑', () => {
    expect(diffFrom({ new_string: 'only' })?.removed).toBe('')
    expect(diffFrom({ old_string: 'only' })?.added).toBe('')
  })

  test('回落到整段 patch，按行首符号分拣', () => {
    const d = diffFrom({ patch: ['-old', '+new', ' ctx'].join('\n') })
    expect(d?.removed).toBe('-old')
    expect(d?.added).toBe('+new')
  })

  /** 取不到就返回 null：返回一个空 diff 会在界面上画出一个空的红绿框。 */
  test('什么都取不到返回 null', () => {
    expect(diffFrom({})).toBeNull()
    expect(diffFrom({ path: 'a.ts' })).toBeNull()
  })
})

describe('待办清单参数识别', () => {
  /**
   * **原始失败形状**：`write_todos` 的展开体落到通用参数表里，整表 JSON
   * 挤在一格中，状态埋在 `"status":"in_progress"` 的引号里——问「哪几条做完了」
   * 得自己数引号。认出来才能走行渲染那一支。
   */
  test('认出整表待办，逐条带状态', () => {
    const list = todosOf({
      todos: [
        { content: '搭页面', status: 'completed' },
        { content: '写样式', status: 'in_progress' },
        { content: '写脚本', status: 'pending' },
      ],
    })
    expect(list?.map((t) => t.status)).toEqual(['completed', 'in_progress', 'pending'])
    expect(list?.[0]?.content).toBe('搭页面')
  })

  /** 落库的 args 里没有 id（那是工具补的），行渲染要稳定 key，所以按位置补。 */
  test('缺 id 时按位置补，带 id 时原样用', () => {
    expect(todosOf({ todos: [{ content: '甲', status: 'pending' }] })?.[0]?.id).toBe('todo_1')
    expect(todosOf({ todos: [{ id: 'x', content: '甲', status: 'pending' }] })?.[0]?.id).toBe('x')
  })

  /**
   * 认不出返回 null 而不是空数组：空数组会让展开体画出一个空的清单框，
   * 而「这一步不是待办」应该走通用参数表那一支。
   */
  test('形状不对一律 null——空表、缺字段、状态是别的词', () => {
    expect(todosOf({})).toBeNull()
    expect(todosOf({ todos: [] })).toBeNull()
    expect(todosOf({ todos: 'a,b' })).toBeNull()
    expect(todosOf({ todos: [{ content: '甲' }] })).toBeNull()
    expect(todosOf({ todos: [{ content: '甲', status: 'doing' }] })).toBeNull()
    expect(todosOf({ todos: [{ status: 'pending' }] })).toBeNull()
  })

  /** 一条不合格就整体不认：半张清单比不渲染更误导。 */
  test('混着一条坏的就整体 null', () => {
    expect(
      todosOf({
        todos: [
          { content: '甲', status: 'completed' },
          { content: '乙', status: 'unknown' },
        ],
      }),
    ).toBeNull()
  })
})

/**
 * 派活图的形状。**派一件与派一张图共用这一份**，所以这里要同时锁住两种输入
 * 产出同一种格子数组——两侧各画各的，代价是同一件事在会话流里长两个样。
 */
describe('派活图', () => {
  const keys = (g: ReturnType<typeof delegateGraph>) => g.nodes.map((n) => n.kind)

  test('派一件：三格一行，两端是会话', () => {
    const g = delegateGraph({ toolName: 'subagent', args: { task: '去查一下' } })
    expect(g.horizontal).toBe(true)
    expect(keys(g)).toEqual(['session', 'agent', 'session'])
    expect(g.layers).toHaveLength(3)
  })

  /** 临时子 agent 的名字来自派发参数；一个字段都没有时印总称。 */
  test('派一件：那一格印子 agent 的名字', () => {
    const g = delegateGraph({
      toolName: 'subagent',
      args: { kind: 'temp', name: '查资料', task: '查' },
    })
    expect(g.nodes[1]?.title).toBe('查资料')
    const bare = delegateGraph({ toolName: 'subagent', args: { task: '查' } })
    expect(bare.nodes[1]?.title).toBe('子 agent')
  })

  /** 外部 CLI 那一格按 kind 认，点开的是它写出来的流。 */
  test('派一件：外部 CLI 那一格印 CLI 名并标成 CLI', () => {
    const g = delegateGraph({
      toolName: 'subagent',
      args: { kind: 'cli', cli: 'claude', task: '改' },
    })
    expect(g.nodes[1]?.title).toBe('claude')
    expect(g.nodes[1]?.cli).toBe(true)
  })

  /** 两种卡的格子同一条规则：主行是名字（临时子 agent 是建时给的名字），次行是指令首行。 */
  test('主行按种类取名，次行是指令的第一行', () => {
    const one = delegateGraph({
      toolName: 'subagent',
      args: { kind: 'role', role: 'reviewer', task: '看一眼\n第二行不上卡' },
    })
    expect(one.nodes[1]).toMatchObject({ title: 'reviewer', task: '看一眼' })
    const many = delegateGraph({
      toolName: 'workflow',
      args: {
        goal: '做完',
        nodes: [
          { id: 'n1', kind: 'role', role: 'reviewer', task: '审' },
          { id: 'api', kind: 'temp', name: '接口', task: '写接口' },
          { id: 'glm', kind: 'temp', name: 'GLM 车组', model: 'glm-5.3-flash', task: '做车' },
          { id: 'cx', kind: 'cli', cli: 'codex', task: '跑' },
        ],
      },
    })
    expect(many.nodes.slice(1, 5).map((n) => [n.key, n.title, n.task])).toEqual([
      ['n1', 'reviewer', '审'],
      ['api', '接口', '写接口'],
      ['glm', 'GLM 车组', '做车'],
      ['cx', 'codex', '跑'],
    ])
  })

  /** 只有一格的图与一次派活形状相同，本来就该长得一样。 */
  test('一个节点的编排也横排', () => {
    const g = delegateGraph({
      toolName: 'workflow',
      args: { goal: '做完', nodes: [{ id: 'n1', kind: 'role', role: 'dev' }] },
    })
    expect(g.horizontal).toBe(true)
  })

  test('多格时竖排', () => {
    const g = delegateGraph({
      toolName: 'workflow',
      args: {
        goal: '做完',
        nodes: [
          { id: 'a', kind: 'role', role: 'dev' },
          { id: 'b', kind: 'role', role: 'dev' },
        ],
      },
    })
    expect(g.horizontal).toBe(false)
  })

  /**
   * 两端各自接住一头：没有上游的从派出端接出来，没有下游的汇进收回端。
   * 接漏了的那一格会浮在图上，连线一条都没有。
   */
  test('两端接住所有没有上下游的格子', () => {
    const g = delegateGraph({
      toolName: 'workflow',
      args: {
        goal: '做完',
        nodes: [
          { id: 'a', kind: 'role', role: 'dev' },
          { id: 'b', kind: 'role', role: 'dev' },
          { id: 'c', kind: 'role', role: 'dev', needs: ['a', 'b'] },
        ],
      },
    })
    const by = (k: string) => g.nodes.find((n) => n.key === k)
    expect(by('a')?.needs).toHaveLength(1)
    expect(by('b')?.needs).toHaveLength(1)
    expect(by('a')?.needs).toEqual(by('b')?.needs)
    // 汇点只接叶子：a、b 都有下游，接上去就成了两条越过 c 的边。
    expect(g.nodes.at(-1)?.needs).toEqual(['c'])
  })

  /** 按依赖分层：并行的那两格在同一层。 */
  test('并行的格子落在同一层', () => {
    const g = delegateGraph({
      toolName: 'workflow',
      args: {
        goal: '做完',
        nodes: [
          { id: 'a', kind: 'role', role: 'dev' },
          { id: 'b', kind: 'role', role: 'dev' },
          { id: 'c', kind: 'role', role: 'dev', needs: ['a', 'b'] },
        ],
      },
    })
    expect(g.layers.map((l) => l.length)).toEqual([1, 2, 1, 1])
  })

  test('checkpoint 就是当前会话审查节点，末尾不再复制一个返回端', () => {
    const g = delegateGraph({
      toolName: 'workflow',
      args: {
        goal: '做完',
        nodes: [
          { id: 'a', kind: 'role', role: 'dev' },
          { id: 'b', kind: 'role', role: 'dev' },
          { id: 'review', kind: 'checkpoint', label: '主会话审批', needs: ['a', 'b'] },
        ],
      },
    })
    expect(g.nodes.map((node) => node.kind)).toEqual(['session', 'agent', 'agent', 'session'])
    expect(g.nodes.at(-1)).toMatchObject({ key: 'review', title: '主会话审批', needs: ['a', 'b'] })
  })

  /** 成环由编排器拒绝，这里只保证画得出来——画不出来的话整张卡是空的。 */
  test('图成环也画得出来', () => {
    const g = delegateGraph({
      toolName: 'workflow',
      args: {
        goal: '做完',
        nodes: [
          { id: 'a', kind: 'role', role: 'dev', needs: ['b'] },
          { id: 'b', kind: 'role', role: 'dev', needs: ['a'] },
        ],
      },
    })
    expect(g.nodes).toHaveLength(4)
    expect(g.layers.length).toBeGreaterThan(0)
  })
})

describe('卡顶那一行', () => {
  test('只取第一行', () => {
    expect(firstLine(`第一行${String.fromCharCode(10)}第二行`)).toBe('第一行')
    expect(firstLine('只有一行')).toBe('只有一行')
    expect(firstLine('')).toBe('')
  })
})
