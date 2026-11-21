/**
 * 拉取接口上的型号：第三方接口的公开计费清单（New API 的 `/api/pricing`）优先，没有时退回 OpenAI 兼容的 `{base}/models`；
 * 退回时若站点有模型广场（`/api/v1/model-plaza`），对话型号的价格按 `plaza.ts` 折算。
 *
 * 计费清单与 New API 的型号列表给出每个型号的接口类型，类别按接口类型与名称确定（`categoryOf`）；价格按 `pricing.ts` 折算。
 * 接口地址属于登记的渠道（`registerPullChannel`）时，由该渠道完成拉取，或按渠道目录给出生成型号保存的规格；
 * 其余站点的生成型号不带规格，使用协议默认。
 * 只读：不写配置，写入由调用方经配置接口完成。
 */

import {
  type ChannelSpec,
  catalogPrefixOf,
  defaultMediaKind,
  identifyMediaModel,
  type MediaKind,
  type MediaOutput,
  mediaKindOutput,
  type ProviderKind,
} from '@qywork/core'
import { builtinCatalog, lookupModel } from '../catalog.ts'
import { bodyMessage, httpStatusName } from '../errors.ts'
import { mediaCatalog, mediaKindsOf } from '../media/catalog.ts'
import { normalizeBaseUrl } from '../providers/openai-compat.ts'
import { PROVIDER_HEADERS, PROVIDER_HTTP } from '../types.ts'
import { type PulledPrice, plazaPrices } from './plaza.ts'
import { chatPriceOf, type NewApiPricingEntry, type PriceBasis, priceBasis } from './pricing.ts'

export interface PullTarget {
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
}

export type PulledModel =
  | {
      id: string
      output: 'chat'
      /**
       * 该型号使用的协议，只在它不支持接口的协议、而支持另一种协议时给出（计费清单的 `supported_endpoint_types`）；
       * 写入接口下该模型的 `kind`。
       */
      kind?: ProviderKind
      /** 模型库中有同名型号，规格按模型库取得。 */
      known: boolean
      /** 名称以模型库 id 为前缀时对应的模型库 id，见 `chatFields`。 */
      base?: string
      price?: PulledPrice
    }
  | {
      id: string
      output: MediaOutput
      kind: MediaKind
      /** 生成目录中有同名型号，或有渠道规格。 */
      known: boolean
      /** 名称以目录 id 为前缀时对应的目录 id，见 `identifyMediaModel`。 */
      base?: string
      /** 登记的渠道给出的保存规格（`registerPullChannel`）。 */
      spec?: ChannelSpec
    }
  /** 未知：条目没有类别，接口类型与名称也无法确定类别（`categoryOf`），由用户选定类别后添加。 */
  | { id: string; output: 'unknown' }

export interface PullResult {
  /**
   * `pricing`：列出全部可计费型号的清单（第三方接口的计费清单、渠道的完整目录），可据此标记已下架；
   * `models`：型号列表接口，官方接口可能不列出别名，不能据此标记已下架。
   */
  source: 'pricing' | 'models'
  models: PulledModel[]
}

/** 两种来源都无法读取。消息说明失败的地址与原因，不含凭证。 */
export class PullError extends Error {}

/** 登记的渠道拉取时使用的连接参数与条目构造。 */
export interface PullContext {
  target: PullTarget
  /** 站点根地址。 */
  origin: string
  /** 规范化的接口地址（`normalizeBaseUrl`）。 */
  base: string
  /** 带凭证的请求头。 */
  auth: Record<string, string>
  signal: AbortSignal
  /** 读取 JSON。连接失败、HTTP 错误与无法解析时抛出 `PullError`，消息含路径与原因。 */
  getJson(url: string, headers: Record<string, string>): Promise<unknown>
  /** 对话型号的条目。`types` 是条目支持的接口类型（New API 的取值），决定是否写明协议（`chatKindOf`）。 */
  chat(id: string, types: readonly string[], price?: PulledPrice): PulledModel
  /** 生成型号的条目：有保存规格时为已收录，否则按生成目录识别。 */
  media(id: string, output: MediaOutput, kind: MediaKind, spec?: ChannelSpec): PulledModel
}

