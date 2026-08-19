/**
 * 模型目录与计价。
 *
 * 这是**内置基线**，不是白名单：用户在设置里填任意 model id 都能跑（BYOK 自定义接口是
 * 需求 11 的硬要求）。目录只提供三件事——已知模型的能力约束、计价、以及请求参数的合法性
 * 校验。未知模型走 `unknownModel()` 的保守默认值，不阻止发送。
 *
 * 口径来源：Anthropic 官方文档（2026-06-24 快照）。改动这里前先核对，别凭记忆写。
 */

import type { EffortLevel } from '@qywork/core'

/**
 * 每百万 token 的单价。
 *
 * **币种是这条数据的一部分。** 阿里 / 月之暗面 / 智谱三家官网就是按人民币标价的，
 * 把 ¥6 当成 $6 会让账面差七倍。所以带上 `currency`，由消费方决定怎么显示、
 * 要不要合计——而不是在这里偷偷换算成一个假的美元数字。
 */
export interface Pricing {
  input: number
  output: number
  /** 省略即 `'USD'`。缺省不写是为了不用给已有的每一条都加一遍。 */
  currency?: 'USD' | 'CNY'
  /** 缓存读取，通常是 input 的 0.1 倍。 */
  cacheRead: number
  /** 缓存写入（5 分钟 TTL），通常是 input 的 1.25 倍。 */
  cacheWrite5m: number
  /** 缓存写入（1 小时 TTL），通常是 input 的 2 倍。 */
  cacheWrite1h: number
}

export type ThinkingMode =
  /** 只接受 {type:'adaptive'}；budget_tokens 会 400。 */
  | 'adaptive_only'
  /** 思考恒开，连 {type:'disabled'} 都会 400——只能省略 thinking 字段。 */
  | 'always_on'
  /** 老模型：{type:'enabled', budget_tokens:N}。 */
  | 'budget_tokens'
  /**
   * OpenAI Responses 形态：思考默认开着，靠 `reasoning.effort` 控制，
   * **`'none'` 是唯一能真的关掉它的值**。
   *
   * 与 `always_on` 的区别是「关得掉」，与 `none` 的区别是「本来就在思考」。
   * 这两条差别都要钱：当成 `always_on` 会让「不思考」这个选项静默失效，
   * 当成 `none` 会让适配器一个 reasoning 字段都不发、于是同样关不掉。
   *
   * 实测（2026-08，deepseek-v4-flash / max_output_tokens=900，各三次）：
   * `effort:'none'` → reasoning_tokens 0/0/0；其余每一档都是 899~900。
   * 也就是说除了 `none`，**effort 是被接受但不被采纳的**——
   * 这类模型的 `effortLevels` 应当照实填 `[]`。
   */
  | 'reasoning_effort'
  /**
   * DeepSeek 自己的那套：**`thinking` 开关和 `reasoning_effort` 档位要一起发**。
   *
   * 只发 `reasoning_effort` 不发 `thinking` 时思考根本没开，档位自然没有效果。
   * 那个现象容易被归因成「模型不支持 effort」，实际是少发了一半。
   */
  | 'deepseek_thinking'
  | 'none'

export interface ModelSpec {
  id: string
  displayName: string
  /** **协议**，不是厂商。见 `Vendor` 上的注释。 */
  provider: ProviderKind
  /**
   * 厂商 id（`VENDORS` 里的一条）。`null` = 未收录，来自用户自建端点。
   *
   * 显式写在每条上，不按 id 前缀推断——L 那条规矩：任何「从名字推断行为」
   * 的便利都要先问反例是什么，而中转站的模型名可以是任何东西。
   */
  vendor: string | null
  contextWindow: number
  maxOutputTokens: number
  pricing: Pricing
  thinking: ThinkingMode
  /**
   * 支持的 effort 档位。空数组=不支持 effort 参数。
   */
  effortLevels: EffortLevel[]
  /**
   * 省略 thinking 字段时是否仍然会思考。
   * Opus 5 / Sonnet 5 = true，这直接影响 maxOutputTokens 的预留——思考和正文
   * 共用同一个上限，按「不思考」的口径调小 max_tokens 会把回答从中间截断。
   */
  thinksByDefault: boolean
  /**
   * 会话**中间**收不收 `role:'system'` 的消息。
   *
   * 尾区注记（日期、技能与记忆索引…）就压在历史之后，不能挪进顶层 `system`——
   * 那等于挪进冻结前缀，改一条记忆就把整段缓存打掉。收它的模型直接发 system 轮
   * （那是不可伪造的操作方通道）；不收的回 400 `role 'system' is not supported
   * on this model`，只能退化成 user 轮里的 `<system-reminder>`。
   *
   * **省略即 false**：漏标一条的表现是「少了个操作方通道」，标错成 true 的表现是
   * 那个模型上每一条请求都发不出去。往安全那侧默认。
   *
   * 只有 anthropic 协议读它——OpenAI 兼容那侧 mid-message system 是通用合法的。
   */
  midConversationSystem?: boolean
  /** 采样参数是否被拒绝。Claude 5 系全部拒绝 temperature/top_p/top_k。 */
  /** 最小可缓存前缀（token）。低于此值加了 cache_control 也静默不缓存。 */
  minCacheablePrefix: number
  /**
   * 分时段折扣。没有就是「一天一个价」，绝大多数模型都是这样。
   *
   * **`pricing` 是基准价（高峰价），这一条只描述什么时候打折。**
   * 存两套完整价目会立刻长出「改了高峰忘了改空闲」这种漂移，
   * 而两套数字看起来都像是对的。
   */
  offPeak?: OffPeakDiscount
  /**
   * 长上下文阶梯价。没有就是「多大的请求都一个价」。
   * 与 `offPeak` 一样，`pricing` 是标准价，这一条只描述什么时候换档。
   */
  longContext?: LongContextTier
  /**
   * 这条 spec 是不是来自内置目录。
   *
   * 只有 `unknownModel()` 会把它设成 `false`——**默认缺省即视为已收录**，
   * 这样往目录里加模型不必每条都写一遍 `catalogued: true`
   * （漏写一条的表现会是「这个正常模型也在报未收录」，噪声一旦出现就没人看提示了）。
   *
   * 它区分的是「没测」和「不支持」，见 `unknownModel()` 上的注释与 ARCHITECTURE §27。
   */
  catalogued?: boolean
}

