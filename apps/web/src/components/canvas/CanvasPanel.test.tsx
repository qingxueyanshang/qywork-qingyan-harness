/**
 * 覆盖 `canvas/CanvasPanel.tsx`、`canvas/GeneratePanel.tsx`、`canvas/SourcePicker.tsx`、`canvas/search.ts`、
 * `canvas/Rail.tsx`、`canvas/Bitmap.tsx`、`canvas/Player.tsx`、`canvas/Timeline.tsx`、`canvas/prompt.ts` 与 `canvas/frame.ts` 的纯函数，
 * 以及 `lib/store/ui.ts` 的 `openCanvasTab`。
 *
 * 服务端由内存中的一份画布模拟：`client.api` 的桩按路径分派，操作经 core 的 `applyCanvasOps` 应用，
 * 每次提交的操作都被记录，断言针对发送了哪几批操作。
 */

import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { CanvasDoc, CanvasOp, CanvasView } from '@qywork/core'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  // happy-dom 不提供这两个 API，真实 WebView 中均有提供。尺寸由 `resize` 手动报告。
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private readonly callback: () => void) {}
    observe(el: Element) {
      observed.set(el, this.callback)
    }
    disconnect() {}
  }
  HTMLElement.prototype.setPointerCapture = () => {}
  // 图片由 Bitmap 自行获取文件；测试中一律获取失败，进入解码失败分支。
  globalThis.fetch = ((url: string) => {
    fetched.push(String(url))
    return Promise.reject(new Error('测试里不取文件'))
  }) as unknown as typeof fetch
})

const observed = new Map<Element, () => void>()
/** Bitmap 发出的文件请求，按请求顺序记录地址。 */
const fetched: string[] = []

/** 为画布区设定测得的尺寸：happy-dom 不进行布局，`clientWidth` 恒为 0。 */
function resize(el: HTMLElement, width: number, height: number) {
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: height })
  observed.get(el)?.()
}

let dispose: (() => void) | undefined
let restore: (() => void) | undefined

afterEach(async () => {
  dispose?.()
  dispose = undefined
  restore?.()
  restore = undefined
  document.body.replaceChildren()
  const store = await import('../../lib/store/index.ts')
  store.setState({ fileVersion: 0, canvasVersion: 0 })
  // 视口、选中与草稿在挂载之间保留（刷新恢复），每条用例从未记录的状态开始。
  const { flushSession } = await import('../../lib/session.ts')
  flushSession()
  sessionStorage.clear()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function waitFor(done: () => boolean, detail: () => string) {
  for (let i = 0; i < 200; i += 1) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`界面没有在时限内更新：${detail()}`)
}

const MODELS = {
  providers: [],
  library: [],
  mediaLibrary: [],
  media: [
    {
      provider: 'qwen',
      id: 'wan3.0-video',
      kind: 'dashscope_videos',
      output: 'video',
      label: '万相 3.0 视频',
      operations: ['text_to_video', 'image_to_video', 'first_last_frame', 'reference_to_video'],
      isDefault: true,
      known: true,
      params: [
        {
          name: 'ratio',
          label: '宽高比',
          type: 'enum',
          values: ['adaptive', '16:9', '9:16'],
          default: 'adaptive',
        },
        {
          name: 'resolution',
          label: '分辨率',
          type: 'enum',
          values: ['1080P', '720P'],
          default: '1080P',
        },
        {
          name: 'duration',
          label: '时长',
          type: 'integer',
          min: 2,
          max: 30,
          auto: -1,
          default: 5,
        },
      ],
    },
    {
      provider: 'qwen',
      id: 'qwen-image-3.0',
      kind: 'dashscope_images',
      output: 'image',
      label: '千问图像 3.0',
      operations: ['generate', 'edit'],
      isDefault: true,
      known: true,
      params: [
        {
          name: 'size',
          label: '尺寸',
          type: 'string',
          shapes: [
            {},
            { ratio: '16:9', tier: '1K', value: '1360*768' },
            { ratio: '1:1', tier: '1K', value: '1024*1024' },
            { ratio: '16:9', tier: '2K', value: '2720*1536' },
            { ratio: '1:1', tier: '2K', value: '2048*2048' },
          ],
        },
        { name: 'n', label: '张数', type: 'integer', min: 1, max: 4, default: 1 },
      ],
    },
  ],
}

interface Server {
  ops: CanvasOp[][]
  runs: { nodeId: string; ops: CanvasOp[] }[]
  reads: number
  doc: () => CanvasDoc
  setView(next: Partial<CanvasView>): void
  broken: boolean
  quote: { cost: number; currency: string } | null
  /** 上传请求的查询字符串，按请求顺序记录。 */
  uploads: URLSearchParams[]
  /** 撤销与重做请求，按请求顺序记录。 */
  restores: { from: string; to: string }[]
  /** 时间线导出会话的请求，按请求顺序记录：开始、写入、完成、放弃。 */
  exports: string[]
  /** 停止请求的节点 id，按请求顺序记录；返回结果取 `cancelOutcome`。 */
  cancels: string[]
  cancelOutcome: 'cancelled' | 'started' | 'unsupported' | 'ended'
  /** 设置时，编辑的响应体先按收到请求时的画布计算，等该 Promise 兑现后才返回：模拟响应晚于其后的重新读取到达。 */
  hold: Promise<void> | null
}

async function mount(
  seed: CanvasOp[],
  states: CanvasView['states'] = {},
  catalog: unknown = MODELS,
): Promise<{ host: HTMLElement; server: Server; refs: Record<string, string> }> {
  const core = await import('@qywork/core')
  const store = await import('../../lib/store/index.ts')
  let n = 0
  const ids = () => `n${++n}`
  const seeded = core.applyCanvasOps(core.emptyCanvas(), seed, ids)
  if (!seeded.ok) throw new Error(seeded.error)
  let doc = seeded.doc
  let extraStates = states
  let written = 0
  let fingerprint = 'd0'
  const snapshots = new Map<string, CanvasDoc>([['d0', doc]])
  const view = (): CanvasView => ({ path: 'board.canvas.json', doc, states: extraStates })
  const server: Server = {
    hold: null,
    cancels: [],
    cancelOutcome: 'started',
    ops: [],
    runs: [],
    reads: 0,
    doc: () => doc,
    setView(next) {
      if (next.doc) {
        doc = next.doc
        // 外部修改：文档被替换，指纹随之变化，撤销应被拒绝。
        fingerprint = `x${++written}`
      }
      if (next.states) extraStates = next.states
    },
    broken: false,
    quote: null,
    uploads: [],
    restores: [],
    exports: [],
  }
  const original = store.client.api
  ;(
    store.client as unknown as { api: (path: string, init?: RequestInit) => Promise<unknown> }
  ).api = async (path: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (path.startsWith('/api/models')) return catalog
    if (path.startsWith('/api/canvas?')) {
      server.reads += 1
      if (server.broken) {
        const { ApiError } = await import('../../lib/client.ts')
        throw new ApiError(
          422,
          path,
          '{"error":"invalid","message":"画布文件格式错误：不是合法的 JSON"}',
        )
      }
      return view()
    }
    if (path.startsWith('/api/canvas/ops')) {
      server.ops.push(body.ops)
      const r = core.applyCanvasOps(doc, body.ops, ids)
      if (!r.ok) {
        const { ApiError } = await import('../../lib/client.ts')
        throw new ApiError(422, path, JSON.stringify({ error: 'invalid', message: r.error }))
      }
      // 与服务端约定相同：每次写入文件时记录修改前后两份文档的指纹。
      const before = fingerprint
      doc = r.doc
      fingerprint = `d${++written}`
      snapshots.set(fingerprint, doc)
      const reply = { ...view(), refs: r.refs, step: { before, after: fingerprint } }
      if (server.hold) await server.hold
      return reply
    }
    if (path.startsWith('/api/canvas/restore')) {
      server.restores.push({ from: body.from, to: body.to })
      if (body.from !== fingerprint || !snapshots.has(body.to)) {
        const { ApiError } = await import('../../lib/client.ts')
        throw new ApiError(
          409,
          path,
          '{"error":"conflict","message":"画布在此之后已被修改，无法撤销"}',
        )
      }
      doc = snapshots.get(body.to)!
      fingerprint = body.to
      return { ...view(), refs: {}, step: { before: body.from, after: body.to } }
    }
    if (path.startsWith('/api/canvas/cancel')) {
      server.cancels.push(body.nodeId)
      return { outcome: server.cancelOutcome }
    }
    if (path.startsWith('/api/canvas/run')) {
      server.runs.push({ nodeId: body.nodeId, ops: body.ops ?? [] })
      if (body.ops) {
        const r = core.applyCanvasOps(doc, body.ops, ids)
        if (r.ok) doc = r.doc
      }
      return view()
    }
    if (path.startsWith('/api/canvas/quote')) return { quote: server.quote }
    if (path.startsWith('/api/files/find')) {
      const params = new URLSearchParams(path.split('?')[1])
      const q = params.get('q')
      if (q === '坏') {
        const { ApiError } = await import('../../lib/client.ts')
        throw new ApiError(500, path, '{"error":"internal","message":"磁盘读不了"}')
      }
      // 与服务端相同：带 `kinds` 时只返回这几类文件，查询可以为空。
      const kinds = params.get('kinds')
      const wanted = kinds === null ? null : new Set(kinds.split(','))
      const all = [
        { path: '角色/小满.png', kind: 'file' },
        { path: '角色', kind: 'dir' },
        { path: '合同.pdf', kind: 'file' },
        { path: '镜头/雨夜.mp4', kind: 'file' },
      ]
      return {
        matches: all.filter(
          (m) =>
            (wanted ? m.kind === 'file' && wanted.has(core.canvasFileKind(m.path) ?? '') : !!q) &&
            (!q || m.path.includes(q)),
        ),
        truncated: false,
      }
    }
    if (path.startsWith('/api/canvas/upload')) {
      // 与服务端行为相同：保存到 uploads/ 并添加节点。
      const q = new URLSearchParams(path.split('?')[1])
      server.uploads.push(q)
      const file = `uploads/${q.get('name')}`
      const beside = q.get('beside')
      const r = core.applyCanvasOps(
        doc,
        [
          {
            op: 'add_file',
            ref: '$u',
            path: file,
            ...(beside ? { beside } : { near: { x: Number(q.get('x')), y: Number(q.get('y')) } }),
          },
        ],
        ids,
      )
      if (!r.ok) throw new Error(r.error)
      doc = r.doc
      return { nodeId: r.refs.$u, path: file }
    }
    if (path.startsWith('/api/canvas/export/')) {
      server.exports.push(path.split('?')[0]!.slice('/api/canvas/export/'.length))
      if (path.startsWith('/api/canvas/export/start')) return { upload: 'u1' }
      if (path.startsWith('/api/canvas/export/abort')) return { ok: true }
      throw new Error('测试里不落盘')
    }
    throw new Error(`没有桩这条：${path}`)
  }
  restore = () => {
    ;(store.client as unknown as { api: typeof original }).api = original
  }
  // 模型目录在模块中只获取一次；同一进程中先运行的测试文件可能已获取过其他目录。
  await store.reloadModelCatalog()
  const { render } = await import('solid-js/web')
  const { default: CanvasPanel } = await import('./CanvasPanel.tsx')
  const host = document.createElement('div')
  host.style.width = '1000px'
  host.style.height = '700px'
  document.body.append(host)
  dispose = render(() => <CanvasPanel path="board.canvas.json" active />, host)
  await waitFor(
    () => host.querySelectorAll('[data-node]').length === doc.nodes.length && doc.nodes.length > 0,
    () => host.innerHTML.slice(0, 300),
  )
  return { host, server, refs: seeded.refs }
}

/** 当前视口缩放（`--z`）。屏幕上的位移除以该值才是画布坐标中的位移。 */
function zoom(host: HTMLElement): number {
  return Number(host.querySelector<HTMLElement>('.canvas-stage')!.style.getPropertyValue('--z'))
}

function node(host: HTMLElement, id: string): HTMLElement {
  const el = host.querySelector<HTMLElement>(`[data-node="${id}"]`)
  if (!el) throw new Error(`没有节点 ${id}`)
  return el
}

function pointer(el: Element, type: string, x: number, y: number, extra: PointerEventInit = {}) {
  el.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      clientX: x,
      clientY: y,
      button: 0,
      pointerId: 1,
      ...extra,
    }),
  )
}

/** 一张图片与一张视频生成卡。 */
const CARD: CanvasOp[] = [
  { op: 'add_file', ref: '$a', path: 'a.png', name: '小满', x: 0, y: 0 },
  { op: 'add_generate', ref: '$v', output: 'video', x: 300, y: 0 },
]

const FILES: CanvasOp[] = [
  { op: 'add_file', ref: '$a', path: 'a.png', name: '小满', x: 0, y: 0 },
  { op: 'add_file', ref: '$b', path: 'b.png', name: '妈妈', x: 300, y: 0 },
]

