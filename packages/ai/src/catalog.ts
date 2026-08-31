/**
 * 模型目录与计价。
 *
 * 这是**内置基线**，不是白名单：用户在设置里填任意 model id 都能跑（BYOK 自定义接口是
 * 需求 11 的硬要求）。目录只提供三件事——已知模型的能力约束、计价、以及请求参数的合法性
 * 校验。未知模型走 `unknownModel()` 的保守默认值，不阻止发送。
 *
 * 口径来源：Anthropic 官方文档（2026-06-24 快照）。改动这里前先核对，别凭记忆写。
 */

import type {
  CacheRouting,
  EffortLevel,
  ProviderKind,
  ReasoningEcho,
  ThinkingMode,
} from '@qywork/core'
import { DEFAULT_DENSITY, type TokenDensity } from './tokens.ts'

/**
 * 每百万 token 的单价。
 *
 * **币种是这条数据的一部分。** 阿里 / 月之暗面 / 智谱三家官网就是按人民币标价的，
 * 把 ¥6 当成 $6 会让账面差七倍。所以带上 `currency`，由消费方决定怎么显示、
 * 要不要合计——而不是在这里换算成一个没有出处的美元数字。
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

export interface ModelSpec {
  id: string
  displayName: string
  /** **协议**，不是厂商。见 `Vendor` 上的注释。 */
  provider: ProviderKind
  /**
   * 厂商 id（`VENDORS` 里的一条）。`null` = 未收录，来自用户自建端点。
   *
   * 显式写在每条上，不按 id 前缀推断——L 那条规矩：任何「从名字推断行为」
   * 的便利都要先问反例是什么，而中转站的模型名可以是任意字符串。
   */
  vendor: string | null
  contextWindow: number
  /**
   * 这个 tokenizer 的 token 密度。三档标定方法与边界见 `tokens.ts` 的 `TokenDensity`。
   *
   * **必填，不给默认值。** 加一条模型时如果没量过，显式写 `DEFAULT_DENSITY`
   * ——那一档是上界，读数偏高但不会低估。写成可选就会有人漏掉，
   * 而漏掉的表现是那个模型的读数换了一把尺，不报错。
   */
  density: TokenDensity
  /**
   * 这个模型单次最多能输出多少 token。**`null` = 没测过，不申报。**
   *
   * `null` 与「上限是某个小数字」是两件事，不许合并（同 `catalogued` 那条）：
   * 编一个数写在这里，模型的长输出会被静默截在那个数上，用户只看到
   * `stop_reason: max_tokens`。OpenAI 系协议下 `null` 表现为整个不发这个字段，
   * 由端点用自己的默认；Anthropic 协议要求这个字段，见 `anthropic.ts` 的兜底。
   */
  maxOutputTokens: number | null
  /**
   * 接不接受图片输入。**三态**，与 `maxOutputTokens` 同一个惯例：
   * `null` = 厂商规格页没写、也没实测过，**不是「不支持」**。
   *
   * **门控只认 `false`。** `null` 一律放行——中转站的模型名是任意字符串，
   * 目录认不出它们，按不确定的数据挡请求比不挡更糟：那种失败看起来像
   * 「图片发不出去」，查不到这里。判错了在模型库那一格覆盖（`SpecOverride`）。
   *
   * 逐条照厂商规格页填，**不按 id 前缀推断**（同 `vendor` 那条）：
   * `qwen3.7-max` 基础版只收文本而它的快照版收图片，名字上分不出来。
   *
   * 消费者三处：模型库那一列、组合器的图片附件入口、`agent` 装配请求时的兜底
   * （`false` 时图像块换成文本注记，历史里的旧图与工具返回的图一并覆盖）。
   */
  vision: boolean | null
  /** 只有官方协议与当前适配器都核实支持时才为 true。未知模型按 false 处理。 */
  video: boolean
  pricing: Pricing
  thinking: ThinkingMode
  /**
   * 带 tool_calls 的历史要不要回传推理原文。与 `thinking` 正交：DeepSeek 的
   * Responses 条目与 OpenAI 同为 `reasoning_effort`，那条轴说的是 effort 旋钮。
   */
  reasoningEcho: ReasoningEcho
  /**
   * Chat Completions 的历史思考协议。
   *
   * `standard` 保持原有行为：只给带 tool_calls 的 assistant 回放 `reasoning_content`。
   * 另外两档是厂商明确要求的完整历史协议；它们同时决定请求开关和纯文本轮回放，
   * 避免「请求体开了保留、历史投影却仍丢思考」这种半套实现。
   */
  chatReasoningProtocol: 'standard' | 'qwen_preserved' | 'glm_preserved'
  /**
   * Chat Completions 的工具参数 schema 协议。
   *
   * `openai_strict` 会把可选属性改成「必填但可为 null」并发送 `strict:true`；
   * `native` 保留模型库注册时的原生 required/optional 形状。两者不能按
   * OpenAI-compatible 这个接口名一刀切：兼容基础字段不等于兼容 strict 采样规则。
   */
  chatToolSchema: 'openai_strict' | 'native'
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
  /** 采样参数是否被拒绝。Claude 5 系全部拒绝 temperature/top_p/top_k。 */
  /** 最小可缓存前缀（token）。低于此值加了 cache_control 也静默不缓存。 */
  /**
   * 这条模型在这条协议上，靠什么把请求钉到同一个缓存分片。
   *
   * **它是「接口 × 模型」那一格的属性，不是模型的属性。** 同一个模型在两个
   * 中转站上表现完全不同，所以内置值只是 seed，端点侧由配置里那一格覆盖
   * （`SpecOverride`），出口是模型库界面那一格。
   *
   * **`qy probe` 不探这一项。** 探针只能发几次请求看命中，而不确定的路线上
   * 那是随机结果——探出「可用」再写回目录，是把一次运气固化成结论。
   *
   * **发了不等于会命中。** 2026-08-19 在一个中转端点上配对实测：
   * 同一时间窗逐轮交替发有键/无键各 12 轮，无键 5/12 真命中、有键 0/12，
   * 换个时间窗又反过来。缓存路线本身不确定时，这个字段盖不住——
   * 它只是协议规定的做法，不是不命中的解药。
   *
   * `'none'` 是**未测**不是不支持：未收录的模型一律落在这一档，
   * 一个字节都不多发——自建端点不会因为这条开始收到它不认识的字段。
   */
  cacheRouting: CacheRouting
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
   * 用量阶梯价，**按 `thresholdTokens` 升序排**。没有就是「多大的请求都一个价」。
   * 与 `offPeak` 一样，`pricing` 是标准价，这一条只描述什么时候换档。
   *
   * 是数组而不是单档：阿里的 flash 两款是三档（≤32K / 32K–256K / 256K–1M），
   * 只留一档就得在「中间那段记高」和「最长那段记低」之间挑一个，
   * 而两个方向都是静默记错钱。
   */
  longContext?: readonly LongContextTier[]
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

