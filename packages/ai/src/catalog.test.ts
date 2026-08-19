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
import { applySpecOverride, computeCost, lookupModel, priceAt } from './catalog.ts'

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
    const spec = lookupModel('deepseek-v4-flash', 'openai_compatible')
    expect(spec.provider).toBe('openai_compatible')
    expect(spec.thinking).toBe('deepseek_thinking')
  })

  /** 两条协议的档位必须各记各的——合并过一次，代价是其中一边一定在说谎。 */
  test('两条协议的档位互不覆盖', () => {
    expect(lookupModel('deepseek-v4-flash', 'openai_compatible').effortLevels).toEqual([
      'high',
      'max',
    ])
    expect(lookupModel('deepseek-v4-flash', 'openai_responses').effortLevels).toEqual([])
  })

  /** 别名不进目录：指向哪个模型由服务端说了算，随时可改。填了就按未收录处理。 */
  test('别名（deepseek-chat / deepseek-reasoner）不在目录里', () => {
    for (const id of ['deepseek-chat', 'deepseek-reasoner']) {
      expect(lookupModel(id, 'openai_compatible').catalogued).toBe(false)
    }
  })
})

describe('实测修正过的字段', () => {
  /**
   * 这一条是 `qy probe` 实测的（「省略字段时自己思考：是」）。写成 `false` 就是
   * 在目录里放一个与实测相反的事实。
   */
  test('deepseek 省略字段时自己思考', () => {
    for (const p of ['openai_compatible', 'openai_responses'] as const) {
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

  /** Haiku 4.5 走 budget_tokens，没有 effort 档——这条没被上面那次订正影响。 */
  test('haiku-4-5 仍然没有 effort 档', () => {
    expect(lookupModel('claude-haiku-4-5', 'anthropic').effortLevels).toEqual([])
  })
})

describe('provider 不符时的兜底', () => {
  /**
   * 经中转站以兼容协议调 claude 是真实场景：保留能力约束、改写 provider。
   * 但这**只是兜底**——它描述的是另一种协议下的行为，要准就得单独建条目。
   */
  test('目录里没有该协议的条目时，保留能力改写 provider', () => {
    const spec = lookupModel('claude-opus-5', 'openai_compatible')
    expect(spec.provider).toBe('openai_compatible')
    expect(spec.contextWindow).toBe(lookupModel('claude-opus-5', 'anthropic').contextWindow)
  })

  /** 完全不认识的模型给保守默认，且计价为 0——前端显示「未知计价」而不是一个错数字。 */
  test('未知模型不编造计价', () => {
    const spec = lookupModel('明天才发布的模型', 'anthropic')
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
    // 同样一千个输入 token，全靠缓存要便宜得多。等价说明缓存根本没被计入折扣。
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
  const opus = () => lookupModel('claude-opus-5', 'anthropic')

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
    const unknown = lookupModel('中转站上的某个模型', 'openai_compatible')
    expect(unknown.catalogued).toBe(false)
    expect(applySpecOverride(unknown, { displayName: '某个模型' }).catalogued).toBe(false)
    expect(applySpecOverride(unknown, { input: 1, output: 2 }).catalogued).toBe(true)
  })

  test('不传覆盖时原样返回', () => {
    expect(applySpecOverride(opus(), undefined)).toEqual(opus())
  })
})

/**
 * DeepSeek 的分时段定价。
 *
 * 口径来源：官方「模型 & 价格」页 2026-08-17 生效的那版——
 * 高峰＝北京时间 9:00-12:00、14:00-18:00（UTC 01:00-04:00、06:00-10:00），
 * 空闲价恰好是高峰的一半。
 *
 * 这一组盯着两个容易错且**完全静默**的方向：按本机时区判档、以及基准价填反
 * （填空闲价时折扣没生效就少记一半钱，账本往便宜的方向说谎）。
 */
describe('分时段定价', () => {
  const flash = () => lookupModel('deepseek-v4-flash', 'openai_compatible')
  /** 给定 UTC 小时的那一刻。日期取哪天都一样——窗口只看小时。 */
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
    const opus = lookupModel('claude-opus-5', 'anthropic')
    expect(priceAt(opus, { now: at(2) })).toBe(opus.pricing)
  })

  test('算钱按算的那一刻取价', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(computeCost(flash(), usage, at(2))).toBe(12) // 高峰 3 + 9
    expect(computeCost(flash(), usage, at(5))).toBe(6) // 空闲 1.5 + 4.5
  })

  test('v4-pro 的两档', () => {
    const pro = lookupModel('deepseek-v4-pro', 'openai_compatible')
    expect(pro.pricing.input).toBe(9)
    expect(pro.pricing.output).toBe(27)
    expect(priceAt(pro, { now: at(5) }).input).toBe(4.5)
    expect(priceAt(pro, { now: at(5) }).output).toBe(13.5)
  })
})

/**
 * Grok 的长上下文阶梯价。
 *
 * 口径来源：xAI 官方价目表。grok-4.5 与 4.6 都是 500K 窗口，
 * 提示词满 20 万 token 之后**整条请求**翻倍。
 *
 * 这一组盯的是那个「整条翻倍」——按超出部分算会把账记少将近一半，
 * 而少记的方向没有任何东西会报错。
 */
