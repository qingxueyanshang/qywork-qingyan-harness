/**
 * 覆盖范围：`compaction.ts` 全部：单元键与边界、收纳段、摘要段的预算与检查、
 * 事实包、投影。接线（发送前检查 → 压缩 → 重新装配）见 `loop/compact.test.ts`。
 */

import { describe, expect, test } from 'bun:test'
import type { WireMessage } from '@qywork/ai'
import { DEFAULT_DENSITY } from '@qywork/ai'
import type { CompactionManifest, MessageId } from '@qywork/core'
import {
  type CompactionAction,
  type CompactionInput,
  compact,
  condenseCutOf,
  condenseMessage,
  cutKey,
  projectManifest,
  stepStamp,
  summaryCutOf,
  unitKey,
} from './compaction.ts'

const msg = (i: number, role: 'user' | 'assistant', content: string) => ({
  id: `ms_${String(i).padStart(3, '0')}` as MessageId,
  role,
  content,
})

const longHistory = [
  msg(1, 'user', '把认证模块重构成 JWT，注意不要动 legacy/ 目录'),
  msg(2, 'assistant', '好的，我先看一下现有实现'),
  msg(3, 'user', '另外数据库迁移必须可回滚'),
  msg(4, 'assistant', '已完成 auth/token.ts 的改写'),
]

const actions: CompactionAction[] = [
  {
    stepId: 'rn_1:1',
    tool: 'read_file',
    status: 'success',
    actionKind: 'read',
    target: 'src/auth/token.ts',
    summary: '读取 120 行',
  },
  {
    stepId: 'rn_1:2',
    tool: 'edit_file',
    status: 'success',
    actionKind: 'edit',
    target: 'src/auth/token.ts',
    summary: '替换 3 处',
  },
  {
    stepId: 'rn_1:3',
    tool: 'run_command',
    status: 'failure',
    actionKind: 'run',
    target: 'npm test -- --reporter=verbose src/**/*.test.ts',
    summary: '2 个用例失败',
    errorCode: 'exit_1',
  },
]

/** 折叠线默认位于最后一条消息，预算充足；各测试按需覆盖。 */
function input(over: Partial<CompactionInput> = {}): CompactionInput {
  return {
    messages: longHistory,
    actions,
    previous: null,
    fold: { messageId: 'ms_004' as MessageId },
    condenseOnly: false,
    density: DEFAULT_DENSITY,
    projectionBudget: 20_000,
    typicalSummaryTokens: null,
    condensedRegionTokens: 5_000,
    foldedMessageCount: 4,
    ...over,
  }
}

const ok = async () => '模型写的摘要'

describe('单元键与边界', () => {
  test('消息本体排在它的执行记录之前', () => {
    const body = unitKey({ role: 'user', content: 'x', _messageId: 'ms_002' })!
    const record = unitKey({
      role: 'tool',
      content: 'x',
      _messageId: 'ms_002',
      _step: stepStamp('rn_a', 3),
    })!
    expect(body < record).toBe(true)
  })

  test('跨消息按消息 id 排序，step 戳不参与比较', () => {
    const early = unitKey({
      role: 'tool',
      content: 'x',
      _messageId: 'ms_002',
      _step: stepStamp('rn_z', 999),
    })!
    const late = unitKey({ role: 'user', content: 'x', _messageId: 'ms_003' })!
    expect(early < late).toBe(true)
  })

  test('同一 run 内 seq 按数值排序，定宽补零使 10 排在 2 之后', () => {
    expect(stepStamp('rn_a', 2) < stepStamp('rn_a', 10)).toBe(true)
  })

  test('无 _messageId 的消息不参与折叠', () => {
    expect(unitKey({ role: 'assistant', content: '投影摘要' })).toBeNull()
  })

  test('缺少 condensedThrough 的 manifest：收纳线与摘要线重合', () => {
    const m: CompactionManifest = {
      revision: 1,
      compactedThroughMessageId: 'ms_004' as MessageId,
      compactedMessageCount: 4,
      summary: 's',
      facts: { filesTouched: [], openItems: [], userConstraints: [] },
      createdAt: 0,
    }
    expect(cutKey(condenseCutOf(m)!)).toBe(cutKey(summaryCutOf(m)!))
  })
})

