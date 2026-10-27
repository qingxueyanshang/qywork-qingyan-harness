/**
 * Token 估算。
 *
 * 覆盖范围：`tokens.ts` 全部，以及 `catalog.ts` 中各型号 `ModelSpec.density` 与实测值的偏差。
 *
 * 断言的是失败形状与偏差区间，不是具体数字：具体数字随标定变化，
 * 而下列低估、暴涨与口径混用都是实测出现过的形状，改动使其复现时测试必须失败。
 * 实测值存于 `fixtures/token-samples.json`：样本只取仓库内文本与合成文本，各模型的真实 token 数按
 * 「样本作为一条用户消息发送，减去只含 ok 的基线请求」测得。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProviderKind } from '@qywork/core'
import { builtinCatalog, lookupModel } from './catalog.ts'
import {
  DEFAULT_DENSITY,
  estimateContent,
  estimateImage,
  estimateJson,
  estimateMessage,
  estimateMessages,
  estimateRequest,
  estimateSchemas,
  estimateText,
  estimateVideo,
  imageSizeOfBase64,
  TEXT_FEATURES,
  THUMBNAIL_EDGE,
  type TokenDensity,
  textFeatures,
} from './tokens.ts'
import { STREAM_IDLE_TIMEOUT_MS } from './transport.ts'

const D = DEFAULT_DENSITY

const measured = JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', 'token-samples.json'), 'utf8'),
) as {
  samples: Record<string, string>
  models: Record<
    string,
    {
      kind: ProviderKind
      real: Record<string, number>
      images: { width: number; height: number; tokens: number }[]
      videos?: { width: number; height: number; seconds: number; audio: boolean; tokens: number }[]
    }
  >
}

/** 只有一项系数非零的系数表，用于锁定单项计数；图片每 token 一像素、没有上下限与固定开销，没有视频规则。 */
function only(feature: Exclude<keyof TokenDensity, 'image' | 'video'>, value = 1): TokenDensity {
  const zero: TokenDensity = {
    cjk: 0,
    rareCjk: 0,
    word: 0,
    letter: 0,
    caseBreak: 0,
    digit: 0,
    punctRun: 0,
    punct: 0,
    space: 0,
    other: 0,
    message: 0,
    image: { pixelsPerToken: 1, minPixels: 0, maxPixels: Number.MAX_SAFE_INTEGER, base: 0 },
    video: null,
  }
  return { ...zero, [feature]: value }
}

describe('词法计数', () => {
  test('空值一律为 0', () => {
    expect(estimateText('', D)).toBe(0)
    expect(estimateJson(undefined, D)).toBe(0)
    expect(estimateJson(null, D)).toBe(0)
    expect(estimateContent(undefined, D)).toBe(0)
  })

  test('十项按定义计数', () => {
    expect(textFeatures('getUserName(42) 的值\n\n  ok')).toEqual({
      cjk: 2,
      rareCjk: 0,
      word: 2,
      letter: 13,
      caseBreak: 2,
      digit: 2,
      punctRun: 2,
      punct: 2,
      space: 2,
      other: 0,
    })
  })

  /** 代理对按一个码点计入「其他」，后半不重复计数。 */
  test('表情按一个码点计', () => {
    expect(textFeatures('a😀b')).toMatchObject({ other: 1, word: 2 })
  })

  /**
   * 按 `length / 3.5` 计算等于每字 0.29 token，低估两倍以上。
   * 该估算是压缩判断的输入，低估过多时实际超限的请求会被判定为不会超限。
   */
  test('中文按字计，不按 1/3.5 个 token 计', () => {
    const cn = '这是一段纯中文的正文'
    expect(estimateText(cn, D)).toBeGreaterThan(Math.ceil(cn.length / 3.5) * 2)
  })

  /** 只按单词计数时，一段很长的连续字母只计为一个单词。 */
  test('长串字母按字母数增长', () => {
    const long = 'a'.repeat(4000)
    expect(estimateText(long, only('letter', 0.25))).toBe(1000)
    expect(estimateText(long, D)).toBeGreaterThan(4000 * D.letter)
  })

  test('循环引用不抛出异常，返回 0', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(estimateJson(cyclic, D)).toBe(0)
  })
})

/**
 * 常用字与其余汉字分两档：DeepSeek 实测随机非一级字 1.87 token / 字，常用中文约 0.69。
 * 合为一档时生僻字被低估，读取一份含大量生僻字的文件后，下一次请求可能超出窗口。
 */
describe('汉字分两档', () => {
  const d = { ...only('cjk'), rareCjk: 3 }

  test('一级字与中文标点按常用档，其余汉字按生僻档', () => {
    expect(estimateText('的一是了', d)).toBe(4)
    expect(estimateText('，。（）「」', d)).toBe(6)
    // 「龘」「㐀」「豈」分别是基本区非一级字、扩展 A 区、兼容区。
    expect(estimateText('龘㐀豈', d)).toBe(9)
  })
})

