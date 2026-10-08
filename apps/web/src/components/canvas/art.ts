/**
 * Art 页面在画布中的运行。iframe 加载 sidecar 的引导页（`/art/host`），界面读取页面 HTML、在最前面注入运行时
 * 与 importmap 后经 `postMessage` 交给引导页写入。实时页面、封面、截图与录制都经由 `connectArt` 返回的句柄。
 *
 * - iframe 必须带 `sandbox="allow-scripts"`：页面是模型写出的代码，不能访问界面的存储与 DOM，也不能使窗口跳转。
 * - 隐藏的页面（封面）用 `visibility: hidden` 放在视口内：放在视口外或被 `clip-path` 裁掉时，
 *   读取其中的 WebGL 画面会使渲染进程崩溃。
 * - 页面时钟由运行时接管（`artRuntime`）：手动模式下按界面给出的时刻逐帧推进，录制的帧率因此与机器快慢无关。
 */

import { ART_DEFAULT_SIZE, artViewportOf, type CanvasPixels, insertAfterHead } from '@qywork/core'
import { client } from '../../lib/store/index.ts'
import { FPS, mp4Output, outputSize } from './render.ts'

/** 运行时的选项：`lib` 是库文件目录的地址，`manual` 为真时页面时钟从 0 开始、只由界面推进（封面）。 */
interface RuntimeOptions {
  lib: string
  manual: boolean
}

/**
 * 页面中的运行时。以源码形式注入页面，在页面自己的脚本之前执行，因此只能使用参数与页面的全局对象，
 * 不要引用本模块中的任何名称。
 *
 * - WebGL 上下文强制 `preserveDrawingBuffer`：截图在页面绘制之后的另一个任务中读取画布。
 * - 接管 `requestAnimationFrame`、`performance.now`、`Date.now` 与 CSS 动画：实时模式下随真实时间推进，
 *   手动模式下停在进入时的时刻，`frame` 消息给出相对该时刻的毫秒数，推进后截取一帧。
 * - 截图用 modern-screenshot 把整个视口栅格化：WebGL 画面与页面上的 DOM 叠加内容都在其中。
 */