/**
 * 厂商。
 *
 * **和 `ProviderKind` 是两个轴，不能合并。** `ProviderKind` 说的是协议——
 * DeepSeek、OpenAI、任何中转站都可以是 `openai_chat_completions`。厂商回答的是
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
 * Anthropic 走 SDK 自带默认；DeepSeek 那条来自本机跑通的配置；OpenAI 那条是
 * `openai-responses.ts` 里的常量。其余六家没有实据，所以留空——凭印象写一个域名，
 * 错了的表现是「填好了却连不上」，比空着要人自己填糟得多。
 */
/**
 * DeepSeek 的 tokenizer 密度。斜率法实测（2026-08-26，`deepseek-v4-flash-vision-exp`）：
 * 中文 0.569 token/字、真实源码 2.71–3.00 字符/token、工具结果整条 2.53 字符/token。
 * 三档各留一点上界，在四份真实样本上落在 1.03–1.12x。
 */
const DEEPSEEK_DENSITY: TokenDensity = {
  cjkTokensPerChar: 0.6,
  textCharsPerToken: 3,
  jsonCharsPerToken: 2.5,
}

/**
 * Google 的 tokenizer 密度。同法实测（2026-08-26，`gemini-3.7-flash`）：
 * 中文 0.647 token/字、真实源码 2.42 字符/token、工具结果 2.43 字符/token。
 * 文本档比 DeepSeek 那一档更紧，因为它的代码密度实测更高。
 */
const GOOGLE_DENSITY: TokenDensity = {
  cjkTokensPerChar: 0.7,
  textCharsPerToken: 2.5,
  jsonCharsPerToken: 2.5,
}

export const VENDORS: readonly Vendor[] = [
  {
    id: 'anthropic',
    displayName: 'Anthropic',
    defaultKind: 'anthropic_messages',
  },
  {
    id: 'openai',
    displayName: 'OpenAI',
    defaultKind: 'openai_chat_completions',
    defaultBaseUrl: 'https://api.openai.com/v1',
  },
  {
    id: 'deepseek',
    displayName: 'DeepSeek',
    defaultKind: 'openai_chat_completions',
    // 带 `/v1`：DeepSeek 的 OpenAI 兼容端点在这一层，少了它是 404。
    defaultBaseUrl: 'https://api.deepseek.com/v1',
  },
  {
    id: 'google',
    displayName: 'Google',
    defaultKind: 'openai_chat_completions',
  },
  { id: 'xai', displayName: 'xAI', defaultKind: 'openai_chat_completions' },
  {
    id: 'alibaba',
    displayName: '阿里云百炼',
    defaultKind: 'openai_chat_completions',
  },
  {
    id: 'moonshot',
    displayName: '月之暗面',
    defaultKind: 'openai_chat_completions',
  },
  {
    id: 'zhipu',
    displayName: '智谱',
    defaultKind: 'openai_chat_completions',
  },
  {
    id: 'minimax',
    displayName: 'MiniMax',
    defaultKind: 'openai_chat_completions',
  },
]

