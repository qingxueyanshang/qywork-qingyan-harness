/**
 * 覆盖 `channels.ts`：渠道目录条目 → 保存的规格 → 生成规格。
 * 数据是 2026-10-21 从 hongcheng 与木木公开接口取得的响应片段（`../fixtures/newapi-*.json`）。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { channelMediaSpec, hongchengVideoSpec, mumugofeVideoSpec } from './channels.ts'

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
      unsupported: '该型号按表单上传素材，当前未接入',
    })
    expect(mumugofeVideoSpec(typetale('gpt-image-2'))).toBeNull()
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
})