export type ProviderKind = 'anthropic' | 'openai_responses' | 'openai_compatible'

/**
 * 厂商。
 *
 * **和 `ProviderKind` 是两个轴，不能合并。** `ProviderKind` 说的是协议——
 * DeepSeek、OpenAI、任何中转站都可以是 `openai_compatible`。厂商回答的是
 * 另外两个问题：端点在哪、旗下有哪些模型。
 * 合成一个的话「选了厂商自动带出端点」就无从做起，因为协议里没有端点。
 *
 * **它不落盘。** 配置文件里存的仍然是 `kind` / `model` / `baseUrl` / `apiKey`
 * 那几个字段，这张表只是填表时的默认值来源。多存一个 `vendor` 就会和 `baseUrl`
 * 打架：用户把端点改成中转站之后，vendor 还写着 deepseek，两本账立刻开始漂移。
 */
export interface Vendor {
  id: string
  displayName: string
  defaultKind: ProviderKind
  /** 官方端点。省略 = 用 SDK 自带的默认值（Anthropic 就是这种情况）。 */
  defaultBaseUrl?: string
}

/**
 * `defaultBaseUrl` **只填有实据的**。
 *
 * Anthropic 走 SDK 自带默认；DeepSeek 那条来自这台机器上跑通的配置；
 * OpenAI 那条是本仓 `openai-responses.ts` 里的常量。其余六家两个仓库里
 * 都没有落过地，所以留空——凭印象写一个域名，错了的表现是「填好了却连不上」，
 * 比空着要人自己填糟得多。
 */
export const VENDORS: readonly Vendor[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    defaultKind: 'anthropic',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    defaultKind: 'openai_compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    defaultKind: 'openai_compatible',
    // 带 `/v1`：DeepSeek 的 OpenAI 兼容端点在这一层，少了它是 404。
    defaultBaseUrl: 'https://api.deepseek.com/v1',
  },
  {
    id: 'google',
    displayName: 'Google',
    defaultKind: 'openai_compatible',
  },
  { id: 'xai', displayName: 'xAI', defaultKind: 'openai_compatible' },
  {
    id: 'alibaba',
    displayName: '阿里云百炼',
    defaultKind: 'openai_compatible',
  },
  {
    id: 'moonshot',
    displayName: '月之暗面',
    defaultKind: 'openai_compatible',
  },
  {
    id: 'zhipu',
    displayName: '智谱',
    defaultKind: 'openai_compatible',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    defaultKind: 'openai_compatible',
  },
]

/**
 * 长上下文阶梯价。
 *
 * **达到阈值之后整条请求都按高档算，不是只算超出的那部分。**
 * xAI 的原话：一条 21 万 token 的请求不是「20 万按标准价 + 1 万按高价」，
 * 而是整条按高价。按超出部分算会把账记少一半，而少记的方向没有任何东西会报错。
 *
 * **高档单价逐字抄厂商的第二行，不按倍率推算。** 各家的倍率不统一：
 * OpenAI 与 Google 的输入是 2 倍而输出只有 1.5 倍，xAI 才是整齐的 2 倍。
 * 存一个倍率就得自己算比值，算错了没有任何东西会提示。
 *
 * 阈值比的是**提示词**大小（未命中输入 + 命中输入），不含输出——
 * 计价发生在请求发出之后，那时输出还没产生，厂商也是按提示词分档的。
 */
export interface LongContextTier {
  /**
   * **第一个进入高档的提示词 token 数**（含）。
   *
   * 各家的边界写法不一样：xAI 写「≥200k」，Google 写「>200k」。
   * 统一成「第一个进高档的数」而不是另加一个比较符——多一个字段就多一处
   * 写反的机会，而写反的表现是整整一档的钱记错。
   */
  thresholdTokens: number
  input: number
  output: number
  cacheRead: number
  /** 一句话，界面直接显示。 */
  note: string
}

/**
 * 分时段折扣。**窗口按 UTC 小时给，不按本机时区。**
 *
 * 厂商公布的是当地时间（DeepSeek 写的是北京时间），但这台机器可能在任何时区，
 * 用 `getHours()` 算等于把用户的时区当成了厂商的时区——在美国跑就整天算错档，
 * 而错的表现只是账本上一个偏低或偏高的数字，没有任何地方会报错。
 * 所以录进来的时候就换算成 UTC，`priceAt` 只认 `getUTCHours()`。
 *
 * ## 为什么记「高峰窗口」而不是「折扣窗口」
 *
 * 照抄厂商的说法。DeepSeek 的原话是「高峰时段为北京时间 9:00-12:00、14:00-18:00
 * （其余为空闲时段）」——记高峰是逐字转录，记折扣就得自己把补集算一遍，
 * 而那一步算错了没有任何东西会提示。
 */
