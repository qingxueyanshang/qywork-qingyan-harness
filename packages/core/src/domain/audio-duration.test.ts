/**
 * 覆盖 `audio-duration.ts`：各格式按文件头与帧头计算的播放时长。
 *
 * 样本按语音模型实际返回的结构构造：千问语音合成的 WAV 头部长度为流式占位值；MP3 带 ID3v2 标签，
 * 一种为 MPEG-2 Layer III 22050 Hz 的连续帧，另一种为 MPEG-1 Layer III 32000 Hz、第一帧为 Info 头并带编码延迟与补齐。
 */

import { describe, expect, test } from 'bun:test'
import { audioDurationOf } from './audio-duration.ts'

/** 头部长度为流式占位值的 WAV：22050 Hz 单声道 16bit，`seconds` 秒采样。 */
function wav(seconds: number): Uint8Array {
  const pcm = Math.round(22050 * 2 * seconds)
  const b = Buffer.alloc(44 + pcm)
  b.write('RIFF', 0, 'latin1')
  b.writeUInt32LE(0x7fffffbf, 4)
  b.write('WAVEfmt ', 8, 'latin1')
  b.writeUInt32LE(16, 16)
  b.writeUInt16LE(1, 20)
  b.writeUInt16LE(1, 22)
  b.writeUInt32LE(22050, 24)
  b.writeUInt32LE(44100, 28)
  b.writeUInt16LE(2, 32)
  b.writeUInt16LE(16, 34)
  b.write('data', 36, 'latin1')
  b.writeUInt32LE(0x7fffff9b, 40)
  return new Uint8Array(b)
}

/** ID3v2.3 标签：10 字节头加 `size` 字节内容，长度按 syncsafe 写入。 */
function id3(size: number): Buffer {
  const b = Buffer.alloc(10 + size)
  b.write('ID3', 0, 'latin1')
  b[3] = 3
  b[6] = (size >> 21) & 0x7f
  b[7] = (size >> 14) & 0x7f
  b[8] = (size >> 7) & 0x7f
  b[9] = size & 0x7f
  return b
}

/** 一帧 MPEG 音频：4 字节帧头，其余为 0。 */
function frame(header: number[], length: number): Buffer {
  const b = Buffer.alloc(length)
  Buffer.from(header).copy(b, 0)
  return b
}

describe('音频时长', () => {
  test('WAV 的 data 长度超出实际字节时按实际字节计算', () => {
    expect(audioDurationOf(wav(3))).toBe(3)
  })

  test('MP3：MPEG-2 Layer III 22050 Hz 单声道 32 kbps，ID3 之后逐帧累加', () => {
    // 每帧 576 个采样、104 字节；192 帧即 192 × 576 / 22050 秒。
    const frames = Array.from({ length: 192 }, () => frame([0xff, 0xf3, 0x40, 0xc0], 104))
    const bytes = new Uint8Array(Buffer.concat([id3(81), ...frames]))
    expect(audioDurationOf(bytes)).toBeCloseTo((192 * 576) / 22050, 6)
  })

  test('MP3：第一帧为 Info 头时按其中的帧数计算，并扣除编码延迟与补齐', () => {
    // MPEG-1 Layer III 32000 Hz 单声道 128 kbps，每帧 1152 个采样、576 字节；Info 头位于帧头与 17 字节侧信息之后。
    const info = frame([0xff, 0xfb, 0x98, 0xc0], 576)
    const tag = 4 + 17
    info.write('Info', tag, 'latin1')
    info.writeUInt32BE(0x0f, tag + 4)
    info.writeUInt32BE(208, tag + 8)
    const encoder = tag + 12 + 4 + 100 + 4
    info.write('Lavf', encoder, 'latin1')
    // 编码延迟 576 与补齐 1267，各占 12 位。
    info.writeUIntBE((576 << 12) | 1267, encoder + 21, 3)
    const audio = Array.from({ length: 2 }, () => frame([0xff, 0xfb, 0x98, 0xc0], 576))
    const bytes = new Uint8Array(Buffer.concat([id3(1130), info, ...audio]))
    expect(audioDurationOf(bytes)).toBe((208 * 1152 - 576 - 1267) / 32000)
  })

  test('OGG Opus：最后一页的粒度位置减去 pre-skip，按 48 kHz 计算', () => {
    const page = (granule: number, body: Buffer) => {
      const head = Buffer.alloc(28)
      head.write('OggS', 0, 'latin1')
      head.writeBigUInt64LE(BigInt(granule), 6)
      head[26] = 1
      head[27] = body.length
      return Buffer.concat([head, body])
    }
    const opusHead = Buffer.alloc(19)
    opusHead.write('OpusHead', 0, 'latin1')
    opusHead[8] = 1
    opusHead[9] = 1
    opusHead.writeUInt16LE(312, 10)
    opusHead.writeUInt32LE(48000, 12)
    const bytes = new Uint8Array(
      Buffer.concat([page(0, opusHead), page(96000 + 312, Buffer.alloc(10))]),
    )
    expect(audioDurationOf(bytes)).toBe(2)
  })

  test('FLAC：STREAMINFO 中的总采样数除以采样率', () => {
    const b = Buffer.alloc(8 + 34)
    b.write('fLaC', 0, 'latin1')
    b[4] = 0x80
    b[7] = 34
    // 采样率 22050（20 位）、单声道、16 bit，总采样数 44100。
    b[18] = 0x05
    b[19] = 0x62
    b[20] = 0x20
    b[21] = 0xf0
    b.writeUInt32BE(44100, 22)
    expect(audioDurationOf(new Uint8Array(b))).toBe(2)
  })

  test('AAC（ADTS）：逐帧累加，每帧 1024 个采样', () => {
    // LC，24000 Hz（索引 6），单声道，每帧 10 字节。
    const adts = frame([0xff, 0xf1, 0x58, 0x40, 0x01, 0x5f, 0xfc], 10)
    const bytes = new Uint8Array(Buffer.concat(Array.from({ length: 47 }, () => adts)))
    expect(audioDurationOf(bytes)).toBeCloseTo((47 * 1024) / 24000, 6)
  })

  test('无法识别或只有一帧时返回 null', () => {
    expect(audioDurationOf(new Uint8Array([1, 2, 3, 4]))).toBeNull()
    expect(audioDurationOf(new Uint8Array(frame([0xff, 0xf3, 0x40, 0xc0], 104)))).toBeNull()
  })
})
