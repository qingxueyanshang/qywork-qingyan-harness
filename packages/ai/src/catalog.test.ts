/**
 * 模型目录。
 *
 * 目录里写的每一个值都会**直接改变发出去的请求**：
 * `thinking` 决定发不发推理字段、`effortLevels` 决定发不发 effort、
 * `pricing` 决定账单上的数字。写错一个不会报错，只会安静地做错事。
 *
 * 下面标「实测」的都是 2026-08 对着真实端点打出来的，不是照文档抄的。
 */

import { describe, expect, test } from 'bun:test'
import { applySpecOverride, builtinCatalog, computeCost, lookupModel, priceAt } from './catalog.ts'

describe('同一模型在不同协议下能力不同', () => {
  /**
   * `deepseek-v4-flash` 走两种协议，**思考的控制面完全是两套**：
   *
   * - chat/completions：`thinking:{type:'enabled'}` + `reasoning_effort`
   *   两个字段一起发，两档（high / max）。
   * - Responses：只有 `reasoning.effort` 一个旋钮，实测四档全部「接受但不采纳」，
   *   只有 `'none'` 真的关得掉。
   *
   * 一个目录条目描述不了两种协议，所以 `lookupModel` 必须先按
   * `(id, provider)` 精确匹配。只按 id 找的话，命中的是「先声明的那条」——
   * 一个跟正确性毫无关系的顺序。
   */
  test('Responses 下是 reasoning.effort 那一套', () => {
    const spec = lookupModel('deepseek-v4-flash', 'openai_responses')
    expect(spec.provider).toBe('openai_responses')
    expect(spec.thinking).toBe('reasoning_effort')
  })

  test('chat/completions 下是 DeepSeek 自己那一套', () => {
    const spec = lookupModel('deepseek-v4-flash', 'openai_chat_completions')
    expect(spec.provider).toBe('openai_chat_completions')
    expect(spec.thinking).toBe('deepseek_thinking')
  })

  /** 两条协议的档位必须各记各的——合并之后其中一边必然与实际能力不符。 */
  test('两条协议的档位互不覆盖', () => {
    expect(lookupModel('deepseek-v4-flash', 'openai_chat_completions').effortLevels).toEqual([
      'low',
      'high',
      'max',
    ])
    expect(lookupModel('deepseek-v4-flash', 'openai_responses').effortLevels).toEqual([])
  })

  /**
   * 视觉模型两条协议都在目录里。
   *
   * 只收录 chat/completions 那一条的话，Responses 下会走到
   * `lookupModel` 的兑底分支（改写 provider 保留能力约束），
   * 因此把 chat 那套思考字段当成 Responses 的能力拿出来用。
   */
  test('vision 在两条协议下各有一条', () => {
    const chat = lookupModel('deepseek-v4-flash-vision-exp', 'openai_chat_completions')
    expect(chat.thinking).toBe('deepseek_thinking')
    expect(chat.effortLevels).toEqual(['low', 'high', 'max'])

    const resp = lookupModel('deepseek-v4-flash-vision-exp', 'openai_responses')
    expect(resp.thinking).toBe('reasoning_effort')
    expect(resp.reasoningEcho).toBe('reasoning_text')
    expect(resp.effortLevels).toEqual([])
  })

  /** 别名不进目录：指向哪个模型由服务端说了算，随时可改。填了就按未收录处理。 */
  test('别名（deepseek-chat / deepseek-reasoner）不在目录里', () => {
    for (const id of ['deepseek-chat', 'deepseek-reasoner']) {
      expect(lookupModel(id, 'openai_chat_completions').catalogued).toBe(false)
    }
  })
})