export interface OffPeakDiscount {
  /** 折扣系数，乘在每一档单价上。DeepSeek 空闲时段恰好是高峰的一半，即 0.5。 */
  rate: number
  /**
   * 高峰时段（不打折），`[起, 止)` 半开区间，UTC 小时，可带小数（`9.5` = 09:30）。
   * 跨零点的窗口拆成两段写，不做环形判断——环形判断只有这一个用户，
   * 而写错的方向是「整段时间收错价」。
   */
  peakWindowsUtc: readonly (readonly [number, number])[]
  /** 一句话，界面直接显示，不再自己拼。 */
  note: string
}

/**
 * DeepSeek 的高峰时段：北京时间 9:00-12:00、14:00-18:00（UTC+8）。
 *
 * 换算成 UTC 就是 01:00-04:00 与 06:00-10:00。
 * 口径来源：官方文档「模型 & 价格」页（2026-08-17 生效的新价目）。
 */
const DEEPSEEK_OFF_PEAK: OffPeakDiscount = {
  rate: 0.5,
  peakWindowsUtc: [
    [1, 4],
    [6, 10],
  ],
  note: '空闲时段 5 折（高峰＝北京时间 9:00-12:00、14:00-18:00）',
}

/**
 * Gemini 3.1 Pro 的长上下文档：官方写「>200k」，所以第一个进高档的是 200001。
 * 注意输入是 2 倍而输出只有 1.5 倍——倍率不统一，逐字抄。
 */
const GEMINI_31_PRO_LONG: LongContextTier = {
  thresholdTokens: 200_001,
  input: 4,
  output: 18,
  cacheRead: 0.4,
  note: '提示词超过 20 万 token 后整条请求按 $4 / $18（缓存 $0.4）计价',
}

/** xAI 官方价目表：提示词满 20 万，整条请求按 $4 / $12 / 缓存 $1 算。 */
const GROK_46_LONG: LongContextTier = {
  thresholdTokens: 200_000,
  input: 4,
  output: 12,
  cacheRead: 1,
  note: '提示词满 20 万 token 后整条请求按 $4 / $12（缓存 $1）计价',
}

/** 同上，4.5 的缓存档是 $0.60 而不是 $1。 */
const GROK_45_LONG: LongContextTier = {
  thresholdTokens: 200_000,
  input: 4,
  output: 12,
  cacheRead: 0.6,
  note: '提示词满 20 万 token 后整条请求按 $4 / $12（缓存 $0.6）计价',
}

/**
 * 这一刻、这么大的一条请求，实际单价是多少。
 *
 * **目录里那组数字是厂商公布的标准价**，这个函数把偏离标准价的两种情况叠上去：
 * 分时段折扣（按钟点）和长上下文档（按提示词大小）。两者互相独立，
 * 直接连乘——没有哪家同时有这两种，但代码不必为此多一个分支。
 *
 * 两种都没有就返回 `spec.pricing` 本身、**同一个对象引用**：
 * 绝大多数模型走这条路，不为它们每次都新建一个对象。
 */
export function priceAt(
  spec: ModelSpec,
  ctx: { now?: number; promptTokens?: number } = {},
): Pricing {
  let rate = 1
  if (spec.offPeak) {
    const d = new Date(ctx.now ?? Date.now())
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60
    const peak = spec.offPeak.peakWindowsUtc.some(([from, to]) => hour >= from && hour < to)
    if (!peak) rate *= spec.offPeak.rate
  }
  const long =
    spec.longContext && (ctx.promptTokens ?? 0) >= spec.longContext.thresholdTokens
      ? spec.longContext
      : undefined
  if (rate === 1 && !long) return spec.pricing
  const p = spec.pricing
  const base = long
    ? { ...p, input: long.input, output: long.output, cacheRead: long.cacheRead }
    : p
  if (rate === 1) return base
  return {
    ...base,
    input: round(base.input * rate),
    output: round(base.output * rate),
    cacheRead: round(base.cacheRead * rate),
    cacheWrite5m: round(base.cacheWrite5m * rate),
    cacheWrite1h: round(base.cacheWrite1h * rate),
  }
}

function anthropicPricing(input: number, output: number): Pricing {
  return {
    input,
    output,
    cacheRead: round(input * 0.1),
    cacheWrite5m: round(input * 1.25),
    cacheWrite1h: round(input * 2),
  }
}

const round = (n: number) => Math.round(n * 1e6) / 1e6

/**
 * Sonnet 5 的 $2/$10 是限时引入价，2026-08-31 之后回到 $3/$15。
 * 按当前时间取值，不写死——否则账单会在九月一号那天悄悄算错。
 */
const SONNET_5_INTRO_ENDS = Date.UTC(2026, 7, 31, 23, 59, 59)

function sonnet5Pricing(now = Date.now()): Pricing {
  return now <= SONNET_5_INTRO_ENDS ? anthropicPricing(2, 10) : anthropicPricing(3, 15)
}

/**
 * Gemini 3.6 / 3.7 Flash 的促销价，2026-12-31 之后回到 $1.50 / $7.50 / $0.15。
 *
 * 与 `sonnet5Pricing` 同一个形状、同一条理由：**按当前时间取值，不写死**，
 * 否则账单会在一月一号那天悄悄算错。
 */
const GEMINI_FLASH_PROMO_ENDS = Date.UTC(2026, 11, 31, 23, 59, 59)

