/**
 * 覆盖 `store/shell.ts`：只有外壳界面窗口按桌面端运行；外壳拖放分发按落点交给命中的接收方，悬停状态广播给全部接收方，注销后不再接收；
 * 落点在 Windows 上按物理像素换算，在 macOS 与 Linux 上即 CSS 像素。
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

/** 外壳事件桥的桩：记录每个事件的回调，由测试手动触发。 */
const handlers = new Map<string, (raw: unknown) => void>()
const pixelRatioDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio')
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')

const setPixelRatio = (value: number) => {
  Object.defineProperty(globalThis, 'devicePixelRatio', { configurable: true, value })
}

/** WebView 的 `navigator.platform`：决定外壳落点的单位。 */
const setPlatform = (platform: string) => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { platform } })
}

beforeAll(() => {
  let next = 0
  const callbacks = new Map<number, (raw: unknown) => void>()
  ;(globalThis as Record<string, unknown>).__TAURI_INTERNALS__ = {
    metadata: { currentWebview: { label: 'main' } },
    transformCallback: (fn: (raw: unknown) => void) => {
      next += 1
      callbacks.set(next, fn)
      return next
    },
    invoke: async (cmd: string, args: { event: string; handler: number }) => {
      if (cmd === 'plugin:event|listen') handlers.set(args.event, callbacks.get(args.handler)!)
    },
  }
})

afterAll(() => {
  delete (globalThis as Record<string, unknown>).__TAURI_INTERNALS__
})

afterEach(() => {
  if (pixelRatioDescriptor) {
    Object.defineProperty(globalThis, 'devicePixelRatio', pixelRatioDescriptor)
  } else {
    Reflect.deleteProperty(globalThis, 'devicePixelRatio')
  }
  if (navigatorDescriptor) Object.defineProperty(globalThis, 'navigator', navigatorDescriptor)
})

const fire = (event: string, payload: unknown) => handlers.get(event)!({ payload })

/**
 * 原始失败形状：内置浏览器的子视图同样被注入 `__TAURI_INTERNALS__`，在其中打开的本界面按桌面端运行，
 * 注册拖放时发出三次 `plugin:event|listen`，均被权限检查拒绝，成为三个未处理的拒绝。
 */
describe('只有外壳界面窗口按桌面端运行', () => {
  test('内置浏览器子视图中不按桌面端运行：不调用任何命令，注册拖放不产生拒绝', async () => {
    const g = globalThis as Record<string, unknown>
    const shell = g.__TAURI_INTERNALS__
    const invoked: string[] = []
    g.__TAURI_INTERNALS__ = {
      metadata: { currentWebview: { label: 'bt_5' } },
      transformCallback: () => 1,
      invoke: async (cmd: string) => {
        invoked.push(cmd)
        throw new Error(`Command ${cmd} not allowed by ACL`)
      },
    }
    const rejections: unknown[] = []
    const onRejection = (reason: unknown) => rejections.push(reason)
    process.on('unhandledRejection', onRejection)
    try {
      const { isDesktopShell, registerDropSink, tauriInvoke } = await import('./shell.ts')
      expect(isDesktopShell()).toBe(false)
      await expect(tauriInvoke('remember_workspace')).rejects.toThrow('该功能仅在桌面端可用')
      const dispose = registerDropSink({ hit: () => false, over: () => {}, paths: () => {} })
      await new Promise((resolve) => setTimeout(resolve, 0))
      dispose()
      expect(invoked).toEqual([])
      expect(rejections).toEqual([])

      g.__TAURI_INTERNALS__ = {
        ...(shell as object),
        metadata: { currentWebview: { label: 'pet' } },
      }
      expect(isDesktopShell()).toBe(true)
      g.__TAURI_INTERNALS__ = { ...(shell as object), metadata: undefined }
      expect(isDesktopShell()).toBe(false)
    } finally {
      process.off('unhandledRejection', onRejection)
      g.__TAURI_INTERNALS__ = shell
    }
  })
})