/**
 * 长上下文阶梯价。
 *
 * **达到阈值之后整条请求都按高档算，不是只算超出的那部分。**
 * xAI 的原话：一条 21 万 token 的请求不是「20 万按标准价 + 1 万按高价」，
 * 而是整条按高价。按超出部分算会把账记少一半，而少记的方向不会有任何报错。
 *
 * **高档单价逐字抄厂商的第二行，不按倍率推算。** 各家的倍率不统一：
 * OpenAI 与 Google 的输入是 2 倍而输出只有 1.5 倍，xAI 才是整齐的 2 倍。
 * 存一个倍率就得自己算比值，算错了不会有任何提示。
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
  /** 输出达到这个数才进档；省略表示不看输出。用于厂商明确按输入和输出双轴计价的模型。 */
  minOutputTokens?: number
  input: number
  output: number
  cacheRead: number
  /** 长上下文档的缓存写入价；省略时沿用基础档。 */
  cacheWrite5m?: number
  /** 长上下文档的 1 小时缓存写入价；省略时沿用基础档。 */
  cacheWrite1h?: number
  /** 一句话，界面直接显示。 */
  note: string
}

/**
 * 分时段折扣。**窗口按 UTC 的星期与小时给，不按本机时区。**
 *
 * 厂商公布的是当地时间（DeepSeek 写的是北京时间），但这台机器可能在任何时区，
 * 用 `getHours()` 算等于把用户的时区当成了厂商的时区——在美国跑就整天算错档，
 * 而错的表现只是账本上一个偏低或偏高的数字，没有任何地方会报错。
 * 所以录进来的时候就换算成 UTC，`priceAt` 只认 `getUTCHours()`。
 *
 * **记「高峰窗口」而不是「折扣窗口」。** 照抄厂商的说法。DeepSeek 的原话是「高峰时段为北京时间
 * 9:00-12:00、14:00-18:00 （其余为空闲时段）」——记高峰是逐字转录，记折扣就得自己把补集算一遍，而
 * 那一步算错了不会有任何提示。
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
  /**
   * 高峰只在这几个星期几成立，`getUTCDay()` 口径（0 = 周日）。不在表里的日子
   * 整天按空闲价。星期与小时必须同为 UTC：混用两个时区会在窗口跨零点时错开一天。
   */
  peakWeekdaysUtc: readonly number[]
  /** 一句话，界面直接显示，不再自己拼。 */
  note: string
}

/**
 * DeepSeek 的高峰时段：北京时间**周一至周五** 9:00-12:00、14:00-18:00（UTC+8），
 * 周六周日整天按空闲价。
 *
 * 换算成 UTC 就是 01:00-04:00 与 06:00-10:00，星期不用挪：两段窗口都落在同一个
 * UTC 日内。窗口若改到跨零点，星期表要跟着挪一天。
 * 口径来源：官方文档「模型 & 价格」页（2026-08-17 生效的新价目）。
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

const MINIMAX_M3_LONG: LongContextTier = {
  thresholdTokens: 524_289,
  input: 0.6,
  output: 2.4,
  cacheRead: 0.12,
  note: '输入超过 512K token 后整条请求按 $0.6 / $2.4（缓存 $0.12）计价',
}

/* 智谱国内站按千 token 分界，所以这里的 32K 是 32,000，不是 32,768。 */
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
 * 阿里的阶梯按输入长度分档，价目页明确 **K = 1,000、M = 1,000,000**。
 * 区间是左开右闭（「32K-256K」不含 32,000），所以第一个进高档的数是边界 + 1。
 */

/** qwen3.7-plus：256K 以上整条按 ¥6 / ¥24 / 命中 ¥1.2。 */
const QWEN_37_PLUS_LONG: LongContextTier = {
  thresholdTokens: 256_001,
  input: 6,
  output: 24,
  cacheRead: 1.2,
  note: '输入超过 256K token 后整条请求按 ¥6 / ¥24（缓存 ¥1.2）计价',
}

/** qwen3.7-flash：三档，官方页面把命中价也逐档给了。 */
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
 * qwen3-vl-flash：三档。
 *
 * **命中价只有第一档是官方给的**（¥0.03，即输入价的 20%），后两档按同一个比例推。
 * 不推的话这两档只能留成第一档的 ¥0.03，那是把长请求按最短那一档记账。
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
 * 这一刻、这么大的一条请求，实际单价是多少。
 *
 * **目录里那组数字是厂商公布的标准价**，这个函数把偏离标准价的两种情况叠上去：
 * 分时段折扣（按星期与钟点）和长上下文档（按提示词大小）。两者互相独立，
 * 直接连乘——没有哪家同时有这两种，但代码不必为此多一个分支。
 *
 * 两种都没有就返回 `spec.pricing` 本身、**同一个对象引用**：
 * 绝大多数模型走这条路，不为它们每次都新建一个对象。
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
  // 取提示词达到的**最高**一档。依赖 `longContext` 是升序的，约定写在字段上。
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
 * 按当前时间取值，不写死——否则账单会从九月一号起静默算错。
 */