describe('长上下文阶梯价', () => {
  const g46 = () => lookupModel('grok-4.6', 'openai_compatible')
  const g45 = () => lookupModel('grok-4.5', 'openai_compatible')

  test('目录里填的是标准价（<200K 那一档）', () => {
    expect(g46().pricing.input).toBe(2)
    expect(g46().pricing.output).toBe(6)
    expect(g46().pricing.cacheRead).toBe(0.5)
    // 4.5 的缓存价是 $0.30，不是 $0.20——上一版这里是错的。
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
    const opus = lookupModel('claude-opus-5', 'anthropic')
    expect(priceAt(opus, { promptTokens: 900_000 })).toBe(opus.pricing)
  })

  /**
   * **各家的倍率不统一**：xAI 是整齐的 2 倍，Google 的输入 2 倍、输出只有 1.5 倍。
   * 存一个倍率去乘就会把 Gemini 的输出算成 $24 而不是 $18。
   */
  test('高档单价逐字抄，不是按倍率乘出来的', () => {
    const pro = lookupModel('gemini-3.1-pro-preview', 'openai_compatible')
    expect(pro.pricing.output).toBe(12)
    const long = priceAt(pro, { promptTokens: 200_001 })
    expect(long.input).toBe(4) // 2 倍
    expect(long.output).toBe(18) // 1.5 倍，不是 24
    expect(long.cacheRead).toBe(0.4)
  })

  /** Google 写的是「>200k」，xAI 写的是「≥200k」，边界差一个 token。 */
  test('两家的阈值边界各按各的', () => {
    const pro = lookupModel('gemini-3.1-pro-preview', 'openai_compatible')
    expect(priceAt(pro, { promptTokens: 200_000 }).output).toBe(12)
    expect(priceAt(pro, { promptTokens: 200_001 }).output).toBe(18)
    expect(priceAt(g46(), { promptTokens: 200_000 }).output).toBe(12)
  })
})

/**
 * 逐条对着官方页面核过的那些数字。
 *
 * 这一组不测机制，只钉**值**：写错一个数不会报错，只会让账本安静地说谎，
 * 而账本正是用来回答「怎么突然变贵了」的那个东西。
 */
describe('目录里的价格与档位', () => {
  const spec = (id: string, kind: 'anthropic' | 'openai_compatible' = 'openai_compatible') =>
    lookupModel(id, kind)

  test('OpenAI GPT-5.6 三档 + Cyber', () => {
    expect(spec('gpt-5.6-sol').pricing.input).toBe(5)
    expect(spec('gpt-5.6-sol').pricing.output).toBe(30)
    // 上一版把 terra 记成 2.5/15、luna 记成 1/6，都是错的。
    expect(spec('gpt-5.6-terra').pricing.input).toBe(2)
    expect(spec('gpt-5.6-terra').pricing.output).toBe(12)
    expect(spec('gpt-5.6-luna').pricing.input).toBe(0.2)
    expect(spec('gpt-5.6-luna').pricing.output).toBe(1.2)
    expect(spec('gpt-5.6-cyber').pricing.output).toBe(75)
    // 官方模型页写的是 1.05M，不是 1M。
    expect(spec('gpt-5.6-sol').contextWindow).toBe(1_050_000)
  })

  test('Gemini Flash 两代同价，3.5 更贵', () => {
    // 上一版三条都记成 0.3/2.5。
    expect(spec('gemini-3.7-flash').pricing.output).toBe(3.75)
    expect(spec('gemini-3.6-flash').pricing.output).toBe(3.75)
    expect(spec('gemini-3.5-flash').pricing.input).toBe(1.5)
    expect(spec('gemini-3.5-flash').pricing.output).toBe(9)
  })

  test('Grok 的档位面：4.6 有 xhigh，4.5 没有，都没有 max', () => {
    expect(spec('grok-4.6').effortLevels).toEqual(['low', 'medium', 'high', 'xhigh'])
    expect(spec('grok-4.5').effortLevels).toEqual(['low', 'medium', 'high'])
  })

  /** effort 支持名单里没有 Haiku 4.5；Sonnet 4.6 有 max 但没有 xhigh。 */
  test('Claude 的档位面逐条对官方名单', () => {
    expect(spec('claude-opus-5', 'anthropic').effortLevels).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ])
    expect(spec('claude-sonnet-4-6', 'anthropic').effortLevels).toEqual([
      'low',
      'medium',
      'high',
      'max',
    ])
    expect(spec('claude-haiku-4-5', 'anthropic').effortLevels).toEqual([])
  })

  test('Kimi K3 三档，Qwen3.8 Max 已收录', () => {
    expect(spec('kimi-k3').effortLevels).toEqual(['low', 'high', 'max'])
    expect(spec('qwen3.8-max').pricing.input).toBe(12)
    expect(spec('qwen3.8-max').pricing.currency).toBe('CNY')
    expect(spec('qwen3.8-max').maxOutputTokens).toBe(131_072)
  })
})