describe('实测修正过的字段', () => {
  /**
   * 这一条是 `qy probe` 实测的（「省略字段时自己思考：是」）。写成 `false` 就是
   * 在目录里放一个与实测相反的事实。
   */
  test('deepseek 省略字段时自己思考', () => {
    for (const p of ['openai_chat_completions', 'openai_responses'] as const) {
      expect(lookupModel('deepseek-v4-flash', p).thinksByDefault).toBe(true)
      expect(lookupModel('deepseek-v4-pro', p).thinksByDefault).toBe(true)
    }
  })

  /**
   * Responses 下的 `effortLevels: []` 是**实测结论**，不是「还没探」的保守默认。
   *
   * minimal / low / medium / high 全部返回 200，而 reasoning_tokens 三次采样
   * 都是 899~900（`max_output_tokens=900`），**没有一档被采纳**。
   * 只有 `none` 有效果，而它是「关掉」不是「一档 effort」。
   *
   * 把四档写上去等于宣称一个不存在的能力——面板会显示「已按 high 运行」，
   * 那是一句假话。
   *
   * 这条**只管 Responses**。chat/completions 那边是另一套字段，见上面那个 describe。
   */
  test('Responses 下 deepseek 没有可用的 effort 档位（accepted ≠ works）', () => {
    expect(lookupModel('deepseek-v4-flash', 'openai_responses').effortLevels).toEqual([])
  })

  /** Haiku 4.5 走 budget_tokens，没有 effort 档。 */
  test('haiku-4-5 仍然没有 effort 档', () => {
    expect(lookupModel('claude-haiku-4-5', 'anthropic_messages').effortLevels).toEqual([])
  })
})

describe('provider 不符时的兜底', () => {
  /**
   * 经中转站以兼容协议调 claude 是真实场景：保留能力约束、改写 provider。
   * 但这**只是兜底**——它描述的是另一种协议下的行为，要准就得单独建条目。
   */
  test('目录里没有该协议的条目时，保留能力改写 provider', () => {
    const spec = lookupModel('claude-opus-5', 'openai_chat_completions')
    expect(spec.provider).toBe('openai_chat_completions')
    expect(spec.contextWindow).toBe(
      lookupModel('claude-opus-5', 'anthropic_messages').contextWindow,
    )
  })

  /** 完全不认识的模型给保守默认，且计价为 0——前端显示「未知计价」而不是一个错数字。 */
  test('未知模型不编造计价', () => {
    const spec = lookupModel('明天才发布的模型', 'anthropic_messages')
    expect(spec.pricing.input).toBe(0)
    expect(spec.thinking).toBe('none')
    expect(spec.effortLevels).toEqual([])
  })
})

describe('计价', () => {
  /**
   * DeepSeek 的 `input` 填的是**缓存未命中**单价，命中部分走 cacheRead。
   * 两者不能重复计——适配器已把用量归一成排他口径。
   */
  test('缓存命中按 cacheRead 计，不重复计进 input', () => {
    const spec = lookupModel('deepseek-v4-flash', 'openai_responses')
    const withCache = computeCost(spec, { inputTokens: 100, outputTokens: 0, cachedTokens: 900 })
    const withoutCache = computeCost(spec, { inputTokens: 1000, outputTokens: 0, cachedTokens: 0 })
    // 同样一千个输入 token，全靠缓存要便宜得多。等价说明缓存没被计入折扣。
    expect(withCache).toBeLessThan(withoutCache)
  })
})

/**
 * 模型库里改过的参数。
 *
 * 这一组锁的是**它真的到得了请求和账本**——只做一个能编辑的界面，改完不影响
 * 任何一次调用，就又是一条「有产出没有消费者」的链路。
 */