describe('收纳段：只保留信封，保留部分逐字不变', () => {
  const toolMsg: WireMessage = {
    role: 'tool',
    toolCallId: 'c1',
    content: JSON.stringify({
      call_id: 'c1',
      tool: 'run_command',
      status: 'success',
      executed: true,
      summary: '跑完了',
      resources: ['rs_abc'],
      result: { stdout: 'x'.repeat(8000) },
    }),
  }

  test('工具结果移除正文，保留信封与落盘定位符', () => {
    const out = condenseMessage(toolMsg)
    const env = JSON.parse(out.content as string)
    expect(env.result).toBeUndefined()
    expect(env.result_omitted).toBe(true)
    // 图像省略标记只用于实际丢弃了图像块的收纳，纯文本收纳不带该标记。
    expect(env.images_omitted).toBeUndefined()
    expect(env.summary).toBe('跑完了')
    expect(env.resources).toEqual(['rs_abc'])
    expect((out.content as string).length).toBeLessThan((toolMsg.content as string).length / 10)
  })

  test('正文型调用参数折叠为摘录与标记', () => {
    const out = condenseMessage({
      role: 'assistant',
      content: '',
      toolCalls: [
        { id: 'c1', name: 'write_file', arguments: { path: 'a.ts', content: 'z'.repeat(5000) } },
      ],
    })
    const args = out.toolCalls![0]!.arguments as { path: string; content: string }
    expect(args.path).toBe('a.ts')
    expect(args.content).toContain('已折叠')
    expect(args.content.length).toBeLessThan(400)
  })

  /** 嵌套在对象与数组中的长字符串同样折叠，结构保留，同一输入两次折叠逐字相同。 */
  test('嵌套参数中的长字符串同样折叠，结构不变且投影稳定', () => {
    const message = {
      role: 'assistant' as const,
      content: '',
      toolCalls: [
        {
          id: 'c1',
          name: 'write_files',
          arguments: {
            files: [
              { path: 'a.ts', content: 'z'.repeat(100_000) },
              { path: 'b.ts', content: '短' },
            ],
            meta: { note: 'y'.repeat(2000), count: 2 },
          },
        },
      ],
    }
    const out = condenseMessage(message)
    const args = out.toolCalls![0]!.arguments as {
      files: { path: string; content: string }[]
      meta: { note: string; count: number }
    }
    expect(args.files[0]!.path).toBe('a.ts')
    expect(args.files[0]!.content).toContain('已折叠')
    expect(args.files[1]!.content).toBe('短')
    expect(args.meta.count).toBe(2)
    expect(JSON.stringify(args).length).toBeLessThan(2000)
    expect(condenseMessage(message)).toEqual(out)
  })

  test('没有长字符串时原样返回同一个调用', () => {
    const call = { id: 'c1', name: 'x', arguments: { a: { b: ['短'] } } }
    const out = condenseMessage({ role: 'assistant', content: '', toolCalls: [call] })
    expect(out.toolCalls![0]).toBe(call)
  })

  test('思考正文原样保留：缺少时 DeepSeek 兼容端点在下一轮返回 400', () => {
    const out = condenseMessage({
      role: 'assistant',
      content: '',
      reasoningContent: '想了很久',
      responseReasoning: {
        tokens: 0,
        items: [{ type: 'reasoning', encrypted_content: 'cipher' }],
      },
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }],
    })
    expect(out.reasoningContent).toBe('想了很久')
    expect(out.responseReasoning).toEqual({
      tokens: 0,
      items: [{ type: 'reasoning', encrypted_content: 'cipher' }],
    })
  })

  test('用户与助手正文原样保留', () => {
    const m: WireMessage = { role: 'user', content: '别改 legacy/' }
    expect(condenseMessage(m)).toBe(m)
  })

  test('投影幂等：同一条消息收纳两次逐字相等', () => {
    const once = condenseMessage(toolMsg)
    expect(condenseMessage(once).content).toBe(once.content)
  })
})

