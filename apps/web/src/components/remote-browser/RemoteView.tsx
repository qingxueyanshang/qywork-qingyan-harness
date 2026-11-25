/**
 * 内置浏览器页面的远程画面，用于桌面外壳以外的客户端：经查看连接（`client.browserViewUrl`）接收画面并转发输入，
 * 协议见 `@qywork/core` 的 `browser-view.ts`。
 *
 * - 画面按比例缩放到显示区域内、居中显示；输入坐标按显示的位置换算为页面视口的 CSS 像素。
 * - 每显示一帧回复一次 `ack`。显示区域的尺寸经 `size` 报告，页面视口按它设定，画面铺满显示区域；尺寸变化时重新报告。
 * - 鼠标的按下、移动、抬起与滚轮原样转发，移动每帧最多一次。触屏：轻点为一次点击，拖动为滚动（转为滚轮）；
 *   长按（`lib/long-press.ts`）后拖动为按住左键拖动（选择文字、拖动滑块），开始时设备振动一次（支持时）。
 *   不把单指拖动直接转为按住拖动：网页按鼠标处理，单指拖动在网页中是选择文字，页面无法滚动。
 * - 缩放比例由调用方持有（`zoom`），随 `size` 报告。双指捏合期间画布按两指距离之比预览，松开后以最近的档位调用 `onZoom`，
 *   预览保持到缩放后的第一帧。不要在捏合期间逐次报告比例：服务端每次设定视口都重新开始推送画面，画面随之停滞。
 * - 键盘经一个透明的输入框（`input`）接收：文字与输入法确认的结果转为 `text`，功能键与快捷键转为 `key`。鼠标点击画面时
 *   聚焦该输入框；触屏客户端由调用方的键盘按钮聚焦（`onInput` 取得该输入框），聚焦时系统键盘弹出。
 *   输入框中保留一个零宽字符：输入框为空时 Android 的系统键盘按退格不产生事件。
 * - 不在画面中的弹出层（下拉框、日期等输入框、网页对话框、选择文件）由 `RemotePrompt` 显示，结果经连接回传。
 * - 复制与粘贴经系统剪贴板：服务端发来网页中选中的文字（`selection`），复制、剪切时写入剪贴板；粘贴时把剪贴板中的文字
 *   作为输入发给网页，不把 Ctrl+V 交给网页（浏览器自身的剪贴板与系统剪贴板不相通）。
 * - 指针样式按服务端读取的网页样式显示，只接受关键字：网页样式中的 `url()` 会使本页面加载网页指定的地址。
 * - 连接关闭时显示原因：页面已关闭、无法显示该页面或连接已断开（后两者可重新连接）。
 */

import type {
  BrowserViewFrame,
  BrowserViewInput,
  BrowserViewNotice,
  BrowserViewPrompt,
  BrowserViewRect,
} from '@qywork/core'
import { createEffect, createSignal, on, onCleanup, onMount, Show } from 'solid-js'
import { attachLongPress } from '../../lib/long-press.ts'
import { client } from '../../lib/store/index.ts'
import RemotePrompt, { type PromptArea } from './RemotePrompt.tsx'
import { nearestZoom, ZOOM_MAX, ZOOM_MIN } from './zoom.ts'

/** 触屏拖动超过该距离（CSS 像素）即为滚动，不再计为轻点。 */
const TAP_SLOP = 8
/** 输入框中保留的字符，见文件头。 */
const KEEP = '​'

/** 可以显示的指针样式（CSS `cursor` 的关键字）。其余取值显示为缺省指针。 */
const CURSORS = new Set([
  'default',
  'pointer',
  'text',
  'vertical-text',
  'move',
  'grab',
  'grabbing',
  'crosshair',
  'not-allowed',
  'no-drop',
  'wait',
  'progress',
  'help',
  'copy',
  'alias',
  'cell',
  'context-menu',
  'zoom-in',
  'zoom-out',
  'col-resize',
  'row-resize',
  'n-resize',
  's-resize',
  'e-resize',
  'w-resize',
  'ne-resize',
  'nw-resize',
  'se-resize',
  'sw-resize',
  'ew-resize',
  'ns-resize',
  'nesw-resize',
  'nwse-resize',
  'all-scroll',
  'none',
])