/**
 * 各型号系数与实测值的偏差。
 *
 * 两侧都须锁定：低于真值即为低估，超限的请求会被判为可容纳；高于真值时读数虚高，
 * 软阈值在实际占用远低于该值时触发压缩，投递额度随之偏小。
 */
describe('标定', () => {
  const models = Object.entries(measured.models)
  const samples = measured.samples

  test('实测过的型号：各样本的估算与真实值相差不超过 15%', () => {
    expect(models.length).toBeGreaterThan(0)
    for (const [id, { kind, real }] of models) {
      const density = lookupModel(id, kind).density
      expect(density).not.toBe(DEFAULT_DENSITY)
      for (const [name, tokens] of Object.entries(real)) {
        const ratio = estimateText(samples[name]!, density) / tokens
        expect({ id, name, ratio: Math.abs(ratio - 1) <= 0.15 }).toEqual({ id, name, ratio: true })
      }
    }
  })

  /** 未标定型号使用的档位对每个实测过的 tokenizer 都不明显偏低。 */
  test('默认档不低于任何实测值的九成', () => {
    for (const [id, { real }] of models) {
      for (const [name, tokens] of Object.entries(real)) {
        const ratio = estimateText(samples[name]!, D) / tokens
        expect({ id, name, ok: ratio >= 0.9 }).toEqual({ id, name, ok: true })
      }
    }
  })

  test('默认档的每一项不低于任何型号的系数', () => {
    for (const spec of builtinCatalog()) {
      for (const k of [...TEXT_FEATURES, 'message'] as const) {
        expect(D[k]).toBeGreaterThanOrEqual(spec.density[k])
      }
    }
  })

  test('目录中每一条都带有 density，各项为非负数，消息开销为正数', () => {
    for (const spec of builtinCatalog()) {
      for (const k of TEXT_FEATURES) expect(spec.density[k]).toBeGreaterThanOrEqual(0)
      expect(spec.density.message).toBeGreaterThan(0)
    }
  })
})

/** 只有文件头合法的 PNG 的 base64，`padding` 字节的填充模拟图片正文。 */
function pngBase64(width: number, height: number, padding = 0): string {
  const b = new Uint8Array(24 + padding)
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  b.set([0x49, 0x48, 0x44, 0x52], 12)
  new DataView(b.buffer).setUint32(16, width)
  new DataView(b.buffer).setUint32(20, height)
  return Buffer.from(b).toString('base64')
}

describe('图片', () => {
  /**
   * 实测的暴涨形状：1 MB 图片约为 137 万个 base64 字符，按字符估算为数十万 token，
   * provider 实际只计数百至数千。附加一张图片后，面板读数从 2% 升至 39%。
   */
  test('按宽高计，不按 base64 长度计', () => {
    const data = pngBase64(1920, 1080, 1_000_000)
    const n = estimateContent(
      [{ type: 'image', mimeType: 'image/png', source: { kind: 'base64', data } }],
      D,
    )
    expect(n).toBe(estimateImage({ width: 1920, height: 1080 }, D))
    expect(n).toBeLessThan(data.length / 100)
  })

  test('正文库引用按记录的尺寸计；尺寸未知时按上限计', () => {
    const block = (size: { width: number; height: number } | null) =>
      estimateContent(
        [
          {
            type: 'image',
            mimeType: 'image/png',
            source: { kind: 'resource', resourceId: 'rs_1', bytes: 1, size },
          },
        ],
        D,
      )
    expect(block({ width: 512, height: 512 })).toBe(estimateImage({ width: 512, height: 512 }, D))
    expect(block(null)).toBe(estimateImage(null, D))
    expect(estimateImage(null, D)).toBeGreaterThan(estimateImage({ width: 3840, height: 2160 }, D))
  })

  test('缩略图按长边 THUMBNAIL_EDGE 换算', () => {
    const data = pngBase64(1536, 864)
    const n = estimateContent(
      [{ type: 'image', mimeType: 'image/png', source: { kind: 'base64', data }, thumbnail: true }],
      D,
    )
    expect(n).toBe(estimateImage({ width: THUMBNAIL_EDGE, height: 432 }, D))
  })

  test('像素数限定在上下限之间', () => {
    const d = {
      ...D,
      image: { pixelsPerToken: 100, minPixels: 10_000, maxPixels: 40_000, base: 5 },
    }
    expect(estimateImage({ width: 10, height: 10 }, d)).toBe(105)
    expect(estimateImage({ width: 150, height: 200 }, d)).toBe(305)
    expect(estimateImage({ width: 1000, height: 1000 }, d)).toBe(405)
  })

  test('JPEG 的尺寸在长 EXIF 之后也能读出', () => {
    const b = new Uint8Array(70_000)
    b.set([0xff, 0xd8], 0)
    // APP1 段长 65000，其后才是 SOF0。
    b.set([0xff, 0xe1, 0xfd, 0xe8], 2)
    const sof = 2 + 2 + 65_000
    b.set([0xff, 0xc0, 0x00, 0x11, 0x08], sof)
    new DataView(b.buffer).setUint16(sof + 5, 900)
    new DataView(b.buffer).setUint16(sof + 7, 1440)
    expect(imageSizeOfBase64(Buffer.from(b).toString('base64'))).toEqual({
      width: 1440,
      height: 900,
    })
  })

  test('图文混排时分别计算', () => {
    const n = estimateContent(
      [
        { type: 'text', text: 'x'.repeat(40) },
        {
          type: 'image',
          mimeType: 'image/png',
          source: { kind: 'base64', data: pngBase64(10, 20) },
        },
      ],
      only('letter', 0.25),
    )
    expect(n).toBe(10 + 200)
  })

  /** 各型号的图片规则与实测值相差不超过 5%；默认档不低于任何实测值的九成。 */
  test('标定：实测过的型号与默认档', () => {
    for (const [id, { kind, images }] of Object.entries(measured.models)) {
      const density = lookupModel(id, kind).density
      for (const { width, height, tokens } of images) {
        const ratio = estimateImage({ width, height }, density) / tokens
        const low = estimateImage({ width, height }, D) / tokens
        expect({ id, width, height, ok: Math.abs(ratio - 1) <= 0.05 && low >= 0.9 }).toEqual({
          id,
          width,
          height,
          ok: true,
        })
      }
    }
  })
})

