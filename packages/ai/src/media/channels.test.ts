/**
 * 覆盖 `channels.ts`：渠道目录条目 → 保存的规格 → 生成规格。
 * 数据是 2026-10-21 从 providera 与服务商B公开接口取得的响应片段（`../fixtures/newapi-*.json`）。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { channelMediaSpec, provideraVideoSpec, providerbVideoSpec } from './channels.ts'

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dir, '../fixtures', name), 'utf8')) as {
    workbench: { data: Record<string, unknown>[] }
    catalog: { models: Record<string, unknown>[] }
  }
const providera = fixture('newapi-providera.json')
const providerb = fixture('newapi-providerb.json')

const workbench = (id: string) =>
  providera.workbench.data.find((e) => e.api_model === id) as Record<string, unknown>
const catalog = (id: string) =>
  providerb.catalog.models.find((e) => e.id === id) as Record<string, unknown>

describe('providera', () => {
  test('工作台目录 → 保存的规格', () => {
    expect(provideraVideoSpec(workbench('TTseadanco2.5-720'))).toEqual({
      channel: 'providera',
      seconds: Array.from({ length: 26 }, (_, i) => i + 5),
      ratios: ['16:9', '9:16', '1:1'],
      resolutions: ['720p'],
      maxImages: 30,
      maxVideos: 10,
      maxAudios: 10,
    })
    expect(provideraVideoSpec({ ...workbench('TTseadanco2.5-720'), duration: '' })).toBeNull()
  })

  test('生成规格：参数名、引用写法与参考视频', () => {
    const spec = channelMediaSpec('TTseadanco2.5-720', {
      ...provideraVideoSpec(workbench('TTseadanco2.5-720'))!,
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
    const yy = channelMediaSpec(
      'seedance-2.5-yy-720p',
      provideraVideoSpec(workbench('seedance-2.5-yy-720p'))!,
    )
    expect(yy.operations).not.toContain('video_to_video')
    expect(yy.price).toBeUndefined()
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
      unsupported: '该型号按表单上传素材，当前未接入',
    })
    expect(providerbVideoSpec(catalog('gpt-image-2'))).toBeNull()
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
})
