/**
 * `openai_images`：OpenAI 形状的图片生成接口 `/images/generations` 与 `/images/edits`。
 *
 * OpenAI、中转站、火山方舟 Seedream、百炼兼容接口共用此形状，差别只有两处，均由目录声明：
 * 参考图使用 multipart `/edits`（OpenAI、New API）还是 JSON 的 `image` 字段（火山、百炼兼容）；
 * 结果位于 `b64_json`（GPT Image 只返回该字段）还是 `url`（百炼兼容只返回该字段），两者都读取。
 *
 * **不发送 `response_format`**：GPT Image 不接受该字段，发送后整个请求被拒绝；其余两家默认返回 url，直接读取即可。
 */

import { basename } from 'node:path'
import { normalizeBaseUrl } from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import { count, dataUri, defined, download, postJson, send, sniffMime } from '../http.ts'
import {
  type MediaAdapter,
  MediaError,
  type MediaFile,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
  type MediaUsage,
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
    const result = await readImages(body, signal)
    return { ...result, usage: readUsage(body, result.files.length) }
  }
}

/**
 * 响应中的 `usage`。OpenAI 返回 token（`input_tokens_details` 区分文字与图片）；火山返回成功张数 `generated_images`、
 * 输入张数 `input_images` 与 `output_tokens`（像素总数 / 256）。张数以接口返回为准，未返回时取实际收到的张数。
 */
function readUsage(body: Record<string, unknown>, received: number): MediaUsage {
  const u = (body.usage ?? {}) as Record<string, unknown>
  const input = (u.input_tokens_details ?? {}) as Record<string, unknown>
  return defined<MediaUsage>({
    images: count(u.generated_images) ?? received,
    inputImages: count(u.input_images),
    inputTextTokens: count(input.text_tokens),
    inputImageTokens: count(input.image_tokens),
    outputTokens: count(u.output_tokens),
  })
}

/** 响应中的 `data[]`：每项是 `b64_json` 或 `url`。单项失败（火山逐张报错）合并到消息中，不静默丢弃。 */
export async function readImages(
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Pick<MediaResult, 'files' | 'warning'>> {
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
  return {
    files,
    ...(errors.length ? { warning: `部分图片生成失败：${errors.join('；')}` } : {}),
  }
}
