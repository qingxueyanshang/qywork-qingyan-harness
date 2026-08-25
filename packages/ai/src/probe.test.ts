/**
 * 推理能力探测。
 *
 * 这一组里最重要的是「无从探测 ≠ 不支持」那几条。
 * 探测器的价值全在于它报的每一条都是实测的——一旦把「客户端没发这个字段」
 * 算成「端点接受了」，它就从一个测量工具变成了一个凭空生成结论的工具，
 * 而那个结论会被写回配置去覆盖目录里正确的保守值。
 */

import { describe, expect, test } from 'bun:test'
import { applySpecOverride, effortIsTransmittable, lookupModel } from './catalog.ts'
import { describeProbe, type ProbeOutcome, toCapabilities } from './probe.ts'

function outcome(over: Partial<ProbeOutcome> = {}): ProbeOutcome {
  return {
    reachable: true,
    untested: [],
    effortLevels: ['low', 'high'],
    thinksByDefault: true,
    probes: [],
    ...over,
  }
}

describe('只写回真的探过的轴', () => {
  test('全探过就全写', () => {
    expect(toCapabilities(outcome())).toEqual({
      effortLevels: ['low', 'high'],
      thinksByDefault: true,
    })
  })

  /**
   * 没探过就不写。留空让目录里的保守默认值继续生效——
   * 写一个「探针都通过了」的空结论，会用凭空的值覆盖正确的值。
   */
  test('effort 没探过时不写 effortLevels', () => {
    expect(toCapabilities(outcome({ untested: ['effort'] })).effortLevels).toBeUndefined()
  })

  /**
   * `thinksByDefault` 不跟着 effort 轴一起丢。
   *
   * 它测的是**回包**——什么都不发，看端点自己吐不吐思考内容。这跟客户端
   * 在这条链路上发不发 effort 字段是两回事。绑在一起的后果在 DeepSeek 上
   * 就能看见：探针报了「省略字段时自己思考：是」，`--save` 却什么都不写，
   * 目录里那条错的 `thinksByDefault: false` 原样留着。
   */
  test('effort 轴没探过，thinksByDefault 照写 —— 它是从回包观测的', () => {
    const c = toCapabilities(outcome({ untested: ['effort'] }))
    expect(c.thinksByDefault).toBe(true)
    expect(c.effortLevels).toBeUndefined()
  })

  /**
   * **思考参数的格式一个字都不写回。**
   *
   * 本项目从不请求思考形态，探针发的 body 与不发时一模一样，所以「端点接受了
   * adaptive」只是 `spec.thinking` 的回声。把回声写回覆盖层，会在 Responses 协议上
   * 把格式从 `reasoning_effort` 改成 `adaptive_only`，因此 effort 整片消失——
   * 校准一次思考，反而再也选不出档位。
   */
  test('写回里没有思考参数格式这一项', () => {
    const spec = lookupModel('gemini-3.7-flash', 'openai_responses')
    expect(effortIsTransmittable(spec)).toBe(true)

    const after = applySpecOverride(spec, toCapabilities(outcome()))
    expect(after.thinking).toBe(spec.thinking)
    expect(effortIsTransmittable(after)).toBe(true)
  })

  /**
   * 端点不通时 `thinksByDefault` 的那个 false 是占位不是观测。
   * 写回去会把「没测成」变成「测出来它不思考」。
   */
  test('端点不通时什么都不写 —— 那个 false 是占位不是结论', () => {
    expect(toCapabilities(outcome({ reachable: false, thinksByDefault: false }))).toEqual({})
  })

  test('探出「不支持 effort」时写空数组，不是不写', () => {
    // 空数组是一条结论（实测每档都被拒），不写是「没测」。两者必须能区分。
    expect(toCapabilities(outcome({ effortLevels: [] })).effortLevels).toEqual([])
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
    expect(a.transmits).toEqual({ effort: true })
  })
})

/**
 * `toCapabilities` 的输出就是模型库那一条覆盖，中间不再有第二种形状。
 * 这一条断的是整链：探测结论 → 模型库 → adapter 手里的 spec。
 */
describe('探测结果真的会影响请求装配', () => {
  test('探测结论作为模型库那一条，覆盖目录里的猜测', async () => {
    const { buildAdapter } = await import('./factory.ts')
    const base = {
      kind: 'openai_chat_completions' as const,
      apiKey: 'sk-x',
      model: '某个中转站的模型',
    }
    expect(buildAdapter(base).spec.thinking).toBe('none')

    // 没有这一步，`qy probe --save` 就只是打印一份报告——探得再准也不影响任何请求。
    const probed = buildAdapter({
      ...base,
      spec: toCapabilities(outcome({ effortLevels: ['high'], thinksByDefault: true })),
    })
    expect(probed.spec.effortLevels).toEqual(['high'])
    expect(probed.spec.thinksByDefault).toBe(true)
    // 参数格式不在写回范围内：探测改不了「用哪套字段发」。
    expect(probed.spec.thinking).toBe('none')
  })
})
