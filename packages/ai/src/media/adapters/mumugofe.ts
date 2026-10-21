/** Mumugofe 的原图上传与回执校验、任务扣费的折算；任务生命周期仍由 OpenAIVideosAdapter 负责。 */
import { createHash } from 'node:crypto'
import type { Currency } from '@qywork/core'
import { quotaAmount } from '../../pull/pricing.ts'
import { getJson, sendJson } from '../http.ts'
import { MediaError, type MediaInput } from '../types.ts'

/**
 * 任务记录中的扣费额度按站点状态（`/api/status`）折算为金额。站点状态无法读取时返回 undefined：
 * 成片已取得，不因此使生成失败，该次金额按单价计算，单价不明时记为不明。
 */
export async function mumugofeBilled(
  base: string,
  quota: number,
  signal: AbortSignal,
): Promise<{ amount: number; currency: Currency } | undefined> {
  try {
    const status = await getJson(`${new URL(base).origin}/api/status`, {}, signal)
    return quotaAmount(quota, (status.data ?? {}) as Record<string, unknown>)
  } catch (err) {
    if (!(err instanceof MediaError)) throw err
    return undefined
  }
}

export async function uploadMumugofeReference(
  input: MediaInput,
  base: string,
  auth: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  const digest = createHash('sha256').update(input.bytes).digest('hex')
  let uploaded = ''
  await sendJson(
    `${base}/studio/assets/${digest}`,
    {
      method: 'PUT',
      headers: { ...auth, 'content-type': input.mime },
      body: new Blob([input.bytes]),
      redirect: 'error',
    },
    signal,
    {
      stage: 'upload',
      validate(body) {
        const asset = body.asset as { id?: unknown; sha256?: unknown; bytes?: unknown } | undefined
        const url = typeof body.url === 'string' ? URL.parse(body.url) : null
        if (
          !asset ||
          asset.sha256 !== digest ||
          asset.bytes !== input.bytes.length ||
          typeof asset.id !== 'string' ||
          !new RegExp(`^studioasset_[a-f0-9]{64}_${digest}$`).test(asset.id) ||
          !url ||
          !['https:', 'http:'].includes(url.protocol) ||
          url.origin !== new URL(base).origin ||
          url.username ||
          url.password ||
          url.hash ||
          url.pathname !== `/v1/studio/assets/${asset.id}/artifacts/source/content` ||
          !url.search
        )
          return '参考图上传后的文件或地址校验失败'
        uploaded = url.href
      },
    },
  )
  return uploaded
}
