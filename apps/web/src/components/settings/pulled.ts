/**
 * 拉取结果写入配置：刷新接口上已添加型号的规格、价格与已下架标记；添加用户选定的型号。
 * 两个函数都只计算新的配置对象，由调用方经 `replaceConfig` 保存；没有变化时返回 null。
 */

import { formatMoney, MEDIA_KIND_OUTPUT } from '@qywork/core'
import type {
  PulledModel,
  PullResult,
  RedactedConfig,
  RedactedMediaModel,
  RedactedModel,
} from '../../lib/store/index.ts'

/**
 * 拉取结果中有的型号：对话型号更新价格（价格不明时删除旧价格），生成型号在取得规格时更新规格，二者都清除已下架。
 * 拉取结果中没有的型号：只有来源是中转的计费清单时标记已下架，型号列表不完整，不据此标记。
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
      const { price: _price, delisted: _delisted, ...rest } = m
      if (!hit) return [id, complete ? { ...m, delisted: true } : m]
      const price = hit.output === 'chat' ? hit.price : m.price
      return [id, { ...rest, ...(price ? { price } : {}) }]
    }),
  )
  const media = Object.fromEntries(
    Object.entries(owner.media ?? {}).map(([id, m]): [string, RedactedMediaModel] => {
      const hit = pulled.get(id)
      const { delisted: _delisted, ...rest } = m
      if (!hit) return [id, complete ? { ...m, delisted: true } : m]
      return [id, hit.output !== 'chat' && hit.spec ? { ...rest, spec: hit.spec } : rest]
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

/** 选定的型号；对话型号不在模型库中时可带对应型号。 */
export interface PulledPick {
  model: PulledModel
  base?: string
}

/**
 * 添加选定的型号。对话型号写入价格，对应型号写入模型库覆盖（「型号 × 协议」）；生成型号写入协议与规格。
 * 接口原本没有对话型号时，第一个添加的对话型号成为默认模型；某一类生成没有默认模型时，第一个添加的成为默认。
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
      models[model.id] = model.price ? { price: model.price } : {}
      if (base) {
        const key = `${model.id}|${owner.kind}`
        catalog[key] = { ...catalog[key], base }
      }
      continue
    }
    if (model.unsupported) continue
    media[model.id] = { kind: model.kind, ...(model.spec ? { spec: model.spec } : {}) }
    const output = MEDIA_KIND_OUTPUT[model.kind]
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
    // 与手动添加相同：接口没有对话模型时不可用，添加第一个即切换到它。
    ...(Object.keys(owner.models).length === 0 && firstChat
      ? { active: { provider, model: firstChat } }
      : {}),
  }
}

/** 可选时长。没有渠道规格时为空串。 */
export function durationSummary(model: PulledModel): string {
  if (model.output === 'chat' || !model.spec) return ''
  const { seconds } = model.spec
  const first = seconds[0]!
  const last = seconds[seconds.length - 1]!
  return first === last ? `${first}秒` : `${first}–${last}秒`
}

/** 参考素材上限，写法与模型库表格相同。没有渠道规格时为空串。 */
export function referenceSummary(model: PulledModel): string {
  if (model.output === 'chat' || !model.spec) return ''
  const { maxImages, maxVideos, maxAudios } = model.spec
  return [
    maxImages ? `图≤${maxImages}` : '',
    maxVideos ? `视频≤${maxVideos}` : '',
    maxAudios ? `音频≤${maxAudios}` : '',
  ]
    .filter(Boolean)
    .join('、')
}

/** 价格摘要：对话为每百万 Token 的输入与输出，生成为每次或每秒。价格不明时为空串。 */
export function priceSummary(model: PulledModel): string {
  if (model.output === 'chat')
    return model.price
      ? `输入 ${formatMoney(model.price.input, model.price.currency)} · 输出 ${formatMoney(model.price.output, model.price.currency)} /百万`
      : ''
  const price = model.spec?.price
  if (!price) return ''
  return `${formatMoney(price.amount, price.currency)}/${price.per === 'request' ? '次' : '秒'}`
}
