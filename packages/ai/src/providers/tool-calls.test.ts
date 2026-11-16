/**
 * 覆盖 `providers/tool-calls.ts`：三种协议共用的工具调用汇总 `collectToolCalls`，
 * 以及判定参数原文是否已闭合的 `ArgumentsScanner`。
 *
 * 锁定的行为：按序号排序；参数只接受 JSON 对象，其余一律记录到 `argumentsError` 且
 * `arguments` 为 `{}`；名称缺失时按协议报错；字符串中的括号与转义引号不影响闭合判定。
 */

import { describe, expect, test } from 'bun:test'
import { ProviderError } from '../errors.ts'
import { ArgumentsScanner, collectToolCalls, type ToolCallSlot } from './tool-calls.ts'

function slots(...entries: [number, ToolCallSlot][]): Map<number, ToolCallSlot> {
  return new Map(entries)
}

describe('工具调用汇总', () => {
  test('按 provider 序号排序，对象参数原样返回', () => {
    const calls = collectToolCalls(
      slots(
        [1, { id: 'b', name: 'y', json: '{"n":2}' }],
        [0, { id: 'a', name: 'x', json: '{"n":1}' }],
      ),
      'openai_chat_completions',
      'm',
    )
    expect(calls).toEqual([
      { id: 'a', name: 'x', arguments: { n: 1 } },
      { id: 'b', name: 'y', arguments: { n: 2 } },
    ])
  })

  test('空参数按无参数处理，不视为错误', () => {
    expect(
      collectToolCalls(slots([0, { id: 'a', name: 'x', json: '  ' }]), 'anthropic_messages', 'm'),
    ).toEqual([{ id: 'a', name: 'x', arguments: {} }])
  })

  /** 参数是合法 JSON 但不是对象时，与解析失败同样处理：向下传递会在执行链之外抛出异常。 */
  test('null、数组、标量与残缺 JSON 均记录原文，参数置为空对象', () => {
    for (const json of ['null', '[]', '[1]', '"x"', '42', 'true', '{"a":']) {
      for (const kind of [
        'anthropic_messages',
        'openai_chat_completions',
        'openai_responses',
      ] as const) {
        const [call] = collectToolCalls(slots([0, { id: 'a', name: 'x', json }]), kind, 'm')
        expect(call).toEqual({ id: 'a', name: 'x', arguments: {}, argumentsError: json })
      }
    }
  })

  test('名称缺失时按协议报错', () => {
    expect(() =>
      collectToolCalls(slots([0, { id: 'a', name: '', json: '{}' }]), 'openai_responses', 'm'),
    ).toThrow(ProviderError)
  })
})

describe('参数原文的闭合判定', () => {
  const scan = (...parts: string[]): boolean[] => {
    const scanner = new ArgumentsScanner()
    return parts.map((part) => {
      scanner.push(part)
      return scanner.closed
    })
  }

  test('对象在最后一个右括号到达时闭合，此前任何一段都不闭合', () => {
    expect(scan('{"path":', '"a.md"', ',"n":{"x":1}', '}')).toEqual([false, false, false, true])
  })

  test('字符串中的括号、转义引号与反斜杠不改变层级', () => {
    expect(
      scan('{"content":"function f() {', ' return \\"}\\" }\\\\', '"', ',"k":[1,{"a":"]"}]', '}'),
    ).toEqual([false, false, false, false, true])
  })

  test('空白与空串不使其闭合', () => {
    expect(scan('', '  ', '{', '}')).toEqual([false, false, false, true])
  })
})
