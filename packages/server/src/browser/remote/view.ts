/**
 * 一条远程查看连接：桌面外壳以外的客户端查看并操作内置浏览器中的一个页面，协议见 `@qywork/core` 的 `browser-view.ts`。
 *
 * - 画面：每条查看连接建立一个 CDP 连接，按标记附加到该页（`CdpClient.attachViewer`），`Page.startScreencast` 的帧经连接发出。
 *   客户端每显示一帧回复一次 `ack`；在途达到 `BROWSER_VIEW_INFLIGHT` 时暂缓确认浏览器的帧，浏览器随之停止产生新帧，
 *   画面不在线路上排队。
 * - 页面不可见时（独立窗口中的后台标签页）浏览器不为 screencast 产生画面，改用截图取帧（`#captureLoop`），
 *   可见后恢复 screencast。
 * - 输入按收到的顺序逐条处理（`#queue`）：按下时先查询该位置是否为代选控件（`controls.ts`），查询返回之前，
 *   随后的移动与抬起不得先到达网页。
 * - 不在画面中的界面交给客户端显示：代选控件、网页对话框与文件选择（查看期间拦截），客户端的结果写回页面；
 *   上传的文件见 `uploads.ts`。
 * - 选中的文字在鼠标抬起与按键之后读取，变化时发给客户端（`selection`），客户端复制时写入系统剪贴板：
 *   浏览器自身的剪贴板与系统剪贴板不相通。鼠标所在元素的指针样式（`cursor`）按 `CURSOR_MS` 的间隔读取。
 * - 不另作本机文件的裁决，也不启用受控页会话的拦截：查看连接由持有配对令牌的用户操作，与用户在桌面上浏览相同。
 * - 页面关闭或宿主断开时通知客户端（`closed`）并关闭连接；附加失败时通知 `error`，原因写入日志。
 */

import { keyEvent } from '@qywork/agent'
import {
  BROWSER_VIEW_INFLIGHT,
  type BrowserViewFrame,
  type BrowserViewInput,
  type BrowserViewNotice,
  log,
} from '@qywork/core'
import type { ServerWebSocket } from 'bun'
import type { SocketData } from '../../deps.ts'
import type { BrowserBridge } from '../bridge.ts'
import { CdpClient as Cdp, type CdpClient, type CdpEvent } from '../cdp.ts'
import { applyControl, findControl, type PendingControl } from './controls.ts'
import { uploadPath } from './uploads.ts'

/** 画面的 JPEG 质量缺省值：文字可辨认，一帧约为 PNG 的十分之一。客户端可在 `size` 中另行指定。 */
const FRAME_QUALITY = 70
/** 读取指针样式的最短间隔：鼠标移动每帧一次，逐次读取的求值无必要。 */
const CURSOR_MS = 100
/** 发给客户端的选中文字的长度上限（字符）。 */
const MAX_SELECTION = 1_000_000

/** 当前选中的文字：输入框与文本域按其选区读取（`getSelection` 不包含它们），密码框不读取。 */
const SELECTION = `(() => {
  const a = document.activeElement
  if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && /^(text|search|url|tel|email|number)$/i.test(a.type)))
    && typeof a.selectionStart === 'number') {
    return a.value.slice(a.selectionStart, a.selectionEnd)
  }
  if (a && a.tagName === 'INPUT' && a.type === 'password') return ''
  return String(getSelection())
})()`
/**
 * 画面像素比的上限：高于它时一帧的字节数随像素比的平方增长（手机为 2.6–3），而文字清晰度的提升有限；
 * 差网络下帧率按字节数下降。
 */
const MAX_SCALE = 2

/**
 * 截图取帧的间隔：画面变化或有输入后为下限，画面不变时逐次加倍到上限。截图在电脑上占用 CPU，
 * 页面静止时不按下限持续截图；有输入时立即截图，不等待间隔。
 */
const CAPTURE_MIN_MS = 100
const CAPTURE_MAX_MS = 800

const BUTTON_BITS = { none: 0, left: 1, right: 2, middle: 4 } as const

const DIALOG_KINDS = ['alert', 'confirm', 'prompt', 'beforeunload'] as const

/** 在途的文件选择：回答时交给该元素。 */
interface PendingChooser {
  id: number
  backendNodeId: number
  multiple: boolean
}

