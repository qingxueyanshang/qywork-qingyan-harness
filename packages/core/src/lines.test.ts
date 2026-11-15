/**
 * 覆盖 `lines.ts`。三个调用方（MCP 传输、插件进程、外部 CLI 输出）溢出时的终态分别由
 * `packages/mcp/src/mcp.test.ts`、`packages/plugins/src/host.test.ts`、`packages/team/src/cli-output.test.ts` 锁定。
 */

import { describe, expect, test } from 'bun:test'
import { createLineFramer } from './lines.ts'

describe('分帧', () => {
  test('跨分片的行拼接完整，换行之后的部分留在缓冲中', () => {
    const framer = createLineFramer(100)
    expect(framer.push('{"a":')).toEqual({ lines: [], overflow: false })
    expect(framer.push('1}\n{"b"')).toEqual({ lines: ['{"a":1}'], overflow: false })
    expect(framer.push(':2}\n')).toEqual({ lines: ['{"b":2}'], overflow: false })
    expect(framer.end()).toBe('')
  })

  test('\\r\\n 的 \\r 与空行原样交给调用方', () => {
    const framer = createLineFramer(100)
    expect(framer.push('a\r\n\n\r\nb\n').lines).toEqual(['a\r', '', '\r', 'b'])
  })

  test('逐字符输入与整段输入结果相同', () => {
    const text = '第一行\n\n{"x":"二"}\r\n末行'
    const whole = createLineFramer(100)
    const split = createLineFramer(100)
    const lines: string[] = []
    for (const char of text) lines.push(...split.push(char).lines)
    expect(lines).toEqual(whole.push(text).lines)
    expect(split.end()).toBe(whole.end())
  })

  test('end 交出没有换行的末行并清空缓冲', () => {
    const framer = createLineFramer(100)
    framer.push('a\nb')
    expect(framer.end()).toBe('b')
    expect(framer.end()).toBe('')
  })
})

describe('单行上限', () => {
  /**
   * 原始失败形状：对端持续输出而不输出换行时，缓冲无限增长。
   * 恰好等于上限的行照常交出，多一个字符即溢出，说明缓冲从不超过上限。
   */
  test('没有换行的输入超过上限时报告溢出，等于上限时不报告', () => {
    const exact = createLineFramer(8)
    expect(exact.push('12345678')).toEqual({ lines: [], overflow: false })
    expect(exact.push('\n')).toEqual({ lines: ['12345678'], overflow: false })

    const over = createLineFramer(8)
    expect(over.push('1234')).toEqual({ lines: [], overflow: false })
    expect(over.push('56789')).toEqual({ lines: [], overflow: true })
  })

  test('同一分片中溢出之前已结束的行照常交出，溢出之后的输入一律丢弃', () => {
    const framer = createLineFramer(4)
    expect(framer.push('ab\ncdefgh\nij\n')).toEqual({ lines: ['ab'], overflow: true })
    expect(framer.push('kl\n')).toEqual({ lines: [], overflow: false })
    expect(framer.end()).toBe('')
  })

  test('以换行结束但超过上限的行同样溢出', () => {
    expect(createLineFramer(4).push('abcde\n')).toEqual({ lines: [], overflow: true })
  })
})