/** 按 New API 计费清单中的条目取得生成型号保存的规格；渠道目录中没有该型号时返回 undefined。 */
export type PullSpecOf = (
  entry: NewApiPricingEntry,
  output: 'image' | 'video',
  basis: PriceBasis | null,
) => ChannelSpec | undefined

/**
 * 有自有目录的渠道。站点不是 New API 时由 `pull` 完成整个拉取；站点是 New API 而另有渠道目录时，
 * `specs` 读取目录（读取失败时返回的函数对每个条目都给出 undefined），计费清单中的生成型号按它取得保存的规格。
 */
export interface PullChannel {
  /** 接口地址属于该渠道。只按接口地址判定，不按返回的字段判定：其他站点可能返回同名字段。 */
  matches(baseUrl: string): boolean
  pull?(ctx: PullContext): Promise<PullResult>
  specs?(ctx: PullContext): Promise<PullSpecOf>
}

const PULL_CHANNELS: PullChannel[] = []

/** 登记有自有目录的渠道。电脑端不登记任何渠道。 */
export function registerPullChannel(channel: PullChannel): void {
  PULL_CHANNELS.push(channel)
}

/** 单个请求的上限。拉取由用户点击触发，等待过久时按失败处理，由用户重试。 */
const TIMEOUT_MS = 20_000

/** New API 的接口类型中，对话类请求的取值。 */
const CHAT_ENDPOINTS = ['openai', 'openai-response', 'anthropic', 'gemini']

/** 接口类型中生成类请求的取值。`video` 不是 New API 的取值，第三方接口用它标记视频型号。 */
const MEDIA_ENDPOINTS: Readonly<Record<string, 'image' | 'video'>> = {
  'openai-video': 'video',
  video: 'video',
  'image-generation': 'image',
}

/** 既不能对话、也没有对应生成协议的接口类型：只带这些类型的条目不列出。 */
const UNLISTED_ENDPOINTS = [
  'embeddings',
  'jina-rerank',
  'rerank',
  'realtime',
  'audio-transcription',
]

/**
 * 条目的类别，计费清单与型号列表共用。依次按：接口类型中的生成类型；只带不可用的类型时不列出（返回 null）；
 * 名称（生成目录 `identifyMediaModel`，模型库 `chatFields`）；接口类型全部为对话类型时归入对话；其余为未知。
 * 名称先于对话类型：第三方接口常把生成型号也标为 `openai`。带有未登记类型（如第三方自定义的语音接口）的条目
 * 不按对话类型归类，该条目上的 `openai` 不能说明它是对话型号。
 */
function categoryOf(
  types: readonly string[],
  media: { output: MediaOutput } | undefined,
  chat: { known: boolean; base?: string },
): 'chat' | MediaOutput | 'unknown' | null {
  const typed = types.map((t) => MEDIA_ENDPOINTS[t])
  if (typed.includes('video')) return 'video'
  if (typed.includes('image')) return 'image'
  if (types.length && types.every((t) => UNLISTED_ENDPOINTS.includes(t))) return null
  if (media) return media.output
  if (chat.known || chat.base) return 'chat'
  if (types.length && types.every((t) => CHAT_ENDPOINTS.includes(t))) return 'chat'
  return 'unknown'
}

/** 型号列表条目中的接口类型。New API 的型号列表与计费清单都带有该字段，其他站点没有。 */
function endpointTypesOf(entry: Record<string, unknown>): string[] {
  const types = entry.supported_endpoint_types
  return Array.isArray(types) ? types.filter((t): t is string => typeof t === 'string') : []
}

