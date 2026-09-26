/**
 * `openai_speech`：OpenAI 形状的语音合成 `POST {base}/audio/speech`，OpenAI、New API、One API 共用。
 *
 * 请求是 JSON，响应体直接是音频字节。格式先按文件头认，认不出再用 `response_format`：
 * `pcm` 没有文件头，只能按请求时的格式定。
 */

import { normalizeBaseUrl } from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import { send, sniffMime } from '../http.ts'
import type {
  MediaAdapter,
  MediaProfile,
  MediaRequest,
  MediaResult,
  MediaRunOptions,
} from '../types.ts'

const FORMAT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/pcm',
}

export class OpenAISpeechAdapter implements MediaAdapter {
  readonly kind = 'openai_speech' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const res = await send(
      `${normalizeBaseUrl(this.profile.baseUrl)}/audio/speech`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.profile.apiKey}`,
          ...this.profile.headers,
        },
        body: JSON.stringify({ model: this.profile.model, input: req.prompt, ...req.params }),
      },
      opts.signal,
    )
    const bytes = new Uint8Array(await res.arrayBuffer())
    const format = String(req.params.response_format ?? 'mp3')
    return { files: [{ bytes, mime: sniffMime(bytes) ?? FORMAT_MIME[format] ?? 'audio/mpeg' }] }
  }
}
