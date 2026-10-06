/**
 * 模型目录。
 *
 * 目录中的每一个值都会**直接改变发出的请求**：
 * `thinking` 决定是否发送推理字段、`effortLevels` 决定是否发送 effort、
 * `pricing` 决定账单上的数值。任何一个值写错都不会报错，只会静默产生错误行为。
 *
 * 下文标注「实测」的取值均为 2026-08 对真实端点实际请求所得，而非依据文档填写。
 */

import { describe, expect, test } from 'bun:test'
import {
  applySpecOverride,
  applyTransportCapabilities,
  builtinCatalog,
  computeCost,
  effortIsTransmittable,
  lookupModel,
  priceAt,
  reasoningReplay,
} from './catalog.ts'

test('MiniMax 与阶跃星辰只收录当前型号，能力按已接通的协议声明', () => {
  const catalog = builtinCatalog()
  expect([...new Set(catalog.filter((m) => m.vendor === 'minimax').map((m) => m.id))]).toEqual([
    'MiniMax-M3.1-Flash-Preview',
    'MiniMax-M3',
  ])
  expect([...new Set(catalog.filter((m) => m.vendor === 'stepfun').map((m) => m.id))]).toEqual([
    'step-5-preview',
  ])
  for (const kind of [
    'openai_chat_completions',
    'openai_responses',
    'anthropic_messages',
  ] as const) {
    const minimax = lookupModel('MiniMax-M3.1-Flash-Preview', kind)
    expect(minimax).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 524_288,
      effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
      vision: true,
      video: kind === 'openai_chat_completions',
      thinksByDefault: true,
      pricing: {
        input: null,
        output: null,
        cacheRead: null,
        cacheWrite5m: null,
        cacheWrite1h: null,
      },
    })
    expect(minimax.pricing.note).toContain('M Plan')
    expect(computeCost(minimax, { inputTokens: 1_000_000, outputTokens: 1_000 })).toBe(0)
  }
  for (const kind of ['openai_chat_completions', 'anthropic_messages'] as const) {
    expect(lookupModel('step-5-preview', kind)).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      effortLevels: ['low', 'medium', 'high'],
      vision: true,
      video: kind === 'openai_chat_completions',
      thinksByDefault: true,
      pricing: { currency: 'CNY', input: 7, output: 20, cacheRead: 0.35, cacheWrite5m: 7 },
    })
  }
  expect(catalog.some((m) => m.id === 'step-5-preview' && m.provider === 'openai_responses')).toBe(
    false,
  )
})

/**
 * 逐协议锁定历史推理的发送规则：装配点裁剪与三个适配器的转换共用该规则，
 * 任何一项变化都会使本地估算与实际发送的字节不一致。
 */
test('历史推理发送规则按协议与目录声明', () => {
  const rule = (id: string, kind: Parameters<typeof lookupModel>[1]) =>
    reasoningReplay(lookupModel(id, kind))
  expect(rule('claude-opus-5-5', 'anthropic_messages')).toEqual({ opaque: true, text: 'none' })
  expect(rule('mimo-v2.6-pro', 'anthropic_messages')).toEqual({ opaque: true, text: 'all' })
  expect(rule('grok-4.7', 'openai_responses')).toEqual({ opaque: true, text: 'none' })
  expect(rule('gpt-6-sol', 'openai_responses')).toEqual({ opaque: false, text: 'none' })
  expect(rule('gpt-6.1-sol', 'openai_responses')).toEqual({ opaque: false, text: 'none' })
  expect(rule('deepseek-flash', 'openai_chat_completions')).toEqual({ opaque: false, text: 'all' })
  expect(rule('grok-4.7', 'openai_chat_completions')).toEqual({
    opaque: false,
    text: 'tool_turns',
  })
})