/** 接口类型与协议的对应。`gemini` 没有对应的协议。 */
const ENDPOINT_KIND: Readonly<Record<string, ProviderKind>> = {
  openai: 'openai_chat_completions',
  'openai-response': 'openai_responses',
  anthropic: 'anthropic_messages',
}

/**
 * 型号应使用的协议：支持接口的协议时返回 undefined（沿用接口的协议），否则返回它支持的第一种协议。
 * 不要无条件写入：第三方接口的型号通常同时支持多种接口类型，写入后用户修改接口协议时这些型号不再随之改变。
 */
export function chatKindOf(
  types: readonly string[],
  providerKind: ProviderKind,
): ProviderKind | undefined {
  const kinds = types.flatMap((t) => (ENDPOINT_KIND[t] ? [ENDPOINT_KIND[t]] : []))
  return kinds.length && !kinds.includes(providerKind) ? kinds[0] : undefined
}

async function getJson(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, {
      ...PROVIDER_HTTP.fetchOptions,
      headers: { ...PROVIDER_HEADERS, accept: 'application/json', ...headers },
      signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
    })
  } catch (err) {
    signal.throwIfAborted()
    throw new PullError(`${new URL(url).pathname} 连接失败：${(err as Error).message}`)
  }
  if (!res.ok) {
    const reason = bodyMessage(await res.text().catch(() => ''))
    throw new PullError(
      `${new URL(url).pathname} 返回 HTTP ${res.status} ${httpStatusName(res.status)}${reason ? `：${reason}` : ''}`,
    )
  }
  try {
    return await res.json()
  } catch {
    throw new PullError(`${new URL(url).pathname} 返回的内容不是 JSON`)
  }
}

/** 读取失败时返回 null：站点状态是可选来源。 */
const optional = (p: Promise<unknown>) =>
  p.catch((err) => {
    if (!(err instanceof PullError)) throw err
    return null
  })

const record = (v: unknown) =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

function listOf(body: unknown, key: string): Record<string, unknown>[] | undefined {
  const list = record(body)?.[key]
  return Array.isArray(list) ? list.flatMap((e) => (record(e) ? [record(e)!] : [])) : undefined
}

/**
 * 对话型号是否已收录：名称在模型库中即已收录。不在时按前缀识别（`catalogPrefixOf`），
 * 名称以模型库 id 为前缀时给出该 id 作为对应型号（第三方接口的自定义名称，如 `gemini-4-argon-high`），添加时规格按它取得。
 */
function chatFields(id: string, kind: ProviderKind): { known: boolean; base?: string } {
  if (lookupModel(id, kind).catalogued !== false) return { known: true }
  const base = catalogPrefixOf(
    id,
    builtinCatalog().map((m) => m.id),
  )
  return base ? { known: false, base } : { known: false }
}

/**
 * 计费清单中的生成型号是否已收录：有渠道规格，或名称与同类别的目录 id 完全一致。
 * 名称以同类别的目录 id 为前缀时给出对应型号。
 */
function catalogFields(
  id: string,
  output: MediaOutput,
  spec: ChannelSpec | undefined,
  baseUrl: string,
): { known: boolean; base?: string } {
  if (spec) return { known: true }
  const hit = identifyMediaModel(id, mediaLibrary(), baseUrl)
  if (!hit || hit.output !== output) return { known: false }
  return hit.base ? { known: false, base: hit.base } : { known: true }
}

/** 供 `identifyMediaModel` 识别的生成目录：带各条目已核实的协议，第三方接口据此改用通用协议。 */
const mediaLibrary = () =>
  mediaCatalog().map((m) => ({ id: m.id, kind: m.kind, kinds: mediaKindsOf(m) }))

