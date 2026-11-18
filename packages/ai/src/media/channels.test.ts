/**
 * 覆盖 `channels.ts`：渠道目录条目 → 保存的规格 → 生成规格。
 * 数据是从 providera（2026-10-27，型号列表需带凭证）与服务商B（2026-10-21）接口取得的响应片段（`../fixtures/newapi-*.json`），
 * 以及 2026-11-18 带凭证取得的服务商C AI 完整模型目录（`../fixtures/providerc-models.json`）。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelVideoSpec } from '@qywork/core'
import { lookupMediaModel, quoteMedia } from './catalog.ts'
import {
  channelImageMediaSpec,
  channelMediaSpec,
  providercVideoSpec,
  provideraVideoSpec,
  providerbImageSpec,
  providerbVideoSpec,
} from './channels.ts'

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, '../fixtures', name), 'utf8')) as {
    models: { data: Record<string, unknown>[] }
    catalog: { models: Record<string, unknown>[] }
  }
const providera = fixture('newapi-providera.json')
const providerb = fixture('newapi-providerb.json')

const parameters = (id: string) =>
  providera.models.data.find((e) => e.id === id)?.parameters as Record<string, unknown>
const catalog = (id: string) =>
  providerb.catalog.models.find((e) => e.id === id) as Record<string, unknown>

describe('providera', () => {
  test('型号列表的 parameters → 保存的规格', () => {
    expect(provideraVideoSpec(parameters('TTseadanco2.5-720'))).toEqual({
      channel: 'providera',
      seconds: Array.from({ length: 26 }, (_, i) => i + 5),
      ratios: ['16:9', '9:16', '1:1'],
      resolutions: ['720p'],
      maxImages: 30,
      maxVideos: 10,
      maxAudios: 10,
    })
    expect(provideraVideoSpec({ ...parameters('TTseadanco2.5-720'), duration: '' })).toBeNull()
  })

  test('生成规格：参数名、引用写法与参考视频', () => {
    const spec = channelMediaSpec('TTseadanco2.5-720', {
      ...provideraVideoSpec(parameters('TTseadanco2.5-720'))!,
      price: { per: 'second', amount: 0.42, currency: 'CNY' },
    })
    expect(spec.videoFormat).toBe('providera')
    expect(spec.operations).toEqual(['text_to_video', 'reference_to_video', 'video_to_video'])
    expect(spec.params.map((p) => [p.name, p.default])).toEqual([
      ['seconds', '5'],
      ['aspect_ratio', '16:9'],
      ['resolution', '720p'],
    ])
    expect(spec.mention).toEqual({ image: '@Image{n}', video: '@Video{n}', audio: '@Audio{n}' })
    expect(spec.price?.cost({ seconds: 10 })).toBeCloseTo(4.2)
    const noVideo = channelMediaSpec(
      'sedanco2.0-300秒必出',
      provideraVideoSpec(parameters('sedanco2.0-300秒必出'))!,
    )
    expect(noVideo.operations).not.toContain('video_to_video')
    expect(noVideo.price).toBeUndefined()
  })
})

describe('服务商B', () => {
  test('目录 → 保存的规格：上传方式与各档位尺寸', () => {
    expect(providerbVideoSpec(catalog('X-SD25-301010'))).toEqual({
      channel: 'providerb',
      seconds: [30],
      ratios: ['16:9', '9:16'],
      resolutions: ['720p'],
      sizes: { '720p': [1280, 720] },
      maxImages: 30,
      maxVideos: 0,
      maxAudios: 0,
      publicUrls: true,
    })
    expect(providerbVideoSpec(catalog('007系列/sd2.5(30图10音/4-30秒/720P)'))).not.toHaveProperty(
      'publicUrls',
    )
    expect(providerbVideoSpec(catalog('sd-2.0-vip'))).toEqual({
      channel: 'providerb',
      seconds: Array.from({ length: 12 }, (_, i) => i + 4),
      ratios: ['16:9', '9:16'],
      resolutions: ['720p', '1080p'],
      sizes: { '720p': [1280, 720], '1080p': [1920, 1080] },
      maxImages: 9,
      maxVideos: 0,
      maxAudios: 0,
      multipart: true,
    })
    expect(providerbVideoSpec(catalog('gpt-image-2'))).toBeNull()
  })

  test('目录给出参考视频与参考音频上限时按其保存；表单上传的型号仍为 0', () => {
    const entry = catalog('X-SD25-301010')
    expect(providerbVideoSpec({ ...entry, video_refs: 10, audio_refs: 3 })).toMatchObject({
      maxImages: 30,
      maxVideos: 10,
      maxAudios: 3,
    })
    expect(
      providerbVideoSpec({ ...catalog('sd-2.0-vip'), video_refs: 3, audio_refs: 3 }),
    ).toMatchObject({ maxVideos: 0, maxAudios: 0, multipart: true })
  })

  test('表单上传：生成规格的素材传递方式；尺寸对应档位，按 resolution 计价时随提交发送', () => {
    const saved = providerbVideoSpec(catalog('sd-2.0-vip'))!
    const spec = channelMediaSpec('sd-2.0-vip', saved)
    expect(spec.inputs.transport).toBe('multipart')
    expect(spec.resolutionBySize).toEqual({
      '1280x720': '720p',
      '720x1280': '720p',
      '1920x1080': '1080p',
      '1080x1920': '1080p',
    })
    expect(spec.resolutionField).toBeUndefined()
    expect(
      channelMediaSpec('sd-2.0-vip', { ...saved, resolutionField: true }).resolutionField,
    ).toBe(true)
  })

  test('图像目录 → 保存的规格 → 生成规格', () => {
    const saved = providerbImageSpec(catalog('gpt-image-2'))
    expect(saved).toEqual({
      channel: 'providerb',
      resolutions: ['1K', '2K', '4K'],
      sizes: [
        '1024x1024',
        '1536x1024',
        '1024x1536',
        '1792x1024',
        '1024x1792',
        '2048x2048',
        '3840x2160',
        '2160x3840',
        '4096x4096',
      ],
      maxImages: 10,
    })
    // 按最长边下限移除未达到下限的尺寸。
    expect(providerbImageSpec({ ...catalog('gpt-image-2'), min_long_edge: 3840 })?.sizes).toEqual([
      '3840x2160',
      '2160x3840',
      '4096x4096',
    ])
    expect(providerbImageSpec(catalog('sd-2.0-vip'))).toBeNull()
    const spec = channelImageMediaSpec('gpt-image-2', { ...saved!, maxImages: 0 })
    expect(spec.operations).toEqual(['generate'])
    expect(spec.params.find((p) => p.name === 'size')?.shapes?.slice(0, 4)).toEqual([
      { ratio: '1:1', value: '1024x1024' },
      { ratio: '3:2', value: '1536x1024' },
      { ratio: '2:3', value: '1024x1536' },
      { ratio: '7:4', value: '1792x1024' },
    ])
  })

  test('生成规格：两个档位的横竖尺寸', () => {
    const spec = channelMediaSpec(
      '007系列/sd2.5(30图10音/480P/720P)',
      providerbVideoSpec(catalog('007系列/sd2.5(30图10音/480P/720P)')) as never,
    )
    expect(spec.videoFormat).toBe('providerb')
    expect(spec.params.find((p) => p.name === 'size')?.shapes).toEqual([
      { ratio: '16:9', tier: '480P', value: '854x480' },
      { ratio: '9:16', tier: '480P', value: '480x854' },
      { ratio: '16:9', tier: '720P', value: '1280x720' },
      { ratio: '9:16', tier: '720P', value: '720x1280' },
    ])
    expect(spec.inputs).toEqual({ maxImages: 30, maxVideos: 0, maxAudios: 0, transport: 'json' })
  })

  test('按分辨率定价：报价按所选尺寸的档位计算，计量缺少档位时金额不明', () => {
    const spec = channelMediaSpec('007系列/sd2.5(30图10音/480P/720P)', {
      ...(providerbVideoSpec(catalog('007系列/sd2.5(30图10音/480P/720P)')) as ChannelVideoSpec),
      price: { per: 'second', amount: { '480p': 0.4, '720p': 0.6 }, currency: 'CNY' },
    })
    const none = { images: 0, videos: 0 }
    expect(quoteMedia(spec, { seconds: '10', size: '480x854' }, none)?.cost).toBeCloseTo(4)
    expect(quoteMedia(spec, { seconds: '10', size: '1280x720' }, none)?.cost).toBeCloseTo(6)
    // 未填写尺寸时取默认值（第一档 480P 横屏）。
    expect(quoteMedia(spec, { seconds: '30' }, none)?.cost).toBeCloseTo(12)
    expect(spec.price?.cost({ seconds: 10 })).toBeNull()
    expect(spec.price?.cost({ seconds: 10, resolution: '720p' })).toBeCloseTo(6)
  })
})

describe('服务商C AI', () => {
  const catalog = (
    JSON.parse(readFileSync(join(import.meta.dir, '../fixtures/providerc-models.json'), 'utf8')) as {
      data: Record<string, unknown>[]
    }
  ).data
  const entry = (id: string) => catalog.find((e) => e.id === id)!
  const none = { images: 0, videos: 0 }

  test('目录 → 保存的规格：时长写为数组或范围，只有固定分辨率时取该档，价格为人民币售价', () => {
    // 按秒分档、时长为范围；带参考视频的秒价与基础秒价相同，型号也不接受参考视频。
    expect(providercVideoSpec(entry('providerc-video-x8c728c9ab4b785f5'))).toEqual({
      channel: 'providerc',
      label: 'Seedance 2.5 满血按秒 480/720p （原生非超分）',
      seconds: Array.from({ length: 27 }, (_, i) => i + 4),
      ratios: ['16:9', '9:16', '1:1', '4:3', '3:4', '21:9'],
      resolutions: ['480p', '720p'],
      maxImages: 30,
      maxVideos: 0,
      maxAudios: 10,
      price: { per: 'second', amount: { '480p': 0.22, '720p': 0.31 }, currency: 'CNY' },
    })
    // 按次、不连续的时长数组、只有 `fixedResolution`。
    expect(providercVideoSpec(entry('providerc-video-17'))).toMatchObject({
      seconds: [5, 10, 15],
      resolutions: ['720p'],
      price: { per: 'request', amount: 1.6, currency: 'CNY' },
    })
    // 按次分档；各档金额相同时保存为一个数。
    expect(providercVideoSpec(entry('providerc-video-xfa7c14da94a94631'))?.price).toEqual({
      per: 'request',
      amount: { '480p': 5, '720p': 7 },
      currency: 'CNY',
    })
    expect(providercVideoSpec(entry('providerc-video-x3951c3746331c227'))?.price).toEqual({
      per: 'request',
      amount: 5.775,
      currency: 'CNY',
    })
    // 视频擦除、图像与对话条目不是视频型号。
    for (const id of ['soundview-subtitle-remove', 'providerc-image-01', 'gpt-6-astra'])
      expect(providercVideoSpec(entry(id))).toBeNull()
    // 目录中的全部视频条目都能取得规格与价格。
    const videos = catalog.filter((e) => e.type === 'video')
    expect(videos.map((e) => providercVideoSpec(e)?.price !== undefined)).toEqual(
      videos.map(() => true),
    )
  })

  test('带参考视频的秒价与基础秒价不同、型号接受参考视频时价格不明；无法识别的计费方式价格不明', () => {
    const wan = entry('providerc-video-x50d0e9583535a814')
    const billing = {
      kind: 'resolutionSecond',
      rates: { '720p': { base: 0.17, withVideo: 0.3 }, '1080p': { base: 0.17, withVideo: 0.3 } },
    }
    expect(providercVideoSpec({ ...wan, billing })?.price).toBeUndefined()
    expect(
      providercVideoSpec({ ...wan, billing, limits: { images: 9, videos: 0, audios: 3 } })?.price,
    ).toEqual({ per: 'second', amount: 0.17, currency: 'CNY' })
    expect(
      providercVideoSpec({ ...wan, billing: { kind: 'durationFixed', amounts: {} } })?.price,
    ).toBeUndefined()
    expect(providercVideoSpec({ ...wan, limits: {} })).toBeNull()
  })

  test('生成规格：协议、显示名称、参数名与按所选参数报价', () => {
    const spec = channelMediaSpec(
      'providerc-video-x8c728c9ab4b785f5',
      providercVideoSpec(entry('providerc-video-x8c728c9ab4b785f5'))!,
    )
    expect(spec.kind).toBe('providerc_videos')
    expect(spec.displayName).toBe('Seedance 2.5 满血按秒 480/720p （原生非超分）')
    expect(spec.videoFormat).toBeUndefined()
    expect(spec.mention).toBeUndefined()
    expect(spec.operations).toEqual(['text_to_video', 'reference_to_video'])
    expect(spec.inputs).toEqual({
      maxImages: 30,
      maxVideos: 0,
      maxAudios: 10,
      transport: 'multipart',
    })
    expect(spec.params.map((p) => [p.name, p.default])).toEqual([
      ['duration', 4],
      ['ratio', '16:9'],
      ['resolution', '480p'],
    ])
    expect(quoteMedia(spec, { duration: 10, resolution: '720p' }, none)?.cost).toBeCloseTo(3.1)
    // 未填写时取默认值：4 秒、480p。
    expect(quoteMedia(spec, {}, none)?.cost).toBeCloseTo(0.88)
    const fixed = channelMediaSpec(
      'providerc-video-x4ede44f3ff68c869',
      providercVideoSpec(entry('providerc-video-x4ede44f3ff68c869'))!,
    )
    expect(fixed.operations).toEqual(['text_to_video', 'reference_to_video', 'video_to_video'])
    expect(quoteMedia(fixed, { duration: 15 }, none)?.cost).toBeCloseTo(3.5)
    // 渠道规格只在所属协议上使用；其他视频协议按协议默认。
    const saved = providercVideoSpec(entry('providerc-video-17'))!
    expect(lookupMediaModel('providerc-video-17', 'providerc_videos', saved).displayName).toBe(
      '特价渠道 Seedance 2.0 mini 720p',
    )
    expect(lookupMediaModel('providerc-video-17', 'openai_videos', saved).catalogued).toBe(false)
  })
})
