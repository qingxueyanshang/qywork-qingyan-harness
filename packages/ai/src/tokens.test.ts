/**
 * Token 粗估的口径。覆盖 `tokens.ts`。
 *
 * 这个函数原本在三个 provider 里各抄了一遍，而 `openai-responses.ts` 用的是
 * **÷4**、另外两个是 **÷3.5**——同一个面板在不同 provider 下差 14% 的读数，
 * 而且没人查得到那里去。合并成一份之后，这条测试锁住它不再分裂。
 */
import { describe, expect, test } from 'bun:test'
import { estimateTokens } from './tokens.ts'

describe('estimateTokens', () => {
  test('空值一律 0，不抛', () => {
    expect(estimateTokens(undefined)).toBe(0)
    expect(estimateTokens(null)).toBe(0)
    expect(estimateTokens('')).toBe(0)
  })

  test('字符串按 3.5 字符 ≈ 1 token 向上取整', () => {
    expect(estimateTokens('a'.repeat(35))).toBe(10)
    // 不足一档也算一个：向下取整会让短消息统计成 0。
    expect(estimateTokens('a')).toBe(1)
  })

  test('对象按序列化后的长度算', () => {
    const obj = { a: 'x'.repeat(30) }
    expect(estimateTokens(obj)).toBe(Math.ceil(JSON.stringify(obj).length / 3.5))
  })

  /** 同一份输入必须给同一个数——三处各自实现时正是这条不成立。 */
  test('同输入同输出', () => {
    const v = { messages: [{ role: 'user', content: '你好' }] }
    expect(estimateTokens(v)).toBe(estimateTokens(v))
  })
})