describe('视频', () => {
  /**
   * 各型号的视频规则与实测值相差不超过 11%（合成视频与生成的成片在 2.5% 以内；恰好半秒的时长百炼向下取整，估算多计一组）；
   * 默认档不低于任何实测值的九成。要防止的形状：视频一律记 0，而一段 60 秒 1080p 视频实测约 16 万。
   */
  test('标定：实测过的型号与默认档', () => {
    let checked = 0
    for (const [id, { kind, videos }] of Object.entries(measured.models)) {
      const density = lookupModel(id, kind).density
      for (const { width, height, seconds, audio, tokens } of videos ?? []) {
        const meta = { bytes: 1, seconds, size: { width, height }, audio }
        const ratio = estimateVideo(meta, density) / tokens
        const low = estimateVideo(meta, D) / tokens
        expect({
          id,
          width,
          height,
          seconds,
          ok: Math.abs(ratio - 1) <= 0.11 && low >= 0.9,
        }).toEqual({
          id,
          width,
          height,
          seconds,
          ok: true,
        })
        checked++
      }
    }
    expect(checked).toBeGreaterThan(40)
  })
})

describe('消息', () => {
  /**
   * 实测的漏计形状：`write_file` 的整份文件正文位于 tool call 的 arguments 中，
   * 只计算 `m.content` 时，面板上该部分为 0。
   */
  test('tool call 参数必须计入', () => {
    const body = 'x'.repeat(4000)
    const withCall = estimateMessage(
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'write_file', arguments: { path: 'a.ts', content: body } }],
      },
      D,
    )
    const withoutCall = estimateMessage({ role: 'assistant', content: '' }, D)
    expect(withCall - withoutCall).toBeGreaterThan(4000 * D.letter)
  })

  /** 思考正文随 tool_calls 一起发送给兼容端点，不计入时估算系统性偏低。 */
  test('reasoningContent 计入', () => {
    const d = only('letter', 0.25)
    const a = estimateMessage(
      { role: 'assistant', content: '', reasoningContent: 'y'.repeat(400) },
      d,
    )
    const b = estimateMessage({ role: 'assistant', content: '' }, d)
    expect(a - b).toBe(100)
  })

  /**
   * 原生推理条目按回报的 token 数计。签名中是加密的完整推理，按字节估算会高出数倍；
   * 存在该条目时思考正文不发送，两者只计一份。
   */
  test('原生推理按回报 token 计，不按签名字节，也不与正文重复计', () => {
    const d = only('letter', 0.25)
    const bare = estimateMessage({ role: 'assistant', content: '' }, d)
    const native = estimateMessage(
      {
        role: 'assistant',
        content: '',
        reasoningContent: 'y'.repeat(400),
        responseReasoning: {
          items: [{ type: 'thinking', thinking: 'y'.repeat(400), signature: 's'.repeat(40_000) }],
          tokens: 700,
        },
      },
      d,
    )
    expect(native - bare).toBe(700)
  })

  test('每条消息计入固定协议开销：几十条短消息不会被系统性低估', () => {
    const many = Array.from({ length: 50 }, () => ({ role: 'user' as const, content: '' }))
    expect(estimateMessages(many, only('message', 3))).toBe(150)
  })
})

describe('整个请求', () => {
  test('system + tools + messages 三部分均计入', () => {
    const req = {
      model: 'm',
      system: [{ text: 'a'.repeat(40) }],
      messages: [{ role: 'user' as const, content: 'b'.repeat(40) }],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
      maxOutputTokens: 100,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      signal: new AbortController().signal,
    }
    const d = only('letter', 0.25)
    const total = estimateRequest(req, d)
    expect(total).toBeGreaterThan(10 + 10)
    expect(total).toBe(10 + estimateSchemas(req.tools, d) + estimateMessages(req.messages, d))
  })
})