describe('画布：节点操作', () => {
  test('无法获取图片时节点中显示图片图标', async () => {
    const { host } = await mount(FILES)
    await waitFor(
      () => host.querySelectorAll('.canvas-bitmap-failed').length === 2,
      () => host.innerHTML.slice(0, 400),
    )
  })

  test('首次适配等待画布区测得尺寸，测得后全部节点位于画布区内', async () => {
    const { host, server } = await mount(FILES)
    const stage = host.querySelector<HTMLElement>('.canvas-stage')!
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(zoom(host)).toBe(1)
    resize(stage, 380, 800)
    await waitFor(
      () => zoom(host) !== 1,
      () => String(zoom(host)),
    )
    const px = Number.parseFloat(stage.style.getPropertyValue('--px'))
    for (const n of server.doc().nodes) {
      expect(px + n.x * zoom(host)).toBeGreaterThanOrEqual(0)
      expect(px + (n.x + n.w) * zoom(host)).toBeLessThanOrEqual(380)
    }
  })

  test('视频节点未选中时只绘制封面，选中后才挂载播放器，使用自有控件而非浏览器自带控件', async () => {
    const { host, refs } = await mount([
      { op: 'add_file', ref: '$v', path: 'clip.mp4', x: 0, y: 0 },
    ])
    const video = node(host, refs.$v!)
    expect(video.querySelector('video')).toBeNull()
    expect(video.querySelector('canvas.canvas-bitmap')).not.toBeNull()
    pointer(video, 'pointerdown', 10, 10)
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
    await waitFor(
      () => !!video.querySelector('video') && !!video.querySelector('.canvas-player'),
      () => video.innerHTML,
    )
    expect(video.querySelector('video')!.hasAttribute('controls')).toBe(false)
  })

  test('音频控件读取时长、同步播放进度与静音，操作进度时不拖动节点', async () => {
    const { host, refs, server } = await mount([{ op: 'add_file', ref: '$a', path: 'voice.wav' }])
    const card = node(host, refs.$a!)
    const audio = card.querySelector('audio')!
    const track = card.querySelector<HTMLInputElement>('input[aria-label="音频进度"]')!
    expect(card.style.width).toBe('300px')
    expect(card.style.height).toBe('96px')
    expect(audio.hasAttribute('controls')).toBe(false)
    expect(track.disabled).toBe(true)
    Object.defineProperty(audio, 'duration', { configurable: true, value: 125 })
    audio.dispatchEvent(new Event('loadedmetadata'))
    expect(track.disabled).toBe(false)
    expect(card.querySelector('.canvas-audio-time')!.textContent).toBe('00:0002:05')
    audio.currentTime = 12
    audio.dispatchEvent(new Event('timeupdate'))
    expect(track.value).toBe('12')
    audio.dispatchEvent(new Event('play'))
    expect(card.querySelector('button[aria-label="暂停"]')).not.toBeNull()
    audio.dispatchEvent(new Event('pause'))
    expect(card.querySelector('button[aria-label="播放"]')).not.toBeNull()

    const stage = host.querySelector('.canvas-stage')!
    pointer(track, 'pointerdown', 30, 30)
    track.value = '62'
    track.dispatchEvent(new Event('input', { bubbles: true }))
    pointer(stage, 'pointermove', 100, 30)
    pointer(stage, 'pointerup', 100, 30)
    expect(audio.currentTime).toBe(62)
    expect(server.ops).toEqual([])
    card.querySelector<HTMLButtonElement>('button[aria-label="静音"]')!.click()
    expect(audio.muted).toBe(true)
    card.querySelector<HTMLButtonElement>('button[aria-label="开启声音"]')!.click()
    expect(audio.muted).toBe(false)
    audio.dispatchEvent(new Event('ended'))
    expect(track.value).toBe('125')
    expect(card.querySelector('button[aria-label="播放"]')).not.toBeNull()
    audio.dispatchEvent(new Event('error'))
    expect(card.querySelector('output')!.textContent).toBe('无法播放，请重试')
  })

  test('更换音频来源时释放旧播放器，进度和失败状态随来源重置', async () => {
    const { host, refs, server } = await mount([{ op: 'add_file', ref: '$a', path: 'old.wav' }])
    const card = node(host, refs.$a!)
    const before = card.querySelector('audio')!
    const pause = spyOn(before, 'pause')
    before.currentTime = 18
    before.dispatchEvent(new Event('timeupdate'))
    before.dispatchEvent(new Event('error'))
    const core = await import('@qywork/core')
    const next = core.applyCanvasOps(server.doc(), [
      { op: 'update', id: refs.$a!, path: 'new.wav' },
    ])
    if (!next.ok) throw new Error(next.error)
    server.setView({ doc: next.doc })
    const store = await import('../../lib/store/index.ts')
    store.setState('fileVersion', 1)
    await waitFor(
      () => card.querySelector('audio') !== before,
      () => card.innerHTML,
    )
    expect(pause).toHaveBeenCalled()
    expect(before.hasAttribute('src')).toBe(false)
    expect(card.querySelector<HTMLInputElement>('input')!.value).toBe('0')
    expect(card.querySelector('output')!.textContent).toBe('音频')
    pause.mockRestore()
  })

  test('切换选中节点后沿用静音设置', async () => {
    const { host, refs } = await mount([
      { op: 'add_file', ref: '$v', path: 'clip.mp4', x: 0, y: 0 },
      { op: 'add_file', ref: '$w', path: 'other.mp4', x: 400, y: 0 },
    ])
    const stage = host.querySelector('.canvas-stage')!
    const select = async (id: string) => {
      pointer(node(host, id), 'pointerdown', 10, 10)
      pointer(stage, 'pointerup', 10, 10)
      await waitFor(
        () => !!node(host, id).querySelector('video'),
        () => node(host, id).innerHTML,
      )
      return node(host, id).querySelector('video')!
    }
    expect((await select(refs.$v!)).muted).toBe(false)
    node(host, refs.$v!).querySelector<HTMLButtonElement>('button[aria-label="静音"]')!.click()
    expect(node(host, refs.$v!).querySelector('video')!.muted).toBe(true)
    expect((await select(refs.$w!)).muted).toBe(true)
    expect((await select(refs.$v!)).muted).toBe(true)
    node(host, refs.$v!).querySelector<HTMLButtonElement>('button[aria-label="开启声音"]')!.click()
    expect((await select(refs.$w!)).muted).toBe(false)
  })

  test('取帧打开取帧条并占据工具条的位置；拖动时刻定位播放器；Esc 关闭', async () => {
    const { host, refs } = await mount([
      { op: 'add_file', ref: '$v', path: 'clip.mp4', x: 0, y: 0 },
    ])
    pointer(node(host, refs.$v!), 'pointerdown', 10, 10)
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
    await waitFor(
      () => !!host.querySelector('.canvas-tools button'),
      () => host.innerHTML.slice(0, 300),
    )
    const video = node(host, refs.$v!).querySelector('video')!
    Object.defineProperty(video, 'duration', { configurable: true, value: 5 })
    video.dispatchEvent(new Event('loadedmetadata'))
    host.querySelector<HTMLButtonElement>('.canvas-tools button')!.click()
    await waitFor(
      () => !!host.querySelector('.canvas-frame-bar'),
      () => host.innerHTML.slice(0, 300),
    )
    expect(host.querySelector('.canvas-tools')).toBeNull()
    const bar = host.querySelector('.canvas-frame-bar')!
    const time = bar.querySelector<HTMLInputElement>('input[aria-label="时刻"]')!
    time.value = '5'
    time.dispatchEvent(new Event('input', { bubbles: true }))
    expect(video.currentTime).toBeCloseTo(5 - 1 / 30, 6)
    expect(bar.querySelector('.canvas-frame-row span')!.textContent).toBe('00:05.0 / 00:05')
    expect(bar.querySelector<HTMLButtonElement>('.canvas-frame-take')!.disabled).toBe(false)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(
      () => !host.querySelector('.canvas-frame-bar') && !!host.querySelector('.canvas-tools'),
      () => host.innerHTML.slice(0, 300),
    )
  })

  test('修改一个节点不会使任何图片重新获取文件', async () => {
    const { host, server, refs } = await mount(FILES)
    await waitFor(
      () => host.querySelectorAll('.canvas-bitmap-failed').length === 2,
      () => host.innerHTML.slice(0, 300),
    )
    const before = fetched.length
    const stage = host.querySelector('.canvas-stage')!
    pointer(node(host, refs.$a!), 'pointerdown', 10, 10)
    pointer(stage, 'pointermove', 110, 60)
    pointer(stage, 'pointerup', 110, 60)
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(fetched.slice(before)).toEqual([])
  })

  test('修改一个节点后其余节点的元素保持不变，不重建', async () => {
    const { host, server, refs } = await mount(FILES)
    const other = node(host, refs.$b!)
    const stage = host.querySelector('.canvas-stage')!
    pointer(node(host, refs.$a!), 'pointerdown', 10, 10)
    pointer(stage, 'pointermove', 110, 60)
    pointer(stage, 'pointerup', 110, 60)
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(node(host, refs.$b!)).toBe(other)
  })

  test('拖动只在松开指针时提交一次位置', async () => {
    const { host, server, refs } = await mount(FILES)
    const stage = host.querySelector('.canvas-stage')!
    pointer(node(host, refs.$a!), 'pointerdown', 10, 10)
    pointer(stage, 'pointermove', 30, 20)
    pointer(stage, 'pointermove', 60, 40)
    pointer(stage, 'pointermove', 110, 60)
    expect(server.ops).toHaveLength(0)
    pointer(stage, 'pointerup', 110, 60)
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([
      {
        op: 'update',
        id: refs.$a!,
        x: Math.round(100 / zoom(host)),
        y: Math.round(50 / zoom(host)),
      },
    ])
  })

  test('拖动时向其余节点的边对齐：相距数个像素内时吸附并绘制对齐线，松开指针时提交对齐后的位置', async () => {
    const { host, server, refs } = await mount(FILES)
    const stage = host.querySelector('.canvas-stage')!
    const z = zoom(host)
    // $b 原与 $a 顶边齐平；横向移动 120、向下移动 3 个屏幕像素后仍在吸附范围内，吸附回顶边。
    pointer(node(host, refs.$b!), 'pointerdown', 10, 10)
    pointer(stage, 'pointermove', 10 + 120 * z, 13)
    expect(host.querySelectorAll('.canvas-guide').length).toBe(1)
    pointer(stage, 'pointerup', 10 + 120 * z, 13)
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([{ op: 'update', id: refs.$b!, x: 420, y: 0 }])
    expect(host.querySelector('.canvas-guide')).toBeNull()
  })

  test('编辑的响应晚于其后的重新读取到达：不覆盖重新读取取得的更新状态', async () => {
    const { host, server, refs } = await mount(FILES)
    const store = await import('../../lib/store/index.ts')
    const stage = host.querySelector('.canvas-stage')!
    let release = () => {}
    server.hold = new Promise((r) => {
      release = r
    })
    pointer(node(host, refs.$a!), 'pointerdown', 10, 10)
    pointer(stage, 'pointermove', 210, 110)
    pointer(stage, 'pointerup', 210, 110)
    await waitFor(
      () => server.ops.length === 1,
      () => '',
    )
    // 编辑发出之后，其他位置的修改引起一次重新读取：$b 的文件已被删除。
    server.setView({ states: { [refs.$b!]: { state: 'missing' } } })
    store.setState('canvasVersion', (n) => n + 1)
    await waitFor(
      () => node(host, refs.$b!).textContent?.includes('缺失') === true,
      () => node(host, refs.$b!).innerHTML,
    )
    release()
    await new Promise((r) => setTimeout(r, 30))
    expect(node(host, refs.$b!).textContent).toContain('缺失')
  })

  test('拖动中因文件变更重新读取时，被拖动的节点不跳回原位', async () => {
    const { host, server, refs } = await mount(FILES)
    const store = await import('../../lib/store/index.ts')
    const stage = host.querySelector('.canvas-stage')!
    pointer(node(host, refs.$a!), 'pointerdown', 10, 10)
    pointer(stage, 'pointermove', 210, 110)
    const reads = server.reads
    store.setState('fileVersion', 1)
    await waitFor(
      () => server.reads > reads,
      () => `reads=${server.reads}`,
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(Number.parseFloat(node(host, refs.$a!).style.left)).toBeCloseTo(200 / zoom(host), 3)
    pointer(stage, 'pointerup', 210, 110)
    await waitFor(
      () => server.ops.length === 1,
      () => '',
    )
    await waitFor(
      () => node(host, refs.$a!).style.left === `${Math.round(200 / zoom(host))}px`,
      () => node(host, refs.$a!).style.left,
    )
  })

  test('框选后按 Delete 发送一批删除操作', async () => {
    const { host, server, refs } = await mount(FILES)
    const stage = host.querySelector('.canvas-stage')!
    // 测试中视口没有尺寸：fit 把初始平移计算为 (w/2, h/2) 以外的值，因此直接按屏幕坐标框选两个节点。
    pointer(stage, 'pointerdown', -5000, -5000, { shiftKey: true })
    pointer(stage, 'pointermove', 5000, 5000, { shiftKey: true })
    pointer(stage, 'pointerup', 5000, 5000)
    await waitFor(
      () => host.querySelectorAll('.canvas-node.selected').length === 2,
      () => '',
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await waitFor(
      () => server.ops.length === 1,
      () => '',
    )
    expect(server.ops[0]).toEqual([
      { op: 'remove', id: refs.$a! },
      { op: 'remove', id: refs.$b! },
    ])
  })

  test('从文件树拖入时添加一个文件节点；拖放到缺失节点上即替换路径', async () => {
    const { host, server, refs } = await mount(FILES, { n2: { state: 'missing' } })
    const store = await import('../../lib/store/index.ts')
    const stage = host.querySelector('.canvas-stage')!
    const drop = (target: Element, path: string) => {
      const ev = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperties(ev, {
        dataTransfer: {
          value: {
            types: [store.WORKSPACE_PATH_TYPE],
            getData: (type: string) => (type === store.WORKSPACE_PATH_TYPE ? path : ''),
          },
        },
        clientX: { value: 400 },
        clientY: { value: 300 },
      })
      target.dispatchEvent(ev)
    }
    drop(stage, 'c.png')
    await waitFor(
      () => server.ops.length === 1,
      () => '',
    )
    expect(server.ops[0]![0]).toMatchObject({ op: 'add_file', path: 'c.png' })
    drop(node(host, refs.$b!), 'b2.png')
    await waitFor(
      () => server.ops.length === 2,
      () => '',
    )
    expect(server.ops[1]).toEqual([{ op: 'update', id: refs.$b!, path: 'b2.png' }])
  })

  test('双击标题重命名', async () => {
    const { host, server, refs } = await mount(FILES)
    const title = node(host, refs.$a!).querySelector('.canvas-node-title')!
    title.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await waitFor(
      () => !!title.querySelector('input'),
      () => title.innerHTML,
    )
    const input = title.querySelector('input')!
    input.value = '小满（校服）'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await waitFor(
      () => server.ops.length === 1,
      () => '',
    )
    expect(server.ops[0]).toEqual([{ op: 'update', id: refs.$a!, name: '小满（校服）' }])
  })

  test('文件快照或画布事件序号变化时重新读取', async () => {
    const { server } = await mount(FILES)
    const store = await import('../../lib/store/index.ts')
    const before = server.reads
    store.setState('canvasVersion', 1)
    await waitFor(
      () => server.reads === before + 1,
      () => `reads=${server.reads}`,
    )
    store.setState('fileVersion', 1)
    await waitFor(
      () => server.reads === before + 2,
      () => `reads=${server.reads}`,
    )
  })

  test('画布文件损坏时显示原文，按 Delete 不发送任何写操作', async () => {
    const { host, server, refs } = await mount(FILES)
    const store = await import('../../lib/store/index.ts')
    pointer(node(host, refs.$a!), 'pointerdown', 10, 10)
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
    server.broken = true
    store.setState('fileVersion', 1)
    await waitFor(
      () => host.textContent?.includes('画布文件格式错误') === true,
      () => host.textContent ?? '',
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }))
    await new Promise((r) => setTimeout(r, 30))
    expect(server.ops).toHaveLength(0)
  })
})