function geminiFlashPromo(now: number): Pricing {
  return now <= GEMINI_FLASH_PROMO_ENDS
    ? { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite5m: 0, cacheWrite1h: 0 }
    : { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite5m: 0, cacheWrite1h: 0 }
}

const CLAUDE_BASE = {
  provider: 'anthropic' as const,
  vendor: 'anthropic',
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  thinking: 'adaptive_only' as const,
  // 照实测填，不引用 EFFORT_ORDER：那等于替以后新加的档位替 Anthropic 作保。
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as EffortLevel[],
}

export function claudeCatalog(now = Date.now()): ModelSpec[] {
  return [
    {
      ...CLAUDE_BASE,
      id: 'claude-opus-5',
      midConversationSystem: true,
      displayName: 'Claude Opus 5',
      pricing: anthropicPricing(5, 25),
      thinksByDefault: true,
      minCacheablePrefix: 512,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-sonnet-5',
      displayName: 'Claude Sonnet 5',
      pricing: sonnet5Pricing(now),
      thinksByDefault: true,
      minCacheablePrefix: 1024,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-fable-5',
      midConversationSystem: true,
      displayName: 'Claude Fable 5',
      pricing: anthropicPricing(10, 50),
      // 思考恒开：连 {type:'disabled'} 都 400，只能整个省略 thinking 字段。
      thinking: 'always_on',
      thinksByDefault: true,
      minCacheablePrefix: 512,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-opus-4-8',
      midConversationSystem: true,
      displayName: 'Claude Opus 4.8',
      pricing: anthropicPricing(5, 25),
      // 4.8 省略 thinking = 不思考，与 Opus 5 相反。
      thinksByDefault: false,
      minCacheablePrefix: 1024,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-opus-4-7',
      displayName: 'Claude Opus 4.7',
      pricing: anthropicPricing(5, 25),
      thinksByDefault: false,
      minCacheablePrefix: 2048,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-sonnet-4-6',
      displayName: 'Claude Sonnet 4.6',
      pricing: anthropicPricing(3, 15),
      thinking: 'adaptive_only',
      effortLevels: ['low', 'medium', 'high', 'max'],
      thinksByDefault: false,
      // 4.6 的采样参数仍然可用。
      minCacheablePrefix: 1024,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-haiku-4-5',
      displayName: 'Claude Haiku 4.5',
      contextWindow: 200_000,
      maxOutputTokens: 64_000,
      pricing: anthropicPricing(1, 5),
      thinking: 'budget_tokens',
      effortLevels: [],
      thinksByDefault: false,
      minCacheablePrefix: 4096,
    },
  ]
}

/**
 * DeepSeek。
 *
 * 口径与 Anthropic 有三处实质差异，都体现在下面的数字里：
 * - **按人民币标价**（官方价目页就是 ¥）。上一版把它记成美元，数字差着七倍。
 * - 缓存**写入不收费**（自动前缀缓存，没有 Anthropic 那样的 1.25x 写入溢价），
 *   所以 cacheWrite 两档都是 0。
 * - `input` 填的是**缓存未命中**单价；命中部分走 cacheRead。适配器已把
 *   `prompt_tokens` 归一成排他口径，两者不会重复计。
 * - **分高峰 / 空闲两档**，见 `DEEPSEEK_OFF_PEAK`。下面填的是高峰价。
 *
 * 价目来源：官方文档「模型 & 价格」页，2026-08-17 生效的那版：
 *
 * | 模型 | 时段 | 命中输入 | 未命中输入 | 输出 |
 * |---|---|---|---|---|
 * | v4-flash | 高峰 | ¥0.10 | ¥3.0 | ¥9.0 |
 * | v4-flash | 空闲 | ¥0.05 | ¥1.5 | ¥4.5 |
 * | v4-pro | 高峰 | ¥0.30 | ¥9.0 | ¥27.0 |
 * | v4-pro | 空闲 | ¥0.15 | ¥4.5 | ¥13.5 |
 *
 * 实测（2026-08）：`deepseek-chat` 与 `deepseek-reasoner` 都被服务端解析成
 * `deepseek-v4-flash`。**别名不进目录**——指向哪个模型由服务端说了算、随时可改，
 * 而目录里一条别名对用户就是「多一个看起来不一样的模型」。真要用别名就自己填 id，
 * 届时按未收录处理（`configNotices` 会点名说清）。
 */
