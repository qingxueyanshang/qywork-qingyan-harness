/**
 * 冻结前缀审计器本身的用例。
 *
 * 用真实的系统提示词进行的审计在 `runtime/src/prompt.test.ts`：系统提示词由 runtime 构造，
 * agent 位于 runtime 之下，不得导入它。本文件通过只说明审计器正确，不说明真实前缀中没有可变字段，
 * 而产生费用的是真实前缀。
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
  test('断点及其之前属于冻结区', () => {
    const sys = [block('a'), block('b', true), block('c')]
    expect(frozenBlocks(sys).map((b) => b.text)).toEqual(['a', 'b'])
  })

  test('多个断点取最后一个', () => {
    const sys = [block('a', true), block('b', true), block('c')]
    expect(frozenBlocks(sys).map((b) => b.text)).toEqual(['a', 'b'])
  })

  /**
   * 没有断点表示未声明冻结区，审计范围为空而不是全部。
   * 若判定为全部，任何一次正常的历史增长都会被报告为漂移，
   * 误报过多会使真实告警被忽略。
   */
  test('没有断点时审计范围为空，而不是全部', () => {
    expect(frozenBlocks([block('a'), block('b')])).toEqual([])
  })
})

describe('哈希', () => {
  test('相同内容得到相同哈希', () => {
    expect(hashFrozen([block('x', true)])).toBe(hashFrozen([block('x', true)]))
  })

  test('相差一个字节即不同', () => {
    expect(hashFrozen([block('x', true)])).not.toBe(hashFrozen([block('x ', true)]))
  })

  /** 拼接歧义：`['ab','']` 与 `['a','b']` 直接拼接得到同一字符串，但它们是不同的前缀。 */
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

describe('静态审计：本身会变化的字段不应进入前缀', () => {
  test('日期', () => {
    expect(auditFrozenText('今天是 2026-08-09').map((h) => h.kind)).toContain('date')
  })

  test('时间', () => {
    expect(auditFrozenText('现在 14:30').map((h) => h.kind)).toContain('time')
  })

  test('绝对路径（识别 Windows 与 POSIX）', () => {
    expect(auditFrozenText('工作区 C:\\Users\\me\\proj').map((h) => h.kind)).toContain('abs-path')
    expect(auditFrozenText('工作区 /home/me/proj').map((h) => h.kind)).toContain('abs-path')
  })

  test('run id 等 uuid', () => {
    const t = '本轮 550e8400-e29b-41d4-a716-446655440000'
    expect(auditFrozenText(t).map((h) => h.kind)).toContain('uuid')
  })

  test('不含可变字段的文本无命中', () => {
    expect(auditFrozenText('你是一个编码 agent，完成任务而不是描述任务。')).toEqual([])
  })

  test('每条命中都说明变化原因：只报告存在问题无法据此修改', () => {
    for (const hit of auditFrozenText('2026-08-09 /home/x/y 12:00')) {
      expect(hit.why.length).toBeGreaterThan(5)
      expect(hit.sample.length).toBeGreaterThan(0)
    }
  })

  test('只审计冻结区，断点之后的日期合法', () => {
    const sys = [block('稳定内容', true), block('当前日期：2026-08-09')]
    expect(auditFrozenPrefix(sys)).toEqual([])
  })
})

describe('运行时审计', () => {
  test('第一次观测不报告', () => {
    expect(new PrefixAudit().observe('cv1', [block('a', true)])).toBeNull()
  })

  test('内容不变时不报告', () => {
    const a = new PrefixAudit()
    a.observe('cv1', [block('a', true)])
    expect(a.observe('cv1', [block('a', true)])).toBeNull()
  })

  test('变化时报告，并指出变化的段序号与新内容', () => {
    const a = new PrefixAudit()
    a.observe('cv1', [block('第一段'), block('第二段', true)])
    const d = a.observe('cv1', [block('第一段'), block('第二段改了', true)])
    expect(d).not.toBeNull()
    expect(d!.blockIndex).toBe(1)
    expect(d!.before).toBe('第二段')
    expect(d!.after).toBe('第二段改了')
  })

  test('段数变化时同样报告', () => {
    const a = new PrefixAudit()
    a.observe('cv1', [block('x', true)])
    const d = a.observe('cv1', [block('x'), block('y', true)])
    expect(d!.blockIndex).toBe(-1)
  })

  /**
   * 报告后必须把基线更新为新值。
   * 不更新时，第一次漂移之后每一轮都重复报告同一条，真正的第二次漂移会被掩盖。
   */
  test('报告后基线更新，相同内容不再重复报告', () => {
    const a = new PrefixAudit()
    a.observe('cv1', [block('a', true)])
    expect(a.observe('cv1', [block('b', true)])).not.toBeNull()
    expect(a.observe('cv1', [block('b', true)])).toBeNull()
  })

  test('漂移次数累计：反复漂移与单次漂移是两种不同的缺陷', () => {
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

  test('说明中写明代价：否则日志读者无法判断是否需要处理', () => {
    const a = new PrefixAudit()
    a.observe('cv1', [block('a', true)])
    const text = describeDrift(a.observe('cv1', [block('b', true)])!)
    expect(text).toContain('缓存')
    expect(text).toContain('计费')
  })
})