describe('外壳拖放分发', () => {
  test('拖放交给落点所在区域的接收方；悬停状态广播给全部接收方；注销后不再接收', async () => {
    const { registerDropSink } = await import('./shell.ts')
    const got: string[] = []
    const over: string[] = []
    const left = registerDropSink({
      hit: (p) => p.x < 100,
      over: (on) => over.push(`left:${on}`),
      paths: (paths) => got.push(`left:${paths.join(',')}`),
    })
    const right = registerDropSink({
      hit: (p) => p.x >= 100,
      over: (on) => over.push(`right:${on}`),
      paths: (paths, pos) => got.push(`right:${paths.join(',')}@${pos.x}`),
    })
    await new Promise((resolve) => setTimeout(resolve, 0))

    fire('tauri://drag-over', { position: { x: 150, y: 10 } })
    expect(over).toEqual(['left:false', 'right:true'])
    fire('tauri://drag-drop', { paths: ['C:/a.png'], position: { x: 150, y: 10 } })
    expect(got).toEqual(['right:C:/a.png@150'])

    right()
    fire('tauri://drag-drop', { paths: ['C:/b.png'], position: { x: 150, y: 10 } })
    expect(got).toEqual(['right:C:/a.png@150'])
    fire('tauri://drag-drop', { paths: ['C:/c.png'], position: { x: 10, y: 10 } })
    expect(got).toEqual(['right:C:/a.png@150', 'left:C:/c.png'])
    left()
  })

  test.each([1, 1.25, 1.5, 2])(
    'Windows 上缩放为 %s 时，输入框与画布按 CSS 坐标接收拖放',
    async (scale) => {
      const { registerDropSink } = await import('./shell.ts')
      setPlatform('Win32')
      setPixelRatio(scale)
      const received: { target: string; paths: string[]; pos: { x: number; y: number } }[] = []
      const hovered = new Set<string>()
      const regions = [
        { target: 'composer', left: 200, top: 600, right: 900, bottom: 750 },
        { target: 'canvas', left: 950, top: 100, right: 1250, bottom: 750 },
      ]
      const unregister = regions.map((r) =>
        registerDropSink({
          hit: (p) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom,
          over: (on) => {
            if (on) hovered.add(r.target)
            else hovered.delete(r.target)
          },
          paths: (paths, pos) => received.push({ target: r.target, paths, pos }),
        }),
      )
      try {
        for (const { target, x, y } of [
          { target: 'composer', x: 500, y: 675 },
          { target: 'canvas', x: 1100, y: 400 },
        ]) {
          const position = { x: x * scale, y: y * scale }
          const paths = [`C:/${target}.png`]
          fire('tauri://drag-over', { position })
          expect([...hovered]).toEqual([target])
          fire('tauri://drag-drop', { paths, position })
          expect(received.at(-1)).toEqual({ target, paths, pos: { x, y } })
          expect(hovered.size).toBe(0)
        }
        expect(received).toHaveLength(2)
        fire('tauri://drag-drop', {
          paths: ['C:/outside.png'],
          position: { x: 925 * scale, y: 675 * scale },
        })
        expect(received).toHaveLength(2)
      } finally {
        for (const dispose of unregister) dispose()
      }
    },
  )

  test('Windows 上跨屏或页面缩放变化后，悬停与松开使用各自事件发生时的缩放比例', async () => {
    const { registerDropSink } = await import('./shell.ts')
    setPlatform('Win32')
    setPixelRatio(1)
    const received: { x: number; y: number }[] = []
    let hovered = false
    const unregister = registerDropSink({
      hit: (p) => p.x >= 200 && p.x <= 900 && p.y >= 600 && p.y <= 750,
      over: (on) => {
        hovered = on
      },
      paths: (_paths, pos) => received.push(pos),
    })
    try {
      setPixelRatio(1.25)
      fire('tauri://drag-over', { position: { x: 625, y: 843.75 } })
      expect(hovered).toBe(true)
      setPixelRatio(2)
      fire('tauri://drag-drop', { paths: ['C:/a.png'], position: { x: 1000, y: 1350 } })
      expect(received).toEqual([{ x: 500, y: 675 }])
      expect(hovered).toBe(false)
      setPixelRatio(1)
      fire('tauri://drag-over', { position: { x: 500, y: 675 } })
      expect(hovered).toBe(true)
      fire('tauri://drag-leave', {})
      expect(hovered).toBe(false)
      fire('tauri://drag-drop', { paths: ['C:/missing-position.png'] })
      expect(received).toHaveLength(1)
    } finally {
      unregister()
    }
  })

  /** 原始失败形状：Retina 屏上落点按物理像素再除以 2，拖到输入框与画布上的文件全部落空。 */
  test.each(['MacIntel', 'Linux x86_64'])(
    '平台为 %s 时落点即 CSS 像素，缩放为 2 时输入框与画布接收拖放',
    async (platform) => {
      const { registerDropSink } = await import('./shell.ts')
      setPlatform(platform)
      setPixelRatio(2)
      const received: { target: string; pos: { x: number; y: number } }[] = []
      const regions = [
        { target: 'composer', left: 200, top: 600, right: 900, bottom: 750 },
        { target: 'canvas', left: 950, top: 100, right: 1250, bottom: 750 },
      ]
      const unregister = regions.map((r) =>
        registerDropSink({
          hit: (p) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom,
          over: () => {},
          paths: (_paths, pos) => received.push({ target: r.target, pos }),
        }),
      )
      try {
        fire('tauri://drag-drop', { paths: ['/Users/a/a.png'], position: { x: 500, y: 675 } })
        fire('tauri://drag-drop', { paths: ['/Users/a/b.png'], position: { x: 1100, y: 400 } })
        expect(received).toEqual([
          { target: 'composer', pos: { x: 500, y: 675 } },
          { target: 'canvas', pos: { x: 1100, y: 400 } },
        ])
      } finally {
        for (const dispose of unregister) dispose()
      }
    },
  )
})
