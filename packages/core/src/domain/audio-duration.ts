/**
 * 音频文件的播放时长（秒），按文件头与帧头计算，不解码。容器按开头的标识字节判断，不按扩展名判断。
 *
 * 支持语音模型实际返回的格式：WAV（PCM）、MP3（MPEG 音频，可带 ID3v2 标签与 Xing / Info 帧）、
 * OGG（Opus / Vorbis）、FLAC、AAC（ADTS）。无法识别或数据不完整时返回 null，调用方不显示时长。
 */

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i++) if (bytes[at + i] !== text.charCodeAt(i)) return false
  return true
}

function u32le(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0
}

function u32be(b: Uint8Array, at: number): number {
  return ((b[at]! << 24) | (b[at + 1]! << 16) | (b[at + 2]! << 8) | b[at + 3]!) >>> 0
}

export function audioDurationOf(bytes: Uint8Array): number | null {
  if (ascii(bytes, 0, 'RIFF') && ascii(bytes, 8, 'WAVE')) return wavDuration(bytes)
  if (ascii(bytes, 0, 'fLaC')) return flacDuration(bytes)
  if (ascii(bytes, 0, 'OggS')) return oggDuration(bytes)
  return mpegDuration(bytes) ?? adtsDuration(bytes)
}

/** data 块的字节数除以每秒字节数。data 块长度超出实际字节（流式编码写入的占位值）时按实际字节计算。 */
function wavDuration(b: Uint8Array): number | null {
  let byteRate = 0
  for (let at = 12; at + 8 <= b.length; ) {
    const size = u32le(b, at + 4)
    if (ascii(b, at, 'fmt ') && at + 20 <= b.length) byteRate = u32le(b, at + 16)
    if (ascii(b, at, 'data')) {
      const bytes = Math.min(size, b.length - at - 8)
      return byteRate > 0 ? bytes / byteRate : null
    }
    at += 8 + size + (size % 2)
  }
  return null
}

/** STREAMINFO 中的总采样数除以采样率；总采样数为 0 表示编码时未知。 */
function flacDuration(b: Uint8Array): number | null {
  if (b.length < 26 || (b[4]! & 0x7f) !== 0) return null
  const s = 8
  const rate = (b[s + 10]! << 12) | (b[s + 11]! << 4) | (b[s + 12]! >> 4)
  const total = (b[s + 13]! & 0x0f) * 2 ** 32 + u32be(b, s + 14)
  return rate > 0 && total > 0 ? total / rate : null
}

/**
 * 最后一页的粒度位置即结束处的采样位置。Opus 按 48 kHz 计，并减去 OpusHead 中的 pre-skip；
 * Vorbis 按标识头中的采样率计。
 */
function oggDuration(b: Uint8Array): number | null {
  const first = 27 + (b[26] ?? 0)
  let rate = 0
  let skip = 0
  if (ascii(b, first, 'OpusHead')) {
    rate = 48000
    skip = (b[first + 10] ?? 0) | ((b[first + 11] ?? 0) << 8)
  } else if (b[first] === 1 && ascii(b, first + 1, 'vorbis')) {
    rate = u32le(b, first + 12)
  }
  if (!rate) return null
  for (let at = b.length - 27; at >= 0; at--) {
    if (!ascii(b, at, 'OggS')) continue
    const granule = u32le(b, at + 6) + u32le(b, at + 10) * 2 ** 32
    return granule > skip ? (granule - skip) / rate : null
  }
  return null
}

const MPEG_BITRATE: Record<string, number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const MPEG_RATE: Record<number, number[]> = {
  1: [44100, 48000, 32000],
  2: [22050, 24000, 16000],
  25: [11025, 12000, 8000],
}

interface MpegFrame {
  length: number
  samples: number
  rate: number
  mpeg1: boolean
  mono: boolean
}

function mpegFrame(b: Uint8Array, at: number): MpegFrame | null {
  if (at + 4 > b.length || b[at] !== 0xff || (b[at + 1]! & 0xe0) !== 0xe0) return null
  const versionBits = (b[at + 1]! >> 3) & 3
  const layerBits = (b[at + 1]! >> 1) & 3
  if (versionBits === 1 || layerBits === 0) return null
  const version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 25
  const layer = 4 - layerBits
  const kbps = MPEG_BITRATE[`${version === 1 ? 1 : 2}-${layer}`]![b[at + 2]! >> 4]
  const rate = MPEG_RATE[version]![(b[at + 2]! >> 2) & 3]
  if (!kbps || !rate) return null
  const pad = (b[at + 2]! >> 1) & 1
  const mpeg1 = version === 1
  const samples = layer === 1 ? 384 : layer === 3 && !mpeg1 ? 576 : 1152
  const length =
    layer === 1
      ? Math.floor((12 * kbps * 1000) / rate + pad) * 4
      : Math.floor(((samples / 8) * kbps * 1000) / rate) + pad
  return { length, samples, rate, mpeg1, mono: b[at + 3]! >> 6 === 3 }
}

/**
 * MPEG 音频。先跳过 ID3v2 标签；第一帧带 Xing / Info 头且给出帧数时按帧数计算，并扣除 LAME 类标签记录的编码延迟与补齐，
 * 与播放器的无缝长度一致；否则逐帧累加采样数。第一帧之后的帧头不连续时视为不是 MPEG 音频。
 */
function mpegDuration(b: Uint8Array): number | null {
  let at = 0
  if (ascii(b, 0, 'ID3') && b.length >= 10) {
    const size =
      ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f)
    at = 10 + size + (b[5]! & 0x10 ? 10 : 0)
  }
  const first = mpegFrame(b, at)
  if (!first || !mpegFrame(b, at + first.length)) return null
  const side = first.mpeg1 ? (first.mono ? 17 : 32) : first.mono ? 9 : 17
  const tag = at + 4 + side
  if (ascii(b, tag, 'Xing') || ascii(b, tag, 'Info')) {
    const flags = u32be(b, tag + 4)
    if (flags & 1) {
      const frames = u32be(b, tag + 8)
      let p = tag + 12 + (flags & 2 ? 4 : 0) + (flags & 4 ? 100 : 0) + (flags & 8 ? 4 : 0)
      let trim = 0
      if (p + 24 <= b.length && b[p] !== 0) {
        p += 21
        trim = ((b[p]! << 4) | (b[p + 1]! >> 4)) + (((b[p + 1]! & 0x0f) << 8) | b[p + 2]!)
      }
      return Math.max(0, frames * first.samples - trim) / first.rate
    }
  }
  let samples = 0
  for (let frame: MpegFrame | null = first; frame; frame = mpegFrame(b, at)) {
    samples += frame.samples
    at += frame.length
  }
  return samples / first.rate
}

const ADTS_RATE = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350,
]

/** AAC（ADTS）：逐帧累加，每帧 1024 个采样。 */
function adtsDuration(b: Uint8Array): number | null {
  let at = 0
  let frames = 0
  let rate = 0
  while (at + 7 <= b.length && b[at] === 0xff && (b[at + 1]! & 0xf6) === 0xf0) {
    rate = ADTS_RATE[(b[at + 2]! >> 2) & 0x0f] ?? 0
    const length = ((b[at + 3]! & 3) << 11) | (b[at + 4]! << 3) | (b[at + 5]! >> 5)
    if (!rate || length < 7) return null
    frames += 1
    at += length
  }
  return frames > 1 && rate ? (frames * 1024) / rate : null
}