describe('画布：生成卡与生成面板', () => {
  const select = async (host: HTMLElement, id: string) => {
    pointer(node(host, id), 'pointerdown', 10, 10)
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
    await waitFor(
      () => !!host.querySelector('.canvas-panel'),
      () => host.innerHTML.slice(0, 200),
    )
  }

  test('选中生成卡时显示面板，取消选中时关闭；两档高度都是固定值', async () => {
    const { host, refs } = await mount(CARD)
    await select(host, refs.$v!)
    const panel = host.querySelector<HTMLElement>('.canvas-panel')!
    expect(panel.classList.contains('tall')).toBe(false)
    panel.querySelector<HTMLButtonElement>('.canvas-panel-expand')!.click()
    await waitFor(
      () => panel.classList.contains('tall'),
      () => panel.className,
    )
    pointer(host.querySelector('.canvas-stage')!, 'pointerdown', 900, 650)
    await waitFor(
      () => !host.querySelector('.canvas-panel'),
      () => '',
    )
  })

  test('画布区比面板窄时面板宽度缩小到画布区宽度', async () => {
    const { host, refs } = await mount(CARD)
    resize(host.querySelector<HTMLElement>('.canvas-stage')!, 380, 800)
    await select(host, refs.$v!)
    const panel = host.querySelector<HTMLElement>('.canvas-panel')!
    expect(panel.style.width).toBe('364px')
  })

  test('面板只按节点定位：节点靠近画布区底边时面板仍位于节点下方，不向画布区内收回而遮挡节点', async () => {
    const { host, server, refs } = await mount(CARD)
    const stage = host.querySelector<HTMLElement>('.canvas-stage')!
    resize(stage, 1000, 300)
    await waitFor(
      () => zoom(host) !== 1,
      () => String(zoom(host)),
    )
    await select(host, refs.$v!)
    const n = server.doc().nodes.find((x) => x.id === refs.$v)!
    const z = zoom(host)
    const px = Number.parseFloat(stage.style.getPropertyValue('--px'))
    const py = Number.parseFloat(stage.style.getPropertyValue('--py'))
    const panel = host.querySelector<HTMLElement>('.canvas-panel')!
    const bottom = py + (n.y + n.h) * z
    // 面板（180）放在节点下方时超出画布区底边。
    expect(bottom + 16 + 180).toBeGreaterThan(300 - 8)
    expect(Number.parseFloat(panel.style.top)).toBeCloseTo(bottom + 16, 3)
    expect(Number.parseFloat(panel.style.left)).toBeCloseTo(px + (n.x + n.w / 2) * z - 240, 3)
  })

  test('画布上的菜单挂载在文档根节点，不在画布区的层叠上下文中', async () => {
    const { host, refs } = await mount(CARD)
    pointer(node(host, refs.$v!), 'pointerdown', 10, 10, { button: 2 })
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10, { button: 2 })
    await waitFor(
      () => !!document.querySelector('.canvas-context-menu'),
      () => document.body.innerHTML.slice(0, 300),
    )
    expect(document.querySelector('.canvas-context-menu')!.closest('.canvas-stage')).toBeNull()
  })

  test('流向运行中卡片的连线用内联样式绘制渐变，其余连线不使用渐变', async () => {
    const { host } = await mount(
      [...CARD, { op: 'connect', from: '$a', to: '$v', role: 'reference' }],
      { n2: { state: 'running', startedAt: Date.now() } },
    )
    const live = host.querySelector<SVGPathElement>('.canvas-edges path.live')!
    const id = /url\("?#([^)"]+)"?\)/.exec(live.style.stroke)?.[1]
    expect(id).toBeDefined()
    expect(host.querySelector(`linearGradient#${id}`)).not.toBeNull()
    expect(live.getAttribute('stroke')).toBeNull()
  })

  test('选中节点时其连线持续显示同一渐变，其余连线不使用渐变', async () => {
    const { host, refs } = await mount([
      ...CARD,
      { op: 'add_file', ref: '$b', path: 'b.png', x: 0, y: 300 },
      { op: 'connect', from: '$a', to: '$v', role: 'reference' },
      { op: 'connect', from: '$b', to: '$v', role: 'reference' },
    ])
    expect(host.querySelector('.canvas-edges path.hot')).toBeNull()
    pointer(node(host, refs.$a!), 'pointerdown', 10, 10)
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
    await waitFor(
      () => host.querySelectorAll('.canvas-edges path.hot').length === 1,
      () => host.querySelector('.canvas-edges')!.innerHTML,
    )
    const hot = host.querySelector<SVGPathElement>('.canvas-edges path.hot')!
    const id = /url\("?#([^)"]+)"?\)/.exec(hot.style.stroke)?.[1]
    expect(host.querySelector(`linearGradient#${id}`)).not.toBeNull()
  })

  test('加载后的第一帧即显示阶段与计时；阶段变化只更新文字，不插入布局行', async () => {
    const { host, server, refs } = await mount(
      [
        ...CARD,
        { op: 'add_generate', ref: '$w', output: 'video', x: 600, y: 0 },
        { op: 'add_generate', ref: '$g', output: 'image', x: 900, y: 0 },
      ],
      {
        n2: { state: 'running', startedAt: Date.now(), phase: 'queued' },
        n3: { state: 'running', startedAt: Date.now() },
        n4: { state: 'running', startedAt: Date.now() },
      },
    )
    expect(node(host, refs.$v!).querySelector('.canvas-live .phase')?.textContent).toBe('排队中')
    const live = node(host, refs.$w!).querySelector('.canvas-live')!
    const phase = live.querySelector('.phase')!
    const snake = live.querySelector('.canvas-snake')!
    expect(phase.textContent).toBe('排队中')
    expect(live.querySelector('.time')?.textContent).toBe('00:00')
    expect(node(host, refs.$g!).querySelector('.canvas-live .phase')?.textContent).toBe('生成中')
    server.setView({
      states: { n3: { state: 'running', startedAt: Date.now(), phase: 'running' } },
    })
    const store = await import('../../lib/store/index.ts')
    store.setState('canvasVersion', 1)
    await waitFor(
      () => phase.textContent === '生成中',
      () => live.textContent ?? '',
    )
    expect(live.querySelector('.phase')).toBe(phase)
    expect(live.querySelector('.canvas-snake')).toBe(snake)
    expect(live.children).toHaveLength(3)
  })

  test('开始运行时立即刷新计时，连续的状态刷新不推迟下一次计时', async () => {
    let time = Date.now()
    const date = spyOn(Date, 'now').mockImplementation(() => time)
    try {
      const { host, server, refs } = await mount(CARD)
      const store = await import('../../lib/store/index.ts')
      time += 60_000
      const startedAt = time - 23_000
      server.setView({ states: { n2: { state: 'running', startedAt } } })
      store.setState('canvasVersion', 1)
      const elapsed = () => node(host, refs.$v!).querySelector('.canvas-live .time')?.textContent
      await waitFor(
        () => elapsed() === '00:23',
        () => elapsed() ?? '',
      )
      time += 4_000
      for (let i = 0; i < 7; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        server.setView({ states: { n2: { state: 'running', startedAt } } })
        store.setState('canvasVersion', (v) => v + 1)
      }
      expect(elapsed()).toBe('00:27')
    } finally {
      date.mockRestore()
    }
  })

  test('生成中发送键变为停止键：点击后发送停止请求；远端无法撤回时底部说明照常计费', async () => {
    const { host, server, refs } = await mount(CARD, {
      n2: { state: 'running', startedAt: Date.now() },
    })
    await select(host, refs.$v!)
    const stop = host.querySelector<HTMLButtonElement>('.canvas-panel .send-btn')!
    expect(stop.getAttribute('aria-label')).toBe('停止')
    stop.click()
    await waitFor(
      () => host.querySelector('.canvas-fault')?.textContent?.includes('照常计费') === true,
      () => host.querySelector('.canvas-fault')?.textContent ?? '',
    )
    expect(server.cancels).toEqual([refs.$v!])
  })

  test('参数按钮只列出标有界面名称的参数；模式只列出模型支持的模式，切换到首尾帧时发送一条 set_mode', async () => {
    const { host, server, refs } = await mount([
      ...CARD,
      { op: 'connect', from: '$a', to: '$v', role: 'reference' },
    ])
    await select(host, refs.$v!)
    await waitFor(
      () => (host.querySelector('.canvas-bar')?.textContent ?? '').includes('1080P'),
      () => host.querySelector('.canvas-bar')?.textContent ?? '',
    )
    const bar = host.querySelector('.canvas-bar')!
    expect(bar.textContent).toContain('5 秒')
    const modeChip = [...bar.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('参考'),
    )!
    modeChip.click()
    await waitFor(
      () => !!document.querySelector('.canvas-bar-menu'),
      () => '',
    )
    const items = [...document.querySelectorAll('.canvas-bar-menu button')].map(
      (b) => b.textContent,
    )
    expect(items).toEqual(['参考', '首尾帧'])
    ;[...document.querySelectorAll<HTMLButtonElement>('.canvas-bar-menu button')]
      .find((b) => b.textContent === '首尾帧')!
      .click()
    await waitFor(
      () => server.ops.length === 1,
      () => '',
    )
    expect(server.ops[0]).toEqual([{ op: 'set_mode', id: refs.$v!, mode: 'first_last' }])
  })

  test('参数合并为一个按钮：面板分节，点选即提交且不关闭；按 Esc 或再次点击按钮时关闭', async () => {
    const { host, server, refs } = await mount(CARD)
    await select(host, refs.$v!)
    const chip = () => host.querySelector<HTMLButtonElement>('.canvas-bar .mode-chip.params')
    const panel = () => document.querySelector('.canvas-params-panel')
    await waitFor(
      () => chip()?.textContent === '自动宽高比 · 1080P · 5 秒',
      () => host.querySelector('.canvas-bar')?.textContent ?? '',
    )
    chip()!.click()
    await waitFor(
      () => !!panel(),
      () => '',
    )
    // Esc 只关闭参数面板，生成面板与选中状态保留。
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(
      () => !panel(),
      () => '',
    )
    expect(host.querySelector('.canvas-panel')).not.toBeNull()
    chip()!.click()
    await waitFor(
      () => !!panel(),
      () => '',
    )
    expect(
      [...panel()!.querySelectorAll('.canvas-params-title')].map((t) => t.textContent),
    ).toEqual(['宽高比', '分辨率', '时长'])
    const cells = (i: number) => [
      ...[...panel()!.querySelectorAll('.canvas-params-section')][i]!.querySelectorAll<HTMLElement>(
        '.canvas-seg > button',
      ),
    ]
    // 宽高比选项上绘制图形：自动为带角标的方框，比例值按比例绘制；分辨率不绘制。
    expect(cells(0).map((b) => b.textContent)).toEqual(['自动', '16:9', '9:16'])
    expect(cells(0)[0]!.querySelector('.canvas-shape-auto')).not.toBeNull()
    expect(cells(0)[1]!.querySelector<HTMLElement>('.canvas-shape')!.style.width).toBe('14px')
    expect(cells(0)[2]!.querySelector<HTMLElement>('.canvas-shape')!.style.height).toBe('14px')
    expect(cells(1).map((b) => b.textContent)).toEqual(['1080P', '720P'])
    expect(cells(1)[0]!.getAttribute('aria-checked')).toBe('true')
    expect(cells(1)[0]!.querySelector('.canvas-shape, .canvas-shape-auto')).toBeNull()
    cells(1)[1]!.click()
    await waitFor(
      () => server.ops.length === 1,
      () => '',
    )
    expect(server.ops[0]).toEqual([{ op: 'update', id: refs.$v!, params: { resolution: '720P' } }])
    await waitFor(
      () => chip()?.textContent === '自动宽高比 · 720P · 5 秒',
      () => chip()?.textContent ?? '',
    )
    // 面板不关闭；再次点击按钮时关闭。
    expect(panel()).not.toBeNull()
    chip()!.click()
    await waitFor(
      () => !panel(),
      () => '',
    )
  })

  test('选择 16:9、4K、最高质量、四张后，生成使用全部选择', async () => {
    const catalog = {
      ...MODELS,
      media: [
        {
          provider: 'test',
          id: 'gpt-image-2.5-sunburst',
          kind: 'openai_images',
          output: 'image',
          label: 'GPT Image 2.5 Sunburst',
          operations: ['generate', 'edit'],
          isDefault: true,
          known: true,
          params: [
            {
              name: 'size',
              label: '尺寸',
              type: 'string',
              default: 'auto',
              shapes: [
                { value: 'auto' },
                { ratio: '16:9', tier: '1K', value: '1360x768' },
                { ratio: '16:9', tier: '4K', value: '3840x2160' },
              ],
            },
            {
              name: 'quality',
              label: '生成质量',
              type: 'enum',
              default: 'auto',
              values: ['auto', 'max'],
              valueLabels: { auto: '自动', max: '最高' },
            },
            { name: 'n', label: '张数', type: 'integer', min: 1, max: 10, default: 1 },
          ],
        },
      ],
    }
    const { host, server, refs } = await mount(
      [{ op: 'add_generate', ref: '$g', output: 'image', prompt: '海报' }],
      {},
      catalog,
    )
    await select(host, refs.$g!)
    host.querySelector<HTMLButtonElement>('.canvas-bar .mode-chip.params')!.click()
    await waitFor(
      () => !!document.querySelector('.canvas-params-panel'),
      () => '',
    )
    const values: [string, string, string | number][] = [
      ['16:9', 'size', '1360x768'],
      ['4K', 'size', '3840x2160'],
      ['最高', 'quality', 'max'],
      ['4', 'n', 4],
    ]
    for (const [label, key, value] of values) {
      const button = [
        ...document.querySelectorAll<HTMLButtonElement>('.canvas-params-panel button'),
      ].find((b) => b.textContent === label)!
      button.click()
      await waitFor(
        () => {
          const n = server.doc().nodes.find((n) => n.id === refs.$g)
          return (
            n?.type === 'generate' &&
            n.params[key] === value &&
            button.getAttribute('aria-checked') === 'true'
          )
        },
        () => JSON.stringify(server.ops),
      )
    }
    host.querySelector<HTMLButtonElement>('.canvas-panel .send-btn')!.click()
    await waitFor(
      () => server.runs.length === 1,
      () => JSON.stringify(server.runs),
    )
    const n = server.doc().nodes.find((n) => n.id === refs.$g)
    expect(n?.type === 'generate' && n.params).toEqual({ size: '3840x2160', quality: 'max', n: 4 })
    expect(server.runs[0]?.nodeId).toBe(refs.$g!)
    expect(server.runs[0]?.ops).toEqual([])
  })

  test('质量的中文选项发送原生值；更多设置默认不发送，恢复默认后清除，切换模型时保留选择', async () => {
    const catalog = {
      ...MODELS,
      media: [
        {
          provider: 'test',
          id: 'gpt-image-2.5-sunburst',
          kind: 'openai_images',
          output: 'image',
          label: 'GPT Image 2.5 Sunburst',
          operations: ['generate', 'edit'],
          isDefault: true,
          known: true,
          params: [
            {
              name: 'quality',
              label: '生成质量',
              type: 'enum',
              values: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
              valueLabels: { low: '低', medium: '中', high: '高', xhigh: '超高', max: '最高' },
              default: 'auto',
            },
            {
              name: 'output_format',
              label: '输出格式',
              type: 'enum',
              values: ['png', 'jpeg', 'webp'],
              default: 'png',
              advanced: true,
            },
            {
              name: 'background',
              label: '背景',
              type: 'enum',
              values: ['transparent', 'opaque', 'auto'],
              valueLabels: { transparent: '透明', opaque: '不透明', auto: '自动' },
              default: 'auto',
              advanced: true,
            },
          ],
        },
        {
          provider: 'test',
          id: 'qwen-image-3.0',
          kind: 'dashscope_images',
          output: 'image',
          label: '千问图像 3.0',
          operations: ['generate', 'edit'],
          isDefault: false,
          known: true,
          params: [
            {
              name: 'seed',
              label: '随机种子',
              type: 'integer',
              min: 0,
              max: 2147483647,
              advanced: true,
            },
            {
              name: 'negative_prompt',
              label: '排除内容',
              type: 'string',
              maxLength: 500,
              advanced: true,
            },
          ],
        },
      ],
    }
    const { host, server, refs } = await mount(
      [{ op: 'add_generate', ref: '$i', output: 'image', prompt: '猫' }],
      {},
      catalog,
    )
    await select(host, refs.$i!)
    const paramsButton = () =>
      host.querySelector<HTMLButtonElement>('.canvas-bar .mode-chip.params')!
    await waitFor(
      () => !!paramsButton(),
      () => host.textContent ?? '',
    )
    paramsButton().click()
    await waitFor(
      () => !!document.querySelector('.canvas-params-panel'),
      () => '',
    )
    const choice = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('.canvas-params-panel button')].find(
        (b) => b.textContent === text,
      )!
    const advanced = () => document.querySelector<HTMLDetailsElement>('.canvas-params-advanced')!
    const openPanel = document.querySelector<HTMLElement>('.canvas-params-panel')!
    const canvasStyle = host.querySelector<HTMLElement>('.canvas-stage')!.style.cssText
    expect(advanced().open).toBe(false)
    advanced().open = true
    expect(advanced().querySelector('summary')?.textContent).toBe('更多设置')
    const format = document.querySelector<HTMLSelectElement>('select[aria-label="输出格式"]')!
    expect(format.selectedOptions[0]!.textContent).toBe('默认（PNG）')
    expect(server.ops).toHaveLength(0)
    const background = () => document.querySelector<HTMLSelectElement>('select[aria-label="背景"]')!
    const backgroundControl = background()
    backgroundControl.focus()
    background().value = JSON.stringify('opaque')
    background().dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor(
      () =>
        (server.doc().nodes[0] as { params: Record<string, unknown> }).params.background ===
        'opaque',
      () => '',
    )
    expect(background() === backgroundControl).toBe(true)
    expect(document.activeElement === backgroundControl).toBe(true)
    expect(document.querySelector('.canvas-params-panel') === openPanel).toBe(true)
    expect(advanced().open).toBe(true)
    expect(host.querySelector<HTMLElement>('.canvas-stage')!.style.cssText).toBe(canvasStyle)
    const store = await import('../../lib/store/index.ts')
    const beforeRead = server.reads
    store.setState('canvasVersion', (v) => v + 1)
    await waitFor(
      () => server.reads > beforeRead,
      () => '',
    )
    expect(background() === backgroundControl).toBe(true)
    expect(document.activeElement === backgroundControl).toBe(true)
    expect(document.querySelector('[aria-label^="重置"]')).toBeNull()
    background().value = ''
    background().dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor(
      () =>
        (server.doc().nodes[0] as { params: Record<string, unknown> }).params.background ===
        undefined,
      () => '',
    )
    const qualityControl = choice('最高')
    qualityControl.focus()
    qualityControl.click()
    await waitFor(
      () => paramsButton().textContent?.includes('生成质量最高') === true,
      () => paramsButton().textContent ?? '',
    )
    expect(choice('最高') === qualityControl).toBe(true)
    expect(document.activeElement === qualityControl).toBe(true)
    choice('自动').click()
    await waitFor(
      () =>
        (server.doc().nodes[0] as { params: Record<string, unknown> }).params.quality === undefined,
      () => '',
    )
    choice('最高').click()
    await waitFor(
      () => paramsButton().textContent?.includes('生成质量最高') === true,
      () => paramsButton().textContent ?? '',
    )
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    const switchTo = async (label: string) => {
      host.querySelector<HTMLButtonElement>('.canvas-bar .mode-chip.model')!.click()
      await waitFor(
        () => !!document.querySelector('.canvas-bar-menu'),
        () => '',
      )
      ;[...document.querySelectorAll<HTMLButtonElement>('.canvas-bar-menu button')]
        .find((b) => b.textContent === label)!
        .click()
      await waitFor(
        () => host.querySelector('.canvas-bar .mode-chip.model')?.textContent === label,
        () => host.textContent ?? '',
      )
    }
    await switchTo('千问图像 3.0')
    expect(paramsButton().textContent).not.toContain('生成质量')
    paramsButton().click()
    await waitFor(
      () => !!document.querySelector('.canvas-params-panel'),
      () => '',
    )
    expect(document.querySelector('.canvas-params-panel')?.textContent).not.toContain('生成质量')
    document.querySelector<HTMLDetailsElement>('.canvas-params-advanced')!.open = true
    const seed = document.querySelector<HTMLInputElement>('input[aria-label="随机种子"]')!
    seed.value = '12345'
    seed.dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor(
      () => (server.doc().nodes[0] as { params: Record<string, unknown> }).params.seed === 12345,
      () => '',
    )
    const negative = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="排除内容"]')!
    negative.value = '文字、水印'
    negative.dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor(
      () =>
        (server.doc().nodes[0] as { params: Record<string, unknown> }).params.negative_prompt ===
        '文字、水印',
      () => '',
    )
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await switchTo('GPT Image 2.5 Sunburst')
    expect(paramsButton().textContent).toContain('生成质量最高')
    expect((server.doc().nodes[0] as { params: Record<string, unknown> }).params).toEqual({
      quality: 'max',
    })
    await switchTo('千问图像 3.0')
    expect((server.doc().nodes[0] as { params: Record<string, unknown> }).params).toEqual({
      seed: 12345,
      negative_prompt: '文字、水印',
    })
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  test('时长加减：到达下限后再减为「自动」，不经过下限以下的值；从「自动」增加时回到下限', async () => {
    const { host, server, refs } = await mount(CARD)
    await select(host, refs.$v!)
    const chip = () => host.querySelector<HTMLButtonElement>('.canvas-bar .mode-chip.params')
    await waitFor(
      () => !!chip(),
      () => '',
    )
    chip()!.click()
    await waitFor(
      () => !!document.querySelector('.canvas-stepper'),
      () => '',
    )
    const shown = () => {
      const input = document.querySelector<HTMLInputElement>('.canvas-stepper > input')!
      return input.value ? `${input.value} 秒` : input.placeholder
    }
    const press = async (label: '减少' | '增加', expected: string) => {
      document
        .querySelector<HTMLButtonElement>(`.canvas-stepper button[aria-label="${label}"]`)!
        .click()
      await waitFor(
        () => shown() === expected,
        () => `${shown()} ≠ ${expected}`,
      )
    }
    for (const n of [4, 3, 2]) await press('减少', `${n} 秒`)
    await press('减少', '自动')
    await press('增加', '2 秒')
    const durations = server.ops.map((ops) => {
      const op = ops[0]
      return op?.op === 'update' ? op.params?.duration : undefined
    })
    expect(durations).toEqual([4, 3, 2, -1, 2])
  })

  test('尺寸按对照表拆分为宽高比与分辨率两节；没有取值时宽高比为自动、分辨率不选中；张数只显示数字', async () => {
    const { host, server, refs } = await mount([{ op: 'add_generate', ref: '$i', output: 'image' }])
    await select(host, refs.$i!)
    const chip = () => host.querySelector<HTMLButtonElement>('.canvas-bar .mode-chip.params')
    await waitFor(
      () => chip()?.textContent === '自动宽高比 · 1 张',
      () => host.querySelector('.canvas-bar')?.textContent ?? '',
    )
    chip()!.click()
    await waitFor(
      () => !!document.querySelector('.canvas-params-panel'),
      () => '',
    )
    const panel = document.querySelector('.canvas-params-panel')!
    expect([...panel.querySelectorAll('.canvas-params-title')].map((t) => t.textContent)).toEqual([
      '宽高比',
      '分辨率',
      '张数',
    ])
    const cells = (i: number) => [
      ...[...panel.querySelectorAll('.canvas-params-section')][i]!.querySelectorAll<HTMLElement>(
        '.canvas-seg > button',
      ),
    ]
    const checked = (i: number) =>
      cells(i)
        .filter((b) => b.getAttribute('aria-checked') === 'true')
        .map((b) => b.textContent)
    expect(cells(0).map((b) => b.textContent)).toEqual(['自动', '16:9', '1:1'])
    expect(cells(1).map((b) => b.textContent)).toEqual(['1K', '2K'])
    expect(cells(2).map((b) => b.textContent)).toEqual(['1', '2', '3', '4'])
    expect(checked(0)).toEqual(['自动'])
    expect(checked(1)).toEqual([])
    expect(panel.querySelector('input')).toBeNull()

    // 从「自动」选择档位：接口不接受档位简写，取该档位的 1:1。
    cells(1)[1]!.click()
    await waitFor(
      () => chip()?.textContent === '1:1 · 2K · 1 张',
      () => chip()?.textContent ?? '',
    )
    // 切换宽高比时保留档位；再选择自动即不发送尺寸。
    cells(0)[1]!.click()
    await waitFor(
      () => chip()?.textContent === '16:9 · 2K · 1 张',
      () => chip()?.textContent ?? '',
    )
    cells(0)[0]!.click()
    await waitFor(
      () => server.ops.length === 3,
      () => '',
    )
    // 尚无结果的卡片：框随所选宽高比改变形状、短边不变；1:1 与缺省框比例相同，不改变；重新选择自动时恢复缺省比例。
    expect(server.ops.map((ops) => ops[0])).toEqual([
      { op: 'update', id: refs.$i!, params: { size: '2048*2048' } },
      { op: 'update', id: refs.$i!, params: { size: '2720*1536' }, w: 300, h: 169 },
      { op: 'update', id: refs.$i!, params: {}, w: 169, h: 169 },
    ])
  })

  test('画布上没有其他素材时 @ 仍提供搜索与上传；选择工作区文件时先添加到画布再插入引用', async () => {
    const { host, server, refs } = await mount([{ op: 'add_generate', ref: '$i', output: 'image' }])
    await select(host, refs.$i!)
    ;[...host.querySelectorAll<HTMLButtonElement>('.canvas-bar button')]
      .find((b) => b.textContent === '@')!
      .click()
    await waitFor(
      () => !!document.querySelector('.canvas-pick input[type="search"]'),
      () => '',
    )
    expect(document.querySelector('.canvas-pick-upload')?.textContent).toContain('从设备上传')
    const input = document.querySelector<HTMLInputElement>('.canvas-pick input[type="search"]')!
    input.value = '小'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const hits = () => [
      ...document.querySelectorAll<HTMLButtonElement>('.canvas-pick-list > button'),
    ]
    // 图像生成卡只接受图片：不列出视频。
    await waitFor(
      () => hits().length === 1,
      () => document.querySelector('.canvas-pick')!.innerHTML,
    )
    hits()[0]!.click()
    await waitFor(
      () => server.ops.length === 2,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]![0]).toMatchObject({ op: 'add_file', path: '角色/小满.png' })
    expect(server.ops[0]![0]).toHaveProperty('near')
    const added = server.doc().nodes.find((n) => n.type === 'file')!
    expect(server.ops[1]).toEqual([{ op: 'update', id: refs.$i!, prompt: `@[${added.id}] ` }])
  })

  test('首尾帧模式下 @ 只列出已连接的帧，不提供文件与上传；从尾帧空位打开时提供', async () => {
    const { host, refs } = await mount([
      ...CARD,
      { op: 'connect', from: '$a', to: '$v', role: 'first_frame' },
    ])
    await select(host, refs.$v!)
    ;[...host.querySelectorAll<HTMLButtonElement>('.canvas-bar button')]
      .find((b) => b.textContent === '@')!
      .click()
    await waitFor(
      () => !!document.querySelector('.canvas-pick'),
      () => '',
    )
    expect(
      [...document.querySelectorAll('.canvas-pick-list > button')].map((b) => b.textContent),
    ).toEqual(['小满'])
    expect(document.querySelector('.canvas-pick-upload')).toBeNull()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(
      () => !document.querySelector('.canvas-pick'),
      () => '',
    )
    host.querySelector<HTMLButtonElement>('.canvas-inputs button[aria-label="尾帧"]')!.click()
    await waitFor(
      () => !!document.querySelector('.canvas-pick-upload'),
      () => document.body.innerHTML.slice(-300),
    )
  })

  test('选择已在画布上的工作区文件：直接引用该节点，不再添加新节点', async () => {
    const { host, server, refs } = await mount([
      { op: 'add_file', ref: '$f', path: '角色/小满.png', x: 0, y: 0 },
      { op: 'add_generate', ref: '$i', output: 'image', x: 300, y: 0 },
    ])
    await select(host, refs.$i!)
    ;[...host.querySelectorAll<HTMLButtonElement>('.canvas-bar button')]
      .find((b) => b.textContent === '@')!
      .click()
    await waitFor(
      () => !!document.querySelector('.canvas-pick input[type="search"]'),
      () => '',
    )
    const input = document.querySelector<HTMLInputElement>('.canvas-pick input[type="search"]')!
    input.value = '角色'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    const file = () =>
      [...document.querySelectorAll<HTMLButtonElement>('.canvas-pick-list > button')].find(
        (b) => b.dataset.tip === '角色/小满.png',
      )
    await waitFor(
      () => !!file(),
      () => document.querySelector('.canvas-pick')!.innerHTML,
    )
    file()!.click()
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([{ op: 'update', id: refs.$i!, prompt: `@[${refs.$f!}] ` }])
  })

  test('从素材栏的「+」上传：上传到该卡片旁边并连接为参考', async () => {
    const { host, server, refs } = await mount(CARD)
    await select(host, refs.$v!)
    host.querySelector<HTMLButtonElement>('.canvas-inputs button[aria-label="添加素材"]')!.click()
    await waitFor(
      () => !!document.querySelector('.canvas-pick input[type="file"]'),
      () => '',
    )
    const upload = document.querySelector<HTMLInputElement>('.canvas-pick input[type="file"]')!
    Object.defineProperty(upload, 'files', {
      configurable: true,
      value: [new File(['a'], '参考.png')],
    })
    upload.dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor(
      () => server.uploads.length === 1,
      () => '',
    )
    expect(server.uploads[0]!.get('name')).toBe('参考.png')
    expect(server.uploads[0]!.has('x')).toBe(true)
    const added = server
      .doc()
      .nodes.find((n) => n.type === 'file' && n.path === 'uploads/参考.png')!
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([
      { op: 'connect', from: added.id, to: refs.$v!, role: 'reference' },
    ])
  })

  test('点击 @ 选择一个素材：在提示词中插入引用并立即提交', async () => {
    const { host, server, refs } = await mount(CARD)
    await select(host, refs.$v!)
    const at = [...host.querySelectorAll<HTMLButtonElement>('.canvas-bar button')].find(
      (b) => b.textContent === '@',
    )!
    at.click()
    await waitFor(
      () => !!document.querySelector('.canvas-pick'),
      () => '',
    )
    ;[...document.querySelectorAll<HTMLButtonElement>('.canvas-pick-list button')]
      .find((b) => b.textContent?.includes('小满'))!
      .click()
    await waitFor(
      () => server.ops.length === 1,
      () => '',
    )
    expect(server.ops[0]).toEqual([{ op: 'update', id: refs.$v!, prompt: `@[${refs.$a!}] ` }])
    // 服务端在同一批操作中补充了参考连线，素材栏中增加一项。
    await waitFor(
      () => host.querySelectorAll('.canvas-inputs .canvas-input i').length === 1,
      () => '',
    )
  })

  test('在一张卡片上输入后直接选中另一张卡片：提示词提交给原卡片，新卡片的面板为空', async () => {
    const { host, server, refs } = await mount([
      { op: 'add_generate', ref: '$g1', output: 'image', x: 0, y: 0 },
      { op: 'add_generate', ref: '$g2', output: 'image', x: 400, y: 0 },
    ])
    await select(host, refs.$g1!)
    const editor = host.querySelector<HTMLElement>('.canvas-prompt')!
    editor.textContent = '一只猫'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    await select(host, refs.$g2!)
    // 浏览器在移除有焦点的元素之后触发失焦事件，测试环境手动补发该事件。
    editor.dispatchEvent(new FocusEvent('blur'))
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([{ op: 'update', id: refs.$g1!, prompt: '一只猫' }])
    expect(host.querySelector('.canvas-prompt')!.textContent).toBe('')
  })

  test('输入后点击空白处取消选中：面板卸载之后的失焦仍提交该卡片的提示词', async () => {
    const { host, server, refs } = await mount(CARD)
    await select(host, refs.$v!)
    const editor = host.querySelector<HTMLElement>('.canvas-prompt')!
    editor.textContent = '雨夜'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    pointer(host.querySelector('.canvas-stage')!, 'pointerdown', 900, 650)
    await waitFor(
      () => !host.querySelector('.canvas-panel'),
      () => '',
    )
    editor.dispatchEvent(new FocusEvent('blur'))
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([{ op: 'update', id: refs.$v!, prompt: '雨夜' }])
  })

  test('发送：在同一次请求中先提交编辑中的提示词，再运行', async () => {
    const { host, server, refs } = await mount(CARD)
    await select(host, refs.$v!)
    const editor = host.querySelector<HTMLElement>('.canvas-prompt')!
    editor.textContent = '雨夜校门口'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    const send = host.querySelector<HTMLButtonElement>('.canvas-panel .send-btn')!
    await waitFor(
      () => !send.disabled,
      () => '',
    )
    send.click()
    await waitFor(
      () => server.runs.length === 1,
      () => '',
    )
    expect(server.runs[0]).toEqual({
      nodeId: refs.$v!,
      ops: [{ op: 'update', id: refs.$v!, prompt: '雨夜校门口' }],
    })
  })

  test('无法推算花费时不显示；可以推算时显示', async () => {
    const { host, server, refs } = await mount(CARD)
    server.quote = { cost: 3, currency: 'CNY' }
    await select(host, refs.$v!)
    await waitFor(
      () => !!host.querySelector('.canvas-price'),
      () => '',
    )
    expect(host.querySelector('.canvas-price')!.textContent).toBe('¥3.00')
  })

  test('右侧「+」新建一张后续视频生成卡并把图片连接为首帧', async () => {
    const { host, server, refs } = await mount(FILES)
    node(host, refs.$a!).querySelector<HTMLButtonElement>('.canvas-port.out')!.click()
    await waitFor(
      () => !!document.querySelector('.canvas-menu'),
      () => '',
    )
    ;[...document.querySelectorAll<HTMLButtonElement>('.canvas-menu button')]
      .find((b) => b.textContent?.includes('视频生成'))!
      .click()
    await waitFor(
      () => server.ops.length === 1,
      () => '',
    )
    expect(server.ops[0]).toEqual([
      { op: 'add_generate', ref: '$n', output: 'video', beside: refs.$a! },
      { op: 'connect', from: refs.$a!, to: '$n', role: 'first_frame' },
    ])
  })

  test('有多个版本时用角标切换当前版本；失败原文显示在空位中', async () => {
    const core = await import('@qywork/core')
    const made = {
      prompt: 'p',
      provider: 'qwen',
      model: 'wan3.0-video',
      params: {},
      inputs: [],
      at: '2026-09-29T10:00:00Z',
    }
    const { host, server, refs } = await mount(CARD)
    const withVersions = core.addVersions(server.doc(), refs.$v!, [
      { id: 'v1', path: 'generated/1.mp4', made },
      { id: 'v2', path: 'generated/2.mp4', made },
    ])
    if (!withVersions.ok) throw new Error(withVersions.error)
    server.setView({ doc: withVersions.doc, states: { [refs.$v!]: { state: 'normal' } } })
    const store = await import('../../lib/store/index.ts')
    store.setState('fileVersion', 1)
    await waitFor(
      () => !!host.querySelector('.canvas-badge.version'),
      () => host.innerHTML.slice(0, 600),
    )
    host.querySelector<HTMLButtonElement>('.canvas-badge.version')!.click()
    await waitFor(
      () => document.querySelectorAll('.canvas-menu button').length === 2,
      () => document.body.innerHTML.slice(-800),
    )
    document.querySelectorAll<HTMLButtonElement>('.canvas-menu button')[1]!.click()
    await waitFor(
      () => server.ops.length === 1,
      () => `ops=${JSON.stringify(server.ops)}`,
    )
    expect(server.ops[0]).toEqual([{ op: 'update', id: refs.$v!, current: 'v2' }])

    server.setView({ doc: core.emptyCanvas(), states: {} })
    const fresh = core.applyCanvasOps(
      core.emptyCanvas(),
      [{ op: 'add_generate', output: 'image' }],
      () => 'g1',
    )
    if (!fresh.ok) throw new Error(fresh.error)
    server.setView({
      doc: fresh.doc,
      states: { g1: { state: 'failed', message: '内容审核未通过' } },
    })
    store.setState('fileVersion', 2)
    await waitFor(
      () => host.textContent?.includes('内容审核未通过') === true,
      () => `final=${host.innerHTML.slice(0, 400)}`,
    )
  })

  test('一次返回四张图片可逐版切换，部分返回与再次失败都在图片节点内提示', async () => {
    const core = await import('@qywork/core')
    const store = await import('../../lib/store/index.ts')
    const { host, server, refs } = await mount([
      { op: 'add_generate', ref: '$g', output: 'image', prompt: '海报', params: { n: 4 } },
    ])
    const id = refs.$g!
    const made = {
      prompt: '海报',
      provider: 'qwen',
      model: 'qwen-image-3.0',
      params: { n: 4 },
      inputs: [],
      at: '2026-10-02T12:00:00Z',
    }
    const r = core.addVersions(
      server.doc(),
      id,
      [1, 2, 3, 4].map((i) => ({ id: `v${i}`, path: `generated/${i}.png`, made })),
    )
    if (!r.ok) throw new Error(r.error)
    server.setView({ doc: r.doc, states: { [id]: { state: 'normal' } } })
    store.setState('canvasVersion', 1)
    await waitFor(
      () => !!host.querySelector('.canvas-badge.version'),
      () => host.textContent ?? '',
    )
    await select(host, id)
    host.querySelector<HTMLButtonElement>('.canvas-badge.version')!.click()
    await waitFor(
      () => document.querySelectorAll('.canvas-menu button').length === 4,
      () => document.body.textContent ?? '',
    )
    document.querySelectorAll<HTMLButtonElement>('.canvas-menu button')[3]!.click()
    await waitFor(
      () => host.querySelector('.canvas-badge.version')?.textContent?.includes('4 / 4') === true,
      () => host.textContent ?? '',
    )
    const updated = server.doc().nodes.find((n) => n.id === id)
    expect(updated?.type === 'generate' && updated.current).toBe('v4')

    const partial = structuredClone(r.doc)
    const card = partial.nodes.find((n) => n.id === id)!
    if (card.type !== 'generate') throw new Error('不是生成节点')
    card.versions = [card.versions[0]!]
    card.versions[0]!.warning = '请求 4 张，实际返回 1 张'
    server.setView({ doc: partial })
    store.setState('canvasVersion', 2)
    await waitFor(
      () =>
        node(host, id)
          .querySelector('.canvas-media .canvas-media-notice')
          ?.textContent?.includes('请求 4 张，实际返回 1 张') === true,
      () => host.textContent ?? '',
    )
    const panel = host.querySelector<HTMLElement>('.canvas-panel')!
    const editor = panel.querySelector<HTMLElement>('.canvas-prompt')!
    expect(panel.querySelector('.canvas-media-notice')).toBeNull()
    expect(host.querySelector('.canvas-result-notice')).toBeNull()
    expect(editor.textContent).toBe('海报')
    expect(host.querySelector('.canvas-badge.version')).toBeNull()

    server.setView({
      states: { [id]: { state: 'failed', message: 'HTTP 400：rejected by the safety system' } },
    })
    store.setState('canvasVersion', 3)
    await waitFor(
      () =>
        node(host, id)
          .querySelector('.canvas-media .canvas-media-notice')
          ?.textContent?.includes('本次生成失败，已保留原结果') === true,
      () => host.textContent ?? '',
    )
    expect(node(host, id).querySelector('.canvas-media-notice')?.getAttribute('role')).toBe('alert')
    expect(node(host, id).querySelector('.canvas-bitmap')).not.toBeNull()
    expect(panel.textContent).not.toContain('HTTP 400')
    expect(editor.textContent).toBe('海报')
    panel.querySelector<HTMLButtonElement>('.send-btn')!.click()
    await waitFor(
      () => server.runs.length === 1,
      () => JSON.stringify(server.runs),
    )
    expect(server.runs[0]?.ops).toEqual([])
  })

  test('选中工具条只保留视频的取帧：已有结果的生成卡不显示「生成参数」「打开」', async () => {
    const core = await import('@qywork/core')
    const { host, server, refs } = await mount(CARD)
    const withVersion = core.addVersions(server.doc(), refs.$v!, [
      {
        id: 'v1',
        path: 'generated/1.mp4',
        made: {
          prompt: '回头',
          provider: 'qwen',
          model: 'wan3.0-video',
          params: {},
          inputs: [],
          at: '2026-09-29T10:00:00Z',
        },
      },
    ])
    if (!withVersion.ok) throw new Error(withVersion.error)
    server.setView({ doc: withVersion.doc, states: { [refs.$v!]: { state: 'normal' } } })
    const store = await import('../../lib/store/index.ts')
    store.setState('fileVersion', 1)
    await waitFor(
      () => !!node(host, refs.$v!).querySelector('.canvas-bitmap'),
      () => node(host, refs.$v!).innerHTML,
    )
    const tools = () => [...host.querySelectorAll('.canvas-tools button')].map((b) => b.textContent)
    pointer(node(host, refs.$v!), 'pointerdown', 10, 10)
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
    await waitFor(
      () => tools().length > 0,
      () => host.innerHTML.slice(0, 300),
    )
    expect(tools()).toEqual(['取帧'])
    pointer(node(host, refs.$a!), 'pointerdown', 10, 10)
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
    await waitFor(
      () => tools().length === 0,
      () => JSON.stringify(tools()),
    )
  })
})

