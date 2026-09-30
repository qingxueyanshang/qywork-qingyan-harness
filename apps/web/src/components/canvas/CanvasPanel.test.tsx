/**
 * 覆盖 `canvas/CanvasPanel.tsx`、`canvas/GeneratePanel.tsx`、`canvas/SourcePicker.tsx`、`canvas/search.ts`、
 * `canvas/Rail.tsx`、`canvas/Bitmap.tsx`、`canvas/prompt.ts` 与 `canvas/frame.ts` 的纯函数，
 * 以及 `lib/store/ui.ts` 的 `openCanvasTab`。
 *
 * 服务端用内存里的一份画布代替：`client.api` 的桩按路径分派，操作经 core 的 `applyCanvasOps` 应用，
 * 每次提交的操作都记下来，断言落在「发了哪几批操作」上。
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { CanvasDoc, CanvasOp, CanvasView } from '@qywork/core'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  // happy-dom 没有这两样；真实 WebView 里都有。尺寸由 `resize` 手动上报。
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    constructor(private readonly callback: () => void) {}
    observe(el: Element) {
      observed.set(el, this.callback)
    }
    disconnect() {}
  }
  HTMLElement.prototype.setPointerCapture = () => {}
  // 图片由 Bitmap 自己取文件；测试里一律取不到，走解码失败的那一支。
  globalThis.fetch = ((url: string) => {
    fetched.push(String(url))
    return Promise.reject(new Error('测试里不取文件'))
  }) as unknown as typeof fetch
})

const observed = new Map<Element, () => void>()
/** Bitmap 发出的取文件请求，按顺序记下地址。 */
const fetched: string[] = []

/** 让画布区「量到」一个尺寸：happy-dom 不排版，`clientWidth` 恒为 0。 */
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
  /** 上传请求的查询串，按顺序。 */
  uploads: URLSearchParams[]
  /** 撤销 / 重做请求，按顺序。 */
  restores: { from: string; to: string }[]
}

async function mount(
  seed: CanvasOp[],
  states: CanvasView['states'] = {},
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
    ops: [],
    runs: [],
    reads: 0,
    doc: () => doc,
    setView(next) {
      if (next.doc) {
        doc = next.doc
        // 外部改动：文档换了、指纹跟着换，撤销应当被拒。
        fingerprint = `x${++written}`
      }
      if (next.states) extraStates = next.states
    },
    broken: false,
    quote: null,
    uploads: [],
    restores: [],
  }
  const original = store.client.api
  ;(
    store.client as unknown as { api: (path: string, init?: RequestInit) => Promise<unknown> }
  ).api = async (path: string, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : {}
    if (path.startsWith('/api/models')) return MODELS
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
      // 与服务端同一约定：每次写盘记下前后两份文档的指纹。
      const before = fingerprint
      doc = r.doc
      fingerprint = `d${++written}`
      snapshots.set(fingerprint, doc)
      return { ...view(), refs: r.refs, step: { before, after: fingerprint } }
    }
    if (path.startsWith('/api/canvas/restore')) {
      server.restores.push({ from: body.from, to: body.to })
      if (body.from !== fingerprint || !snapshots.has(body.to)) {
        const { ApiError } = await import('../../lib/client.ts')
        throw new ApiError(
          409,
          path,
          '{"error":"conflict","message":"画布在这之后被改过，撤销不了"}',
        )
      }
      doc = snapshots.get(body.to)!
      fingerprint = body.to
      return { ...view(), refs: {}, step: { before: body.from, after: body.to } }
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
      const q = new URLSearchParams(path.split('?')[1]).get('q')
      if (q === '坏') {
        const { ApiError } = await import('../../lib/client.ts')
        throw new ApiError(500, path, '{"error":"internal","message":"磁盘读不了"}')
      }
      return {
        matches: [
          { path: '角色/小满.png', kind: 'file' },
          { path: '角色', kind: 'dir' },
          { path: '合同.pdf', kind: 'file' },
          { path: '镜头/雨夜.mp4', kind: 'file' },
        ],
        truncated: false,
      }
    }
    if (path.startsWith('/api/canvas/upload')) {
      // 与服务端同一写法：落进 uploads/ 并加节点。
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
    throw new Error(`没有桩这条：${path}`)
  }
  restore = () => {
    ;(store.client as unknown as { api: typeof original }).api = original
  }
  // 模型目录在模块里只拉一次；同一进程里先跑的测试文件可能已经拉过别的目录。
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

