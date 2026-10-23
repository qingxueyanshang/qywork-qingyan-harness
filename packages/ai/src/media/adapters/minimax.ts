/**
 * `minimax_speech`：MiniMax 同步语音合成 `POST {base}/t2a_v2`，非流式。
 *
 * 目录参数平铺，按接口结构放入 `voice_setting` 与 `audio_setting`，其余放在请求体顶层。
 * 音频为 hex 编码。HTTP 200 时 `base_resp.status_code` 非 0 仍是失败。按 `extra_info.usage_characters` 计费。
 */

import { normalizeBaseUrl } from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import { count, defined, postJson, sniffMime } from '../http.ts'
import { failureDetail } from '../task.ts'
import {
  type MediaAdapter,
  MediaError,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
  type MediaUsage,
} from '../types.ts'

const VOICE_FIELDS = ['voice_id', 'speed', 'vol', 'pitch', 'emotion']
const AUDIO_FIELDS = ['format', 'sample_rate', 'bitrate', 'channel']

const FORMAT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
}

export class MiniMaxSpeechAdapter implements MediaAdapter {
  readonly kind = 'minimax_speech' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const rest: Record<string, unknown> = { ...req.params }
    // 音色必填；画布省略默认值时发送目录中的默认音色。
    rest.voice_id ??= this.spec.params.find((p) => p.name === 'voice_id')?.default
    const take = (fields: readonly string[]) => {
      const out: Record<string, unknown> = {}
      for (const f of fields) {
        if (rest[f] !== undefined) out[f] = rest[f]
        delete rest[f]
      }
      return out
    }
    const voice = take(VOICE_FIELDS)
    const audio = take(AUDIO_FIELDS)
    const body = await postJson(
      `${normalizeBaseUrl(this.profile.baseUrl)}/t2a_v2`,
      {
        model: this.profile.model,
        text: req.prompt,
        stream: false,
        voice_setting: voice,
        ...(Object.keys(audio).length ? { audio_setting: audio } : {}),
        ...rest,
      },
      { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers },
      opts.signal,
    )
    const status = body.base_resp as { status_code?: unknown; status_msg?: unknown } | undefined
    if (typeof status?.status_code === 'number' && status.status_code !== 0)
      throw new MediaError(
        `接口拒绝生成：${failureDetail(status.status_code, status.status_msg, '未提供原因')}`,
      )
    const hex = (body.data as { audio?: unknown } | null | undefined)?.audio
    if (typeof hex !== 'string' || !hex) throw new MediaError('接口没有返回音频')
    const bytes = new Uint8Array(Buffer.from(hex, 'hex'))
    const extra = body.extra_info as
      | { usage_characters?: unknown; audio_format?: unknown }
      | undefined
    const format = String(extra?.audio_format ?? audio.format ?? 'mp3')
    return {
      files: [{ bytes, mime: sniffMime(bytes) ?? FORMAT_MIME[format] ?? 'audio/mpeg' }],
      usage: defined<MediaUsage>({ characters: count(extra?.usage_characters) }),
    }
  }
}