describe('画布：导航与选择的快捷键', () => {
  const stageOf = (host: HTMLElement) => host.querySelector<HTMLElement>('.canvas-stage')!
  const pan = (host: HTMLElement) => stageOf(host).style.getPropertyValue('--px')
  const spaceKey = (target: EventTarget, type: 'keydown' | 'keyup', repeat = false) => {
    const event = new KeyboardEvent(type, {
      key: ' ',
      code: 'Space',
      bubbles: true,
      cancelable: true,
      repeat,
    })
    target.dispatchEvent(event)
    return event
  }

  test('按钮仍持有焦点时，空格平移拦截首次按下、长按重复与松开按键的默认操作', async () => {
    const { host, server } = await mount(FILES)
    const button = document.createElement('button')
    button.textContent = '最大化'
    document.body.append(button)
    button.focus()
    const before = Number.parseFloat(pan(host))
    const scale = zoom(host)
    expect(spaceKey(button, 'keydown').defaultPrevented).toBe(true)
    pointer(stageOf(host), 'pointerdown', 100, 100)
    pointer(stageOf(host), 'pointermove', 160, 130)
    for (let i = 0; i < 3; i += 1) {
      expect(spaceKey(button, 'keydown', true).defaultPrevented).toBe(true)
    }
    pointer(stageOf(host), 'pointerup', 160, 130)
    expect(spaceKey(button, 'keyup').defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(button)
    expect(Number.parseFloat(pan(host)) - before).toBe(60)
    expect(zoom(host)).toBe(scale)
    expect(stageOf(host).classList.contains('panning')).toBe(false)
    expect(server.ops).toEqual([])
  })

  test('输入控件中空格的按下、重复与松开不被画布拦截', async () => {
    const { host } = await mount(FILES)
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    for (const input of [
      document.createElement('input'),
      document.createElement('textarea'),
      document.createElement('select'),
      editor,
    ]) {
      host.append(input)
      input.focus()
      expect(spaceKey(input, 'keydown').defaultPrevented).toBe(false)
      expect(spaceKey(input, 'keydown', true).defaultPrevented).toBe(false)
      expect(spaceKey(input, 'keyup').defaultPrevented).toBe(false)
      expect(stageOf(host).classList.contains('panning')).toBe(false)
    }
  })

  test('长按空格时窗口失焦会退出平移，恢复焦点后的左键拖动仍为框选', async () => {
    const { host } = await mount(FILES)
    spaceKey(window, 'keydown')
    expect(stageOf(host).classList.contains('panning')).toBe(true)
    window.dispatchEvent(new Event('blur'))
    expect(stageOf(host).classList.contains('panning')).toBe(false)
    const before = pan(host)
    pointer(stageOf(host), 'pointerdown', 100, 100)
    pointer(stageOf(host), 'pointermove', 160, 130)
    pointer(stageOf(host), 'pointerup', 160, 130)
    expect(pan(host)).toBe(before)
    expect(spaceKey(window, 'keyup').defaultPrevented).toBe(false)
  })

  test('左键拖动空白处为框选，不平移', async () => {
    const { host, refs } = await mount(FILES)
    const before = pan(host)
    pointer(stageOf(host), 'pointerdown', -5000, -5000)
    pointer(stageOf(host), 'pointermove', 5000, 5000)
    pointer(stageOf(host), 'pointerup', 5000, 5000)
    expect(pan(host)).toBe(before)
    expect(node(host, refs.$a!).classList.contains('selected')).toBe(true)
    expect(node(host, refs.$b!).classList.contains('selected')).toBe(true)
  })

  test('中键拖动与按住 Space 时左键拖动均为平移，不改变选区', async () => {
    const { host, refs } = await mount(FILES)
    pointer(node(host, refs.$a!), 'pointerdown', 10, 10)
    pointer(stageOf(host), 'pointerup', 10, 10)
    const before = pan(host)
    pointer(stageOf(host), 'pointerdown', 100, 100, { button: 1 })
    pointer(stageOf(host), 'pointermove', 160, 100, { button: 1 })
    pointer(stageOf(host), 'pointerup', 160, 100, { button: 1 })
    const afterMiddle = pan(host)
    expect(afterMiddle).not.toBe(before)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space' }))
    pointer(node(host, refs.$b!), 'pointerdown', 100, 100)
    pointer(stageOf(host), 'pointermove', 160, 130)
    pointer(stageOf(host), 'pointerup', 160, 130)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space' }))
    expect(pan(host)).not.toBe(afterMiddle)
    expect(node(host, refs.$a!).classList.contains('selected')).toBe(true)
    expect(node(host, refs.$b!).classList.contains('selected')).toBe(false)
  })

  test('Ctrl+A 全选；Shift+2 缩放到选中', async () => {
    const { host, refs } = await mount(FILES)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true }))
    await waitFor(
      () => node(host, refs.$b!).classList.contains('selected'),
      () => '',
    )
    expect(node(host, refs.$a!).classList.contains('selected')).toBe(true)
    // 只选中一张并缩放到选中：该节点占满视野，缩放比例大于全选时。
    const all = zoom(host)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    pointer(node(host, refs.$a!), 'pointerdown', 10, 10)
    pointer(stageOf(host), 'pointerup', 10, 10)
    resize(stageOf(host), 800, 600)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '@', code: 'Digit2', shiftKey: true }))
    await waitFor(
      () => zoom(host) !== all,
      () => String(zoom(host)),
    )
  })
})

