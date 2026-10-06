/**
 * 模型目录与计价。
 *
 * 本目录是**内置基线**，不是白名单：用户在设置中填写的任意 model id 均可运行（BYOK 自定义
 * 接口为必备能力）。目录提供模型能力、计价、请求参数约束与官方端点。
 * 未知模型使用保守参数，需要用户指定端点。
 *
 * 口径来源：Anthropic 官方文档（2026-09-02 快照）。改动前先核对，不要凭记忆填写。
 */

import type {
  CacheRouting,
  EffortLevel,
  ProviderKind,
  ReasoningEcho,
  ThinkingMode,
  ToolSchemaMode,
} from '@qywork/core'
import { DEFAULT_DENSITY, type TokenDensity } from './tokens.ts'
import type { TransportCapabilities } from './types.ts'

/**
 * 每百万 token 的单价。
 *
 * **币种是价目的一部分。** 阿里、月之暗面、智谱等厂商的官网按人民币标价，
 * 把 ¥6 当作 $6 会使账面相差约七倍。因此价目携带 `currency`，由消费方决定如何显示、
 * 是否合计，不在此处换算为没有出处的美元金额。
 */
export interface Pricing {
  /** null = 未公布按 token 单价，不代表免费。 */
  input: number | null
  output: number | null
  /** 省略即 `'USD'`，美元价目无需逐条填写。 */
  currency?: 'USD' | 'CNY'
  /** 缓存读取，通常是 input 的 0.1 倍。 */
  cacheRead: number | null
  /** 缓存写入（5 分钟 TTL），通常是 input 的 1.25 倍。 */
  cacheWrite5m: number | null
  /** 缓存写入（1 小时 TTL），通常是 input 的 2 倍。 */
  cacheWrite1h: number | null
  /** 订阅或单价可用范围，随模型库价目显示。 */
  note?: string
}

/** 历史思考内容的回放规则；自定义模型覆盖与内置目录共用。 */
export const CHAT_REASONING_PROTOCOLS = [
  'standard',
  'preserved',
  'qwen_preserved',
  'glm_preserved',
  'deepseek_preserved',
] as const
export type ChatReasoningProtocol = (typeof CHAT_REASONING_PROTOCOLS)[number]

export interface ModelSpec {
  id: string
  displayName: string
  /** **协议**，不是厂商。见 `Vendor` 上的注释。 */
  provider: ProviderKind
  /**
   * 厂商 id（`VENDORS` 中的条目）。`null` 表示未收录，来自用户自建端点。
   *
   * 逐条显式填写，不按 id 前缀推断（CLAUDE.md B1）：任何从名称推断行为
   * 的做法都须先考虑反例，而中转站的模型名可以是任意字符串。
   */
  vendor: string | null
  contextWindow: number
  /**
   * 该模型 tokenizer 的 token 密度。三档的标定方法与边界见 `tokens.ts` 的 `TokenDensity`。
   *
   * **必填，不设默认值。** 新增模型时若未实测，显式填写 `DEFAULT_DENSITY`：
   * 该档为上界，读数偏高但不会低估。改为可选字段会导致遗漏，
   * 遗漏时该模型的读数改按其他密度估算，且不报错。
   */
  density: TokenDensity
  /**
   * 模型单次输出的 token 上限。**`null` 表示未实测，不申报。**
   *
   * `null` 与「上限为某个较小数值」含义不同，不得合并（与 `catalogued` 同理）：
   * 在此填写臆测的数值，模型的长输出会被静默截断在该数值处，用户只看到
   * `stop_reason: max_tokens`。OpenAI 系协议下 `null` 表示不发送该字段，
   * 由端点使用自身默认值；Anthropic 协议要求该字段，见 `anthropic.ts` 的后备取值。
   */
  maxOutputTokens: number | null
  /**
   * 是否接受图片输入。**三态**，与 `maxOutputTokens` 惯例相同：
   * `null` 表示厂商规格页未注明且未实测，**不表示「不支持」**。
   *
   * **门控只拦截 `false`。** `null` 一律放行：中转站的模型名是任意字符串，
   * 目录无法识别，依据不确定的数据拦截请求比放行更糟：这种失败表现为
   * 「图片无法发送」，无法追溯到此处。判定有误时在模型库的对应字段覆盖（`SpecOverride`）。
   *
   * 逐条按厂商规格页填写，**不按 id 前缀推断**（与 `vendor` 同理）：
   * `qwen3.7-max` 基础版只接受文本，而其快照版接受图片，无法从名称区分。
   *
   * 消费方有三处：模型库的对应列、输入框的图片附件入口、`agent` 装配请求时的后备处理
   * （为 `false` 时图像块替换为文本注记，历史中的图片与工具返回的图片同样替换）。
   */
  vision: boolean | null
  /** 只有官方协议与当前适配器都核实支持时才为 true。未知模型按 false 处理。 */
  video: boolean
  pricing: Pricing
  thinking: ThinkingMode
  /**
   * 带 tool_calls 的历史是否回传推理原文。与 `thinking` 相互独立：DeepSeek 的
   * Responses 条目与 OpenAI 同为 `reasoning_effort`，`thinking` 描述的是 effort 的控制方式。
   */
  reasoningEcho: ReasoningEcho
  /**
   * Chat Completions 的历史思考协议。
   *
   * `standard`：只为带 tool_calls 的 assistant 消息回放 `reasoning_content`。
   * `preserved`：回放全部历史思考，不增加请求开关；Qwen / GLM 另需请求开关，
   * 否则请求体启用了保留思考，而历史投影仍会丢弃思考内容。
   */
  chatReasoningProtocol: ChatReasoningProtocol
  /**
   * OpenAI 兼容协议的工具参数 schema 规则（字段名沿用已有配置）。
   *
   * `openai_strict` 将可选属性改为「必填但可为 null」并发送 `strict:true`；
   * `native` 保留模型库注册时的原生 required/optional 结构。不能按
   * OpenAI-compatible 接口名统一选择：兼容基础字段不等于兼容 strict 采样规则。
   */
  chatToolSchema: ToolSchemaMode
  /**
   * 支持的 effort 档位。空数组=不支持 effort 参数。
   */
  effortLevels: EffortLevel[]
  /**
   * 省略 thinking 字段时是否仍然会思考。
   * Opus 5 / Sonnet 5 为 true。该值决定 maxOutputTokens 的预留：思考与正文
   * 共用同一个上限，按「不思考」调小 max_tokens 会使回答在中途被截断。
   */
  thinksByDefault: boolean
  /**
   * 系统提示词末尾是否附 Anthropic 官方的输出上限说明（`runtime/prompt.ts` 的 `outputLimitNote`）。
   * Claude 会先在思考中写出完整交付物，再在回复中重写一遍，单次输出因此接近 `maxOutputTokens`
   * 而被截断；该官方文本引导模型将思考用于决策。文本以 Claude 自称，只对 Claude 条目启用。
   */
  outputLimitNote?: true
  /**
   * 该模型在当前协议上将请求路由到同一缓存分片的方式。
   *
   * **它是「接口 × 模型」组合的属性，不是模型的属性。** 同一个模型在两个
   * 中转站上表现可能完全不同，因此内置值只是 seed，端点侧由配置中的对应字段覆盖
   * （`SpecOverride`），用户在模型库界面的对应字段中修改。
   *
   * **`qy probe` 不探测该项。** 探针只能发送几次请求观察是否命中，而在缓存路由不确定的链路上
   * 结果是随机的；将一次「可用」的探测结果写回目录，会把偶然结果固化为结论。
   *
   * **发送不等于命中。** 2026-08-19 在一个中转端点上配对实测：
   * 同一时间窗内逐轮交替发送有键与无键请求各 12 轮，无键命中 5/12、有键 0/12，
   * 换一个时间窗结果相反。缓存路由本身不确定时，该字段无法保证命中：
   * 它只是协议规定的做法，不能解决未命中问题。
   *
   * `'none'` 表示**未测**，不表示不支持：未收录的模型一律取该值，
   * 不发送任何额外字段，自建端点因此不会收到无法识别的字段。
   */
  cacheRouting: CacheRouting
  /** 最小可缓存前缀（token）。低于此值时即使设置 cache_control 也不会缓存，且不报错。 */
  minCacheablePrefix: number
  /**
   * 分时段折扣。省略表示全天单一价格，绝大多数模型如此。
   *
   * **`pricing` 是基准价（高峰价），本字段只描述折扣时段。**
   * 存储两套完整价目会产生「修改了高峰价而未修改空闲价」的不一致，
   * 且两套数字看起来都正确。
   */
  offPeak?: OffPeakDiscount
  /**
   * 用量阶梯价，**按 `thresholdTokens` 升序排列**。省略表示不论请求大小均为同一价格。
   * 与 `offPeak` 相同，`pricing` 是标准价，本字段只描述换档条件。
   *
   * 使用数组而不是单档：阿里的两款 flash 模型分三档（≤32K / 32K–256K / 256K–1M），
   * 只保留一档就必须在「中间档记高」与「最长档记低」之间选择，
   * 两种选择都会静默记错金额。
   */
  longContext?: readonly LongContextTier[]
  /**
   * 该 spec 是否来自内置目录。
   *
   * 只有 `unknownModel()` 将其设为 `false`。**省略即视为已收录**，
   * 向目录添加模型时无需逐条填写 `catalogued: true`
   * （否则漏写的条目会被误报为未收录，误报会使用户忽略该提示）。
   *
   * 它区分「未测」与「不支持」，见 `unknownModel()` 上的注释与 ARCHITECTURE §27。
   */
  catalogued?: boolean
}

/** 厂商及各协议的官方端点。端点只作为 Base URL 留空时的默认值，不写入配置。 */
export interface Vendor {
  id: string
  displayName: string
  /** 未登记的协议需要显式配置端点。 */
  baseUrls: Partial<Record<ProviderKind, string>>
}