const SONNET_5_INTRO_ENDS = Date.UTC(2026, 7, 31, 23, 59, 59)

function sonnet5Pricing(now = Date.now()): Pricing {
  return now <= SONNET_5_INTRO_ENDS ? anthropicPricing(2, 10) : anthropicPricing(3, 15)
}

/**
 * Gemini 3.6 / 3.7 Flash 的促销价，2026-12-31 之后回到 $1.50 / $7.50 / $0.15。
 *
 * 与 `sonnet5Pricing` 同一个形状、同一条理由：**按当前时间取值，不写死**，
 * 否则账单会从一月一号起静默算错。
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
 * 与 `sonnet5Pricing`、`geminiFlashPromo` 同一个形状、同一条理由：**按当前时间取值，
 * 不写死**，否则账单会从九月一日起静默算错。
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
   * **没有直连实测过。** 斜率法只在中转站上测到中文约 1.03 token/字，同一段文本
   * 换长度重测的斜率在 1.03 与 1.31 之间跳，不作数。上界档对它偏保守，
   * 表现是读数偏高。直连量过之后在这里填自己那一档。
   */
  density: DEFAULT_DENSITY,
  maxOutputTokens: 128_000,
  // Claude 5 与 4 系全部收图片（官方模型页的输入模态一栏）。
  vision: true,
  video: false,
  // Anthropic 走显式 `cache_control` 断点，没有亲和键这回事。
  cacheRouting: 'none' as const,
  thinking: 'adaptive_only' as const,
  reasoningEcho: 'none' as const,
  chatReasoningProtocol: 'standard' as const,
  chatToolSchema: 'native' as const,
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
 * - **按人民币标价**（官方价目页就是 ¥）。记成美元的话数字差七倍。
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
 * | v4-flash-vision-exp | 高峰 | ¥0.10 | ¥3.0 | ¥9.0 |
 * | v4-flash-vision-exp | 空闲 | ¥0.05 | ¥1.5 | ¥4.5 |
 *
 * 实测（2026-08）：`deepseek-chat` 与 `deepseek-reasoner` 都被服务端解析成
 * `deepseek-v4-flash`。**别名不进目录**——指向哪个模型由服务端说了算、随时可改，
 * 而目录里一条别名对用户就是「多一个看起来不一样的模型」。真要用别名就自己填 id，
 * 届时按未收录处理（`configNotices` 会点名说清）。
 */
function deepseekCatalog(): ModelSpec[] {
  const base = {
    provider: 'openai_chat_completions' as const,
    vendor: 'deepseek',
    contextWindow: 1_000_000,
    density: DEEPSEEK_DENSITY,
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
    // 只有下面那条视觉实验模型收图片，flash 与 pro 都不收。
    vision: false,
    video: false,
    // chat/completions 那支的回传由 `openai-compat` 无条件发 `reasoning_content`，
    // 不读这一格。要回传的是下面 Responses 那支。
    reasoningEcho: 'none' as const,
    chatReasoningProtocol: 'standard' as const,
    chatToolSchema: 'openai_strict' as const,
    effortLevels: ['high', 'max'] as EffortLevel[],
    thinksByDefault: false,
    // 兼容协议没有显式缓存断点，命中完全靠前缀逐字节稳定。
    minCacheablePrefix: 0,
    cacheRouting: 'prompt_cache_key' as const,
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
   * 视觉实验模型。窗口、输出上限、思考控制面、计价与 flash 完全相同，
   * 唯一差别是接受图片输入。
   *
   * 图片缩放后按输入 token 计入，单张上限 384 token，**没有单独的图片价目**——
   * 不要为它在 `Pricing` 上加一条轴，那会是一个零消费者的字段。
   *
   * 边界：只接受 JPEG / PNG / GIF / WebP，不接受 PDF 与文档。
   */
  const vision: ModelSpec = {
    ...base,
    id: 'deepseek-v4-flash-vision-exp',
    displayName: 'DeepSeek V4 Flash Vision',
    vision: true,
    pricing: { ...flash.pricing },
  }

  /**
   * Responses 协议下的同一批模型，**能力不同所以单独一条**。
   *
   * 差别不是「协议名不一样」，是**思考能不能被控制**：
   * - 走 chat/completions 时客户端不发思考相关字段，无从控制 → `thinking: 'none'`。
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
    /*
     * 带 tool_calls 的历史不回传 `reasoning_text` 就 400，实测原话与回传规则
     * 记在 `providers/openai-responses.ts` 的文件头。
     *
     * **`thinking` 与 OpenAI 同为 `reasoning_effort` 不代表这一格也同**：
     * 那条轴说的是 effort 旋钮，这条说的是回传要求，两者正交。
     */
    reasoningEcho: 'reasoning_text',
    thinksByDefault: true,
    // **这一格的实测是在这条协议下做的，与上面 chat/completions 那条各自独立。**
    // Responses 只有 `reasoning.effort` 一个旋钮，没有 DeepSeek 那个 `thinking`
    // 开关可配；实测四档全部返回 200 而 reasoning_tokens 都是 899~900，
    // 一档都没被采纳。chat/completions 那边两个字段一起发是另一回事，
    // 各自的结论各自记，不合并。
    effortLevels: [],
  })

  return [
    { ...flash, thinksByDefault: true },
    { ...pro, thinksByDefault: true },
    { ...vision, thinksByDefault: true },
    responses(flash),
    responses(pro),
    responses(vision),
  ]
}

