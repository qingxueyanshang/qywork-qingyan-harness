/**
 * 画布页：一个 `*.canvas.json` 的视图与编辑。
 *
 * 画布文件与节点状态以服务端为准（`readCanvas`）：文件快照序号或画布事件序号一变就重读，
 * 每次修改提交一批操作、回体直接是应用后的画布。本地只多两样：视口（不存盘）与拖动中的位置。
 * 拖动中的节点在松手提交之前一直用本地位置，这期间的重读不改它的位置。
 *
 * 渲染用 DOM + CSS transform 平移缩放，一层 SVG 画线：节点里有播放器、面板里是输入框。
 */

import {
  applyCanvasOps,
  type CanvasDoc,
  type CanvasGenerateNode,
  type CanvasMade,
  type CanvasNode,
  type CanvasOp,
  type CanvasView,
  canvasMediaOf,
  copyOps,
  displayNameOf,
  inputsOf,
  MEDIA_OUTPUTS,
  type MediaInputRole,
  type MediaOutput,
  modeOf,
} from '@qywork/core'
import {
  createEffect,
  createResource,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  onMount,
  Show,
  Switch,
} from 'solid-js'
import {
  type CanvasEdit,
  captureFrame,
  client,
  editCanvas,
  ensureModelCatalog,
  explainApiError,
  importToCanvas,
  isDesktopShell,
  modelCatalog,
  openFileInPanel,
  readCanvas,
  registerDropSink,
  restoreCanvas,
  retrieveCard,
  runCard,
  state,
  uploadToCanvas,
  WORKSPACE_PATH_TYPE,
} from '../../lib/store/index.ts'
import { AnchoredMenu } from '../AnchoredMenu.tsx'
import { IconAudio, IconCanvas, IconChevron, IconFile, IconPlus } from '../Icons.tsx'
import { Bitmap } from './Bitmap.tsx'
import { dismissOnOutside } from './dismiss.ts'
import { captureVideoFrame, type FrameAt, frameLabel } from './frame.ts'
import { GeneratePanel, mediaOf, paramText, ROLE_LABEL } from './GeneratePanel.tsx'
import { KindIcon, OUTPUT_LABEL } from './kinds.tsx'
import { Rail } from './Rail.tsx'

const PANEL_W = 600
const PANEL_H = 272
const PANEL_TALL = 440
const TEXT_RE = /\.(md|txt)$/i

/** `at`：从连接点拖到空白处松手时，新卡放在这一点（画布坐标）。 */
type Menu = {
  kind: 'frame' | 'out' | 'version' | 'made'
  anchor: HTMLElement
  nodeId: string
  at?: { x: number; y: number }
}

type Drag =
  | { mode: 'pan'; sx: number; sy: number; px: number; py: number }
  | {
      mode: 'move'
      sx: number
      sy: number
      start: { id: string; x: number; y: number }[]
      moved: boolean
    }
  | { mode: 'box'; sx: number; sy: number; base: ReadonlySet<string> }
  | { mode: 'link'; from: string; sx: number; sy: number; moved: boolean; anchor: HTMLElement }

/** 画布之间共用的剪贴板：复制那一刻的整份文档与选中的节点。只在本应用内，跨画布粘贴要求文件在同一工作区。 */
let clipboard: { source: CanvasDoc; ids: string[] } | null = null