/**
 * DeepSeek 的 tokenizer 密度。斜率法实测（2026-08-26，`deepseek-v4-flash-vision-exp`）：
 * 中文 0.569 token/字、真实源码 2.71–3.00 字符/token、工具结果整条 2.53 字符/token。
 * 三档均取略高于实测值的上界，在四份真实样本上估算值为实际值的 1.03–1.12 倍。生僻字未实测，取 `DEFAULT_DENSITY` 的字节级上界。
 */
const DEEPSEEK_DENSITY: TokenDensity = {
  cjkTokensPerChar: 0.6,
  rareCjkTokensPerChar: DEFAULT_DENSITY.rareCjkTokensPerChar,
  textCharsPerToken: 3,
  jsonCharsPerToken: 2.5,
}

/**
 * Google 的 tokenizer 密度。同法实测（2026-08-26，`gemini-3.7-flash`）：
 * 中文 0.647 token/字、真实源码 2.42 字符/token、工具结果 2.43 字符/token。
 * 文本档的字符/token 值低于 DeepSeek，因为其源码 token 密度实测更高。生僻字未实测，取 `DEFAULT_DENSITY` 的字节级上界。
 */
const GOOGLE_DENSITY: TokenDensity = {
  cjkTokensPerChar: 0.7,
  rareCjkTokensPerChar: DEFAULT_DENSITY.rareCjkTokensPerChar,
  textCharsPerToken: 2.5,
  jsonCharsPerToken: 2.5,
}

export const VENDORS: readonly Vendor[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    baseUrls: {
      anthropic_messages: 'https://api.anthropic.com',
      openai_chat_completions: 'https://api.anthropic.com/v1',
    },
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    baseUrls: {
      openai_chat_completions: 'https://api.openai.com/v1',
      openai_responses: 'https://api.openai.com/v1',
    },
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    baseUrls: {
      openai_chat_completions: 'https://api.deepseek.com/v1',
      openai_responses: 'https://api.deepseek.com/v1',
      anthropic_messages: 'https://api.deepseek.com/anthropic',
    },
  },
  {
    id: 'xiaomi',
    displayName: '小米 MiMo',
    baseUrls: {
      openai_chat_completions: 'https://api.xiaomimimo.com/v1',
      openai_responses: 'https://api.xiaomimimo.com/v1',
      anthropic_messages: 'https://api.xiaomimimo.com/anthropic',
    },
  },
  {
    id: 'google',
    displayName: 'Google',
    baseUrls: {
      openai_chat_completions: 'https://generativelanguage.googleapis.com/v1beta/openai',
    },
  },
  {
    id: 'xai',
    displayName: 'xAI',
    baseUrls: {
      openai_chat_completions: 'https://api.x.ai/v1',
      openai_responses: 'https://api.x.ai/v1',
    },
  },
  {
    id: 'alibaba',
    displayName: '阿里云百炼',
    baseUrls: {
      openai_chat_completions: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      anthropic_messages: 'https://dashscope.aliyuncs.com/apps/anthropic',
    },
  },
  {
    id: 'moonshot',
    displayName: '月之暗面',
    baseUrls: { openai_chat_completions: 'https://api.moonshot.cn/v1' },
  },
  {
    id: 'zhipu',
    displayName: '智谱',
    baseUrls: { openai_chat_completions: 'https://open.bigmodel.cn/api/paas/v4' },
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    baseUrls: {
      openai_chat_completions: 'https://api.minimax.cn/v1',
      openai_responses: 'https://api.minimax.cn/v1',
      anthropic_messages: 'https://api.minimax.cn/anthropic',
    },
  },
  {
    id: 'stepfun',
    displayName: '阶跃星辰',
    baseUrls: {
      openai_chat_completions: 'https://api.stepfun.com/v1',
      anthropic_messages: 'https://api.stepfun.com',
    },
  },
]

/** 以模型库声明的厂商和所选协议解析官方端点，不根据模型名称推测厂商。 */
export function officialBaseUrl(spec: Pick<ModelSpec, 'vendor' | 'provider'>): string | undefined {
  return VENDORS.find((vendor) => vendor.id === spec.vendor)?.baseUrls[spec.provider]
}

/**
 * 长上下文阶梯价。
 *
 * **达到阈值后整条请求按高档计价，而不是只有超出部分按高档计价。**
 * 按 xAI 价目说明，一条 21 万 token 的请求不是「20 万按标准价 + 1 万按高价」，
 * 而是整条按高价。按超出部分计价会少记近一半费用，且少记不会产生任何报错。
 *
 * **高档单价按厂商价目表的第二行逐项录入，不按倍率推算。** 各厂商的倍率不统一：
 * OpenAI 与 Google 的输入为 2 倍、输出为 1.5 倍，xAI 的输入与输出均为 2 倍。
 * 存储倍率需要自行计算比值，计算错误不会有任何提示。
 *
 * 阈值比较的是**提示词**大小（未命中输入 + 命中输入），不含输出：
 * 档位按请求发出时的提示词确定，此时输出尚未产生；厂商同样按提示词大小分档。
 */
export interface LongContextTier {
  /**
   * **第一个进入高档的提示词 token 数**（含）。
   *
   * 各厂商的边界写法不同：xAI 写「≥200k」，Google 写「>200k」。
   * 统一为「第一个进入高档的数」，不另设比较符字段：多一个字段就多一处
   * 写反的可能，写反会使整整一档的费用记错。
   */
  thresholdTokens: number
  /** 输出达到该值才进入此档；省略表示不考虑输出。用于厂商明确按输入与输出双轴计价的模型。 */
  minOutputTokens?: number
  input: number
  output: number
  cacheRead: number
  /** 长上下文档的缓存写入价；省略时沿用基础档。 */
  cacheWrite5m?: number
  /** 长上下文档的 1 小时缓存写入价；省略时沿用基础档。 */
  cacheWrite1h?: number
  /** 单句说明，界面直接显示。 */
  note: string
}

/**
 * 分时段折扣。**时段按 UTC 的星期与小时表示，不按本机时区。**
 *
 * 厂商公布的是当地时间（DeepSeek 使用北京时间），而本机可能处于任何时区，
 * 使用 `getHours()` 等于把用户时区当作厂商时区：在美国运行时全天档位判定错误，
 * 错误只表现为账本上偏低或偏高的金额，不会产生任何报错。
 * 因此录入时即换算为 UTC，`priceAt` 只使用 `getUTCHours()`。
 *
 * **记录「高峰时段」而不是「折扣时段」**，与厂商的表述一致。DeepSeek 的表述是「高峰时段为北京时间
 * 9:00-12:00、14:00-18:00 （其余为空闲时段）」：记录高峰时段可直接转录，记录折扣时段则需自行计算补集，
 * 计算错误不会有任何提示。
 */
export interface OffPeakDiscount {
  /** 折扣系数，与每一档单价相乘。DeepSeek 空闲时段价格为高峰价的一半，即 0.5。 */
  rate: number
  /**
   * 高峰时段（不打折），`[起, 止)` 半开区间，UTC 小时，可带小数（`9.5` = 09:30）。
   * 跨零点的时段拆为两段填写，不做环形判断：环形判断只有此处使用，
   * 写错会使整个时段计价错误。
   */
  peakWindowsUtc: readonly (readonly [number, number])[]
  /**
   * 高峰时段仅在所列星期生效，按 `getUTCDay()` 取值（0 = 周日）。未列出的日期
   * 全天按空闲价。星期与小时必须同为 UTC：混用两个时区会在时段跨零点时错开一天。
   */
  peakWeekdaysUtc: readonly number[]
  /** 单句说明，界面直接显示，不另行拼接。 */
  note: string
}

/**
 * DeepSeek 的高峰时段：北京时间**周一至周五** 9:00-12:00、14:00-18:00（UTC+8），
 * 周六、周日全天按空闲价。
 *
 * 换算为 UTC 为 01:00-04:00 与 06:00-10:00，星期无需调整：两段时段均位于同一个
 * UTC 日内。时段若改为跨零点，星期表需相应顺移一天。
 * 数据来源：官方文档「模型 & 价格」页（2026-08-17 生效的价目）。
 */
const DEEPSEEK_OFF_PEAK: OffPeakDiscount = {
  rate: 0.5,
  peakWindowsUtc: [
    [1, 4],
    [6, 10],
  ],
  peakWeekdaysUtc: [1, 2, 3, 4, 5],
  note: '空闲时段 5 折（高峰＝北京时间周一至周五 9:00-12:00、14:00-18:00）',
}

/**
 * Gemini 3.1 Pro 的长上下文档：官方标注「>200k」，因此第一个进入高档的值是 200001。
 * 输入为 2 倍、输出为 1.5 倍，倍率不统一，按价目表逐项录入。
 */
const GEMINI_31_PRO_LONG: LongContextTier = {
  thresholdTokens: 200_001,
  input: 4,
  output: 18,
  cacheRead: 0.4,
  note: '提示词超过 20 万 token 后整条请求按 $4 / $18（缓存 $0.4）计价',
}

const GPT_6_ASTRA_LONG: LongContextTier = {
  thresholdTokens: 272_001,
  input: 20,
  output: 75,
  cacheRead: 2,
  cacheWrite5m: 25,
  cacheWrite1h: 25,
  note: '提示词超过 272K token 后整条请求按 $20 / $75（缓存 $2）计价',
}

const GPT_6_SOL_LONG: LongContextTier = {
  thresholdTokens: 272_001,
  input: 4,
  output: 15,
  cacheRead: 0.4,
  cacheWrite5m: 5,
  cacheWrite1h: 5,
  note: '提示词超过 272K token 后整条请求按 $4 / $15（缓存 $0.4）计价',
}

const GPT_61_SOL_LONG: LongContextTier = {
  thresholdTokens: 272_001,
  input: 4,
  output: 15,
  cacheRead: 0.2,
  cacheWrite5m: 5,
  cacheWrite1h: 5,
  note: '提示词超过 272K token 后整条请求按 $4 / $15（缓存 $0.2）计价',
}

