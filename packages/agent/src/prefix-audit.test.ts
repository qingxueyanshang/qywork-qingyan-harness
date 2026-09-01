/**
 * 冻结前缀审计。
 *
 * 这一组里最重要的是最后那个 describe：它拿**真实的**系统提示词去审。
 * 前面几条验的是审计器本身，最后那条验的是被审的前缀——
 * 前者绿了不代表后者没问题，而后者才是会花钱的那个。
 */

import { describe, expect, test } from 'bun:test'
import type { SystemBlock } from '@qywork/ai'
import {
  auditFrozenPrefix,
  auditFrozenText,
  describeDrift,
  frozenBlocks,
  hashFrozen,
  PrefixAudit,
} from './prefix-audit.ts'

const block = (text: string, brk = false): SystemBlock =>
  brk ? { text, cacheBreakpoint: true } : { text }

describe('冻结区边界是最后一个断点', () => {
  test('断点之前（含）算冻结区', () => {
    const sys = [block('a'), block('b', true), block('c')]
    expect(frozenBlocks(sys).map((b) => b.text)).toEqual(['a', 'b'])
  })

  test('多个断点取最后一个', () => {
    const sys = [block('a', true), block('b', true), block('c')]
    expect(frozenBlocks(sys).map((b) => b.text)).toEqual(['a', 'b'])
  })

  /**
   * 没有断点 = 没有声明冻结区，审计范围是空而不是「全部」。
   * 判成全部的话，任何一次正常的历史增长都会被报成漂移，
   * 而假警报多了真警报就没人看了。
   */
  test('一个断点都没有时审计范围为空，不是全部', () => {
    expect(frozenBlocks([block('a'), block('b')])).toEqual([])
  })
})

describe('哈希', () => {
  test('同样的内容同样的哈希', () => {
    expect(hashFrozen([block('x', true)])).toBe(hashFrozen([block('x', true)]))
  })

  test('差一个字节就不同', () => {
    expect(hashFrozen([block('x', true)])).not.toBe(hashFrozen([block('x ', true)]))
  })

  /** 拼接歧义：`['ab','']` 与 `['a','b']` 直接相连是同一串，但它们是不同的前缀。 */
  test('分段方式不同 → 哈希不同', () => {
    const a = [block('ab'), block('', true)]
    const b = [block('a'), block('b', true)]
    expect(hashFrozen(a)).not.toBe(hashFrozen(b))
  })

  test('断点之后的内容不影响哈希', () => {
    const a = [block('x', true), block('尾区甲')]
    const b = [block('x', true), block('尾区乙')]
    expect(hashFrozen(a)).toBe(hashFrozen(b))
  })
})

describe('静态审计：天生会变的字段不该进前缀', () => {
  test('日期', () => {
    expect(auditFrozenText('今天是 2026-08-09').map((h) => h.kind)).toContain('date')
  })

  test('时间', () => {
    expect(auditFrozenText('现在 14:30').map((h) => h.kind)).toContain('time')
  })

  test('绝对路径（Windows 与 POSIX 都认）', () => {
    expect(auditFrozenText('工作区 C:\\Users\\me\\proj').map((h) => h.kind)).toContain('abs-path')
    expect(auditFrozenText('工作区 /home/me/proj').map((h) => h.kind)).toContain('abs-path')
  })

  test('run id 之类的 uuid', () => {
    const t = '本轮 550e8400-e29b-41d4-a716-446655440000'
    expect(auditFrozenText(t).map((h) => h.kind)).toContain('uuid')
  })

  test('干净文本零命中', () => {
    expect(auditFrozenText('你是一个编码 agent，完成任务而不是描述任务。')).toEqual([])
  })

  test('每条命中都要说清为什么会变 —— 只说「有问题」没法改', () => {
    for (const hit of auditFrozenText('2026-08-09 /home/x/y 12:00')) {
      expect(hit.why.length).toBeGreaterThan(5)
      expect(hit.sample.length).toBeGreaterThan(0)
    }
  })

  test('只审冻结区，断点之后的日期是合法的', () => {
    const sys = [block('稳定内容', true), block('当前日期：2026-08-09')]
    expect(auditFrozenPrefix(sys)).toEqual([])
  })
})

