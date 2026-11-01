/** 覆盖 `skin.ts`：皮肤校验、合并与文件名判定。 */

import { describe, expect, test } from 'bun:test'
import { DEFAULT_SKIN, isSkinId, isSkinImageName, mergeSkin, parseSkin, type Skin } from './skin.ts'

const sample: Skin = {
  name: '星空',
  base: 'dark',
  background: { kind: 'image', file: 'bg.jpg', fit: 'cover', dim: 0.3, blur: 0 },
  effect: { kind: 'fog', color: '#ffffff', density: 0.5, speed: 0.4 },
  surface: { opacity: 0.7 },
  accent: '#7c3aed',
}

describe('parseSkin', () => {
  test('合法皮肤原样通过，颜色统一为小写', () => {
    const r = parseSkin({ ...sample, accent: '#7C3AED' })
    expect(r).toEqual({ ok: true, value: sample })
  })

  test('默认皮肤合法', () => {
    expect(parseSkin(DEFAULT_SKIN).ok).toBe(true)
  })

  test('未知字段被拒绝，不做忽略', () => {
    const r = parseSkin({ ...sample, extra: 1 })
    expect(r).toEqual({ ok: false, error: '皮肤 中有无法识别的字段：extra' })
  })

  test('切换背景类型后残留的字段被拒绝', () => {
    const r = parseSkin({ ...sample, background: { kind: 'color', color: '#000', file: 'bg.jpg' } })
    expect(r.ok).toBe(false)
  })

  test('越界数值与非法颜色被拒绝', () => {
    expect(parseSkin({ ...sample, surface: { opacity: 0.1 } }).ok).toBe(false)
    expect(parseSkin({ ...sample, surface: { opacity: 1, blur: 4 } }).ok).toBe(false)
    expect(parseSkin({ ...sample, accent: 'red' }).ok).toBe(false)
    expect(
      parseSkin({ ...sample, background: { kind: 'gradient', angle: 90, stops: ['#000'] } }).ok,
    ).toBe(false)
  })

  test('图片文件名不接受路径', () => {
    const bad = { ...sample.background, file: '../bg.jpg' }
    expect(parseSkin({ ...sample, background: bad }).ok).toBe(false)
  })
})

describe('mergeSkin', () => {
  test('同类参数组逐字段覆盖', () => {
    const r = mergeSkin(sample, { effect: { density: 0.2 } })
    expect(r.ok && r.value.effect).toEqual({
      kind: 'fog',
      color: '#ffffff',
      density: 0.2,
      speed: 0.4,
    })
  })

  test('换类型时整组替换，不保留旧字段', () => {
    const r = mergeSkin(sample, { background: { kind: 'color', color: '#101018' } })
    expect(r.ok && r.value.background).toEqual({ kind: 'color', color: '#101018' })
  })

  test('合并结果非法时返回错误', () => {
    expect(mergeSkin(sample, { surface: { opacity: 2 } }).ok).toBe(false)
    expect(mergeSkin(sample, null).ok).toBe(false)
  })
})

describe('名称判定', () => {
  test('皮肤 id', () => {
    expect(isSkinId('night-sky_2')).toBe(true)
    expect(isSkinId('../x')).toBe(false)
    expect(isSkinId('A')).toBe(false)
  })

  test('图片文件名', () => {
    expect(isSkinImageName('bg.webp')).toBe(true)
    expect(isSkinImageName('bg.svg')).toBe(false)
    expect(isSkinImageName('a/b.png')).toBe(false)
    expect(isSkinImageName('.png')).toBe(false)
  })
})