describe('画布：右键菜单', () => {
  let restoreDesktop: (() => void) | undefined
  afterEach(() => {
    restoreDesktop?.()
    restoreDesktop = undefined
  })

  const desktop = async (root: string, reveal: (path: string) => Promise<void>) => {
    const store = await import('../../lib/store/index.ts')
    const g = globalThis as Record<string, unknown>
    const previous = g.__TAURI_INTERNALS__
    const workspace = store.workspace()
    // 挂载完成后才启用菜单所用的桌面桥接，不占用外壳拖放测试的常驻事件订阅。
    g.__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args: { path: string }) => {
        if (cmd !== 'reveal_file') throw new Error(`未预期命令：${cmd}`)
        return reveal(args.path)
      },
    }
    store.setWorkspace({ id: 'ws_canvas_reveal', root, name: '画布项目' })
    restoreDesktop = () => {
      g.__TAURI_INTERNALS__ = previous
      store.setWorkspace(workspace)
    }
  }

  const stageOf = (host: HTMLElement) => host.querySelector<HTMLElement>('.canvas-stage')!
  const menu = () => document.querySelector('.canvas-context-menu')
  const items = () =>
    [...document.querySelectorAll<HTMLButtonElement>('.canvas-context-menu > button')].map(
      (b) => b.querySelector('span')!.textContent,
    )
  const choose = (label: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.canvas-context-menu > button')]
      .find((b) => b.querySelector('span')!.textContent === label)!
      .click()
  const rightClick = (host: HTMLElement, el: Element, x: number, y: number) => {
    pointer(el, 'pointerdown', x, y, { button: 2 })
    pointer(stageOf(host), 'pointerup', x, y, { button: 2 })
  }

  test.each([
    ['C:\\素材 项目', 'C:\\素材 项目\\generated\\视频 2.mp4'],
    ['\\\\server\\共享 项目', '\\\\server\\共享 项目\\generated\\视频 2.mp4'],
    ['/tmp/素材 项目', '/tmp/素材 项目/generated/视频 2.mp4'],
  ])('桌面菜单在重命名前定位当前版本文件：%s', async (root, expected) => {
    const paths: string[] = []
    const { host, server, refs } = await mount(CARD)
    await desktop(root, async (path) => {
      paths.push(path)
    })
    const core = await import('@qywork/core')
    const store = await import('../../lib/store/index.ts')
    const made = {
      prompt: '视频',
      provider: 'qwen',
      model: 'wan3.0-video',
      params: {},
      inputs: [],
      at: '2026-10-02T16:00:00Z',
    }
    const r = core.addVersions(server.doc(), refs.$v!, [
      { id: 'v1', path: 'generated/视频 1.mp4', made },
      { id: 'v2', path: 'generated/视频 2.mp4', made },
    ])
    if (!r.ok) throw new Error(r.error)
    const card = r.doc.nodes.find((n) => n.id === refs.$v)!
    if (card.type !== 'generate') throw new Error('不是生成节点')
    card.current = 'v2'
    server.setView({ doc: r.doc })
    store.setState('canvasVersion', 1)
    await waitFor(
      () => !!node(host, refs.$v!).querySelector('.canvas-badge.version'),
      () => '',
    )
    rightClick(host, node(host, refs.$v!), 10, 10)
    await waitFor(
      () => items().includes('在资源管理器中显示'),
      () => JSON.stringify(items()),
    )
    expect(items().indexOf('在资源管理器中显示')).toBe(items().indexOf('重命名') - 1)
    choose('在资源管理器中显示')
    await waitFor(
      () => paths.length === 1,
      () => '',
    )
    expect(paths).toEqual([expected])
    expect(server.ops).toEqual([])
    expect(menu()).toBeNull()
  })

  test('素材文件可定位，桌面命令失败时显示原因', async () => {
    const paths: string[] = []
    const { host, refs } = await mount([{ op: 'add_file', ref: '$a', path: '素材 图片.png' }])
    await desktop('C:\\项目', async (path) => {
      paths.push(path)
      throw '文件不存在：C:\\项目\\素材 图片.png'
    })
    rightClick(host, node(host, refs.$a!), 10, 10)
    await waitFor(
      () => items().includes('在资源管理器中显示'),
      () => JSON.stringify(items()),
    )
    choose('在资源管理器中显示')
    await waitFor(
      () => host.querySelector('.canvas-fault')?.textContent?.includes('文件不存在') === true,
      () => host.textContent ?? '',
    )
    expect(paths).toEqual(['C:\\项目\\素材 图片.png'])
  })

  test('没有产物或只有任务记录时不提供文件定位', async () => {
    const { host, server, refs } = await mount(CARD)
    await desktop('C:\\项目', async () => {
      throw new Error('不应调用')
    })
    rightClick(host, node(host, refs.$v!), 10, 10)
    await waitFor(
      () => !!menu(),
      () => '',
    )
    expect(items()).not.toContain('在资源管理器中显示')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    const core = await import('@qywork/core')
    const store = await import('../../lib/store/index.ts')
    const r = core.addVersions(server.doc(), refs.$v!, [
      {
        id: 'pending',
        path: 'generated/video.task.json',
        made: {
          prompt: '视频',
          provider: 'qwen',
          model: 'wan3.0-video',
          params: {},
          inputs: [],
          at: '2026-10-02T16:00:00Z',
        },
      },
    ])
    if (!r.ok) throw new Error(r.error)
    server.setView({ doc: r.doc, states: { [refs.$v!]: { state: 'pending', version: 'pending' } } })
    store.setState('canvasVersion', 1)
    await waitFor(
      () => node(host, refs.$v!).textContent?.includes('取回') === true,
      () => '',
    )
    rightClick(host, node(host, refs.$v!), 10, 10)
    await waitFor(
      () => !!menu(),
      () => '',
    )
    expect(items()).not.toContain('在资源管理器中显示')
  })

  test('已填写提示词的生成卡右键菜单中没有「运行」：付费生成只从面板的发送按钮发起，该处标有价格', async () => {
    const { host, refs } = await mount([
      { op: 'add_generate', ref: '$v', output: 'video', prompt: '街口回头', x: 0, y: 0 },
    ])
    rightClick(host, node(host, refs.$v!), 10, 10)
    await waitFor(
      () => !!menu(),
      () => '',
    )
    expect(items()).toContain('复制')
    expect(items()).not.toContain('运行')
  })

  test('在节点上右键：先选中该节点，菜单包含复制、剪切、创建副本、重命名、删除；删除即移除该节点', async () => {
    const { host, server, refs } = await mount(FILES)
    rightClick(host, node(host, refs.$b!), 10, 10)
    await waitFor(
      () => !!menu(),
      () => '',
    )
    expect(node(host, refs.$b!).classList.contains('selected')).toBe(true)
    for (const label of ['复制', '剪切', '创建副本', '重命名', '删除'])
      expect(items()).toContain(label)
    expect(items()).not.toContain('在资源管理器中显示')
    expect(menu()!.textContent).toContain('Delete')
    choose('删除')
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([{ op: 'remove', id: refs.$b! }])
    expect(menu()).toBeNull()
  })

  test('右键拖动只平移，不弹出菜单，不改变选区', async () => {
    const { host, refs } = await mount(FILES)
    const before = stageOf(host).style.getPropertyValue('--px')
    pointer(node(host, refs.$a!), 'pointerdown', 100, 100, { button: 2 })
    pointer(stageOf(host), 'pointermove', 180, 100, { button: 2 })
    pointer(stageOf(host), 'pointerup', 180, 100, { button: 2 })
    expect(stageOf(host).style.getPropertyValue('--px')).not.toBe(before)
    expect(menu()).toBeNull()
    expect(node(host, refs.$a!).classList.contains('selected')).toBe(false)
  })

  test('在空白处右键：新建的生成卡放在右键点击的位置；复制节点后菜单提供粘贴，粘贴到该位置', async () => {
    const { host, server, refs } = await mount(FILES)
    rightClick(host, stageOf(host), 700, 500)
    await waitFor(
      () => !!menu(),
      () => '',
    )
    for (const label of ['图像生成', '视频生成', '音频生成', '从设备上传', '全选']) {
      expect(items()).toContain(label)
    }
    const z = zoom(host)
    const px = Number.parseFloat(stageOf(host).style.getPropertyValue('--px'))
    const py = Number.parseFloat(stageOf(host).style.getPropertyValue('--py'))
    choose('图像生成')
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    const near = (server.ops[0]![0] as { near: { x: number; y: number } }).near
    expect(server.ops[0]![0]).toMatchObject({ op: 'add_generate', output: 'image' })
    expect(near.x).toBeCloseTo((700 - px) / z, 3)
    expect(near.y).toBeCloseTo((500 - py) / z, 3)
    // 新卡片在响应体到达之后才被选中；等待其被选中后再继续，避免覆盖之后右键操作的选区。
    await waitFor(
      () => {
        const sel = host.querySelector('.canvas-node.selected')
        return !!sel && sel !== node(host, refs.$a!) && sel !== node(host, refs.$b!)
      },
      () => '',
    )

    rightClick(host, node(host, refs.$a!), 10, 10)
    await waitFor(
      () => !!menu(),
      () => '',
    )
    choose('复制')
    rightClick(host, stageOf(host), 900, 500)
    await waitFor(
      () => items().includes('粘贴'),
      () => JSON.stringify(items()),
    )
    choose('粘贴')
    await waitFor(
      () => server.ops.length === 2,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[1]![0]).toMatchObject({ op: 'add_file', path: 'a.png' })
  })

  test('在连线上右键：断开该连线', async () => {
    const { host, server } = await mount([
      ...CARD,
      { op: 'connect', from: '$a', to: '$v', role: 'reference' },
    ])
    rightClick(host, host.querySelector('.canvas-edge-hit')!, 10, 10)
    await waitFor(
      () => !!menu(),
      () => '',
    )
    expect(items()).toEqual(['断开'])
    choose('断开')
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.doc().edges).toHaveLength(0)
  })
})