function artRuntime(opts: RuntimeOptions): void {
  type Message = { type: 'qywork-art'; op: string; id?: number; at?: number; on?: boolean }
  const post = (msg: Record<string, unknown>, transfer: Transferable[] = []) =>
    parent.postMessage({ type: 'qywork-art', ...msg }, '*', transfer)
  const text = (e: unknown) => String((e as { message?: unknown } | null)?.message ?? e)
  window.addEventListener('error', (e: ErrorEvent) =>
    post({ op: 'error', message: text(e.error ?? e.message) }),
  )
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) =>
    post({ op: 'error', message: text(e.reason) }),
  )

  const proto = HTMLCanvasElement.prototype as unknown as {
    getContext(kind: string, attrs?: Record<string, unknown>): unknown
  }
  const getContext = proto.getContext
  proto.getContext = function (this: HTMLCanvasElement, kind, attrs) {
    const gl = kind === 'webgl' || kind === 'webgl2' || kind === 'experimental-webgl'
    return getContext.call(this, kind, gl ? { ...attrs, preserveDrawingBuffer: true } : attrs)
  }

  const realFrame = requestAnimationFrame.bind(window)
  const realNow = performance.now.bind(performance)
  const wall = Date.now() - realNow()
  let manual = opts.manual
  /** 手动模式下的页面时刻；实时模式下页面时刻为 `realNow() - offset`。 */
  let clock = 0
  let offset = realNow()
  /** 进入手动模式时的页面时刻，`frame` 消息的时刻相对它计算。 */
  let base = 0
  const now = () => (manual ? clock : realNow() - offset)
  const queue = new Map<number, FrameRequestCallback>()
  let seq = 0
  window.requestAnimationFrame = (cb) => {
    seq += 1
    queue.set(seq, cb)
    return seq
  }
  window.cancelAnimationFrame = (id) => {
    queue.delete(id)
  }
  performance.now = now
  Date.now = () => Math.floor(wall + offset + now())
  const flush = (t: number) => {
    clock = t
    const list = [...queue.values()]
    queue.clear()
    for (const cb of list) {
      try {
        cb(t)
      } catch (e) {
        post({ op: 'error', message: text(e) })
      }
    }
  }
  const tick = () => {
    if (!manual) flush(realNow() - offset)
    realFrame(tick)
  }
  realFrame(tick)

  /** CSS 动画在手动模式下暂停，进度按页面时刻设定；首次见到时按其当前进度推算起点。 */
  const born = new WeakMap<Animation, number>()
  const seek = (t: number) => {
    for (const a of document.getAnimations()) {
      if (!born.has(a)) born.set(a, t - Number(a.currentTime ?? 0))
      a.pause()
      a.currentTime = t - (born.get(a) ?? t)
    }
  }
  const step = (t: number) => {
    flush(t)
    seek(t)
  }
  const setManual = (on: boolean) => {
    if (on === manual) return
    if (on) {
      clock = now()
      manual = true
      seek(clock)
    } else {
      offset = realNow() - clock
      manual = false
      for (const a of document.getAnimations()) a.play()
    }
    base = clock
  }

  /** 视口的底色：根元素透明时取 body 的背景色（CSS 的背景传播），都透明时为白色，与页面实际显示一致。 */
  const background = () => {
    const clear = (c: string) => c === 'transparent' || /^rgba\(.*,\s*0\)$/.test(c)
    const root = getComputedStyle(document.documentElement).backgroundColor
    if (!clear(root)) return root
    const body = document.body ? getComputedStyle(document.body).backgroundColor : 'transparent'
    return clear(body) ? '#ffffff' : body
  }
  /** modern-screenshot 中用到的部分。 */
  type Shooter = {
    createContext(node: Node, options: Record<string, unknown>): Promise<{ sandbox?: Element }>
    domToCanvas(context: unknown): Promise<HTMLCanvasElement>
    destroyContext(context: unknown): void
  }
  // 经 Function 构造动态导入：本函数以源码注入页面，打包工具改写 `import()` 时会引用本模块中的辅助函数。
  const load = new Function('url', 'return import(url)') as (url: string) => Promise<Shooter>
  let shooter: Promise<Shooter> | null = null
  const capture = async () => {
    shooter ??= load(`${opts.lib}modern-screenshot.js`)
    const ms = await shooter
    const context = await ms.createContext(document.documentElement, {
      width: innerWidth,
      height: innerHeight,
      scale: 1,
      backgroundColor: background(),
    })
    // 不挂载的 iframe 没有 contentWindow，库按「没有缺省样式」处理，计算样式全部内联。不要省略：
    // 库的缺省做法是挂载一个 srcdoc iframe 读取缺省样式，它在沙箱中是另一个不透明源，读取即抛错。
    context.sandbox = document.createElement('iframe')
    try {
      return await createImageBitmap(await ms.domToCanvas(context))
    } finally {
      ms.destroyContext(context)
    }
  }

  addEventListener('message', async (e: MessageEvent<Message>) => {
    if (e.source !== parent || e.data?.type !== 'qywork-art') return
    const m = e.data
    if (m.op === 'manual') setManual(!!m.on)
    if (m.op === 'step' && manual && m.at !== undefined) step(base + m.at)
    if (m.op !== 'frame') return
    try {
      if (manual && m.at !== undefined) step(base + m.at)
      const bitmap = await capture()
      post({ op: 'frame', id: m.id, bitmap }, [bitmap])
    } catch (err) {
      post({ op: 'frame', id: m.id, error: text(err) })
    }
  })
  // 不要改为等下一个动画帧：不可见的跨源 iframe（封面）中动画帧暂停，加载完成永远不会报告。
  addEventListener('load', () => setTimeout(() => post({ op: 'ready' })))
}

/** sidecar 的地址：桌面端页面来自外壳的资源协议，引导页与库文件必须由 sidecar 提供（见 `server/src/art.ts`）。 */
const hostUrl = () => `${client.base}/art/host`
const libUrl = () => `${client.base}/art/lib/`

