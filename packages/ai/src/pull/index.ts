/**
 * 拉取接口上的型号：中转的公开计费清单（New API 的 `/api/pricing`）优先，没有时退回 OpenAI 兼容的 `{base}/models`。
 *
 * 计费清单给出每个型号的接口类型，据此区分对话、图像与视频；价格按 `pricing.ts` 折算。
 * 视频型号再按渠道目录（hongcheng 工作台目录、木木目录）、图像型号按木木目录取得保存的规格；
 * 目录中没有该型号时不带规格，使用协议默认。
 * 只读：不写配置，写入由调用方经配置接口完成。
 */

import {
  type ChannelSpec,
  type ChannelVideoSpec,
  defaultMediaKind,
  identifyMediaModel,
  MEDIA_KIND_OUTPUT,
  type MediaKind,
  type MediaOutput,
  type ProviderKind,
} from '@qywork/core'
import { lookupModel } from '../catalog.ts'
import { bodyMessage, httpStatusName } from '../errors.ts'
import { mediaCatalog } from '../media/catalog.ts'
import {
  channelMediaSpec,
  hongchengVideoSpec,
  mumugofeImageSpec,
  mumugofeVideoSpec,
} from '../media/channels.ts'
import { normalizeBaseUrl } from '../providers/openai-compat.ts'
import { PROVIDER_HEADERS, PROVIDER_HTTP } from '../types.ts'
import {
  type ChatPrice,
  chatPriceOf,
  imagePriceOf,
  type NewApiPricingEntry,
  type PriceBasis,
  priceBasis,
  videoPriceOf,
} from './pricing.ts'

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
      /** 模型库中有同名型号，规格按模型库取得。 */
      known: boolean
      price?: ChatPrice
    }
  | {
      id: string
      output: MediaOutput
      kind: MediaKind
      /** 生成目录中有同名型号，或有渠道规格。 */
      known: boolean
      /** 名称是目录 id 加后缀时对应的目录 id，见 `identifyMediaModel`。 */
      base?: string
      spec?: ChannelSpec
    }
  /** 未知：条目没有类别，名称也不在模型库与生成目录中，由用户选定类别后添加。 */
  | { id: string; output: 'unknown' }

export interface PullResult {
  /**
   * `pricing`：中转的计费清单，列出全部可计费型号，可据此标记已下架；
   * `models`：型号列表接口，官方接口可能不列出别名，不能据此标记已下架。
   */
  source: 'pricing' | 'models'
  models: PulledModel[]
}

/** 两种来源都无法读取。消息说明失败的地址与原因，不含凭证。 */
export class PullError extends Error {}

/** 单个请求的上限。拉取由用户点击触发，等待过久时按失败处理，由用户重试。 */
const TIMEOUT_MS = 20_000

/** New API 的接口类型中，对话类请求的取值。 */
const CHAT_ENDPOINTS = ['openai', 'openai-response', 'anthropic', 'gemini']

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

/** 读取失败时返回 null：渠道目录与站点状态是可选来源。 */
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
 * 渠道规格中各分辨率档位对应的参数可选值，用于按公式逐档求价；时长单独传入。
 * 计量中的 `resolution` 取该档位：渠道按它计价时请求可能只发送尺寸。
 */
function tiersOf(id: string, spec: ChannelVideoSpec): Record<string, Record<string, string[]>> {
  const tiers: Record<string, Record<string, string[]>> = {}
  for (const resolution of spec.resolutions) {
    const choices: Record<string, string[]> = {}
    for (const p of channelMediaSpec(id, { ...spec, resolutions: [resolution] }).params) {
      if (p.name === 'seconds') continue
      const values = p.shapes?.flatMap((s) => (s.value === undefined ? [] : [s.value])) ?? p.values
      if (values?.length) choices[p.name] = values.map(String)
    }
    choices.resolution ??= [resolution]
    tiers[resolution] = choices
  }
  return tiers
}

/**
 * 计费清单中的生成型号是否已收录：有渠道规格，或名称与同类别的目录 id 完全一致。
 * 名称是同类别的目录 id 加后缀时给出对应型号。
 */
function catalogFields(
  id: string,
  output: MediaOutput,
  spec: ChannelSpec | undefined,
  baseUrl: string,
): { known: boolean; base?: string } {
  if (spec) return { known: true }
  const hit = identifyMediaModel(id, mediaCatalog(), baseUrl)
  if (!hit || hit.output !== output) return { known: false }
  return hit.base ? { known: false, base: hit.base } : { known: true }
}

function videoOf(
  entry: NewApiPricingEntry,
  basis: PriceBasis | null,
  hongcheng: Record<string, unknown> | undefined,
  mumugofe: Record<string, unknown> | undefined,
  baseUrl: string,
): PulledModel {
  const id = entry.model_name
  const parsed = hongcheng
    ? hongchengVideoSpec(hongcheng)
    : mumugofe
      ? mumugofeVideoSpec(mumugofe)
      : null
  let spec = parsed ?? undefined
  // 木木按请求中的 resolution 计价的型号，不传时渠道按默认档位出图，提交时须发送与尺寸对应的档位。
  if (spec?.channel === 'mumugofe' && entry.billing_usage_schema?.resolution)
    spec = { ...spec, resolutionField: true }
  const price = spec && basis && videoPriceOf(entry, basis, spec.seconds, tiersOf(id, spec))
  if (spec && price) spec = { ...spec, price }
  return {
    id,
    output: 'video',
    kind: 'openai_videos',
    ...catalogFields(id, 'video', spec, baseUrl),
    ...(spec ? { spec } : {}),
  }
}