const GPT_6_LUNA_LONG: LongContextTier = {
  thresholdTokens: 272_001,
  input: 0.2,
  output: 0.75,
  cacheRead: 0.02,
  cacheWrite5m: 0.25,
  cacheWrite1h: 0.25,
  note: '提示词超过 272K token 后整条请求按 $0.2 / $0.75（缓存 $0.02）计价',
}

const GPT_56_SOL_LONG: LongContextTier = {
  thresholdTokens: 272_001,
  input: 8,
  output: 30,
  cacheRead: 0.8,
  cacheWrite5m: 10,
  cacheWrite1h: 10,
  note: '提示词超过 272K token 后整条请求按 $8 / $30（缓存 $0.8）计价',
}

const GPT_56_TERRA_LONG: LongContextTier = {
  thresholdTokens: 272_001,
  input: 4,
  output: 18,
  cacheRead: 0.4,
  cacheWrite5m: 5,
  cacheWrite1h: 5,
  note: '提示词超过 272K token 后整条请求按 $4 / $18（缓存 $0.4）计价',
}

const GPT_56_LUNA_LONG: LongContextTier = {
  thresholdTokens: 272_001,
  input: 0.4,
  output: 1.8,
  cacheRead: 0.04,
  cacheWrite5m: 0.5,
  cacheWrite1h: 0.5,
  note: '提示词超过 272K token 后整条请求按 $0.4 / $1.8（缓存 $0.04）计价',
}

/** xAI 官方价目表：提示词达到 20 万后，整条请求按 $4 / $12 / 缓存 $1 计价。 */
const GROK_46_47_LONG: LongContextTier = {
  thresholdTokens: 200_000,
  input: 4,
  output: 12,
  cacheRead: 1,
  note: '提示词满 20 万 token 后整条请求按 $4 / $12（缓存 $1）计价',
}

/** 同上，4.5 的缓存价为 $0.60 而不是 $1。 */
const GROK_45_LONG: LongContextTier = {
  thresholdTokens: 200_000,
  input: 4,
  output: 12,
  cacheRead: 0.6,
  note: '提示词满 20 万 token 后整条请求按 $4 / $12（缓存 $0.6）计价',
}

const MINIMAX_M3_LONG: LongContextTier = {
  thresholdTokens: 524_289,
  input: 0.6,
  output: 2.4,
  cacheRead: 0.12,
  note: '输入超过 512K token 后整条请求按 $0.6 / $2.4（缓存 $0.12）计价',
}

/* 智谱国内站按千 token 分界，因此此处的 32K 为 32,000，不是 32,768。 */
const GLM_47_TIERS: readonly LongContextTier[] = [
  {
    thresholdTokens: 0,
    minOutputTokens: 200,
    input: 3,
    output: 14,
    cacheRead: 0.6,
    note: '输入不足 32K、输出满 200 token 后整条请求按 ¥3 / ¥14（缓存 ¥0.6）计价',
  },
  {
    thresholdTokens: 32_000,
    input: 4,
    output: 16,
    cacheRead: 0.8,
    note: '输入满 32K token 后整条请求按 ¥4 / ¥16（缓存 ¥0.8）计价',
  },
]

const GLM_5V_TURBO_LONG: LongContextTier = {
  thresholdTokens: 32_000,
  input: 7,
  output: 26,
  cacheRead: 1.8,
  note: '输入满 32K token 后整条请求按 ¥7 / ¥26（缓存 ¥1.8）计价',
}

const GLM_46V_LONG: LongContextTier = {
  thresholdTokens: 32_000,
  input: 2,
  output: 6,
  cacheRead: 0.4,
  note: '输入满 32K token 后整条请求按 ¥2 / ¥6（缓存 ¥0.4）计价',
}

/*
 * 阿里的阶梯价按输入长度分档，价目页注明 **K = 1,000、M = 1,000,000**。
 * 区间为左开右闭（「32K-256K」不含 32,000），因此第一个进入高档的值为边界 + 1。
 */

/** qwen3.7-plus：超过 256K 后整条请求按 ¥6 / ¥24 / 命中 ¥1.2 计价。 */
const QWEN_37_PLUS_LONG: LongContextTier = {
  thresholdTokens: 256_001,
  input: 6,
  output: 24,
  cacheRead: 1.2,
  note: '输入超过 256K token 后整条请求按 ¥6 / ¥24（缓存 ¥1.2）计价',
}

/** qwen3.7-flash：三档，官方页面逐档给出了命中价。 */
const QWEN_37_FLASH_LONG: readonly LongContextTier[] = [
  {
    thresholdTokens: 32_001,
    input: 0.6,
    output: 2.4,
    cacheRead: 0.12,
    note: '输入超过 32K token 后整条请求按 ¥0.6 / ¥2.4（缓存 ¥0.12）计价',
  },
  {
    thresholdTokens: 256_001,
    input: 1.2,
    output: 4.8,
    cacheRead: 0.24,
    note: '输入超过 256K token 后整条请求按 ¥1.2 / ¥4.8（缓存 ¥0.24）计价',
  },
]

/**
 * qwen3-vl-plus 与 qwen3-vl-flash：各三档。
 *
 * **命中价只有第一档有官方数据**（均为输入价的 20%，如 flash 的 ¥0.03），后两档按同一比例推算。
 * 不推算时后两档只能沿用第一档的命中价，相当于把长请求按最短档记账。
 */
const QWEN_VL_PLUS_LONG: readonly LongContextTier[] = [
  {
    thresholdTokens: 32_001,
    input: 1.5,
    output: 15,
    cacheRead: 0.3,
    note: '输入超过 32K token 后整条请求按 ¥1.5 / ¥15（缓存 ¥0.3）计价',
  },
  {
    thresholdTokens: 128_001,
    input: 3,
    output: 30,
    cacheRead: 0.6,
    note: '输入超过 128K token 后整条请求按 ¥3 / ¥30（缓存 ¥0.6）计价',
  },
]

const QWEN_VL_FLASH_LONG: readonly LongContextTier[] = [
  {
    thresholdTokens: 32_001,
    input: 0.3,
    output: 3,
    cacheRead: 0.06,
    note: '输入超过 32K token 后整条请求按 ¥0.3 / ¥3 计价',
  },
  {
    thresholdTokens: 128_001,
    input: 0.6,
    output: 6,
    cacheRead: 0.12,
    note: '输入超过 128K token 后整条请求按 ¥0.6 / ¥6 计价',
  },
]

/**
 * 计算给定时刻、给定大小的请求的实际单价。
 *
 * **目录中的价格是厂商公布的标准价**，本函数在其上叠加两种偏离标准价的情况：
 * 分时段折扣（按星期与小时）与长上下文档（按提示词大小）。两者相互独立，
 * 直接连乘：目前没有厂商同时采用两者，但代码无需为此增加分支。
 *
 * 两者均不适用时返回 `spec.pricing` 本身，**即同一个对象引用**：
 * 绝大多数模型属于此情形，无需每次新建对象。
 */
