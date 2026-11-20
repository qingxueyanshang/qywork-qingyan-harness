/**
 * 覆盖范围：`provider-edit.ts` 的 `withProviderPatch`、`carryBase`、`withoutCalibration`，以及 `pulled.ts` 的 `refreshPulled`
 * 在型号协议改变时的连带修改。
 */

import { describe, expect, test } from 'bun:test'
import type { RedactedConfig } from '../../lib/store/index.ts'
import { withProviderPatch } from './provider-edit.ts'
import { refreshPulled } from './pulled.ts'

const config = (): RedactedConfig =>
  ({
    providers: {
      relay: {
        kind: 'openai_chat_completions',
        baseUrl: 'https://relay.example/v1',
        hasApiKey: true,
        models: {
          'claude-opus-5-custom': {
            transport: { effort: false, toolCalls: { ok: true } as never },
          },
          'pinned-model': { kind: 'openai_responses', transport: { effort: false } },
        },
      },
    },
    catalog: {
      'claude-opus-5-custom|openai_chat_completions': { base: 'claude-opus-5', contextWindow: 9 },
    },
  }) as unknown as RedactedConfig

describe('修改接口的协议或地址', () => {
  /** 原始失败形状：改换协议后自定义名称的型号失去对应型号，窗口与单价按未收录型号计算，推理等级消失。 */
  test('协议改变：对应型号复制到新协议的键下，其余覆盖字段不复制；原键保留', () => {
    const next = withProviderPatch(config(), 'relay', { kind: 'anthropic_messages' })!
    expect(next.catalog?.['claude-opus-5-custom|anthropic_messages']).toEqual({
      base: 'claude-opus-5',
    })
    expect(next.catalog?.['claude-opus-5-custom|openai_chat_completions']).toEqual({
      base: 'claude-opus-5',
      contextWindow: 9,
    })
    // 单独声明了协议的型号不随接口的协议改变：检测结论保留，不复制对应型号。
    expect(next.providers.relay?.models['pinned-model']?.transport).toEqual({ effort: false })
  })

  /** 原始失败形状：经旧地址检测为「不传思考参数」后换到官方地址，推理等级仍被隐藏。 */
  test('地址改变：删除全部型号的思考参数检测结论，保留工具调用的检测记录', () => {
    const next = withProviderPatch(config(), 'relay', { baseUrl: 'https://api.example.com/v1' })!
    expect(next.providers.relay?.models['claude-opus-5-custom']?.transport).toEqual({
      toolCalls: { ok: true } as never,
    })
    expect(next.providers.relay?.models['pinned-model']?.transport).toBeUndefined()
    expect(next.catalog).toEqual(config().catalog)
  })

  test('其他字段改变时不修改型号与模型库覆盖', () => {
    const cur = config()
    const next = withProviderPatch(cur, 'relay', { hasApiKey: false })!
    expect(next.providers.relay?.models).toEqual(cur.providers.relay!.models)
    expect(next.catalog).toBe(cur.catalog)
    expect(withProviderPatch(cur, '不存在', { kind: 'anthropic_messages' })).toBeNull()
  })
})

describe('拉取刷新型号的协议', () => {
  test('型号的协议改变时复制对应型号并删除思考参数检测结论', () => {
    const next = refreshPulled(config(), 'relay', {
      source: 'models',
      models: [
        { id: 'claude-opus-5-custom', output: 'chat', kind: 'anthropic_messages', known: false },
        { id: 'pinned-model', output: 'chat', kind: 'openai_responses', known: false },
      ],
    } as never)!
    expect(next.catalog?.['claude-opus-5-custom|anthropic_messages']).toEqual({
      base: 'claude-opus-5',
    })
    expect(next.providers.relay?.models['claude-opus-5-custom']).toEqual({
      kind: 'anthropic_messages',
      transport: { toolCalls: { ok: true } as never },
    })
    expect(next.providers.relay?.models['pinned-model']?.transport).toEqual({ effort: false })
  })
})
