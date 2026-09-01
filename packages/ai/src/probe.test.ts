/**
 * 推理能力探测。
 *
 * 这一组里最重要的是「无从探测 ≠ 不支持」那几条。
 * 探测器的价值全在于它报的每一条都是实测的——一旦把「客户端没发这个字段」
 * 算成「端点接受了」，它就从一个测量工具变成了一个凭空生成结论的工具，
 * 而那个结论会被写回配置去覆盖目录里正确的保守值。
 */

import { describe, expect, test } from 'bun:test'
import { lookupModel } from './catalog.ts'
import { describeProbe, type ProbeOutcome, toTransportCapabilities } from './probe.ts'

function outcome(over: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    reachable: true,
    untested: [],
    inconclusive: [],
    effortLevels: ['low', 'high'],
    thinksByDefault: true,
    probes: [],
    ...over,
  }
}

describe('只写回真的探过的轴', () => {
  test('官方档位在当前端点通过时只写透传结论', () => {
    expect(toTransportCapabilities(outcome())).toEqual({ effort: true })
  })

  /**
   * 没探过就不写。留空让目录里的保守默认值继续生效——
   * 写一个「探针都通过了」的空结论，会用凭空的值覆盖正确的值。
   */
  test('effort 没探过时不写结论', () => {
    expect(toTransportCapabilities(outcome({ untested: ['effort'] }))).toEqual({})
  })

  test('effort 探测遇到暂时失败时不写 false', () => {
    expect(
      toTransportCapabilities(outcome({ effortLevels: [], inconclusive: ['effort'] })),
    ).toEqual({})
  })

  /**
   * **思考参数的格式一个字都不写回。**
   *
   * 本项目从不请求思考形态，探针发的 body 与不发时一模一样，所以「端点接受了
   * adaptive」只是 `spec.thinking` 的回声。把回声写回覆盖层，会在 Responses 协议上
   * 把格式从 `reasoning_effort` 改成 `adaptive_only`，因此 effort 整片消失——
   * 校准一次思考，反而再也选不出档位。
   */
  test('写回里没有档位、默认行为或思考参数格式', () => {
    expect(toTransportCapabilities(outcome())).toEqual({ effort: true })
  })

  /**
   * 端点不通时 `thinksByDefault` 的那个 false 是占位不是观测。
   * 写回去会把「没测成」变成「测出来它不思考」。
   */
  test('端点不通时什么都不写 —— 那个 false 是占位不是结论', () => {
    expect(toTransportCapabilities(outcome({ reachable: false, thinksByDefault: false }))).toEqual(
      {},
    )
  })

  test('探出当前端点拒绝 effort 时写 false，不改官方档位', () => {
    expect(toTransportCapabilities(outcome({ effortLevels: [] }))).toEqual({ effort: false })
  })
})

describe('报告要能区分三种状态', () => {
  test('未探测的标 – 而不是 ✓ 或 ✗', () => {
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

  test('实测不支持时说「不支持」，不说「未探测」', () => {
    const t = describeProbe(outcome({ effortLevels: [] }), 'anthropic_messages', 'x')
    expect(t).toContain('（不支持）')
  })

  test('暂时失败显示未得出结论，不冒充不支持', () => {
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
    expect(t).toContain('未得出结论')
    expect(t).not.toContain('（不支持）')
  })

  test('原始探针逐条列出 —— 结论错了要能查', () => {
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

describe('适配器如实声明自己发不发 effort', () => {
  test('anthropic 发', async () => {
    const { AnthropicAdapter } = await import('./providers/anthropic.ts')
    const a = new AnthropicAdapter(
      { kind: 'anthropic_messages', apiKey: 'sk-x', model: 'claude-opus-5' },
      lookupModel('claude-opus-5', 'anthropic_messages'),
    )
    expect(a.transmits).toEqual({ effort: true })
  })

  /**
   * 兼容协议下 effort 的字段名各家不一，而那是**每个模型自己的属性**，
   * 目录里正好有（`thinking` 说用哪套字段）。一律不发的代价是
   * GPT-5.6 / Gemini / Grok / Kimi / GLM 这些真有档位的模型全都调不了。
   */
  test('openai_chat_completions 按参数格式发 effort', async () => {
    const { OpenAICompatAdapter } = await import('./providers/openai-compat.ts')
    const a = new OpenAICompatAdapter(
      { kind: 'openai_chat_completions', apiKey: 'sk-x', model: 'deepseek-v4-flash' },
      lookupModel('deepseek-v4-flash', 'openai_chat_completions'),
    )
    expect(a.transmits).toEqual({ effort: true, video: true })
  })
})

/**
 * 这一条断的是整链：当前接口的探测结论 → 传输否决闸 → adapter。
 */
describe('探测结果真的会影响请求装配', () => {
  test('当前端点拒绝时收起控制面，但不改官方模型档位', async () => {
    const { buildAdapter } = await import('./factory.ts')
    const base = {
      kind: 'openai_chat_completions' as const,
      apiKey: 'sk-x',
      model: 'deepseek-v4-flash',
    }
    expect(buildAdapter(base).spec.effortLevels).toEqual(['low', 'high', 'max'])

    const probed = buildAdapter({
      ...base,
      transport: toTransportCapabilities(outcome({ effortLevels: [] })),
    })
    expect(probed.spec.effortLevels).toEqual([])
    expect(lookupModel(base.model, base.kind).effortLevels).toEqual(['low', 'high', 'max'])
  })

  test('端点通过不能给未收录模型凭空增加档位', async () => {
    const { buildAdapter } = await import('./factory.ts')
    const adapter = buildAdapter({
      kind: 'openai_chat_completions',
      apiKey: 'sk-x',
      model: '某个中转站的模型',
      transport: { effort: true },
    })
    expect(adapter.spec.effortLevels).toEqual([])
  })
})