test('Claude Opus 5.5 的官方价格、缓存与恒开思考规格', () => {
  const opus = lookupModel('claude-opus-5-5', 'anthropic_messages')
  expect(opus).toMatchObject({
    provider: 'anthropic_messages',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    vision: true,
    thinking: 'always_on',
    thinksByDefault: true,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
    minCacheablePrefix: 512,
    pricing: { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  })
})

describe('模型库与端点校验的优先级', () => {
  const transport = {
    effort: true,
    effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
    thinking: 'reasoning_effort' as const,
  }
  const probed = () => ({ ...transport, effortLevels: [...transport.effortLevels] })
  test('旧探测名单不能扩大内置档位或覆盖参数格式', () => {
    const spec = applyTransportCapabilities(
      lookupModel('deepseek-flash', 'openai_chat_completions'),
      probed(),
    )
    expect(spec.effortLevels).toEqual(['low', 'high', 'max'])
    expect(spec.thinking).toBe('deepseek_thinking')
    expect(
      applyTransportCapabilities(lookupModel('claude-haiku-4-5', 'anthropic_messages'), probed())
        .effortLevels,
    ).toEqual([])
  })
  test('人工声明的档位（含空列表）与格式不被检测结果扩大', () => {
    const seed = lookupModel('custom', 'openai_chat_completions')
    expect(
      applyTransportCapabilities(seed, probed(), { effortLevels: ['high', 'max'] }).effortLevels,
    ).toEqual(['high', 'max'])
    const spec = applyTransportCapabilities(seed, probed(), {
      effortLevels: [],
      thinking: 'deepseek_thinking',
    })
    expect(spec.effortLevels).toEqual([])
    expect(spec.thinking).toBe('deepseek_thinking')
  })
  test('未知模型仅补录价格时，探测候选值仍然生效', () => {
    const spec = applyTransportCapabilities(
      lookupModel('custom', 'openai_chat_completions'),
      probed(),
      { input: 1 },
    )
    expect(spec.catalogued).toBe(true)
    expect(spec.effortLevels).toEqual([...transport.effortLevels])
    expect(spec.thinking).toBe('reasoning_effort')
  })
})

describe('DeepSeek 当前规格', () => {
  const before = Date.UTC(2026, 8, 10)
  const cutover = Date.UTC(2026, 8, 14, 4)
  test('正式目录只列 Flash 和 Pro，Flash 支持图片和三档思考', () => {
    for (const kind of [
      'openai_chat_completions',
      'openai_responses',
      'anthropic_messages',
    ] as const) {
      const models = builtinCatalog(before).filter(
        (m) => m.vendor === 'deepseek' && m.provider === kind,
      )
      expect(models.map((m) => m.id)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
      const flash = lookupModel('deepseek-flash', kind, before)
      expect(flash.vision).toBe(true)
      expect(flash.thinksByDefault).toBe(true)
      expect(flash.effortLevels).toEqual(['low', 'high', 'max'])
      expect(flash.contextWindow).toBe(1_000_000)
      expect(flash.maxOutputTokens).toBe(384_000)
    }
  })
  test('Chat 和 Responses 使用各自的思考控制参数', () => {
    expect(lookupModel('deepseek-flash', 'openai_chat_completions').thinking).toBe(
      'deepseek_thinking',
    )
    const responses = lookupModel('deepseek-flash', 'openai_responses')
    expect(responses.thinking).toBe('reasoning_effort')
    expect(responses.reasoningEcho).toBe('reasoning_text')
    expect(responses.cacheRouting).toBe('none')
  })
  test('Pro 在原定下线日期前后均保持独立价格与文本能力', () => {
    for (const kind of [
      'openai_chat_completions',
      'openai_responses',
      'anthropic_messages',
    ] as const) {
      for (const now of [cutover - 1, cutover, Date.UTC(2026, 9, 1)]) {
        const pro = lookupModel('deepseek-v4-pro', kind, now)
        expect(pro.vision).toBe(false)
        expect(pro.pricing).toMatchObject({ input: 9, output: 27, cacheRead: 0.3 })
        expect(pro.pricing).not.toEqual(lookupModel('deepseek-flash', kind, now).pricing)
      }
      const pro = lookupModel('deepseek-v4-pro', kind)
      expect(priceAt(pro, { now: Date.UTC(2026, 8, 15, 2) })).toMatchObject({
        input: 9,
        output: 27,
        cacheRead: 0.3,
      })
      expect(priceAt(pro, { now: Date.UTC(2026, 8, 15, 12) })).toMatchObject({
        input: 4.5,
        output: 13.5,
        cacheRead: 0.15,
      })
    }
  })
  test('Haiku 的预算模式不声明 effort 档位', () => {
    expect(lookupModel('claude-haiku-4-5', 'anthropic_messages').effortLevels).toEqual([])
  })
})

describe('MiMo 官方模型映射', () => {
  for (const kind of [
    'openai_chat_completions',
    'openai_responses',
    'anthropic_messages',
  ] as const) {
    test(`${kind} 按协议收录三款模型，思考开关不作为强度档位`, () => {
      for (const id of ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'mimo-v2.6-pro-ultraspeed']) {
        const m = lookupModel(id, kind)
        expect(builtinCatalog().filter((s) => s.id === id && s.provider === kind)).toHaveLength(1)
        expect(m).toMatchObject({
          vendor: 'xiaomi',
          provider: kind,
          contextWindow: 1_000_000,
          maxOutputTokens: 131_072,
          vision: true,
          video: false,
          thinksByDefault: true,
          effortLevels: [],
          chatReasoningProtocol: 'preserved',
          cacheRouting: 'none',
          reasoningEcho: kind === 'openai_responses' ? 'reasoning_text' : 'none',
        })
        expect(m.catalogued).not.toBe(false)
        const effective = applyTransportCapabilities(m, {
          effort: true,
          effortLevels: ['low', 'high', 'max'],
          thinking: 'reasoning_effort',
        })
        expect(effective.effortLevels).toEqual([])
        expect(effortIsTransmittable(effective)).toBe(false)
      }
    })
  }

  test('国内按量价格进入费用计算，缓存输入不重复计费', () => {
    for (const [id, cost] of [
      ['mimo-v2.6-pro', 9.025],
      ['mimo-v2.6-flash', 3.02],
      ['mimo-v2.6-pro-ultraspeed', 90.25],
    ] as const) {
      const m = lookupModel(id, 'openai_responses')
      expect(m.pricing.currency).toBe('CNY')
      expect(
        computeCost(m, {
          inputTokens: 1_000_000,
          outputTokens: 1_000_000,
          cachedTokens: 1_000_000,
        }),
      ).toBeCloseTo(cost)
    }
  })
})

describe('provider 不符时的回退处理', () => {
  /**
   * 经中转站以兼容协议调用 Claude 是实际存在的配置：保留能力约束，改写 provider。
   * 但这**只是回退处理**：条目描述的是另一种协议下的行为，需要准确时须单独建立条目。
   */
  test('目录中没有该协议的条目时，保留能力并改写 provider', () => {
    const spec = lookupModel('claude-opus-5', 'openai_chat_completions')
    expect(spec.provider).toBe('openai_chat_completions')
    expect(spec.contextWindow).toBe(
      lookupModel('claude-opus-5', 'anthropic_messages').contextWindow,
    )
  })

  /** 完全未收录的模型使用保守默认值，计价为 0：前端显示「未知计价」，而不是一个错误的数值。 */
  test('未知模型不编造计价', () => {
    const spec = lookupModel('明天才发布的模型', 'anthropic_messages')
    expect(spec.pricing.input).toBe(0)
    expect(spec.thinking).toBe('none')
    expect(spec.effortLevels).toEqual([])
  })
})

describe('计价', () => {
  /**
   * DeepSeek 的 `input` 为**缓存未命中**单价，命中部分按 cacheRead 计价。
   * 两者不能重复计费：适配器已将用量归一为互斥口径。
   */
  test('缓存命中按 cacheRead 计价，不重复计入 input', () => {
    const spec = lookupModel('deepseek-flash', 'openai_responses')
    const withCache = computeCost(spec, { inputTokens: 100, outputTokens: 0, cachedTokens: 900 })
    const withoutCache = computeCost(spec, { inputTokens: 1000, outputTokens: 0, cachedTokens: 0 })
    // 同为一千个输入 token，大部分命中缓存时费用明显更低。两者相等则说明缓存未按折扣计价。
    expect(withCache).toBeLessThan(withoutCache)
  })
})

/**
 * 模型库中修改过的参数。
 *
 * 本组锁定**修改确实进入请求与账本**：若只提供可编辑的界面而修改不影响
 * 任何调用，即构成一条有生产者而没有消费者的链路。
 */
describe('模型库覆盖', () => {
  const opus = () => lookupModel('claude-opus-5', 'anthropic_messages')

  test('未知模型可显式声明完整历史思考回放', () => {
    const spec = applySpecOverride(lookupModel('custom', 'openai_chat_completions'), {
      thinking: 'deepseek_thinking',
      effortLevels: ['low', 'high', 'max'],
      chatReasoningProtocol: 'deepseek_preserved',
    })
    expect(spec.chatReasoningProtocol).toBe('deepseek_preserved')
    expect(spec.effortLevels).toEqual(['low', 'high', 'max'])
  })

  test('只覆盖已填写的字段，未填写的沿用 seed', () => {
    const s = applySpecOverride(opus(), { contextWindow: 200_000 })
    expect(s.contextWindow).toBe(200_000)
    expect(s.maxOutputTokens).toBe(opus().maxOutputTokens)
    expect(s.pricing.input).toBe(opus().pricing.input)
  })

  /**
   * 缓存价格沿用 seed，**不按 input 等比例推算**。
   * 各家缓存定价的比例不同（Anthropic 写入为 1.25x，DeepSeek 写入免费），
   * 推算结果是看似精确的错误数值。
   */
  test('修改单价不改变缓存价格', () => {
    const s = applySpecOverride(opus(), { input: 99 })
    expect(s.pricing.input).toBe(99)
    expect(s.pricing.cacheRead).toBe(opus().pricing.cacheRead)
    expect(s.pricing.cacheWrite5m).toBe(opus().pricing.cacheWrite5m)
  })

  test('修改后的价格直接计入账本', () => {
    const s = applySpecOverride(opus(), { input: 100, output: 200 })
    const cost = computeCost(s, { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(cost).toBe(300)
  })

  /**
   * 未收录的模型须由用户填写单价才视为已收录。
   *
   * 仅修改显示名称就置为 true 时，计价仍为 0 而「未收录」提醒消失：
   * 账本继续记录 $0，且不再有任何提示。
   */
  test('填写单价才视为收录，仅修改名称不算', () => {
    const unknown = lookupModel('中转站上的某个模型', 'openai_chat_completions')
    expect(unknown.catalogued).toBe(false)
    expect(applySpecOverride(unknown, { displayName: '某个模型' }).catalogued).toBe(false)
    expect(applySpecOverride(unknown, { input: 1, output: 2 }).catalogued).toBe(true)
  })

  /**
   * 未收录模型的窗口默认值。
   *
   * 锁定的是**取值方向**而不是具体数值：取值偏小会使每轮提前压缩，既增加费用又丢失上下文，
   * 且完全静默，不会有任何位置报告压缩过早。
   */
  test('未收录模型的窗口默认为 500K，且可由模型库字段覆盖', () => {
    const unknown = lookupModel('中转站上的某个模型', 'openai_chat_completions')
    expect(unknown.contextWindow).toBe(500_000)
    expect(applySpecOverride(unknown, { contextWindow: 1_000_000 }).contextWindow).toBe(1_000_000)
  })

  test('不传覆盖时原样返回', () => {
    expect(applySpecOverride(opus(), undefined)).toEqual(opus())
  })

  /**
   * 思考三项同样存于模型库。若只存于接口配置中，界面上既不显示也无法修改，
   * 模型库显示的值与实际发送的值会不一致。
   */
  test('思考三项覆盖 seed', () => {
    const s = applySpecOverride(lookupModel('中转站上的某个模型', 'openai_chat_completions'), {
      thinking: 'reasoning_effort',
      effortLevels: ['low', 'high'],
      thinksByDefault: true,
    })
    expect(s.thinking).toBe('reasoning_effort')
    expect(s.effortLevels).toEqual(['low', 'high'])
    expect(s.thinksByDefault).toBe(true)
  })

  /** `false` 是有效覆盖：按 falsy 判定缺省时，「模型默认不思考」这一实测结果无法写入。 */
  test('thinksByDefault 填写 false 同样视为覆盖', () => {
    expect(applySpecOverride(opus(), { thinksByDefault: false }).thinksByDefault).toBe(false)
    expect(applySpecOverride(opus(), {}).thinksByDefault).toBe(opus().thinksByDefault)
  })

  /**
   * 中转站将接受图片的模型配置在自定义名称下时，该字段是唯一的设置入口：
   * 目录无法识别该名称，取值为 `null`（不裁决）。反之，
   * 中转站的某条链路不接受图片时，填写 `false` 即可拦截。
   */
  test('vision 三态均可覆盖，false 不被视为缺省', () => {
    const unknown = lookupModel('中转站上的某个模型', 'openai_chat_completions')
    expect(unknown.vision).toBeNull()
    expect(applySpecOverride(unknown, { vision: true }).vision).toBe(true)
    expect(applySpecOverride(opus(), { vision: false }).vision).toBe(false)
    expect(applySpecOverride(opus(), {}).vision).toBe(opus().vision)
  })
})

/**
 * 图片输入能力。
 *
 * 三态的含义：`null` 表示厂商规格页未写明，门控按放行处理；
 * 只有 `false` 会使 `agent` 将图像块替换为文本注记，并使界面隐藏图片入口。
 * 将 `null` 合并为 `false` 时，一批实际接受图片的中转站模型会被拦截。
 */
describe('图片输入', () => {
  test('未收录模型不裁决', () => {
    expect(lookupModel('中转站上的某个模型', 'openai_chat_completions').vision).toBeNull()
  })

  /** 按厂商规格页逐条填写，不按 id 前缀推断：同一厂商的两个型号可能取值相反。 */
  test('按规格页填写：同一厂商的两个型号取值相反', () => {
    expect(lookupModel('glm-5.3', 'openai_chat_completions').vision).toBe(false)
    expect(lookupModel('glm-5.3-flash', 'openai_chat_completions').vision).toBe(true)
    expect(lookupModel('qwen3.7-max', 'openai_chat_completions').vision).toBe(false)
    expect(lookupModel('qwen3.7-plus', 'openai_chat_completions').vision).toBe(true)
    expect(lookupModel('qwen3.7-max', 'openai_chat_completions').video).toBe(false)
    expect(lookupModel('qwen3.7-plus', 'openai_chat_completions').video).toBe(true)
    expect(lookupModel('中转站上的某个模型', 'openai_chat_completions').video).toBe(false)
  })
})

describe('输出上限说明', () => {
  /** 官方文本以 Claude 自称，发给其他厂商的模型等于要求其扮演另一个模型。 */
  test('只有 Anthropic 的条目开启，经兼容协议调用 Claude 时同样携带', () => {
    for (const spec of builtinCatalog()) {
      expect(spec.outputLimitNote === true).toBe(spec.vendor === 'anthropic')
    }
    expect(lookupModel('claude-opus-5-5', 'openai_chat_completions').outputLimitNote).toBe(true)
    expect(
      lookupModel('中转站上的某个模型', 'openai_chat_completions').outputLimitNote,
    ).toBeUndefined()
  })
})

describe('视频输入', () => {
  test('完整内置目录只放行官方协议与当前适配器都支持的模型', () => {
    const supported = builtinCatalog()
      .filter((spec) => spec.video)
      .map((spec) => `${spec.provider}:${spec.id}`)
      .sort()

    expect(supported).toEqual(
      [
        'openai_chat_completions:MiniMax-M3',
        'openai_chat_completions:MiniMax-M3.1-Flash-Preview',
        'openai_chat_completions:glm-4.6v',
        'openai_chat_completions:glm-5.3-flash',
        'openai_chat_completions:glm-5.3-flashx',
        'openai_chat_completions:glm-5v-turbo',
        'openai_chat_completions:kimi-k3',
        'openai_chat_completions:qwen3-vl-flash',
        'openai_chat_completions:qwen3-vl-plus',
        'openai_chat_completions:qwen3.7-flash',
        'openai_chat_completions:qwen3.7-plus',
        'openai_chat_completions:qwen3.8-flash',
        'openai_chat_completions:qwen3.8-max',
        'openai_chat_completions:qwen3.8-omni-flash',
        'openai_chat_completions:step-5-preview',
      ].sort(),
    )
  })

  test('原生模型支持但当前协议未接通时仍不放行', () => {
    expect(lookupModel('gemini-3.8-flash', 'openai_chat_completions').video).toBe(false)
    expect(lookupModel('gemini-3.7-flash', 'openai_chat_completions').video).toBe(false)
    expect(lookupModel('gpt-5.6-sol', 'openai_chat_completions').video).toBe(false)
    expect(lookupModel('claude-opus-5', 'anthropic_messages').video).toBe(false)
    expect(lookupModel('deepseek-flash', 'openai_chat_completions').video).toBe(false)
    expect(lookupModel('中转站上的某个模型', 'openai_chat_completions').video).toBe(false)
  })
})

/**
 * DeepSeek 的分时段定价。
 *
 * 口径来源：官方「模型 & 价格」页 2026-08-17 生效的版本：
 * 高峰＝北京时间周一至周五 9:00-12:00、14:00-18:00（UTC 01:00-04:00、06:00-10:00），
 * 空闲价恰为高峰价的一半。
 *
 * 本组针对两类易错且**完全静默**的问题：按本机时区判定档位，以及基准价填反
 * （基准价填为空闲价时，高峰时段少记一半费用，账本金额偏低）。
 */
describe('分时段定价', () => {
  const flash = () => lookupModel('deepseek-flash', 'openai_chat_completions')
  /** 2026-09-08（周二）的指定时刻。星期同样参与档位判定，因此日期不能随意更换。 */
  const at = (utcHour: number, utcMinute = 0) => Date.UTC(2026, 8, 8, utcHour, utcMinute)

  test('目录中填写高峰价，币种为人民币', () => {
    const p = flash().pricing
    expect(p.currency).toBe('CNY')
    expect(p.input).toBe(2)
    expect(p.output).toBe(8)
    expect(p.cacheRead).toBe(0.04)
    // 自动前缀缓存，写入不收费。
    expect(p.cacheWrite5m).toBe(0)
  })

  test('高峰时段按原价', () => {
    // 北京时间 10:00 = UTC 02:00，位于第一段高峰内。
    expect(priceAt(flash(), { now: at(2) }).output).toBe(8)
    // 北京时间 15:00 = UTC 07:00，位于第二段高峰内。
    expect(priceAt(flash(), { now: at(7) }).output).toBe(8)
  })

  test('空闲时段五折，适用于每一项单价', () => {
    // 北京时间 13:00 = UTC 05:00，位于两段高峰之间。
    const p = priceAt(flash(), { now: at(5) })
    expect(p.input).toBe(1)
    expect(p.output).toBe(4)
    expect(p.cacheRead).toBe(0.02)
  })

  /** 半开区间：起点属于高峰，终点不属于。边界偏差一小时即导致费用相差一倍。 */
  test('窗口边界是左闭右开', () => {
    expect(priceAt(flash(), { now: at(1) }).output).toBe(8) // 北京 9:00 整，高峰第一分钟
    expect(priceAt(flash(), { now: at(0, 59) }).output).toBe(4) // 北京 8:59，高峰未开始
    expect(priceAt(flash(), { now: at(4) }).output).toBe(4) // 北京 12:00 整，高峰已结束
    expect(priceAt(flash(), { now: at(3, 59) }).output).toBe(8) // 北京 11:59，仍在高峰内
  })

  /**
   * 星期维度：仅周一至周五有高峰，周六、周日全天为空闲时段。
   *
   * 只按小时判定时，周末落在两段窗口内的请求会按原价记录，账本金额偏高，
   * 且没有任何位置报错。四条断言锁定星期集合的两端。
   */
  test('高峰只在周一至周五', () => {
    const hour = (day: number, utcHour: number) => Date.UTC(2026, 7, day, utcHour)
    expect(priceAt(flash(), { now: hour(22, 2) }).output).toBe(4) // 周六，第一段窗口内
    expect(priceAt(flash(), { now: hour(23, 7) }).output).toBe(4) // 周日，第二段窗口内
    expect(priceAt(flash(), { now: hour(17, 2) }).output).toBe(8) // 周一，在高峰内
    expect(priceAt(flash(), { now: hour(21, 7) }).output).toBe(8) // 周五，在高峰内
  })

  /**
   * **按 UTC 判定，不按本机时区。**
   *
   * 使用 `getHours()` 时按本机所在时区判定档位：在美国运行会全天
   * 计价错误，错误只体现为账本上的数值，任何位置都不会报错。
   * 本断言仅在实现使用 `getUTCHours()` 时成立。
   */
  test('档位判定只依据 UTC', () => {
    const utcNoon = Date.UTC(2026, 7, 18, 12, 0) // UTC 12:00 = 北京 20:00，空闲
    expect(priceAt(flash(), { now: utcNoon }).output).toBe(4)
  })

  test('没有分时段的模型原样返回，不新建对象', () => {
    const opus = lookupModel('claude-opus-5', 'anthropic_messages')
    expect(priceAt(opus, { now: at(2) })).toBe(opus.pricing)
  })

  test('计费按计费时刻取价', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(computeCost(flash(), usage, at(2))).toBe(10) // 高峰 2 + 8
    expect(computeCost(flash(), usage, at(5))).toBe(5) // 空闲 1 + 4
  })

  test('v4-pro 的两档', () => {
    const pro = lookupModel('deepseek-v4-pro', 'openai_chat_completions', Date.UTC(2026, 8, 10))
    expect(pro.pricing.input).toBe(9)
    expect(pro.pricing.output).toBe(27)
    expect(priceAt(pro, { now: at(5) }).input).toBe(4.5)
    expect(priceAt(pro, { now: at(5) }).output).toBe(13.5)
  })
})

/**
 * Grok 的长上下文阶梯价。
 *
 * 口径来源：xAI 官方价目表。grok-4.5 与 4.6 均为 500K 窗口，
 * 提示词达到 20 万 token 后**整条请求**价格翻倍。
 *
 * 本组针对整条请求翻倍的规则：按超出部分计算会少记将近一半费用，
 * 且少记不会触发任何报错。
 */
describe('长上下文阶梯价', () => {
  const g46 = () => lookupModel('grok-4.6', 'openai_chat_completions')
  const g45 = () => lookupModel('grok-4.5', 'openai_chat_completions')

  test('目录中填写标准价（<200K 档）', () => {
    expect(g46().pricing.input).toBe(2)
    expect(g46().pricing.output).toBe(6)
    expect(g46().pricing.cacheRead).toBe(0.5)
    // 4.5 的缓存价是 $0.30，不是 $0.20。
    expect(g45().pricing.cacheRead).toBe(0.3)
  })

  test('未达阈值时按标准价', () => {
    expect(priceAt(g46(), { promptTokens: 199_999 }).output).toBe(6)
  })

  test('达到阈值时每一项单价均翻倍', () => {
    const p = priceAt(g46(), { promptTokens: 200_000 })
    expect(p.input).toBe(4)
    expect(p.output).toBe(12)
    expect(p.cacheRead).toBe(1)
    const p45 = priceAt(g45(), { promptTokens: 200_000 })
    expect(p45.cacheRead).toBe(0.6)
  })

  /**
   * **整条请求翻倍，不是只对超出部分翻倍。**
   *
   * 21 万 token 的提示词不按「20 万按标准价 + 1 万按高价」计算。按超出部分计算时
   * 本断言得到约 0.42 而不是 0.84，相差将近一半，且完全静默。
   */
  test('整条请求切换价格档，不只对超出部分切换', () => {
    const cost = computeCost(g46(), { inputTokens: 210_000, outputTokens: 0 })
    expect(cost).toBeCloseTo((210_000 * 4) / 1e6, 9)
  })

  /** 阈值比较的是**提示词**（未命中 + 命中），输出不参与：厂商同样按提示词分档。 */
  test('阈值只计提示词，缓存命中部分同样计入', () => {
    const under = computeCost(g46(), { inputTokens: 100_000, outputTokens: 500_000 })
    expect(under).toBeCloseTo((100_000 * 2 + 500_000 * 6) / 1e6, 9)
    // 未命中 12 万 + 命中 8 万 = 20 万，达到阈值。
    const over = priceAt(g46(), { promptTokens: 120_000 + 80_000 })
    expect(over.input).toBe(4)
  })

  test('没有阶梯价的模型不受影响', () => {
    const opus = lookupModel('claude-opus-5', 'anthropic_messages')
    expect(priceAt(opus, { promptTokens: 900_000 })).toBe(opus.pricing)
  })

  /**
   * **各家的倍率不统一**：xAI 统一为 2 倍，Google 输入为 2 倍、输出仅为 1.5 倍。
   * 存储单一倍率相乘会将 Gemini 的输出算成 $24 而不是 $18。
   */
  test('高档单价按价目表逐项填写，不按倍率推算', () => {
    const pro = lookupModel('gemini-3.1-pro-preview', 'openai_chat_completions')
    expect(pro.pricing.output).toBe(12)
    const long = priceAt(pro, { promptTokens: 200_001 })
    expect(long.input).toBe(4) // 2 倍
    expect(long.output).toBe(18) // 1.5 倍，不是 24
    expect(long.cacheRead).toBe(0.4)
  })

  test('GPT-6 Astra 按含缓存的输入总量切换整条请求的价格', () => {
    const astra = lookupModel('gpt-6-astra', 'openai_responses')
    const usage = {
      inputTokens: 100_000,
      cachedTokens: 100_000,
      cacheWriteTokens: 72_000,
      outputTokens: 10_000,
    }
    expect(computeCost(astra, usage)).toBe(2.5)
    expect(computeCost(astra, { ...usage, cacheWriteTokens: 72_001 })).toBe(4.750025)
  })

  test('GPT-6 Sol、GPT-6.1 Sol 与 Luna 在 272K 边界切换完整计费档', () => {
    for (const [id, short, long] of [
      ['gpt-6-sol', [2, 10, 0.2, 2.5], [4, 15, 0.4, 5]],
      ['gpt-6.1-sol', [2, 10, 0.1, 2.5], [4, 15, 0.2, 5]],
      ['gpt-6-luna', [0.1, 0.5, 0.01, 0.125], [0.2, 0.75, 0.02, 0.25]],
    ] as const) {
      const model = lookupModel(id, 'openai_responses')
      expect(model.provider).toBe('openai_responses')
      expect(model.contextWindow).toBe(1_050_000)
      expect(model.maxOutputTokens).toBe(128_000)
      expect(model.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
      const before = priceAt(model, { promptTokens: 272_000 })
      const after = priceAt(model, { promptTokens: 272_001 })
      expect([before.input, before.output, before.cacheRead, before.cacheWrite5m]).toEqual([
        ...short,
      ])
      expect([after.input, after.output, after.cacheRead, after.cacheWrite5m]).toEqual([...long])
      expect(before.cacheWrite1h).toBe(short[3])
      expect(after.cacheWrite1h).toBe(long[3])
    }
  })

  test('GPT-6.1 Sol 的缓存读写计入 272K 分界，整条请求按新缓存价格计费', () => {
    const sol = lookupModel('gpt-6.1-sol', 'openai_responses')
    const usage = {
      inputTokens: 100_000,
      cachedTokens: 100_000,
      cacheWriteTokens: 72_000,
      outputTokens: 10_000,
    }
    expect(computeCost(sol, usage)).toBeCloseTo(0.49, 10)
    expect(computeCost(sol, { ...usage, cacheWriteTokens: 72_001 })).toBeCloseTo(0.930005, 10)
  })

  test('GPT-5.6 长上下文档的缓存写入价同步切换', () => {
    const sol = lookupModel('gpt-5.6-sol', 'openai_chat_completions')
    expect(priceAt(sol, { promptTokens: 272_000 }).cacheWrite5m).toBe(5)
    const long = priceAt(sol, { promptTokens: 272_001 })
    expect(long.input).toBe(8)
    expect(long.output).toBe(30)
    expect(long.cacheRead).toBe(0.8)
    expect(long.cacheWrite5m).toBe(10)
  })

  test('MiniMax M3 以 512K 为价格分界', () => {
    const m3 = lookupModel('MiniMax-M3', 'openai_chat_completions')
    expect(priceAt(m3, { promptTokens: 524_288 }).input).toBe(0.3)
    expect(priceAt(m3, { promptTokens: 524_289 }).input).toBe(0.6)
  })

  test('GLM-4.7 国内站按输入与输出双轴换档', () => {
    const glm = lookupModel('glm-4.7', 'openai_chat_completions')
    expect(priceAt(glm, { promptTokens: 31_999, outputTokens: 199 }).output).toBe(8)
    expect(priceAt(glm, { promptTokens: 31_999, outputTokens: 200 }).output).toBe(14)
    // 输入满 32K 后第三档优先，不再取「短输入、长输出」的第二档。
    const long = priceAt(glm, { promptTokens: 32_000, outputTokens: 200 })
    expect(long.input).toBe(4)
    expect(long.output).toBe(16)
    expect(long.cacheRead).toBe(0.8)
  })

  test('GLM 视觉模型的国内站 32K 档进入真实计费', () => {
    const turbo = lookupModel('glm-5v-turbo', 'openai_chat_completions')
    expect(priceAt(turbo, { promptTokens: 31_999 }).output).toBe(22)
    expect(priceAt(turbo, { promptTokens: 32_000 }).output).toBe(26)
    const v46 = lookupModel('glm-4.6v', 'openai_chat_completions')
    expect(priceAt(v46, { promptTokens: 32_000 }).cacheRead).toBe(0.4)
    expect(computeCost(v46, { inputTokens: 32_000, outputTokens: 1_000 })).toBe(0.07)
  })

  /** Google 标注为「>200k」，xAI 标注为「≥200k」，边界相差一个 token。 */
  test('两家的阈值边界各自按官方写法判定', () => {
    const pro = lookupModel('gemini-3.1-pro-preview', 'openai_chat_completions')
    expect(priceAt(pro, { promptTokens: 200_000 }).output).toBe(12)
    expect(priceAt(pro, { promptTokens: 200_001 }).output).toBe(18)
    expect(priceAt(g46(), { promptTokens: 200_000 }).output).toBe(12)
  })

  /**
   * 三档阶梯的模型：取**达到的最高一档**，而不是第一条命中的档位。
   *
   * 只保留一档时，中间区段与最长区段必有一段计价错误，且两种错误均不报错。
   */
  test('三档阶梯逐档切换', () => {
    const flash = lookupModel('qwen3.7-flash', 'openai_chat_completions')
    expect(priceAt(flash, { promptTokens: 32_000 }).input).toBe(0.2)
    expect(priceAt(flash, { promptTokens: 32_001 }).input).toBe(0.6)
    expect(priceAt(flash, { promptTokens: 256_000 }).input).toBe(0.6)
    expect(priceAt(flash, { promptTokens: 256_001 }).input).toBe(1.2)
    expect(priceAt(flash, { promptTokens: 900_000 }).output).toBe(4.8)
  })

  test('Qwen3-VL 两款都按官方 32K / 128K 三档计价', () => {
    const plus = lookupModel('qwen3-vl-plus', 'openai_chat_completions')
    expect(priceAt(plus, { promptTokens: 32_000 }).output).toBe(10)
    expect(priceAt(plus, { promptTokens: 32_001 }).output).toBe(15)
    expect(priceAt(plus, { promptTokens: 128_001 }).output).toBe(30)

    const flash = lookupModel('qwen3-vl-flash', 'openai_chat_completions')
    expect(priceAt(flash, { promptTokens: 32_001 }).input).toBe(0.3)
    expect(priceAt(flash, { promptTokens: 128_001 }).input).toBe(0.6)
  })
})

/**
 * 已逐条与官方页面核对的数值。
 *
 * 本组不测试机制，只锁定**取值**：写错一个数值不会报错，只会使账本静默出错，
 * 而账本正是用于查明费用变化原因的记录。
 */
describe('目录中的价格与档位', () => {
  const spec = (
    id: string,
    kind: 'anthropic_messages' | 'openai_chat_completions' = 'openai_chat_completions',
  ) => lookupModel(id, kind)

  test('OpenAI GPT-5.6 三档 + Cyber', () => {
    expect(spec('gpt-5.6-sol').pricing.input).toBe(4)
    expect(spec('gpt-5.6-sol').pricing.output).toBe(20)
    // terra 不是 2.5/15，luna 不是 1/6。
    expect(spec('gpt-5.6-terra').pricing.input).toBe(2)
    expect(spec('gpt-5.6-terra').pricing.output).toBe(12)
    expect(spec('gpt-5.6-luna').pricing.input).toBe(0.2)
    expect(spec('gpt-5.6-luna').pricing.output).toBe(1.2)
    expect(spec('gpt-5.6-cyber').pricing.output).toBe(75)
    // 官方模型页标注为 1.05M，不是 1M。
    expect(spec('gpt-5.6-sol').contextWindow).toBe(1_050_000)
    expect(spec('gpt-5.6-cyber').contextWindow).toBe(400_000)
  })

  test('Gemini 3.8 Flash 的规格、档位与促销价逐项与官方模型页一致', () => {
    const flash = spec('gemini-3.8-flash')
    expect(flash.displayName).toBe('Gemini 3.8 Flash')
    expect(flash.vendor).toBe('google')
    expect(flash.contextWindow).toBe(1_048_576)
    expect(flash.maxOutputTokens).toBe(65_536)
    expect(flash.vision).toBe(true)
    expect(flash.video).toBe(false)
    expect(flash.thinking).toBe('reasoning_effort')
    expect(flash.thinksByDefault).toBe(true)
    expect(flash.effortLevels).toEqual(['low', 'medium', 'high'])
    expect(flash.pricing).toMatchObject({ input: 0.75, output: 3.75, cacheRead: 0.075 })
  })

  test('Gemini Flash 三代促销价相同，3.5 价格更高', () => {
    // 四个型号均不是 0.3/2.5。
    expect(spec('gemini-3.8-flash').pricing.output).toBe(3.75)
    expect(spec('gemini-3.7-flash').pricing.output).toBe(3.75)
    expect(spec('gemini-3.6-flash').pricing.output).toBe(3.75)
    expect(spec('gemini-3.5-flash').pricing.input).toBe(1.5)
    expect(spec('gemini-3.5-flash').pricing.output).toBe(9)
    expect(spec('gemini-3.6-flash').effortLevels).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(spec('gemini-3.7-flash').contextWindow).toBe(1_048_576)
    expect(spec('gemini-3.7-flash').maxOutputTokens).toBe(65_536)
  })

  test('Gemini 3.8 Flash 在促销结束后恢复标准价', () => {
    const pricing = lookupModel(
      'gemini-3.8-flash',
      'openai_chat_completions',
      Date.UTC(2027, 0, 1),
    ).pricing
    expect(pricing).toMatchObject({ input: 1.5, output: 7.5, cacheRead: 0.15 })
  })

  test('Grok 的档位：4.6 有 xhigh，4.5 没有，均没有 max', () => {
    expect(spec('grok-4.6').effortLevels).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(spec('grok-4.5').effortLevels).toEqual(['low', 'medium', 'high'])
  })

  test('Grok 使用 xAI 原生工具 schema 与 Chat Completions 缓存请求头', () => {
    for (const model of ['grok-4.6', 'grok-4.5']) {
      expect(spec(model).chatToolSchema).toBe('native')
      expect(spec(model).cacheRouting).toBe('x_grok_conv_id')
    }
  })

  test('Claude Fable 5.1 的规格与价格逐项与官方模型页一致', () => {
    const fable = spec('claude-fable-5-1', 'anthropic_messages')
    expect(fable.displayName).toBe('Claude Fable 5.1')
    expect(fable.contextWindow).toBe(1_000_000)
    expect(fable.maxOutputTokens).toBe(128_000)
    expect(fable.vision).toBe(true)
    expect(fable.video).toBe(false)
    expect(fable.thinking).toBe('always_on')
    expect(fable.thinksByDefault).toBe(true)
    expect(fable.minCacheablePrefix).toBe(512)
    expect(fable.pricing).toMatchObject({
      input: 10,
      output: 50,
      cacheRead: 0.25,
      cacheWrite5m: 12.5,
      cacheWrite1h: 20,
    })
    // 5.1 降至 0.025 倍；Fable 5 的缓存读取仍为 0.1 倍。
    expect(spec('claude-fable-5', 'anthropic_messages').pricing.cacheRead).toBe(1)
  })

  test('Sonnet 5 的引入价已转为长期标准价', () => {
    const afterPlannedIncrease = lookupModel(
      'claude-sonnet-5',
      'anthropic_messages',
      Date.UTC(2026, 8, 1),
    ).pricing
    expect(afterPlannedIncrease).toMatchObject({ input: 2, output: 10, cacheRead: 0.2 })
  })

  /** effort 支持名单中没有 Haiku 4.5；Sonnet 4.6 有 max 但没有 xhigh。 */
  test('Claude 的档位逐条与官方名单一致', () => {
    for (const id of ['claude-fable-5-1', 'claude-opus-5']) {
      expect(spec(id, 'anthropic_messages').effortLevels).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ])
    }
    expect(spec('claude-sonnet-4-6', 'anthropic_messages').effortLevels).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ])
    expect(spec('claude-haiku-4-5', 'anthropic_messages').effortLevels).toEqual([])
  })

  /** 国内端点按 BigModel 国内站价目以人民币计价。 */
  test('GLM 国内站基础价与币种', () => {
    for (const id of ['glm-5.3', 'glm-5.2']) {
      expect(spec(id).pricing.input).toBe(8)
      expect(spec(id).pricing.output).toBe(28)
      expect(spec(id).pricing.cacheRead).toBe(2)
      expect(spec(id).pricing.currency).toBe('CNY')
    }
    expect(spec('glm-4.7').pricing.input).toBe(2)
    expect(spec('glm-5v-turbo').pricing.input).toBe(5)
    expect(spec('glm-4.6v').pricing.input).toBe(1)
    expect(spec('glm-5.3').effortLevels).toEqual(['low', 'high', 'max'])
  })

  test('GLM-5.3 Flash 国内站限时价在北京时间九月一日自动恢复', () => {
    const before = lookupModel(
      'glm-5.3-flash',
      'openai_chat_completions',
      Date.UTC(2026, 7, 31, 15, 59, 59),
    ).pricing
    expect(before).toMatchObject({ input: 0.4, output: 1.4, cacheRead: 0.115, currency: 'CNY' })
    const after = lookupModel(
      'glm-5.3-flash',
      'openai_chat_completions',
      Date.UTC(2026, 7, 31, 16),
    ).pricing
    expect(after).toMatchObject({ input: 0.8, output: 2.8, cacheRead: 0.23, currency: 'CNY' })
  })

  test('Kimi K3 三档，Qwen3.8 Max 与 Omni Flash 已收录', () => {
    expect(spec('kimi-k3').effortLevels).toEqual(['low', 'high', 'max'])
    expect(spec('kimi-k3').pricing).toMatchObject({
      input: 20,
      output: 100,
      cacheRead: 2,
      currency: 'CNY',
    })
    expect(spec('kimi-k3').maxOutputTokens).toBe(1_048_576)
    expect(spec('qwen3.8-max').pricing.input).toBe(12)
    expect(spec('qwen3.8-max').pricing.currency).toBe('CNY')
    expect(spec('qwen3.8-max').maxOutputTokens).toBe(131_072)
    expect(spec('qwen3.8-max').effortLevels).toEqual(['low', 'medium', 'xhigh'])
    expect(spec('qwen3.8-max').chatReasoningProtocol).toBe('qwen_preserved')
    expect(spec('qwen3.8-max').chatToolSchema).toBe('openai_strict')
    expect(spec('qwen3.8-omni-flash')).toMatchObject({
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      vision: true,
      video: true,
      thinksByDefault: true,
      effortLevels: ['low', 'medium', 'xhigh'],
      chatReasoningProtocol: 'qwen_preserved',
      cacheRouting: 'none',
      pricing: { input: 0.8, output: 2.7, cacheRead: 0.1, currency: 'CNY' },
    })
  })

  test('GLM-5.3 系列 Chat 使用保留思考协议，并保留厂商原生工具 schema', () => {
    for (const id of ['glm-5.3', 'glm-5.3-flash', 'glm-5.3-flashx']) {
      expect(spec(id).effortLevels).toEqual(['low', 'high', 'max'])
      expect(spec(id).maxOutputTokens).toBe(131_072)
      expect(spec(id).chatReasoningProtocol).toBe('glm_preserved')
      expect(spec(id).chatToolSchema).toBe('native')
    }
  })

  test('官方可确认的输出上限已收录；Grok 不推测独立上限', () => {
    expect(spec('MiniMax-M3').maxOutputTokens).toBe(524_288)
    expect(spec('glm-4.6v').maxOutputTokens).toBe(32_768)
    expect(spec('kimi-k3').maxOutputTokens).toBe(1_048_576)
    expect(
      builtinCatalog()
        .filter((m) => m.maxOutputTokens === null)
        .map((m) => m.id),
    ).toEqual(['grok-4.7', 'grok-4.7', 'grok-4.6', 'grok-4.5'])
  })
})
