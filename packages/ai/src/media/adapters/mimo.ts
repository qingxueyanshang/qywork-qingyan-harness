/**
 * `mimo_speech`：小米 MiMo 语音合成，经对话接口 `POST {base}/chat/completions`，非流式。
 *
 * 朗读文本必须放在 assistant 消息中，放在 user 消息中会被当作指令而不朗读。`instructions` 有值时作为 user 消息发送；
 * 其余参数放入 `audio`。参考音频（声音复刻样本）以 data URI 写入 `audio.voice`。
 * 结果为 `choices[0].message.audio.data` 中的 Base64 音频。
 */

import { normalizeBaseUrl } from '../../providers/openai-compat.ts'
import type { MediaModelSpec } from '../catalog.ts'
import { count, dataUri, defined, postJson, sniffMime } from '../http.ts'
import {
  type MediaAdapter,
  MediaError,
  type MediaProfile,
  type MediaRequest,
  type MediaResult,
  type MediaRunOptions,
  type MediaUsage,
} from '../types.ts'

const FORMAT_MIME: Record<string, string> = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
}

export class MiMoSpeechAdapter implements MediaAdapter {
  readonly kind = 'mimo_speech' as const

  constructor(
    private readonly profile: MediaProfile,
    readonly spec: MediaModelSpec,
  ) {}

  async run(req: MediaRequest, opts: MediaRunOptions): Promise<MediaResult> {
    const { instructions, ...audio } = req.params
    const sample = req.inputs.find((i) => i.role === 'audio')
    const body = await postJson(
      `${normalizeBaseUrl(this.profile.baseUrl)}/chat/completions`,
      {
        model: this.profile.model,
        messages: [
          ...(typeof instructions === 'string' && instructions
            ? [{ role: 'user', content: instructions }]
            : []),
          { role: 'assistant', content: req.prompt },
        ],
        audio: { ...audio, ...(sample ? { voice: dataUri(sample.bytes, sample.mime) } : {}) },
        stream: false,
      },
      { authorization: `Bearer ${this.profile.apiKey}`, ...this.profile.headers },
      opts.signal,
    )
    const choice = (body.choices as Record<string, unknown>[] | undefined)?.[0]
    const message = choice?.message as { audio?: { data?: unknown } } | undefined
    const data = message?.audio?.data
    if (typeof data !== 'string' || !data)
      throw new MediaError(
        choice?.finish_reason === 'content_filter'
          ? '内容被过滤，接口没有返回音频'
          : '接口没有返回音频',
      )
    const bytes = new Uint8Array(Buffer.from(data, 'base64'))
    const usage = (body.usage ?? {}) as Record<string, unknown>
    return {
      files: [
        {
          bytes,
          mime: sniffMime(bytes) ?? FORMAT_MIME[String(audio.format ?? 'wav')] ?? 'audio/wav',
        },
      ],
      usage: defined<MediaUsage>({
        inputTokens: count(usage.prompt_tokens),
        outputTokens: count(usage.completion_tokens),
      }),
    }
  }
}