/**
 * 原始失败形状：整页刷新后画布按全部节点重新适配视口，选中与未提交的提示词丢失。
 * 刷新以「卸载、`flushSession`、以同一份文档重新挂载」模拟：挂载时只能从记录取得刷新前的状态。
 */
describe('画布：刷新后恢复', () => {
  const reload = async () => {
    dispose?.()
    dispose = undefined
    restore?.()
    restore = undefined
    document.body.replaceChildren()
    const { flushSession } = await import('../../lib/session.ts')
    flushSession()
  }
  const viewport = (host: HTMLElement) => {
    const stage = host.querySelector<HTMLElement>('.canvas-stage')!
    return ['--z', '--px', '--py'].map((v) => stage.style.getPropertyValue(v))
  }

  test('视口与选中的节点按刷新前恢复，不重新适配', async () => {
    const first = await mount(CARD)
    resize(first.host.querySelector<HTMLElement>('.canvas-stage')!, 1000, 700)
    const stage = first.host.querySelector<HTMLElement>('.canvas-stage')!
    stage.dispatchEvent(new WheelEvent('wheel', { deltaX: 120, deltaY: 80, bubbles: true }))
    pointer(node(first.host, first.refs.$a!), 'pointerdown', 10, 10)
    pointer(stage, 'pointerup', 10, 10)
    const before = viewport(first.host)
    await reload()

    const second = await mount(CARD)
    resize(second.host.querySelector<HTMLElement>('.canvas-stage')!, 1000, 700)
    expect(viewport(second.host)).toEqual(before)
    expect(node(second.host, second.refs.$a!).classList.contains('selected')).toBe(true)
  })

  test('未提交的提示词草稿按刷新前恢复；提示词已被修改时丢弃草稿', async () => {
    const select = async (host: HTMLElement, id: string) => {
      pointer(node(host, id), 'pointerdown', 10, 10)
      pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
      await waitFor(
        () => !!host.querySelector('.canvas-panel'),
        () => host.innerHTML.slice(0, 200),
      )
    }
    const first = await mount(CARD)
    await select(first.host, first.refs.$v!)
    const editor = first.host.querySelector<HTMLElement>('.canvas-prompt')!
    editor.textContent = '雨夜'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    await reload()

    const second = await mount(CARD)
    await waitFor(
      () => !!second.host.querySelector('.canvas-panel'),
      () => second.host.innerHTML.slice(0, 200),
    )
    expect(second.host.querySelector('.canvas-prompt')!.textContent).toBe('雨夜')
    expect(second.server.ops).toEqual([])
    // 恢复的草稿未提交、编辑框没有焦点；此后画布重新读取一次（提示词未变化）不得清除草稿。
    const store = await import('../../lib/store/index.ts')
    const reads = second.server.reads
    store.setState('fileVersion', (v) => v + 1)
    await waitFor(
      () => second.server.reads > reads,
      () => '',
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(second.host.querySelector('.canvas-prompt')!.textContent).toBe('雨夜')
    await reload()

    const third = await mount([...CARD, { op: 'update', id: '$v', prompt: '晴天' }])
    await waitFor(
      () => !!third.host.querySelector('.canvas-panel'),
      () => third.host.innerHTML.slice(0, 200),
    )
    expect(third.host.querySelector('.canvas-prompt')!.textContent).toBe('晴天')
  })
})

describe('画布：撤销与重做', () => {
  const key = (k: string, extra: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, ...extra }))
  const dragA = (host: HTMLElement, id: string) => {
    const stage = host.querySelector('.canvas-stage')!
    pointer(node(host, id), 'pointerdown', 10, 10)
    pointer(stage, 'pointermove', 110, 60)
    pointer(stage, 'pointerup', 110, 60)
  }

  test('Ctrl+Z 撤销移动，Ctrl+Shift+Z 重做', async () => {
    const { host, server, refs } = await mount(FILES)
    const x0 = server.doc().nodes[0]!.x
    dragA(host, refs.$a!)
    await waitFor(
      () => server.doc().nodes[0]!.x !== x0,
      () => '',
    )
    const moved = server.doc().nodes[0]!.x
    key('z')
    await waitFor(
      () => server.doc().nodes[0]!.x === x0,
      () => JSON.stringify(server.restores),
    )
    expect(server.restores).toEqual([{ from: 'd1', to: 'd0' }])
    key('z', { shiftKey: true })
    await waitFor(
      () => server.doc().nodes[0]!.x === moved,
      () => JSON.stringify(server.restores),
    )
    expect(server.restores[1]).toEqual({ from: 'd0', to: 'd1' })
  })

  test('文件在期间被其他位置修改：撤销被拒绝并显示原因，撤销栈清空', async () => {
    const { host, server, refs } = await mount(FILES)
    dragA(host, refs.$a!)
    await waitFor(
      () => server.ops.length === 1,
      () => '',
    )
    server.setView({ doc: server.doc() })
    key('z')
    await waitFor(
      () => host.querySelector('.canvas-fault')?.textContent?.includes('无法撤销') === true,
      () => host.querySelector('.canvas-fault')?.textContent ?? '',
    )
    key('z')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(server.restores).toHaveLength(1)
  })
})

describe('画布：复制、剪切、粘贴', () => {
  /** happy-dom 的 ClipboardEvent 不含 clipboardData：此处手动附加一个只含 files 的对象。 */
  function paste(files: File[] = []) {
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: { files } })
    document.body.dispatchEvent(ev)
  }
  const key = (k: string, extra: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, ...extra }))

  test('Ctrl+C 后粘贴：添加副本并选中副本，原节点不变', async () => {
    const { host, server, refs } = await mount(FILES)
    pointer(node(host, refs.$a!), 'pointerdown', 10, 10)
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
    key('c')
    key('v')
    paste()
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toHaveLength(1)
    expect(server.ops[0]![0]).toMatchObject({ op: 'add_file', path: 'a.png', name: '小满' })
    const copy = server.doc().nodes.at(-1)!
    await waitFor(
      () => !!host.querySelector(`[data-node="${copy.id}"].selected`),
      () => '',
    )
    expect(node(host, refs.$a!).classList.contains('selected')).toBe(false)
    expect(server.doc().nodes).toHaveLength(3)
  })

  test('Ctrl+D 创建副本并保留输入连线；Ctrl+X 剪切', async () => {
    const { host, server, refs } = await mount([
      ...CARD,
      { op: 'connect', from: '$a', to: '$v', role: 'reference' },
    ])
    pointer(node(host, refs.$v!), 'pointerdown', 10, 10)
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
    key('d')
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]!.map((o) => o.op)).toEqual(['add_generate', 'connect'])
    expect(server.ops[0]![1]).toMatchObject({ from: refs.$a!, role: 'reference' })
    const copy = server.doc().nodes.at(-1)!
    await waitFor(
      () => !!host.querySelector(`[data-node="${copy.id}"].selected`),
      () => '',
    )
    key('x')
    await waitFor(
      () => server.ops.length === 2,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[1]).toEqual([{ op: 'remove', id: copy.id }])
  })

  test('系统剪贴板中有图片时粘贴即上传', async () => {
    const { server } = await mount(FILES)
    paste([new File(['x'], '截图.png', { type: 'image/png' })])
    await waitFor(
      () => server.uploads.length === 1,
      () => '',
    )
    expect(server.uploads[0]!.get('name')).toBe('截图.png')
  })
})