/** 一条查看连接。`start` 之后由连接的消息驱动，`close` 在连接关闭时调用。 */
export class BrowserView {
  readonly #ws: ServerWebSocket<SocketData>
  readonly #bridge: BrowserBridge
  readonly #tabId: string
  #client: CdpClient | null = null
  #session = ''
  #inflight = 0
  /** 已收到、尚未确认的浏览器帧：在途达到上限时暂缓确认。 */
  #heldFrame: number | null = null
  /** 客户端的显示区域（`size`），收到之前为 `null`。可能在附加完成之前收到，附加后设定。 */
  #viewport: { width: number; height: number; scale: number } | null = null
  #quality = FRAME_QUALITY
  /** 最近发给客户端的选中文字与指针样式：只在变化时发送。 */
  #selection = ''
  #cursor = ''
  /** 指针样式的读取：间隔内的移动只记录位置，间隔结束时按最后的位置读取。 */
  #pointer: { x: number; y: number } | null = null
  #cursorTimer: ReturnType<typeof setTimeout> | null = null
  /** 按下的鼠标键：移动事件据此带上 `buttons`，拖动时页面收到按住状态。 */
  #buttons = 0
  /** 输入的处理顺序，见文件头。 */
  #queue: Promise<void> = Promise.resolve()
  /** 弹出层的编号，客户端的回答按它对应。 */
  #nextId = 0
  #control: PendingControl | null = null
  #chooser: PendingChooser | null = null
  /** 按下交给了代选控件：对应的抬起同样不交给网页。 */
  #swallowUp = false
  /** 浏览器报告页面不可见（`Page.screencastVisibilityChanged`），画面改由截图取得。 */
  #hidden = false
  #capturing = false
  #captureIdle = CAPTURE_MIN_MS
  /** 截图等待中：输入时提前结束等待。 */
  #wake: (() => void) | null = null
  /** 在途达到上限时等待客户端确认的截图循环。 */
  #ackWaiters: (() => void)[] = []
  #closed = false
  #offs: (() => void)[] = []

  constructor(ws: ServerWebSocket<SocketData>, bridge: BrowserBridge, tabId: string) {
    this.#ws = ws
    this.#bridge = bridge
    this.#tabId = tabId
  }