/**
 * 未知模型的保守默认值。
 *
 * BYOK 场景下用户可能填任意模型名（中转站的自定义名、本地 ollama 模型、明天才发布的
 * 模型）。这里给一组不会让请求失败的默认值：不声明 thinking、不声明 effort、
 * 不声明采样参数限制、计价为 0（前端显示「未知计价」而不是显示一个错的数字）。
 */
export function unknownModel(id: string, provider: ProviderKind): ModelSpec {
  return {
    id,
    displayName: id,
    provider,
    // 未收录 = 没有厂商。别按 id 猜——中转站的模型名可以是任意字符串。
    vendor: null,
    /*
     * **这一条必须被消费。** 下面那些值是「没测」，不是「不支持」——
     * 而 ARCHITECTURE §27 记的正是这两者不能合并。
     *
     * 具体后果有两条，都完全静默：
     *
     * 1. `thinking: 'none'` → `buildReasoning` 整个省略 reasoning 字段，
     *    因此**这个模型永远不会思考**。用户配了 `gpt-5.6` 期待思考，
     *    拿到的是 `reasoning_tokens: 0`，没有任何报错。
     * 2. `pricing` 全零 → `qy usage` 报 $0。**账本与实际不符**，
     *    而账本正是用来发现「怎么突然变贵了」的那份记录。
     *
     * 保守默认本身是对的（乱发 reasoning 字段会让不支持的端点每次 400），
     * 错的是不说。`configNotices` 据这个字段提醒，出口是 `qy probe --save`。
     */
    catalogued: false,
    /*
     * 未收录 = **没测过**，不是不支持。所以不发亲和键：自建端点（ollama / vLLM）
     * 对未知字段的容忍度没验过，而它们全都落在这一档。
     * 想开就在配置里那一格填 `cacheRouting`，或者跑 `qy probe --save`。
     */
    cacheRouting: 'none',
    /*
     * **判错的两个方向代价不对等，所以往大的一侧给。** 给小了每轮提前压缩，
     * 白花钱又丢上下文，而且完全静默；给大了撞窗拿到的是带 `capacity` 的
     * `context_overflow`，`loop.ts` 据它压一次再重发，有终态。
     *
     * 取 256K 不取 1M：1M 是当前发布里最常见的标称档，但中转站按自己的策略截、
     * 本地 ollama 按 `num_ctx` 给，实际可用窗口小于标称是常态。
     * 知道确切窗口就在模型库那一格填 `contextWindow`。
     */
    // 未收录 = 没标定过，走上界档。读数偏高，但不会把超限的请求判成装得下。
    density: DEFAULT_DENSITY,
    contextWindow: 256_000,
    /*
     * **不申报输出上限。** 未收录 = 没测过，而这一格编一个数的代价是静默截断：
     * 8192 之上的正常回答会在那里断掉，界面上只有一个 `max_tokens` 停止原因。
     * 想钉死就在模型库那一格填 `maxOutputTokens`。
     */
    maxOutputTokens: null,
    // 没有出处就不裁决：挡住一个实际收图片的中转站模型，比不挡更糟。
    vision: null,
    video: false,
    pricing: { input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0 },
    thinking: 'none',
    /*
     * 未收录 = 没测过。不回传是保守的那一侧：多发一个条目会让不要求回传的端点
     * 每一轮工具调用之后都 400，而少发只在要求回传的端点上 400，且那个 400
     * 带着对方的明文原话。想开就在模型库那一格填 `reasoningEcho`。
     */
    reasoningEcho: 'none',
    chatReasoningProtocol: 'standard',
    chatToolSchema: 'openai_strict',
    effortLevels: [],
    thinksByDefault: false,
    minCacheablePrefix: 1024,
  }
}

