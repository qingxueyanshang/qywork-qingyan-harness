import { describe, expect, test } from 'bun:test'
import type { CompactionManifest, MessageId } from '@qywork/core'
import { compact, localSummary, projectManifest } from './compaction.ts'

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

const actions = [
  {
    stepId: 'rn_1:1',
    tool: 'read_file',
    status: 'success',
    target: 'src/auth/token.ts',
    summary: '读取 120 行',
  },
  {
    stepId: 'rn_1:2',
    tool: 'edit_file',
    status: 'success',
    target: 'src/auth/token.ts',
    summary: '替换 3 处',
  },
  {
    stepId: 'rn_1:3',
    tool: 'run_command',
    status: 'failure',
    target: 'npm test',
    summary: '2 个用例失败',
    errorCode: 'exit_1',
  },
]

describe('触发门槛', () => {
  test('消息太少不压缩 —— 摘要的信息损失比省下的 token 更贵', async () => {
    const r = await compact(
      { messages: longHistory.slice(0, 2), actions: [], previous: null },
      null,
    )
    expect(r.status).toBe('skipped')
    expect(r.status === 'skipped' && r.reasonCode).toBe('too_few_messages')
  })

  test('已经压到头且没有新动作时跳过，不白花一次模型调用', async () => {
    const previous: CompactionManifest = {
      revision: 1,
      compactedThroughMessageId: 'ms_004' as MessageId,
      compactedRunSteps: {},
      summary: '之前的摘要',
      facts: { filesTouched: [], decisions: [], openItems: [], userConstraints: [] },
      createdAt: 0,
    }
    const r = await compact({ messages: longHistory, actions: [], previous }, null)
    expect(r.status).toBe('skipped')
    expect(r.status === 'skipped' && r.reasonCode).toBe('nothing_new')
  })

  test('skipped 不是 failed —— 调用方不该据此报错', async () => {
    const r = await compact({ messages: [], actions: [], previous: null }, null)
    expect(r.status).not.toBe('failed')
  })
})

describe('摘要生成', () => {
  test('模型摘要可用时采用它', async () => {
    const r = await compact(
      { messages: longHistory, actions, previous: null },
      async () => '模型写的摘要',
    )
    expect(r.status).toBe('compacted')
    expect(r.status === 'compacted' && r.usedModel).toBe(true)
    expect(r.status === 'compacted' && r.manifest.summary).toBe('模型写的摘要')
  })

  test('摘要调用抛异常时降级到本地，不把整轮带崩', async () => {
    const r = await compact({ messages: longHistory, actions, previous: null }, async () => {
      throw new Error('上下文超限')
    })
    expect(r.status).toBe('compacted')
    expect(r.status === 'compacted' && r.usedModel).toBe(false)
    expect(r.status === 'compacted' && r.manifest.summary).toContain('本地确定性摘要')
  })

  test('摘要返回空串时同样降级', async () => {
    const r = await compact({ messages: longHistory, actions, previous: null }, async () => '   ')
    expect(r.status === 'compacted' && r.usedModel).toBe(false)
  })

  test('没有摘要器时直接走本地路径', async () => {
    const r = await compact({ messages: longHistory, actions, previous: null }, null)
    expect(r.status).toBe('compacted')
  })
})

describe('事实包必须逐字保留，不经模型', () => {
  test('用户约束原话进 facts，即使模型摘要完全跑偏', async () => {
    const r = await compact(
      { messages: longHistory, actions, previous: null },
      async () => '这份摘要故意什么都没说',
    )
    expect(r.status).toBe('compacted')
    if (r.status !== 'compacted') return
    const constraints = r.manifest.facts.userConstraints.join('\n')
    expect(constraints).toContain('不要动 legacy/ 目录')
    expect(constraints).toContain('迁移必须可回滚')
  })

  test('文件路径从动作目标提取，不靠模型转述', async () => {
    const r = await compact({ messages: longHistory, actions, previous: null }, null)
    expect(r.status === 'compacted' && r.manifest.facts.filesTouched).toContain('src/auth/token.ts')
  })

  test('失败的动作进未解决清单', async () => {
    const r = await compact({ messages: longHistory, actions, previous: null }, null)
    const open = r.status === 'compacted' ? r.manifest.facts.openItems.join('\n') : ''
    expect(open).toContain('run_command')
    expect(open).toContain('exit_1')
  })

  test('增量压缩合并旧事实 —— 早期约束不能随新压缩消失', async () => {
    const previous: CompactionManifest = {
      revision: 1,
      compactedThroughMessageId: 'ms_000' as MessageId,
      compactedRunSteps: {},
      summary: '旧摘要',
      facts: {
        filesTouched: ['src/legacy/keep.ts'],
        decisions: ['决定用 RS256'],
        openItems: [],
        userConstraints: ['第一轮就定下的约束'],
      },
      createdAt: 0,
    }
    const r = await compact({ messages: longHistory, actions, previous }, null)
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    expect(r.manifest.facts.filesTouched).toContain('src/legacy/keep.ts')
    expect(r.manifest.facts.decisions).toContain('决定用 RS256')
    expect(r.manifest.facts.userConstraints).toContain('第一轮就定下的约束')
    expect(r.manifest.revision).toBe(2)
  })
})

