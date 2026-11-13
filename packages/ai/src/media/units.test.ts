/** 覆盖 `units.ts`：按计费单位从请求参数取得计量、按档位取单价，以及上架时的校验。 */

import { expect, test } from 'bun:test'
import type { ChannelVideoSpec } from '@qywork/core'
import { meterMedia, unitAmount, unitProblem } from './units.ts'

const request = (params: Record<string, unknown>, prompt = '') => ({ params, prompt })

test('按张：张数取参数 n，未填写时取默认值；参数表没有张数参数的型号按 1 张', () => {
  const gpt = { id: 'gpt-image-2', kind: 'openai_images' as const }
  expect(meterMedia(gpt, 'image', 500_000, request({ n: 3 }))).toEqual({ units: 3 })
  expect(meterMedia(gpt, 'image', 500_000, request({}))?.units).toBe(1)
  const gemini = { id: 'gemini-3.1-flash-image', kind: 'gemini_images' as const }
  expect(meterMedia(gemini, 'image', 500_000, request({}))).toEqual({ units: 1 })
})

test('按秒：时长取协议的时长参数；按档位定价时取分辨率参数，档位不在单价表中时无法计价', () => {
  const seedance = { id: 'doubao-seedance-2-0-260128', kind: 'ark_videos' as const }
  const prices = { '480p': 100_000, '720p': 200_000, '1080p': 400_000 }
  const meter = meterMedia(
    seedance,
    'second',
    prices,
    request({ duration: 10, resolution: '720p' }),
  )
  expect(meter).toEqual({ units: 10, resolution: '720p' })
  expect(unitAmount(prices, meter!)).toBe(2_000_000)
  expect(meterMedia(seedance, 'second', { '480p': 1 }, request({ resolution: '720p' }))).toBeNull()
  const veo = { id: 'veo-3.1-generate-preview', kind: 'veo_videos' as const }
  expect(meterMedia(veo, 'second', 100, request({ durationSeconds: 6 }))?.units).toBe(6)
})

test('中转渠道规格：时长参数为字符串，按渠道规格的默认值计量', () => {
  const spec: ChannelVideoSpec = {
    channel: 'hongcheng',
    seconds: [5, 10],
    ratios: ['16:9'],
    resolutions: ['720p', '1080p'],
    maxImages: 1,
    maxVideos: 0,
    maxAudios: 0,
  }
  const model = { id: 'relay-video', kind: 'openai_videos' as const, spec }
  expect(meterMedia(model, 'second', 1000, request({}))).toEqual({ units: 5 })
  expect(meterMedia(model, 'second', 1000, request({ seconds: '10' }))).toEqual({ units: 10 })
  expect(meterMedia(model, 'request', { '720p': 7, '1080p': 9 }, request({}))).toEqual({
    units: 1,
    resolution: '720p',
  })
})

test('档位由尺寸决定的渠道规格：按尺寸所属的档位计量与上架', () => {
  const spec: ChannelVideoSpec = {
    channel: 'mumugofe',
    seconds: [5, 10],
    ratios: ['16:9', '9:16'],
    resolutions: ['720p', '1080p'],
    sizes: { '720p': [1280, 720], '1080p': [1920, 1080] },
    maxImages: 1,
    maxVideos: 0,
    maxAudios: 0,
  }
  const model = { id: 'relay-video', kind: 'openai_videos' as const, spec }
  const prices = { '720p': 4_900_000, '1080p': 6_000_000 }
  expect(unitProblem(model, 'video', 'request', prices)).toBeNull()
  expect(unitProblem(model, 'video', 'request', { '720p': 1 })).toBe('缺少分辨率档位的单价：1080p')
  expect(meterMedia(model, 'request', prices, request({ size: '1080x1920' }))).toEqual({
    units: 1,
    resolution: '1080p',
  })
  expect(meterMedia(model, 'request', prices, request({}))).toEqual({
    units: 1,
    resolution: '720p',
  })
})

test('按万字符：字符数取提示词，按码点计', () => {
  const tts = { id: 'speech-2.8-hd', kind: 'minimax_speech' as const }
  expect(meterMedia(tts, '10k_chars', 1_000_000, request({}, '你好😀'))?.units).toBe(3 / 10_000)
  expect(meterMedia(tts, '10k_chars', 1_000_000, request({}, ''))).toBeNull()
})

test('上架校验：计费单位与类别不符、没有时长参数却按秒、没有分辨率参数却按档位、单价表缺少档位时给出原因', () => {
  const seedance = { id: 'doubao-seedance-2-0-260128', kind: 'ark_videos' as const }
  expect(unitProblem(seedance, 'video', 'image', 1)).toBe('计费单位与类别不符')
  expect(unitProblem(seedance, 'video', 'second', 1)).toBeNull()
  expect(unitProblem(seedance, 'video', 'second', { '720p': 1 })).toMatch(/^缺少分辨率档位的单价/)
  const omni = { id: 'gemini-omni-1.1-flash', kind: 'gemini_videos' as const }
  expect(unitProblem(omni, 'video', 'second', 1)).toBe('该型号没有时长参数，不能按秒计费')
  expect(unitProblem(omni, 'video', 'request', 1)).toBeNull()
  const qwen = { id: 'qwen-image-3.0', kind: 'dashscope_images' as const }
  expect(unitProblem(qwen, 'image', 'image', { '1K': 1 })).toBe(
    '该型号没有分辨率参数，不能按档位定价',
  )
})