/**
 * 其余七家。
 *
 * 窗口、默认最大输出、四档价、思考档位是 2026-07-30 的一份 seed，**没有在本仓
 * 逐条实测过**。改价要拿厂商现行价目表核，别凭印象改。
 *
 * `thinksByDefault`：有思考档位的填 `true`。它影响的是给思考预留多少输出上限，
 * 多留一点只是保守，少留会把回答从中间截断——两个方向的代价不对等。
 *
 * `minCacheablePrefix`：兼容协议的前缀缓存由服务端自动做、不需要显式断点，
 * 这个数在那条路上没有消费者，1024 只是占位。
 * **真正消费它的是 Anthropic 路径**（`providers/anthropic.ts`）——低于这个长度
 * 打断点不会报错，只是不生效，白付一次缓存写入的记账。
 *
 * **两个不要加回来的能力位。**
 *
 * `rejectsSamplingParams` / `maxCacheBreakpoints`：两个都会是零消费者。
 *
 * `maxCacheBreakpoints` 只有两个取值：Anthropic 恒 4、兼容协议恒 0。
 * 那是**协议常量**不是模型能力，而本仓只用 2 个断点——一个逐模型不变的字段，
 * 放在逐模型的目录里就是误导。断点数写在用它的那个适配器里。
 *
 * `vision` 不在这份名单里：它有三个消费者，取值是三态而不是布尔，
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
    // 没标定过的一律上界档。标定过的在自己那条上覆盖。
    density: DEFAULT_DENSITY,
    // 逐条按厂商规格页覆盖。这一档是「没有出处」，不裁决。
    vision: null as boolean | null,
    video: false,
  }
  /** OpenAI 兼容的命名档位，走 chat/completions 的 `reasoning_effort`。 */
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
   * 会思考，但用哪个字段控制、有哪几档没有出处。档位照保守留空——多声明一档的
   * 代价是一个选了没反应的控件；默认思考照保守填 `true`——思考与正文共用输出上限，
   * 少留会把回答从中间截断。
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
  const GPT_56_EFFORTS: EffortLevel[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max']

  return [
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
     * 官方定价页（2026-08）逐字，单位 $/百万：
     *
     * | 模型 | 输入 | 输出 | 缓存 | 备注 |
     * |---|---|---|---|---|
     * | gemini-3.1-pro-preview | 2.00 | 12.00 | 0.20 | >200k：4.00 / 18.00 / 0.40 |
     * | gemini-3.7-flash | 0.75 | 3.75 | 0.075 | 促销至 2026-12-31，之后 1.50 / 7.50 / 0.15 |
     * | gemini-3.6-flash | 0.75 | 3.75 | 0.075 | 同上 |
     * | gemini-3.5-flash | 1.50 | 9.00 | 0.15 | |
     *
     * **这三条容易记错**：Flash 不是 0.3/2.5，Pro 有长上下文档，
     * 而且 Pro 的 id 是 `gemini-3.1-pro-preview`。
     *
     * 3.6 / 3.5 Flash 另有 `minimal`；3.7 Flash 与 3.1 Pro 从 `low` 起。
     * 四条模型页均给出 1,048,576 输入与 65,536 输出上限。
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
     * 4.6 明确不设文本输出上限；4.5 页面也未声明独立输出上限，均不猜数。
     */
    {
      ...base,
      ...effort(['low', 'medium', 'high', 'xhigh']),
      id: 'grok-4.6',
      displayName: 'Grok 4.6',
      vendor: 'xai',
      // xAI 的工具 schema 天然按 required/optional 严格采样；不要套 OpenAI 的
      // “全部 required + nullable”，否则模型会被迫给 probe_url 等可选项编值。
      chatToolSchema: 'native',
      // xAI Chat Completions 的缓存亲和键是请求头，不是请求体 prompt_cache_key。
      cacheRouting: 'x_grok_conv_id',
      vision: true,
      contextWindow: 500_000,
      maxOutputTokens: null,
      pricing: usd(2, 6, 0.5),
      longContext: [GROK_46_LONG],
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
     * 官方模型页（2026-08）逐字，华北 2（北京），单位 ¥/百万：
     *
     * | 模型 | 窗口 | 最大输出 | 输入 | 输出 | 命中 | 输入模态 |
     * |---|---|---|---|---|---|---|
     * | qwen3.8-max | 1,000,000 | 131,072 | 12 | 36 | 1.5 | Image、Text、Video |
     * | qwen3.8-flash | 1,000,000 | 131,072 | 0.8 | 2.7 | 0.1 | Image、Text、Video |
     * | qwen3.7-max | 1,000,000 | 131,072 | 12 | 36 | 2.4 | Text |
     * | qwen3.7-plus | 1,000,000 | 131,072 | 2 | 8 | 0.4 | Image、Text、Video |
     * | qwen3.7-flash | 1,000,000 | 131,072 | 0.2 | 0.8 | 0.04 | Image、Text、Video |
     * | qwen3-vl-plus | 262,144 | 32,768 | 1 | 10 | 0.2 | Image、Text、Video |
     * | qwen3-vl-flash | 262,144 | 32,768 | 0.15 | 1.5 | 0.03 | Image、Text、Video |
     *
     * **最大输出那一列容易记错**：plus 与 flash 都是 131,072。
     *
     * `qwen3.7-max` 是这一批里唯一只收文本的：它的日期快照版收图片，基础版不收，
     * 名字上分不出来——逐条按规格页填，不按 id 前缀推断。
     *
     * Qwen3.8 的 Chat API 明确支持 `none / low / medium / xhigh`，默认 xhigh；
     * 同时默认保留思考并要求历史 `reasoning_content` 完整、原序回放。
     * 3.7 系是混合思考且默认开启，但没有同一组命名 effort 档；VL 两款默认关闭。
     *
     * `qwen3.8-max-prime` 不进目录：价目页上有它（¥24 / ¥72），模型页取不到，
     * 窗口与最大输出没有出处，而这两项没法留空。
     *
     * **`Qwen3.8-Flash-Next` 不是这里的 `qwen3.8-flash`，别填错。** 前者是开放权重
     * 版本（自部署，原生 256K，没有官方 API 定价），后者是托管服务的模型 id，
     * 1M 窗口与上面那一行价目都出自它的模型页。目录收的是 API 上调得到的那个 id。
     */
    {
      ...base,
      ...effort(['none', 'low', 'medium', 'xhigh']),
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
      ...effort(['none', 'low', 'medium', 'xhigh']),
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
     * 价目来源：智谱国内站价目表（2026-08），逐字，单位 ¥/百万：
     *
     * | 模型 | 输入 | 缓存命中 | 输出 |
     * |---|---|---|---|
     * | glm-5.3 | 8 | 2 | 28 |
     * | glm-5.3-flash | 0.8（限时 0.4） | 0.23（限时 0.115） | 2.8（限时 1.4） |
     * | glm-5.2 | 8 | 2 | 28 |
     * | glm-4.7 | 2 | 0.4 | 8 |
     * | glm-5v-turbo | 5 | 1.2 | 22 |
     * | glm-4.6v | 1 | 0.2 | 3 |
     *
     * 4.7 还按输入 32K、输出 200 双轴分档；两款视觉模型按输入 32K 分档。
     * 这些档位必须进入计价函数，不能只把首页第一行抄进目录。
     *
     * **图片输入按价目页的分节填**：文本模型一节里的三条（5.3 / 5.2 / 4.7）
     * 只收文本，视觉模型一节里的（5v-turbo / 4.6v）收图片。glm-5.3 的模型页
     * 另有一句明写「当前不支持图片输入」。
     *
     * glm-5.3 的窗口 1M / 最大输出 131,072 与三档 `reasoning_effort`（默认 max、
     * 思考关不掉）来自它的模型规格页。5.2 同样支持 low / high / max。
     *
     * glm-5.3-flash 的模型页：1M 窗口、131,072 最大输出、原生多模态；
     * 与 5.3 同样支持 low / high / max。两条都要求思考恒开，完整回放历史
     * `reasoning_content`，并用 `clear_thinking:false` 保留连续思考。
     *
     * glm-5v-turbo 的模型页：200K 窗口、128K 最大输出、收图片视频文本文件，
     * 思考是一个开关而不是档位。glm-4.6v：128K 窗口、32K 最大输出。
     */
    {
      ...base,
      ...effort(['low', 'high', 'max']),
      id: 'glm-5.3',
      displayName: 'GLM-5.3',
      vendor: 'zhipu',
      vision: false,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      pricing: cny(8, 28, 2),
      chatReasoningProtocol: 'glm_preserved',
      // 智谱只公开标准 required/optional Function Call 形状；不要套 OpenAI strict 的
      // 「全部 required + nullable」。Flash 实测会把 JSON null 采样成字符串 "null"。
      chatToolSchema: 'native',
      // 国内站缓存自动识别公共前缀、无需手动参数，不发送未声明的 prompt_cache_key。
      cacheRouting: 'none',
    },
    {
      ...base,
      ...effort(['low', 'high', 'max']),
      id: 'glm-5.3-flash',
      displayName: 'GLM-5.3 Flash',
      vendor: 'zhipu',
      vision: true,
      video: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 131_072,
      pricing: glm53FlashPromo(now),
      chatReasoningProtocol: 'glm_preserved',
      chatToolSchema: 'native',
      cacheRouting: 'none',
    },
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
  /**
   * 接不接受图片输入。**只能手填**——探针不探这一轴：探出「这次发过去没报错」
   * 不等于这条链路稳定收图片，而探出报错也分不清是模型不收还是这一次参数写错了。
   *
   * 这一格是中转站模型的唯一出口：内置目录认不出它们的自定义名，
   * 目录里落在 `null`（不裁决）。填了 `false` 才会挡图片。
   */
  vision?: boolean
  input?: number
  output?: number
  /** 缓存命中价。 */
  cacheRead?: number
  /**
   * 缓存写入价。**只覆盖 5 分钟那一档**——`computeCost` 只按它算，
   * 全项目从不请求 1 小时缓存。`cacheWrite1h` 留在价目表里是参考数据，
   * 没有可达的代码分支，所以也没有让人改它的理由。
   */
  cacheWrite?: number
  currency?: 'USD' | 'CNY'
  /**
   * 思考三项。它们既是用户手填的参数，也是 `qy probe --save` 的落点——
   * 探测得到的就是「这条模型在这条协议上的思考能力」，与窗口、价格同属模型库。
   */
  thinking?: ThinkingMode
  effortLevels?: EffortLevel[]
  thinksByDefault?: boolean
  /**
   * 回传推理原文。探针不覆盖这一轴（探不出来的不猜），只能手填——
   * 中转站把 DeepSeek 挂在自定义模型名下时，内置目录认不出它，这一格是唯一出口。
   */
  reasoningEcho?: ReasoningEcho
  /**
   * 缓存路由。与思考三项同属「探测得到、也可手填」的那一类，落点也是同一处。
   *
   * 它比思考更需要按端点覆盖：缓存能力是「端点 × 模型」那一格的属性，
   * 换个中转站同一个模型就是另一条结论，内置表只能给 seed。
   */
  cacheRouting?: CacheRouting
}

/**
 * 把用户改过的参数叠到目录条目上。**seed → 用户覆盖**，只有这一个顺序。
 *
 * 两条边界：
 *
 * - **只覆盖写了的字段。** 缓存两档要改就单独填，**不按 input 等比例推算**——
 *   推算出来的是个看起来精确的假数字，而各家缓存定价的比例本来就不一样
 *   （Anthropic 写入是 1.25x，DeepSeek 写入不要钱）。
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
    // 布尔，`false` 是有效覆盖（正是「挡住图片」那一档），只能按 `undefined` 判缺省。
    ...(o.vision !== undefined ? { vision: o.vision } : {}),
    ...(o.thinking ? { thinking: o.thinking } : {}),
    ...(o.reasoningEcho ? { reasoningEcho: o.reasoningEcho } : {}),
    ...(o.effortLevels ? { effortLevels: o.effortLevels } : {}),
    ...(o.cacheRouting ? { cacheRouting: o.cacheRouting } : {}),
    // `thinksByDefault` 是布尔，`false` 是有效覆盖，只能按 `undefined` 判缺省。
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

/** 全部内置模型。仅用于能力约束与计价，不是可用模型的白名单。 */
export function builtinCatalog(now = Date.now()): ModelSpec[] {
  return [...claudeCatalog(now), ...deepseekCatalog(), ...openAiCompatCatalog(now)]
}

/**
 * 查目录。
 *
 * **先按 `(id, provider)` 精确匹配：同一个模型在不同协议下能力不一样。** 实测（2026-08）
 * `deepseek-v4-flash`：走 chat/completions 时客户端不发思考相关字段，思考无从控制；走 Responses
 * 时 `reasoning.effort:'none'` 能真的关掉它。一个条目描述不了两种协议，所以目录允许同 id 多条、按
 * provider 区分。
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
 * 不保证能力属实**。因此 `effortLevels` 还是那五档，但兼容协议不发 Anthropic
 * 的 `output_config.effort`。界面照着那五档画一个 chip，选了没有任何反应。
 *
 * 判据按协议分：
 * - `anthropic`：适配器只看 `effortLevels` 非空就发 `output_config.effort`。
 * - `openai_responses`：只有 `reasoning.effort` 一条路。
 * - `openai_chat_completions`：`reasoning_effort`（OpenAI 那套）或 `deepseek_thinking`
 *   （DeepSeek 要两个字段一起发），其余一律发不出去。
 *
 * 与 `openai-compat.ts` 的 `buildReasoning` 是同一份判断的两个用途：
 * 这里答「能不能」，那里答「用哪几个字段」。改一处务必看另一处。
 */
export function effortIsTransmittable(spec: ModelSpec): boolean {
  if (spec.effortLevels.length === 0) return false
  if (spec.provider === 'anthropic_messages') return true
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
  // 三项相加才是这一次的提示词大小：三个数是排他的，漏掉写入那项会让长上下文档
  // 在一次冷启动上判不到——而冷启动正是写入量最大的那一次。
  const p = priceAt(spec, {
    now,
    promptTokens: usage.inputTokens + (usage.cachedTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
    outputTokens: usage.outputTokens,
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