  async start(): Promise<void> {
    const host = this.#bridge.host()
    const tab = this.#bridge.tab(this.#tabId)
    if (!host || !tab) {
      this.#end({ type: 'closed' })
      return
    }
    this.#offs.push(
      this.#bridge.onEvent((frame) => {
        if (frame.kind === 'closed' && frame.tabId === this.#tabId) this.#end({ type: 'closed' })
      }),
      this.#bridge.onHostChange((next) => {
        if (next?.connectionEpoch !== host.connectionEpoch) this.#end({ type: 'closed' })
      }),
    )
    try {
      const client = await Cdp.connect(host.debugPort, async () => null)
      this.#client = client
      if (this.#closed) {
        client.close()
        return
      }
      client.onDisconnect(() => this.#end({ type: 'closed' }))
      this.#session = await client.attachViewer(tab.marker)
      this.#offs.push(client.onSessionEvent(this.#session, (e) => this.#onEvent(e)))
      await client.send('Page.enable', {}, { sessionId: this.#session })
      // 不支持拦截时网页的文件对话框照常在电脑上打开，查看本身不受影响。
      await client
        .send('Page.setInterceptFileChooserDialog', { enabled: true }, { sessionId: this.#session })
        .catch(() => {})
      await this.#apply()
    } catch (err) {
      log.warn(
        'browser',
        `远程查看无法附加页面：${err instanceof Error ? err.message : String(err)}`,
        {
          tabId: this.#tabId,
        },
      )
      this.#end({ type: 'error' })
    }
  }

  /** 客户端的一条消息。无法解析或无法执行的输入不回报：画面本身反映输入的结果。 */
  input(raw: string): void {
    let msg: BrowserViewInput
    try {
      msg = JSON.parse(raw) as BrowserViewInput
    } catch {
      return
    }
    if (msg.type === 'size') {
      const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
      this.#viewport =
        msg.width > 0 && msg.height > 0
          ? {
              width: Math.round(clamp(msg.width, 64, 4096)),
              height: Math.round(clamp(msg.height, 64, 4096)),
              scale: clamp(msg.scale, 1, MAX_SCALE),
            }
          : null
      this.#quality = Math.round(clamp(msg.quality ?? FRAME_QUALITY, 30, 95))
      if (this.#client && this.#session && !this.#closed) void this.#apply().catch(() => {})
      return
    }
    if (msg.type === 'ack') {
      this.#inflight = Math.max(0, this.#inflight - 1)
      if (this.#heldFrame !== null) {
        const id = this.#heldFrame
        this.#heldFrame = null
        this.#command('Page.screencastFrameAck', { sessionId: id })
      }
      for (const resume of this.#ackWaiters.splice(0)) resume()
      return
    }
    this.#captureIdle = CAPTURE_MIN_MS
    this.#queue = this.#queue
      .then(() => this.#handle(msg))
      .catch(() => {})
      .then(() => this.#wake?.())
  }

  /** 连接已关闭。 */
  close(): void {
    this.#closed = true
    if (this.#cursorTimer) clearTimeout(this.#cursorTimer)
    for (const off of this.#offs.splice(0)) off()
    for (const resume of this.#ackWaiters.splice(0)) resume()
    this.#wake?.()
    const client = this.#client
    this.#client = null
    if (!client) return
    const session = this.#session
    void Promise.all([
      client.send('Page.stopScreencast', {}, { sessionId: session, teardown: 'detach' }),
      client.send(
        'Emulation.clearDeviceMetricsOverride',
        {},
        { sessionId: session, teardown: 'detach' },
      ),
    ])
      .catch(() => {})
      .finally(() => client.close())
  }

  /** 发出一条命令，不等待结果；连接未附加或已关闭时忽略。 */
  #command(method: string, params: Record<string, unknown>): void {
    const client = this.#client
    if (!client || !this.#session || this.#closed) return
    void client.send(method, params, { sessionId: this.#session }).catch(() => {})
  }

  async #handle(msg: Exclude<BrowserViewInput, { type: 'size' | 'ack' }>): Promise<void> {
    const client = this.#client
    const session = this.#session
    if (!client || !session || this.#closed) return
    switch (msg.type) {
      case 'mouse': {
        if (msg.action === 'down' && msg.button === 'left') {
          const found = await findControl(client, session, msg.x, msg.y)
          if (found) {
            this.#settleControl()
            this.#control = { id: ++this.#nextId, objectId: found.objectId }
            this.#swallowUp = true
            this.#notify({ ...found.prompt, id: this.#control.id })
            return
          }
        }
        if (msg.action === 'up' && this.#swallowUp) {
          this.#swallowUp = false
          return
        }
        if (msg.action === 'move') this.#pointAt(msg.x, msg.y)
        if (msg.action === 'up') void this.#readSelection()
        const bit = BUTTON_BITS[msg.button] ?? 0
        if (msg.action === 'down') this.#buttons |= bit
        if (msg.action === 'up') this.#buttons &= ~bit
        this.#command('Input.dispatchMouseEvent', {
          type:
            msg.action === 'down'
              ? 'mousePressed'
              : msg.action === 'up'
                ? 'mouseReleased'
                : 'mouseMoved',
          x: msg.x,
          y: msg.y,
          button: msg.action === 'move' ? 'none' : msg.button,
          buttons: this.#buttons,
          clickCount: msg.action === 'move' ? 0 : (msg.clickCount ?? 1),
        })
        return
      }
      case 'wheel':
        this.#command('Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: msg.x,
          y: msg.y,
          deltaX: msg.dx,
          deltaY: msg.dy,
        })
        return
      case 'key': {
        const fields = keyEvent(msg.code, msg.held)
        if (!fields) return
        const base = {
          key: fields.key,
          code: fields.code,
          windowsVirtualKeyCode: fields.keyCode,
          nativeVirtualKeyCode: fields.keyCode,
          modifiers: fields.modifiers,
        }
        this.#command('Input.dispatchKeyEvent', {
          ...base,
          type: fields.text === undefined ? 'rawKeyDown' : 'keyDown',
          ...(fields.text === undefined ? {} : { text: fields.text, unmodifiedText: fields.text }),
        })
        this.#command('Input.dispatchKeyEvent', { ...base, type: 'keyUp' })
        void this.#readSelection()
        return
      }
      case 'text':
        if (msg.text) this.#command('Input.insertText', { text: msg.text })
        return
      case 'answer': {
        const control = this.#control
        if (!control || control.id !== msg.id) return
        if (msg.value !== null) {
          await applyControl(client, session, control.objectId, msg.value).catch(() => {})
        }
        this.#settleControl()
        return
      }
      case 'dialog':
        if (client.dialogOf(session)) {
          await client.handleDialog(session, msg.accept, msg.text).catch(() => {})
        }
        return
      case 'files': {
        const chooser = this.#chooser
        if (!chooser || chooser.id !== msg.id) return
        this.#chooser = null
        const files = msg.uploads
          .map((id) => uploadPath(this.#tabId, id))
          .filter((path): path is string => path !== null)
        if (files.length === 0) return
        this.#command('DOM.setFileInputFiles', {
          files: chooser.multiple ? files : files.slice(0, 1),
          backendNodeId: chooser.backendNodeId,
        })
        return
      }
    }
  }

  /** 结束在途的代选控件并释放其引用。 */
  #settleControl(): void {
    const control = this.#control
    this.#control = null
    if (control) this.#command('Runtime.releaseObject', { objectId: control.objectId })
  }

  /**
   * 按客户端的显示区域设定页面视口，并按它（重新）开始推送画面；显示区域未知或不可见（`size` 为 0）时停止推送。
   * 不在收到显示区域之前推送：此前的画面是电脑上的尺寸，随后被替换，显示为一次跳变。
   */
  async #apply(): Promise<void> {
    const client = this.#client
    if (!client || !this.#session) return
    const view = this.#viewport
    await client.send('Page.stopScreencast', {}, { sessionId: this.#session })
    this.#inflight = 0
    this.#heldFrame = null
    if (!view) return
    await client.send(
      'Emulation.setDeviceMetricsOverride',
      {
        width: view.width,
        height: view.height,
        deviceScaleFactor: view.scale,
        // 不按移动端排版：没有 viewport 声明的网页会按 980 像素宽排版再整体缩小，输入坐标的单位随之与画面不同。
        // 按客户端的实际宽度排版时，自适应的网页与在手机浏览器中相同。
        mobile: false,
      },
      { sessionId: this.#session },
    )
    await client.send(
      'Page.startScreencast',
      {
        format: 'jpeg',
        quality: this.#quality,
        maxWidth: Math.round(view.width * view.scale),
        maxHeight: Math.round(view.height * view.scale),
        everyNthFrame: 1,
      },
      { sessionId: this.#session },
    )
  }

  #onEvent(event: CdpEvent): void {
    if (this.#closed) return
    switch (event.method) {
      case 'Page.frameNavigated': {
        const frame = event.params.frame as { parentId?: string } | undefined
        if (frame?.parentId) return
        // 主框架跨进程导航后，浏览器按窗口尺寸推送画面，元数据与仍然生效的视口设定不一致，输入坐标随之错位：
        // 每次主框架导航后重新设定视口并重新开始推送。
        if (this.#viewport) void this.#apply().catch(() => {})
        // 导航后原页面的控件与文件输入框已不存在，客户端收起对应的弹出层。
        if (this.#control || this.#chooser) {
          this.#settleControl()
          this.#chooser = null
          this.#notify({ type: 'dismiss' })
        }
        return
      }
      case 'Page.javascriptDialogOpening': {
        const p = event.params as { type?: string; message?: string; defaultPrompt?: string }
        this.#notify({
          type: 'dialog',
          kind: DIALOG_KINDS.find((k) => k === p.type) ?? 'alert',
          message: String(p.message ?? ''),
          defaultPrompt: String(p.defaultPrompt ?? ''),
        })
        return
      }
      case 'Page.javascriptDialogClosed':
        this.#notify({ type: 'dismiss' })
        return
      case 'Page.fileChooserOpened': {
        const p = event.params as { backendNodeId?: number; mode?: string }
        const node = Number(p.backendNodeId)
        if (!Number.isFinite(node)) return
        const chooser = {
          id: ++this.#nextId,
          backendNodeId: node,
          multiple: p.mode === 'selectMultiple',
        }
        this.#chooser = chooser
        void this.#acceptOf(node).then((accept) => {
          if (this.#chooser === chooser) {
            this.#notify({ type: 'files', id: chooser.id, multiple: chooser.multiple, accept })
          }
        })
        return
      }
      case 'Page.screencastFrame':
        this.#frame(event)
        return
      case 'Page.screencastVisibilityChanged':
        this.#hidden = event.params.visible !== true
        if (this.#hidden) void this.#captureLoop()
        return
    }
  }

  /** 页面不可见期间以截图取帧，在途帧数与 screencast 相同；与上一帧相同的截图不发送。 */
  async #captureLoop(): Promise<void> {
    if (this.#capturing) return
    this.#capturing = true
    let last = ''
    try {
      while (this.#hidden && !this.#closed) {
        const client = this.#client
        const view = this.#viewport
        if (!client || !view) return
        if (this.#inflight >= BROWSER_VIEW_INFLIGHT) {
          await new Promise<void>((resume) => this.#ackWaiters.push(resume))
          continue
        }
        const shot = await client
          .send<{ data: string }>(
            'Page.captureScreenshot',
            { format: 'jpeg', quality: this.#quality },
            { sessionId: this.#session },
          )
          .catch(() => null)
        if (shot && shot.data !== last && this.#hidden && !this.#closed) {
          last = shot.data
          this.#captureIdle = CAPTURE_MIN_MS
          this.#push(shot.data, { width: view.width, height: view.height })
          this.#inflight += 1
        } else {
          this.#captureIdle = Math.min(this.#captureIdle * 2, CAPTURE_MAX_MS)
        }
        await new Promise<void>((resume) => {
          const timer = setTimeout(resume, this.#captureIdle)
          this.#wake = () => {
            clearTimeout(timer)
            resume()
          }
        })
        this.#wake = null
      }
    } finally {
      this.#capturing = false
    }
  }

  /** 读取选中的文字，与上次发送的不同时发给客户端。页面正在导航等读取失败的情况不发送。 */
  async #readSelection(): Promise<void> {
    const client = this.#client
    if (!client) return
    const read = await client
      .send<{ result: { value?: unknown } }>(
        'Runtime.evaluate',
        { expression: SELECTION, returnByValue: true },
        { sessionId: this.#session },
      )
      .catch(() => null)
    const value = read?.result.value
    if (typeof value !== 'string') return
    const text = value.slice(0, MAX_SELECTION)
    if (text === this.#selection) return
    this.#selection = text
    this.#notify({ type: 'selection', text })
  }

  /** 记录鼠标位置；不在间隔内时立即读取指针样式，否则在间隔结束时按最后的位置读取。 */
  #pointAt(x: number, y: number): void {
    this.#pointer = { x, y }
    if (this.#cursorTimer) return
    void this.#readCursor()
    this.#cursorTimer = setTimeout(() => {
      this.#cursorTimer = null
      if (this.#pointer) void this.#readCursor()
    }, CURSOR_MS)
  }

  async #readCursor(): Promise<void> {
    const client = this.#client
    const at = this.#pointer
    this.#pointer = null
    if (!client || !at || !Number.isFinite(at.x) || !Number.isFinite(at.y)) return
    const read = await client
      .send<{ result: { value?: unknown } }>(
        'Runtime.evaluate',
        {
          expression: `(() => { const el = document.elementFromPoint(${at.x}, ${at.y}); return el ? getComputedStyle(el).cursor : '' })()`,
          returnByValue: true,
        },
        { sessionId: this.#session },
      )
      .catch(() => null)
    const cursor = read?.result.value
    if (typeof cursor !== 'string' || cursor === this.#cursor) return
    this.#cursor = cursor
    this.#notify({ type: 'cursor', cursor })
  }

  /** 文件输入框的 `accept` 属性；无法读取时为空串（不限类型）。 */
  async #acceptOf(backendNodeId: number): Promise<string> {
    const client = this.#client
    const sessionId = this.#session
    if (!client) return ''
    try {
      const { object } = await client.send<{ object: { objectId?: string } }>(
        'DOM.resolveNode',
        { backendNodeId },
        { sessionId },
      )
      if (!object.objectId) return ''
      const read = await client.send<{ result: { value?: unknown } }>(
        'Runtime.callFunctionOn',
        {
          objectId: object.objectId,
          functionDeclaration: 'function () { return this.accept || "" }',
          returnByValue: true,
        },
        { sessionId },
      )
      void client
        .send('Runtime.releaseObject', { objectId: object.objectId }, { sessionId })
        .catch(() => {})
      return typeof read.result.value === 'string' ? read.result.value : ''
    } catch {
      return ''
    }
  }

  #frame(event: CdpEvent): void {
    const params = event.params as {
      data: string
      sessionId: number
      metadata: { deviceWidth: number; deviceHeight: number }
    }
    this.#push(params.data, {
      width: params.metadata.deviceWidth,
      height: params.metadata.deviceHeight,
    })
    this.#inflight += 1
    if (this.#inflight < BROWSER_VIEW_INFLIGHT) {
      this.#command('Page.screencastFrameAck', { sessionId: params.sessionId })
    } else {
      this.#heldFrame = params.sessionId
    }
  }

  /** 发出一帧：元数据与 JPEG（base64）按协议拼成一条二进制消息。 */
  #push(data: string, meta: BrowserViewFrame): void {
    const head = new TextEncoder().encode(JSON.stringify(meta))
    const jpeg = Buffer.from(data, 'base64')
    const message = new Uint8Array(4 + head.length + jpeg.length)
    new DataView(message.buffer).setUint32(0, head.length)
    message.set(head, 4)
    message.set(jpeg, 4 + head.length)
    this.#ws.send(message)
  }

  #notify(notice: BrowserViewNotice): void {
    if (!this.#closed) this.#ws.send(JSON.stringify(notice))
  }

  #end(notice: BrowserViewNotice): void {
    if (this.#closed) return
    this.#ws.send(JSON.stringify(notice))
    this.#ws.close(1000, notice.type)
    this.close()
  }
}