export function priceAt(
  spec: ModelSpec,
  ctx: { now?: number; promptTokens?: number; outputTokens?: number } = {},
): Pricing {
  let rate = 1
  if (spec.offPeak) {
    const d = new Date(ctx.now ?? Date.now())
    const hour = d.getUTCHours() + d.getUTCMinutes() / 60
    const peak =
      spec.offPeak.peakWeekdaysUtc.includes(d.getUTCDay()) &&
      spec.offPeak.peakWindowsUtc.some(([from, to]) => hour >= from && hour < to)
    if (!peak) rate *= spec.offPeak.rate
  }
  // 取提示词达到的**最高**一档。依赖 `longContext` 升序排列，该约定写在字段注释上。
  let long: LongContextTier | undefined
  for (const tier of spec.longContext ?? []) {
    if (
      (ctx.promptTokens ?? 0) >= tier.thresholdTokens &&
      (ctx.outputTokens ?? 0) >= (tier.minOutputTokens ?? 0)
    ) {
      long = tier
    }
  }
  if (rate === 1 && !long) return spec.pricing
  const p = spec.pricing
  const base = long
    ? {
        ...p,
        input: long.input,
        output: long.output,
        cacheRead: long.cacheRead,
        ...(long.cacheWrite5m !== undefined ? { cacheWrite5m: long.cacheWrite5m } : {}),
        ...(long.cacheWrite1h !== undefined ? { cacheWrite1h: long.cacheWrite1h } : {}),
      }
    : p
  if (rate === 1) return base
  return {
    ...base,
    input: base.input === null ? null : round(base.input * rate),
    output: base.output === null ? null : round(base.output * rate),
    cacheRead: base.cacheRead === null ? null : round(base.cacheRead * rate),
    cacheWrite5m: base.cacheWrite5m === null ? null : round(base.cacheWrite5m * rate),
    cacheWrite1h: base.cacheWrite1h === null ? null : round(base.cacheWrite1h * rate),
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
 * Gemini 3.6 / 3.7 / 3.8 Flash 的促销价，2026-12-31 之后恢复为 $1.50 / $7.50 / $0.15。
 *
 * **按当前时间取值，不硬编码**，否则自 1 月 1 日起账单会静默算错。
 */
const GEMINI_FLASH_PROMO_ENDS = Date.UTC(2026, 11, 31, 23, 59, 59)

function geminiFlashPromo(now: number): Pricing {
  return now <= GEMINI_FLASH_PROMO_ENDS
    ? { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite5m: 0, cacheWrite1h: 0 }
    : { input: 1.5, output: 7.5, cacheRead: 0.15, cacheWrite5m: 0, cacheWrite1h: 0 }
}

/**
 * GLM-5.3-Flash 国内站限时半价，有效期至 2026-08-31；北京时间九月一日零点恢复原价。
 *
 * 与 `geminiFlashPromo` 结构与理由相同：**按当前时间取值，不硬编码**，
 * 否则自九月一日起账单会静默算错。
 */
const GLM_53_FLASH_PROMO_EXPIRES = Date.UTC(2026, 7, 31, 16, 0, 0)

function glm53FlashPromo(now: number): Pricing {
  return now < GLM_53_FLASH_PROMO_EXPIRES
    ? {
        input: 0.4,
        output: 1.4,
        cacheRead: 0.115,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        currency: 'CNY',
      }
    : {
        input: 0.8,
        output: 2.8,
        cacheRead: 0.23,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        currency: 'CNY',
      }
}

const CLAUDE_BASE = {
  provider: 'anthropic_messages' as const,
  vendor: 'anthropic',
  contextWindow: 1_000_000,
  /*
   * **未经直连实测。** 斜率法仅在中转站上测得中文约 1.03 token/字，同一段文本
   * 改变长度重测时斜率在 1.03 与 1.31 之间波动，结果不可采信。上界档对其偏保守，
   * 读数偏高。直连实测后在此填写对应的密度。
   */
  density: DEFAULT_DENSITY,
  maxOutputTokens: 128_000,
  // Claude 5 与 4 系均接受图片输入（见官方模型页的输入模态一栏）。
  vision: true,
  video: false,
  // Anthropic 使用显式 `cache_control` 断点，没有缓存路由字段。
  cacheRouting: 'none' as const,
  thinking: 'adaptive_only' as const,
  reasoningEcho: 'none' as const,
  chatReasoningProtocol: 'standard' as const,
  chatToolSchema: 'native' as const,
  // 按实测填写，不引用 EFFORT_ORDER：引用它等于假定 Anthropic 支持今后新增的所有档位。
  effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] as EffortLevel[],
  outputLimitNote: true as const,
}

export function claudeCatalog(): ModelSpec[] {
  return [
    {
      ...CLAUDE_BASE,
      id: 'claude-opus-5-5',
      displayName: 'Claude Opus 5.5',
      pricing: { ...anthropicPricing(4, 20), cacheRead: 0.2 },
      thinking: 'always_on',
      thinksByDefault: true,
      minCacheablePrefix: 512,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-fable-5-1',
      displayName: 'Claude Fable 5.1',
      // 5.1 的缓存读取是输入价的 0.025 倍；写入仍是 1.25 / 2 倍。
      pricing: { ...anthropicPricing(10, 50), cacheRead: 0.25 },
      thinking: 'always_on',
      thinksByDefault: true,
      minCacheablePrefix: 512,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-opus-5',
      displayName: 'Claude Opus 5',
      pricing: anthropicPricing(5, 25),
      thinksByDefault: true,
      minCacheablePrefix: 512,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-sonnet-5',
      displayName: 'Claude Sonnet 5',
      pricing: anthropicPricing(2, 10),
      thinksByDefault: true,
      minCacheablePrefix: 1024,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-fable-5',
      displayName: 'Claude Fable 5',
      pricing: anthropicPricing(10, 50),
      // 思考始终开启：发送 {type:'disabled'} 也返回 400，只能完全省略 thinking 字段。
      thinking: 'always_on',
      thinksByDefault: true,
      minCacheablePrefix: 512,
    },
    {
      ...CLAUDE_BASE,
      id: 'claude-opus-4-8',
      displayName: 'Claude Opus 4.8',
      pricing: anthropicPricing(5, 25),
      // 4.8 省略 thinking 时不思考，与 Opus 5 相反。
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

/** DeepSeek 当前模型规格。价格为人民币高峰价，空闲时段五折。 */
function deepseekCatalog(): ModelSpec[] {
  const flash: ModelSpec = {
    id: 'deepseek-flash',
    displayName: 'DeepSeek V4.1 Flash',
    provider: 'openai_chat_completions',
    vendor: 'deepseek',
    contextWindow: 1_000_000,
    density: DEFAULT_DENSITY,
    maxOutputTokens: 384_000,
    thinking: 'deepseek_thinking',
    vision: true,
    video: false,
    reasoningEcho: 'none',
    chatReasoningProtocol: 'deepseek_preserved',
    chatToolSchema: 'openai_strict',
    effortLevels: ['low', 'high', 'max'],
    thinksByDefault: true,
    minCacheablePrefix: 0,
    cacheRouting: 'none',
    offPeak: DEEPSEEK_OFF_PEAK,
    pricing: {
      input: 2,
      output: 8,
      currency: 'CNY',
      cacheRead: 0.04,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
    },
  }
  // 官方已撤回 Pro 的下线安排，Pro 按自身单价继续提供服务；不要按日期将其切换为 Flash。
  const pro: ModelSpec = {
    ...flash,
    id: 'deepseek-v4-pro',
    displayName: 'DeepSeek V4 Pro',
    density: DEEPSEEK_DENSITY,
    vision: false,
    pricing: { ...flash.pricing, input: 9, output: 27, cacheRead: 0.3 },
  }
  return [flash, pro].flatMap((model): ModelSpec[] => [
    model,
    {
      ...model,
      provider: 'openai_responses',
      thinking: 'reasoning_effort',
      reasoningEcho: 'reasoning_text',
    },
    // 默认开启思考；Anthropic 兼容接口通过 output_config.effort 选择档位。
    { ...model, provider: 'anthropic_messages', thinking: 'deepseek_thinking' },
  ])
}

/**
 * MiMo 官方规格与国内按量价格，2026-09-22 核对。
 * https://mimo.mi.com/docs/zh-CN/price/pay-as-you-go
 * https://mimo.mi.com/docs/zh-CN/api/chat/responses
 * 正向 effort 值均开启同一种思考，不声明独立强度；三协议均保留历史思考。
 */
function mimoCatalog(): ModelSpec[] {
  const models = [
    { id: 'mimo-v2.6-pro', displayName: 'MiMo V2.6 Pro', input: 3, output: 6, cacheRead: 0.025 },
    { id: 'mimo-v2.6-flash', displayName: 'MiMo V2.6 Flash', input: 1, output: 2, cacheRead: 0.02 },
    {
      id: 'mimo-v2.6-pro-ultraspeed',
      displayName: 'MiMo V2.6 Pro UltraSpeed',
      input: 30,
      output: 60,
      cacheRead: 0.25,
    },
  ]
  return models.flatMap(({ id, displayName, input, output, cacheRead }): ModelSpec[] => {
    const base: ModelSpec = {
      id,
      displayName,
      provider: 'openai_chat_completions',
      vendor: 'xiaomi',
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      density: DEFAULT_DENSITY,
      vision: true,
      // 当前媒体管线未接入 MiMo 的视频输入。
      video: false,
      pricing: { input, output, cacheRead, cacheWrite5m: 0, cacheWrite1h: 0, currency: 'CNY' },
      thinking: 'none',
      thinksByDefault: true,
      effortLevels: [],
      reasoningEcho: 'none',
      chatReasoningProtocol: 'preserved',
      // MiMo Chat / Responses 使用 strict nullable 定义时，实测会产生不完整的 arguments。
      // 三个型号共用官方原生工具定义，保留 required/optional，不转换成 nullable。
      chatToolSchema: 'native',
      cacheRouting: 'none',
      minCacheablePrefix: 0,
    }
    return [
      base,
      { ...base, provider: 'openai_responses', reasoningEcho: 'reasoning_text' },
      { ...base, provider: 'anthropic_messages' },
    ]
  })
}

/**
 * 未知模型的保守默认值。
 *
 * BYOK 场景下用户可能填写任意模型名（中转站的自定义名、本地 ollama 模型、尚未发布的
 * 模型）。此处提供一组不会导致请求失败的默认值：不声明 thinking、不声明 effort、
 * 不声明采样参数限制、计价为 0（前端显示「未知计价」，而不是错误的金额）。
 */
export function unknownModel(id: string, provider: ProviderKind): ModelSpec {
  return {
    id,
    displayName: id,
    provider,
    // 未收录即没有厂商。不要按 id 推测：中转站的模型名可以是任意字符串。
    vendor: null,
    /*
     * **该字段必须有消费方。** 以下取值表示「未测」，不表示「不支持」，
     * ARCHITECTURE §27 记录了两者不能合并的原因。
     *
     * 缺少消费方时有两项后果，均不产生任何报错：
     *
     * 1. `thinking: 'none'` → `buildReasoning` 完全省略 reasoning 字段，
     *    因此**该模型始终不会思考**。用户配置 `gpt-5.6` 并期望思考，
     *    得到的是 `reasoning_tokens: 0`，没有任何报错。
     * 2. `pricing` 全零 → `qy usage` 显示 $0。**账本与实际不符**，
     *    而账本正是用于发现费用异常增长的记录。
     *
     * 保守默认值本身正确（随意发送 reasoning 字段会使不支持的端点每次返回 400），
     * 错误在于不提示。`configNotices` 据此字段提醒用户，解决方式是明确补录模型规格；
     * 端点探测只能校验传输，不能推断官方能力。
     */
    catalogued: false,
    /*
     * 未收录表示**未测**，不表示不支持。因此不发送缓存路由字段：自建端点（ollama / vLLM）
     * 对未知字段的容忍度未经验证，而它们均属于此类。
     * 需要启用时在配置中明确填写 `cacheRouting`；当前探针不推断缓存能力。
     */
    cacheRouting: 'none',
    /*
     * **两个方向的误判代价不对等，因此取偏大的值。** 取值偏小时每轮都会提前压缩，
     * 既增加费用又丢失上下文，且不产生任何提示；取值偏大时，触发窗口上限会得到带 `capacity` 的
     * `context_overflow`，`agent/loop/compact.ts` 据此压缩一次后重发，有终态。
     *
     * 取 500K 而不取 1M：1M 是当前发布模型中最常见的标称窗口，但中转站按自身策略截断、
     * 本地 ollama 按 `num_ctx` 分配，实际可用窗口通常小于标称值。
     * 已知确切窗口时在模型库中填写 `contextWindow`。
     */
    // 未收录即未标定，使用上界档。读数偏高，但不会把超限的请求误判为未超限。
    density: DEFAULT_DENSITY,
    contextWindow: 500_000,
    /*
     * **不申报输出上限。** 未收录即未实测，在此臆测一个数值会导致静默截断：
     * 超过 8192 的正常回答会在该处中断，界面上只显示 `max_tokens` 停止原因。
     * 需要固定上限时在模型库中填写 `maxOutputTokens`。
     */
    maxOutputTokens: null,
    // 没有出处则不裁决：拦截一个实际接受图片的中转站模型，比放行更糟。
    vision: null,
    video: false,
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    thinking: 'none',
    /*
     * 未收录即未实测。不回传是保守的选择：多发送一个条目会使不要求回传的端点
     * 在每轮工具调用之后都返回 400，而少发送只会使要求回传的端点返回 400，且该 400
     * 带有端点的原始错误信息。需要启用时在模型库中填写 `reasoningEcho`。
     */
    reasoningEcho: 'none',
    chatReasoningProtocol: 'standard',
    chatToolSchema: 'native',
    effortLevels: [],
    thinksByDefault: false,
    minCacheablePrefix: 1024,
  }
}

/**
 * 其余厂商。
 *
 * 窗口、默认最大输出、四档价格与思考档位来自 2026-07-30 的 seed，**未在本仓库
 * 逐条实测**。修改价格时须对照厂商现行价目表，不要凭印象修改。
 *
 * `thinksByDefault`：有思考档位的模型填 `true`。它决定为思考预留的输出上限，
 * 多留只是偏保守，少留会使回答在中途被截断，两个方向的代价不对等。
 *
 * `minCacheablePrefix`：兼容协议的前缀缓存由服务端自动完成，无需显式断点，
 * 该值在兼容协议上没有消费方，1024 只是占位值。
 * **实际使用它的是 Anthropic 路径**（`providers/anthropic.ts`）：低于该长度时
 * 设置断点不会报错，只是不生效。
 *
 * **以下两个能力字段不要重新添加。**
 *
 * `rejectsSamplingParams` / `maxCacheBreakpoints`：两者均没有消费方。
 *
 * `maxCacheBreakpoints` 只有两个取值：Anthropic 恒为 4，兼容协议恒为 0。
 * 它是**协议常量**而不是模型能力，且本仓库只使用 2 个断点；不随模型变化的字段
 * 放在逐模型的目录中会造成误导。断点数写在使用它的适配器中。
 *
 * `vision` 不在此列：它有三个消费方，取值为三态而不是布尔值，
 * 约定写在 `ModelSpec.vision` 上。
 */
function openAiCompatCatalog(now: number): ModelSpec[] {
  const base = {
    provider: 'openai_chat_completions' as const,
    minCacheablePrefix: 1024,
    cacheRouting: 'prompt_cache_key' as const,
    reasoningEcho: 'none' as const,
    chatReasoningProtocol: 'standard' as const,
    chatToolSchema: 'openai_strict' as const,
    // 未标定的模型一律使用上界档，已标定的模型在各自条目中覆盖。
    density: DEFAULT_DENSITY,
    // 逐条按厂商规格页覆盖。`null` 表示没有出处，不裁决。
    vision: null as boolean | null,
    video: false,
  }
  /** OpenAI 兼容的命名档位，使用 chat/completions 的 `reasoning_effort`。 */
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
  /**
   * 会思考，但控制字段与档位没有出处。档位按保守原则留空：多声明一档的
   * 代价是一个选择后无效果的控件；默认思考按保守原则填 `true`：思考与正文共用输出上限，
   * 预留不足会使回答在中途被截断。
   */
  const thinksNoDial = {
    thinking: 'none' as const,
    effortLevels: [] as EffortLevel[],
    thinksByDefault: true,
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
  const GPT_56_EFFORTS: EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

  return [
    {
      ...base,
      ...effort(['low', 'medium', 'high', 'xhigh', 'max']),
      id: 'gpt-6-astra',
      displayName: 'GPT-6 Astra',
      vendor: 'openai',
      // Astra 的工具调用要求 Responses API。
      provider: 'openai_responses',
      vision: true,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      pricing: usd(10, 50, 1, 12.5),
      longContext: [GPT_6_ASTRA_LONG],
    },
    {
      ...base,
      ...effort(['low', 'medium', 'high', 'xhigh', 'max']),
      id: 'gpt-6.1-sol',
      displayName: 'GPT-6.1 Sol',
      vendor: 'openai',
      // 2026-09-30 核对：https://developers.openai.com/api/docs/models/gpt-6.1-sol
      // 工具调用要求 Responses；不支持 none / minimal，缓存读取价为输入价的 5%。
      provider: 'openai_responses',
      vision: true,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      pricing: usd(2, 10, 0.1, 2.5),
      longContext: [GPT_61_SOL_LONG],
    },
    {
      ...base,
      ...effort(['low', 'medium', 'high', 'xhigh', 'max']),
      id: 'gpt-6-sol',
      displayName: 'GPT-6 Sol',
      vendor: 'openai',
      // 思考档位下的工具调用要求 Responses API。
      provider: 'openai_responses',
      vision: true,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      pricing: usd(2, 10, 0.2, 2.5),
      longContext: [GPT_6_SOL_LONG],
    },
    {
      ...base,
      ...effort(['low', 'medium', 'high', 'xhigh', 'max']),
      id: 'gpt-6-luna',
      displayName: 'GPT-6 Luna',
      vendor: 'openai',
      // 2026-10-02 核对：https://developers.openai.com/api/docs/models/gpt-6-luna
      // 官方另支持 none；产品只提供正向思考档位，未选择时沿用默认 medium。
      // 思考开启时的工具调用使用 Responses；Chat 仅在 none 下支持工具调用。
      provider: 'openai_responses',
      vision: true,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      pricing: usd(0.1, 0.5, 0.01, 0.125),
      longContext: [GPT_6_LUNA_LONG],
    },
    /*
     * ── OpenAI GPT-5.6 ──
     *
     * 官方价目页（2026-08）的短上下文档，逐字：
     *
     * | 模型 | 输入 | 缓存输入 | 输出 |
     * |---|---|---|---|
     * | sol | $4.00 | $0.40 | $20.00 |
     * | terra | $2.00 | $0.20 | $12.00 |
     * | luna | $0.20 | $0.02 | $1.20 |
     * | cyber | $12.50 | $1.25 | $75.00 |
     *
     * Sol / Terra / Luna 窗口 1.05M、最大输出 128K；Cyber 窗口 400K。
     * 三个 1.05M 模型在提示词超过 272K 后，整条请求输入 2 倍、输出 1.5 倍，
     * 缓存写入按高档未命中输入价的 1.25 倍。
     */
    {
      ...base,
      ...effort(GPT_56_EFFORTS),
      id: 'gpt-5.6-sol',
      displayName: 'GPT-5.6 Sol',
      vendor: 'openai',
      vision: true,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      pricing: usd(4, 20, 0.4, 5),
      longContext: [GPT_56_SOL_LONG],
    },
    {
      ...base,
      ...effort(GPT_56_EFFORTS),
      id: 'gpt-5.6-terra',
      displayName: 'GPT-5.6 Terra',
      vendor: 'openai',
      vision: true,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      pricing: usd(2, 12, 0.2, 2.5),
      longContext: [GPT_56_TERRA_LONG],
    },
    {
      ...base,
      ...effort(GPT_56_EFFORTS),
      id: 'gpt-5.6-luna',
      displayName: 'GPT-5.6 Luna',
      vendor: 'openai',
      vision: true,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000,
      pricing: usd(0.2, 1.2, 0.02, 0.25),
      longContext: [GPT_56_LUNA_LONG],
    },
    {
      ...base,
      ...effort(['low', 'medium', 'high', 'xhigh', 'max']),
      id: 'gpt-5.6-cyber',
      displayName: 'GPT-5.6 Cyber',
      vendor: 'openai',
      vision: true,
      contextWindow: 400_000,
      maxOutputTokens: 128_000,
      pricing: usd(12.5, 75, 1.25, 15.625),
    },

    /*
     * ── Google Gemini ──
     *
     * 官方定价页（2026-09）逐字，单位 $/百万：
     *
     * | 模型 | 输入 | 输出 | 缓存 | 备注 |
     * |---|---|---|---|---|
     * | gemini-3.1-pro-preview | 2.00 | 12.00 | 0.20 | >200k：4.00 / 18.00 / 0.40 |
     * | gemini-3.8-flash | 0.75 | 3.75 | 0.075 | 促销至 2026-12-31，之后 1.50 / 7.50 / 0.15 |
     * | gemini-3.7-flash | 0.75 | 3.75 | 0.075 | 促销至 2026-12-31，之后 1.50 / 7.50 / 0.15 |
     * | gemini-3.6-flash | 0.75 | 3.75 | 0.075 | 同上 |
     * | gemini-3.5-flash | 1.50 | 9.00 | 0.15 | |
     *
     * **以下三点容易记错**：Flash 不是 0.3/2.5；Pro 有长上下文档；
     * Pro 的 id 是 `gemini-3.1-pro-preview`。
     *
     * 3.6 / 3.5 Flash 另有 `minimal`；3.8 / 3.7 Flash 与 3.1 Pro 从 `low` 起。
     * 五条模型页均给出 1,048,576 输入与 65,536 输出上限。
     */
    {
      ...base,
      ...effort(['low', 'medium', 'high']),
      id: 'gemini-3.1-pro-preview',
      displayName: 'Gemini 3.1 Pro Preview',
      vendor: 'google',
      vision: true,
      density: GOOGLE_DENSITY,
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      pricing: usd(2, 12, 0.2),
      longContext: [GEMINI_31_PRO_LONG],
    },
    {
      ...base,
      ...effort(['low', 'medium', 'high']),
      id: 'gemini-3.8-flash',
      displayName: 'Gemini 3.8 Flash',
      vendor: 'google',
      vision: true,
      density: GOOGLE_DENSITY,
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      pricing: geminiFlashPromo(now),
    },
    {
      ...base,
      ...effort(['low', 'medium', 'high']),
      id: 'gemini-3.7-flash',
      displayName: 'Gemini 3.7 Flash',
      vendor: 'google',
      vision: true,
      density: GOOGLE_DENSITY,
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      pricing: geminiFlashPromo(now),
    },
    {
      ...base,
      ...effort(['minimal', 'low', 'medium', 'high']),
      id: 'gemini-3.6-flash',
      displayName: 'Gemini 3.6 Flash',
      vendor: 'google',
      vision: true,
      density: GOOGLE_DENSITY,
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      pricing: geminiFlashPromo(now),
    },
    {
      ...base,
      ...effort(['minimal', 'low', 'medium', 'high']),
      id: 'gemini-3.5-flash',
      displayName: 'Gemini 3.5 Flash',
      vendor: 'google',
      vision: true,
      density: GOOGLE_DENSITY,
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536,
      pricing: usd(1.5, 9, 0.15),
    },

    // ── xAI ──
    // 2026-09-21 核对官方 4.7 文档：两种协议的缓存与历史回传方式不同；Fast 未开放公共 API。
    ...(['openai_chat_completions', 'openai_responses'] as const).map(
      (provider): ModelSpec => ({
        ...base,
        ...effort(['low', 'medium', 'high', 'xhigh']),
        id: 'grok-4.7',
        displayName: 'Grok 4.7',
        provider,
        vendor: 'xai',
        chatToolSchema: 'native',
        cacheRouting: provider === 'openai_responses' ? 'prompt_cache_key' : 'x_grok_conv_id',
        reasoningEcho: provider === 'openai_responses' ? 'encrypted_content' : 'none',
        vision: true,
        contextWindow: 500_000,
        maxOutputTokens: null,
        pricing: usd(2, 6, 0.5),
        longContext: [GROK_46_47_LONG],
      }),
    ),
    /*
     * xAI 官方价目表（2026-08）。两款均为 500K 窗口，**提示词达到 20 万后整条请求价格翻倍**：
     *
     * | 模型 | <200K | ≥200K |
     * |---|---|---|
     * | grok-4.6 | $2 / 缓存 $0.50 / 出 $6 | $4 / $1.00 / $12 |
     * | grok-4.5 | $2 / 缓存 $0.30 / 出 $6 | $4 / $0.60 / $12 |
     *
     * 目录填写 <200K 档（厂商公布的标准价），高档由 `GROK_46_47_LONG` 与 `GROK_45_LONG` 描述。
     *
     * 4.6 明确不设文本输出上限；4.5 页面也未声明独立输出上限，均不推测数值。
     */
    {
      ...base,
      ...effort(['low', 'medium', 'high', 'xhigh']),
      id: 'grok-4.6',
      displayName: 'Grok 4.6',
      vendor: 'xai',
      // xAI 的工具 schema 原生按 required/optional 严格采样；不要套用 OpenAI 的
      // 「全部 required + nullable」，否则模型会被迫为 probe_url 等可选参数臆造取值。
      chatToolSchema: 'native',
      // xAI Chat Completions 的缓存路由字段是请求头，不是请求体 prompt_cache_key。
      cacheRouting: 'x_grok_conv_id',
      vision: true,
      contextWindow: 500_000,
      maxOutputTokens: null,
      pricing: usd(2, 6, 0.5),
      longContext: [GROK_46_47_LONG],
    },
    {
      ...base,
      ...effort(['low', 'medium', 'high']),
      id: 'grok-4.5',
      displayName: 'Grok 4.5',
      vendor: 'xai',
      chatToolSchema: 'native',
      cacheRouting: 'x_grok_conv_id',
      vision: true,
      contextWindow: 500_000,
      maxOutputTokens: null,
      pricing: usd(2, 6, 0.3),
      longContext: [GROK_45_LONG],
    },

    // ── 阿里云百炼 Qwen（人民币标价）──
    /*
     * 官方模型页（2026-09）逐字，华北 2（北京），单位 ¥/百万：
     *
     * | 模型 | 窗口 | 最大输出 | 输入 | 输出 | 命中 | 输入模态 |
     * |---|---|---|---|---|---|---|
     * | qwen3.8-max | 1,000,000 | 131,072 | 12 | 36 | 1.5 | Image、Text、Video |
     * | qwen3.8-flash | 1,000,000 | 131,072 | 0.8 | 2.7 | 0.1 | Image、Text、Video |
     * | qwen3.8-omni-flash | 1,000,000 | 131,072 | 0.8 | 2.7 | 0.1 | Image、Text、Audio、Video |
     * | qwen3.7-max | 1,000,000 | 131,072 | 12 | 36 | 2.4 | Text |
     * | qwen3.7-plus | 1,000,000 | 131,072 | 2 | 8 | 0.4 | Image、Text、Video |
     * | qwen3.7-flash | 1,000,000 | 131,072 | 0.2 | 0.8 | 0.04 | Image、Text、Video |
     * | qwen3-vl-plus | 262,144 | 32,768 | 1 | 10 | 0.2 | Image、Text、Video |
     * | qwen3-vl-flash | 262,144 | 32,768 | 0.15 | 1.5 | 0.03 | Image、Text、Video |
     *
     * Omni Flash 的新加坡地域另有 ¥1.094 / ¥3.427 / 缓存 ¥0.117；此目录记北京价。
     *
     * **最大输出一列容易记错**：plus 与 flash 均为 131,072。
     *
     * `qwen3.7-max` 是本组中唯一只接受文本的模型：其日期快照版接受图片，基础版不接受，
     * 无法从名称区分，因此逐条按规格页填写，不按 id 前缀推断。
     *
     * Qwen3.8 的 Chat API 正向强度是 `low / medium / xhigh`，默认 xhigh；
     * 协议另有用于关闭思考的 `none`，产品不将其作为强度档位。
     * 同时默认保留思考，并要求按原顺序完整回放历史 `reasoning_content`。
     * 3.7 系是混合思考且默认开启，但没有同一组命名 effort 档；VL 两款默认关闭。
     *
     * `qwen3.8-max-prime` 不收录：价目页列有该模型（¥24 / ¥72），但无法获取其模型页，
     * 窗口与最大输出没有出处，而这两项不能留空。
     *
     * **`Qwen3.8-Flash-Next` 不是此处的 `qwen3.8-flash`，不要混淆。** 前者是开放权重
     * 版本（自部署，原生 256K，没有官方 API 定价），后者是托管服务的模型 id，
     * 1M 窗口与上表中对应行的价格均出自其模型页。目录收录的是可通过 API 调用的 id。
     */
    {
      ...base,
      ...effort(['low', 'medium', 'xhigh']),
      id: 'qwen3.8-max',
      displayName: 'Qwen3.8 Max',
      vendor: 'alibaba',
      vision: true,
      video: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      pricing: cny(12, 36, 1.5),
      chatReasoningProtocol: 'qwen_preserved',
      // 百炼是隐式前缀缓存，不接收 OpenAI 的 prompt_cache_key 路由提示。
      cacheRouting: 'none',
    },
    {
      ...base,
      ...effort(['low', 'medium', 'xhigh']),
      id: 'qwen3.8-flash',
      displayName: 'Qwen3.8 Flash',
      vendor: 'alibaba',
      vision: true,
      video: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      pricing: cny(0.8, 2.7, 0.1),
      chatReasoningProtocol: 'qwen_preserved',
      cacheRouting: 'none',
    },
    {
      ...base,
      ...effort(['low', 'medium', 'xhigh']),
      id: 'qwen3.8-omni-flash',
      displayName: 'Qwen3.8 Omni Flash',
      vendor: 'alibaba',
      // 当前目录只声明已接通的图片与视频输入；音频输入由模型支持，但本协议适配器尚未接通。
      vision: true,
      video: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      pricing: cny(0.8, 2.7, 0.1),
      chatReasoningProtocol: 'qwen_preserved',
      cacheRouting: 'none',
    },
    {
      ...base,
      ...thinksNoDial,
      id: 'qwen3.7-max',
      displayName: 'Qwen3.7 Max',
      vendor: 'alibaba',
      vision: false,
      video: false,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      pricing: cny(12, 36, 2.4),
    },
    {
      ...base,
      ...thinksNoDial,
      id: 'qwen3.7-plus',
      displayName: 'Qwen3.7 Plus',
      vendor: 'alibaba',
      vision: true,
      video: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      pricing: cny(2, 8, 0.4),
      longContext: [QWEN_37_PLUS_LONG],
    },
    {
      ...base,
      ...thinksNoDial,
      id: 'qwen3.7-flash',
      displayName: 'Qwen3.7 Flash',
      vendor: 'alibaba',
      vision: true,
      video: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      pricing: cny(0.2, 0.8, 0.04),
      longContext: QWEN_37_FLASH_LONG,
    },
    {
      ...base,
      ...noThinking,
      id: 'qwen3-vl-plus',
      displayName: 'Qwen3-VL Plus',
      vendor: 'alibaba',
      vision: true,
      video: true,
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
      pricing: cny(1, 10, 0.2),
      longContext: QWEN_VL_PLUS_LONG,
    },
    {
      ...base,
      ...noThinking,
      id: 'qwen3-vl-flash',
      displayName: 'Qwen3-VL Flash',
      vendor: 'alibaba',
      vision: true,
      video: true,
      contextWindow: 262_144,
      maxOutputTokens: 32_768,
      pricing: cny(0.15, 1.5, 0.03),
      longContext: QWEN_VL_FLASH_LONG,
    },

    // ── 月之暗面（人民币标价）──
    {
      ...base,
      ...effort(['low', 'high', 'max']),
      id: 'kimi-k3',
      displayName: 'Kimi K3',
      vendor: 'moonshot',
      vision: true,
      video: true,
      contextWindow: 1_000_000,
      // OpenAPI：默认 131,072，参数最大可设 1,048,576；运行时仍会按剩余上下文收紧。
      maxOutputTokens: 1_048_576,
      pricing: cny(20, 100, 2),
    },

    /*
     * ── 智谱 ──
     *
     * 价目来源：智谱国内站价目表（2026-09-22 核对），单位 ¥/百万：
     *
     * | 模型 | 输入 | 缓存命中 | 输出 |
     * |---|---|---|---|
     * | glm-5.3 | 8 | 2 | 28 |
     * | glm-5.3-flash | 0.8（限时 0.4） | 0.23（限时 0.115） | 2.8（限时 1.4） |
     * | glm-5.3-flashx | 2 | 0.57 | 7 |
     * | glm-5.2 | 8 | 2 | 28 |
     * | glm-4.7 | 2 | 0.4 | 8 |
     * | glm-5v-turbo | 5 | 1.2 | 22 |
     * | glm-4.6v | 1 | 0.2 | 3 |
     *
     * 4.7 还按输入 32K、输出 200 双轴分档；两款视觉模型按输入 32K 分档。
     * 这些档位必须纳入计价，不能只将价目首行录入目录。
     *
     * **图片输入按价目页的分节填写**：文本模型一节中的三款（5.3 / 5.2 / 4.7）
     * 只接受文本，视觉模型一节中的（5v-turbo / 4.6v）接受图片。glm-5.3 的模型页
     * 另明确注明「当前不支持图片输入」。
     *
     * glm-5.3 的窗口 1M / 最大输出 131,072 与三档 `reasoning_effort`（默认 max、
     * 思考无法关闭）来自其模型规格页。5.2 同样支持 low / high / max。
     *
     * glm-5.3-flash 的模型页：1M 窗口、131,072 最大输出、原生多模态；
     * 与 5.3 同样支持 low / high / max。两款均要求思考始终开启、完整回放历史
     * `reasoning_content`，并用 `clear_thinking:false` 保留连续思考。
     *
     * glm-5v-turbo 的模型页：200K 窗口、128K 最大输出，接受图片、视频、文本与文件输入，
     * 思考为开关而非档位。glm-4.6v：128K 窗口、32K 最大输出。
     */
    ...[
      { id: 'glm-5.3', displayName: 'GLM-5.3', vision: false, pricing: cny(8, 28, 2) },
      {
        id: 'glm-5.3-flash',
        displayName: 'GLM-5.3 Flash',
        vision: true,
        pricing: glm53FlashPromo(now),
      },
      {
        id: 'glm-5.3-flashx',
        displayName: 'GLM-5.3 FlashX',
        vision: true,
        pricing: cny(2, 7, 0.57),
      },
    ].flatMap((model): ModelSpec[] => {
      const chat: ModelSpec = {
        ...base,
        ...effort(['low', 'high', 'max']),
        ...model,
        vendor: 'zhipu',
        video: model.vision,
        contextWindow: 1_000_000,
        maxOutputTokens: 131_072,
        chatReasoningProtocol: 'glm_preserved',
        // 保留原生 required/optional；Flash 实测会把 strict 的 null 采样为字符串。
        chatToolSchema: 'native',
        cacheRouting: 'none',
      }
      return [
        chat,
        {
          ...chat,
          provider: 'openai_responses',
          // 官方 Responses 将 low/medium 映射为 high，xhigh 映射为 max。
          effortLevels: ['high', 'max'],
          reasoningEcho: 'reasoning_text_object',
          chatReasoningProtocol: 'preserved',
          cacheRouting: 'prompt_cache_key',
          video: false,
        },
      ]
    }),
    {
      ...base,
      ...effort(['low', 'high', 'max']),
      id: 'glm-5.2',
      displayName: 'GLM-5.2',
      vendor: 'zhipu',
      vision: false,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      pricing: cny(8, 28, 2),
    },
    {
      ...base,
      ...thinksNoDial,
      id: 'glm-4.7',
      displayName: 'GLM-4.7',
      vendor: 'zhipu',
      vision: false,
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      pricing: cny(2, 8, 0.4),
      longContext: GLM_47_TIERS,
    },
    {
      ...base,
      ...thinksNoDial,
      id: 'glm-5v-turbo',
      displayName: 'GLM-5V Turbo',
      vendor: 'zhipu',
      vision: true,
      video: true,
      contextWindow: 200_000,
      maxOutputTokens: 128_000,
      pricing: cny(5, 22, 1.2),
      longContext: [GLM_5V_TURBO_LONG],
    },
    {
      ...base,
      ...thinksNoDial,
      id: 'glm-4.6v',
      displayName: 'GLM-4.6V',
      vendor: 'zhipu',
      vision: true,
      video: true,
      contextWindow: 128_000,
      maxOutputTokens: 32_768,
      pricing: cny(1, 3, 0.2),
      longContext: [GLM_46V_LONG],
    },

    // ── MiniMax ──
    ...(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const).map(
      (provider): ModelSpec => ({
        ...base,
        ...effort(['low', 'medium', 'high', 'xhigh', 'max']),
        id: 'MiniMax-M3.1-Flash-Preview',
        displayName: 'MiniMax M3.1 Flash Preview',
        vendor: 'minimax',
        provider,
        thinking: provider === 'anthropic_messages' ? 'always_on' : 'reasoning_effort',
        chatReasoningProtocol: 'preserved',
        reasoningEcho: provider === 'openai_responses' ? 'reasoning_text' : 'none',
        chatToolSchema: 'native',
        cacheRouting: 'none',
        minCacheablePrefix: 1024,
        vision: true,
        video: provider === 'openai_chat_completions',
        contextWindow: 1_000_000,
        maxOutputTokens: 524_288,
        pricing: {
          input: null,
          output: null,
          cacheRead: null,
          cacheWrite5m: null,
          cacheWrite1h: null,
          note: '仅 M Plan 订阅 Key 可用；尚未公布按 token 单价',
        },
      }),
    ),
    {
      ...base,
      ...thinksNoDial,
      id: 'MiniMax-M3',
      displayName: 'MiniMax M3',
      vendor: 'minimax',
      vision: true,
      video: true,
      contextWindow: 1_000_000,
      // OpenAI 兼容接口：推荐 131,072，参数最大可设 524,288。
      maxOutputTokens: 524_288,
      pricing: usd(0.3, 1.2, 0.06),
      longContext: [MINIMAX_M3_LONG],
    },
    // ── 阶跃星辰 ──
    ...(['openai_chat_completions', 'anthropic_messages'] as const).map(
      (provider): ModelSpec => ({
        ...base,
        ...effort(['low', 'medium', 'high']),
        id: 'step-5-preview',
        displayName: 'Step 5 Preview',
        vendor: 'stepfun',
        provider,
        thinking: provider === 'anthropic_messages' ? 'always_on' : 'reasoning_effort',
        chatToolSchema: 'native',
        cacheRouting: 'none',
        minCacheablePrefix: 256,
        vision: true,
        video: provider === 'openai_chat_completions',
        contextWindow: 1_000_000,
        maxOutputTokens: 64_000,
        pricing: { ...cny(7, 20, 0.35), cacheWrite5m: 7, cacheWrite1h: 7 },
      }),
    ),
  ]
}

/**
 * 用户对模型参数的覆盖。字段均为可选，只写入修改过的字段。
 *
 * 落盘结构见 `runtime` 的 `StoredCatalogEntry`；此处再次声明，是因为
 * 合并必须发生在 `@qywork/ai`（适配器与计价都在该层），而该包无法引用 runtime。
 * 两处字段必须一致，修改一处时须同步检查另一处。
 */
export interface SpecOverride {
  displayName?: string
  vendor?: string
  contextWindow?: number
  maxOutputTokens?: number
  /**
   * 是否接受图片输入。**只能手动填写**，探针不探测该项：一次发送未报错
   * 不等于该链路稳定接受图片，而报错也无法区分是模型不接受图片还是本次参数有误。
   *
   * 该字段是中转站模型的唯一配置入口：内置目录无法识别其自定义名称，
   * 目录中的取值为 `null`（不裁决）。填写 `false` 后才会拦截图片。
   */
  vision?: boolean
  input?: number
  output?: number
  /** 缓存命中价。 */
  cacheRead?: number
  /**
   * 缓存写入价。**只覆盖 5 分钟档**：`computeCost` 只按该档计算，
   * 全项目从不请求 1 小时缓存。`cacheWrite1h` 保留在价目表中作为参考数据，
   * 没有可达的代码分支，因此不提供修改入口。
   */
  cacheWrite?: number
  currency?: 'USD' | 'CNY'
  /**
   * 思考相关的三项是用户明确维护的模型规格。端点探测只判定某条链路是否透传思考控制参数，
   * 不覆盖官方档位或默认思考行为。
   */
  thinking?: ThinkingMode
  effortLevels?: EffortLevel[]
  thinksByDefault?: boolean
  /** 需要完整回传历史思考的自定义模型，必须显式声明回放协议。 */
  chatReasoningProtocol?: ChatReasoningProtocol
  /**
   * 回传推理原文。探针不覆盖该项（无法探测的内容不推测），只能手动填写：
   * 中转站以自定义模型名提供 DeepSeek 时，内置目录无法识别，该字段是唯一入口。
   */
  reasoningEcho?: ReasoningEcho
  /**
   * 缓存路由。当前探针不探测该项，只能由目录 seed 或用户明确填写。
   *
   * 它比思考参数更需要按端点覆盖：缓存能力是「端点 × 模型」组合的属性，
   * 同一个模型在不同中转站上结论不同，内置表只能提供 seed。
   */
  cacheRouting?: CacheRouting
}

/**
 * 将用户修改的参数叠加到目录条目上。**seed → 用户覆盖**，顺序唯一。
 *
 * 两条边界：
 *
 * - **只覆盖已填写的字段。** 缓存两档需要修改时单独填写，**不按 input 等比例推算**：
 *   推算结果是看似精确的错误数值，而各厂商的缓存定价比例并不相同
 *   （Anthropic 写入为 1.25x，DeepSeek 写入免费）。
 * - **`catalogued` 只在覆盖中包含单价时才设为 true。** 若只修改显示名就标记为
 *   「已收录」，计价仍为 0 而提醒消失：账本继续显示 $0，且不再有任何提示。
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
    // 布尔值，`false` 是有效覆盖（即拦截图片），只能按 `undefined` 判定缺省。
    ...(o.vision !== undefined ? { vision: o.vision } : {}),
    ...(o.thinking ? { thinking: o.thinking } : {}),
    ...(o.chatReasoningProtocol ? { chatReasoningProtocol: o.chatReasoningProtocol } : {}),
    ...(o.reasoningEcho ? { reasoningEcho: o.reasoningEcho } : {}),
    ...(o.effortLevels ? { effortLevels: o.effortLevels } : {}),
    ...(o.cacheRouting ? { cacheRouting: o.cacheRouting } : {}),
    // `thinksByDefault` 是布尔值，`false` 是有效覆盖，只能按 `undefined` 判定缺省。
    ...(o.thinksByDefault !== undefined ? { thinksByDefault: o.thinksByDefault } : {}),
    pricing: {
      ...spec.pricing,
      ...(o.input !== undefined ? { input: o.input } : {}),
      ...(o.output !== undefined ? { output: o.output } : {}),
      ...(o.cacheRead !== undefined ? { cacheRead: o.cacheRead } : {}),
      ...(o.cacheWrite !== undefined ? { cacheWrite5m: o.cacheWrite } : {}),
      ...(o.currency ? { currency: o.currency } : {}),
    },
    ...(priced ? { catalogued: true } : {}),
  }
}

/** 必须传入未覆盖的目录 seed；计价覆盖不会把未知档位变成已知。 */
export function declaredEffortLevels(
  seed: ModelSpec,
  override?: SpecOverride,
): EffortLevel[] | undefined {
  return override?.effortLevels ?? (seed.catalogued !== false ? seed.effortLevels : undefined)
}

/**
 * 运行时与模型选择器共用的规格合并。模型库声明档位，端点校验只能缩小该集合；
 * 只有未声明档位的模型才采用探测候选值。参数被接受不意味着它是独立的强度。
 */
export function applyTransportCapabilities(
  seed: ModelSpec,
  transport?: TransportCapabilities,
  override?: SpecOverride,
): ModelSpec {
  const declared = applySpecOverride(seed, override)
  // Messages 适配器始终发送原生 input_schema；运行时与检测应报告实际发送策略。
  const spec =
    declared.provider === 'anthropic_messages'
      ? { ...declared, chatToolSchema: 'native' as const }
      : declared
  if (!transport) return spec
  const levels = declaredEffortLevels(seed, override)
  return {
    ...spec,
    ...(seed.catalogued === false && override?.thinking === undefined && transport.thinking
      ? { thinking: transport.thinking }
      : {}),
    ...(transport.effortLevels
      ? {
          effortLevels:
            levels?.filter((level) => transport.effortLevels!.includes(level)) ??
            transport.effortLevels,
        }
      : {}),
    ...(transport.effort === false ? { effortLevels: [] } : {}),
  }
}

/** 全部内置模型。提供默认规格与计价，不限制未收录模型的接入或探测。 */
export function builtinCatalog(now = Date.now()): ModelSpec[] {
  return [...claudeCatalog(), ...deepseekCatalog(), ...mimoCatalog(), ...openAiCompatCatalog(now)]
}

/**
 * 查询目录。
 *
 * **先按 `(id, provider)` 精确匹配：同一个模型在不同协议下的请求字段不同。**
 * DeepSeek 的三条协议分别使用 thinking + reasoning_effort、reasoning.effort、
 * output_config.effort，因此目录允许同 id 按 provider 分开声明。
 *
 * 若只按 id 查找（`.find(m => m.id === id)`），同 id 的多个条目中始终只命中先声明的一条，
 * 而声明顺序与正确性无关。
 */
export function lookupModel(id: string, provider: ProviderKind, now = Date.now()): ModelSpec {
  const all = builtinCatalog(now)
  const exact = all.find((m) => m.id === id && m.provider === provider)
  if (exact) return exact

  const found = all.find((m) => m.id === id)
  // provider 与内置目录不符时（例如经中转站以 openai 兼容协议调用 claude），
  // 保留能力约束但改写 provider：协议由用户配置决定，不由模型名决定。
  //
  // 该分支**只保留能力约束，不保证能力属实**：改写了 provider 的条目描述的是
  // 另一种协议下的行为。因此它是后备处理，不代表支持；需要准确规格时，在目录中
  // 为该协议单独添加条目。
  if (found) return { ...found, provider }
  return unknownModel(id, provider)
}

/**
 * 该 spec 在**当前协议**上能否实际发送思考强度。
 *
 * 用于 `lookupModel` 的后备分支：目录中没有「Claude + 兼容协议」的条目时，
 * 该分支保留 Claude 的能力约束、只改写 `provider`，**只保留约束、
 * 不保证能力属实**。因此 `effortLevels` 仍为五档，但兼容协议不发送 Anthropic
 * 的 `output_config.effort`；界面若按五档渲染 chip，选择后不会有任何效果。
 *
 * 判据按协议区分：
 * - `anthropic`：适配器只要 `effortLevels` 非空即发送 `output_config.effort`。
 * - `openai_responses`：只能通过 `reasoning.effort` 发送。
 * - `openai_chat_completions`：`reasoning_effort`（OpenAI 的字段）或 `deepseek_thinking`
 *   （DeepSeek 需要同时发送两个字段），其余均无法发送。
 *
 * 与 `openai-compat.ts` 的 `buildReasoning` 是同一判断的两种用途：
 * 本函数判定能否发送，`buildReasoning` 决定使用哪些字段。修改一处时须同步检查另一处。
 */
export function effortIsTransmittable(spec: ModelSpec): boolean {
  if (spec.effortLevels.length === 0) return false
  if (spec.provider === 'anthropic_messages') return true
  if (spec.provider === 'openai_responses') return spec.thinking === 'reasoning_effort'
  return spec.thinking === 'reasoning_effort' || spec.thinking === 'deepseek_thinking'
}

/** 历史中的推理在该 spec 的协议上是否发送、发送哪种。 */
export interface ReasoningReplay {
  /** 思考正文回放到哪些 assistant 消息上。有原生条目的消息不再附带正文。 */
  text: 'none' | 'tool_turns' | 'all'
  /** 原生推理条目（带签名的思考块、加密推理）是否回放。 */
  opaque: boolean
}

/**
 * 历史推理的发送规则。**装配点的裁剪与三个适配器的转换共用此规则**：两处分别判定时，
 * 估算计入的推理与实际发送的推理不一致，本地估算因此系统性地多出整段思考。
 *
 * - `anthropic`：带签名的思考块原样回放；Claude 不接受缺少签名的思考文字（静默丢弃），
 *   只有 `preserved` 系端点接受文字。
 * - `openai_responses`：由 `reasoningEcho` 声明，加密条目与文字条目二选一。
 * - `openai_chat_completions`：`reasoning_content` 字段，工具调用轮次始终携带（DeepSeek 思考模式
 *   缺少即返回 400，其余端点忽略该字段），`standard` 以外的协议在全部轮次携带。
 */
export function reasoningReplay(spec: ModelSpec): ReasoningReplay {
  if (spec.provider === 'anthropic_messages') {
    const preserved =
      spec.chatReasoningProtocol === 'deepseek_preserved' ||
      spec.chatReasoningProtocol === 'preserved'
    return { opaque: true, text: preserved ? 'all' : 'none' }
  }
  if (spec.provider === 'openai_responses') {
    const text =
      spec.reasoningEcho === 'reasoning_text' || spec.reasoningEcho === 'reasoning_text_object'
    return { opaque: spec.reasoningEcho === 'encrypted_content', text: text ? 'all' : 'none' }
  }
  return { opaque: false, text: spec.chatReasoningProtocol === 'standard' ? 'tool_turns' : 'all' }
}

/**
 * 按 usage 计算本次请求的费用。
 *
 * **币种为 `spec.pricing.currency`，不一定是美元**：阿里、月之暗面、智谱、
 * DeepSeek 等按人民币标价。本函数只返回数值，币种由调用方一并记入账本。
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
  // 单价**按计费时刻与本次请求的大小取值**，不按创建 adapter 的时刻取值。
  //
  // adapter 每个 run 创建一次，而 run 可能持续很长时间：DeepSeek 的高峰时段每天有两段，
  // 08:55 开始、运行超过 09:00 的 run，若按创建 adapter 的时刻取价，整轮都会按空闲价计费。
  // 计费按请求逐次调用（`agent/loop/attempt.ts` 每收到一次 usage 计算一次），
  // 在此处取时间即对应该次请求结束的时刻。
  //
  // 提示词大小同理：它随请求逐次增长，长上下文档必须按**本次请求**的大小判定，
  // 按整个 run 的最大值或首次请求的值判定都会算错部分请求。
  // 三项之和才是本次请求的提示词大小：三个数互不重叠，遗漏缓存写入项会使长上下文档
  // 在冷启动请求上判定失效，而冷启动正是写入量最大的请求。
  const p = priceAt(spec, {
    now,
    promptTokens: usage.inputTokens + (usage.cachedTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    outputTokens: usage.outputTokens,
  })
  // 只按 5 分钟档计算：全项目从不请求 1 小时缓存。`cacheWrite1h` 保留在价目表中作为
  // **参考数据**（它是真实价格），不是可达的代码分支。不要为它添加 cacheTtl 参数：
  // 没有调用方会传入，1h 分支永远不可达。
  const writeRate = p.cacheWrite5m
  // 沿用运行用量中「0 表示金额不明」的约定；没有单价时不估算订阅费用。
  if (p.input === null || p.output === null || p.cacheRead === null || writeRate === null) return 0
  const total =
    (usage.inputTokens * p.input +
      usage.outputTokens * p.output +
      (usage.cachedTokens ?? 0) * p.cacheRead +
      (usage.cacheWriteTokens ?? 0) * writeRate) /
    1e6
  return round(total)
}
