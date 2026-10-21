/**
 * 覆盖 `channels.ts`：渠道目录条目 → 保存的规格 → 生成规格。
 * 数据是 2026-10-21 从 hongcheng 与木木公开接口取得的响应片段（`../fixtures/newapi-*.json`）。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ChannelVideoSpec } from '@qywork/core'
import { quoteMedia } from './catalog.ts'
import {
  channelImageMediaSpec,
  channelMediaSpec,
  hongchengVideoSpec,
  mumugofeImageSpec,
  mumugofeVideoSpec,
} from './channels.ts'

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, '../fixtures', name), 'utf8')) as {
    workbench: { data: Record<string, unknown>[] }
    typetale: { models: Record<string, unknown>[] }
  }
const hongcheng = fixture('newapi-hongcheng.json')
const mumugofe = fixture('newapi-mumugofe.json')

const workbench = (id: string) =>
  hongcheng.workbench.data.find((e) => e.api_model === id) as Record<string, unknown>
const typetale = (id: string) =>
  mumugofe.typetale.models.find((e) => e.id === id) as Record<string, unknown>

describe('hongcheng', () => {
  test('工作台目录 → 保存的规格', () => {
    expect(hongchengVideoSpec(workbench('TTseadanco2.5-720'))).toEqual({
      channel: 'hongcheng',
      seconds: Array.from({ length: 26 }, (_, i) => i + 5),
      ratios: ['16:9', '9:16', '1:1'],
      resolutions: ['720p'],
      maxImages: 30,
      maxVideos: 10,
      maxAudios: 10,
    })
    expect(hongchengVideoSpec({ ...workbench('TTseadanco2.5-720'), duration: '' })).toBeNull()
  })

  test('生成规格：参数名、引用写法与参考视频', () => {
    const spec = channelMediaSpec('TTseadanco2.5-720', {
      ...hongchengVideoSpec(workbench('TTseadanco2.5-720'))!,
      price: { per: 'second', amount: 0.42, currency: 'CNY' },
    })
    expect(spec.videoFormat).toBe('hongcheng')
    expect(spec.operations).toEqual(['text_to_video', 'reference_to_video', 'video_to_video'])
    expect(spec.params.map((p) => [p.name, p.default])).toEqual([
      ['seconds', '5'],
      ['aspect_ratio', '16:9'],
      ['resolution', '720p'],
    ])
    expect(spec.mention).toEqual({ image: '@Image{n}', video: '@Video{n}', audio: '@Audio{n}' })
    expect(spec.price?.cost({ seconds: 10 })).toBeCloseTo(4.2)
    const yy = channelMediaSpec(
      'seedance-2.5-yy-720p',
      hongchengVideoSpec(workbench('seedance-2.5-yy-720p'))!,
    )
    expect(yy.operations).not.toContain('video_to_video')
    expect(yy.price).toBeUndefined()
  })
})

describe('木木', () => {
  test('目录 → 保存的规格：上传方式与各档位尺寸', () => {
    expect(mumugofeVideoSpec(typetale('X-SD25-301010'))).toEqual({
      channel: 'mumugofe',
      seconds: [30],
      ratios: ['16:9', '9:16'],
      resolutions: ['720p'],
      sizes: { '720p': [1280, 720] },
      maxImages: 30,
      maxVideos: 0,
      maxAudios: 0,
      publicUrls: true,
    })
    expect(mumugofeVideoSpec(typetale('007系列/sd2.5(30图10音/4-30秒/720P)'))).not.toHaveProperty(
      'publicUrls',
    )
    expect(mumugofeVideoSpec(typetale('sd-2.0-vip'))).toEqual({
      channel: 'mumugofe',
      seconds: Array.from({ length: 12 }, (_, i) => i + 4),
      ratios: ['16:9', '9:16'],
      resolutions: ['720p', '1080p'],
      sizes: { '720p': [1280, 720], '1080p': [1920, 1080] },
      maxImages: 9,
      maxVideos: 0,
      maxAudios: 0,
      multipart: true,
    })
    expect(mumugofeVideoSpec(typetale('gpt-image-2'))).toBeNull()
  })

  test('表单上传：生成规格的素材传递方式；按 resolution 计价时尺寸对应档位', () => {
    const saved = mumugofeVideoSpec(typetale('sd-2.0-vip'))!
    expect(channelMediaSpec('sd-2.0-vip', saved).inputs.transport).toBe('multipart')
    expect(channelMediaSpec('sd-2.0-vip', saved).resolutionBySize).toBeUndefined()
    expect(
      channelMediaSpec('sd-2.0-vip', { ...saved, resolutionField: true }).resolutionBySize,
    ).toEqual({
      '1280x720': '720p',
      '720x1280': '720p',
      '1920x1080': '1080p',
      '1080x1920': '1080p',
    })
  })

  test('图像目录 → 保存的规格 → 生成规格', () => {
    const saved = mumugofeImageSpec(typetale('gpt-image-2'))
    expect(saved).toEqual({
      channel: 'mumugofe',
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
    // 最长边下限去掉达不到的尺寸。
    expect(mumugofeImageSpec({ ...typetale('gpt-image-2'), min_long_edge: 3840 })?.sizes).toEqual([
      '3840x2160',
      '2160x3840',
      '4096x4096',
    ])
    expect(mumugofeImageSpec(typetale('sd-2.0-vip'))).toBeNull()
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
      mumugofeVideoSpec(typetale('007系列/sd2.5(30图10音/480P/720P)')) as never,
    )
    expect(spec.videoFormat).toBe('mumugofe')
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
      ...(mumugofeVideoSpec(typetale('007系列/sd2.5(30图10音/480P/720P)')) as ChannelVideoSpec),
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