describe('模型库覆盖', () => {
  const opus = () => lookupModel('claude-opus-5', 'anthropic_messages')

  test('只覆盖写了的字段，没写的照 seed', () => {
    const s = applySpecOverride(opus(), { contextWindow: 200_000 })
    expect(s.contextWindow).toBe(200_000)
    expect(s.maxOutputTokens).toBe(opus().maxOutputTokens)
    expect(s.pricing.input).toBe(opus().pricing.input)
  })

  /**
   * 缓存档跟着 seed 走，**不按 input 等比例推算**。
   * 各家缓存定价的比例不一样（Anthropic 写入 1.25x，DeepSeek 写入不要钱），
   * 推出来的是个看起来精确的假数字。
   */
  test('改单价不动缓存档', () => {
    const s = applySpecOverride(opus(), { input: 99 })
    expect(s.pricing.input).toBe(99)
    expect(s.pricing.cacheRead).toBe(opus().pricing.cacheRead)
    expect(s.pricing.cacheWrite5m).toBe(opus().pricing.cacheWrite5m)
  })

  test('改过的价直接进账本', () => {
    const s = applySpecOverride(opus(), { input: 100, output: 200 })
    const cost = computeCost(s, { inputTokens: 1_000_000, outputTokens: 1_000_000 })
    expect(cost).toBe(300)
  })

  /**
   * 未收录的模型自己填了单价才算收录。
   *
   * 只改个显示名就翻成 true 的话，计价仍然是 0 而「未收录」的提醒没了——
   * 账本继续报 $0，且再没有人说它。
   */
  test('填了单价才算收录，只改名字不算', () => {
    const unknown = lookupModel('中转站上的某个模型', 'openai_chat_completions')
    expect(unknown.catalogued).toBe(false)
    expect(applySpecOverride(unknown, { displayName: '某个模型' }).catalogued).toBe(false)
    expect(applySpecOverride(unknown, { input: 1, output: 2 }).catalogued).toBe(true)
  })

  /**
   * 未收录模型的窗口默认值。
   *
   * 锁的是**方向**不是那个具体的数：给小了每轮提前压缩，白花钱又丢上下文，
   * 而且完全静默——不会有任何一处报「压早了」。
   */
  test('未收录模型的窗口给 256K，且能被那一格改掉', () => {
    const unknown = lookupModel('中转站上的某个模型', 'openai_chat_completions')
    expect(unknown.contextWindow).toBe(256_000)
    expect(applySpecOverride(unknown, { contextWindow: 1_000_000 }).contextWindow).toBe(1_000_000)
  })

  test('不传覆盖时原样返回', () => {
    expect(applySpecOverride(opus(), undefined)).toEqual(opus())
  })

  /**
   * 思考三项也在库里。只存在于接口下那一格时界面上看不见也改不动，
   * 「库里显示的」和「真正发出去的」会是两个值。
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

  /** `false` 是有效覆盖：按 falsy 判缺省的话，「它自己不思考」这条实测写不进去。 */
  test('thinksByDefault 写 false 也算覆盖', () => {
    expect(applySpecOverride(opus(), { thinksByDefault: false }).thinksByDefault).toBe(false)
    expect(applySpecOverride(opus(), {}).thinksByDefault).toBe(opus().thinksByDefault)
  })

  /**
   * 中转站把一个收图片的模型挂在自定义名下时，这一格是唯一出口——
   * 目录认不出那个名字，落在 `null`（不裁决）。反过来也一样：
   * 中转站的某条链路不收图片时填 `false` 就挡住了。
   */
  test('vision 三态都能覆盖，false 不被当成缺省', () => {
    const unknown = lookupModel('中转站上的某个模型', 'openai_chat_completions')
    expect(unknown.vision).toBeNull()
    expect(applySpecOverride(unknown, { vision: true }).vision).toBe(true)
    expect(applySpecOverride(opus(), { vision: false }).vision).toBe(false)
    expect(applySpecOverride(opus(), {}).vision).toBe(opus().vision)
  })
})

/**
 * 图片输入这一轴。
 *
 * 三态的意义全在这里：`null` 是「厂商规格页没写」，被门控当成放行；
 * 只有 `false` 会让 `agent` 把图像块换成文本注记、让界面收起图片入口。
 * 把 `null` 折成 `false` 的话，一批实际收图片的中转站模型会被挡掉。
 */
