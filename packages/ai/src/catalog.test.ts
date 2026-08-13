/**
 * 模型目录。
 *
 * 这个文件此前没有——而目录里写的每一个值都会**直接改变发出去的请求**：
 * `thinking` 决定发不发推理字段、`effortLevels` 决定发不发 effort、
 * `pricing` 决定账单上的数字。写错一个不会报错，只会安静地做错事。
 *
 * 下面标「实测」的都是 2026-08 对着真实端点打出来的，不是照文档抄的。
 */

import { describe, expect, test } from 'bun:test'
import { computeCost, lookupModel } from './catalog.ts'

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

  test('别名（deepseek-chat / deepseek-reasoner）两种协议下都在', () => {
    for (const id of ['deepseek-chat', 'deepseek-reasoner']) {
      expect(lookupModel(id, 'openai_responses').thinking).toBe('reasoning_effort')
      expect(lookupModel(id, 'openai_compatible').thinking).toBe('deepseek_thinking')
    }
  })
})

describe('实测修正过的字段', () => {
  /**
   * 目录里原来写的是 `false`，那是错的。`qy probe` 早就打印过
   * 「省略字段时自己思考：是」，只是那个结论被 `toCapabilities` 一起丢掉了
   * （见 ROADMAP §22.3）——**一个测出来了却被扔掉的事实**。
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
