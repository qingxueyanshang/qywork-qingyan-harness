/**
 * 覆盖范围：`compaction.ts` 全部——单元键与边界、收纳段、摘要段的预算与闸、
 * 事实包、投影。接线（发送前检查 → 压缩 → 重新装配）在 `compaction-loop.test.ts`。
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

/** 折叠线默认落在最后一条消息上，预算给足；单项测试按需覆盖。 */
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

  test('跨消息按消息 id 排，戳不参与', () => {
    const early = unitKey({
      role: 'tool',
      content: 'x',
      _messageId: 'ms_002',
      _step: stepStamp('rn_z', 999),
    })!
    const late = unitKey({ role: 'user', content: 'x', _messageId: 'ms_003' })!
    expect(early < late).toBe(true)
  })

  test('同一 run 内 seq 按数值排，定宽补零不会让 10 排在 2 之前', () => {
    expect(stepStamp('rn_a', 2) < stepStamp('rn_a', 10)).toBe(true)
  })

  test('无 _messageId 的消息不参与折叠', () => {
    expect(unitKey({ role: 'assistant', content: '投影摘要' })).toBeNull()
  })

  test('缺 condensedThrough 的 manifest：收纳线与摘要线重合', () => {
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

describe('收纳段：换信封，不改字节', () => {
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

  test('工具结果去正文，留信封与落盘定位符', () => {
    const out = condenseMessage(toolMsg)
    const env = JSON.parse(out.content as string)
    expect(env.result).toBeUndefined()
    expect(env.result_omitted).toBe(true)
    // 图像省略标记只属于真丢过图像块的收纳，纯文本收纳不得带。
    expect(env.images_omitted).toBeUndefined()
    expect(env.summary).toBe('跑完了')
    expect(env.resources).toEqual(['rs_abc'])
    expect((out.content as string).length).toBeLessThan((toolMsg.content as string).length / 10)
  })

  test('正文型调用参数折成摘录 + 标记', () => {
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

  test('思考正文原样保留 —— 缺它 DeepSeek 兼容端点下一轮 400', () => {
    const out = condenseMessage({
      role: 'assistant',
      content: '',
      reasoningContent: '想了很久',
      toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } }],
    })
    expect(out.reasoningContent).toBe('想了很久')
  })

  test('用户与助手正文原样', () => {
    const m: WireMessage = { role: 'user', content: '别改 legacy/' }
    expect(condenseMessage(m)).toBe(m)
  })

  test('投影幂等：同一条收纳两次逐字相等', () => {
    const once = condenseMessage(toolMsg)
    expect(condenseMessage(once).content).toBe(once.content)
  })
})

describe('收纳够用时不调模型', () => {
  test('condenseOnly：摘要器零次调用，只前移收纳线', async () => {
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
    // 摘要线不动。
    expect(r.manifest.compactedThroughMessageId).toBeNull()
  })

  test('收纳线已经在折叠线上时跳过 —— 不白涨一个修订号', async () => {
    const previous: CompactionManifest = {
      revision: 1,
      compactedThroughMessageId: null,
      condensedThrough: { messageId: 'ms_004' as MessageId },
      compactedMessageCount: 0,
      summary: '',
      facts: { filesTouched: [], openItems: [], userConstraints: [] },
      createdAt: 0,
    }
    // 收纳线不前移时摘要段仍可推进摘要线，所以这里走的是摘要段。
    const r = await compact(input({ previous }), ok)
    expect(r.status).toBe('compacted')
    if (r.status !== 'compacted') return
    expect(r.summarized).toBe(true)
  })
})

describe('摘要段失败不回退收纳段', () => {
  test('摘要器抛错：收纳线照常前移，带失败码', async () => {
    const r = await compact(input(), async () => {
      throw new Error('上下文超限')
    })
    if (r.status !== 'compacted') throw new Error('收纳应当落库')
    expect(r.summarized).toBe(false)
    expect(r.reasonCode).toBe('summary_error')
    expect(r.manifest.compactedThroughMessageId).toBeNull()
    expect(r.manifest.condensedThrough).toEqual({ messageId: 'ms_004' as MessageId })
  })

  test('摘要为空（含被截断）同样算段失败', async () => {
    const r = await compact(input(), async () => null)
    expect(r.status === 'compacted' && r.reasonCode).toBe('summary_empty')
  })

  test('收纳也推不动时才算彻底失败', async () => {
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

  test('没有摘要空间时不发请求', async () => {
    let calls = 0
    const r = await compact(input({ projectionBudget: 0 }), async () => {
      calls++
      return '摘要'
    })
    expect(calls).toBe(0)
    expect(r.status === 'compacted' && r.reasonCode).toBe('no_headroom')
  })
})

describe('摘要预算：两头取小，全程 token 计', () => {
  test('有观测时取 min(headroom, p95)', async () => {
    const seen: number[] = []
    await compact(input({ typicalSummaryTokens: 300 }), async (_p, b) => {
      seen.push(b)
      return '摘要'
    })
    expect(seen[0]).toBe(300)
  })

  test('无观测时退回 headroom，不套固定比例', async () => {
    const seen: number[] = []
    await compact(input({ projectionBudget: 900, typicalSummaryTokens: null }), async (_p, b) => {
      seen.push(b)
      return '摘要'
    })
    // 事实清单先占，摘要拿剩下的：一定小于总预算但远大于旧的 4000 字符上限折算。
    expect(seen[0]!).toBeGreaterThan(0)
    expect(seen[0]!).toBeLessThan(900)
  })

  test('预算随输入的可用空间走，不随原文长度定死', async () => {
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

describe('「必须更小」闸', () => {
  test('新投影不比被替换的内容小就作废摘要段', async () => {
    const r = await compact(input({ condensedRegionTokens: 1 }), async () => '摘'.repeat(5_000))
    expect(r.status === 'compacted' && r.summarized).toBe(false)
    expect(r.status === 'compacted' && r.reasonCode).toBe('not_smaller')
  })

  test('小得下来就采用，摘要线推到折叠线', async () => {
    const r = await compact(input({ condensedRegionTokens: 5_000 }), ok)
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.summarized).toBe(true)
    expect(r.manifest.compactedThroughMessageId).toBe('ms_004' as MessageId)
    expect(r.manifest.condensedThrough).toEqual({ messageId: 'ms_004' as MessageId })
  })
})

describe('中断即丢弃', () => {
  test('摘要调用抛 AbortError → aborted，不落任何行', async () => {
    const r = await compact(input(), async () => {
      throw new DOMException('已中断', 'AbortError')
    })
    expect(r.status).toBe('aborted')
  })

  test('摘要写完的同一刻信号被拉起 → 照样丢弃', async () => {
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

describe('事实包必须逐字保留，不经模型', () => {
  test('文件路径按动作类别收，命令串不进清单', async () => {
    const r = await compact(input(), ok)
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.filesTouched).toEqual(['src/auth/token.ts'])
    expect(r.manifest.facts.filesTouched.join('')).not.toContain('npm test')
  })

  test('全部用户消息逐字进事实包，约束排在前面', async () => {
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

  test('失败的动作进未解决清单', async () => {
    const r = await compact(input(), ok)
    const open = r.status === 'compacted' ? r.manifest.facts.openItems.join('\n') : ''
    expect(open).toContain('run_command')
    expect(open).toContain('exit_1')
  })

  test('落盘定位符逐条收，压缩之后 read_resource 仍调得起来', async () => {
    const r = await compact(
      input({
        actions: [{ ...actions[0]!, resourceId: 'rs_abc' }],
      }),
      ok,
    )
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.resources?.join('')).toContain('rs_abc')
  })

  test('增量压缩合并旧事实 —— 早期约束不能随新压缩消失', async () => {
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

  test('逐字相同的重复约束只留一条', async () => {
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

  test('预算不够时先裁文件、再裁未解决，约束最后裁', async () => {
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
    expect(projected[0]!.content).toContain('修订版本 3')
  })

  test('事实清单单独成条，避免被下一轮压缩改写', () => {
    const facts = projectManifest(manifest)[1]!.content
    expect(facts).toContain('不要动 legacy/ 目录')
    expect(facts).toContain('src/auth/token.ts')
    expect(facts).toContain('逐字保留')
  })

  test('事实全空时也给出明确的「无」，不产出空消息', () => {
    const empty = projectManifest({
      ...manifest,
      facts: { filesTouched: [], openItems: [], userConstraints: [] },
    })
    expect(empty[1]!.content.trim().length).toBeGreaterThan(0)
  })
})
