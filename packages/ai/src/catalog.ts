/**
 * 模型目录与计价。
 *
 * 这是**内置基线**，不是白名单：用户在设置里填任意 model id 都能跑（BYOK 自定义接口是
 * 需求 11 的硬要求）。目录只提供三件事——已知模型的能力约束、计价、以及请求参数的合法性
 * 校验。未知模型走 `unknownModel()` 的保守默认值，不阻止发送。
 *
 * 口径来源：Anthropic 官方文档（2026-06-24 快照）。改动这里前先核对，别凭记忆写。
 */

/** 每百万 token 的美元单价。 */
export interface Pricing {
  input: number
  output: number
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
  | 'none'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface ModelSpec {
  id: string
  displayName: string
  provider: ProviderKind
  contextWindow: number
  maxOutputTokens: number
  pricing: Pricing
  vision: boolean
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
   * 关闭思考所允许的最高 effort 档。null = 不允许关闭。
   * Opus 5：thinking:{type:'disabled'} 配 xhigh/max 直接 400。
   */
  disableThinkingMaxEffort: EffortLevel | null
  /** 采样参数是否被拒绝。Claude 5 系全部拒绝 temperature/top_p/top_k。 */
  rejectsSamplingParams: boolean
  /** 最小可缓存前缀（token）。低于此值加了 cache_control 也静默不缓存。 */
  minCacheablePrefix: number
  /** 提示缓存断点上限。 */
  maxCacheBreakpoints: number
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

const CLAUDE_BASE = {
  provider: 'anthropic' as const,
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000,
  vision: true,
  thinking: 'adaptive_only' as const,
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as EffortLevel[],
  rejectsSamplingParams: true,
  maxCacheBreakpoints: 4,
}

export function claudeCatalog(now = Date.now()): ModelSpec[] {
  return [
    {
      ...CLAUDE_BASE,
      id: 'claude-opus-5',
      displayName: 'Claude Opus 5',
      pricing: anthropicPricing(5, 25),
      thinksByDefault: true,
      // 关思考只允许到 high；配 xhigh/max 是 400。
      disableThinkingMaxEffort: 'high',
      minCacheablePrefix: 512,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-sonnet-5',
      displayName: 'Claude Sonnet 5',
      pricing: sonnet5Pricing(now),
      thinksByDefault: true,
      disableThinkingMaxEffort: 'max',
      minCacheablePrefix: 1024,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-fable-5',
      displayName: 'Claude Fable 5',
      pricing: anthropicPricing(10, 50),
      // 思考恒开：连 {type:'disabled'} 都 400，只能整个省略 thinking 字段。
      thinking: 'always_on',
      thinksByDefault: true,
      disableThinkingMaxEffort: null,
      minCacheablePrefix: 512,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-opus-4-8',
      displayName: 'Claude Opus 4.8',
      pricing: anthropicPricing(5, 25),
      // 4.8 省略 thinking = 不思考，与 Opus 5 相反。
      thinksByDefault: false,
      disableThinkingMaxEffort: 'max',
      minCacheablePrefix: 1024,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-opus-4-7',
      displayName: 'Claude Opus 4.7',
      pricing: anthropicPricing(5, 25),
      thinksByDefault: false,
      disableThinkingMaxEffort: 'max',
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
      disableThinkingMaxEffort: 'max',
      // 4.6 的采样参数仍然可用。
      rejectsSamplingParams: false,
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
      disableThinkingMaxEffort: 'max',
      rejectsSamplingParams: false,
      minCacheablePrefix: 4096,
    },
  ]
}

/**
 * DeepSeek。
 *
 * 口径与 Anthropic 有两处实质差异，都体现在下面的数字里：
 * - 缓存**写入不收费**（自动前缀缓存，没有 Anthropic 那样的 1.25x 写入溢价），
 *   所以 cacheWrite 两档都是 0。
 * - `input` 填的是**缓存未命中**单价；命中部分走 cacheRead。适配器已把
 *   `prompt_tokens` 归一成排他口径，两者不会重复计。
 *
 * 实测（2026-08）：`deepseek-chat` 与 `deepseek-reasoner` 都被服务端解析成
 * `deepseek-v4-flash`。别名随时可能改指向，生产配置建议直接写具体 id。
 */
function deepseekCatalog(): ModelSpec[] {
  const base = {
    provider: 'openai_compatible' as const,
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
    vision: false,
    thinking: 'none' as const,
    effortLevels: [] as EffortLevel[],
    thinksByDefault: false,
    disableThinkingMaxEffort: 'max' as EffortLevel,
    rejectsSamplingParams: false,
    // 兼容协议没有显式缓存断点，命中完全靠前缀逐字节稳定。
    minCacheablePrefix: 0,
    maxCacheBreakpoints: 0,
  }
  const flash: ModelSpec = {
    ...base,
    id: 'deepseek-v4-flash',
    displayName: 'DeepSeek V4 Flash',
    pricing: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite5m: 0, cacheWrite1h: 0 },
  }
  const pro: ModelSpec = {
    ...base,
    id: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    pricing: { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite5m: 0, cacheWrite1h: 0 },
  }
  /**
   * Responses 协议下的同一批模型，**能力不同所以单独一条**。
   *
   * 差别不是「协议名不一样」，是**我们能不能控制它思考**：
   * - 走 chat/completions 时客户端根本不发思考相关字段，无从控制 → `thinking: 'none'`。
   * - 走 Responses 时 `reasoning.effort:'none'` 能真的关掉 → `thinking: 'reasoning_effort'`。
   *
   * `thinksByDefault` 两边都是 **true**：省略字段它自己就思考。
   * 目录里原来写的 `false` 是错的——`qy probe` 早就打印过「省略字段时自己思考：是」，
   * 只是那个结论当时被 `toCapabilities` 一起丢掉了（见 ROADMAP §22.3）。
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
  })

  return [
    { ...flash, thinksByDefault: true },
    { ...pro, thinksByDefault: true },
    {
      ...flash,
      thinksByDefault: true,
      id: 'deepseek-chat',
      displayName: 'DeepSeek Chat（→ V4 Flash）',
    },
    {
      ...flash,
      thinksByDefault: true,
      id: 'deepseek-reasoner',
      displayName: 'DeepSeek Reasoner（→ V4 Flash）',
    },
    responses(flash),
    responses(pro),
    responses({ ...flash, id: 'deepseek-chat', displayName: 'DeepSeek Chat（→ V4 Flash）' }),
    responses({
      ...flash,
      id: 'deepseek-reasoner',
      displayName: 'DeepSeek Reasoner（→ V4 Flash）',
    }),
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
    vision: false,
    thinking: 'none',
    effortLevels: [],
    thinksByDefault: false,
    disableThinkingMaxEffort: 'max',
    rejectsSamplingParams: false,
    minCacheablePrefix: 1024,
    maxCacheBreakpoints: 4,
  }
}

/** 全部内置模型。仅用于能力约束与计价，不是可用模型的白名单。 */
export function builtinCatalog(now = Date.now()): ModelSpec[] {
  return [...claudeCatalog(now), ...deepseekCatalog()]
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

/** 按 usage 算这一轮的花费（美元）。 */
export function computeCost(
  spec: ModelSpec,
  usage: {
    inputTokens: number
    outputTokens: number
    cachedTokens?: number | null
    cacheWriteTokens?: number | null
  },
  cacheTtl: '5m' | '1h' = '5m',
): number {
  const p = spec.pricing
  const writeRate = cacheTtl === '1h' ? p.cacheWrite1h : p.cacheWrite5m
  const total =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      (usage.cachedTokens ?? 0) * p.cacheRead +
      (usage.cacheWriteTokens ?? 0) * writeRate) /
    1e6
  return round(total)
}
