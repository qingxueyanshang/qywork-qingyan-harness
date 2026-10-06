/**
 * 推理能力探测。
 *
 * 重点是「无法探测 ≠ 不支持」相关的用例。
 * 探测器的每条结论都必须来自实测：若将「客户端未发送该字段」记为「端点已接受」，
 * 探测器便会生成无依据的结论，并写回配置，覆盖目录中正确的保守值。
 */

import { describe, expect, test } from 'bun:test'
import { lookupModel } from './catalog.ts'
import { describeProbe, type ProbeOutcome, toTransportCapabilities } from './probe.ts'

function outcome(over: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    reachable: true,
    untested: [],
    inconclusive: [],
    effortSource: 'catalog',
    effortLevels: ['low', 'high'],
    thinkingObserved: true,
    probes: [],
    ...over,
  }
}

describe('只写回实际探测过的项', () => {
  test('官方档位在当前端点通过时只写透传结论', () => {
    expect(toTransportCapabilities(outcome())).toEqual({
      effort: true,
      effortLevels: ['low', 'high'],
    })
  })

  /**
   * 未探测则不写入。留空使目录中的保守默认值继续生效；
   * 写入「探针均通过」的空结论，会以无依据的值覆盖正确的值。
   */
  test('effort 未探测时不写入结论', () => {
    expect(toTransportCapabilities(outcome({ untested: ['effort'] }))).toEqual({})
  })

  test('effort 探测遇到临时失败时不写入 false', () => {
    expect(
      toTransportCapabilities(outcome({ effortLevels: [], inconclusive: ['effort'] })),
    ).toEqual({})
  })

  /** 请求接受情况不改写默认思考行为或其他模型事实。 */
  test('只写入端点接受的档位，不修改默认思考行为', () => {
    expect(toTransportCapabilities(outcome())).toEqual({
      effort: true,
      effortLevels: ['low', 'high'],
    })
  })

  /**
   * 端点不可达时，`thinkingObserved` 的 false 不是能力结论。
   * 写回会将「未完成测试」记为「测得模型不思考」。
   */
  test('端点不可达时不写入任何内容，此时的 false 是占位值而非结论', () => {
    expect(toTransportCapabilities(outcome({ reachable: false, thinkingObserved: false }))).toEqual(
      {},
    )
  })

  test('探测到当前端点拒绝 effort 时写入 false，不修改官方档位', () => {
    expect(toTransportCapabilities(outcome({ effortLevels: [] }))).toEqual({
      effort: false,
      effortLevels: [],
    })
  })
})

describe('报告须区分三种状态', () => {
  test('未探测的项标为 –，而非 ✓ 或 ✗', () => {
    const t = describeProbe(
      outcome({
        untested: ['effort'],
        probes: [{ name: 'effort', ok: false, skipped: true, detail: '不发该字段' }],
      }),
      'openai_chat_completions',
      'x',
    )
    expect(t).toContain('– effort')
    expect(t).toContain('未探测')
    expect(t).not.toContain('（不支持）')
  })

  test('实测不支持时显示「不支持」，而非「未探测」', () => {
    const t = describeProbe(outcome({ effortLevels: [] }), 'anthropic_messages', 'x')
    expect(t).toContain('（不支持）')
  })

  test('临时失败时显示未得出结论，不显示为不支持', () => {
    const t = describeProbe(
      outcome({
        effortLevels: [],
        inconclusive: ['effort'],
        probes: [{ name: 'effort=low', ok: false, inconclusive: true, detail: '连接超时' }],
      }),
      'openai_chat_completions',
      'x',
    )
    expect(t).toContain('? effort=low')
    expect(t).toContain('未确认')
    expect(t).not.toContain('（不支持）')
  })

  test('逐条列出原始探针，便于核查错误结论', () => {
    const t = describeProbe(
      outcome({
        probes: [
          { name: '最小请求', ok: true, detail: '接受' },
          { name: 'effort=max', ok: false, detail: '400 unsupported' },
        ],
      }),
      'anthropic_messages',
      'x',
    )
    expect(t).toContain('最小请求')
    expect(t).toContain('400 unsupported')
  })
})

describe('适配器如实声明是否发送 effort', () => {
  test('anthropic 发送', async () => {
    const { AnthropicAdapter } = await import('./providers/anthropic.ts')
    const a = new AnthropicAdapter(
      { kind: 'anthropic_messages', apiKey: 'sk-x', model: 'claude-opus-5' },
      lookupModel('claude-opus-5', 'anthropic_messages'),
    )
    expect(a.transmits).toEqual({ effort: true })
  })

  /**
   * 兼容协议下 effort 的字段名因厂商而异，但字段名是每个模型自身的属性，
   * 目录中已有记录（`thinking` 指明使用哪套字段）。一律不发送会使
   * GPT-5.6 / Gemini / Grok / Kimi / GLM 等具有档位的模型均无法调节档位。
   */
  test('openai_chat_completions 按参数格式发送 effort', async () => {
    const { OpenAICompatAdapter } = await import('./providers/openai-compat.ts')
    const a = new OpenAICompatAdapter(
      { kind: 'openai_chat_completions', apiKey: 'sk-x', model: 'deepseek-flash' },
      lookupModel('deepseek-flash', 'openai_chat_completions'),
    )
    expect(a.transmits).toEqual({ effort: true, video: true })
  })
})

/**
 * 本组断言完整链路：当前接口的探测结论 → 传输能力约束 → adapter。
 */
describe('探测结果实际影响请求装配', () => {
  test('当前端点拒绝时清空可用档位，但不修改官方模型档位', async () => {
    const { buildAdapter } = await import('./factory.ts')
    const base = {
      kind: 'openai_chat_completions' as const,
      apiKey: 'sk-x',
      model: 'deepseek-flash',
    }
    expect(buildAdapter(base).spec.effortLevels).toEqual(['low', 'high', 'max'])

    const probed = buildAdapter({
      ...base,
      transport: toTransportCapabilities(outcome({ effortLevels: [] })),
    })
    expect(probed.spec.effortLevels).toEqual([])
    expect(lookupModel(base.model, base.kind).effortLevels).toEqual(['low', 'high', 'max'])
  })

  test('端点通过时不为未收录模型增加无依据的档位', async () => {
    const { buildAdapter } = await import('./factory.ts')
    const adapter = buildAdapter({
      kind: 'openai_chat_completions',
      apiKey: 'sk-x',
      model: '某个中转站的模型',
      baseUrl: 'https://relay.example/v1',
      transport: { effort: true },
    })
    expect(adapter.spec.effortLevels).toEqual([])
  })
})