function deepseekCatalog(): ModelSpec[] {
  const base = {
    provider: 'openai_compatible' as const,
    vendor: 'deepseek',
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    /**
     * 只描述模型，不描述本适配器发不发思考字段——填 `'none'` 是后者，那是错的。
     *
     * 这一支是 chat/completions（Responses 那支见下面）：`thinking:{type:'enabled'}`
     * 和 `reasoning_effort` 必须**一起发**，两档 high / max。
     *
     * **这两档没有在本仓实测过。** 要坐实就跑 `qy probe`——它会把实际接受的档位
     * 写回档案覆盖这里。
     */
    thinking: 'deepseek_thinking' as const,
    effortLevels: ['high', 'max'] as EffortLevel[],
    thinksByDefault: false,
    // 兼容协议没有显式缓存断点，命中完全靠前缀逐字节稳定。
    minCacheablePrefix: 0,
    offPeak: DEEPSEEK_OFF_PEAK,
  }
  const flash: ModelSpec = {
    ...base,
    id: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    pricing: {
      input: 3,
      output: 9,
      currency: 'CNY',
      cacheRead: 0.1,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    },
  }
  const pro: ModelSpec = {
    ...base,
    id: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    pricing: {
      input: 9,
      output: 27,
      currency: 'CNY',
      cacheRead: 0.3,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    },
  }
  /**
   * Responses 协议下的同一批模型，**能力不同所以单独一条**。
   *
   * 差别不是「协议名不一样」，是**我们能不能控制它思考**：
   * - 走 chat/completions 时客户端根本不发思考相关字段，无从控制 → `thinking: 'none'`。
   * - 走 Responses 时 `reasoning.effort:'none'` 能真的关掉 → `thinking: 'reasoning_effort'`。
   *
   * `thinksByDefault` 两边都是 **true**：省略字段它自己就思考，`qy probe` 实测过。
   *
   * `effortLevels` 仍然是 **`[]`**，这是实测结论不是保守默认：
   * minimal / low / medium / high 全部返回 200，而 reasoning_tokens 三次采样
   * 都是 899~900，**没有一档被采纳**。把四档写上去等于宣称一个不存在的能力。
   */
  const responses = (m: ModelSpec): ModelSpec => ({
    ...m,
    provider: 'openai_responses',
    thinking: 'reasoning_effort',
    thinksByDefault: true,
    // **本仓那次实测是在这条协议下做的，不被上面那条改动覆盖。**
    // Responses 只有 `reasoning.effort` 一个旋钮，没有 DeepSeek 那个 `thinking`
    // 开关可配；实测四档全部返回 200 而 reasoning_tokens 都是 899~900，
    // 一档都没被采纳。chat/completions 那边两个字段一起发是另一回事，
    // 各自的结论各自记，不合并。
    effortLevels: [],
  })

  return [
    { ...flash, thinksByDefault: true },
    { ...pro, thinksByDefault: true },
    responses(flash),
    responses(pro),
  ]
}

/**
 * 未知模型的保守默认值。
 *
 * BYOK 场景下用户可能填任何东西（中转站的自定义名、本地 ollama 模型、明天才发布的
 * 模型）。这里给一组不会把请求搞崩的默认值：不声明 thinking、不声明 effort、
 * 不声明采样参数限制、计价为 0（前端显示「未知计价」而不是显示一个错的数字）。
 */
export function unknownModel(id: string, provider: ProviderKind): ModelSpec {
  return {
    id,
    displayName: id,
    provider,
    // 未收录 = 没有厂商。别按 id 猜——中转站的模型名可以叫任何东西。
    vendor: null,
    /*
     * **这一条必须被消费。** 下面那些值是「没测」，不是「不支持」——
     * 而 ARCHITECTURE §27 记的正是这两者不能合并。
     *
     * 具体后果有两条，都完全静默：
     *
     * 1. `thinking: 'none'` → `buildReasoning` 整个省略 reasoning 字段，
     *    于是**这个模型永远不会思考**。用户配了 `gpt-5.6` 期待思考，
     *    拿到的是 `reasoning_tokens: 0`，没有任何报错。
     * 2. `pricing` 全零 → `qy usage` 报 $0。**账本在说谎**，
     *    而账本正是用来发现「怎么突然变贵了」的那个东西。
     *
     * 保守默认本身是对的（乱发 reasoning 字段会让不支持的端点每次 400），
     * 错的是不说。`configNotices` 据这个字段提醒，出口是 `qy probe --save`。
     */
    catalogued: false,
    contextWindow: 128_000,
    maxOutputTokens: 8_192,
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    thinking: 'none',
    effortLevels: [],
    thinksByDefault: false,
    minCacheablePrefix: 1024,
  }
}

/**
 * 其余七家。
 *
 * 窗口、默认最大输出、四档价、思考档位是 2026-07-30 的一份 seed，**没有在本仓
 * 逐条实测过**。改价要拿厂商当时的价目表核，别凭印象改。
 *
 * `thinksByDefault`：有思考档位的填 `true`。它影响的是给思考预留多少输出上限，
 * 多留一点只是保守，少留会把回答从中间截断——两个方向的代价不对等。
 *
 * `minCacheablePrefix`：兼容协议的前缀缓存由服务端自动做、不需要显式断点，
 * 这个数在那条路上没有消费者，1024 只是占位。
 * **真正消费它的是 Anthropic 路径**（`providers/anthropic.ts`）——低于这个长度
 * 打断点不会报错，只是不生效，白付一次缓存写入的记账。
 *
 * ## 三个不要加回来的能力位
 *
 * `vision` / `rejectsSamplingParams` / `maxCacheBreakpoints`：三个都会是零消费者。
 *
 * `vision` 值得单说：它对绝大多数条目只能填 `false`，而语义是**未确认**不是
 * 「确认不支持」。拿它当门控会把一批实际支持视觉的中转站模型挡掉，
 * 而那种失败看起来像「图片发不出去」，查不到这里。**按不确定的数据做门控，
 * 比不做门控更糟。**
 *
 * `maxCacheBreakpoints` 只有两个取值：Anthropic 恒 4、兼容协议恒 0。
 * 那是**协议常量**不是模型能力，而我们只用 2 个断点——一个逐模型不变的字段，
 * 放在逐模型的目录里就是误导。断点数写在用它的那个适配器里。
 */