describe('图片输入', () => {
  test('未收录模型不裁决', () => {
    expect(lookupModel('中转站上的某个模型', 'openai_chat_completions').vision).toBeNull()
  })

  /** 照厂商规格页逐条填，不按 id 前缀推断：同一家的两条能一真一假。 */
  test('照规格页填：同一家里两条取值相反', () => {
    expect(lookupModel('glm-5.3', 'openai_chat_completions').vision).toBe(false)
    expect(lookupModel('glm-5.3-flash', 'openai_chat_completions').vision).toBe(true)
    expect(lookupModel('qwen3.7-max', 'openai_chat_completions').vision).toBe(false)
    expect(lookupModel('qwen3.7-plus', 'openai_chat_completions').vision).toBe(true)
    expect(lookupModel('qwen3.7-max', 'openai_chat_completions').video).toBe(false)
    expect(lookupModel('qwen3.7-plus', 'openai_chat_completions').video).toBe(true)
    expect(lookupModel('中转站上的某个模型', 'openai_chat_completions').video).toBe(false)
  })

  /** DeepSeek 那两条的唯一差别就是这一项，两条协议下都成立。 */
  test('DeepSeek 视觉条目与普通条目分得开', () => {
    for (const kind of ['openai_chat_completions', 'openai_responses'] as const) {
      expect(lookupModel('deepseek-v4-flash', kind).vision).toBe(false)
      expect(lookupModel('deepseek-v4-flash-vision-exp', kind).vision).toBe(true)
    }
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
        'openai_chat_completions:glm-4.6v',
        'openai_chat_completions:glm-5.3-flash',
        'openai_chat_completions:glm-5v-turbo',
        'openai_chat_completions:kimi-k3',
        'openai_chat_completions:qwen3-vl-flash',
        'openai_chat_completions:qwen3-vl-plus',
        'openai_chat_completions:qwen3.7-flash',
        'openai_chat_completions:qwen3.7-plus',
        'openai_chat_completions:qwen3.8-flash',
        'openai_chat_completions:qwen3.8-max',
      ].sort(),
    )
  })

  test('原生模型支持但当前协议未接通时仍不放行', () => {
    expect(lookupModel('gemini-3.7-flash', 'openai_chat_completions').video).toBe(false)
    expect(lookupModel('gpt-5.6-sol', 'openai_chat_completions').video).toBe(false)
    expect(lookupModel('claude-opus-5', 'anthropic_messages').video).toBe(false)
    expect(lookupModel('deepseek-v4-flash-vision-exp', 'openai_chat_completions').video).toBe(false)
    expect(lookupModel('中转站上的某个模型', 'openai_chat_completions').video).toBe(false)
  })
})

/**
 * DeepSeek 的分时段定价。
 *
 * 口径来源：官方「模型 & 价格」页 2026-08-17 生效的那版——
 * 高峰＝北京时间周一至周五 9:00-12:00、14:00-18:00（UTC 01:00-04:00、06:00-10:00），
 * 空闲价恰好是高峰的一半。
 *
 * 这一组盯着两个容易错且**完全静默**的方向：按本机时区判档、以及基准价填反
 * （填空闲价时折扣没生效就少记一半钱，账本向偏低的方向出错）。
 */