describe('收纳足够时不调用模型', () => {
  test('condenseOnly：不调用摘要器，只前移收纳线', async () => {
    let calls = 0
    const r = await compact(input({ condenseOnly: true }), async () => {
      calls++
      return '不该被调用'
    })
    expect(calls).toBe(0)
    if (r.status !== 'compacted') throw new Error('应当落库')
    expect(r.summarized).toBe(false)
    expect(r.reasonCode).toBeUndefined()
    expect(r.manifest.condensedThrough).toEqual({ messageId: 'ms_004' as MessageId })
    // 摘要线不变。
    expect(r.manifest.compactedThroughMessageId).toBeNull()
  })

  test('收纳线已在折叠线上时跳过收纳段，由摘要段推进摘要线', async () => {
    const previous: CompactionManifest = {
      revision: 1,
      compactedThroughMessageId: null,
      condensedThrough: { messageId: 'ms_004' as MessageId },
      compactedMessageCount: 0,
      summary: '',
      facts: { filesTouched: [], openItems: [], userConstraints: [] },
      createdAt: 0,
    }
    // 收纳线不前移时摘要段仍可推进摘要线，因此本例经由摘要段。
    const r = await compact(input({ previous }), ok)
    expect(r.status).toBe('compacted')
    if (r.status !== 'compacted') return
    expect(r.summarized).toBe(true)
  })
})

describe('摘要段失败不回退收纳段', () => {
  test('摘要器抛出异常：收纳线照常前移，结果带失败码', async () => {
    const r = await compact(input(), async () => {
      throw new Error('上下文超限')
    })
    if (r.status !== 'compacted') throw new Error('收纳应当落库')
    expect(r.summarized).toBe(false)
    expect(r.reasonCode).toBe('summary_error')
    expect(r.manifest.compactedThroughMessageId).toBeNull()
    expect(r.manifest.condensedThrough).toEqual({ messageId: 'ms_004' as MessageId })
  })

  test('摘要为空（含被截断）同样判定为摘要段失败', async () => {
    const r = await compact(input(), async () => null)
    expect(r.status === 'compacted' && r.reasonCode).toBe('summary_empty')
  })

  test('收纳线也无法前移时才判定为整次失败', async () => {
    const previous: CompactionManifest = {
      revision: 1,
      compactedThroughMessageId: 'ms_001' as MessageId,
      condensedThrough: { messageId: 'ms_004' as MessageId },
      compactedMessageCount: 1,
      summary: '旧摘要',
      facts: { filesTouched: [], openItems: [], userConstraints: [] },
      createdAt: 0,
    }
    const r = await compact(input({ previous }), async () => null)
    expect(r.status).toBe('failed')
    expect(r.status === 'failed' && r.reasonCode).toBe('summary_empty')
  })

  test('没有摘要空间时不发送请求', async () => {
    let calls = 0
    const r = await compact(input({ projectionBudget: 0 }), async () => {
      calls++
      return '摘要'
    })
    expect(calls).toBe(0)
    expect(r.status === 'compacted' && r.reasonCode).toBe('no_headroom')
  })
})

describe('摘要预算：取两者较小值，全程按 token 计', () => {
  test('有观测时取 min(headroom, p95)', async () => {
    const seen: number[] = []
    await compact(input({ typicalSummaryTokens: 300 }), async (_p, b) => {
      seen.push(b)
      return '摘要'
    })
    expect(seen[0]).toBe(300)
  })

  test('无观测时取 headroom，不使用固定比例', async () => {
    const seen: number[] = []
    await compact(input({ projectionBudget: 900, typicalSummaryTokens: null }), async (_p, b) => {
      seen.push(b)
      return '摘要'
    })
    // 事实清单优先占用预算，摘要使用剩余部分，因此摘要预算为正且小于总预算。
    expect(seen[0]!).toBeGreaterThan(0)
    expect(seen[0]!).toBeLessThan(900)
  })

  test('预算随输入的可用空间变化，不由原文长度决定', async () => {
    const seen: number[] = []
    const capture = async (_p: string, b: number) => {
      seen.push(b)
      return '摘要'
    }
    await compact(input({ projectionBudget: 1_000 }), capture)
    await compact(input({ projectionBudget: 50_000 }), capture)
    expect(seen[1]!).toBeGreaterThan(seen[0]!)
  })
})