function openAiCompatCatalog(now: number): ModelSpec[] {
  const base = {
    provider: 'openai_compatible' as const,
    minCacheablePrefix: 1024,
  }
  /** OpenAI 那套五档，走 chat/completions 的 `reasoning_effort`。 */
  const effort = (levels: EffortLevel[]) => ({
    thinking: 'reasoning_effort' as const,
    effortLevels: levels,
    thinksByDefault: true,
  })
  const noThinking = {
    thinking: 'none' as const,
    effortLevels: [] as EffortLevel[],
    thinksByDefault: false,
  }
  const usd = (input: number, output: number, cacheRead: number, write = 0): Pricing => ({
    input,
    output,
    cacheRead,
    cacheWrite5m: write,
    cacheWrite1h: write,
  })
  const cny = (input: number, output: number, cacheRead: number): Pricing => ({
    input,
    output,
    cacheRead,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    currency: 'CNY',
  })
  const FIVE: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

  return [
    /*
     * ── OpenAI GPT-5.6 ──
     *
     * 官方价目页（2026-08）的短上下文档，逐字：
     *
     * | 模型 | 输入 | 缓存输入 | 输出 |
     * |---|---|---|---|
     * | sol | $5.00 | $0.50 | $30.00 |
     * | terra | $2.00 | $0.20 | $12.00 |
     * | luna | $0.20 | $0.02 | $1.20 |
     * | cyber | $12.50 | $1.25 | $75.00 |
     *
     * 窗口 1.05M、最大输出 128K（官方模型页）。
     *
     * **长上下文档没有填**：官方价目页给了第二行价（sol $10/$1/$45、
     * terra $4/$0.4/$18、luna $0.4/$0.04/$1.8），但**没有公布切档的 token 阈值**，
     * 而 `LongContextTier` 少了阈值就无从判断。宁可不填——填一个猜的阈值，
     * 错的方向是「长请求按短价记账」，而那是静默少记钱。
     * 拿到阈值就把这三条补上。
     *
     * `cacheWrite` 那一档官方页没有单列，沿用原有的估算值。
     */
    {
      ...base,
      ...effort(FIVE),
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      vendor: 'openai',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      pricing: usd(5, 30, 0.5, 6.25),
    },
    {
      ...base,
      ...effort(FIVE),
      id: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      vendor: 'openai',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      pricing: usd(2, 12, 0.2, 2.5),
    },
    {
      ...base,
      ...effort(FIVE),
      id: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      vendor: 'openai',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      pricing: usd(0.2, 1.2, 0.02, 0.25),
    },
    {
      ...base,
      ...effort(FIVE),
      id: 'gpt-5.6-cyber',
      displayName: 'GPT-5.6 Cyber',
      vendor: 'openai',
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      pricing: usd(12.5, 75, 1.25, 15.625),
    },

    /*
     * ── Google Gemini ──
     *
     * 官方定价页（2026-08）逐字，单位 $/百万：
     *
     * | 模型 | 输入 | 输出 | 缓存 | 备注 |
     * |---|---|---|---|---|
     * | gemini-3.1-pro-preview | 2.00 | 12.00 | 0.20 | >200k：4.00 / 18.00 / 0.40 |
     * | gemini-3.7-flash | 0.75 | 3.75 | 0.075 | 促销至 2026-12-31，之后 1.50 / 7.50 / 0.15 |
     * | gemini-3.6-flash | 0.75 | 3.75 | 0.075 | 同上 |
     * | gemini-3.5-flash | 1.50 | 9.00 | 0.15 | |
     *
     * **上一版这三条价格全是错的**（3.5/3.6 Flash 记成 0.3/2.5，Pro 缺长上下文档），
     * 而且 id 也不对：官方叫 `gemini-3.1-pro-preview`。
     *
     * flash 两款厂商还给了一档 `minimal`。它不在 EffortLevel 词表里，
     * **不为它扩词表**——扩了就得让所有消费方都认一个只有一家用的档，
     * 而少这一档只是少一个更省的选项。
     *
     * **窗口与最大输出官方定价页没写**，沿用这批 seed 原有的值，两者都没实测过。
     */
    {
      ...base,
      ...effort(['low', 'medium', 'high']),
      id: 'gemini-3.1-pro-preview',
      displayName: 'Gemini 3.1 Pro Preview',
      vendor: 'google',
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      pricing: usd(2, 12, 0.2),
      longContext: GEMINI_31_PRO_LONG,
    },
    {
      ...base,
      ...effort(['low', 'medium', 'high']),
      id: 'gemini-3.7-flash',
      displayName: 'Gemini 3.7 Flash',
      vendor: 'google',
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      pricing: geminiFlashPromo(now),
    },
    {
      ...base,
      ...effort(['low', 'medium', 'high']),
      id: 'gemini-3.6-flash',
      displayName: 'Gemini 3.6 Flash',
      vendor: 'google',
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      pricing: geminiFlashPromo(now),
    },
    {
      ...base,
      ...effort(['low', 'medium', 'high']),
      id: 'gemini-3.5-flash',
      displayName: 'Gemini 3.5 Flash',
      vendor: 'google',
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      pricing: usd(1.5, 9, 0.15),
    },

    // ── xAI ──
    /*
     * xAI 官方价目表（2026-08）。两条都是 500K 窗口、**提示词满 20 万整条翻倍**：
     *
     * | 模型 | <200K | ≥200K |
     * |---|---|---|
     * | grok-4.6 | $2 / 缓存 $0.50 / 出 $6 | $4 / $1.00 / $12 |
     * | grok-4.5 | $2 / 缓存 $0.30 / 出 $6 | $4 / $0.60 / $12 |
     *
     * 目录里填 <200K 那一档（厂商公布的标准价），高档由 `GROK_LONG_CONTEXT` 描述。
     *
     * `maxOutputTokens` 与思考档位官方页面**没写**，沿用这批 seed 原有的值，
     * 两者都没有在本仓实测过。要坐实跑 `qy probe --save`。
     */
    {
      ...base,
      ...effort(['low', 'medium', 'high', 'xhigh']),
      id: 'grok-4.6',
      displayName: 'Grok 4.6',
      vendor: 'xai',
      contextWindow: 500_000,
      maxOutputTokens: 64_000,
      pricing: usd(2, 6, 0.5),
      longContext: GROK_46_LONG,
    },
    {
      ...base,
      ...effort(['low', 'medium', 'high']),
      id: 'grok-4.5',
      displayName: 'Grok 4.5',
      vendor: 'xai',
      contextWindow: 500_000,
      maxOutputTokens: 64_000,
      pricing: usd(2, 6, 0.3),
      longContext: GROK_45_LONG,
    },

    // ── 阿里云百炼 Qwen（人民币标价）──
    /**
     * 官方规格页（2026-08）：窗口 1000000、最大输出 131072、
     * ¥12 输入 / ¥36 输出 / ¥1.5 命中。
     *
     * **思考控制面没测**：规格页写着「最大输出长度（思考模式下）131072」与
     * 「最大思维链长度 262144」，所以它会思考，但用哪个字段控制、有哪几档，
     * 官方页面没说。照保守填 `effortLevels: []`——多声明一个档位的代价是
     * 一个选了没反应的控件。要坐实跑 `qy probe --save`。
     *
     * `thinksByDefault` 填 `true`：思考和正文共用输出上限，多留是保守，
     * 少留会把回答从中间截断，两个方向的代价不对等。
     */
    {
      ...base,
      thinking: 'none',
      effortLevels: [],
      thinksByDefault: true,
      id: 'qwen3.8-max',
      displayName: 'Qwen3.8 Max',
      vendor: 'alibaba',
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      pricing: cny(12, 36, 1.5),
    },
    {
      ...base,
      ...noThinking,
      id: 'qwen3.7-max',
      displayName: 'Qwen3.7 Max',
      vendor: 'alibaba',
      contextWindow: 1_000_000,
      maxOutputTokens: 32_000,
      pricing: cny(6, 24, 1.5),
    },
    {
      ...base,
      ...noThinking,
      id: 'qwen3.7-plus',
      displayName: 'Qwen3.7 Plus',
      vendor: 'alibaba',
      contextWindow: 1_000_000,
      maxOutputTokens: 32_000,
      pricing: cny(2, 8, 0.5),
    },
    {
      ...base,
      ...noThinking,
      id: 'qwen3.7-flash',
      displayName: 'Qwen3.7 Flash',
      vendor: 'alibaba',
      contextWindow: 1_000_000,
      maxOutputTokens: 16_000,
      pricing: cny(0.3, 1.2, 0.08),
    },

    // ── 月之暗面（人民币标价）──
    {
      ...base,
      ...effort(['low', 'high', 'max']),
      id: 'kimi-k3',
      displayName: 'Kimi K3',
      vendor: 'moonshot',
      contextWindow: 1_000_000,
      maxOutputTokens: 32_000,
      pricing: cny(21, 105, 2.1),
    },

    // ── 智谱（人民币标价）──
    {
      ...base,
      ...effort(['high', 'max']),
      id: 'glm-5.2',
      displayName: 'GLM-5.2',
      vendor: 'zhipu',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: cny(10, 30, 2),
    },
    {
      ...base,
      ...noThinking,
      id: 'glm-4.7',
      displayName: 'GLM-4.7',
      vendor: 'zhipu',
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      pricing: cny(2, 8, 0.4),
    },

    // ── MiniMax ──
    {
      ...base,
      ...noThinking,
      id: 'MiniMax-M3',
      displayName: 'MiniMax M3',
      vendor: 'minimax',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: usd(0.6, 2.4, 0.12),
    },
  ]
}