describe('分时段定价', () => {
  const flash = () => lookupModel('deepseek-v4-flash', 'openai_chat_completions')
  /** 2026-08-18（周二）的这一刻。星期也参与判档，所以日期不能随便换。 */
  const at = (utcHour: number, utcMinute = 0) => Date.UTC(2026, 7, 18, utcHour, utcMinute)

  test('目录里填的是高峰价，人民币', () => {
    const p = flash().pricing
    expect(p.currency).toBe('CNY')
    expect(p.input).toBe(3)
    expect(p.output).toBe(9)
    expect(p.cacheRead).toBe(0.1)
    // 自动前缀缓存，写入不收费。
    expect(p.cacheWrite5m).toBe(0)
  })

  test('高峰时段按原价', () => {
    // 北京时间 10:00 = UTC 02:00，落在第一段高峰里。
    expect(priceAt(flash(), { now: at(2) }).output).toBe(9)
    // 北京时间 15:00 = UTC 07:00，落在第二段。
    expect(priceAt(flash(), { now: at(7) }).output).toBe(9)
  })

  test('空闲时段五折，每一档都打', () => {
    // 北京时间 13:00 = UTC 05:00，卡在两段高峰之间。
    const p = priceAt(flash(), { now: at(5) })
    expect(p.input).toBe(1.5)
    expect(p.output).toBe(4.5)
    expect(p.cacheRead).toBe(0.05)
  })

  /** 半开区间：起点算高峰，终点不算。差一个小时就是差一倍的钱。 */
  test('窗口边界是左闭右开', () => {
    expect(priceAt(flash(), { now: at(1) }).output).toBe(9) // 北京 9:00 整，高峰第一分钟
    expect(priceAt(flash(), { now: at(0, 59) }).output).toBe(4.5) // 北京 8:59，还没开始
    expect(priceAt(flash(), { now: at(4) }).output).toBe(4.5) // 北京 12:00 整，已经结束
    expect(priceAt(flash(), { now: at(3, 59) }).output).toBe(9) // 北京 11:59，还在里面
  })

  /**
   * 星期这一维：周一至周五才有高峰，周六周日整天空闲。
   *
   * 只按小时判的话，周末落在两段窗口里的请求会按原价记——账本向偏高的方向出错，
   * 没有任何地方会报错。四条断言把星期集合的两端都钉住。
   */
  test('高峰只在周一至周五', () => {
    const hour = (day: number, utcHour: number) => Date.UTC(2026, 7, day, utcHour)
    expect(priceAt(flash(), { now: hour(22, 2) }).output).toBe(4.5) // 周六，第一段窗口内
    expect(priceAt(flash(), { now: hour(23, 7) }).output).toBe(4.5) // 周日，第二段窗口内
    expect(priceAt(flash(), { now: hour(17, 2) }).output).toBe(9) // 周一，在
    expect(priceAt(flash(), { now: hour(21, 7) }).output).toBe(9) // 周五，在
  })

  /**
   * **按 UTC 判，不按本机时区。**
   *
   * 用 `getHours()` 的话，这台机器在哪个时区就按哪个时区算档——在美国跑就整天
   * 收错价，而错的表现只是账本上一个数字，没有任何地方会报错。
   * 这条断言只有在实现取 `getUTCHours()` 时才成立。
   */
  test('判档只认 UTC', () => {
    const utcNoon = Date.UTC(2026, 7, 18, 12, 0) // UTC 12:00 = 北京 20:00，空闲
    expect(priceAt(flash(), { now: utcNoon }).output).toBe(4.5)
  })

  test('没有分时段的模型原样返回，不新建对象', () => {
    const opus = lookupModel('claude-opus-5', 'anthropic_messages')
    expect(priceAt(opus, { now: at(2) })).toBe(opus.pricing)
  })

  test('算钱按算的那一刻取价', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(computeCost(flash(), usage, at(2))).toBe(12) // 高峰 3 + 9
    expect(computeCost(flash(), usage, at(5))).toBe(6) // 空闲 1.5 + 4.5
  })

  test('v4-pro 的两档', () => {
    const pro = lookupModel('deepseek-v4-pro', 'openai_chat_completions')
    expect(pro.pricing.input).toBe(9)
    expect(pro.pricing.output).toBe(27)
    expect(priceAt(pro, { now: at(5) }).input).toBe(4.5)
    expect(priceAt(pro, { now: at(5) }).output).toBe(13.5)
  })

  /**
   * 视觉模型与 flash 同价，分时段一起打折。
   *
   * 逐档断言而不是比整个 `pricing` 对象：漏收录（id 写错）时 `lookupModel`
   * 返回 `unknownModel`，四档全零而不报错——账本从此报 ¥0。
   */
  test('vision 与 flash 同价', () => {
    const v = lookupModel('deepseek-v4-flash-vision-exp', 'openai_chat_completions')
    expect(v.catalogued).not.toBe(false)
    expect(v.pricing.currency).toBe('CNY')
    expect(v.pricing.input).toBe(3)
    expect(v.pricing.output).toBe(9)
    expect(v.pricing.cacheRead).toBe(0.1)
    expect(priceAt(v, { now: at(5) }).output).toBe(4.5)
  })
})