describe('本地降级摘要', () => {
  test('保住第一条用户消息与末尾片段 —— 两头最重要', () => {
    const segs = [
      '[message:ms_001] 用户：这是最初的任务',
      ...Array.from({ length: 60 }, (_, i) => `[action:st_${i}] 工具=read_file；状态=success`),
      '[message:ms_099] 助手：这是当前进度',
    ]
    const out = localSummary(segs, 1200)
    expect(out).toContain('这是最初的任务')
    expect(out).toContain('这是当前进度')
    // 中间的探索过程应当被挤掉大部分。
    expect(out.length).toBeLessThanOrEqual(1200)
  })

  test('预算极小时不返回空 —— 空摘要等于压缩失败', () => {
    const out = localSummary(['[message:ms_001] 用户：任务'], 10)
    expect(out.length).toBeGreaterThan(0)
  })

  test('没有片段时返回空串（调用方据此判 failed）', () => {
    expect(localSummary([], 1000)).toBe('')
  })
})

describe('投影', () => {
  const manifest: CompactionManifest = {
    revision: 3,
    compactedThroughMessageId: 'ms_010' as MessageId,
    compactedRunSteps: { rn_1: 5 },
    summary: '重构认证模块，已改完 token.ts',
    facts: {
      filesTouched: ['src/auth/token.ts'],
      decisions: ['用 RS256'],
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
      facts: { filesTouched: [], decisions: [], openItems: [], userConstraints: [] },
    })
    expect(empty[1]!.content.trim().length).toBeGreaterThan(0)
  })
})

describe('压缩必须真的变小', () => {
  /**
   * 回归用例：曾经这里是「所有用户消息逐字保留 + 固定 4000 字符摘要预算」，
   * 结果一段 2574 字符的会话被"压"成 5478 字符的投影——**压缩把上下文变大了**。
   * 实测由 `scripts/compaction-fidelity.ts` 抓到（报 213%）。
   */
  test('长会话的投影明显短于原文', async () => {
    const messages = Array.from({ length: 40 }, (_, i) =>
      msg(
        i + 1,
        i % 2 === 0 ? 'user' : 'assistant',
        i === 0
          ? '重构认证模块，不要动 legacy/ 目录'
          : `第 ${i} 轮：继续，看看 src/mod${i}.ts 里还有什么要改的`,
      ),
    )
    const original = messages.reduce((n, m) => n + m.content.length, 0)

    // 摘要器按预算截断，模拟真实模型会填满预算的行为。
    const r = await compact({ messages, actions: [], previous: null }, async (_p, budget) =>
      '摘'.repeat(budget),
    )
    if (r.status !== 'compacted') throw new Error('应当压缩成功')

    const projected = projectManifest(r.manifest)
      .map((p) => p.content)
      .join('\n')
    expect(projected.length).toBeLessThan(original)
  })

  test('摘要预算随输入缩放，不是固定值', async () => {
    const budgets: number[] = []
    const capture = async (_p: string, b: number) => {
      budgets.push(b)
      return '摘要'
    }

    const short = Array.from({ length: 5 }, (_, i) => msg(i + 1, 'user', '短'))
    const long = Array.from({ length: 5 }, (_, i) => msg(i + 1, 'user', 'x'.repeat(4000)))

    await compact({ messages: short, actions: [], previous: null }, capture)
    await compact({ messages: long, actions: [], previous: null }, capture)

    expect(budgets[1]!).toBeGreaterThan(budgets[0]!)
  })

  test('普通过程性消息不进事实包，带约束的进', async () => {
    const r = await compact(
      {
        messages: [
          msg(1, 'user', '继续，看看 src/a.ts'),
          msg(2, 'assistant', '看过了'),
          msg(3, 'user', '不要动 legacy/ 目录'),
          msg(4, 'user', '令牌有效期定为 15 分钟'),
          msg(5, 'user', '然后呢'),
        ],
        actions: [],
        previous: null,
      },
      null,
    )
    if (r.status !== 'compacted') throw new Error('应当压缩成功')
    const c = r.manifest.facts.userConstraints.join('\n')

    expect(c).toContain('legacy')
    // 带单位的数字必须逐字留下：模型概括时最爱丢的就是具体数值，
    // 而一个数字被改写整条约束就错了。
    expect(c).toContain('15 分钟')
    expect(c).not.toContain('然后呢')
    expect(c).not.toContain('看看 src/a.ts')
  })
})
