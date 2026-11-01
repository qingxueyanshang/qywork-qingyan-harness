/**
 * 覆盖 `lib/store/theme.ts`（外观权威：主题与皮肤选择）、`lib/store/appearance/skins.ts`（皮肤库读取与变更）、
 * `lib/color.ts` 与 `SkinBackdrop.tsx`。
 *
 * 测试 DOM 在本文件内注册，结束后注销，理由同 `settings/LoadState.test.tsx`。
 * 令牌以一段样式表注入：骨架半透明底色由当前明暗的 `--bg-*` 计算，缺少令牌时无法验证取值。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Skin } from '@qywork/core'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const style = document.createElement('style')
  style.textContent = `
    :root { --bg-sunken: #f7f7f8; --bg-app: #ffffff; }
    :root[data-theme="dark"] { --bg-sunken: #151517; --bg-app: #0c0c0d; }
  `
  document.head.append(style)
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const skin: Skin = {
  name: '星空',
  base: 'dark',
  background: { kind: 'gradient', angle: 135, stops: ['#101018', '#302050'] },
  effect: { kind: 'fog', color: '#ffffff', density: 0.5, speed: 0.5 },
  surface: { opacity: 0.5 },
  accent: '#7c3aed',
}

describe('color', () => {
  test('解析十六进制与 rgb 函数', async () => {
    const { parseColor, toCss, withAlpha, mix, luminance } = await import('../../lib/color.ts')
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor(' #15151780 ')?.a).toBeCloseTo(128 / 255)
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 })
    expect(parseColor('red')).toBeNull()
    expect(toCss(withAlpha({ r: 21, g: 21, b: 23, a: 1 }, 0.5))).toBe('rgba(21, 21, 23, 0.5)')
    expect(toCss(mix({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }, 0.5))).toBe(
      'rgba(128, 128, 128, 1)',
    )
    expect(luminance({ r: 255, g: 255, b: 255, a: 1 })).toBeCloseTo(1)
  })
})

describe('外观权威', () => {
  test('选用皮肤：明暗取皮肤的 base，读取定义后写入骨架变量', async () => {
    const store = await import('../../lib/store/index.ts')
    store.setTheme('light')
    store.chooseSkin({ id: 'night', base: 'dark' })
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(store.effectiveTheme()).toBe('dark')

    store.paintSkin({ id: 'night', skin, imageUrl: null })
    expect(root.style.getPropertyValue('--frame-bg')).toBe('rgba(21, 21, 23, 0.5)')
    expect(root.style.getPropertyValue('--content-bg')).toBe('rgba(12, 12, 13, 0.5)')
    expect(root.style.getPropertyValue('--accent')).toBe('rgba(124, 58, 237, 1)')
    expect(store.paintedSkin()?.id).toBe('night')
  })

  test('主题偏好在选用皮肤期间不改变明暗', async () => {
    const store = await import('../../lib/store/index.ts')
    store.setTheme('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(store.theme()).toBe('light')
  })

  test('已改选其他皮肤时，较慢返回的旧定义被忽略', async () => {
    const store = await import('../../lib/store/index.ts')
    store.chooseSkin({ id: 'other', base: 'dark' })
    expect(store.paintedSkin()).toBeNull()
    expect(document.documentElement.style.getPropertyValue('--frame-bg')).toBe('')
    store.paintSkin({ id: 'night', skin, imageUrl: null })
    expect(store.paintedSkin()).toBeNull()
  })

  test('定义的 base 与记录不一致时校正记录与明暗', async () => {
    const store = await import('../../lib/store/index.ts')
    store.chooseSkin({ id: 'paper', base: 'dark' })
    store.paintSkin({ id: 'paper', skin: { ...skin, base: 'light', accent: null }, imageUrl: null })
    expect(store.skinChoice()).toEqual({ id: 'paper', base: 'light' })
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(document.documentElement.style.getPropertyValue('--frame-bg')).toBe(
      'rgba(247, 247, 248, 0.5)',
    )
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('')
  })

  test('取消皮肤：恢复主题偏好并移除全部骨架变量', async () => {
    const store = await import('../../lib/store/index.ts')
    store.setTheme('system')
    store.chooseSkin(null)
    const root = document.documentElement
    expect(root.hasAttribute('data-theme')).toBe(false)
    expect(root.style.getPropertyValue('--frame-bg')).toBe('')
    expect(root.style.getPropertyValue('--content-bg')).toBe('')
    expect(store.paintedSkin()).toBeNull()
  })
})

describe('SkinBackdrop', () => {
  test('未选用皮肤时不渲染；渐变与雾面按参数渲染', async () => {
    const store = await import('../../lib/store/index.ts')
    const { render } = await import('solid-js/web')
    const { SkinBackdrop } = await import('./SkinBackdrop.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => <SkinBackdrop />, host)
    try {
      expect(host.querySelector('.skin-backdrop')).toBeNull()

      store.chooseSkin({ id: 'night', base: 'dark' })
      store.paintSkin({ id: 'night', skin, imageUrl: null })
      const layer = host.querySelector<HTMLElement>('.skin-layer')
      expect(layer?.style.backgroundImage).toContain('linear-gradient(135deg')
      expect(host.querySelectorAll('.fog-blob')).toHaveLength(4)
      expect(host.querySelector('.skin-dim')).toBeNull()

      store.paintSkin({
        id: 'night',
        skin: {
          ...skin,
          background: { kind: 'image', file: 'bg.jpg', fit: 'cover', dim: 0.4, blur: 10 },
          effect: { kind: 'none' },
        },
        imageUrl: 'http://localhost/bg.jpg',
      })
      const image = host.querySelector<HTMLElement>('.skin-layer')
      expect(image?.style.backgroundImage).toContain('bg.jpg')
      expect(image?.style.filter).toBe('blur(10px)')
      expect(host.querySelector<HTMLElement>('.skin-dim')?.style.opacity).toBe('0.4')
      expect(host.querySelector('.skin-fog')).toBeNull()

      store.chooseSkin(null)
      expect(host.querySelector('.skin-backdrop')).toBeNull()
    } finally {
      dispose()
      host.remove()
    }
  })
})

describe('皮肤库读取', () => {
  const entry = {
    id: 'night',
    skin: { ...skin, background: { kind: 'image', file: 'bg.png', fit: 'cover', dim: 0, blur: 0 } },
    updatedAt: 1700000000000.4,
  }

  test('按 id 选用：读取定义后应用，图片直链带令牌与修改时间', async () => {
    const store = await import('../../lib/store/index.ts')
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url))
      return new Response(JSON.stringify(entry), { status: 200 })
    }) as unknown as typeof fetch
    await store.selectSkinById('night')
    expect(urls[0]).toContain('/api/skins/night')
    expect(store.skinChoice()).toEqual({ id: 'night', base: 'dark' })
    expect(store.paintedSkin()?.imageUrl).toContain(
      '/api/skins/night/files/bg.png?v=1700000000000&token=',
    )
  })

  test('选用的皮肤被删除时恢复主题；改动其他皮肤时不重新读取', async () => {
    const store = await import('../../lib/store/index.ts')
    const { setSkinsChange } = await import('../../lib/store/connection.ts')
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url))
      return new Response(JSON.stringify(entry), { status: 200 })
    }) as unknown as typeof fetch
    const stop = store.observeSkins()
    try {
      setSkinsChange({ id: 'other', removed: false, seq: 1 })
      expect(urls).toEqual([])
      setSkinsChange({ id: 'night', removed: false, seq: 2 })
      expect(urls).toHaveLength(1)
      setSkinsChange({ id: 'night', removed: true, seq: 3 })
      expect(store.skinChoice()).toBeNull()
      expect(store.paintedSkin()).toBeNull()
    } finally {
      stop()
    }
  })

  test('对话中的 apply：按 id 读取并切换，null 取消皮肤', async () => {
    const store = await import('../../lib/store/index.ts')
    const { setSkinApply } = await import('../../lib/store/connection.ts')
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(entry), { status: 200 })) as unknown as typeof fetch
    const stop = store.observeSkins()
    try {
      setSkinApply({ id: 'night', seq: 1 })
      await new Promise((r) => setTimeout(r, 0))
      expect(store.skinChoice()).toEqual({ id: 'night', base: 'dark' })
      setSkinApply({ id: null, seq: 2 })
      expect(store.skinChoice()).toBeNull()
    } finally {
      stop()
    }
  })

  test('连接就绪时读取选用的皮肤，返回 404 时取消选用', async () => {
    const store = await import('../../lib/store/index.ts')
    store.selectSkin(entry as never)
    store.setState('connection', 'connecting')
    globalThis.fetch = (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
    const stop = store.observeSkins()
    try {
      store.setState('connection', 'ready')
      await new Promise((r) => setTimeout(r, 0))
      expect(store.skinChoice()).toBeNull()
    } finally {
      stop()
    }
  })
})