/** 在页面最前面注入运行时与 importmap。importmap 必须位于页面自己的模块脚本之前。 */
export function prepareArt(html: string, opts: RuntimeOptions): string {
  const imports = { three: `${opts.lib}three.module.js`, 'three/addons/': `${opts.lib}addons/` }
  return insertAfterHead(
    html,
    `<script>(${artRuntime.toString()})(${JSON.stringify(opts)})</script>` +
      `<script type="importmap">${JSON.stringify({ imports })}</script>`,
  )
}

/** 页面的视口：取自 viewport 标签，没有时为缺省尺寸。 */
export function artSizeOfHtml(html: string): CanvasPixels {
  return artViewportOf(html) ?? ART_DEFAULT_SIZE
}

/** 与一个 art 页面通信的句柄。 */
export interface ArtHandle {
  /** 页面加载完成（`load` 之后）时兑现；加载超时时拒绝。 */
  ready: Promise<void>
  /** 进入或退出手动模式。 */
  manual(on: boolean): void
  /** 手动模式下把页面时钟推进到 `at`（相对进入手动模式时刻的毫秒数），不截取。 */
  step(at: number): void
  /** 截取一帧。`at` 为相对进入手动模式时刻的毫秒数，只在手动模式下推进页面时钟。 */
  capture(at?: number): Promise<ImageBitmap>
  /** 停止监听；iframe 由调用方移除。 */
  dispose(): void
}

/** 页面加载的时限：超过即视为失败，封面显示失败图标。 */
const LOAD_MS = 15_000

/**
 * 把 `html` 放入 `frame` 运行。`frame` 必须已带 `sandbox="allow-scripts"` 并已挂载；此处设置地址并处理消息。
 * 页面脚本的错误经 `onError` 报告。
 */
export function connectArt(
  frame: HTMLIFrameElement,
  html: string,
  opts: { manual: boolean; onError?: (message: string) => void },
): ArtHandle {
  const waiters = new Map<number, { resolve(b: ImageBitmap): void; reject(e: Error): void }>()
  let seq = 0
  let loaded!: () => void
  let failed!: (e: Error) => void
  const ready = new Promise<void>((resolve, reject) => {
    loaded = resolve
    failed = reject
  })
  const timer = setTimeout(() => failed(new Error('页面加载超时')), LOAD_MS)
  const send = (msg: Record<string, unknown>) =>
    frame.contentWindow?.postMessage({ type: 'qywork-art', ...msg }, '*')
  const onMessage = (e: MessageEvent) => {
    if (e.source !== frame.contentWindow || !e.data || typeof e.data !== 'object') return
    const d = e.data as {
      type?: string
      op?: string
      id?: number
      message?: string
      bitmap?: ImageBitmap
      error?: string
    }
    if (d.type === 'qywork-art-host') {
      const page = prepareArt(html, { lib: libUrl(), manual: opts.manual })
      frame.contentWindow?.postMessage({ type: 'qywork-art-load', html: page }, '*')
      return
    }
    if (d.type !== 'qywork-art') return
    if (d.op === 'ready') {
      clearTimeout(timer)
      loaded()
    }
    if (d.op === 'error' && d.message) opts.onError?.(d.message)
    if (d.op === 'frame' && d.id !== undefined) {
      const w = waiters.get(d.id)
      waiters.delete(d.id)
      if (d.bitmap) w?.resolve(d.bitmap)
      else w?.reject(new Error(d.error ?? '截取失败'))
    }
  }
  addEventListener('message', onMessage)
  frame.src = hostUrl()
  return {
    ready,
    manual: (on) => send({ op: 'manual', on }),
    step: (at) => send({ op: 'step', at }),
    capture: (at) =>
      new Promise<ImageBitmap>((resolve, reject) => {
        seq += 1
        waiters.set(seq, { resolve, reject })
        send({ op: 'frame', id: seq, ...(at === undefined ? {} : { at }) })
      }),
    dispose: () => {
      clearTimeout(timer)
      removeEventListener('message', onMessage)
      for (const w of waiters.values()) w.reject(new Error('页面已关闭'))
      waiters.clear()
    },
  }
}