describe('画布：连线', () => {
  /** 在元素上按下，再在目标元素上松开。happy-dom 不进行布局，elementFromPoint 直接替换为返回松开处的元素。 */
  async function dragLink(host: HTMLElement, from: HTMLElement, onto: Element | null) {
    const stage = host.querySelector('.canvas-stage')!
    const original = document.elementFromPoint
    document.elementFromPoint = () => onto
    try {
      pointer(from, 'pointerdown', 10, 10)
      pointer(stage, 'pointermove', 120, 40)
      pointer(stage, 'pointerup', 120, 40)
    } finally {
      document.elementFromPoint = original
    }
  }

  test('从图片的输出连接点拖到视频卡上：连接为参考图', async () => {
    const { host, server, refs } = await mount(CARD)
    const port = node(host, refs.$a!).querySelector<HTMLElement>('.canvas-port.out')!
    await dragLink(host, port, node(host, refs.$v!))
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([
      { op: 'connect', from: refs.$a!, to: refs.$v!, role: 'reference' },
    ])
  })

  test('在无法连接的目标（文件节点、已连接的卡片）上松开时不发送请求', async () => {
    const { host, server, refs } = await mount([
      ...CARD,
      { op: 'add_file', ref: '$b', path: 'b.png', x: 0, y: 300 },
      { op: 'connect', from: '$a', to: '$v', role: 'reference' },
    ])
    const port = node(host, refs.$a!).querySelector<HTMLElement>('.canvas-port.out')!
    await dragLink(host, port, node(host, refs.$b!))
    await dragLink(host, port, node(host, refs.$v!))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(server.ops).toEqual([])
  })

  /**
   * 原始失败形状：落点靠近源节点时，新卡片以落点为中心放置、与源节点相交后被移到其下方，
   * 位置与落点无关；菜单的右边沿对齐落点，向左展开。
   */
  test('拖到空白处松开：菜单从落点向右展开，新卡片的输入端位于落点并完成连接', async () => {
    const { host, server, refs } = await mount(CARD)
    const z = zoom(host)
    const stage = host.querySelector<HTMLElement>('.canvas-stage')!
    const px = Number.parseFloat(stage.style.getPropertyValue('--px'))
    const py = Number.parseFloat(stage.style.getPropertyValue('--py'))
    // happy-dom 不进行布局：为落点锚点与菜单提供尺寸，菜单的定位才能区分向左与向右展开。
    const rect = spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.classList.contains('canvas-drop-anchor')) {
        return { left: 500, right: 500, top: 300, bottom: 300, width: 0, height: 0 } as DOMRect
      }
      if (this.classList.contains('canvas-menu')) {
        return { left: 0, right: 160, top: 0, bottom: 40, width: 160, height: 40 } as DOMRect
      }
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 } as DOMRect
    })
    try {
      const port = node(host, refs.$a!).querySelector<HTMLElement>('.canvas-port.out')!
      await dragLink(host, port, host.querySelector('.canvas-stage'))
      await waitFor(
        () => !!document.querySelector('.canvas-menu'),
        () => '',
      )
      expect(document.querySelector<HTMLElement>('.canvas-menu')!.style.left).toBe('500px')
    } finally {
      rect.mockRestore()
    }
    ;[...document.querySelectorAll<HTMLButtonElement>('.canvas-menu button')]
      .find((b) => b.textContent === '图像生成')!
      .click()
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]![0]).toMatchObject({ op: 'add_generate', output: 'image' })
    expect(server.ops[0]![1]).toMatchObject({ op: 'connect', from: refs.$a!, role: 'reference' })
    const added = server.doc().nodes.find((n) => n.id !== refs.$a && n.id !== refs.$v)!
    expect(added.x).toBe(Math.round((120 - px) / z))
    expect(Math.abs(added.y + added.h / 2 - (40 - py) / z)).toBeLessThanOrEqual(1)
  })

  test('点击连线将其选中，按 Delete 删除', async () => {
    const { host, server, refs } = await mount([
      ...CARD,
      { op: 'connect', from: '$a', to: '$v', role: 'reference' },
    ])
    const hit = host.querySelector<SVGPathElement>('.canvas-edge-hit')!
    pointer(hit as unknown as HTMLElement, 'pointerdown', 10, 10)
    await waitFor(
      () => !!host.querySelector('.canvas-edges path.selected'),
      () => host.querySelector('.canvas-edges')!.innerHTML,
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    const edge = server.doc().edges.length
    expect(server.ops[0]![0]).toMatchObject({ op: 'remove' })
    expect(edge).toBe(0)
    expect(refs.$v).toBeDefined()
  })

  test('连线仅选中后出现剪刀：悬停不出现，改选节点后隐藏，单击剪刀断开连线', async () => {
    const { host, server, refs } = await mount([
      ...CARD,
      { op: 'connect', from: '$a', to: '$v', role: 'reference' },
    ])
    const stage = host.querySelector('.canvas-stage')!
    const cut = () => host.querySelector<HTMLButtonElement>('.canvas-edge-cut')
    expect(cut()).toBeNull()
    const hit = () => host.querySelector<SVGPathElement>('.canvas-edge-hit')!
    pointer(hit(), 'pointermove', 10, 10)
    expect(cut()).toBeNull()
    pointer(node(host, refs.$a!), 'pointerdown', 10, 10)
    pointer(stage, 'pointerup', 10, 10)
    pointer(hit(), 'pointermove', 10, 10)
    expect(cut()).toBeNull()
    pointer(hit(), 'pointerdown', 10, 10)
    await waitFor(
      () => !!cut(),
      () => '',
    )
    pointer(cut()!, 'pointermove', 12, 12)
    expect(cut()).not.toBeNull()
    pointer(stage, 'pointermove', 500, 500)
    expect(cut()).not.toBeNull()
    pointer(node(host, refs.$v!), 'pointerdown', 10, 10)
    pointer(stage, 'pointerup', 10, 10)
    await waitFor(
      () => !cut(),
      () => '',
    )
    pointer(hit(), 'pointermove', 10, 10)
    expect(cut()).toBeNull()
    pointer(hit(), 'pointerdown', 10, 10)
    await waitFor(
      () => !!cut(),
      () => '',
    )
    cut()!.click()
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]![0]).toMatchObject({ op: 'remove' })
    expect(server.doc().edges).toHaveLength(0)
  })

  test('未配置模型的类别：卡片显示「未配置模型」，模型按钮打开模型库，发送键禁用', async () => {
    const { host, refs } = await mount([{ op: 'add_generate', ref: '$s', output: 'audio' }])
    const store = await import('../../lib/store/index.ts')
    pointer(node(host, refs.$s!), 'pointerdown', 10, 10)
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
    await waitFor(
      () => !!host.querySelector('.canvas-panel'),
      () => '',
    )
    const chip = host.querySelector<HTMLButtonElement>('.canvas-bar .mode-chip.model')!
    expect(chip.textContent).toBe('未配置模型')
    expect(host.querySelector<HTMLButtonElement>('.canvas-panel .send-btn')!.disabled).toBe(true)
    chip.click()
    await waitFor(
      () => !!document.querySelector('.canvas-bar-menu'),
      () => '',
    )
    document.querySelector<HTMLButtonElement>('.canvas-bar-menu button')!.click()
    expect(store.settingsPage()).toBe('models')
    store.closeSettings()
  })
})

describe('画布：左侧工具条', () => {
  const rail = (host: HTMLElement) => [
    ...host.querySelectorAll<HTMLButtonElement>('.canvas-rail > button'),
  ]
  const labels = (host: HTMLElement) => rail(host).map((b) => b.textContent)

  test('列出全部生成类别，包括未配置模型的类别；点击一项在视野中央添加一张卡片', async () => {
    const { host, server } = await mount(FILES)
    expect(labels(host)).toEqual([
      '图像生成',
      '视频生成',
      '音频生成',
      '时间线',
      '从工作区选择',
      '从设备上传',
    ])
    rail(host)[1]!.click()
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]![0]).toMatchObject({ op: 'add_generate', output: 'video' })
  })

  test('从工作区选择：打开后无需输入即列出可添加到画布的文件；连续选择时第二个放在第一个右侧', async () => {
    const { host, server } = await mount(FILES)
    rail(host)
      .find((b) => b.textContent === '从工作区选择')!
      .click()
    const hits = () => [...host.querySelectorAll<HTMLButtonElement>('.canvas-picker-list > button')]
    await waitFor(
      () => hits().length === 2,
      () => host.querySelector('.canvas-picker')!.innerHTML,
    )
    expect(hits().map((b) => b.querySelector('.truncate')!.textContent)).toEqual([
      '角色/小满.png',
      '镜头/雨夜.mp4',
    ])
    hits()[0]!.click()
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]![0]).toMatchObject({ op: 'add_file', path: '角色/小满.png' })
    expect(server.ops[0]![0]).toHaveProperty('near')
    hits()[1]!.click()
    await waitFor(
      () => server.ops.length === 2,
      () => JSON.stringify(server.ops),
    )
    const first = server.doc().nodes.find((n) => n.type === 'file' && n.path === '角色/小满.png')!
    expect(server.ops[1]![0]).toMatchObject({
      op: 'add_file',
      path: '镜头/雨夜.mp4',
      beside: first.id,
    })
  })

  test('搜索失败时列表中显示一行原因', async () => {
    const { host } = await mount(FILES)
    rail(host)
      .find((b) => b.textContent === '从工作区选择')!
      .click()
    await waitFor(
      () => !!host.querySelector('.canvas-picker input'),
      () => '',
    )
    const input = host.querySelector<HTMLInputElement>('.canvas-picker input')!
    input.value = '坏'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    await waitFor(
      () =>
        host.querySelector('.canvas-picker-error')?.textContent?.includes('磁盘读不了') === true,
      () => host.querySelector('.canvas-picker')!.innerHTML,
    )
  })

  test('从设备上传：逐个上传，第一个放在视野中央，第二个放在第一个右侧', async () => {
    const { host, server } = await mount(FILES)
    const input = host.querySelector<HTMLInputElement>('.canvas-rail input[type="file"]')!
    const files = [new File(['a'], '小满.png'), new File(['b'], '雨夜.mp4')]
    Object.defineProperty(input, 'files', { configurable: true, value: files })
    input.dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor(
      () => server.uploads.length === 2,
      () => String(server.uploads.length),
    )
    expect(server.uploads[0]!.get('name')).toBe('小满.png')
    expect(server.uploads[0]!.get('path')).toBe('board.canvas.json')
    expect(server.uploads[0]!.has('x') && server.uploads[0]!.has('y')).toBe(true)
    const first = server
      .doc()
      .nodes.find((n) => n.type === 'file' && n.path === 'uploads/小满.png')!
    expect(server.uploads[1]!.get('beside')).toBe(first.id)
  })
})

describe('画布：纯函数与标签页', () => {
  test('解码宽度按填满框所需计算：横图放入偏竖的框时按高度换算，竖图放入偏横的框时取框宽', async () => {
    const { coverWidth } = await import('./Bitmap.tsx')
    expect(coverWidth({ w: 256, h: 256 }, { w: 1536, h: 1024 })).toBe(384)
    expect(coverWidth({ w: 256, h: 171 }, { w: 1536, h: 1024 })).toBe(257)
    expect(coverWidth({ w: 256, h: 144 }, { w: 1024, h: 1536 })).toBe(256)
  })

  test('参数取值决定的宽高比：对照表取对应项，比例取值取其本身，自动返回 auto，无关参数返回 null', async () => {
    const { ratioOf } = await import('./GeneratePanel.tsx')
    const size: Parameters<typeof ratioOf>[0] = {
      name: 'size',
      label: '尺寸',
      type: 'string',
      shapes: [
        { tier: '2K', value: '2K' },
        { ratio: '16:9', tier: '2K', value: '2720x1536' },
      ],
    }
    const ratio: Parameters<typeof ratioOf>[0] = {
      name: 'ratio',
      label: '宽高比',
      type: 'enum',
      values: ['adaptive', '16:9', '9:16'],
    }
    const resolution: Parameters<typeof ratioOf>[0] = {
      name: 'resolution',
      label: '分辨率',
      type: 'enum',
      values: ['1080P', '720P'],
    }
    expect(ratioOf(size, '2720x1536')).toBe('16:9')
    expect(ratioOf(size, '2K')).toBe('auto')
    expect(ratioOf(size, '800x600')).toBeNull()
    expect(ratioOf(ratio, '9:16')).toBe('9:16')
    expect(ratioOf(ratio, 'adaptive')).toBe('auto')
    expect(ratioOf(resolution, '720P')).toBeNull()
  })

  test('解码档位：2 的幂，不小于 256、不大于 4096', async () => {
    const { tierOf } = await import('./Bitmap.tsx')
    expect(tierOf(40)).toBe(256)
    expect(tierOf(257)).toBe(512)
    expect(tierOf(1024)).toBe(1024)
    expect(tierOf(9000)).toBe(4096)
  })

  test('参数取值的界面文字：自动选择与布尔值替换为对应文字，时长带单位，选项上只显示取值', async () => {
    const { cellText, paramText, valueText } = await import('./GeneratePanel.tsx')
    expect(valueText('adaptive')).toBe('自动')
    expect(valueText('auto')).toBe('自动')
    expect(valueText('16:9')).toBe('16:9')
    const duration = { name: 'duration', label: '时长', type: 'integer', auto: -1 } as const
    expect(paramText(duration, -1)).toBe('自动')
    expect(paramText(duration, 5)).toBe('5 秒')
    expect(cellText(duration, 5)).toBe('5')
    expect(cellText(duration, -1)).toBe('自动')
    const lastFrame = { name: 'return_last_frame', label: '返回尾帧', type: 'boolean' } as const
    expect(paramText(lastFrame, true)).toBe('开')
  })

  test('参数按钮上的文字：只显示取值，自动与开关补充参数名，各参数用「 · 」连接，关闭的开关不显示', async () => {
    const { chipText, paramsText } = await import('./GeneratePanel.tsx')
    const size = { name: 'size', label: '尺寸', type: 'string' } as const
    const n = { name: 'n', label: '张数', type: 'integer' } as const
    const duration = { name: 'duration', label: '时长', type: 'integer', auto: -1 } as const
    const lastFrame = { name: 'return_last_frame', label: '返回尾帧', type: 'boolean' } as const
    expect(chipText(size, 'auto')).toBe('自动尺寸')
    expect(chipText(size, undefined)).toBe('自动尺寸')
    expect(chipText(size, '1024x1024')).toBe('1024x1024')
    expect(chipText(n, 2)).toBe('2 张')
    expect(chipText(duration, -1)).toBe('自动时长')
    const values: Record<string, unknown> = { size: 'auto', n: 2, return_last_frame: false }
    expect(paramsText([size, n, lastFrame], (p) => values[p.name])).toBe('自动尺寸 · 2 张')
    values.return_last_frame = true
    expect(paramsText([duration, lastFrame], (p) => values[p.name])).toBe('自动时长 · 返回尾帧开')
  })

  test('带对照表的尺寸：按钮显示宽高比与档位，表外的取值原样显示', async () => {
    const { chipText } = await import('./GeneratePanel.tsx')
    const size: Parameters<typeof chipText>[0] = {
      name: 'size',
      label: '尺寸',
      type: 'string',
      shapes: [
        { tier: '2K', value: '2K' },
        { ratio: '16:9', tier: '2K', value: '2720x1536' },
        { ratio: '1:1', value: '1024x1024' },
      ],
    }
    expect(chipText(size, '2K')).toBe('自动宽高比 · 2K')
    expect(chipText(size, '2720x1536')).toBe('16:9 · 2K')
    expect(chipText(size, '1024x1024')).toBe('1:1')
    expect(chipText(size, '800x600')).toBe('800x600')
  })

  test('比例与像素尺寸绘制成的框：长边 14，短边按比例；其余取值不绘制', async () => {
    const { shapeOf } = await import('./GeneratePanel.tsx')
    expect(shapeOf('16:9')).toEqual({ w: 14, h: 8 })
    expect(shapeOf('21:9')).toEqual({ w: 14, h: 6 })
    expect(shapeOf('1024x1536')).toEqual({ w: 9, h: 14 })
    expect(shapeOf('1:1')).toEqual({ w: 14, h: 14 })
    expect(shapeOf('adaptive')).toBeNull()
    expect(shapeOf('2K')).toBeNull()
    expect(shapeOf(undefined)).toBeNull()
  })

  test('提示词与编辑框互相转换：引用写回 @[id]，保留换行', async () => {
    const { promptOfEditor, promptParts } = await import('./prompt.ts')
    expect(promptParts('@[n1] 走出 @[n2]\n下雨')).toEqual([
      { id: 'n1' },
      { text: ' 走出 ' },
      { id: 'n2' },
      { text: '\n下雨' },
    ])
    const root = document.createElement('div')
    const chip = document.createElement('span')
    chip.dataset.node = 'n1'
    chip.textContent = '小满'
    root.append(chip, ' 走出', document.createElement('br'), '下雨')
    expect(promptOfEditor(root)).toBe('@[n1] 走出\n下雨')
  })

  test('取帧的时刻与名称：起点为首帧，终点为尾帧且取 duration - 1/30 秒，其余按 0.1 秒', async () => {
    const { frameLabel, frameTime } = await import('./frame.ts')
    expect(frameTime(0, 5)).toBe(0)
    expect(frameTime(5, 5)).toBeCloseTo(5 - 1 / 30, 6)
    expect(frameTime(1.6, 5)).toBe(1.6)
    expect(frameLabel(0, 5)).toBe('首帧')
    expect(frameLabel(5, 5)).toBe('尾帧')
    expect(frameLabel(12.43, 20)).toBe('12.4s')
  })

  test('同一张画布打开两次只有一个标签页', async () => {
    const store = await import('../../lib/store/index.ts')
    store.setWorkspace({ id: 'ws_canvas', root: 'C:/w', name: 'w' })
    store.openCanvasTab('分镜/第一集.canvas.json', '第一集')
    store.openCanvasTab('分镜/第一集.canvas.json', '第一集')
    expect(store.panelTabs().filter((t) => t.kind === 'canvas')).toEqual([
      expect.objectContaining({ path: '分镜/第一集.canvas.json', title: '第一集' }),
    ])
    expect(store.canvasTitle('分镜/第一集.canvas.json')).toBe('第一集')
    store.setWorkspace(null)
  })
})

