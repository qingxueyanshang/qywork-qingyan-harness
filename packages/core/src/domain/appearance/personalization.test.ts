/** 覆盖 `personalization.ts`：个性化的校验、合并、默认值判定与文件名判定。 */

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_PERSONALIZATION,
  isDefaultPersonalization,
  isPersonalImageName,
  mergePersonalization,
  type Personalization,
  parsePersonalization,
} from './personalization.ts'

const sample: Personalization = {
  background: { kind: 'image', file: 'bg.jpg', fit: 'cover', dim: 0.3, blur: 0 },
  fog: { color: '#ffffff', density: 0.5, speed: 0.4 },
  opacity: 0.7,
  accent: '#7c3aed',
}

describe('parsePersonalization', () => {
  test('合法内容原样通过，颜色统一为小写', () => {
    expect(parsePersonalization({ ...sample, accent: '#7C3AED' })).toEqual({
      ok: true,
      value: sample,
    })
  })

  test('默认值合法，纯色背景的颜色可以为 null', () => {
    expect(parsePersonalization(DEFAULT_PERSONALIZATION)).toEqual({
      ok: true,
      value: DEFAULT_PERSONALIZATION,
    })
  })

  test('未知字段被拒绝，不做忽略', () => {
    expect(parsePersonalization({ ...sample, base: 'dark' })).toEqual({
      ok: false,
      error: '个性化 中有无法识别的字段：base',
    })
  })

  test('渐变恰好两种颜色加一个方向', () => {
    const gradient = { kind: 'gradient', from: '#000000', to: '#ffffff', direction: 'vertical' }
    expect(parsePersonalization({ ...sample, background: gradient }).ok).toBe(true)
    expect(
      parsePersonalization({ ...sample, background: { ...gradient, direction: 'radial' } }).ok,
    ).toBe(false)
    expect(parsePersonalization({ ...sample, background: { ...gradient, angle: 90 } }).ok).toBe(
      false,
    )
  })

  test('越界数值与非法颜色被拒绝', () => {
    expect(parsePersonalization({ ...sample, opacity: 0.1 }).ok).toBe(false)
    expect(parsePersonalization({ ...sample, accent: 'red' }).ok).toBe(false)
    expect(
      parsePersonalization({ ...sample, fog: { color: '#fff', density: 2, speed: 0 } }).ok,
    ).toBe(false)
  })

  test('图片文件名不接受路径', () => {
    const bad = { ...sample.background, file: '../bg.jpg' }
    expect(parsePersonalization({ ...sample, background: bad }).ok).toBe(false)
  })
})

describe('mergePersonalization', () => {
  test('已有雾面时逐字段覆盖', () => {
    const r = mergePersonalization(sample, { fog: { density: 0.2 } })
    expect(r.ok && r.value.fog).toEqual({ color: '#ffffff', density: 0.2, speed: 0.4 })
  })

  test('雾面设为 null 即取消；没有雾面时需给出完整的一组', () => {
    expect(mergePersonalization(sample, { fog: null }).ok && true).toBe(true)
    expect(mergePersonalization(DEFAULT_PERSONALIZATION, { fog: { color: '#ffffff' } }).ok).toBe(
      false,
    )
  })

  test('换背景类型时整组替换，不保留旧字段', () => {
    const r = mergePersonalization(sample, { background: { kind: 'color', color: '#101018' } })
    expect(r.ok && r.value.background).toEqual({ kind: 'color', color: '#101018' })
  })

  test('合并结果非法时返回错误', () => {
    expect(mergePersonalization(sample, { opacity: 2 }).ok).toBe(false)
    expect(mergePersonalization(sample, null).ok).toBe(false)
  })
})

test('默认值判定', () => {
  expect(isDefaultPersonalization(DEFAULT_PERSONALIZATION)).toBe(true)
  expect(isDefaultPersonalization({ ...DEFAULT_PERSONALIZATION, accent: '#7c3aed' })).toBe(false)
})

test('图片文件名', () => {
  expect(isPersonalImageName('bg.webp')).toBe(true)
  expect(isPersonalImageName('bg.svg')).toBe(false)
  expect(isPersonalImageName('a/b.png')).toBe(false)
  expect(isPersonalImageName('.png')).toBe(false)
})
