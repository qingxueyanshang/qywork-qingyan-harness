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
   * 关闭思考所允许的最高 effort 档。null = 不允许关闭。
   * Opus 5：thinking:{type:'disabled'} 配 xhigh/max 直接 400。
   */
  disableThinkingMaxEffort: EffortLevel | null
  /** 采样参数是否被拒绝。Claude 5 系全部拒绝 temperature/top_p/top_k。 */
  /** 最小可缓存前缀（token）。低于此值加了 cache_control 也静默不缓存。 */
  minCacheablePrefix: number
  /** 提示缓存断点上限。 */
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
 * 另外三个问题：端点在哪、key 惯例上叫什么名字、旗下有哪些模型。
 * 合成一个的话「选了模型自动带出端点」就无从做起，因为协议里没有端点。
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
  /** 惯例上的环境变量名。 */
  apiKeyEnv: string
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
    apiKeyEnv: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    defaultKind: 'openai_compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    defaultKind: 'openai_compatible',
    // 带 `/v1`：DeepSeek 的 OpenAI 兼容端点在这一层，少了它是 404。
    defaultBaseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'google',
    displayName: 'Google',
    defaultKind: 'openai_compatible',
    apiKeyEnv: 'GEMINI_API_KEY',
  },
  { id: 'xai', displayName: 'xAI', defaultKind: 'openai_compatible', apiKeyEnv: 'XAI_API_KEY' },
  {
    id: 'alibaba',
    displayName: '阿里云百炼',
    defaultKind: 'openai_compatible',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
  },
  {
    id: 'moonshot',
    displayName: '月之暗面',
    defaultKind: 'openai_compatible',
    apiKeyEnv: 'MOONSHOT_API_KEY',
  },
  {
    id: 'zhipu',
    displayName: '智谱',
    defaultKind: 'openai_compatible',
    apiKeyEnv: 'ZHIPU_API_KEY',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    defaultKind: 'openai_compatible',
    apiKeyEnv: 'MINIMAX_API_KEY',
  },
]

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
    disableThinkingMaxEffort: 'max' as EffortLevel,
    // 兼容协议没有显式缓存断点，命中完全靠前缀逐字节稳定。
    minCacheablePrefix: 0,
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
    disableThinkingMaxEffort: 'max',
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
 * ## 删掉的三个能力位
 *
 * `vision` / `rejectsSamplingParams` / `maxCacheBreakpoints` 曾经在这里，
 * 三个都是零消费者，按 C1 删掉。
 *
 * `vision` 值得单说：它对绝大多数条目填的是 `false`，而语义是**未确认**不是
 * 「确认不支持」。拿它当门控会把一批实际支持视觉的中转站模型挡掉，
 * 而那种失败看起来像「图片发不出去」，查不到这里。**按不确定的数据做门控，
 * 比不做门控更糟。**
 *
 * `maxCacheBreakpoints` 只有两个取值：Anthropic 恒 4、兼容协议恒 0。
 * 那是**协议常量**不是模型能力，而我们只用 2 个断点——一个逐模型不变的字段，
 * 放在逐模型的目录里就是误导。断点数写在用它的那个适配器里。
 */
function openAiCompatCatalog(): ModelSpec[] {
  const base = {
    provider: 'openai_compatible' as const,
    disableThinkingMaxEffort: 'max' as EffortLevel,
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
    // ── OpenAI GPT-5.6 ──
    {
      ...base,
      ...effort(FIVE),
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      vendor: 'openai',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: usd(5, 30, 0.5, 6.25),
    },
    {
      ...base,
      ...effort(FIVE),
      id: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      vendor: 'openai',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: usd(2.5, 15, 0.25, 3.125),
    },
    {
      ...base,
      ...effort(FIVE),
      id: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      vendor: 'openai',
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000,
      pricing: usd(1, 6, 0.1, 1.25),
    },

    // ── Google Gemini ──
    // flash 两款厂商还给了一档 `minimal`。它不在 EffortLevel 词表里，
    // **不为它扩词表**——扩了就得让所有消费方都认一个只有一家用的档，
    // 而少这一档只是少一个更省的选项。
    {
      ...base,
      ...effort(['low', 'medium', 'high']),
      id: 'gemini-3.1-pro',
      displayName: 'Gemini 3.1 Pro',
      vendor: 'google',
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      pricing: usd(2, 12, 0.2),
    },
    {
      ...base,
      ...effort(['low', 'medium', 'high']),
      id: 'gemini-3.6-flash',
      displayName: 'Gemini 3.6 Flash',
      vendor: 'google',
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      pricing: usd(0.3, 2.5, 0.03),
    },
    {
      ...base,
      ...effort(['low', 'medium', 'high']),
      id: 'gemini-3.5-flash',
      displayName: 'Gemini 3.5 Flash',
      vendor: 'google',
      contextWindow: 1_000_000,
      maxOutputTokens: 64_000,
      pricing: usd(0.3, 2.5, 0.03),
    },

    // ── xAI ──
    {
      ...base,
      ...effort(['low', 'medium', 'high']),
      id: 'grok-4.5',
      displayName: 'Grok 4.5',
      vendor: 'xai',
      contextWindow: 500_000,
      maxOutputTokens: 64_000,
      pricing: usd(2, 6, 0.2),
    },

    // ── 阿里云百炼 Qwen（人民币标价）──
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

/** 全部内置模型。仅用于能力约束与计价，不是可用模型的白名单。 */
export function builtinCatalog(now = Date.now()): ModelSpec[] {
  return [...claudeCatalog(now), ...deepseekCatalog(), ...openAiCompatCatalog()]
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

/** 按 usage 算这一轮的花费（美元）。 */
export function computeCost(
  spec: ModelSpec,
  usage: {
    inputTokens: number
    outputTokens: number
    cachedTokens?: number | null
    cacheWriteTokens?: number | null
  },
): number {
  const p = spec.pricing
  // 只按 5 分钟档算：全项目从不请求 1 小时缓存。`cacheWrite1h` 留在价目表里是
  // **参考数据**（它是真实价格），不是可达的代码分支——曾经这里有一个 cacheTtl 参数，
  // 而没有任何调用方传过它，那条 1h 分支永远走不到。
  const writeRate = p.cacheWrite5m
  const total =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      (usage.cachedTokens ?? 0) * p.cacheRead +
      (usage.cacheWriteTokens ?? 0) * writeRate) /
    1e6
  return round(total)
}