/** 位图编码为 PNG。 */
export async function pngOf(bitmap: ImageBitmap): Promise<Blob> {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvas.convertToBlob({ type: 'image/png' })
}

/** 封面所取的页面时刻（毫秒）：常见的入场动画在此之前已有画面。 */
const POSTER_AT = 500

/**
 * 已生成的封面（PNG）与其所依据的页面内容，按页面地址缓存。生成卡的版本文件写出后不再修改；
 * 放上画布的 HTML 文件可能被改写，实时页面读到不同内容时经 `dropStalePoster` 丢弃。
 */
const posters = new Map<string, { html?: string; png: Promise<Blob> }>()

/** 实时页面读到的内容与封面所依据的不同时丢弃该封面，下次显示封面时重新生成。 */
export function dropStalePoster(url: string, html: string): void {
  const hit = posters.get(url)
  if (hit?.html !== undefined && hit.html !== html) posters.delete(url)
}

/**
 * 页面的封面：在隐藏的 iframe 中从 0 开始逐帧推进到 `POSTER_AT`，截取后关闭。页面脚本报错或加载超时时拒绝。
 */
export function artPoster(url: string): Promise<Blob> {
  const hit = posters.get(url)
  if (hit) return hit.png
  const entry: { html?: string; png: Promise<Blob> } = {
    png: renderPoster(url, (html) => {
      entry.html = html
    }),
  }
  posters.set(url, entry)
  return entry.png
}

/** 生成一张封面。读到页面内容后经 `onSource` 交出，供缓存比对。 */
async function renderPoster(url: string, onSource: (html: string) => void): Promise<Blob> {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok) throw new Error(`页面读取失败：${res.status}`)
  const html = await res.text()
  onSource(html)
  const size = artSizeOfHtml(html)
  const frame = document.createElement('iframe')
  frame.setAttribute('sandbox', 'allow-scripts')
  frame.width = String(size.w)
  frame.height = String(size.h)
  frame.style.cssText =
    'position:fixed;left:0;top:0;border:0;visibility:hidden;pointer-events:none;z-index:-1'
  document.body.append(frame)
  const errors: string[] = []
  const art = connectArt(frame, html, { manual: true, onError: (m) => errors.push(m) })
  try {
    await art.ready
    // 逐帧推进：页面按帧累积状态（物理、阻尼）时一次跳到终点与实际显示不同。消息按发送顺序处理。
    for (let t = 0; t < POSTER_AT; t += 1000 / FPS) art.step(t)
    const bitmap = await art.capture(POSTER_AT)
    if (errors.length) {
      bitmap.close()
      throw new Error(errors[0])
    }
    return await pngOf(bitmap)
  } finally {
    art.dispose()
    frame.remove()
  }
}

/**
 * 录制：从页面当前的状态起逐帧推进 `seconds` 秒（30 帧/秒），编码为 mp4，字节按块交给 `write`（同时间线导出）。
 * 期间页面停在手动模式，结束或失败后恢复实时。`signal` 中止时抛出 `AbortError`。
 */
export async function recordArt(
  art: ArtHandle,
  size: CanvasPixels,
  seconds: number,
  onProgress: (ratio: number) => void,
  signal: AbortSignal,
  write: (bytes: Uint8Array<ArrayBuffer>, at: number) => Promise<void>,
): Promise<void> {
  const mb = await import('mediabunny')
  const { width, height } = outputSize(size.w, size.h)
  const frames = Math.round(seconds * FPS)
  const { output, video, ctx } = mp4Output(mb, width, height, frames, write)
  await output.start()
  art.manual(true)
  try {
    for (let i = 0; i < frames; i++) {
      if (signal.aborted) throw new DOMException('录制已取消', 'AbortError')
      const bitmap = await art.capture((i * 1000) / FPS)
      ctx.drawImage(bitmap, 0, 0, width, height)
      bitmap.close()
      await video.add(i / FPS, 1 / FPS)
      onProgress((i + 1) / frames)
    }
    await output.finalize()
  } catch (err) {
    await output.cancel().catch(() => {})
    throw err
  } finally {
    art.manual(false)
  }
}