describe('画布：时间线', () => {
  /** happy-dom 不解码视频：任何 `<video>` 设置地址后即报告时长 `seconds`。 */
  function fakeDurations(seconds: number): () => void {
    const proto = HTMLVideoElement.prototype
    const src = Object.getOwnPropertyDescriptor(proto, 'src')
    const duration = Object.getOwnPropertyDescriptor(proto, 'duration')
    Object.defineProperty(proto, 'duration', { configurable: true, get: () => seconds })
    Object.defineProperty(proto, 'src', {
      configurable: true,
      get(this: HTMLVideoElement) {
        return this.getAttribute('src') ?? ''
      },
      set(this: HTMLVideoElement, value: string) {
        this.setAttribute('src', value)
        setTimeout(() => this.dispatchEvent(new Event('loadedmetadata')))
      },
    })
    return () => {
      if (src) Object.defineProperty(proto, 'src', src)
      else delete (proto as unknown as Record<string, unknown>).src
      if (duration) Object.defineProperty(proto, 'duration', duration)
      else delete (proto as unknown as Record<string, unknown>).duration
    }
  }

  const TIMELINE: CanvasOp[] = [
    {
      op: 'add_timeline',
      ref: '$t',
      x: 0,
      y: 0,
      clips: [
        { path: 'a.mp4', in: 0, out: 2 },
        { path: 'b.mp4', in: 1, out: 4 },
      ],
    },
    { op: 'add_file', ref: '$v', path: 'clip.mp4', x: 0, y: 500 },
  ]

  test('左侧工具条新建时间线：发送 add_timeline 并选中该时间线；空轨道只有「添加视频」', async () => {
    const { host, server } = await mount(FILES)
    ;[...host.querySelectorAll<HTMLButtonElement>('.canvas-rail > button')]
      .find((b) => b.textContent === '时间线')!
      .click()
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]![0]).toMatchObject({ op: 'add_timeline' })
    const id = server.doc().nodes.at(-1)!.id
    await waitFor(
      () => !!host.querySelector(`[data-node="${id}"].selected .canvas-tl-empty`),
      () => host.innerHTML.slice(0, 300),
    )
    expect(host.querySelector(`[data-node="${id}"] .canvas-tl-empty`)!.textContent).toBe('添加视频')
    expect(host.querySelector(`[data-node="${id}"] .canvas-tl-view`)).toBeNull()
  })

  test('从文件树把视频拖到时间线上：完整插入轨道；拖入图片时报告错误，不发送操作', async () => {
    const restoreVideo = fakeDurations(5)
    try {
      const { host, server, refs } = await mount(TIMELINE)
      const store = await import('../../lib/store/index.ts')
      const drop = (path: string) => {
        const ev = new Event('drop', { bubbles: true, cancelable: true })
        Object.defineProperties(ev, {
          dataTransfer: {
            value: {
              types: [store.WORKSPACE_PATH_TYPE],
              getData: (type: string) => (type === store.WORKSPACE_PATH_TYPE ? path : ''),
            },
          },
          clientX: { value: 100 },
          clientY: { value: 100 },
        })
        node(host, refs.$t!).dispatchEvent(ev)
      }
      drop('镜头/雨夜.mp4')
      await waitFor(
        () => server.ops.length === 1,
        () => JSON.stringify(server.ops),
      )
      expect(server.ops[0]).toEqual([
        {
          op: 'update',
          id: refs.$t!,
          clips: [
            { path: 'a.mp4', in: 0, out: 2 },
            { path: 'b.mp4', in: 1, out: 4 },
            { path: '镜头/雨夜.mp4', in: 0, out: 5 },
          ],
        },
      ])
      drop('角色/小满.png')
      await waitFor(
        () => host.querySelector('.canvas-fault')?.textContent === '只有视频可以加入时间线',
        () => host.querySelector('.canvas-fault')?.textContent ?? '',
      )
      expect(server.ops).toHaveLength(1)
    } finally {
      restoreVideo()
    }
  })

  test('从系统把视频拖到时间线上：先上传到 uploads/（放在时间线右侧），再完整插入轨道', async () => {
    const restoreVideo = fakeDurations(3)
    const original = document.elementsFromPoint
    try {
      const { host, server, refs } = await mount(TIMELINE)
      const tl = node(host, refs.$t!)
      document.elementsFromPoint = () => [tl]
      const ev = new Event('drop', { bubbles: true, cancelable: true })
      Object.defineProperties(ev, {
        dataTransfer: {
          value: {
            types: ['Files'],
            getData: () => '',
            files: [new File([new Uint8Array([1])], '雨夜.mp4', { type: 'video/mp4' })],
          },
        },
        clientX: { value: 100 },
        clientY: { value: 100 },
      })
      tl.dispatchEvent(ev)
      await waitFor(
        () => server.ops.length === 1,
        () => JSON.stringify(server.ops),
      )
      expect(server.uploads[0]!.get('beside')).toBe(refs.$t!)
      expect(server.ops[0]![0]).toMatchObject({
        op: 'update',
        id: refs.$t!,
        clips: [
          { path: 'a.mp4', in: 0, out: 2 },
          { path: 'b.mp4', in: 1, out: 4 },
          { path: 'uploads/雨夜.mp4', in: 0, out: 3 },
        ],
      })
    } finally {
      document.elementsFromPoint = original
      restoreVideo()
    }
  })

  test('从片段推导连线：画布上被片段引用的视频各有一条连线连到时间线；断开连线即删除引用该视频的片段', async () => {
    const { host, server, refs } = await mount([
      ...TIMELINE,
      { op: 'add_file', ref: '$a', path: 'a.mp4', x: 0, y: 900 },
    ])
    const line = `clip:${refs.$t!}:${refs.$a!}`
    await waitFor(
      () => !!host.querySelector(`.canvas-edge-hit[data-edge="${line}"]`),
      () => host.querySelector('.canvas-edges')!.innerHTML.slice(0, 300),
    )
    expect(host.querySelector(`[data-edge="clip:${refs.$t!}:${refs.$v!}"]`)).toBeNull()
    const hit = host.querySelector<SVGPathElement>(`.canvas-edge-hit[data-edge="${line}"]`)!
    pointer(hit as unknown as HTMLElement, 'pointerdown', 10, 10)
    await waitFor(
      () => !!host.querySelector('.canvas-edges path.selected'),
      () => host.querySelector('.canvas-edges')!.innerHTML.slice(0, 300),
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([
      { op: 'update', id: refs.$t!, clips: [{ path: 'b.mp4', in: 1, out: 4 }] },
    ])
    await waitFor(
      () => !host.querySelector(`[data-edge="${line}"]`),
      () => host.querySelector('.canvas-edges')!.innerHTML.slice(0, 300),
    )
  })

  test('从视频节点的连接点拖线到时间线上：落在轨道外时完整插入到末尾', async () => {
    const restoreVideo = fakeDurations(5)
    const point = document.elementFromPoint
    const points = document.elementsFromPoint
    try {
      const { host, server, refs } = await mount(TIMELINE)
      const stage = host.querySelector('.canvas-stage')!
      document.elementFromPoint = () => node(host, refs.$t!)
      document.elementsFromPoint = () => [node(host, refs.$t!)]
      pointer(node(host, refs.$v!).querySelector('.canvas-port.out')!, 'pointerdown', 10, 10)
      pointer(stage, 'pointermove', 120, 40)
      await waitFor(
        () => node(host, refs.$t!).classList.contains('link-target'),
        () => node(host, refs.$t!).className,
      )
      pointer(stage, 'pointerup', 120, 40)
      await waitFor(
        () => server.ops.length === 1,
        () => JSON.stringify(server.ops),
      )
      expect(server.ops[0]).toEqual([
        {
          op: 'update',
          id: refs.$t!,
          clips: [
            { path: 'a.mp4', in: 0, out: 2 },
            { path: 'b.mp4', in: 1, out: 4 },
            { path: 'clip.mp4', in: 0, out: 5 },
          ],
        },
      ])
    } finally {
      document.elementFromPoint = point
      document.elementsFromPoint = points
      restoreVideo()
    }
  })

  test('在片段上右键：菜单作用于该片段，创建副本插入其后，删除即移除该片段', async () => {
    const { host, server, refs } = await mount(TIMELINE)
    const clipAt = (i: number) => node(host, refs.$t!).querySelectorAll('.canvas-tl-clip')[i]!
    const menuFor = async (i: number) => {
      clipAt(i).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      await waitFor(
        () => !!document.querySelector('.canvas-context-menu'),
        () => document.body.innerHTML.slice(-300),
      )
      return [...document.querySelectorAll<HTMLButtonElement>('.canvas-context-menu button')]
    }
    const items = await menuFor(1)
    expect(items.map((b) => b.querySelector('span')!.textContent)).toContain('创建副本')
    items.find((b) => b.textContent?.startsWith('创建副本'))!.click()
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([
      {
        op: 'update',
        id: refs.$t!,
        clips: [
          { path: 'a.mp4', in: 0, out: 2 },
          { path: 'b.mp4', in: 1, out: 4 },
          { path: 'b.mp4', in: 1, out: 4 },
        ],
      },
    ])
    await waitFor(
      () => node(host, refs.$t!).querySelectorAll('.canvas-tl-clip').length === 3,
      () => '',
    )
    ;(await menuFor(0)).find((b) => b.textContent?.startsWith('删除'))!.click()
    await waitFor(
      () => server.ops.length === 2,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[1]).toEqual([
      {
        op: 'update',
        id: refs.$t!,
        clips: [
          { path: 'b.mp4', in: 1, out: 4 },
          { path: 'b.mp4', in: 1, out: 4 },
        ],
      },
    ])
  })

  test('Delete：轨道上选中片段时删除该片段而不删除节点；未选中片段时删除节点', async () => {
    const { host, server, refs } = await mount(TIMELINE)
    const { sessionOf } = await import('./timeline.ts')
    const tl = node(host, refs.$t!)
    pointer(tl.querySelector('.canvas-tl-bar')!, 'pointerdown', 10, 10)
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
    await waitFor(
      () => tl.classList.contains('selected'),
      () => tl.className,
    )
    sessionOf(refs.$t!)!.select(1)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([
      { op: 'update', id: refs.$t!, clips: [{ path: 'a.mp4', in: 0, out: 2 }] },
    ])
    expect(sessionOf(refs.$t!)!.selected()).toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    await waitFor(
      () => server.ops.length === 2,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[1]).toEqual([{ op: 'remove', id: refs.$t! }])
  })

  test('分割在播放头处把片段一分为二；播放头不在片段内时按钮不可用', async () => {
    const { host, server, refs } = await mount(TIMELINE)
    const { sessionOf } = await import('./timeline.ts')
    const split = node(host, refs.$t!).querySelector<HTMLButtonElement>(
      'button[aria-label="分割"]',
    )!
    sessionOf(refs.$t!)!.seek(0)
    await waitFor(
      () => split.disabled,
      () => String(split.disabled),
    )
    sessionOf(refs.$t!)!.seek(3)
    await waitFor(
      () => !split.disabled,
      () => String(split.disabled),
    )
    split.click()
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([
      {
        op: 'update',
        id: refs.$t!,
        clips: [
          { path: 'a.mp4', in: 0, out: 2 },
          { path: 'b.mp4', in: 1, out: 2 },
          { path: 'b.mp4', in: 2, out: 4 },
        ],
      },
    ])
  })

  test('全屏编辑覆盖应用，预览移入全屏；全屏中 Delete 不删除节点，Esc 退出且预览回到节点', async () => {
    const { host, server, refs } = await mount(TIMELINE)
    const tl = node(host, refs.$t!)
    pointer(tl.querySelector('.canvas-tl-bar')!, 'pointerdown', 10, 10)
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
    tl.querySelector<HTMLButtonElement>('.canvas-tl-full-btn')!.click()
    await waitFor(
      () => !!document.querySelector('.canvas-tl-layer .canvas-tl.full .canvas-tl-screen'),
      () => document.body.innerHTML.slice(-300),
    )
    expect(tl.querySelector('.canvas-tl-screen')).toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete' }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(server.ops).toHaveLength(0)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await waitFor(
      () => !document.querySelector('.canvas-tl-layer') && !!tl.querySelector('.canvas-tl-screen'),
      () => document.body.innerHTML.slice(-300),
    )
  })

  test('导出失败：显示原因，通知服务端放弃本次导出，按钮恢复为可再次导出，不保留进度', async () => {
    const { host, server, refs } = await mount(TIMELINE)
    const button = node(host, refs.$t!).querySelector<HTMLButtonElement>('.canvas-tl-export')!
    button.click()
    await waitFor(
      () => !!host.querySelector('.canvas-fault'),
      () => button.outerHTML,
    )
    await waitFor(
      () => button.getAttribute('aria-label') === '导出',
      () => button.outerHTML,
    )
    expect(button.textContent).toBe('')
    await waitFor(
      () => server.exports.includes('abort'),
      () => JSON.stringify(server.exports),
    )
    expect(server.exports).toEqual(['start', 'abort'])
  })
})