function contextOf(target: PullTarget, signal: AbortSignal): PullContext {
  const base = normalizeBaseUrl(target.baseUrl)
  return {
    target,
    origin: new URL(base).origin,
    base,
    auth: {
      ...(target.kind === 'anthropic_messages'
        ? { 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01' }
        : { authorization: `Bearer ${target.apiKey}` }),
      ...target.headers,
    },
    signal,
    getJson: (url, headers) => getJson(url, headers, signal),
    chat(id, types, price) {
      const kind = chatKindOf(types, target.kind)
      return {
        id,
        output: 'chat',
        ...(kind ? { kind } : {}),
        ...chatFields(id, kind ?? target.kind),
        ...(price ? { price } : {}),
      }
    },
    media: (id, output, kind, spec) => ({
      id,
      output,
      kind,
      ...catalogFields(id, output, spec, target.baseUrl),
      ...(spec ? { spec } : {}),
    }),
  }
}

async function fromPricing(
  entries: NewApiPricingEntry[],
  pricing: unknown,
  ctx: PullContext,
  channel: PullChannel | undefined,
): Promise<PullResult> {
  const [status, specOf] = await Promise.all([
    optional(ctx.getJson(`${ctx.origin}/api/status`, {})),
    channel?.specs?.(ctx),
  ])
  // 站点状态读取失败时无法确定充值价与币种，价格不明。
  const statusData = record(record(status)?.data)
  const basis = statusData ? priceBasis(record(pricing) ?? {}, statusData) : null
  const models = new Map<string, PulledModel>()
  for (const entry of entries) {
    const id = entry.model_name
    if (models.has(id)) continue
    const types = entry.supported_endpoint_types ?? []
    const media = identifyMediaModel(id, mediaLibrary(), ctx.target.baseUrl)
    const kind = chatKindOf(types, ctx.target.kind)
    const output = categoryOf(types, media, chatFields(id, kind ?? ctx.target.kind))
    if (output === null) continue
    if (output === 'unknown') {
      models.set(id, { id, output })
    } else if (output === 'chat') {
      models.set(id, ctx.chat(id, types, basis ? chatPriceOf(entry, basis) : undefined))
    } else {
      // 接口类型给出类别时按站点的通用协议；只按名称识别时使用目录的识别结果。
      const typed = types.some((t) => MEDIA_ENDPOINTS[t] === output)
      const mediaKind =
        !typed && media?.output === output
          ? media.kind
          : defaultMediaKind(output, ctx.target.baseUrl)
      const spec = output === 'audio' ? undefined : specOf?.(entry, output, basis)
      models.set(id, ctx.media(id, output, mediaKind, spec))
    }
  }
  return { source: 'pricing', models: [...models.values()] }
}

/**
 * 厂商自有生成协议的目录条目：接口地址的默认协议不同于通用协议时，该协议只由该厂商提供，
 * 目录中该协议的条目即该厂商的型号。官方型号列表可能不含这些型号（MiniMax 只列出对话型号），由此补齐。
 */
function ownProtocolModels(baseUrl: string): PulledModel[] {
  return mediaCatalog().flatMap((m): PulledModel[] => {
    const output = mediaKindOutput(m.kind)
    const own = defaultMediaKind(output, baseUrl)
    if (own !== m.kind || own === defaultMediaKind(output, undefined)) return []
    return [{ id: m.id, output, kind: m.kind, known: true }]
  })
}

/** 方舟型号条目的 `domain`。null 为向量与 3D 型号：既不能对话也没有对应的生成协议，不列出。 */
const DOMAIN_OUTPUT: Record<string, 'chat' | MediaOutput | null> = {
  LLM: 'chat',
  VLM: 'chat',
  Router: 'chat',
  ImageGeneration: 'image',
  VideoGeneration: 'video',
  Embedding: null,
  '3DGeneration': null,
}

const MODALITY_OUTPUT: Record<string, 'chat' | MediaOutput> = {
  text: 'chat',
  image: 'image',
  video: 'video',
  audio: 'audio',
}

/**
 * 条目自带的类别：先读 `domain`，没有时读 `modalities.output_modalities`（输出含文字即为对话）。
 * 返回 null 表示不列出（含 `status` 为 `Shutdown` 的已下线型号）；undefined 表示条目只有名称，由调用方按名称识别。
 * 方舟的条目带这些字段，但部分条目 `domain` 为空或缺少输出模态，因此两者依次读取。
 */
function declaredOutput(entry: Record<string, unknown>): 'chat' | MediaOutput | null | undefined {
  if (entry.status === 'Shutdown') return null
  const domain = typeof entry.domain === 'string' ? DOMAIN_OUTPUT[entry.domain] : undefined
  if (domain !== undefined) return domain
  const out = record(entry.modalities)?.output_modalities
  if (!Array.isArray(out) || !out.length) return undefined
  const outputs = out.flatMap((m) =>
    typeof m === 'string' && MODALITY_OUTPUT[m] ? [MODALITY_OUTPUT[m]] : [],
  )
  return outputs.includes('chat') ? 'chat' : (outputs[0] ?? null)
}

/**
 * 型号列表接口：条目带类别（`declaredOutput`）时按类别归类，否则按接口类型与名称归类（`categoryOf`）。
 * 列表中没有的厂商自有协议型号按目录补齐（`ownProtocolModels`）。
 * 类别为生成而目录中没有该名称时，协议按接口地址取默认值（`defaultMediaKind`），不带规格。
 */
function fromModelList(
  entries: Record<string, unknown>[],
  target: PullTarget,
  prices: ReadonlyMap<string, PulledPrice> | null,
): PullResult {
  const listed = new Map<string, PulledModel>()
  for (const entry of entries) {
    const id = entry.id
    if (typeof id !== 'string' || listed.has(id)) continue
    const declared = declaredOutput(entry)
    if (declared === null) continue
    const types = endpointTypesOf(entry)
    const media = identifyMediaModel(id, mediaLibrary(), target.baseUrl)
    const kind = chatKindOf(types, target.kind)
    const chat = chatFields(id, kind ?? target.kind)
    const output = declared ?? categoryOf(types, media, chat)
    if (output === null) continue
    if (output === 'unknown') {
      listed.set(id, { id, output })
    } else if (output === 'chat') {
      const price = prices?.get(id)
      listed.set(id, {
        id,
        output,
        ...(kind ? { kind } : {}),
        ...chat,
        ...(price ? { price } : {}),
      })
    } else if (media?.output === output) {
      listed.set(id, {
        id,
        output,
        kind: media.kind,
        known: !media.base,
        ...(media.base ? { base: media.base } : {}),
      })
    } else {
      listed.set(id, {
        id,
        output,
        kind: defaultMediaKind(output, target.baseUrl),
        known: false,
      })
    }
  }
  const own = ownProtocolModels(target.baseUrl).filter((m) => !listed.has(m.id))
  return { source: 'models', models: [...listed.values(), ...own] }
}

export async function pullModels(target: PullTarget, signal: AbortSignal): Promise<PullResult> {
  const ctx = contextOf(target, signal)
  const channel = PULL_CHANNELS.find((c) => c.matches(target.baseUrl))
  if (channel?.pull) return channel.pull(ctx)
  const pricing = await optional(ctx.getJson(`${ctx.origin}/api/pricing`, {}))
  const entries = listOf(pricing, 'data')?.filter(
    (e): e is Record<string, unknown> & NewApiPricingEntry => typeof e.model_name === 'string',
  )
  if (entries?.length) return fromPricing(entries, pricing, ctx, channel)

  const [listed, plaza] = await Promise.all([
    ctx.getJson(`${ctx.base}/models`, ctx.auth),
    optional(ctx.getJson(`${ctx.origin}/api/v1/model-plaza`, {})),
  ])
  const models = listOf(listed, 'data')
  if (!models) throw new PullError(`${new URL(ctx.base).pathname}/models 返回的格式无法识别`)
  return fromModelList(models, target, plaza ? plazaPrices(plaza, target.kind) : null)
}
