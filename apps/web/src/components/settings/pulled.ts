/**
 * 拉取结果写入配置：刷新接口上已添加型号的价格与已下架标记；添加用户选定的型号。
 * 两个函数都只计算新的配置对象，由调用方经 `replaceConfig` 保存；没有变化时返回 null。
 */

import { defaultMediaKind, formatMoney, type MediaOutput, mediaKindOutput } from '@qywork/core'
import type {
  MediaLibraryModel,
  PulledModel,
  PullResult,
  RedactedConfig,
  RedactedMediaModel,
  RedactedModel,
} from '../../lib/store/index.ts'

/**
 * 拉取结果中有的型号：对话型号更新价格（价格不明时删除旧价格），对话与生成型号都清除已下架标记。
 * 拉取结果中没有的型号：只有来源是第三方接口的计费清单时标记已下架，型号列表不完整，不据此标记。
 */
export function refreshPulled(
  cur: RedactedConfig,
  provider: string,
  result: PullResult,
): RedactedConfig | null {
  const owner = cur.providers[provider]
  if (!owner) return null
  const pulled = new Map(result.models.map((m) => [m.id, m]))
  const complete = result.source === 'pricing'
  const models = Object.fromEntries(
    Object.entries(owner.models).map(([id, m]): [string, RedactedModel] => {
      const hit = pulled.get(id)
      const { price: _price, delisted: _delisted, kind: _kind, ...rest } = m
      if (!hit) return [id, complete ? { ...m, delisted: true } : m]
      const price = hit.output === 'chat' ? hit.price : m.price
      // 协议随每次拉取更新：型号改为支持接口的协议后，拉取结果不再带 `kind`，此处随之删除。
      const kind = hit.output === 'chat' ? hit.kind : m.kind
      return [id, { ...rest, ...(kind ? { kind } : {}), ...(price ? { price } : {}) }]
    }),
  )
  const media = Object.fromEntries(
    Object.entries(owner.media ?? {}).map(([id, m]): [string, RedactedMediaModel] => {
      const { delisted: _delisted, ...rest } = m
      if (!pulled.has(id)) return [id, complete ? { ...m, delisted: true } : m]
      return [id, rest]
    }),
  )
  const next = {
    ...owner,
    models,
    ...(owner.media ? { media } : {}),
  }
  if (JSON.stringify(next) === JSON.stringify(owner)) return null
  return { ...cur, providers: { ...cur.providers, [provider]: next } }
}

/** 已确定类别的型号：未知型号须先选定类别（`withCategory`）。 */
export type ClassifiedModel = Exclude<PulledModel, { output: 'unknown' }>

/** 选定的型号，`model` 已按对应型号确定类别（`withBase`）；未收录的型号可带对应型号。 */
export interface PulledPick {
  model: ClassifiedModel
  base?: string
}

/** 按用户选定的类别归类未知型号，协议按接口地址取默认值；其余型号与未选定类别时为拉取结果本身。 */
export function withCategory(
  model: PulledModel,
  output: 'chat' | MediaOutput | undefined,
  baseUrl: string | undefined,
): PulledModel {
  if (model.output !== 'unknown' || !output) return model
  if (output === 'chat') return { id: model.id, output, known: false }
  return { id: model.id, output, kind: defaultMediaKind(output, baseUrl), known: false }
}

/**
 * 按对应型号确定添加时的类别。对话型号的对应型号是生成目录中的型号时改按该型号的类别添加，协议按接口地址取默认值，
 * 与 `identifyMediaModel` 中以目录 id 为前缀的名称相同；其余情况为拉取结果本身。生成型号的对应型号只能是同类别的生成目录。
 * 类别改变时不保留拉取到的价格：价格属于原类别。
 */
export function withBase(
  model: PulledModel,
  base: string | undefined,
  library: readonly MediaLibraryModel[],
  baseUrl: string | undefined,
): PulledModel {
  const output = library.find((m) => m.id === base)?.output
  if (!output || output === model.output) return model
  return { id: model.id, output, kind: defaultMediaKind(output, baseUrl), known: false }
}

/**
 * 添加选定的型号。对话型号写入价格，对应型号写入模型库覆盖（「型号 × 协议」）；生成型号写入协议，
 * 对应型号写入 `spec: { base }`。
 * 没有默认对话模型时，第一个添加的对话型号成为默认模型；某一类生成没有默认模型时，第一个添加的成为默认。
 * 已有的默认值不改变。
 */
export function addPulled(
  cur: RedactedConfig,
  provider: string,
  picks: readonly PulledPick[],
): RedactedConfig | null {
  const owner = cur.providers[provider]
  if (!owner) return null
  const models = { ...owner.models }
  const media = { ...owner.media }
  const catalog = { ...cur.catalog }
  const mediaDefaults = { ...cur.mediaDefaults }
  for (const { model, base } of picks) {
    if (model.id in models || model.id in media) continue
    if (model.output === 'chat') {
      models[model.id] = {
        ...(model.kind ? { kind: model.kind } : {}),
        ...(model.price ? { price: model.price } : {}),
      }
      if (base) {
        const key = `${model.id}|${model.kind ?? owner.kind}`
        catalog[key] = { ...catalog[key], base }
      }
      continue
    }
    media[model.id] = { kind: model.kind, ...(base ? { spec: { base } } : {}) }
    const output = mediaKindOutput(model.kind)
    mediaDefaults[output] ??= { provider, model: model.id }
  }
  if (
    Object.keys(models).length === Object.keys(owner.models).length &&
    Object.keys(media).length === Object.keys(owner.media ?? {}).length
  )
    return null
  const firstChat = Object.keys(models).find((id) => !(id in owner.models))
  return {
    ...cur,
    providers: {
      ...cur.providers,
      [provider]: { ...owner, models, ...(Object.keys(media).length ? { media } : {}) },
    },
    ...(Object.keys(catalog).length ? { catalog } : {}),
    ...(Object.keys(mediaDefaults).length ? { mediaDefaults } : {}),
    // 与手动添加相同：只在没有默认对话模型时设置。
    ...(!cur.active && firstChat ? { active: { provider, model: firstChat } } : {}),
  }
}

/** 参考素材上限的写法，如「图≤30、视频≤10、音频≤10」；为 0 或省略的项不写。 */
export function referenceLimits(l: {
  maxImages?: number
  maxVideos?: number
  maxAudios?: number
}): string {
  return [
    l.maxImages ? `图≤${l.maxImages}` : '',
    l.maxVideos ? `视频≤${l.maxVideos}` : '',
    l.maxAudios ? `音频≤${l.maxAudios}` : '',
  ]
    .filter(Boolean)
    .join('、')
}

/**
 * 对话型号的价格摘要：每百万 Token 的输入与输出（有分时段折扣时为高峰价并注明折扣）。生成型号与价格不明时为空串。
 */
export function priceSummary(model: PulledModel): string {
  if (model.output !== 'chat' || !model.price) return ''
  const price = model.price
  if ('scale' in price) return `官方价 × ${price.scale}`
  const discount = price.offPeak
    ? ` · 空闲时段 ${Math.round(price.offPeak.rate * 100) / 10} 折`
    : ''
  return `输入 ${formatMoney(price.input, price.currency)} · 输出 ${formatMoney(price.output, price.currency)} /百万${discount}`
}