describe('「必须更小」检查', () => {
  test('新投影不小于被替换的内容时作废摘要段', async () => {
    const r = await compact(input({ condensedRegionTokens: 1 }), async () => '摘'.repeat(5_000))
    expect(r.status === 'compacted' && r.summarized).toBe(false)
    expect(r.status === 'compacted' && r.reasonCode).toBe('not_smaller')
  })

  test('新投影更小时采用，摘要线推进到折叠线', async () => {
    const r = await compact(input({ condensedRegionTokens: 5_000 }), ok)
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.summarized).toBe(true)
    expect(r.manifest.compactedThroughMessageId).toBe('ms_004' as MessageId)
    expect(r.manifest.condensedThrough).toEqual({ messageId: 'ms_004' as MessageId })
  })
})

/**
 * 「在预算内」检查：摘要超出事实清单之外的剩余预算时作废摘要段。
 * 摘要段作废时按 `summaryFailed` 处理：收纳线可前移则前移，旧摘要与事实原样沿用。
 */
describe('「在预算内」检查', () => {
  const previous: CompactionManifest = {
    revision: 1,
    compactedThroughMessageId: 'ms_001' as MessageId,
    condensedThrough: { messageId: 'ms_001' as MessageId },
    compactedMessageCount: 1,
    summary: '旧摘要',
    facts: { filesTouched: ['a.ts'], openItems: [], userConstraints: ['不要动 legacy/'] },
    createdAt: 0,
  }
  const tooLong = async () => '摘'.repeat(20_000)

  test('被替换的区域很大时，远超预算的摘要同样不采用', async () => {
    const r = await compact(
      input({ projectionBudget: 1_000, condensedRegionTokens: 50_000 }),
      tooLong,
    )
    expect(r.status === 'compacted' && r.summarized).toBe(false)
    expect(r.status === 'compacted' && r.reasonCode).toBe('over_budget')
  })

  test('摘要段作废、收纳线可前移：旧摘要与事实不变，收纳线推进到折叠线', async () => {
    const r = await compact(
      input({ previous, projectionBudget: 1_000, condensedRegionTokens: 50_000 }),
      tooLong,
    )
    if (r.status !== 'compacted') throw new Error('收纳线应当前移')
    expect(r.manifest.summary).toBe('旧摘要')
    expect(r.manifest.facts).toEqual(previous.facts)
    expect(r.manifest.compactedThroughMessageId).toBe('ms_001' as MessageId)
    expect(r.manifest.condensedThrough).toEqual({ messageId: 'ms_004' as MessageId })
  })

  test('摘要段作废且收纳线无法前移：本次失败，不写入新 manifest', async () => {
    const r = await compact(
      input({
        previous: { ...previous, condensedThrough: { messageId: 'ms_004' as MessageId } },
        projectionBudget: 1_000,
        condensedRegionTokens: 50_000,
      }),
      tooLong,
    )
    expect(r.status).toBe('failed')
    expect(r.status === 'failed' && r.reasonCode).toBe('over_budget')
  })
})

describe('中断即丢弃', () => {
  test('摘要调用抛出 AbortError 时返回 aborted，不写入任何记录', async () => {
    const r = await compact(input(), async () => {
      throw new DOMException('已中断', 'AbortError')
    })
    expect(r.status).toBe('aborted')
  })

  test('摘要生成完成的同时中止信号被触发：同样丢弃', async () => {
    const ac = new AbortController()
    const r = await compact(
      input(),
      async () => {
        ac.abort()
        return '一份没人等到的摘要'
      },
      ac.signal,
    )
    expect(r.status).toBe('aborted')
  })
})

