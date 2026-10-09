import { describe, expect, test } from 'bun:test'
import { activeMediaParams, mediaParamValues, resolveMediaParam } from '@qywork/core'
import { findMediaModel, type MediaOperation } from './catalog.ts'
import { describeParam, validateMediaCall } from './params.ts'

const active = (
  id: string,
  operation: MediaOperation,
  params: Record<string, unknown>,
  images = 0,
) => activeMediaParams(findMediaModel(id)!.params, operation, params, images)

describe('生成参数按模型和输入模式匹配', () => {
  test('各厂商只显示各自的控制项，共用协议不会引入其不支持的字段', () => {
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

  test('max 只在支持的模型上通过；未设置质量时不自动补充 max', () => {
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

  test('万相 Pro 的 4K 在图生图时隐藏且不发送，切回文生图时恢复', () => {
    const model = findMediaModel('wan2.7-image-pro')!
    const prefs = { size: '4K', thinking_mode: true, seed: 99 }
    const size = model.params.find((p) => p.name === 'size')!
    const edit = resolveMediaParam(size, 'edit', mediaParamValues(model.params, prefs), 1)
    expect(edit.shapes?.some((s) => s.tier === '4K')).toBe(false)
    expect(active(model.id, 'edit', prefs, 1)).toEqual({ seed: 99 })
    expect(active(model.id, 'generate', prefs)).toEqual(prefs)
    expect(active(model.id, 'edit', { size: '4096*4096' }, 1)).toEqual({})
  })

  test('格式与透明背景、PNG 与压缩质量的冲突组合不会被发送', () => {
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

  test('直接工具调用仍拒绝非法值，不将拼写错误的参数视为执行成功', () => {
    const gpt = findMediaModel('gpt-image-2.5-flare')!
    expect(
      validateMediaCall(gpt, 'generate', { size: '1000x1000' }, { images: 0, videos: 0 }).join(),
    ).toContain('可选 auto（自动宽高比）、1552x656（21:9 · 1K）')
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

/**
 * 原始失败形状：模型按「任意宽x高」的说明填写 1536x864，校验通过，参数面板的宽高比与分辨率无一选中。
 * 同一参数在大模型说明、校验与画布控件三处使用同一份对照表或预设。
 */
describe('带对照表与预设的参数只有一套取值', () => {
  const gpt = findMediaModel('gpt-image-2.5-sunburst')!
  const size = gpt.params.find((p) => p.name === 'size')!
  const counts = { images: 0, videos: 0 }

  test('尺寸只接受对照表中的取值，报错列出全部可选值', () => {
    expect(validateMediaCall(gpt, 'generate', { size: '1360x768' }, counts)).toEqual([])
    expect(validateMediaCall(gpt, 'generate', { size: 'auto' }, counts)).toEqual([])
    const problems = validateMediaCall(gpt, 'generate', { size: '1536x864' }, counts).join()
    expect(problems).toContain('1360x768（16:9 · 1K）')
    expect(validateMediaCall(gpt, 'generate', { size: '1536x1024' }, counts)).toHaveLength(1)
  })

  test('音色只接受预设，与画布控件的选项一致', () => {
    const tts = findMediaModel('gpt-4o-mini-tts')!
    expect(validateMediaCall(tts, 'speech', { voice: 'nova' }, counts)).toEqual([])
    expect(validateMediaCall(tts, 'speech', { voice: 'my-voice' }, counts).join()).toContain(
      '可选 alloy | ash',
    )
  })

  test('大模型读取的参数说明逐项列出对照表与预设，不再写任意宽高', () => {
    const text = describeParam(size)
    expect(text).toStartWith('size：取值为下列之一，括号内为参数面板中的显示：auto（自动宽高比）、')
    expect(text).toContain('1360x768（16:9 · 1K）')
    expect(text).toContain('2720x1536（16:9 · 2K）')
    expect(text).not.toContain('16 的倍数')
    const voice = findMediaModel('gpt-4o-mini-tts')!.params.find((p) => p.name === 'voice')!
    expect(describeParam(voice)).toStartWith('voice：alloy | ash | ballad')
  })

  /** 参数面板按同一份有效参数显示：表外的旧取值显示为自动，与实际发送的请求一致。 */
  test('卡片上表外的尺寸与其他不适用的取值一样不发送，表中取值照常发送', () => {
    expect(active('gpt-image-2.5-sunburst', 'generate', { size: '1536x864' })).toEqual({})
    expect(active('gpt-image-2.5-sunburst', 'generate', { size: '1360x768' })).toEqual({
      size: '1360x768',
    })
  })
})