/** 当前视口缩放（`--z`）。屏幕上的位移除以它才是画布坐标里的位移。 */
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
  test('图片取不到时节点里显示图片图标', async () => {
    const { host } = await mount(FILES)
    await waitFor(
      () => host.querySelectorAll('.canvas-bitmap-failed').length === 2,
      () => host.innerHTML.slice(0, 400),
    )
  })

  test('首次适配等画布区量到尺寸，量到之后全部节点落在画布区内', async () => {
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

  test('视频节点平时只画封面，选中才挂播放器', async () => {
    const { host, refs } = await mount([
      { op: 'add_file', ref: '$v', path: 'clip.mp4', x: 0, y: 0 },
    ])
    const video = node(host, refs.$v!)
    expect(video.querySelector('video')).toBeNull()
    expect(video.querySelector('canvas.canvas-bitmap')).not.toBeNull()
    pointer(video, 'pointerdown', 10, 10)
    pointer(host.querySelector('.canvas-stage')!, 'pointerup', 10, 10)
    await waitFor(
      () => !!video.querySelector('video[controls]'),
      () => video.innerHTML,
    )
  })

  test('改一个节点不让任何图片重新取文件', async () => {
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

  test('改一个节点后其余节点的元素原样保留，不重建', async () => {
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

  test('拖动只在松手时提交一次位置', async () => {
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

  test('拖动中收到文件变更重读，被拖的节点不跳回', async () => {
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

  test('框选后按 Delete 发一批删除', async () => {
    const { host, server, refs } = await mount(FILES)
    const stage = host.querySelector('.canvas-stage')!
    // 视口在测试里没有尺寸：初始平移由 fit 算成 (w/2, h/2) 之外的值，直接按屏幕坐标框住两个节点。
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

  test('从文件树拖入加一个文件节点；拖到缺失节点上即替换路径', async () => {
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

  test('双击标题改名', async () => {
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

  test('文件快照或画布事件序号变了就重读', async () => {
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

  test('画布文件坏了：显示原文，按 Delete 不发任何写操作', async () => {
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

  test('选中生成卡出现面板，取消选中收起；两档高度都是固定值', async () => {
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

  test('画布区比面板窄时面板收到画布区宽度，不越出左边', async () => {
    const { host, refs } = await mount(CARD)
    resize(host.querySelector<HTMLElement>('.canvas-stage')!, 380, 800)
    await select(host, refs.$v!)
    const panel = host.querySelector<HTMLElement>('.canvas-panel')!
    expect(panel.style.width).toBe('364px')
    expect(panel.style.left).toBe('8px')
  })

  test('流向在跑的卡的连线用内联样式描银河梯度，其余连线不带', async () => {
    const { host } = await mount(
      [...CARD, { op: 'connect', from: '$a', to: '$v', role: 'reference' }],
      { n2: { state: 'running', startedAt: Date.now() } },
    )
    const live = host.querySelector<SVGPathElement>('.canvas-edges path.live')!
    const id = /url\(#([^)]+)\)/.exec(live.style.stroke)?.[1]
    expect(id).toBeDefined()
    expect(host.querySelector(`linearGradient#${id}`)).not.toBeNull()
    expect(live.getAttribute('stroke')).toBeNull()
  })

  test('生成中禁止发送', async () => {
    const { host, refs } = await mount(CARD, { n2: { state: 'running', startedAt: Date.now() } })
    await select(host, refs.$v!)
    const send = host.querySelector<HTMLButtonElement>('.canvas-panel .send-btn')!
    expect(send.disabled).toBe(true)
  })

  test('参数按钮只列标了界面名的参数；模式只列模型支持的，切到首尾帧发一条 set_mode', async () => {
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

  test('参数合成一个按钮：面板分节、点选即提交且不收起；Esc 与再点按钮收起', async () => {
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
    // Esc 只收参数面板，生成面板与选中都还在。
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
    // 宽高比的格子上画图形：自动是带角标的方框，比例按比例；分辨率不画。
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
    // 面板不收起；再点按钮收起。
    expect(panel()).not.toBeNull()
    chip()!.click()
    await waitFor(
      () => !panel(),
      () => '',
    )
  })

  test('时长加减：到下限再减是「自动」，不经过下限以下的值；从「自动」加回到下限', async () => {
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
    const shown = () => document.querySelector('.canvas-stepper > span')?.textContent
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

  test('尺寸按对照表拆成宽高比与分辨率两节；没有取值时宽高比是自动、分辨率不选；张数只写数字', async () => {
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

    // 从「自动」选档位：接口不认档位简写，取这一档的 1:1。
    cells(1)[1]!.click()
    await waitFor(
      () => chip()?.textContent === '1:1 · 2K · 1 张',
      () => chip()?.textContent ?? '',
    )
    // 换宽高比保留档位；再选自动即不传尺寸。
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
    // 还没有结果的卡：框随所选宽高比变宽变窄、高度不变；1:1 与缺省框同比例不改；选回自动还原成缺省比例。
    expect(server.ops.map((ops) => ops[0])).toEqual([
      { op: 'update', id: refs.$i!, params: { size: '2048*2048' } },
      { op: 'update', id: refs.$i!, params: { size: '2720*1536' }, w: 300, h: 169 },
      { op: 'update', id: refs.$i!, params: {}, w: 169, h: 169 },
    ])
  })

  test('画布上没有别的素材时 @ 仍有搜索与上传；选工作区文件先放上画布再插入引用', async () => {
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
    // 出图卡只收图片：视频不列。
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

  test('首尾帧模式下 @ 只列已连上的帧、不给文件与上传；从尾帧空位打开时给', async () => {
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

  test('选到已在画布上的工作区文件：直接引用那个节点，不再加一个', async () => {
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
        (b) => b.title === '角色/小满.png',
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

  test('从素材格的「+」上传：上传到这张卡旁边并连成参考', async () => {
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

  test('点 @ 选一个素材：提示词里插入引用并立刻提交', async () => {
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
    // 服务端在同一批里补了参考线，素材格里多了一张。
    await waitFor(
      () => host.querySelectorAll('.canvas-inputs .canvas-input i').length === 1,
      () => '',
    )
  })

  test('在一张卡上打字后直接选另一张卡：提示词提交给原来那张，新卡的面板是空的', async () => {
    const { host, server, refs } = await mount([
      { op: 'add_generate', ref: '$g1', output: 'image', x: 0, y: 0 },
      { op: 'add_generate', ref: '$g2', output: 'image', x: 400, y: 0 },
    ])
    await select(host, refs.$g1!)
    const editor = host.querySelector<HTMLElement>('.canvas-prompt')!
    editor.textContent = '一只猫'
    editor.dispatchEvent(new Event('input', { bubbles: true }))
    await select(host, refs.$g2!)
    // 浏览器在移除有焦点的元素之后发失焦，测试环境补发这一次。
    editor.dispatchEvent(new FocusEvent('blur'))
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([{ op: 'update', id: refs.$g1!, prompt: '一只猫' }])
    expect(host.querySelector('.canvas-prompt')!.textContent).toBe('')
  })

  test('打字后点空白处取消选中：面板卸载之后的失焦照样提交这张卡的提示词', async () => {
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

  test('发送：先提交编辑中的提示词，再运行，同一次请求', async () => {
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

  test('推不出花费时不显示；推得出时显示', async () => {
    const { host, server, refs } = await mount(CARD)
    server.quote = { cost: 3, currency: 'CNY' }
    await select(host, refs.$v!)
    await waitFor(
      () => !!host.querySelector('.canvas-price'),
      () => '',
    )
    expect(host.querySelector('.canvas-price')!.textContent).toBe('¥3.00')
  })

  test('右侧「+」接出一张视频卡并把图片连为首帧', async () => {
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

  test('多版时角标切换当前版；失败原文显示在空位里', async () => {
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

  test('选中工具条只剩视频的取帧：出过结果的生成卡不出「生成参数」「打开」', async () => {
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

describe('画布：导航与选择的键位', () => {
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

  test('按钮仍持有焦点时，空格平移拦截首次按下、长按重复和松键的默认操作', async () => {
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

  test('输入控件里的空格按下、重复与松键不被画布拦截', async () => {
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

  test('长按空格时窗口失焦会退出平移，回来后的左键拖动仍是框选', async () => {
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

  test('左键拖空白是框选，不平移', async () => {
    const { host, refs } = await mount(FILES)
    const before = pan(host)
    pointer(stageOf(host), 'pointerdown', -5000, -5000)
    pointer(stageOf(host), 'pointermove', 5000, 5000)
    pointer(stageOf(host), 'pointerup', 5000, 5000)
    expect(pan(host)).toBe(before)
    expect(node(host, refs.$a!).classList.contains('selected')).toBe(true)
    expect(node(host, refs.$b!).classList.contains('selected')).toBe(true)
  })

  test('中键拖动、按住 Space 左键拖动都是平移，不改选区', async () => {
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
    // 只选一张，缩放到它：视野里它占满，缩放比全选时大。
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

  test('节点上右键：先选中它，菜单有复制、剪切、创建副本、改名、删除；删除删掉它', async () => {
    const { host, server, refs } = await mount(FILES)
    rightClick(host, node(host, refs.$b!), 10, 10)
    await waitFor(
      () => !!menu(),
      () => '',
    )
    expect(node(host, refs.$b!).classList.contains('selected')).toBe(true)
    for (const label of ['复制', '剪切', '创建副本', '改名', '删除'])
      expect(items()).toContain(label)
    expect(menu()!.textContent).toContain('Delete')
    choose('删除')
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]).toEqual([{ op: 'remove', id: refs.$b! }])
    expect(menu()).toBeNull()
  })

  test('右键拖动只平移，不弹菜单、不改选区', async () => {
    const { host, refs } = await mount(FILES)
    const before = stageOf(host).style.getPropertyValue('--px')
    pointer(node(host, refs.$a!), 'pointerdown', 100, 100, { button: 2 })
    pointer(stageOf(host), 'pointermove', 180, 100, { button: 2 })
    pointer(stageOf(host), 'pointerup', 180, 100, { button: 2 })
    expect(stageOf(host).style.getPropertyValue('--px')).not.toBe(before)
    expect(menu()).toBeNull()
    expect(node(host, refs.$a!).classList.contains('selected')).toBe(false)
  })

  test('空白处右键：新建生成卡放在右键那一点；复制过节点后有粘贴，粘在那一点', async () => {
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
    // 新卡在回体到了之后才被选中；等它选中再往下，免得覆盖后面右键的选区。
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

  test('连线上右键：断开这条线', async () => {
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

  test('中间被别处改过：撤销被拒、报出原因，撤销栈清空', async () => {
    const { host, server, refs } = await mount(FILES)
    dragA(host, refs.$a!)
    await waitFor(
      () => server.ops.length === 1,
      () => '',
    )
    server.setView({ doc: server.doc() })
    key('z')
    await waitFor(
      () => host.querySelector('.canvas-fault')?.textContent?.includes('撤销不了') === true,
      () => host.querySelector('.canvas-fault')?.textContent ?? '',
    )
    key('z')
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(server.restores).toHaveLength(1)
  })
})

describe('画布：复制、剪切、粘贴', () => {
  /** happy-dom 的 ClipboardEvent 不带 clipboardData：自己挂一个只有 files 的。 */
  function paste(files: File[] = []) {
    const ev = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(ev, 'clipboardData', { value: { files } })
    document.body.dispatchEvent(ev)
  }
  const key = (k: string, extra: KeyboardEventInit = {}) =>
    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, ctrlKey: true, ...extra }))

  test('Ctrl+C 再粘贴：加出副本并选中副本，原节点不动', async () => {
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

  test('Ctrl+D 复制一份带上输入线；Ctrl+X 剪切', async () => {
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

  test('系统剪贴板里有图片时粘贴即上传', async () => {
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
  /** 在元素上按下，再在某个元素上松开。elementFromPoint 在 happy-dom 里不排版，直接替成松手处的元素。 */
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

  test('从图片的输出连接点拖到视频卡上：连成参考图', async () => {
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

  test('连不上的目标（文件节点、已连过的卡）松手不发请求', async () => {
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

  test('拖到空白处松手：在落点打开接出菜单，选一项新卡放在落点并连好', async () => {
    const { host, server, refs } = await mount(CARD)
    const port = node(host, refs.$a!).querySelector<HTMLElement>('.canvas-port.out')!
    await dragLink(host, port, host.querySelector('.canvas-stage'))
    await waitFor(
      () => !!document.querySelector('.canvas-menu'),
      () => '',
    )
    ;[...document.querySelectorAll<HTMLButtonElement>('.canvas-menu button')]
      .find((b) => b.textContent === '图像生成')!
      .click()
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]![0]).toMatchObject({ op: 'add_generate', output: 'image' })
    expect(server.ops[0]![0]).toHaveProperty('near')
    expect(server.ops[0]![1]).toMatchObject({ op: 'connect', from: refs.$a!, role: 'reference' })
  })

  test('点连线选中它，按 Delete 删掉', async () => {
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

  test('指针移到连线上，中点出现剪刀；移到剪刀上不消失，点一下断开这条线', async () => {
    const { host, server } = await mount([
      ...CARD,
      { op: 'connect', from: '$a', to: '$v', role: 'reference' },
    ])
    const stage = host.querySelector('.canvas-stage')!
    const cut = () => host.querySelector<HTMLButtonElement>('.canvas-edge-cut')
    expect(cut()).toBeNull()
    const hit = host.querySelector<SVGPathElement>('.canvas-edge-hit')!
    pointer(hit as unknown as HTMLElement, 'pointermove', 10, 10)
    await waitFor(
      () => !!cut(),
      () => '',
    )
    pointer(cut()!, 'pointermove', 12, 12)
    expect(cut()).not.toBeNull()
    pointer(stage, 'pointermove', 500, 500)
    await waitFor(
      () => !cut(),
      () => '',
    )
    pointer(hit as unknown as HTMLElement, 'pointermove', 10, 10)
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

  test('没配模型的类别：卡上写未配置模型，模型按钮通往模型库，发送键置灰', async () => {
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

  test('生成类别全列，没配模型的也列；点一项在视野中央加一张卡', async () => {
    const { host, server } = await mount(FILES)
    expect(labels(host)).toEqual(['图像生成', '视频生成', '音频生成', '从工作区选择', '从设备上传'])
    rail(host)[1]!.click()
    await waitFor(
      () => server.ops.length === 1,
      () => JSON.stringify(server.ops),
    )
    expect(server.ops[0]![0]).toMatchObject({ op: 'add_generate', output: 'video' })
  })

  test('从工作区选择：只列能放上画布的文件；连着选，第二个排在第一个右侧', async () => {
    const { host, server } = await mount(FILES)
    rail(host)
      .find((b) => b.textContent === '从工作区选择')!
      .click()
    const input = await (async () => {
      await waitFor(
        () => !!host.querySelector('.canvas-picker input'),
        () => host.innerHTML.slice(-300),
      )
      return host.querySelector<HTMLInputElement>('.canvas-picker input')!
    })()
    input.value = '小'
    input.dispatchEvent(new Event('input', { bubbles: true }))
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

  test('搜索失败时列表里显示一行原因', async () => {
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

  test('从设备上传：逐个上传，第一个放在视野中央，第二个排在第一个右侧', async () => {
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

describe('画布：纯函数与页签', () => {
  test('解码宽度按铺满框所需：横图进偏竖的框按高度折算，竖图进偏横的框按框宽', async () => {
    const { coverWidth } = await import('./Bitmap.tsx')
    expect(coverWidth({ w: 256, h: 256 }, { w: 1536, h: 1024 })).toBe(384)
    expect(coverWidth({ w: 256, h: 171 }, { w: 1536, h: 1024 })).toBe(257)
    expect(coverWidth({ w: 256, h: 144 }, { w: 1024, h: 1536 })).toBe(256)
  })

  test('参数取值定下的宽高比：对照表取那一格，比例取值取本身，自动回 auto，无关参数回 null', async () => {
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

  test('参数取值的界面用词：自动选择与布尔值换词，时长带单位，格子上只写取值', async () => {
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

  test('参数按钮上的字：只写取值，自动与开关补参数名，各参数用「 · 」连起、关着的开关不写', async () => {
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

  test('带对照表的尺寸：按钮写宽高比与档位，表外的取值原样写', async () => {
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

  test('比例与像素尺寸画成的框：长边 14，短边按比例；其余取值不画', async () => {
    const { shapeOf } = await import('./GeneratePanel.tsx')
    expect(shapeOf('16:9')).toEqual({ w: 14, h: 8 })
    expect(shapeOf('21:9')).toEqual({ w: 14, h: 6 })
    expect(shapeOf('1024x1536')).toEqual({ w: 9, h: 14 })
    expect(shapeOf('1:1')).toEqual({ w: 14, h: 14 })
    expect(shapeOf('adaptive')).toBeNull()
    expect(shapeOf('2K')).toBeNull()
    expect(shapeOf(undefined)).toBeNull()
  })

  test('提示词与编辑框互转：引用写回 @[id]，换行保留', async () => {
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

  test('取帧的时刻与名字：尾帧取 duration - 1/30 秒', async () => {
    const { frameLabel, frameTime } = await import('./frame.ts')
    expect(frameTime('first', 5)).toBe(0)
    expect(frameTime('last', 5)).toBeCloseTo(5 - 1 / 30, 6)
    expect(frameLabel('last')).toBe('尾帧')
    expect(frameLabel(12.43)).toBe('12.4s')
  })

  test('同一张画布开两次只有一页', async () => {
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