function imageOf(
  entry: NewApiPricingEntry,
  basis: PriceBasis | null,
  mumugofe: Record<string, unknown> | undefined,
  baseUrl: string,
): PulledModel {
  const id = entry.model_name
  let spec = (mumugofe && mumugofeImageSpec(mumugofe)) || undefined
  const price = spec && basis && imagePriceOf(entry, basis, spec.resolutions)
  if (spec && price) spec = { ...spec, price }
  return {
    id,
    output: 'image',
    kind: 'openai_images',
    ...catalogFields(id, 'image', spec, baseUrl),
    ...(spec ? { spec } : {}),
  }
}

async function fromPricing(
  entries: NewApiPricingEntry[],
  pricing: unknown,
  origin: string,
  target: PullTarget,
  signal: AbortSignal,
): Promise<PullResult> {
  const [status, workbench, typetale] = await Promise.all([
    optional(getJson(`${origin}/api/status`, {}, signal)),
    optional(getJson(`${origin}/api/workbench-models`, {}, signal)),
    optional(getJson(`${origin}/docs/typetale-models.json`, {}, signal)),
  ])
  // 站点状态读取失败时无法确定充值价与币种，价格不明。
  const statusData = record(record(status)?.data)
  const basis = statusData ? priceBasis(record(pricing) ?? {}, statusData) : null
  const hongcheng = new Map(
    (listOf(workbench, 'data') ?? []).flatMap((e) =>
      typeof e.api_model === 'string' ? [[e.api_model, e] as const] : [],
    ),
  )
  const mumugofe = new Map(
    (listOf(typetale, 'models') ?? []).flatMap((e) =>
      typeof e.id === 'string' ? [[e.id, e] as const] : [],
    ),
  )
  const models = new Map<string, PulledModel>()
  for (const entry of entries) {
    const id = entry.model_name
    if (models.has(id)) continue
    const types = entry.supported_endpoint_types ?? []
    if (types.includes('openai-video')) {
      models.set(id, videoOf(entry, basis, hongcheng.get(id), mumugofe.get(id), target.baseUrl))
    } else if (types.includes('image-generation')) {
      models.set(id, imageOf(entry, basis, mumugofe.get(id), target.baseUrl))
    } else if (types.some((t) => CHAT_ENDPOINTS.includes(t))) {
      const price = basis ? chatPriceOf(entry, basis) : undefined
      models.set(id, {
        id,
        output: 'chat',
        known: lookupModel(id, target.kind).catalogued !== false,
        ...(price ? { price } : {}),
      })
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
    const output = MEDIA_KIND_OUTPUT[m.kind]
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
 * 型号列表接口：条目带类别时按类别归类；只有名称时，生成目录中的名称（`identifyMediaModel`）归入对应类别，
 * 模型库中的名称归入对话，其余归为未知。列表中没有的厂商自有协议型号按目录补齐（`ownProtocolModels`）。
 * 类别为生成而目录中没有该名称时，协议按接口地址取默认值（`defaultMediaKind`），不带规格。
 */
function fromModelList(entries: Record<string, unknown>[], target: PullTarget): PullResult {
  const listed = new Map<string, PulledModel>()
  for (const entry of entries) {
    const id = entry.id
    if (typeof id !== 'string' || listed.has(id)) continue
    const declared = declaredOutput(entry)
    if (declared === null) continue
    const media = identifyMediaModel(id, mediaCatalog(), target.baseUrl)
    const known = lookupModel(id, target.kind).catalogued !== false
    const output = declared ?? media?.output ?? (known ? 'chat' : 'unknown')
    if (output === 'unknown') {
      listed.set(id, { id, output })
    } else if (output === 'chat') {
      listed.set(id, { id, output, known })
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
  const base = normalizeBaseUrl(target.baseUrl)
  const origin = new URL(base).origin
  const pricing = await optional(getJson(`${origin}/api/pricing`, {}, signal))
  const entries = listOf(pricing, 'data')?.filter(
    (e): e is Record<string, unknown> & NewApiPricingEntry => typeof e.model_name === 'string',
  )
  if (entries?.length) return fromPricing(entries, pricing, origin, target, signal)

  const auth: Record<string, string> =
    target.kind === 'anthropic_messages'
      ? { 'x-api-key': target.apiKey, 'anthropic-version': '2023-06-01' }
      : { authorization: `Bearer ${target.apiKey}` }
  const listed = await getJson(`${base}/models`, { ...auth, ...target.headers }, signal)
  const models = listOf(listed, 'data')
  if (!models) throw new PullError(`${new URL(base).pathname}/models 返回的格式无法识别`)
  return fromModelList(models, target)
}
