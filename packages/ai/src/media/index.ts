/**
 * 生成适配器的唯一构造入口：按 `profile.kind` 分派一次，之后调用方只见 `MediaAdapter`。
 * 具体类不导出，理由同对话适配器（`../factory.ts`）。
 */

import { ArkVideosAdapter } from './adapters/ark-videos.ts'
import {
  DashScopeImagesAdapter,
  DashScopeSpeechAdapter,
  DashScopeVideosAdapter,
} from './adapters/dashscope.ts'
import { KlingVideosAdapter } from './adapters/kling.ts'
import { OpenAIImagesAdapter } from './adapters/openai-images.ts'
import { OpenAISpeechAdapter } from './adapters/openai-speech.ts'
import { OpenAIVideosAdapter } from './adapters/openai-videos.ts'
import { lookupMediaModel } from './catalog.ts'
import type { MediaAdapter, MediaProfile } from './types.ts'

export function buildMediaAdapter(profile: MediaProfile): MediaAdapter {
  const spec = lookupMediaModel(profile.model, profile.kind)
  switch (profile.kind) {
    case 'openai_images':
      return new OpenAIImagesAdapter(profile, spec)
    case 'dashscope_images':
      return new DashScopeImagesAdapter(profile, spec)
    case 'openai_videos':
      return new OpenAIVideosAdapter(profile, spec)
    case 'ark_videos':
      return new ArkVideosAdapter(profile, spec)
    case 'dashscope_videos':
      return new DashScopeVideosAdapter(profile, spec)
    case 'kling_videos':
      return new KlingVideosAdapter(profile, spec)
    case 'openai_speech':
      return new OpenAISpeechAdapter(profile, spec)
    case 'dashscope_speech':
      return new DashScopeSpeechAdapter(profile, spec)
  }
}