/**
 * 用户对某个模型参数的覆盖。字段全部可选，只写改过的那几个。
 *
 * 落盘形状见 `runtime` 的 `StoredCatalogEntry`；这里之所以再声明一次，是因为
 * 合并要发生在 `@qywork/ai`（适配器和计价都在这一层），而它引不到 runtime。
 * 两处字段必须一致，改一处务必看另一处。
 */
export interface SpecOverride {
  displayName?: string
  vendor?: string
  contextWindow?: number
  maxOutputTokens?: number
  input?: number
  output?: number
  currency?: 'USD' | 'CNY'
  effortLevels?: EffortLevel[]
}

/**
 * 把用户改过的参数叠到目录条目上。**seed → 用户覆盖**，只有这一个顺序。
 *
 * 两条边界：
 *
 * - **只覆盖写了的字段。** 缓存档单价（`cacheRead` / `cacheWrite*`）跟着 seed 走，
 *   不按 input 等比例推算——推算出来的是个看起来精确的假数字，而各家缓存定价
 *   的比例本来就不一样（Anthropic 写入是 1.25x，DeepSeek 写入不要钱）。
 * - **`catalogued` 只有在覆盖里带了单价时才翻成 true。** 只改个显示名就宣布
 *   「已收录」的话，计价仍然是 0 而提醒没了——账本继续报 $0，且再没有人说它。
 */
export function applySpecOverride(spec: ModelSpec, o: SpecOverride | undefined): ModelSpec {
  if (!o) return spec
  const priced = o.input !== undefined || o.output !== undefined
  return {
    ...spec,
    ...(o.displayName ? { displayName: o.displayName } : {}),
    ...(o.vendor ? { vendor: o.vendor } : {}),
    ...(o.contextWindow ? { contextWindow: o.contextWindow } : {}),
    ...(o.maxOutputTokens ? { maxOutputTokens: o.maxOutputTokens } : {}),
    ...(o.effortLevels ? { effortLevels: o.effortLevels } : {}),
    pricing: {
      ...spec.pricing,
      ...(o.input !== undefined ? { input: o.input } : {}),
      ...(o.output !== undefined ? { output: o.output } : {}),
      ...(o.currency ? { currency: o.currency } : {}),
    },
    ...(priced ? { catalogued: true } : {}),
  }
}