/** 版本的生成时间：当天只写时分，跨天补月日。 */
function madeAt(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

export default function CanvasPanel(props: { path: string; active: boolean }) {
  void ensureModelCatalog()
  const [view, setView] = createSignal<CanvasView | null>(null)
  /** 读不出这张画布（格式错误、文件没了）。此时不发任何写操作。 */
  const [broken, setBroken] = createSignal<string | null>(null)
  /** 最近一次操作没做成的原文，下一次成功即清。 */
  const [fault, setFault] = createSignal<string | null>(null)
  const [z, setZ] = createSignal(1)
  const [px, setPx] = createSignal(40)
  const [py, setPy] = createSignal(60)
  /** 画布区的实际尺寸，由 ResizeObserver 写入；未量到时为 0。 */
  const [size, setSize] = createSignal({ w: 0, h: 0 })
  const [selected, setSelected] = createSignal<ReadonlySet<string>>(new Set())
  const [moving, setMoving] = createSignal<Readonly<Record<string, { x: number; y: number }>>>({})
  const [marquee, setMarquee] = createSignal<{ x: number; y: number; w: number; h: number } | null>(
    null,
  )
  const [renaming, setRenaming] = createSignal<string | null>(null)
  /** 选中的连线。与选中的节点互斥。 */
  const [edgeSelected, setEdgeSelected] = createSignal<string | null>(null)
  /** 从连接点拖出的连线：起点节点与指针位置（画布坐标），以及此刻指着的可连目标。 */
  const [linking, setLinking] = createSignal<{ from: string; x: number; y: number } | null>(null)
  const [linkTarget, setLinkTarget] = createSignal<string | null>(null)
  let dropAnchor!: HTMLSpanElement
  /** 指针最近在画布区里的位置（画布坐标）；粘贴与拖入放在这里，指针不在画布区时放视野中央。 */
  let pointerAt: { x: number; y: number } | null = null
  /** 按下 Ctrl+Shift+V 时为真，随后的 paste 事件带上外部输入线。 */
  let pasteWithInputs = false
  const [menu, setMenu] = createSignal<Menu | null>(null)
  const [tall, setTall] = createSignal(false)
  const [now, setNow] = createSignal(Date.now())
  /** 视频节点的播放器，「当前帧」取它此刻的位置。 */
  const players = new Map<string, HTMLVideoElement>()
  let stage!: HTMLDivElement
  let fitted = false
  let drag: Drag | null = null

  dismissOnOutside(menu, () => setMenu(null))

  // ── 读与写 ──

  /** 只采纳最后一次：连续重读时先发的可能后到；写操作的回体同样作废在它之前发出的读。 */
  let seq = 0
  const load = async () => {
    const mine = ++seq
    try {
      const next = await readCanvas(props.path)
      if (mine !== seq) return
      setView(next)
      setBroken(null)
    } catch (e) {
      if (mine === seq) setBroken(explainApiError(e, '打不开这张画布'))
    }
  }
  createEffect(
    on(
      () => [props.path, state.fileVersion, state.canvasVersion] as const,
      () => void load(),
    ),
  )

  const settle = (next: CanvasView) => {
    seq += 1
    setView(next)
    setFault(null)
  }

  /**
   * 本页自己的编辑：每步记下前后两份文档的指纹。撤销换回前一份、重做换回后一份，由服务端核对当前文件仍是那一份。
   * 上传、拖入、取帧与生成回写不在栈里。
   */
  const undoStack: CanvasEdit['step'][] = []
  const redoStack: CanvasEdit['step'][] = []

  const apply = async (ops: CanvasOp[]): Promise<CanvasEdit | null> => {
    if (broken()) return null
    try {
      const next = await editCanvas(props.path, ops)
      settle(next)
      if (next.step.before !== next.step.after) {
        undoStack.push(next.step)
        if (undoStack.length > 100) undoStack.shift()
        redoStack.length = 0
      }
      return next
    } catch (e) {
      setFault(explainApiError(e, '没有改成'))
      return null
    }
  }

  /** 撤销（`back` 为真）或重做一步。服务端拒绝时两个栈都清空：文件已经不是栈里记的那条历史。 */
  const travel = async (back: boolean) => {
    const from = back ? undoStack : redoStack
    const to = back ? redoStack : undoStack
    const step = from.pop()
    if (!step) return
    try {
      settle(
        await restoreCanvas(
          props.path,
          back ? step.after : step.before,
          back ? step.before : step.after,
        ),
      )
      to.push(step)
    } catch (e) {
      undoStack.length = 0
      redoStack.length = 0
      setFault(explainApiError(e, back ? '没有撤销' : '没有重做'))
    }
  }

  const run = (nodeId: string, ops: CanvasOp[]) => {
    void runCard(props.path, nodeId, ops).then(settle, (e: unknown) =>
      setFault(explainApiError(e, '没有开始生成')),
    )
  }

  const retrieve = (nodeId: string, version?: string) => {
    void retrieveCard(props.path, nodeId, version).then(settle, (e: unknown) =>
      setFault(explainApiError(e, '没有开始取回')),
    )
  }

  // 有卡在跑时每秒走一次计时。
  createEffect(() => {
    const v = view()
    if (!v || !Object.values(v.states).some((s) => s.state === 'running')) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  // ── 视口 ──

  const nodes = () => view()?.doc.nodes ?? []
  const byId = (id: string) => nodes().find((n) => n.id === id)
  const pos = (n: CanvasNode) => moving()[n.id] ?? { x: n.x, y: n.y }
  /** 屏幕上的点距靠近 24px：画布点距取 20 × 2ⁿ，n 取让屏幕点距最接近 24px 的那一档。 */
  const grid = () => {
    const n = Math.max(-2, Math.min(6, Math.round(Math.log2(24 / (20 * z())))))
    return 20 * 2 ** n * z()
  }
  const toWorld = (clientX: number, clientY: number) => {
    const r = stage.getBoundingClientRect()
    return { x: (clientX - r.left - px()) / z(), y: (clientY - r.top - py()) / z() }
  }

  /** 让 `list`（缺省是全部节点）整体落进视野。 */
  const fit = (animate: boolean, list: CanvasNode[] = nodes()) => {
    const { w, h } = size()
    if (!list.length) {
      setZ(1)
      setPx(w / 2)
      setPy(h / 2)
      return
    }
    const minX = Math.min(...list.map((n) => n.x)) - 40
    const minY = Math.min(...list.map((n) => n.y)) - 30
    const maxX = Math.max(...list.map((n) => n.x + n.w)) + 40
    const maxY = Math.max(...list.map((n) => n.y + n.h)) + 10
    const nz = Math.min(
      1.5,
      Math.max(0.1, Math.min((w - 60) / (maxX - minX), (h - 80) / (maxY - minY))),
    )
    const target = {
      z: nz,
      px: (w - (maxX - minX) * nz) / 2 - minX * nz,
      py: (h - (maxY - minY) * nz) / 2 - minY * nz,
    }
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setZ(target.z)
      setPx(target.px)
      setPy(target.py)
      return
    }
    const from = { z: z(), px: px(), py: py() }
    const t0 = performance.now()
    const step = (t: number) => {
      const k = 1 - (1 - Math.min(1, (t - t0) / 180)) ** 3
      setZ(from.z + (target.z - from.z) * k)
      setPx(from.px + (target.px - from.px) * k)
      setPy(from.py + (target.py - from.py) * k)
      if (k < 1) requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  }

  // 首次适配等画布区量到尺寸：页签在后台打开时尺寸为 0，按缺省尺寸算出的视口与实际不符。
  createEffect(() => {
    if (fitted || !view() || size().w === 0) return
    fitted = true
    fit(false)
  })

  /**
   * 删除选中的节点。在窗口上听，只在这一页显示着、按键不在输入框或编辑框里时生效：
   * 画布本身不抢焦点，点过画布之后焦点仍可能在别处。
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!props.active) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'))
      return
    if (e.code === 'Space' && !e.repeat) {
      e.preventDefault()
      space = true
      stage.classList.add('panning')
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const edge = edgeSelected()
      if (edge) {
        e.preventDefault()
        void apply([{ op: 'remove', id: edge }]).then((r) => r && setEdgeSelected(null))
        return
      }
      if (!selected().size) return
      e.preventDefault()
      removeSelected()
    }
    if (e.key === 'Escape') {
      setSelected(new Set<string>())
      setEdgeSelected(null)
    }
    const mod = e.ctrlKey || e.metaKey
    const key = e.key.toLowerCase()
    if (mod && key === 'z') {
      e.preventDefault()
      void travel(!e.shiftKey)
    }
    if (mod && key === 'y') {
      e.preventDefault()
      void travel(false)
    }
    if (mod && key === 'c' && copySelection()) e.preventDefault()
    if (mod && key === 'x' && copySelection()) {
      e.preventDefault()
      removeSelected()
    }
    if (mod && key === 'd') {
      e.preventDefault()
      const v = view()
      const ids = [...selected()]
      if (v && ids.length) void pasteNodes(v.doc, ids, null, true)
    }
    // 粘贴本身在 paste 事件里做：那里才拿得到系统剪贴板里的图片。
    if (mod && key === 'v') pasteWithInputs = e.shiftKey
    if (mod && e.key.toLowerCase() === 'a') {
      e.preventDefault()
      setEdgeSelected(null)
      setSelected(new Set(nodes().map((n) => n.id)))
    }
    if (e.shiftKey && e.code === 'Digit1') fit(true)
    if ((e.shiftKey && e.code === 'Digit2') || (!mod && e.key === '.')) {
      const list = nodes().filter((n) => selected().has(n.id))
      if (list.length) fit(true, list)
    }
    if (mod && e.key === '0') {
      e.preventDefault()
      zoomAt(1)
    }
    if (mod && (e.key === '=' || e.key === '+' || e.key === '-')) {
      e.preventDefault()
      zoomAt(z() * (e.key === '-' ? 1 / 1.25 : 1.25))
    }
  }

  const removeSelected = () => {
    const ids = [...selected()]
    if (!ids.length) return
    void apply(ids.map((id) => ({ op: 'remove', id }))).then(
      (r) => r && setSelected(new Set<string>()),
    )
  }

  const copySelection = (): boolean => {
    const v = view()
    const ids = [...selected()]
    if (!v || !ids.length) return false
    clipboard = { source: structuredClone(v.doc), ids }
    return true
  }

  /**
   * 把 `source` 里的一组节点复制到这张画布：整组中心落在 `at`；`at` 为 `null` 时在原位右下错开一点（复制一份）。
   * 粘贴后选中副本。
   */
  const pasteNodes = async (
    source: CanvasDoc,
    ids: string[],
    at: { x: number; y: number } | null,
    withInputs: boolean,
  ) => {
    const v = view()
    const picked = source.nodes.filter((n) => ids.includes(n.id))
    if (!v || !picked.length) return
    const minX = Math.min(...picked.map((n) => n.x))
    const minY = Math.min(...picked.map((n) => n.y))
    const maxX = Math.max(...picked.map((n) => n.x + n.w))
    const maxY = Math.max(...picked.map((n) => n.y + n.h))
    const offset = at
      ? { dx: Math.round(at.x - (minX + maxX) / 2), dy: Math.round(at.y - (minY + maxY) / 2) }
      : { dx: 40, dy: 40 }
    const r = await apply(copyOps(source, ids, v.doc, offset, withInputs))
    if (r) {
      setEdgeSelected(null)
      setSelected(new Set(picked.flatMap((_, i) => r.refs[`$copy${i + 1}`] ?? [])))
    }
  }

  /** 粘贴：系统剪贴板里有文件（截图、复制的图片）就上传，否则粘贴本应用剪贴板里的节点。 */
  const onPaste = (e: ClipboardEvent) => {
    if (!props.active) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')) return
    const withInputs = pasteWithInputs
    pasteWithInputs = false
    const files = [...(e.clipboardData?.files ?? [])]
    if (files.length) {
      e.preventDefault()
      void uploadFiles(files, pointerAt ?? center())
      return
    }
    if (!clipboard) return
    e.preventDefault()
    void pasteNodes(clipboard.source, clipboard.ids, pointerAt ?? center(), withInputs)
  }

  /** 以画布区中心为不动点缩放到 `next`。 */
  const zoomAt = (next: number) => {
    const nz = Math.min(3, Math.max(0.1, next))
    const { w, h } = size()
    setPx(w / 2 - (w / 2 - px()) * (nz / z()))
    setPy(h / 2 - (h / 2 - py()) * (nz / z()))
    setZ(nz)
  }

  /** 按住 Space 时左键拖动是平移。 */
  let space = false
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code === 'Space') {
      space = false
      stage.classList.remove('panning')
    }
  }

  onMount(() => {
    const ro = new ResizeObserver(() => setSize({ w: stage.clientWidth, h: stage.clientHeight }))
    ro.observe(stage)
    // 滚轮要 `passive: false` 才能拦住页面滚动。
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest('.canvas-panel, .canvas-picker')) return
      e.preventDefault()
      const r = stage.getBoundingClientRect()
      const mx = e.clientX - r.left
      const my = e.clientY - r.top
      if (e.ctrlKey || e.metaKey) {
        const nz = Math.min(3, Math.max(0.1, z() * Math.exp(-e.deltaY * 0.0015)))
        setPx(mx - (mx - px()) * (nz / z()))
        setPy(my - (my - py()) * (nz / z()))
        setZ(nz)
      } else {
        setPx(px() - e.deltaX)
        setPy(py() - e.deltaY)
      }
    }
    stage.addEventListener('wheel', onWheel, { passive: false })
    // 桌面外壳里系统拖放由外壳截获、给绝对路径：画布区登记成接收方。
    if (isDesktopShell()) {
      const unregister = registerDropSink({
        hit: (pos) => {
          if (!props.active) return false
          const r = stage.getBoundingClientRect()
          return pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom
        },
        over: (on) => stage.classList.toggle('drop-over', on),
        paths: (paths, pos) => {
          if (!paths.length) return
          void importToCanvas(props.path, paths, toWorld(pos.x, pos.y)).then(
            () => {
              setFault(null)
              void load()
            },
            (e: unknown) => setFault(explainApiError(e, '没有放上画布')),
          )
        },
      })
      onCleanup(unregister)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('paste', onPaste)
    onCleanup(() => {
      ro.disconnect()
      stage.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('paste', onPaste)
    })
  })

  // ── 指针：平移、选中、拖动、框选 ──

  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement
    // 平移：中键、右键或按住 Space 的左键，在画布上任何地方都行。
    if (e.button === 1 || e.button === 2 || (e.button === 0 && space)) {
      if (target.closest('.canvas-panel, .canvas-rail, .canvas-picker, .canvas-dock')) return
      e.preventDefault()
      drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, px: px(), py: py() }
      stage.classList.add('grabbing')
      stage.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return
    if (
      target.closest(
        'button, input, select, audio, .canvas-panel, .canvas-tools, .canvas-dock, .canvas-rail, .canvas-picker, video[controls]',
      )
    )
      return
    const hit = target.closest<SVGPathElement>('.canvas-edge-hit')
    if (hit) {
      setSelected(new Set<string>())
      setEdgeSelected(hit.dataset.edge!)
      return
    }
    setEdgeSelected(null)
    const nodeEl = target.closest<HTMLElement>('[data-node]')
    if (nodeEl) {
      const id = nodeEl.dataset.node!
      let next = selected()
      if (e.shiftKey) {
        next = new Set(next)
        if (next.has(id)) (next as Set<string>).delete(id)
        else (next as Set<string>).add(id)
      } else if (!next.has(id)) next = new Set([id])
      setSelected(next)
      const start = [...next].flatMap((s) => {
        const n = byId(s)
        return n ? [{ id: n.id, ...pos(n) }] : []
      })
      drag = { mode: 'move', sx: e.clientX, sy: e.clientY, start, moved: false }
    } else {
      // 左键拖空白是框选；按住 Shift 时叠加到已有选区。
      const base = e.shiftKey ? selected() : new Set<string>()
      if (!e.shiftKey) setSelected(base)
      const r = stage.getBoundingClientRect()
      drag = { mode: 'box', sx: e.clientX - r.left, sy: e.clientY - r.top, base }
    }
    stage.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: PointerEvent) => {
    pointerAt = toWorld(e.clientX, e.clientY)
    const d = drag
    if (!d) return
    if (d.mode === 'link') {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return
      d.moved = true
      setLinking({ from: d.from, ...toWorld(e.clientX, e.clientY) })
      const over = document
        .elementFromPoint(e.clientX, e.clientY)
        ?.closest<HTMLElement>('[data-node]')?.dataset.node
      setLinkTarget(over && linkRole(d.from, over) ? over : null)
      return
    }
    if (d.mode === 'pan') {
      setPx(d.px + e.clientX - d.sx)
      setPy(d.py + e.clientY - d.sy)
      return
    }
    if (d.mode === 'move') {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return
      d.moved = true
      const dx = (e.clientX - d.sx) / z()
      const dy = (e.clientY - d.sy) / z()
      setMoving(Object.fromEntries(d.start.map((s) => [s.id, { x: s.x + dx, y: s.y + dy }])))
      return
    }
    const r = stage.getBoundingClientRect()
    const x = e.clientX - r.left
    const y = e.clientY - r.top
    const box = {
      x: Math.min(x, d.sx),
      y: Math.min(y, d.sy),
      w: Math.abs(x - d.sx),
      h: Math.abs(y - d.sy),
    }
    setMarquee(box)
    const x1 = (box.x - px()) / z()
    const y1 = (box.y - py()) / z()
    const x2 = (box.x + box.w - px()) / z()
    const y2 = (box.y + box.h - py()) / z()
    setSelected(
      new Set([
        ...d.base,
        ...nodes()
          .filter((n) => n.x < x2 && n.x + n.w > x1 && n.y < y2 && n.y + n.h > y1)
          .map((n) => n.id),
      ]),
    )
  }

  const onPointerUp = (e: PointerEvent) => {
    const d = drag
    drag = null
    stage.classList.remove('grabbing')
    setMarquee(null)
    if (d?.mode === 'link') {
      const target = linkTarget()
      setLinking(null)
      setLinkTarget(null)
      if (!d.moved) {
        setMenu({ kind: 'out', anchor: d.anchor, nodeId: d.from })
      } else if (target) {
        void connect(d.from, target)
      } else if (e.type === 'pointerup' && extendable(d.from).length) {
        const r = stage.getBoundingClientRect()
        dropAnchor.style.left = `${e.clientX - r.left}px`
        dropAnchor.style.top = `${e.clientY - r.top}px`
        setMenu({
          kind: 'out',
          anchor: dropAnchor,
          nodeId: d.from,
          at: toWorld(e.clientX, e.clientY),
        })
      }
      return
    }
    if (d?.mode !== 'move' || !d.moved) return
    const moved = moving()
    const ops: CanvasOp[] = Object.entries(moved).map(([id, p]) => ({
      op: 'update',
      id,
      x: Math.round(p.x),
      y: Math.round(p.y),
    }))
    // 松手才提交一次；回体到之前一直用本地位置，免得节点先跳回再跳过去。
    void apply(ops).then(() => setMoving({}))
  }

  /** 双击标题改名，双击内容在主区打开那个文件。 */
  const onDblClick = (e: MouseEvent) => {
    const target = e.target as HTMLElement
    const nodeEl = target.closest<HTMLElement>('[data-node]')
    if (!nodeEl) return
    const id = nodeEl.dataset.node!
    if (target.closest('.canvas-node-title')) {
      setRenaming(id)
      return
    }
    const media = view() ? mediaOf(view()!, id) : null
    if (media?.path) openFileInPanel(media.path)
  }

  // ── 从文件树或系统拖入 ──

  const onDragOver = (e: DragEvent) => {
    const dt = e.dataTransfer
    if (!dt || (!dt.types.includes(WORKSPACE_PATH_TYPE) && !dt.types.includes('Files'))) return
    e.preventDefault()
    dt.dropEffect = 'copy'
  }
  const onDrop = (e: DragEvent) => {
    const path = e.dataTransfer?.getData(WORKSPACE_PATH_TYPE)
    const files = [...(e.dataTransfer?.files ?? [])]
    if (!path && files.length) {
      // 浏览器里从系统拖入；桌面外壳里系统拖放由外壳截获，走 shell-drop。
      e.preventDefault()
      void uploadFiles(files, toWorld(e.clientX, e.clientY))
      return
    }
    if (!path) return
    e.preventDefault()
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-node]')
    const onto = target ? byId(target.dataset.node!) : undefined
    // 拖到一个缺失的文件节点上即替换它的路径。
    if (onto?.type === 'file' && view()?.states[onto.id]?.state === 'missing') {
      void apply([{ op: 'update', id: onto.id, path }])
      return
    }
    const at = toWorld(e.clientX, e.clientY)
    void apply([{ op: 'add_file', path, x: Math.round(at.x - 110), y: Math.round(at.y - 80) }])
  }

  // ── 新建与接出 ──

  /** 视野中央在画布坐标里的位置。 */
  const center = () => {
    const { w, h } = size()
    return { x: (w / 2 - px()) / z(), y: (h / 2 - py()) / z() }
  }

  const addGenerate = async (output: MediaOutput) => {
    setMenu(null)
    const r = await apply([{ op: 'add_generate', ref: '$n', output, near: center() }])
    if (r?.refs.$n) setSelected(new Set([r.refs.$n]))
  }

  /**
   * 选择框里连着选的文件：第一个放在视野中央附近的空位，之后的排在上一个右侧的空位。
   * 依次提交：前一个的回体到了才知道它的 id，并发提交的话后一个会落在视野中央、压住前一个。
   */
  let lastPicked: string | null = null
  let picks = Promise.resolve()
  const pickFile = (path: string, first: boolean) => {
    picks = picks.then(async () => {
      const after = !first && lastPicked && byId(lastPicked) ? lastPicked : null
      const r = await apply([
        { op: 'add_file', ref: '$f', path, ...(after ? { beside: after } : { near: center() }) },
      ])
      if (r?.refs.$f) lastPicked = r.refs.$f
    })
  }

  /** 从本机选的文件逐个上传：第一个放在视野中央附近的空位，之后的排在上一个右侧。有一个失败就停下并报出。 */
  const uploadFiles = async (files: File[], near = center()) => {
    let prev: string | null = null
    for (const file of files) {
      try {
        const r = await uploadToCanvas(props.path, file, prev ? { beside: prev } : { near })
        prev = r.nodeId
        setFault(null)
      } catch (e) {
        setFault(explainApiError(e, `没有传上去：${file.name}`))
        break
      }
    }
    void load()
  }

  /**
   * 生成面板里放上画布的素材：放在卡左侧、与卡中线对齐的空位（连线从左往右进卡）。
   * 本机文件先上传；回新节点的 id，没放成回 `null` 并报出原因。
   */
  const placeInput = async (
    card: CanvasNode,
    source: { path: string } | { file: File },
  ): Promise<string | null> => {
    const at = pos(card)
    const near = { x: at.x - 210, y: at.y + card.h / 2 }
    if ('path' in source) {
      const r = await apply([{ op: 'add_file', ref: '$f', path: source.path, near }])
      return r?.refs.$f ?? null
    }
    try {
      const r = await uploadToCanvas(props.path, source.file, { near })
      setFault(null)
      await load()
      return r.nodeId
    } catch (e) {
      setFault(explainApiError(e, `没有传上去：${source.file.name}`))
      return null
    }
  }

  /** 从一个节点接出一张生成卡，并把它连为输入：视频节点连成参考视频，图片连成首帧（视频）或参考（出图）。 */
  const extend = async (nodeId: string, output: MediaOutput, at?: { x: number; y: number }) => {
    setMenu(null)
    const source = byId(nodeId)
    const kind = mediaOf(view()!, nodeId).kind
    if (!source || !kind) return
    const role: MediaInputRole =
      output === 'image' ? 'reference' : kind === 'image' ? 'first_frame' : kind
    const r = await apply([
      { op: 'add_generate', ref: '$n', output, ...(at ? { near: at } : { beside: nodeId }) },
      { op: 'connect', from: nodeId, to: '$n', role },
    ])
    if (r?.refs.$n) setSelected(new Set([r.refs.$n]))
  }

  /**
   * 从 `from` 连到 `to` 时的用途；连不上回 `null`。先按素材类别与目标的模式定一个用途，
   * 再交给 core 的操作校验试一次：能连与否只有 core 一处说了算。
   */
  const linkRole = (from: string, to: string): MediaInputRole | null => {
    const v = view()
    const target = byId(to)
    const kind = v ? mediaOf(v, from).kind : null
    if (!v || !kind || target?.type !== 'generate') return null
    let role: MediaInputRole = kind === 'image' ? 'reference' : kind
    if (target.output === 'video' && kind === 'image' && modeOf(v.doc, to) === 'first_last') {
      const used = new Set(inputsOf(v.doc, to).map((e) => e.role))
      role = used.has('first_frame') ? 'last_frame' : 'first_frame'
    }
    return applyCanvasOps(v.doc, [{ op: 'connect', from, to, role }]).ok ? role : null
  }

  const connect = async (from: string, to: string) => {
    const role = linkRole(from, to)
    if (role) await apply([{ op: 'connect', from, to, role }])
  }

  /** 从连接点按下：拖出去是连线，原地松开是点击（开接出菜单）。 */
  const startLink = (e: PointerEvent, from: string) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.preventDefault()
    drag = {
      mode: 'link',
      from,
      sx: e.clientX,
      sy: e.clientY,
      moved: false,
      anchor: e.currentTarget as HTMLElement,
    }
    stage.setPointerCapture(e.pointerId)
  }

  /** 能从这个节点接出哪几类生成卡。 */
  const extendable = (nodeId: string): MediaOutput[] => {
    const kind = view() ? mediaOf(view()!, nodeId).kind : null
    return MEDIA_OUTPUTS.filter((o) =>
      o === 'image' ? kind === 'image' : o === 'video' && kind !== null,
    )
  }

  // ── 取帧 ──

  const capture = async (nodeId: string, at: FrameAt | 'current') => {
    setMenu(null)
    const media = view() ? mediaOf(view()!, nodeId) : null
    if (!media?.path) return
    const when: FrameAt = at === 'current' ? (players.get(nodeId)?.currentTime ?? 0) : at
    try {
      const blob = await captureVideoFrame(client.fileUrl(media.path), when)
      const r = await captureFrame(props.path, nodeId, frameLabel(when), blob)
      setFault(null)
      setSelected(new Set([r.nodeId]))
      void load()
    } catch (e) {
      setFault(explainApiError(e, '没有取到这一帧'))
    }
  }

  // ── 派生 ──

  const single = () => {
    const ids = [...selected()]
    return ids.length === 1 && !Object.keys(moving()).length ? byId(ids[0]!) : undefined
  }
  const isVideo = (n: CanvasNode) =>
    view() !== null &&
    mediaOf(view()!, n.id).kind === 'video' &&
    mediaOf(view()!, n.id).path !== null
  const currentOf = (n: CanvasGenerateNode) => n.versions.find((v) => v.id === n.current)
  const catalogModel = (provider: string | undefined, id: string) =>
    (modelCatalog()?.media ?? []).find((m) => m.provider === provider && m.id === id)
  const modelLabel = (n: CanvasGenerateNode): string => {
    const current = currentOf(n)
    const id = n.model ?? current?.made.model
    if (!id) return ''
    return catalogModel(n.provider ?? current?.made.provider, id)?.label ?? id
  }
  /** 生成参数里有界面名的那几项；模型已不在目录里时一项也列不出。 */
  const madeParams = (made: CanvasMade): string[] =>
    (catalogModel(made.provider, made.model)?.params ?? []).flatMap((p) => {
      if (!(p.name in made.params)) return []
      const text = paramText(p, made.params[p.name])
      return [typeof made.params[p.name] === 'boolean' ? text : `${p.label} ${text}`]
    })
  const panelAt = () => {
    const n = single()
    if (n?.type !== 'generate') return null
    const p = pos(n)
    const { w, h } = size()
    const height = tall() ? PANEL_TALL : PANEL_H
    // 画布区比面板窄时面板收到画布区宽度，否则左侧被画布区裁掉。
    const width = Math.min(PANEL_W, w - 16)
    return {
      node: n,
      width,
      left: Math.max(8, Math.min(px() + (p.x + n.w / 2) * z() - width / 2, w - width - 8)),
      top: Math.max(8, Math.min(py() + (p.y + n.h) * z() + 16, h - height - 8)),
    }
  }

  const edgePaths = () => {
    const v = view()
    if (!v) return []
    return v.doc.edges.flatMap((e) => {
      const a = byId(e.from)
      const b = byId(e.to)
      if (!a || !b) return []
      const pa = pos(a)
      const pb = pos(b)
      const x1 = pa.x + a.w
      const y1 = pa.y + a.h / 2
      const x2 = pb.x
      const y2 = pb.y + b.h / 2
      const dx = Math.max(40, (x2 - x1) / 2)
      return [
        {
          id: e.id,
          d: `M${x1} ${y1} C${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`,
          live: v.states[b.id]?.state === 'running',
          hot: selected().has(a.id) || selected().has(b.id),
          x1,
          y1,
          x2,
          y2,
        },
      ]
    })
  }

  // ── 节点 ──

  function TextPreview(p: { path: string }) {
    const [text] = createResource(
      () => p.path,
      (path) =>
        client
          .api<{ content?: string }>(`/api/files/preview?path=${encodeURIComponent(path)}`)
          .then((r) => (r.content ?? '').slice(0, 600)),
    )
    return <div class="canvas-text">{text() ?? ''}</div>
  }

  /** `w` 是节点的画布宽度，图片按它乘当前缩放与设备像素比解码。 */
  function Media(p: {
    nodeId: string
    path: string
    kind: MediaOutput | null
    w: number
    controls: boolean
  }) {
    const [length, setLength] = createSignal<number | null>(null)
    return (
      <Switch
        fallback={
          <Show
            when={TEXT_RE.test(p.path)}
            fallback={
              <div class="canvas-media canvas-other">
                <IconFile size={20} />
                <span>{p.path.split('/').pop()}</span>
              </div>
            }
          >
            <TextPreview path={p.path} />
          </Show>
        }
      >
        <Match when={p.kind === 'image'}>
          <div class="canvas-media">
            <Bitmap src={client.fileUrl(p.path)} width={p.w * z() * window.devicePixelRatio} />
          </div>
        </Match>
        <Match when={p.kind === 'video'}>
          <div class="canvas-media">
            {/* 选中时才挂播放器：播放、拖进度与「当前帧」都要它；平时只画封面。 */}
            <Show
              when={p.controls}
              fallback={
                <Bitmap
                  kind="video"
                  src={client.fileUrl(p.path)}
                  width={p.w * z() * window.devicePixelRatio}
                  onDuration={setLength}
                />
              }
            >
              <video
                ref={(el) => {
                  players.set(p.nodeId, el)
                  onCleanup(() => players.delete(p.nodeId))
                }}
                src={`${client.fileUrl(p.path)}#t=0.1`}
                preload="metadata"
                muted
                playsinline
                crossOrigin="anonymous"
                controls
                onLoadedMetadata={(e) => setLength(e.currentTarget.duration)}
              />
            </Show>
            <Show when={!p.controls && length()}>
              {(s) => (
                <span class="canvas-badge" style={{ right: '6px', bottom: '6px' }}>
                  {clock(s() * 1000)}
                </span>
              )}
            </Show>
          </div>
        </Match>
        <Match when={p.kind === 'audio'}>
          <div class="canvas-media canvas-other">
            <IconAudio size={20} />
            <audio src={client.fileUrl(p.path)} controls preload="none" />
          </div>
        </Match>
      </Switch>
    )
  }

  /**
   * 按 id 取节点：每次写操作回来的文档是新对象，按对象挂载的话每改一处全部节点重建、图片全部重新解码。
   * 节点被删的那次更新里，组件内的计算可能先于列表重算，这时沿用最后一份。
   */
  function Node(p: { id: string }) {
    let last!: CanvasNode
    const n = () => {
      last = byId(p.id) ?? last
      return last
    }
    const st = () => view()?.states[n().id]
    const at = () => pos(n())
    const isSelected = () => selected().has(n().id)
    const kind = (): MediaOutput | 'text' | null =>
      n().type === 'generate'
        ? (n() as CanvasGenerateNode).output
        : TEXT_RE.test((n() as { path: string }).path)
          ? 'text'
          : canvasMediaOf(n())
    const commitName = (value: string) => {
      setRenaming(null)
      const name = value.trim()
      if (name === displayNameOf(n())) return
      if (n().type === 'generate' && !name) return
      void apply([{ op: 'update', id: n().id, name: name || null }])
    }

    return (
      <div
        class="canvas-node"
        classList={{ selected: isSelected(), 'link-target': linkTarget() === n().id }}
        data-node={n().id}
        style={{
          left: `${at().x}px`,
          top: `${at().y}px`,
          width: `${n().w}px`,
          height: `${n().h}px`,
        }}
      >
        <div class="canvas-node-title">
          <KindIcon kind={kind()} />
          <Show when={renaming() === n().id} fallback={<span>{displayNameOf(n())}</span>}>
            <input
              value={displayNameOf(n())}
              ref={(el) => requestAnimationFrame(() => el.select())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName(e.currentTarget.value)
                if (e.key === 'Escape') setRenaming(null)
              }}
              onBlur={(e) => commitName(e.currentTarget.value)}
            />
          </Show>
          <Show when={n().type === 'generate' && modelLabel(n() as CanvasGenerateNode)}>
            {(label) => <span class="model">{label()}</span>}
          </Show>
        </div>

        <Show
          when={n().type === 'generate'}
          fallback={
            <Show
              when={st()?.state !== 'missing'}
              fallback={
                <div class="canvas-missing">
                  <span class="label">缺失</span>
                  <button
                    class="canvas-ghost"
                    type="button"
                    onClick={() => void apply([{ op: 'remove', id: n().id }])}
                  >
                    移除
                  </button>
                </div>
              }
            >
              <Media
                nodeId={n().id}
                path={(n() as { path: string }).path}
                kind={canvasMediaOf(n())}
                w={n().w}
                controls={isSelected()}
              />
            </Show>
          }
        >
          <GenerateBody node={n() as CanvasGenerateNode} selected={isSelected()} />
        </Show>

        <Show when={n().type === 'generate' && (n() as CanvasGenerateNode).output !== 'audio'}>
          <button
            class="canvas-port in"
            type="button"
            aria-label="添加素材"
            onClick={() => setSelected(new Set([n().id]))}
          >
            <IconPlus stroke={1.8} />
          </button>
        </Show>
        <Show when={extendable(n().id).length}>
          <button
            class="canvas-port out"
            type="button"
            aria-label="接出生成"
            onPointerDown={(e) => startLink(e, n().id)}
            onClick={(e) => {
              // 指针的按下与松开由 startLink 与 onPointerUp 处理；这里只接键盘触发的点击。
              if (e.detail === 0) setMenu({ kind: 'out', anchor: e.currentTarget, nodeId: n().id })
            }}
          >
            <IconPlus stroke={1.8} />
          </button>
        </Show>
      </div>
    )
  }

  function GenerateBody(p: { node: CanvasGenerateNode; selected: boolean }) {
    const st = () => view()?.states[p.node.id]
    const running = () => {
      const s = st()
      return s?.state === 'running' ? s : null
    }
    const pending = () => {
      const s = st()
      return s?.state === 'pending' ? s : null
    }
    const failed = () => {
      const s = st()
      return s?.state === 'failed' && !p.node.versions.length ? s : null
    }
    const current = () => currentOf(p.node)
    const index = () => p.node.versions.findIndex((v) => v.id === p.node.current) + 1
    return (
      <Switch
        fallback={
          <div class="canvas-media canvas-slot empty">
            <KindIcon kind={p.node.output} size={22} stroke={1.6} />
          </div>
        }
      >
        <Match when={running()}>
          {(s) => (
            <div class="canvas-media canvas-slot">
              <div class="canvas-live">
                <span class="canvas-snake">
                  <span />
                  <span />
                  <span />
                  <span />
                  <span />
                </span>
                <span class="time">{clock(now() - s().startedAt)}</span>
              </div>
            </div>
          )}
        </Match>
        <Match when={pending()}>
          {(s) => (
            <div class="canvas-media canvas-slot">
              <button
                class="canvas-ghost"
                type="button"
                onClick={() => retrieve(p.node.id, s().version)}
              >
                取回
              </button>
            </div>
          )}
        </Match>
        <Match when={failed()}>
          {(s) => (
            <div class="canvas-media canvas-slot">
              <KindIcon kind={p.node.output} size={22} />
              <span class="error">{s().message}</span>
            </div>
          )}
        </Match>
        <Match when={st()?.state === 'missing'}>
          <div class="canvas-missing">
            <span class="label">缺失</span>
          </div>
        </Match>
        <Match when={current()}>
          {(v) => (
            <div class="canvas-media" style={{ overflow: 'hidden' }}>
              <Media
                nodeId={p.node.id}
                path={v().path}
                kind={p.node.output}
                w={p.node.w}
                controls={p.selected}
              />
              <Show when={p.node.versions.length > 1}>
                <button
                  class="canvas-badge version"
                  type="button"
                  onClick={(e) =>
                    setMenu({ kind: 'version', anchor: e.currentTarget, nodeId: p.node.id })
                  }
                >
                  {index()}
                  <IconChevron size={10} />
                </button>
              </Show>
            </div>
          )}
        </Match>
      </Switch>
    )
  }

  // ── 选中工具条 ──

  const tools = () => {
    const n = single()
    if (!n) return null
    const items: { label: string; kind: 'frame' | 'made' | 'open' }[] = []
    if (isVideo(n)) items.push({ label: '取帧', kind: 'frame' })
    if (n.type === 'generate' && currentOf(n)) items.push({ label: '生成参数', kind: 'made' })
    if (view() && mediaOf(view()!, n.id).path) items.push({ label: '打开', kind: 'open' })
    if (!items.length) return null
    const p = pos(n)
    return { node: n, items, left: px() + (p.x + n.w / 2) * z(), top: py() + p.y * z() - 26 }
  }

  const madeOf = (nodeId: string) => {
    const n = byId(nodeId)
    return n?.type === 'generate' ? currentOf(n)?.made : undefined
  }

  return (
    <div
      class="canvas-stage"
      ref={stage}
      role="application"
      aria-label="画布"
      style={{
        '--z': String(z()),
        '--grid': `${grid()}px`,
        '--px': `${px()}px`,
        '--py': `${py()}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        if (!drag) pointerAt = null
      }}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onDblClick={onDblClick}
      // 画布里不起浏览器自带的拖拽：选中的文字或图片被拖起来后指针事件被接管，节点拖不动、光标变成禁止。
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <Show when={view() && !broken()} fallback={<div class="canvas-note">{broken() ?? ''}</div>}>
        <svg
          class="canvas-edges"
          aria-hidden="true"
          width="1"
          height="1"
          style={{ transform: `translate(${px()}px, ${py()}px) scale(${z()})` }}
        >
          <defs>
            <For each={edgePaths().filter((e) => e.live)}>
              {(e) => (
                <linearGradient
                  id={`canvas-live-${e.id}`}
                  gradientUnits="userSpaceOnUse"
                  x1={e.x1}
                  y1={e.y1}
                  x2={e.x2}
                  y2={e.y2}
                >
                  <stop offset="0" stop-color="#ddd6fe" />
                  <stop offset=".3" stop-color="#a78bfa" />
                  <stop offset=".62" stop-color="#7c3aed" />
                  <stop offset="1" stop-color="#5b21b6" />
                </linearGradient>
              )}
            </For>
          </defs>
          <For each={edgePaths()}>
            {(e) => (
              <>
                <path
                  d={e.d}
                  classList={{
                    live: e.live,
                    hot: !e.live && e.hot,
                    selected: edgeSelected() === e.id,
                  }}
                  // 梯度写在内联样式里：写成 `stroke` 属性会被 `.canvas-edges path` 的描边色覆盖。
                  style={e.live ? { stroke: `url(#canvas-live-${e.id})` } : {}}
                />
                <path class="canvas-edge-hit" data-edge={e.id} d={e.d} />
              </>
            )}
          </For>
          <Show when={linking()}>
            {(l) => {
              const d = () => {
                const a = byId(l().from)
                if (!a) return ''
                const p = pos(a)
                const x1 = p.x + a.w
                const y1 = p.y + a.h / 2
                const dx = Math.max(40, (l().x - x1) / 2)
                return `M${x1} ${y1} C${x1 + dx} ${y1} ${l().x - dx} ${l().y} ${l().x} ${l().y}`
              }
              return <path class="canvas-edge-draft" d={d()} />
            }}
          </Show>
        </svg>
        <div
          class="canvas-world"
          style={{ transform: `translate(${px()}px, ${py()}px) scale(${z()})` }}
        >
          <For each={nodes().map((n) => n.id)}>{(id) => <Node id={id} />}</For>
        </div>

        <Show when={tools()}>
          {(t) => (
            <div class="canvas-tools" style={{ left: `${t().left}px`, top: `${t().top}px` }}>
              <For each={t().items}>
                {(item) => (
                  <button
                    type="button"
                    aria-expanded={
                      item.kind !== 'open' &&
                      menu()?.kind === item.kind &&
                      (menu() as { nodeId?: string }).nodeId === t().node.id
                    }
                    onClick={(e) => {
                      if (item.kind === 'open') {
                        const media = mediaOf(view()!, t().node.id)
                        if (media.path) openFileInPanel(media.path)
                        return
                      }
                      setMenu({ kind: item.kind, anchor: e.currentTarget, nodeId: t().node.id })
                    }}
                  >
                    {item.label}
                    <Show when={item.kind === 'frame'}>
                      <IconChevron size={10} />
                    </Show>
                  </button>
                )}
              </For>
            </div>
          )}
        </Show>

        <Show when={panelAt()}>
          {(at) => (
            <GeneratePanel
              view={view()!}
              node={at().node}
              state={view()?.states[at().node.id]}
              left={at().left}
              width={at().width}
              top={at().top}
              tall={tall()}
              onTall={setTall}
              apply={(ops) => apply(ops).then((r) => r !== null)}
              run={(ops) => run(at().node.id, ops)}
              place={(source) => placeInput(at().node, source)}
            />
          )}
        </Show>
      </Show>

      <Show when={marquee()}>
        {(m) => (
          <div
            class="canvas-marquee"
            style={{
              left: `${m().x}px`,
              top: `${m().y}px`,
              width: `${m().w}px`,
              height: `${m().h}px`,
            }}
          />
        )}
      </Show>

      <Show when={fault()}>{(f) => <div class="canvas-fault">{f()}</div>}</Show>

      <Rail
        outputs={[...MEDIA_OUTPUTS]}
        disabled={!view() || !!broken()}
        accepts={(p) =>
          canvasMediaOf({ id: '', type: 'file', path: p, x: 0, y: 0, w: 0, h: 0 }) !== null ||
          TEXT_RE.test(p)
        }
        onGenerate={(o) => void addGenerate(o)}
        onPick={pickFile}
        onUpload={(files) => void uploadFiles(files)}
      />

      <span class="canvas-drop-anchor" ref={dropAnchor} />

      <div class="canvas-dock">
        <button class="zoom" type="button" onClick={() => fit(true)}>
          {Math.round(z() * 100)}%
        </button>
      </div>

      <Show when={menu()}>
        {(m) => (
          <Switch>
            <Match when={m().kind === 'made'}>
              <Show when={madeOf((m() as { nodeId: string }).nodeId)}>
                {(made) => (
                  <AnchoredMenu class="canvas-made" anchor={m().anchor}>
                    <dl>
                      <dt>提示词</dt>
                      <dd>{made().prompt || '（空）'}</dd>
                      <dt>模型</dt>
                      <dd>{catalogModel(made().provider, made().model)?.label ?? made().model}</dd>
                      <Show when={madeParams(made()).length}>
                        <dt>参数</dt>
                        <dd>{madeParams(made()).join(' · ')}</dd>
                      </Show>
                      <Show when={made().inputs.length}>
                        <dt>输入</dt>
                        <dd>
                          {made()
                            .inputs.map((i) => `${ROLE_LABEL[i.role]} ${i.path}`)
                            .join('\n')}
                        </dd>
                      </Show>
                      <dt>时间</dt>
                      <dd>{madeAt(made().at)}</dd>
                    </dl>
                  </AnchoredMenu>
                )}
              </Show>
            </Match>
            <Match when={true}>
              <AnchoredMenu class="canvas-menu" anchor={m().anchor}>
                <Switch>
                  <Match when={m().kind === 'frame'}>
                    <button
                      type="button"
                      onClick={() => void capture((m() as { nodeId: string }).nodeId, 'first')}
                    >
                      首帧
                    </button>
                    <button
                      type="button"
                      onClick={() => void capture((m() as { nodeId: string }).nodeId, 'last')}
                    >
                      尾帧
                    </button>
                    <button
                      type="button"
                      onClick={() => void capture((m() as { nodeId: string }).nodeId, 'current')}
                    >
                      当前帧
                    </button>
                  </Match>
                  <Match when={m().kind === 'out'}>
                    <For each={extendable((m() as { nodeId: string }).nodeId)}>
                      {(o) => (
                        <button type="button" onClick={() => void extend(m().nodeId, o, m().at)}>
                          <KindIcon kind={o} size={14} />
                          {OUTPUT_LABEL[o]}
                        </button>
                      )}
                    </For>
                  </Match>
                  <Match when={m().kind === 'version'}>
                    <For
                      each={(() => {
                        const n = byId((m() as { nodeId: string }).nodeId)
                        return n?.type === 'generate' ? n.versions : []
                      })()}
                    >
                      {(v, i) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={
                            v.id ===
                            (
                              byId((m() as { nodeId: string }).nodeId) as
                                | CanvasGenerateNode
                                | undefined
                            )?.current
                          }
                          onClick={() => {
                            // 先取节点 id 再收菜单：收起之后 `m()` 已失效。
                            const id = (m() as { nodeId: string }).nodeId
                            setMenu(null)
                            void apply([{ op: 'update', id, current: v.id }])
                          }}
                        >
                          {i() + 1} · {madeAt(v.made.at)}
                        </button>
                      )}
                    </For>
                  </Match>
                </Switch>
              </AnchoredMenu>
            </Match>
          </Switch>
        )}
      </Show>
      <Show when={!view() && !broken()}>
        <div class="canvas-note">
          <IconCanvas size={20} />
        </div>
      </Show>
    </div>
  )
}