describe('事实包必须逐字保留，不经过模型', () => {
  test('文件路径按动作类别收录，命令串不进入清单', async () => {
    const r = await compact(input(), ok)
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.filesTouched).toEqual(['src/auth/token.ts'])
    expect(r.manifest.facts.filesTouched.join('')).not.toContain('npm test')
  })

  test('全部用户消息逐字进入事实包，约束排在前面', async () => {
    const r = await compact(
      input({
        messages: [
          msg(1, 'user', '继续，看看 src/a.ts'),
          msg(2, 'user', '不要动 legacy/ 目录'),
          msg(3, 'assistant', '好'),
        ],
        actions: [],
      }),
      ok,
    )
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    const kept = r.manifest.facts.userConstraints
    expect(kept).toEqual(['不要动 legacy/ 目录', '继续，看看 src/a.ts'])
  })

  /**
   * 摘要线越过这些读取之后，只有事实清单记录读取位置。
   * 同一文件的行段按起点合并（相邻与重叠的行段均合并），并与上一份清单合并；失败的读取不计入。
   */
  test('按行读取的进度并入事实清单，投影中包含续读位置', async () => {
    const read = (
      stepId: string,
      from: number,
      to: number,
      status = 'success',
    ): CompactionAction => ({
      stepId,
      tool: 'read_file',
      status,
      actionKind: 'read',
      target: 'big.txt',
      summary: `读取 big.txt 第 ${from}–${to} 行`,
      lines: { from, to, total: 500 },
    })
    const previous: CompactionManifest = {
      revision: 1,
      compactedThroughMessageId: 'ms_001' as MessageId,
      compactedMessageCount: 1,
      summary: '上一份摘要',
      facts: {
        filesTouched: ['big.txt'],
        openItems: [],
        userConstraints: [],
        filesRead: [{ path: 'big.txt', totalLines: 500, ranges: [[401, 450]] }],
      },
      createdAt: 0,
    }
    const r = await compact(
      input({
        previous,
        actions: [
          read('rn:1', 1, 100),
          read('rn:2', 101, 200),
          read('rn:3', 301, 350),
          read('rn:4', 201, 300, 'failure'),
        ],
      }),
      ok,
    )
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.filesRead).toEqual([
      {
        path: 'big.txt',
        totalLines: 500,
        ranges: [
          [1, 200],
          [301, 350],
          [401, 450],
        ],
      },
    ])
    const projected = projectManifest(r.manifest)
      .map((m) => m.content)
      .join('\n')
    expect(projected).toContain('big.txt：已读第 1–200、301–350、401–450 行（共 500 行）')
  })

  test('失败的动作进入未解决清单', async () => {
    const r = await compact(input(), ok)
    const open = r.status === 'compacted' ? r.manifest.facts.openItems.join('\n') : ''
    expect(open).toContain('run_command')
    expect(open).toContain('exit_1')
  })

  test('落盘定位符逐条收录，压缩后仍可调用 read_resource', async () => {
    const r = await compact(
      input({
        actions: [{ ...actions[0]!, resourceId: 'rs_abc' }],
      }),
      ok,
    )
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.resources?.join('')).toContain('rs_abc')
  })

  test('增量压缩合并旧事实：早期约束不随新一次压缩消失', async () => {
    const previous: CompactionManifest = {
      revision: 1,
      compactedThroughMessageId: 'ms_000' as MessageId,
      compactedMessageCount: 0,
      summary: '旧摘要',
      facts: {
        filesTouched: ['src/legacy/keep.ts'],
        openItems: [],
        userConstraints: ['第一轮就定下的约束'],
      },
      createdAt: 0,
    }
    const r = await compact(input({ previous }), ok)
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.filesTouched).toContain('src/legacy/keep.ts')
    expect(r.manifest.facts.userConstraints).toContain('第一轮就定下的约束')
    expect(r.manifest.revision).toBe(2)
  })

  test('逐字相同的重复约束只保留一条', async () => {
    const r = await compact(
      input({
        messages: Array.from({ length: 5 }, (_, i) => msg(i, 'user', '不要 force-push')),
        actions: [],
      }),
      ok,
    )
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.userConstraints).toEqual(['不要 force-push'])
  })

  test('预算不足时先裁剪文件清单，再裁剪未解决项，约束最后裁剪', async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      ...actions[0]!,
      stepId: `rn_1:${i}`,
      target: `src/very/long/nested/path/module${i}.ts`,
    }))
    const r = await compact(
      input({
        messages: [msg(1, 'user', '不要动 legacy/ 目录')],
        actions: many,
        projectionBudget: 200,
      }),
      ok,
    )
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.userConstraints).toContain('不要动 legacy/ 目录')
    expect(r.manifest.facts.filesTouched.length).toBeLessThan(many.length)
  })

  /** 约束位于长消息的后半段。先截取头部再判定时，该句既不被判定为约束，也不进入事实包。 */
  test('长消息按全文判定约束，摘录带约束的句子并附原文地址', async () => {
    const long = `${'这是一段很长的背景说明，交代需求的来龙去脉。'.repeat(20)}上线前不要动 production 数据库。`
    const r = await compact(input({ messages: [msg(7, 'user', long)], actions: [] }), ok)
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    const [fact] = r.manifest.facts.userConstraints
    expect(fact).toContain('不要动 production 数据库')
    expect(fact).toContain('[message:ms_007]')
  })

  /** 预算紧张时，较新的普通消息不能挤占较早的禁止性要求。 */
  test('预算紧张时先收录带约束的消息，再收录其他消息', async () => {
    const chatter = Array.from({ length: 30 }, (_, i) =>
      msg(10 + i, 'user', `顺便看看这段输出有什么问题，追问编号 ${i}：补充一些背景。`),
    )
    const r = await compact(
      input({
        messages: [msg(1, 'user', '不要 force-push'), ...chatter],
        actions: [],
        projectionBudget: 300,
      }),
      ok,
    )
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.userConstraints[0]).toBe('不要 force-push')
    expect(r.manifest.facts.userConstraints.length).toBeLessThan(chatter.length + 1)
  })

  /** 同一工具对同一目标先失败后成功时，之前的失败不再列为未解决；其他目标的成功不核销该失败。 */
  test('未解决项按同一工具与目标的后续成功核销', async () => {
    const read = (i: number, target: string, status: 'success' | 'failure') => ({
      stepId: `rn_1:${i}`,
      tool: 'read_file',
      status,
      actionKind: 'read' as const,
      target,
      summary: '',
      ...(status === 'failure' ? { errorCode: 'path_not_found' } : {}),
    })
    const r = await compact(
      input({
        actions: [
          read(1, 'a.ts', 'failure'),
          read(2, 'b.ts', 'failure'),
          read(3, 'a.ts', 'success'),
          read(4, 'c.ts', 'success'),
        ],
      }),
      ok,
    )
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.openItems).toEqual(['read_file b.ts 失败（path_not_found）'])
  })

  test('上一次压缩留下的失败项同样可以被核销', async () => {
    const previous: CompactionManifest = {
      revision: 1,
      compactedThroughMessageId: 'ms_000' as MessageId,
      compactedMessageCount: 0,
      summary: '旧摘要',
      facts: {
        filesTouched: [],
        openItems: ['read_file a.ts 失败（path_not_found）'],
        userConstraints: [],
      },
      createdAt: 0,
    }
    const r = await compact(
      input({
        previous,
        actions: [
          {
            stepId: 'rn_2:1',
            tool: 'read_file',
            status: 'success',
            actionKind: 'read',
            target: 'a.ts',
            summary: '',
          },
        ],
      }),
      ok,
    )
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.openItems).toEqual([])
  })
})