/** 全部内置模型。仅用于能力约束与计价，不是可用模型的白名单。 */
export function builtinCatalog(now = Date.now()): ModelSpec[] {
  return [...claudeCatalog(now), ...deepseekCatalog(), ...openAiCompatCatalog(now)]
}

/**
 * 查目录。
 *
 * ## 为什么先按 `(id, provider)` 精确匹配
 *
 * **同一个模型在不同协议下能力不一样。** 实测（2026-08）`deepseek-v4-flash`：
 * 走 chat/completions 时我们根本不发思考相关字段，思考无从控制；
 * 走 Responses 时 `reasoning.effort:'none'` 能真的关掉它。
 * 一个条目描述不了两种协议，所以目录允许同 id 多条、按 provider 区分。
 *
 * 只按 id 找（`.find(m => m.id === id)`）的话，两条里永远只命中先声明的那条，
 * 而「先声明的那条」是个跟正确性毫无关系的顺序。
 */
export function lookupModel(id: string, provider: ProviderKind, now = Date.now()): ModelSpec {
  const all = builtinCatalog(now)
  const exact = all.find((m) => m.id === id && m.provider === provider)
  if (exact) return exact

  const found = all.find((m) => m.id === id)
  // provider 与内置目录不符时（例如经中转站以 openai 兼容协议调 claude），
  // 保留能力约束但改写 provider——协议由用户配置决定，不由模型名决定。
  //
  // 注意这条**只保留能力约束，不保证能力属实**：被改写 provider 的条目描述的是
  // 另一种协议下的行为。所以它是兜底，不是「支持」——真要准，就在目录里
  // 为那个协议单独建一条。
  if (found) return { ...found, provider }
  return unknownModel(id, provider)
}

/**
 * 这条 spec 在**它当前那条协议**上，思考强度是不是真的发得出去。
 *
 * 存在的理由是 `lookupModel` 的那条兜底：目录里没有「Claude + 兼容协议」的条目时，
 * 它保留 Claude 的能力约束、只改写 `provider`——而注释里已经写明**这只保留约束、
 * 不保证能力属实**。于是 `effortLevels` 还是那五档，但兼容协议根本不发 Anthropic
 * 的 `output_config.effort`。界面照着那五档画一个 chip，选了没有任何反应。
 *
 * 判据按协议分：
 * - `anthropic`：适配器只看 `effortLevels` 非空就发 `output_config.effort`。
 * - `openai_responses`：只有 `reasoning.effort` 一条路。
 * - `openai_compatible`：`reasoning_effort`（OpenAI 那套）或 `deepseek_thinking`
 *   （DeepSeek 要两个字段一起发），其余一律发不出去。
 *
 * 与 `openai-compat.ts` 的 `buildReasoning` 是同一份判断的两个用途：
 * 这里答「能不能」，那里答「用哪几个字段」。改一处务必看另一处。
 */
export function effortIsTransmittable(spec: ModelSpec): boolean {
  if (spec.effortLevels.length === 0) return false
  if (spec.provider === 'anthropic') return true
  if (spec.provider === 'openai_responses') return spec.thinking === 'reasoning_effort'
  return spec.thinking === 'reasoning_effort' || spec.thinking === 'deepseek_thinking'
}

/**
 * 按 usage 算这一轮的花费。
 *
 * **币种是 `spec.pricing.currency`，不恒是美元**——阿里 / 月之暗面 / 智谱 /
 * DeepSeek 都按人民币标价。这个函数只返回数字，币种由调用方一起记进账本。
 */
export function computeCost(
  spec: ModelSpec,
  usage: {
    inputTokens: number
    outputTokens: number
    cachedTokens?: number | null
    cacheWriteTokens?: number | null
  },
  now = Date.now(),
): number {
  // 单价**按算钱这一刻、按这一条请求的大小取**，不是按建 adapter 那一刻。
  //
  // adapter 是一个 run 建一次，而 run 可以跑很久：DeepSeek 的高峰窗口一天有两段，
  // 一个 08:55 开始、跑过 09:00 的 run，按建 adapter 那一刻取价会把整轮都按空闲价记。
  // 算钱是逐波次调的（`agent/loop.ts` 每收完一次 usage 就算一次），
  // 在这里取时间正好落在那一次请求刚结束的时候。
  //
  // 提示词大小同理：它逐波次增长，长上下文档必须按**这一次**的大小判，
  // 按整个 run 的最大值或第一次的值判都会算错一半的波次。
  const p = priceAt(spec, {
    now,
    promptTokens: usage.inputTokens + (usage.cachedTokens ?? 0),
  })
  // 只按 5 分钟档算：全项目从不请求 1 小时缓存。`cacheWrite1h` 留在价目表里是
  // **参考数据**（它是真实价格），不是可达的代码分支。别为它加一个 cacheTtl 参数：
  // 没有调用方会传，那条 1h 分支永远走不到。
  const writeRate = p.cacheWrite5m
  const total =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      (usage.cachedTokens ?? 0) * p.cacheRead +
      (usage.cacheWriteTokens ?? 0) * writeRate) /
    1e6
  return round(total)
}