/**
 * Grok 的长上下文阶梯价。
 *
 * 口径来源：xAI 官方价目表。grok-4.5 与 4.6 都是 500K 窗口，
 * 提示词满 20 万 token 之后**整条请求**翻倍。
 *
 * 这一组盯的是那个「整条翻倍」——按超出部分算会把账记少将近一半，
 * 而少记的方向不会有任何报错。
 */
describe('长上下文阶梯价', () => {
  const g46 = () => lookupModel('grok-4.6', 'openai_chat_completions')
  const g45 = () => lookupModel('grok-4.5', 'openai_chat_completions')

  test('目录里填的是标准价（<200K 那一档）', () => {
    expect(g46().pricing.input).toBe(2)
    expect(g46().pricing.output).toBe(6)
    expect(g46().pricing.cacheRead).toBe(0.5)
    // 4.5 的缓存价是 $0.30，不是 $0.20。
    expect(g45().pricing.cacheRead).toBe(0.3)
  })

  test('没到阈值按标准价', () => {
    expect(priceAt(g46(), { promptTokens: 199_999 }).output).toBe(6)
  })

  test('到了阈值每一档都翻倍', () => {
    const p = priceAt(g46(), { promptTokens: 200_000 })
    expect(p.input).toBe(4)
    expect(p.output).toBe(12)
    expect(p.cacheRead).toBe(1)
    const p45 = priceAt(g45(), { promptTokens: 200_000 })
    expect(p45.cacheRead).toBe(0.6)
  })

  /**
   * **整条请求翻倍，不是只算超出的那部分。**
   *
   * 21 万 token 的提示不是「20 万按标准 + 1 万按高价」。按超出部分算的话
   * 这条断言会得到约 0.42 而不是 0.84——差将近一半，且完全静默。
   */
  test('整条请求换档，不是只算超出部分', () => {
    const cost = computeCost(g46(), { inputTokens: 210_000, outputTokens: 0 })
    expect(cost).toBeCloseTo((210_000 * 4) / 1e6, 9)
  })

  /** 阈值比的是**提示词**（未命中 + 命中），输出不参与——厂商也是按提示词分档的。 */
  test('阈值只看提示词，命中的那部分也算进去', () => {
    const under = computeCost(g46(), { inputTokens: 100_000, outputTokens: 500_000 })
    expect(under).toBeCloseTo((100_000 * 2 + 500_000 * 6) / 1e6, 9)
    // 未命中 12 万 + 命中 8 万 = 20 万，够阈值了。
    const over = priceAt(g46(), { promptTokens: 120_000 + 80_000 })
    expect(over.input).toBe(4)
  })

  test('没有阶梯价的模型不受影响', () => {
    const opus = lookupModel('claude-opus-5', 'anthropic_messages')
    expect(priceAt(opus, { promptTokens: 900_000 })).toBe(opus.pricing)
  })

  /**
   * **各家的倍率不统一**：xAI 是整齐的 2 倍，Google 的输入 2 倍、输出只有 1.5 倍。
   * 存一个倍率去乘就会把 Gemini 的输出算成 $24 而不是 $18。
   */
  test('高档单价逐字抄，不是按倍率乘出来的', () => {
    const pro = lookupModel('gemini-3.1-pro-preview', 'openai_chat_completions')
    expect(pro.pricing.output).toBe(12)
    const long = priceAt(pro, { promptTokens: 200_001 })
    expect(long.input).toBe(4) // 2 倍
    expect(long.output).toBe(18) // 1.5 倍，不是 24
    expect(long.cacheRead).toBe(0.4)
  })

  test('GPT-5.6 长上下文连缓存写入价一起换档', () => {
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

  /** Google 写的是「>200k」，xAI 写的是「≥200k」，边界差一个 token。 */
  test('两家的阈值边界各按各的', () => {
    const pro = lookupModel('gemini-3.1-pro-preview', 'openai_chat_completions')
    expect(priceAt(pro, { promptTokens: 200_000 }).output).toBe(12)
    expect(priceAt(pro, { promptTokens: 200_001 }).output).toBe(18)
    expect(priceAt(g46(), { promptTokens: 200_000 }).output).toBe(12)
  })

  /**
   * 三档的那几条：取**达到的最高一档**，不是第一条命中的。
   *
   * 只留一档的话，中间那段与最长那段必有一段记错价，而两个方向都是静默的。
   */
  test('三档阶梯逐档进档', () => {
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
 * 逐条对着官方页面核过的那些数字。
 *
 * 这一组不测机制，只钉**值**：写错一个数不会报错，只会让账本静默出错，
 * 而账本正是用来回答「怎么突然变贵了」的那份记录。
 */
describe('目录里的价格与档位', () => {
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
    // 官方模型页写的是 1.05M，不是 1M。
    expect(spec('gpt-5.6-sol').contextWindow).toBe(1_050_000)
    expect(spec('gpt-5.6-cyber').contextWindow).toBe(400_000)
  })

  test('Gemini Flash 两代同价，3.5 更贵', () => {
    // 三条都不是 0.3/2.5。
    expect(spec('gemini-3.7-flash').pricing.output).toBe(3.75)
    expect(spec('gemini-3.6-flash').pricing.output).toBe(3.75)
    expect(spec('gemini-3.5-flash').pricing.input).toBe(1.5)
    expect(spec('gemini-3.5-flash').pricing.output).toBe(9)
    expect(spec('gemini-3.6-flash').effortLevels).toEqual(['minimal', 'low', 'medium', 'high'])
    expect(spec('gemini-3.7-flash').contextWindow).toBe(1_048_576)
    expect(spec('gemini-3.7-flash').maxOutputTokens).toBe(65_536)
  })

  test('Grok 的档位面：4.6 有 xhigh，4.5 没有，都没有 max', () => {
    expect(spec('grok-4.6').effortLevels).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(spec('grok-4.5').effortLevels).toEqual(['low', 'medium', 'high'])
  })

  test('Grok 使用 xAI 原生工具 schema 与 Chat Completions 缓存请求头', () => {
    for (const model of ['grok-4.6', 'grok-4.5']) {
      expect(spec(model).chatToolSchema).toBe('native')
      expect(spec(model).cacheRouting).toBe('x_grok_conv_id')
    }
  })

  /** effort 支持名单里没有 Haiku 4.5；Sonnet 4.6 有 max 但没有 xhigh。 */
  test('Claude 的档位面逐条对官方名单', () => {
    expect(spec('claude-opus-5', 'anthropic_messages').effortLevels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(spec('claude-sonnet-4-6', 'anthropic_messages').effortLevels).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ])
    expect(spec('claude-haiku-4-5', 'anthropic_messages').effortLevels).toEqual([])
  })

  /** 国内端点按 BigModel 国内站价目记人民币。 */
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

  test('Kimi K3 三档，Qwen3.8 Max 已收录', () => {
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
  })

  test('GLM-5.3 两款走保留思考协议，并保留厂商原生工具 schema', () => {
    for (const id of ['glm-5.3', 'glm-5.3-flash']) {
      expect(spec(id).effortLevels).toEqual(['low', 'high', 'max'])
      expect(spec(id).maxOutputTokens).toBe(131_072)
      expect(spec(id).chatReasoningProtocol).toBe('glm_preserved')
      expect(spec(id).chatToolSchema).toBe('native')
    }
  })

  test('官方可确认的输出上限已收录；只有 Grok 两条保留 null', () => {
    expect(spec('MiniMax-M3').maxOutputTokens).toBe(524_288)
    expect(spec('glm-4.6v').maxOutputTokens).toBe(32_768)
    expect(spec('kimi-k3').maxOutputTokens).toBe(1_048_576)
    expect(
      builtinCatalog()
        .filter((m) => m.maxOutputTokens === null)
        .map((m) => m.id),
    ).toEqual(['grok-4.6', 'grok-4.5'])
  })
})