describe('投影', () => {
  const manifest: CompactionManifest = {
    revision: 3,
    compactedThroughMessageId: 'ms_010' as MessageId,
    compactedMessageCount: 5,
    summary: '重构认证模块，已改完 token.ts',
    facts: {
      filesTouched: ['src/auth/token.ts'],
      openItems: ['npm test 有 2 个用例失败'],
      userConstraints: ['不要动 legacy/ 目录'],
    },
    createdAt: 0,
  }

  test('产出两条消息：摘要与事实清单分开', () => {
    const projected = projectManifest(manifest)
    expect(projected).toHaveLength(2)
    expect(projected[0]!.content).toContain('重构认证模块')
  })

  /** 只推进收纳线时 revision 递增、summary 与 facts 不变，投影必须逐字不变。 */
  test('只有 revision 变化时投影字节不变', () => {
    const next = { ...manifest, revision: manifest.revision + 1 }
    expect(projectManifest(next)).toEqual(projectManifest(manifest))
  })

  test('事实清单单独成条，避免被下一轮压缩改写', () => {
    const facts = projectManifest(manifest)[1]!.content
    expect(facts).toContain('不要动 legacy/ 目录')
    expect(facts).toContain('src/auth/token.ts')
    expect(facts).toContain('逐字保留')
  })

  test('事实全空时输出明确的「无」，不产出空消息', () => {
    const empty = projectManifest({
      ...manifest,
      facts: { filesTouched: [], openItems: [], userConstraints: [] },
    })
    expect(empty[1]!.content.trim().length).toBeGreaterThan(0)
  })
})
