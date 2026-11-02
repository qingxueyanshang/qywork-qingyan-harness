/**
 * 覆盖 `lib/store/theme.ts`（外观权威：主题与个性化变量）、`lib/store/appearance/personalization.ts`
 * （个性化的读取、编辑与变更）、`lib/color.ts` 与 `PersonalBackdrop.tsx`。
 *
 * 测试 DOM 在本文件内注册，结束后注销，理由同 `settings/LoadState.test.tsx`。
 * 令牌以一段样式表注入：骨架半透明底色由当前明暗的 `--bg-*` 计算，缺少令牌时无法验证取值。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Personalization } from '@qywork/core'

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

const sample: Personalization = {
  background: { kind: 'gradient', from: '#101018', to: '#302050', direction: 'diagonal-down' },
  fog: { color: '#ffffff', density: 0.5, speed: 0.5 },
  opacity: 0.5,
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
  test('应用个性化：按当前明暗写入半透明底色与强调色', async () => {
    const store = await import('../../lib/store/index.ts')
    store.setTheme('dark')
    store.paintPersonalization({ personalization: sample, imageUrl: null })
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('dark')
    expect(root.style.getPropertyValue('--frame-bg')).toBe('rgba(21, 21, 23, 0.5)')
    expect(root.style.getPropertyValue('--content-bg')).toBe('rgba(12, 12, 13, 0.5)')
    expect(root.style.getPropertyValue('--accent')).toBe('rgba(124, 58, 237, 1)')
    expect(root.style.getPropertyValue('--accent-fg')).toBe('#ffffff')
    // 生成进度的色阶不属于强调色，保持 `tokens.css` 的值。
    expect(root.style.getPropertyValue('--vivid-500')).toBe('')
  })

  test('切换主题时按新明暗重新计算底色，个性化本身不变', async () => {
    const store = await import('../../lib/store/index.ts')
    store.setTheme('light')
    const root = document.documentElement
    expect(root.getAttribute('data-theme')).toBe('light')
    expect(root.style.getPropertyValue('--frame-bg')).toBe('rgba(247, 247, 248, 0.5)')
    expect(store.paintedPersonalization()?.personalization).toEqual(sample)
  })

  test('浅色强调色上的文字取深色', async () => {
    const store = await import('../../lib/store/index.ts')
    store.paintPersonalization({
      personalization: { ...sample, accent: '#fde68a' },
      imageUrl: null,
    })
    expect(document.documentElement.style.getPropertyValue('--accent-fg')).toBe('#16161a')
  })

  test('不透明度为 1、强调色为空时不写入变量；清除时移除全部变量', async () => {
    const store = await import('../../lib/store/index.ts')
    const root = document.documentElement
    store.paintPersonalization({
      personalization: { ...sample, opacity: 1, accent: null },
      imageUrl: null,
    })
    expect(root.style.getPropertyValue('--frame-bg')).toBe('')
    expect(root.style.getPropertyValue('--accent')).toBe('')
    store.paintPersonalization({ personalization: sample, imageUrl: null })
    store.paintPersonalization(null)
    expect(root.style.getPropertyValue('--frame-bg')).toBe('')
    expect(store.paintedPersonalization()).toBeNull()
  })
})

describe('PersonalBackdrop', () => {
  test('默认值不渲染背景色与雾面；渐变、图片与雾面按参数渲染', async () => {
    const store = await import('../../lib/store/index.ts')
    const { DEFAULT_PERSONALIZATION } = await import('@qywork/core')
    const { render } = await import('solid-js/web')
    const { PersonalBackdrop } = await import('./PersonalBackdrop.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    store.paintPersonalization(null)
    const dispose = render(() => <PersonalBackdrop />, host)
    try {
      expect(host.querySelector('.personal-backdrop')).toBeNull()
      store.paintPersonalization({ personalization: DEFAULT_PERSONALIZATION, imageUrl: null })
      expect(host.querySelector<HTMLElement>('.personal-layer')?.style.backgroundColor).toBe('')
      expect(host.querySelector('.personal-fog')).toBeNull()

      store.paintPersonalization({ personalization: sample, imageUrl: null })
      const layer = host.querySelector<HTMLElement>('.personal-layer')
      expect(layer?.style.backgroundImage).toContain('linear-gradient(135deg')
      expect(host.querySelectorAll('.fog-blob')).toHaveLength(4)
      expect(host.querySelector('.personal-dim')).toBeNull()

      store.paintPersonalization({
        personalization: {
          ...sample,
          background: { kind: 'image', file: 'bg.jpg', fit: 'cover', dim: 0.4, blur: 10 },
          fog: null,
        },
        imageUrl: 'http://localhost/bg.jpg',
      })
      const image = host.querySelector<HTMLElement>('.personal-layer')
      expect(image?.style.backgroundImage).toContain('bg.jpg')
      expect(image?.style.filter).toBe('blur(10px)')
      expect(host.querySelector<HTMLElement>('.personal-dim')?.style.opacity).toBe('0.4')
      expect(host.querySelector('.personal-fog')).toBeNull()
    } finally {
      dispose()
      host.remove()
      store.paintPersonalization(null)
    }
  })
})

describe('个性化读取', () => {
  const entry = {
    personalization: {
      ...sample,
      background: { kind: 'image', file: 'bg.png', fit: 'cover', dim: 0, blur: 0 },
    },
    updatedAt: 1700000000000.4,
  }

  test('连接就绪时读取并应用，图片直链带令牌与修改时间；变更时重新读取', async () => {
    const store = await import('../../lib/store/index.ts')
    const { setPersonalizationChange } = await import('../../lib/store/connection.ts')
    const urls: string[] = []
    globalThis.fetch = (async (url: string) => {
      urls.push(String(url))
      return new Response(JSON.stringify(entry), { status: 200 })
    }) as unknown as typeof fetch
    store.setState('connection', 'connecting')
    const stop = store.observePersonalization()
    try {
      store.setState('connection', 'ready')
      await new Promise((r) => setTimeout(r, 0))
      expect(urls[0]).toContain('/api/personalization')
      expect(store.paintedPersonalization()?.imageUrl).toContain(
        '/api/personalization/files/bg.png?v=1700000000000&token=',
      )
      setPersonalizationChange(7)
      await new Promise((r) => setTimeout(r, 0))
      expect(urls).toHaveLength(2)
    } finally {
      stop()
    }
  })

  test('编辑立即预览、停顿后保存一次；保存期间的变更不触发重新读取', async () => {
    const store = await import('../../lib/store/index.ts')
    const { setPersonalizationChange } = await import('../../lib/store/connection.ts')
    const calls: { url: string; method: string }[] = []
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET' })
      return new Response(JSON.stringify(entry), { status: 200 })
    }) as unknown as typeof fetch
    // 连接未就绪：观察开始时不读取，记录到的请求只有编辑的保存。
    store.setState('connection', 'connecting')
    const stop = store.observePersonalization()
    try {
      const a = { ...sample, opacity: 0.6 }
      const b = { ...sample, opacity: 0.7 }
      store.editPersonalization(a)
      store.editPersonalization(b)
      expect(store.currentPersonalization()).toEqual(b)
      setPersonalizationChange(8)
      await new Promise((r) => setTimeout(r, 300))
      expect(calls).toHaveLength(1)
      expect(calls[0]?.method).toBe('PUT')
      expect(calls[0]?.url).toContain('/api/personalization')
    } finally {
      stop()
    }
  })
})

describe('个性化保存失败', () => {
  test('没有收到响应时只显示本次操作的结果，不显示浏览器原文', async () => {
    const store = await import('../../lib/store/index.ts')
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch')
    }) as unknown as typeof fetch
    store.editPersonalization({ ...sample, opacity: 0.65 })
    await new Promise((r) => setTimeout(r, 300))
    expect(store.personalizationError()).toBe('保存失败')
  })

  test('服务端拒绝时显示服务端说明的原因', async () => {
    const store = await import('../../lib/store/index.ts')
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: '强调色格式不正确' }), {
        status: 422,
      })) as unknown as typeof fetch
    store.editPersonalization({ ...sample, opacity: 0.6 })
    await new Promise((r) => setTimeout(r, 300))
    expect(store.personalizationError()).toBe('强调色格式不正确')
  })
})