/** 转为 `key` 的按键：不产生文字的功能键。按住 Ctrl、Alt 或 Meta 时任何键都转为 `key`。 */
const NAMED_KEYS = new Set([
  'Enter',
  'Tab',
  'Escape',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
])

const BUTTONS = ['left', 'middle', 'right'] as const

function heldOf(e: KeyboardEvent): string[] {
  const held: string[] = []
  if (e.ctrlKey) held.push('ControlLeft')
  if (e.shiftKey) held.push('ShiftLeft')
  if (e.altKey) held.push('AltLeft')
  if (e.metaKey) held.push('MetaLeft')
  return held
}

export default function RemoteView(props: {
  tabId: string
  /** 取得键盘输入框，供触屏客户端的键盘按钮聚焦。 */
  onInput?: (input: HTMLInputElement) => void
  /** 画面的 JPEG 质量；不给出时为服务端的缺省值。本机显示时线路不受限，取较高的质量。 */
  quality?: number
  /** 缩放比例，1 为 100%；不给出时为 1。 */
  zoom?: number
  /** 双指捏合结束时以最近的档位调用；不给出时不处理捏合。 */
  onZoom?: (zoom: number) => void
}) {
  let box!: HTMLDivElement
  let canvas!: HTMLCanvasElement
  let input!: HTMLInputElement
  const [state, setState] = createSignal<'connecting' | 'open' | 'closed' | 'failed' | 'lost'>(
    'connecting',
  )
  const [prompt, setPrompt] = createSignal<BrowserViewPrompt | null>(null)
  let ws: WebSocket | null = null
  /** 最近一帧的页面视口尺寸与画面在画布上的位置（CSS 像素）。 */
  let frame: BrowserViewFrame | null = null
  let drawn = { x: 0, y: 0, w: 0, h: 0 }
  /** 网页中选中的文字（服务端的 `selection`）：复制时写入剪贴板。 */
  let selected = ''

  const send = (msg: BrowserViewInput) => {
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
  }

  /** 显示区域中的位置换算为页面视口的 CSS 像素；画面之外返回 `null`。 */
  const pagePoint = (clientX: number, clientY: number) => {
    if (!frame || drawn.w === 0) return null
    const rect = canvas.getBoundingClientRect()
    const x = ((clientX - rect.left - drawn.x) / drawn.w) * frame.width
    const y = ((clientY - rect.top - drawn.y) / drawn.h) * frame.height
    if (x < 0 || y < 0 || x > frame.width || y > frame.height) return null
    return { x, y }
  }

  /** 弹出层的显示区域：页面视口中的矩形按画面的位置与缩放换算。 */
  const area = (): PromptArea => ({
    width: box.clientWidth,
    height: box.clientHeight,
    place: (rect: BrowserViewRect) => {
      const k = frame ? drawn.w / frame.width : 1
      return {
        x: drawn.x + rect.x * k,
        y: drawn.y + rect.y * k,
        width: rect.width * k,
        height: rect.height * k,
      }
    },
  })

  const draw = async (data: ArrayBuffer) => {
    const head = new DataView(data).getUint32(0)
    const meta = JSON.parse(
      new TextDecoder().decode(new Uint8Array(data, 4, head)),
    ) as BrowserViewFrame
    const image = await createImageBitmap(
      new Blob([new Uint8Array(data, 4 + head)], { type: 'image/jpeg' }),
    )
    const dpr = window.devicePixelRatio || 1
    const cw = box.clientWidth
    const ch = box.clientHeight
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(ch * dpr)) {
      canvas.width = Math.round(cw * dpr)
      canvas.height = Math.round(ch * dpr)
    }
    const scale = Math.min(cw / meta.width, ch / meta.height)
    const w = meta.width * scale
    const h = meta.height * scale
    drawn = { x: (cw - w) / 2, y: (ch - h) / 2, w, h }
    frame = meta
    const ctx = canvas.getContext('2d')
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(image, drawn.x * dpr, drawn.y * dpr, w * dpr, h * dpr)
    }
    image.close()
    if (preview !== null && meta.width !== preview) clearPreview()
  }

  /**
   * 报告显示区域：页面视口按它设定。尺寸变化时重新报告，每帧最多一次。所在的页未显示时尺寸为 0，服务端随之停止推送画面。
   */
  let sizeFrame = 0
  const reportSize = () => {
    cancelAnimationFrame(sizeFrame)
    sizeFrame = requestAnimationFrame(() => {
      send({
        type: 'size',
        width: box.clientWidth,
        height: box.clientHeight,
        scale: window.devicePixelRatio || 1,
        ...(props.quality === undefined ? {} : { quality: props.quality }),
        ...(props.zoom === undefined ? {} : { zoom: props.zoom }),
      })
    })
  }
  createEffect(on(() => props.zoom, reportSize, { defer: true }))

  const connect = () => {
    setState('connecting')
    setPrompt(null)
    clearPreview()
    const socket = new WebSocket(client.browserViewUrl(props.tabId))
    socket.binaryType = 'arraybuffer'
    ws = socket
    socket.onopen = () => {
      setState('open')
      reportSize()
    }
    socket.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const notice = JSON.parse(e.data) as BrowserViewNotice
        if (notice.type === 'closed') setState('closed')
        else if (notice.type === 'error') setState('failed')
        else if (notice.type === 'dismiss') setPrompt(null)
        else if (notice.type === 'selection') selected = notice.text
        else if (notice.type === 'cursor') {
          canvas.style.cursor = CURSORS.has(notice.cursor) ? notice.cursor : 'default'
        } else setPrompt(notice)
        return
      }
      draw(e.data as ArrayBuffer).then(
        () => send({ type: 'ack' }),
        () => send({ type: 'ack' }),
      )
    }
    socket.onclose = () => {
      if (ws !== socket) return
      ws = null
      setPrompt(null)
      setState((s) => (s === 'closed' || s === 'failed' ? s : 'lost'))
    }
  }

  // ── 鼠标 ──
  let moveQueued: { x: number; y: number } | null = null
  let moveFrame = 0
  const flushMove = () => {
    moveFrame = 0
    if (moveQueued) send({ type: 'mouse', action: 'move', ...moveQueued, button: 'none' })
    moveQueued = null
  }

  // ── 触屏：轻点与拖动滚动，双指捏合缩放 ──
  /** `held`：长按后进入按住左键拖动，此后的移动与抬起按鼠标转发。 */
  let touch: {
    id: number
    x: number
    y: number
    lastX: number
    lastY: number
    moved: boolean
    held: boolean
  } | null = null
  /** 按下的手指的位置，按 `pointerId`。 */
  const fingers = new Map<number, { x: number; y: number }>()
  /** 进行中的捏合：两指的初始距离与预览的比例。距离变化超过 `TAP_SLOP` 之前不计为捏合。 */
  let pinch: { start: number; ratio: number; moved: boolean } | null = null
  /** 捏合预览保持期间为捏合开始时帧元数据的宽度：宽度不同的帧即为缩放后的画面。 */
  let preview: number | null = null

  function clearPreview() {
    preview = null
    canvas.style.transform = ''
  }

  const spread = () => {
    const [a, b] = [...fingers.values()]
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0
  }

  /** 长按：手指仍按住且未开始滚动时，在按下处按下左键，此后的移动按拖动转发。 */
  const hold = (x: number, y: number) => {
    const t = touch
    if (!t || t.moved || pinch) return
    const p = pagePoint(x, y)
    if (!p) return
    t.held = true
    navigator.vibrate?.(10)
    send({ type: 'mouse', action: 'move', ...p, button: 'none' })
    send({ type: 'mouse', action: 'down', ...p, button: 'left', clickCount: 1 })
  }
  /** 结束按住拖动：在最后的位置抬起左键。 */
  const release = (clientX: number, clientY: number) => {
    flushMove()
    const p = pagePoint(clientX, clientY)
    if (p) send({ type: 'mouse', action: 'up', ...p, button: 'left', clickCount: 1 })
  }

  const startPinch = (): boolean => {
    const start = spread()
    if (touch?.held) return false
    if (!props.onZoom || !frame || pinch || fingers.size !== 2 || start === 0) return false
    const [a, b] = [...fingers.values()] as [{ x: number; y: number }, { x: number; y: number }]
    const rect = canvas.getBoundingClientRect()
    touch = null
    pinch = { start, ratio: 1, moved: false }
    preview = frame.width
    canvas.style.transformOrigin = `${(a.x + b.x) / 2 - rect.left}px ${(a.y + b.y) / 2 - rect.top}px`
    return true
  }

  const movePinch = (p: { start: number; ratio: number; moved: boolean }) => {
    const d = spread()
    if (!p.moved && Math.abs(d - p.start) < TAP_SLOP) return
    p.moved = true
    const current = props.zoom ?? 1
    const target = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, (current * d) / p.start))
    p.ratio = target / current
    canvas.style.transform = `scale(${p.ratio})`
  }

  /** 结束捏合：`apply` 为 false（触点被取消）或未达到捏合距离时不改比例。 */
  const endPinch = (apply: boolean) => {
    const p = pinch
    pinch = null
    if (!p) return
    const current = props.zoom ?? 1
    const next = apply && p.moved ? nearestZoom(current * p.ratio) : current
    if (next === current) clearPreview()
    else props.onZoom?.(next)
  }

  const onPointerDown = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') {
      fingers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (startPinch() || touch || pinch) return
      touch = {
        id: e.pointerId,
        x: e.clientX,
        y: e.clientY,
        lastX: e.clientX,
        lastY: e.clientY,
        moved: false,
        held: false,
      }
      return
    }
    const p = pagePoint(e.clientX, e.clientY)
    if (!p) return
    e.preventDefault()
    input.focus({ preventScroll: true })
    canvas.setPointerCapture(e.pointerId)
    send({
      type: 'mouse',
      action: 'down',
      ...p,
      button: BUTTONS[e.button] ?? 'left',
      clickCount: e.detail || 1,
    })
  }

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') {
      const finger = fingers.get(e.pointerId)
      if (finger) {
        finger.x = e.clientX
        finger.y = e.clientY
      }
      if (pinch) {
        movePinch(pinch)
        return
      }
      if (!touch || e.pointerId !== touch.id || !frame) return
      if (touch.held) {
        touch.lastX = e.clientX
        touch.lastY = e.clientY
        const p = pagePoint(e.clientX, e.clientY)
        if (!p) return
        moveQueued = p
        if (!moveFrame) moveFrame = requestAnimationFrame(flushMove)
        return
      }
      if (!touch.moved && Math.hypot(e.clientX - touch.x, e.clientY - touch.y) < TAP_SLOP) return
      touch.moved = true
      const p = pagePoint(e.clientX, e.clientY) ?? { x: frame.width / 2, y: frame.height / 2 }
      const scale = frame.width / drawn.w
      send({
        type: 'wheel',
        ...p,
        dx: (touch.lastX - e.clientX) * scale,
        dy: (touch.lastY - e.clientY) * scale,
      })
      touch.lastX = e.clientX
      touch.lastY = e.clientY
      return
    }
    const p = pagePoint(e.clientX, e.clientY)
    if (!p) return
    moveQueued = p
    if (!moveFrame) moveFrame = requestAnimationFrame(flushMove)
  }

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerType !== 'mouse') {
      fingers.delete(e.pointerId)
      if (pinch) {
        endPinch(true)
        return
      }
      if (!touch || e.pointerId !== touch.id) return
      if (touch.held) {
        touch = null
        release(e.clientX, e.clientY)
        return
      }
      const tapped = !touch.moved
      touch = null
      const p = tapped ? pagePoint(e.clientX, e.clientY) : null
      if (!p) return
      send({ type: 'mouse', action: 'move', ...p, button: 'none' })
      send({ type: 'mouse', action: 'down', ...p, button: 'left', clickCount: 1 })
      send({ type: 'mouse', action: 'up', ...p, button: 'left', clickCount: 1 })
      return
    }
    const p = pagePoint(e.clientX, e.clientY)
    if (!p) return
    flushMove()
    send({
      type: 'mouse',
      action: 'up',
      ...p,
      button: BUTTONS[e.button] ?? 'left',
      clickCount: e.detail || 1,
    })
  }

  const onWheel = (e: WheelEvent) => {
    const p = pagePoint(e.clientX, e.clientY)
    if (!p || !frame) return
    e.preventDefault()
    const unit =
      e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? 16
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? frame.height
          : 1
    send({ type: 'wheel', ...p, dx: e.deltaX * unit, dy: e.deltaY * unit })
  }

  // ── 键盘 ──
  const resetInput = () => {
    input.value = KEEP
    input.setSelectionRange(KEEP.length, KEEP.length)
  }
  let composing = false
  const onKeyDown = (e: KeyboardEvent) => {
    if (composing || e.isComposing || e.key === 'Unidentified' || e.key === 'Process') return
    const shortcut = e.ctrlKey || e.altKey || e.metaKey
    if (!NAMED_KEYS.has(e.key) && !(shortcut && e.code)) return
    const clip = (e.ctrlKey || e.metaKey) && !e.altKey ? e.code : ''
    // 粘贴由 `paste` 事件发送剪贴板中的文字；复制与剪切照常交给网页（剪切删除选中的内容），
    // 同时让输入框触发 `copy` / `cut`：输入框中的内容被选中时这两个事件才会触发。
    if (clip === 'KeyV') return
    if (clip === 'KeyC' || clip === 'KeyX') input.select()
    else e.preventDefault()
    send({ type: 'key', code: e.code || e.key, held: heldOf(e) })
  }
  const onClipboardOut = (e: ClipboardEvent) => {
    e.preventDefault()
    e.clipboardData?.setData('text/plain', selected)
    resetInput()
  }
  const onPaste = (e: ClipboardEvent) => {
    e.preventDefault()
    const text = e.clipboardData?.getData('text/plain')
    if (text) send({ type: 'text', text })
  }
  const onBeforeInput = (e: InputEvent) => {
    if (composing) return
    if (e.inputType === 'insertText' && e.data) {
      e.preventDefault()
      send({ type: 'text', text: e.data })
    } else if (e.inputType === 'insertLineBreak' || e.inputType === 'insertParagraph') {
      e.preventDefault()
      send({ type: 'key', code: 'Enter', held: [] })
    } else if (e.inputType === 'deleteContentBackward') {
      e.preventDefault()
      send({ type: 'key', code: 'Backspace', held: [] })
    }
  }
  const onCompositionEnd = (e: CompositionEvent) => {
    composing = false
    if (e.data) send({ type: 'text', text: e.data })
    resetInput()
  }

  onMount(() => {
    resetInput()
    props.onInput?.(input)
    attachLongPress(canvas, hold)
    connect()
    const ro = new ResizeObserver(() => reportSize())
    ro.observe(box)
    canvas.addEventListener('wheel', onWheel, { passive: false })
    onCleanup(() => {
      ro.disconnect()
      canvas.removeEventListener('wheel', onWheel)
      cancelAnimationFrame(moveFrame)
      cancelAnimationFrame(sizeFrame)
      const socket = ws
      ws = null
      socket?.close()
    })
  })

  return (
    <div class="remote-view" ref={box}>
      <canvas
        ref={canvas}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={(e) => {
          if (touch?.held && touch.id === e.pointerId) release(touch.lastX, touch.lastY)
          touch = null
          fingers.delete(e.pointerId)
          endPinch(false)
        }}
        onContextMenu={(e) => e.preventDefault()}
      />
      <input
        ref={input}
        class="remote-view-input"
        type="text"
        autocomplete="off"
        autocapitalize="off"
        spellcheck={false}
        aria-label="网页输入"
        onKeyDown={onKeyDown}
        onCopy={onClipboardOut}
        onCut={onClipboardOut}
        onPaste={onPaste}
        onBeforeInput={onBeforeInput}
        onCompositionStart={() => {
          composing = true
        }}
        onCompositionEnd={onCompositionEnd}
        onInput={() => {
          if (!composing) resetInput()
        }}
      />
      <Show when={prompt()} keyed>
        {(p) => (
          <RemotePrompt
            prompt={p}
            tabId={props.tabId}
            area={area()}
            send={send}
            onDone={() => setPrompt(null)}
          />
        )}
      </Show>
      <Show when={state() === 'closed'}>
        <p class="remote-view-note">页面已关闭</p>
      </Show>
      <Show when={state() === 'failed' || state() === 'lost'}>
        <p class="remote-view-note">
          {state() === 'failed' ? '无法显示该页面' : '连接已断开'}
          <button class="btn-ghost sm" type="button" onClick={connect}>
            重新连接
          </button>
        </p>
      </Show>
    </div>
  )
}
