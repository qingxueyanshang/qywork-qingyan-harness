/**
 * 工作区中媒体文件的播放时长（秒）。视频取 ISO 容器 `mvhd` 中的时长（`movieMetadataOfFile`），音频按文件头与帧头计算
 * （`audioDurationOf`）。画布的生成结果、时间线片段的校验与生成工具的回执共用此函数，不另行解析。
 * 不是这两类文件、无法识别或读取失败时返回 null，调用方不显示时长。
 */

import { readFileSync, statSync } from 'node:fs'
import { audioDurationOf } from '@qywork/core'
import { movieMetadataOfFile } from './video-meta.ts'

const VIDEO_RE = /\.(mp4|mov|m4v)$/i
const AUDIO_RE = /\.(wav|mp3|ogg|opus|flac|aac)$/i
/** MP3 与 AAC 逐帧累加，须读入整个文件；超过该大小不读取。语音与配乐远小于此值。 */
const MAX_AUDIO = 64 * 1024 * 1024

export function mediaDurationOfFile(abs: string): number | null {
  try {
    if (VIDEO_RE.test(abs)) return movieMetadataOfFile(abs)?.duration ?? null
    if (!AUDIO_RE.test(abs) || statSync(abs).size > MAX_AUDIO) return null
    return audioDurationOf(new Uint8Array(readFileSync(abs)))
  } catch {
    return null
  }
}
