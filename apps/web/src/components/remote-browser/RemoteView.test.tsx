/**
 * 覆盖 `remote-browser/RemoteView.tsx` 的缩放（`size.zoom` 的报告与双指捏合）与 `remote-browser/zoom.ts` 的档位换算。
 *
 * 查看连接是假 WebSocket，画面解码（`createImageBitmap`）以桩代替。
 */

import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

class FakeSocket {
  static readonly OPEN = 1
  static last: FakeSocket | null = null
  readyState = 0
  binaryType = ''
  sent: Record<string, unknown>[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: (() => void) | null = null

  constructor(readonly url: string) {
    FakeSocket.last = this
  }

  send(raw: string): void {
    this.sent.push(JSON.parse(raw) as Record<string, unknown>)
  }

  close(): void {
    this.readyState = 3
  }

  open(): void {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }

  /** 推送一帧：元数据之后是两个字节的画面。 */
  frame(width: number, height: number): void {
    const head = new TextEncoder().encode(JSON.stringify({ width, height }))
    const data = new Uint8Array(4 + head.length + 2)
    new DataView(data.buffer).setUint32(0, head.length)
    data.set(head, 4)
    this.onmessage?.({ data: data.buffer })
  }

  sizes(): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type === 'size')
  }
}

let dispose: (() => void) | undefined

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents, DelegatedEvents } = await import('solid-js/web')
  delegateEvents([...DelegatedEvents])
  Object.assign(globalThis, {
    WebSocket: FakeSocket,
    createImageBitmap: async () => ({ close() {} }),
  })
})

afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function until(check: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`等待超时：${what}`)
}

function touch(el: Element, type: string, id: number, x: number, y: number): void {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      pointerId: id,
      pointerType: 'touch',
    }),
  )
}

async function mount() {
  const { render } = await import('solid-js/web')
  const { createSignal } = await import('solid-js')
  const { default: RemoteView } = await import('./RemoteView.tsx')
  const [zoom, setZoom] = createSignal(1)
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <RemoteView tabId="bt_1" zoom={zoom()} onZoom={setZoom} />, host)
  const socket = FakeSocket.last as FakeSocket
  socket.open()
  await until(() => socket.sizes().length === 1, '连接后报告显示区域')
  socket.frame(390, 700)
  const canvas = host.querySelector('canvas') as HTMLCanvasElement
  return { socket, canvas, zoom, setZoom }
}

test('显示区域随缩放比例报告；工具栏改比例时重新报告', async () => {
  const { socket, setZoom } = await mount()
  expect(socket.sizes()[0]).toMatchObject({ zoom: 1 })
  setZoom(1.5)
  await until(() => socket.sizes().length === 2, '比例变化后重新报告')
  expect(socket.sizes()[1]).toMatchObject({ zoom: 1.5 })
})

test('双指捏合：画布按距离之比预览，松开后取最近的档位，预览保持到缩放后的第一帧；捏合不产生点击', async () => {
  const { socket, canvas, zoom } = await mount()
  await new Promise((resolve) => setTimeout(resolve, 10))
  touch(canvas, 'pointerdown', 1, 100, 100)
  touch(canvas, 'pointerdown', 2, 200, 100)
  touch(canvas, 'pointermove', 2, 310, 100)
  expect(canvas.style.transform).toBe('scale(2.1)')
  touch(canvas, 'pointerup', 2, 310, 100)
  expect(zoom()).toBe(2)
  await until(() => socket.sizes().length === 2, '松开后报告新的比例')
  expect(socket.sizes()[1]).toMatchObject({ zoom: 2 })
  // 缩放之前的画面不清除预览；缩放后的视口宽度不同，收到时清除。
  socket.frame(390, 700)
  await new Promise((resolve) => setTimeout(resolve, 10))
  expect(canvas.style.transform).toBe('scale(2.1)')
  socket.frame(195, 350)
  await until(() => canvas.style.transform === '', '缩放后的第一帧清除预览')
  touch(canvas, 'pointerup', 1, 100, 100)
  expect(socket.sent.filter((m) => m.type === 'mouse' || m.type === 'wheel')).toEqual([])
})

test('两指距离变化不超过轻点的容差时不改比例', async () => {
  const { socket, canvas, zoom } = await mount()
  await new Promise((resolve) => setTimeout(resolve, 10))
  touch(canvas, 'pointerdown', 1, 100, 100)
  touch(canvas, 'pointerdown', 2, 200, 100)
  touch(canvas, 'pointermove', 2, 204, 100)
  touch(canvas, 'pointerup', 2, 204, 100)
  touch(canvas, 'pointerup', 1, 100, 100)
  expect(zoom()).toBe(1)
  expect(canvas.style.transform).toBe('')
  expect(socket.sent.filter((m) => m.type === 'mouse' || m.type === 'wheel')).toEqual([])
})

test('档位换算：按档位步进、端点不变；捏合的比例取比值最接近的一档', async () => {
  const { nearestZoom, zoomStep } = await import('./zoom.ts')
  expect(zoomStep(1, 1)).toBe(1.1)
  expect(zoomStep(1, -1)).toBe(0.9)
  expect(zoomStep(1.2, 1)).toBe(1.25)
  expect(zoomStep(1.2, -1)).toBe(1.1)
  expect(zoomStep(5, 1)).toBe(5)
  expect(zoomStep(0.25, -1)).toBe(0.25)
  expect(nearestZoom(0.7)).toBe(2 / 3)
  expect(nearestZoom(0.72)).toBe(0.75)
  expect(nearestZoom(2.2)).toBe(2)
  expect(nearestZoom(9)).toBe(5)
  expect(nearestZoom(0.1)).toBe(0.25)
})
