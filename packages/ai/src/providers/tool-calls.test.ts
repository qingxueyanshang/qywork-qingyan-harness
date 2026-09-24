/**
 * 覆盖 `providers/tool-calls.ts` 的 `collectToolCalls`：三种协议共用的工具调用收拢。
 *
 * 锁三件事：按序号排序；参数只接受 JSON 对象，其余一律挂 `argumentsError` 且
 * `arguments` 为 `{}`；名字缺失按协议报错。
 */

import { describe, expect, test } from 'bun:test'
import { ProviderError } from '../errors.ts'
import { collectToolCalls, type ToolCallSlot } from './tool-calls.ts'

function slots(...entries: [number, ToolCallSlot][]): Map<number, ToolCallSlot> {
  return new Map(entries)
}

describe('工具调用收拢', () => {
  test('按 provider 序号排序，对象参数原样交出', () => {
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

  test('空参数按无参数处理，不算错误', () => {
    expect(
      collectToolCalls(slots([0, { id: 'a', name: 'x', json: '  ' }]), 'anthropic_messages', 'm'),
    ).toEqual([{ id: 'a', name: 'x', arguments: {} }])
  })

  /** 合法 JSON 但不是对象的参数与解析失败同样处置：交下去会在执行链之外抛出。 */
  test('null、数组、标量与残缺 JSON 都挂原文，参数置空对象', () => {
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

  test('名字缺失按协议报错', () => {
    expect(() =>
      collectToolCalls(slots([0, { id: 'a', name: '', json: '{}' }]), 'openai_responses', 'm'),
    ).toThrow(ProviderError)
  })
})
