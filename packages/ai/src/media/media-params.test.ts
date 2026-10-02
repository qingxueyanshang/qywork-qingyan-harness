import { describe, expect, test } from 'bun:test'
import { activeMediaParams, mediaParamValues, resolveMediaParam } from '@qywork/core'
import { findMediaModel, type MediaOperation } from './catalog.ts'
import { validateMediaCall } from './params.ts'

const active = (
  id: string,
  operation: MediaOperation,
  params: Record<string, unknown>,
  images = 0,
) => activeMediaParams(findMediaModel(id)!.params, operation, params, images)

describe('生成参数按模型和输入模式匹配', () => {
  test('各家展示自己的控制项，没有的字段不会因共用协议出现', () => {
    const labels = (id: string) =>
      findMediaModel(id)!
        .params.filter((p) => p.label)
        .map((p) => p.name)
    expect(labels('gpt-image-2.5-sunburst')).toContain('quality')
    expect(labels('grok-imagine-image-2.0')).toContain('quality')
    expect(labels('doubao-seedream-5-0-pro-260628')).not.toContain('quality')
    expect(labels('qwen-image-3.0')).toEqual(
      expect.arrayContaining(['negative_prompt', 'seed', 'enable_thinking', 'prompt_extend']),
    )
    expect(labels('wan3.0-video')).toContain('audio')
    expect(labels('doubao-seedance-2-5-260628')).toContain('generate_audio')
    expect(labels('kling/kling-v3-video-generation')).toContain('mode')
    expect(labels('gemini-3.1-flash-image')).toContain('mime_type')
    expect(labels('veo-3.1-generate-preview')).not.toContain('generate_audio')
  })

  test('max 只在支持的模型上通过；未设置质量不自动补 max', () => {
    expect(active('gpt-image-2.5-sunburst', 'edit', { quality: 'max' }, 1)).toEqual({
      quality: 'max',
    })
    expect(active('grok-imagine-image-2.0', 'edit', { quality: 'max' }, 1)).toEqual({})
    expect(active('gpt-image-2.5-sunburst', 'generate', {})).toEqual({})
  })

  test('千问的扩写模式和思考随操作自动适配，偏好保持原样', () => {
    const prefs = { prompt_extend_mode: 'agent', enable_thinking: true, seed: 42 }
    expect(active('qwen-image-3.0', 'generate', prefs)).toEqual(prefs)
    expect(active('qwen-image-3.0', 'edit', prefs, 1)).toEqual({ enable_thinking: true, seed: 42 })
    expect(active('qwen-image-3.0', 'generate', { ...prefs, prompt_extend: false })).toEqual({
      seed: 42,
      prompt_extend: false,
    })
    expect(active('qwen-image-3.0', 'generate', prefs)).toEqual(prefs)
  })

  test('万相 Pro 的 4K 在图生时隐藏且不发送，回文生时恢复', () => {
    const model = findMediaModel('wan2.7-image-pro')!
    const prefs = { size: '4K', thinking_mode: true, seed: 99 }
    const size = model.params.find((p) => p.name === 'size')!
    const edit = resolveMediaParam(size, 'edit', mediaParamValues(model.params, prefs), 1)
    expect(edit.shapes?.some((s) => s.tier === '4K')).toBe(false)
    expect(active(model.id, 'edit', prefs, 1)).toEqual({ seed: 99 })
    expect(active(model.id, 'generate', prefs)).toEqual(prefs)
    expect(active(model.id, 'edit', { size: '4096*4096' }, 1)).toEqual({})
  })

  test('格式与透明背景、PNG 与压缩质量组合不能误发', () => {
    expect(active('gpt-image-2.5-flare', 'generate', { output_compression: 90 })).toEqual({})
    expect(
      active('gpt-image-2.5-flare', 'generate', {
        output_format: 'webp',
        output_compression: 90,
        background: 'transparent',
      }),
    ).toEqual({ output_format: 'webp', output_compression: 90, background: 'transparent' })
    expect(
      active('doubao-seedream-5-0-pro-260628', 'edit', { background: 'transparent' }, 2),
    ).toEqual({})
    expect(
      active('doubao-seedream-5-0-pro-260628', 'edit', { background: 'transparent' }, 1),
    ).toEqual({ background: 'transparent' })
  })

  test('视频任务、分辨率、音频限制自动过滤，原偏好仍可恢复', () => {
    const seedance = 'doubao-seedance-2-5-260628'
    const prefs = { ratio: '16:9', duration: 10, generate_audio: false }
    expect(active(seedance, 'first_last_frame', prefs)).toEqual({
      duration: 10,
      generate_audio: false,
    })
    expect(
      active(seedance, 'video_to_video', { ...prefs, omni_reference_task_type: 'edit' }),
    ).toEqual({ generate_audio: false, omni_reference_task_type: 'edit' })
    expect(active(seedance, 'text_to_video', prefs)).toEqual(prefs)
    expect(
      active('kling/kling-v3-omni-video-generation', 'video_to_video', {
        audio: true,
        duration: 15,
      }),
    ).toEqual({})
    expect(
      active('veo-3.1-generate-preview', 'text_to_video', { durationSeconds: 4, resolution: '4k' }),
    ).toEqual({ resolution: '4k' })
    expect(
      active('grok-imagine-video-1.5', 'first_last_frame', {
        resolution: '1080p',
        generate_audio: false,
      }),
    ).toEqual({ generate_audio: false })
  })

  test('直接工具调用仍拒绝非法值，避免将拼错的参数当作成功执行', () => {
    const gpt = findMediaModel('gpt-image-2.5-flare')!
    expect(
      validateMediaCall(gpt, 'generate', { size: '1000x1000' }, { images: 0, videos: 0 }).join(),
    ).toContain('16 的倍数')
    expect(
      validateMediaCall(
        findMediaModel('qwen-image-3.0')!,
        'edit',
        { prompt_extend_mode: 'agent' },
        { images: 1, videos: 0 },
      ).join(),
    ).toContain('direct')
    expect(
      validateMediaCall(
        gpt,
        'generate',
        { output_format: 'jpeg', background: 'transparent' },
        { images: 0, videos: 0 },
      ).length,
    ).toBeGreaterThan(0)
  })
})
