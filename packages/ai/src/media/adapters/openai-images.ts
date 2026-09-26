/**
 * `openai_images`：OpenAI 形状的出图接口 `/images/generations` 与 `/images/edits`。
 *
 * OpenAI、中转站、火山方舟 Seedream、百炼兼容出图共用这一个形状，差别只有两处，都由目录声明：
 * 参考图走 multipart `/edits`（OpenAI、New API）还是走 JSON 的 `image` 字段（火山、百炼兼容）；
 * 结果在 `b64_json`（GPT Image 只回这个）还是 `url`（百炼兼容只回这个），两个都读。
 *
 * **不发 `response_format`**：GPT Image 不收这个字段，发了整个请求被拒；其余两家默认回 url，照读即可。
 */

import { basename } from 'node:path'
import { normalizeBaseUrl } from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import { dataUri, download, postJson, send, sniffMime } from '../http.ts'
import {
  type MediaAdapter,
  MediaError,
  type MediaFile,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
} from '../types.ts'

export class OpenAIImagesAdapter implements MediaAdapter {
  readonly kind = 'openai_images' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { signal } = opts
    const base = normalizeBaseUrl(this.profile.baseUrl)
    const auth = { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers }
    const multipart = req.inputs.length > 0 && this.spec.inputs.transport === 'multipart'

    let body: Record<string, unknown>
    if (multipart) {
      const form = new FormData()
      form.set('model', this.profile.model)
      form.set('prompt', req.prompt)
      for (const input of req.inputs) {
        form.append('image[]', new Blob([input.bytes], { type: input.mime }), basename(input.path))
      }
      for (const [key, value] of Object.entries(req.params)) form.set(key, String(value))
      const res = await send(
        `${base}/images/edits`,
        { method: 'POST', headers: auth, body: form },
        signal,
      )
      body = (await res.json()) as Record<string, unknown>
    } else {
      body = await postJson(
        `${base}/images/generations`,
        {
          model: this.profile.model,
          prompt: req.prompt,
          ...(req.inputs.length ? { image: req.inputs.map((i) => dataUri(i.bytes, i.mime)) } : {}),
          ...req.params,
        },
        auth,
        signal,
      )
    }
    return { files: await readImages(body, signal) }
  }
}

/** 响应里的 `data[]`：每项是 `b64_json` 或 `url`。单项失败（火山会逐张报错）并进消息，不静默丢。 */
async function readImages(
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<MediaFile[]> {
  const data = Array.isArray(body.data) ? (body.data as Record<string, unknown>[]) : []
  const files: MediaFile[] = []
  const errors: string[] = []
  for (const item of data) {
    if (typeof item.b64_json === 'string') {
      const bytes = new Uint8Array(Buffer.from(item.b64_json, 'base64'))
      files.push({ bytes, mime: sniffMime(bytes) ?? 'image/png' })
    } else if (typeof item.url === 'string') {
      files.push(await download(item.url, signal))
    } else if (item.error && typeof item.error === 'object') {
      errors.push(String((item.error as Record<string, unknown>).message ?? '单张生成失败'))
    }
  }
  if (files.length === 0) {
    throw new MediaError(
      errors.length ? `接口没有返回图片：${errors.join('；')}` : '接口没有返回图片',
    )
  }
  return files
}