describe('运行时审计', () => {
  test('第一次观测不报', () => {
    expect(new PrefixAudit().observe('cv1', [block('a', true)])).toBeNull()
  })

  test('内容不变不报', () => {
    const a = new PrefixAudit()
    a.observe('cv1', [block('a', true)])
    expect(a.observe('cv1', [block('a', true)])).toBeNull()
  })

  test('变了要报，并指出第几段、变成了什么', () => {
    const a = new PrefixAudit()
    a.observe('cv1', [block('第一段'), block('第二段', true)])
    const d = a.observe('cv1', [block('第一段'), block('第二段改了', true)])
    expect(d).not.toBeNull()
    expect(d!.blockIndex).toBe(1)
    expect(d!.before).toBe('第二段')
    expect(d!.after).toBe('第二段改了')
  })

  test('段数变了也报', () => {
    const a = new PrefixAudit()
    a.observe('cv1', [block('x', true)])
    const d = a.observe('cv1', [block('x'), block('y', true)])
    expect(d!.blockIndex).toBe(-1)
  })

  /**
   * 报完要把基线更新成新值。
   * 不更新的话第一次漂移之后每一轮都重复报同一条，真正的第二次漂移被淹掉。
   */
  test('报过之后基线更新，同样的内容不再重复报', () => {
    const a = new PrefixAudit()
    a.observe('cv1', [block('a', true)])
    expect(a.observe('cv1', [block('b', true)])).not.toBeNull()
    expect(a.observe('cv1', [block('b', true)])).toBeNull()
  })

  test('漂移次数累计 —— 反复漂和只漂一次是两种 bug', () => {
    const a = new PrefixAudit()
    a.observe('cv1', [block('a', true)])
    expect(a.observe('cv1', [block('b', true)])!.occurrence).toBe(1)
    expect(a.observe('cv1', [block('c', true)])!.occurrence).toBe(2)
  })

  test('不同会话互不影响', () => {
    const a = new PrefixAudit()
    a.observe('cv1', [block('a', true)])
    expect(a.observe('cv2', [block('完全不同', true)])).toBeNull()
  })

  test('forget 之后不再持有', () => {
    const a = new PrefixAudit()
    a.observe('cv1', [block('a', true)])
    expect(a.size).toBe(1)
    a.forget('cv1')
    expect(a.size).toBe(0)
  })

  test('说明里要点明代价 —— 不然读日志的人不知道这条要不要管', () => {
    const a = new PrefixAudit()
    a.observe('cv1', [block('a', true)])
    const text = describeDrift(a.observe('cv1', [block('b', true)])!)
    expect(text).toContain('缓存')
    expect(text).toContain('计费')
  })
})

describe('审真实的系统提示词', () => {
  /** 门槛工具全在，能力段全部发出——审的是最长的那份前缀。 */
  const GATES = [
    'run_command',
    'write_memory',
    'move_memory',
    'read_skill',
    'write_skill',
    'move_skill',
    'write_mcp_server',
    'move_mcp_server',
    'load_tool',
    'subagent',
    'workflow',
    'create_schedule',
    'read_goal',
    'read_history',
    'web_search',
  ]
  const ALL = new Set(GATES)

  test('三层冻结前缀里没有天生会变的字段', async () => {
    const { buildSystemPrompt } = await import('@qywork/runtime')
    expect(auditFrozenText(buildSystemPrompt(ALL))).toEqual([])
  })

  test('两次构造逐字节相同', async () => {
    const { buildSystemPrompt } = await import('@qywork/runtime')
    expect(buildSystemPrompt(ALL)).toBe(buildSystemPrompt(ALL))
  })

  /** 缺一条模型就想不起来自己能做这件事，所以每个类目都要发到。 */
  test('能力段把每个类目都告诉模型', async () => {
    const { buildSystemPrompt } = await import('@qywork/runtime')
    const p = buildSystemPrompt(ALL)
    for (const tool of GATES) expect(p).toContain(tool)
    expect(p).toContain('主会话验收后可能要求原子会话返工')
    expect(p).toContain('revise 回流')
  })

  /**
   * 复现的是原始失败形状：`run_command` / `subagent` / `workflow` / `load_tool`
   * 按通道注册，写死会让没有对应通道的会话读到一个不存在的工具。
   */
  test('缺通道时那一行不发，其余照常', async () => {
    const { buildSystemPrompt } = await import('@qywork/runtime')
    const p = buildSystemPrompt(new Set(['write_memory', 'read_skill']))
    expect(p).not.toContain('run_command')
    expect(p).not.toContain('subagent')
    expect(p).not.toContain('load_tool')
    expect(p).toContain('write_memory')
    expect(p).toContain('read_skill')

    // 一个门槛工具都没有时整段不出现，而不是留一个空标题。
    expect(buildSystemPrompt(new Set())).not.toContain('## 能力')
  })

  test('输入区显式引用绑定技能、外部工具与子 agent', async () => {
    const { buildSystemPrompt } = await import('@qywork/runtime')
    const p = buildSystemPrompt(
      new Set(['read_skill', 'load_tool', 'define_subagent', 'subagent', 'mcp__github__search']),
    )
    expect(p).toContain('#技能名')
    expect(p).toContain('@工具注册名')
    expect(p).toContain('@角色id')
    expect(p).toContain('/subagent 角色描述')
    expect(p).toContain('可长期复用')
    expect(p).not.toContain('`@subagent`')
    expect(p).toContain('直接调用该工具')
  })

  /**
   * 尾区注记**应该**含日期——这条反过来验：那些会变的字段确实被放在了
   * 断点之外。它绿了才说明分层是真的分开了，而不是两边都干净所以看着没问题。
   */
  test('尾区注记确实带着会变的内容（证明分层不是摆设）', async () => {
    const { buildTailNotes } = await import('@qywork/runtime')
    const notes = buildTailNotes({ workspaceRoot: '/tmp/ws', platform: 'linux', mode: 'auto' })
      .map((n) => n.content)
      .join('\n')
    const kinds = auditFrozenText(notes).map((h) => h.kind)
    expect(kinds).toContain('date')
    expect(kinds).toContain('abs-path')
  })
})
