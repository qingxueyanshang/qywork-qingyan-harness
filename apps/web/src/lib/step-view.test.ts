/**
 * 工具步骤呈现逻辑的测试。覆盖 `lib/step-view.ts`。
 *
 * 这些函数不能放在 `Transcript.tsx` 中：`bun test` 加载 `.tsx` 时会查找
 * JSX runtime 并失败。每个函数都有实际的边界条件，
 * 仅凭目视检查渲染结果无法验证，因此拆出后单独测试。
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
  readRange,
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

test('未知停止码不把内部枚举显示到界面', () => {
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
      | 'limit_exhausted'
      | 'context_compaction'
      | 'context_compaction_failed'
      | 'process_exit'
    purpose?: 'turn' | 'summary'
  }) =>
    requestOutcome({
      status: over.status ?? 'rejected',
      ...(over.purpose ? { purpose: over.purpose } : {}),
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

  test('摘要请求的结果显示「上下文压缩」，截断与拒绝仍按原有文案显示', () => {
    expect(outcome({ status: 'received', purpose: 'summary', finishReason: 'end_turn' })).toBe(
      '上下文压缩',
    )
    expect(outcome({ status: 'received', purpose: 'summary', finishReason: '' })).toBe('上下文压缩')
    expect(outcome({ status: 'received', purpose: 'summary', finishReason: 'max_tokens' })).toBe(
      '输出被截断',
    )
    expect(outcome({ status: 'received', purpose: 'turn', finishReason: 'end_turn' })).toBe(
      '已完成',
    )
  })

  test('没有 provider 原文时把错误码转换为用户文案', () => {
    expect(outcome({ status: 'uncertain', errorCode: 'network_error' })).toBe('网络连接失败')
    expect(outcome({ errorCode: 'internal_error' })).toBe('内部错误')
    expect(outcome({ errorCode: 'future_internal_code' })).toBe('被拒绝')
  })

  test('七种重试裁决全部有唯一结果文案', () => {
    const decisions = [
      ['resend', '请求失败，已自动重发'],
      ['interrupted', '已中断，结果不明'],
      ['not_retryable', '请求失败，未重发'],
      ['limit_exhausted', '请求失败，重试已用尽'],
      ['context_compaction', '请求失败，已压缩后重发'],
      ['context_compaction_failed', '请求失败，压缩失败，未重发'],
      ['process_exit', '服务进程退出，结果不明'],
    ] as const
    for (const [decision, expected] of decisions) {
      expect(outcome({ errorMessage: '请求失败。', decision })).toBe(expected)
    }
  })

  test('错误正文只取第一行，重试说明不会因换行被会话栏截断', () => {
    expect(outcome({ errorMessage: '第一行原因\n第二行详情', decision: 'limit_exhausted' })).toBe(
      '第一行原因，重试已用尽',
    )
  })
})

describe('target 截断方向', () => {
  test('较短的目标原样返回，连续空白压缩为单个空格', () => {
    expect(sanitizeTarget('src/lib.ts')).toBe('src/lib.ts')
    expect(sanitizeTarget('  a   b\nc ')).toBe('a b c')
  })

  /**
   * 该函数的用途即在于此：路径的有效信息在末尾，模式串的有效信息在开头。
   * 两类都截断同一侧时，必然有一类丢失有效的部分。
   */
  test('路径保留尾部，非路径保留头部', () => {
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

describe('分段读取的行号范围', () => {
  test('同一文件的不同段落各自显示实际读取的范围', () => {
    expect(readRange({ startLine: 1, endLine: 70, totalLines: 700 })).toBe('1-70')
    expect(readRange({ startLine: 395, endLine: 448, totalLines: 700 })).toBe('395-448')
    expect(readRange({ startLine: 657, endLine: 700, totalLines: 700 })).toBe('657-700')
  })

  test('读取整个文件、0 行结果与缺少行号时不显示范围', () => {
    expect(readRange({ startLine: 1, endLine: 144, totalLines: 144 })).toBeNull()
    expect(readRange({ startLine: 800, endLine: 799, totalLines: 700 })).toBeNull()
    expect(readRange({ content: 'x' })).toBeNull()
    expect(readRange(undefined)).toBeNull()
  })
})

describe('外置工具的目标去除前缀', () => {
  test('只去除开头的前缀，路径中的冒号保持不变', () => {
    expect(displayTarget('mcp:github/search')).toBe('github/search')
    expect(displayTarget('plugin:demo/count')).toBe('demo/count')
    // 去除的是前缀而不是子串：文件名中包含的 `mcp:` 不应被去除。
    expect(displayTarget('src/mcp:notes.ts')).toBe('src/mcp:notes.ts')
    expect(displayTarget('bun test')).toBe('bun test')
    // 只去除一层：以 `mcp:` 开头的 server 名本身仍须保留在目标中。
    expect(displayTarget('mcp:mcp:x')).toBe('mcp:x')
  })
})

describe('修改行数', () => {
  test('多个文件求和，两个数都为 0 时不显示角标', () => {
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

  /** 清空一个文件：新增 0 行，但角标必须显示，否则该次调用看似没有任何修改。 */
  test('只有一侧非零时也显示角标', () => {
    expect(fileDelta([{ additions: 0, deletions: 12 }])).toEqual({ additions: 0, deletions: 12 })
  })
})

/** 命中率的入参只用到以下字段，测试中不构造其余字段。 */
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
  test('大数缩写为 K / M，小数保持不变', () => {
    expect(compact(999)).toBe('999')
    expect(compact(1234)).toBe('1.2K')
    expect(compact(86_800)).toBe('87K')
    expect(compact(1_430_000)).toBe('1.43M')
  })

  /** 没有逐轮记录时回落到整轮累计；在该路径上 `null` 仍表示未知。 */
  test('命中率：null 与 0 必须区分', () => {
    expect(hitRate(usage({ cachedTokens: null }))).toBe('N/A')
    expect(hitRate(usage({ inputTokens: 1000, cachedTokens: 0 }))).toBe('0.00%')
    // 分母是输入总量：277 未命中 + 723 命中 = 1000。
    expect(hitRate(usage({ inputTokens: 277, cachedTokens: 723 }))).toBe('72.30%')
    // 没有任何 token 但 provider 明确回报了 0 时，仍显示实际的 0。
    expect(hitRate(usage({ inputTokens: 0, cachedTokens: 0 }))).toBe('0.00%')
  })

  /*
   * 三家适配器的 `inputTokens` 都是排他口径（只包含未命中部分），以它作分母
   * 会把命中部分从分母中扣除。该用例按用户截图的数量级构造：
   * 794K 命中、2K 未命中，按错误公式会输出 39700%。
   */
  test('命中率：分母含命中与写入，不会超过 100%', () => {
    const s = hitRate(usage({ inputTokens: 2_000, cachedTokens: 794_000 }))
    expect(s).toBe('99.75%')
    expect(Number.parseFloat(s)).toBeLessThanOrEqual(100)
    // 写入也计入输入总量，同样计入分母。
    expect(hitRate(usage({ inputTokens: 100, cachedTokens: 800, cacheWriteTokens: 100 }))).toBe(
      '80.00%',
    )
  })

  /*
   * 一轮中的第一次调用必然未命中，按累计计算时它被计入均值，使长轮次的命中率偏低。
   * 用户查看该数值是为了确认缓存当前是否生效，因此取最后一次调用。
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
   * 复现原始失败形状：会话 `cv_0mt10yhy20000vace5y` 中，最后一次调用的响应
   * 不含 `cached_tokens` 字段。跳过该次调用而取更早一次有回报的数据（第 10 次，
   * 37376/(18056+37376)），界面会显示 67.43%；强制转换为 0 则会把「未知」
   * 显示为「确认未命中」。该字段只能显示 N/A。
   */
  test('命中率：最后一次未回报缓存字段时显示 N/A，不向前查找', () => {
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

  /** 本次调用没有 usage（使用本地估算）时不得显示 0：该数值是编造的。 */
  test('命中率：最后一次没有 usage 时显示 N/A', () => {
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

  /** 旧数据没有逐轮记录。回落到累计值，不得显示 `—`：它会被理解为「没有缓存」。 */
  test('命中率：没有逐轮记录时回落到整轮累计', () => {
    expect(hitRate(usage({ inputTokens: 250, cachedTokens: 750, turns: [] }))).toBe('75.00%')
  })

  test('成功时不显示文字，只有失败时显示', () => {
    expect(statusWord('success')).toBe('')
    expect(statusWord('running')).toBe('')
    expect(statusWord(undefined)).toBe('')
    expect(statusWord('failure')).toBe('失败')
  })
})

describe('结果取值', () => {
  test('按 entries / matches / files 的顺序识别列表，元素不全为字符串时不识别', () => {
    expect(listOf({ entries: ['a', 'b'] })).toEqual(['a', 'b'])
    expect(listOf({ matches: ['x'] })).toEqual(['x'])
    // 空数组不识别：渲染结果是一个空块。
    expect(listOf({ entries: [] })).toBeNull()
    // 混入非字符串时不符合「每行一条」的形状。
    expect(listOf({ files: ['a', 1] })).toBeNull()
    expect(listOf({ other: ['a'] })).toBeNull()
  })

  test('图片结果只接受落盘协议中的四种栅格格式', () => {
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

  test('截断时须注明剩余字数', () => {
    const short = 'x'.repeat(10)
    expect(clamp(short)).toBe(short)
    const long = 'y'.repeat(CLAMP + 25)
    const cut = clamp(long)
    expect(cut.startsWith('y'.repeat(100))).toBe(true)
    expect(cut).toContain('剩余 25 字')
  })
  test('回车符覆盖时每行只保留最后一帧', () => {
    const cr = String.fromCharCode(13)
    const nl = String.fromCharCode(10)
    expect(collapseCarriageReturns('没有回车')).toBe('没有回车')
    expect(collapseCarriageReturns(`${cr}第一帧${cr}第二帧${cr}末帧`)).toBe('末帧')
    // CRLF 行尾不是覆盖标记，按覆盖处理会使整行内容丢失。
    expect(collapseCarriageReturns(`甲${cr}${nl}乙${cr}${nl}`)).toBe(`甲${nl}乙${nl}`)
    expect(collapseCarriageReturns(`头${nl}${cr}旧${cr}新${cr}${nl}尾`)).toBe(`头${nl}新${nl}尾`)
  })
})

describe('参数表', () => {
  test('跳过空值，对象序列化，超长内容使用专用块而不进入参数表', () => {
    expect(
      argsRows({ path: 'a.ts', empty: '', nothing: null, gone: undefined, opts: { deep: 1 } }),
    ).toEqual([
      ['path', 'a.ts'],
      ['opts', '{"deep":1}'],
    ])
    // 长文本进入参数表会增大卡片尺寸，应使用代码块显示。
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
  test('成对字段优先，删除与新增两侧各带前缀', () => {
    const d = diffFrom({ old_string: 'a', new_string: 'b' })
    expect(d?.removed.startsWith('- a')).toBe(true)
    expect(d?.added).toBe('+ b')
  })

  test('只有一侧时同样成立：新建与删除都是合法的编辑', () => {
    expect(diffFrom({ new_string: 'only' })?.removed).toBe('')
    expect(diffFrom({ old_string: 'only' })?.added).toBe('')
  })

  test('回落到整段 patch，按行首符号分类', () => {
    const d = diffFrom({ patch: ['-old', '+new', ' ctx'].join('\n') })
    expect(d?.removed).toBe('-old')
    expect(d?.added).toBe('+new')
  })

  /** 无法取得时返回 null：返回空 diff 会在界面上渲染出一个空的差异框。 */
  test('无法取得任何内容时返回 null', () => {
    expect(diffFrom({})).toBeNull()
    expect(diffFrom({ path: 'a.ts' })).toBeNull()
  })
})

describe('待办清单参数识别', () => {
  /**
   * 原始失败形状：`write_todos` 的展开内容进入通用参数表，整张清单的 JSON
   * 集中在一个单元格中，状态位于 `"status":"in_progress"` 的引号内，判断哪些条目已完成
   * 只能逐个查看引号内容。识别出待办清单后才能按行渲染。
   */
  test('识别整张待办清单，每条带状态', () => {
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

  /** 数据库中的 args 不含 id（id 由工具补充），按行渲染需要稳定的 key，因此按位置补充。 */
  test('缺少 id 时按位置补充，带有 id 时原样使用', () => {
    expect(todosOf({ todos: [{ content: '甲', status: 'pending' }] })?.[0]?.id).toBe('todo_1')
    expect(todosOf({ todos: [{ id: 'x', content: '甲', status: 'pending' }] })?.[0]?.id).toBe('x')
  })

  /**
   * 无法识别时返回 null 而不是空数组：空数组会使展开内容渲染出一个空的清单框，
   * 而不是待办的步骤应使用通用参数表。
   */
  test('形状不符时一律返回 null：空表、缺少字段、状态为其他取值', () => {
    expect(todosOf({})).toBeNull()
    expect(todosOf({ todos: [] })).toBeNull()
    expect(todosOf({ todos: 'a,b' })).toBeNull()
    expect(todosOf({ todos: [{ content: '甲' }] })).toBeNull()
    expect(todosOf({ todos: [{ content: '甲', status: 'doing' }] })).toBeNull()
    expect(todosOf({ todos: [{ status: 'pending' }] })).toBeNull()
  })

  /** 任一条不合格即整体不识别：只显示部分清单比不渲染更具误导性。 */
  test('含有一条不合格条目时整体返回 null', () => {
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
 * 派发任务图的形状。派发单项任务与派发任务图共用同一份实现，因此此处同时锁定两种输入
 * 产出同一种节点数组；两侧若各自绘制，同一件事在会话流中会呈现两种样式。
 */
describe('派发任务图', () => {
  const keys = (g: ReturnType<typeof delegateGraph>) => g.nodes.map((n) => n.kind)

  test('派发单项任务：三个节点排成一行，两端是会话', () => {
    const g = delegateGraph({ toolName: 'subagent', args: { task: '去查一下' } })
    expect(g.horizontal).toBe(true)
    expect(keys(g)).toEqual(['session', 'agent', 'session'])
    expect(g.layers).toHaveLength(3)
  })

  /** 临时子 agent 的名称来自派发参数；没有任何相关字段时显示统称。 */
  test('派发单项任务：中间节点显示子 agent 的名称', () => {
    const g = delegateGraph({
      toolName: 'subagent',
      args: { kind: 'temp', name: '查资料', task: '查' },
    })
    expect(g.nodes[1]?.title).toBe('查资料')
    const bare = delegateGraph({ toolName: 'subagent', args: { task: '查' } })
    expect(bare.nodes[1]?.title).toBe('子 agent')
  })

  /** 图的形状只来自参数，参数中可识别的只有名称：种类由状态提供，此处不做推测。 */
  test('派发单项任务：外部 CLI 节点显示 CLI 名称', () => {
    const g = delegateGraph({
      toolName: 'subagent',
      args: { kind: 'cli', cli: 'claude', task: '改' },
    })
    expect(g.nodes[1]?.title).toBe('claude')
  })

  /** 两种卡片的节点遵循同一条规则：主行是名称（临时子 agent 为创建时指定的名称），次行是指令首行。 */
  test('主行按种类取得名称，次行是指令的第一行', () => {
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

  /** 只有一个节点的图与一次派发任务形状相同，应呈现相同样式。 */
  test('只有一个节点的编排同样横向排列', () => {
    const g = delegateGraph({
      toolName: 'workflow',
      args: { goal: '做完', nodes: [{ id: 'n1', kind: 'role', role: 'dev' }] },
    })
    expect(g.horizontal).toBe(true)
  })

  test('多个节点时纵向排列', () => {
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
   * 两端分别连接一侧：没有上游的节点从派出端连出，没有下游的节点汇入收回端。
   * 遗漏连接的节点在图上孤立显示，没有任何连线。
   */
  test('两端连接所有缺少上游或下游的节点', () => {
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
    // 汇点只连接叶节点：a、b 都有下游，连接后会形成两条越过 c 的边。
    expect(g.nodes.at(-1)?.needs).toEqual(['c'])
  })

  /** 按依赖分层：两个并行节点位于同一层。 */
  test('并行的节点位于同一层', () => {
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

  test('checkpoint 即当前会话审查节点，末尾不再额外添加返回端', () => {
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

  /** 成环的图由编排器拒绝，此处只保证能够绘制；无法绘制时整张卡片为空。 */
  test('成环的图同样能够绘制', () => {
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

describe('卡片顶部的标题行', () => {
  test('只取第一行', () => {
    expect(firstLine(`第一行${String.fromCharCode(10)}第二行`)).toBe('第一行')
    expect(firstLine('只有一行')).toBe('只有一行')
    expect(firstLine('')).toBe('')
  })
})
