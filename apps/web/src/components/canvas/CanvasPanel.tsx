/**
 * 画布页：`*.canvas.json` 的查看与编辑。
 *
 * 画布文件与节点状态以服务端为准（`readCanvas`）：文件快照序号或画布事件序号变化时重新读取，
 * 每次修改提交一批操作，响应体即应用后的画布。本地只额外保存两项：视口（不保存到文件）与拖动中的位置。
 * 拖动中的节点在松开指针提交之前始终使用本地位置，其间的重新读取不改变它的位置。
 *
 * 渲染使用 DOM + CSS transform 实现平移缩放，用一层 SVG 绘制连线：节点中有播放器，面板中有输入框。
 */

import {
  applyCanvasOps,
  blankBox,
  type CanvasDoc,
  type CanvasGenerateNode,
  type CanvasNode,
  type CanvasOp,
  type CanvasTimelineNode,
  type CanvasView,
  canvasFileKind,
  canvasMediaOf,
  copyOps,
  displayNameOf,
  GENERATE_OUTPUTS,
  type GenerateOutput,
  inputsOf,
  type MediaInputRole,
  modeOf,
} from '@qywork/core'
import {
  createEffect,
  createMemo,
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
import { Portal } from 'solid-js/web'
import { readSession, SET_CODEC, sessionSignal } from '../../lib/session.ts'
import {
  absPath,
  type CanvasEdit,
  cancelCard,
  captureFrame,
  client,
  editCanvas,
  ensureModelCatalog,
  explainApiError,
  exportAbort,
  exportFinish,
  exportStart,
  exportWrite,
  importToCanvas,
  isDesktopShell,
  modelCatalog,
  openFileInPanel,
  readCanvas,
  registerDropSink,
  restoreCanvas,
  retrieveCard,
  revealFile,
  runCard,
  state,
  uploadToCanvas,
  WORKSPACE_PATH_TYPE,
  workspace,
} from '../../lib/store/index.ts'
import { AnchoredMenu } from '../AnchoredMenu.tsx'
import { IconCanvas, IconCheck, IconChevron, IconFile, IconPlus, IconScissors } from '../Icons.tsx'
import { type ArtLive, ArtView } from './ArtView.tsx'
import { pngOf, recordArt } from './art.ts'
import { Bitmap } from './Bitmap.tsx'
import { dismissOnOutside } from './dismiss.ts'
import { captureVideoFrame, frameLabel } from './frame.ts'
import { GeneratePanel, mediaOf } from './GeneratePanel.tsx'
import { KindIcon, OUTPUT_LABEL } from './kinds.tsx'
import { AudioPlayer, clock, FrameBar, type PlayerHandle, VideoPlayer } from './Player.tsx'
import { Rail } from './Rail.tsx'
import { renderTimeline } from './render.ts'
import { SourcePicker } from './SourcePicker.tsx'
import { boundsOf, type Guide, snap } from './snap.ts'
import { Timeline } from './Timeline.tsx'
import { gapAt, insertClips, metaOf, sessionOf, splitAt, withoutClip } from './timeline.ts'

const PANEL_W = 480
/** Art 录制的时长选项（秒）。 */
const RECORD_SECONDS = [5, 10] as const

/**
 * 右键点击的对象：节点作用于选区（点击的节点不在选区中时先只选中它），空白处作用于点击位置；
 * 时间线上的片段（`clip`）记录片段序号与指针处的成片时刻 `t`。
 */
type ContextTarget =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'blank' }
  | { kind: 'clip'; id: string; index: number; t: number }

/** 从片段推导出的「视频 → 时间线」连线：id 由该前缀、时间线 id 与视频节点 id 组成。画布 id 不含冒号，不会冲突。 */
const CLIP_LINK = 'clip:'
/** 拖动节点时的吸附范围（屏幕像素）：按缩放换算为画布单位，缩放后吸附距离不变。 */
const SNAP = 6

/**
 * `at`：从连接点拖到空白处松开时新卡片的输入端位于该点；右键菜单中的粘贴、新建与上传放在该点（画布坐标）。
 * 右键菜单（`context`）的 `nodeId` 为空字符串，作用对象在 `target` 中。
 * 时间线的「+」（`clip`）：选中的视频插入第 `gap` 个间隙。
 */
type Menu = {
  kind: 'frame' | 'out' | 'version' | 'context' | 'clip' | 'record'
  anchor: HTMLElement
  nodeId: string
  at?: { x: number; y: number }
  target?: ContextTarget
  gap?: number
}

type Drag =
  /** `context`：按下右键开始的平移；松开时未拖动则弹出右键菜单。 */
  | {
      mode: 'pan'
      sx: number
      sy: number
      px: number
      py: number
      context?: ContextTarget
    }
  | {
      mode: 'move'
      sx: number
      sy: number
      start: { id: string; x: number; y: number }[]
      moved: boolean
    }
  | { mode: 'box'; sx: number; sy: number; base: ReadonlySet<string> }
  | { mode: 'link'; from: string; sx: number; sy: number; moved: boolean; anchor: HTMLElement }

/** 各画布共用的剪贴板：复制时的完整文档与选中的节点。仅在本应用内有效，跨画布粘贴要求文件位于同一工作区。 */
let clipboard: { source: CanvasDoc; ids: string[] } | null = null

/** 版本的生成时间：当天只显示时分，非当天加上月日。 */
function madeAt(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return d.toDateString() === new Date().toDateString()
    ? hm
    : `${d.getMonth() + 1}/${d.getDate()} ${hm}`
}

export default function CanvasPanel(props: { path: string; active: boolean }) {
  void ensureModelCatalog()
  /** 本页记录的键前缀。视口、选中、全屏中的时间线与面板展开态按项目与画布文件记录，刷新后恢复。 */
  const key = `qywork.canvas:${workspace()?.id ?? ''}:${props.path}`
  const [view, setView] = createSignal<CanvasView | null>(null)
  /** 无法读取画布时的原因（格式错误、文件已删除）。此时不发送任何写操作。 */
  const [broken, setBroken] = createSignal<string | null>(null)
  /** 最近一次操作失败的原文，下一次操作成功时清空。 */
  const [fault, setFault] = createSignal<string | null>(null)
  const [z, setZ] = sessionSignal(`${key}.z`, 1)
  const [px, setPx] = sessionSignal(`${key}.px`, 40)
  const [py, setPy] = sessionSignal(`${key}.py`, 60)
  /** 画布区的实际尺寸，由 ResizeObserver 写入；尚未测得时为 0。 */
  const [size, setSize] = createSignal({ w: 0, h: 0 })
  const [selected, setSelected] = sessionSignal<ReadonlySet<string>>(
    `${key}.selected`,
    new Set(),
    SET_CODEC,
  )
  const [moving, setMoving] = createSignal<Readonly<Record<string, { x: number; y: number }>>>({})
  const [marquee, setMarquee] = createSignal<{ x: number; y: number; w: number; h: number } | null>(
    null,
  )
  const [renaming, setRenaming] = createSignal<string | null>(null)
  /** 选中的连线。与选中的节点互斥。 */
  const [edgeSelected, setEdgeSelected] = sessionSignal<string | null>(`${key}.edge`, null)
  /** 从连接点拖出的连线：起点节点与指针位置（画布坐标），以及当前指向的可连接目标。 */
  const [linking, setLinking] = createSignal<{ from: string; x: number; y: number } | null>(null)
  const [linkTarget, setLinkTarget] = createSignal<string | null>(null)
  /** 拖动节点时吸附到的对齐线（画布坐标），松开指针时清空。 */
  const [guides, setGuides] = createSignal<Guide[]>([])
  let dropAnchor!: HTMLSpanElement
  /** 指针最近在画布区中的位置（画布坐标）；粘贴与拖入的内容放在此处，指针不在画布区时放在视野中央。 */
  let pointerAt: { x: number; y: number } | null = null
  /** 按下 Ctrl+Shift+V 时为真，随后的 paste 事件同时复制外部输入连线。 */
  let pasteWithInputs = false
  const [menu, setMenu] = createSignal<Menu | null>(null)
  const [tall, setTall] = sessionSignal(`${key}.tall`, false)
  const [now, setNow] = createSignal(Date.now())
  /** 选中的视频节点的播放器；取帧条读写它的时刻。 */
  const players = new Map<string, PlayerHandle>()
  /** 单独选中的 Art 节点的实时页面；截图与录制经由它执行。 */
  const arts = new Map<string, ArtLive>()
  /** 全屏编辑中的时间线。全屏打开时画布的按键处理只保留撤销与重做。 */
  const [fullscreen, setFullscreen] = sessionSignal<string | null>(`${key}.fullscreen`, null)
  /** 导出中的时间线、录制中的 Art 节点与进度（0–1）。 */
  const [exports, setExports] = createSignal<Readonly<Record<string, number>>>({})
  const exportAborts = new Map<string, AbortController>()
  /** 拖动视频节点时指针下的时间线：松开指针时把这些视频加入其轨道。 */
  const [clipTarget, setClipTarget] = createSignal<string | null>(null)
  let stage!: HTMLDivElement
  /** 有视口记录（刷新前的视口）时不执行首次适配。 */
  let fitted = readSession(`${key}.z`) !== undefined
  let drag: Drag | null = null

  dismissOnOutside(menu, () => setMenu(null))

  // ── 读取与写入 ──

  /** 只采纳最后一次：连续重新读取时先发出的请求可能后返回；读写共用一个序号，按发出顺序计算（见 `write`）。 */
  let seq = 0
  const load = async () => {
    const mine = ++seq
    try {
      const next = await readCanvas(props.path)
      if (mine !== seq) return
      setView(next)
      setBroken(null)
    } catch (e) {
      if (mine === seq) setBroken(explainApiError(e, '无法打开画布'))
    }
  }
  createEffect(
    on(
      () => [props.path, state.fileVersion, state.canvasVersion] as const,
      () => void load(),
    ),
  )

  /**
   * 写操作的响应体：发出时占用序号，返回时只有在此后未发出新的读取时才采纳。
   * 不要改为返回时才占用序号：那样会作废在写操作之后发起、内容更新的读取（例如生成中平台报告状态引起的
   * 重新读取），画布停留在旧状态，直到下一次变化。
   */
  const write = async <T extends CanvasView>(request: Promise<T>): Promise<T> => {
    const mine = ++seq
    const next = await request
    if (mine === seq) setView(() => next)
    setFault(null)
    return next
  }

  /**
   * 本页发起的编辑：每一步记录修改前后两份文档的指纹。撤销恢复修改前的文档，重做恢复修改后的文档，
   * 由服务端核对当前文件仍是记录中的那一份。上传、拖入、取帧与生成结果写回不进入栈。
   */
  const undoStack: CanvasEdit['step'][] = []
  const redoStack: CanvasEdit['step'][] = []
  /** 本页最近一次编辑：撤销与重做先等待其返回，否则松开指针后立即撤销时该步尚未进入撤销栈，撤销无效。 */
  let editing: Promise<unknown> = Promise.resolve()

  const apply = (ops: CanvasOp[]): Promise<CanvasEdit | null> => {
    const job = (async () => {
      if (broken()) return null
      try {
        const next = await write(editCanvas(props.path, ops))
        if (next.step.before !== next.step.after) {
          undoStack.push(next.step)
          if (undoStack.length > 100) undoStack.shift()
          redoStack.length = 0
        }
        return next
      } catch (e) {
        setFault(explainApiError(e, '修改失败'))
        return null
      }
    })()
    editing = job
    return job
  }

  /** 撤销（`back` 为真）或重做一步。服务端拒绝时清空两个栈：文件已不再对应栈中记录的历史。 */
  const travel = async (back: boolean) => {
    await editing
    const from = back ? undoStack : redoStack
    const to = back ? redoStack : undoStack
    const step = from.pop()
    if (!step) return
    try {
      await write(
        restoreCanvas(props.path, back ? step.after : step.before, back ? step.before : step.after),
      )
      to.push(step)
    } catch (e) {
      undoStack.length = 0
      redoStack.length = 0
      setFault(explainApiError(e, back ? '撤销失败' : '重做失败'))
    }
  }

  const run = (nodeId: string, ops: CanvasOp[]) => {
    write(runCard(props.path, nodeId, ops)).catch((e: unknown) =>
      setFault(explainApiError(e, '无法开始生成')),
    )
  }

  /** 停止：无法撤回时用一句话说明照常计费；撤回成功时由 `canvas.run` 事件刷新，卡片恢复到本次生成之前。 */
  const cancel = (nodeId: string) =>
    cancelCard(props.path, nodeId).then(
      (outcome) => {
        if (outcome === 'started') setFault('已开始生成，平台不支持中途取消，完成后照常计费')
        else if (outcome === 'unsupported') setFault('该平台不支持取消，完成后照常计费')
      },
      (e: unknown) => {
        setFault(explainApiError(e, '取消失败'))
      },
    )

  const retrieve = (nodeId: string, version?: string) => {
    write(retrieveCard(props.path, nodeId, version)).catch((e: unknown) =>
      setFault(explainApiError(e, '无法开始取回')),
    )
  }

  // 只在开始与全部结束时启动或停止计时；状态报告与其他画布更新不重置一秒的间隔。
  const hasRunning = createMemo(() =>
    Object.values(view()?.states ?? {}).some((s) => s.state === 'running'),
  )
  createEffect(() => {
    if (!hasRunning()) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  // ── 视口 ──

  const nodes = () => view()?.doc.nodes ?? []
  const byId = (id: string) => nodes().find((n) => n.id === id)
  const pos = (n: CanvasNode) => moving()[n.id] ?? { x: n.x, y: n.y }
  /** 屏幕上的网格点距接近 24px：画布点距取 20 × 2ⁿ，n 取使屏幕点距最接近 24px 的值。 */
  const grid = () => {
    const n = Math.max(-2, Math.min(6, Math.round(Math.log2(24 / (20 * z())))))
    return 20 * 2 ** n * z()
  }
  const toWorld = (clientX: number, clientY: number) => {
    const r = stage.getBoundingClientRect()
    return { x: (clientX - r.left - px()) / z(), y: (clientY - r.top - py()) / z() }
  }

  /** 使 `list`（缺省为全部节点）整体位于视野内。 */
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

  // 首次适配等待画布区测得尺寸：标签页在后台打开时尺寸为 0，按缺省尺寸计算的视口与实际不符。
  createEffect(() => {
    if (fitted || !view() || size().w === 0) return
    fitted = true
    fit(false)
  })

  /**
   * 删除选中的节点。监听挂在窗口上，只在本页可见且按键不在输入框或编辑框中时生效：
   * 画布本身不获取焦点，点击画布之后焦点仍可能在其他元素上。
   */
  const onKeyDown = (e: KeyboardEvent) => {
    if (!props.active) return
    const target = e.target instanceof Element ? e.target : null
    if (target?.closest('input, textarea, select, [contenteditable="true"], [contenteditable=""]'))
      return
    if (fullscreen()) {
      const mod = e.ctrlKey || e.metaKey
      const key = e.key.toLowerCase()
      if (mod && (key === 'z' || key === 'y')) {
        e.preventDefault()
        void travel(key === 'z' && !e.shiftKey)
      }
      return
    }
    if (e.code === 'Space') {
      // 焦点可能仍在窗口或面板按钮上；长按产生的重复事件也必须拦截，否则松开按键会触发按钮。
      e.preventDefault()
      space = true
      stage.classList.add('panning')
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const edge = edgeSelected()
      if (edge) {
        e.preventDefault()
        void cutLink(edge).then((ok) => ok && setEdgeSelected(null))
        return
      }
      if (!selected().size) return
      e.preventDefault()
      if (removeSelectedClip()) return
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
    // 粘贴本身在 paste 事件中处理：只有在该事件中才能取得系统剪贴板中的图片。
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

  /** 选中的是一条时间线且其轨道上选中了片段时，删除该片段。已删除时返回 true。 */
  const removeSelectedClip = (): boolean => {
    const n = single()
    const index = n?.type === 'timeline' ? sessionOf(n.id)?.selected() : null
    if (n?.type !== 'timeline' || index === null || index === undefined) return false
    sessionOf(n.id)?.select(null)
    void apply([{ op: 'update', id: n.id, clips: withoutClip(n.clips, index) }])
    return true
  }

  /** 断开一条连线。对于从片段推导出的连线，删除时间线中引用该视频文件的全部片段。成功时返回 true。 */
  const cutLink = async (id: string): Promise<boolean> => {
    if (!id.startsWith(CLIP_LINK)) return (await apply([{ op: 'remove', id }])) !== null
    const [timeline, source] = id.slice(CLIP_LINK.length).split(':')
    const n = byId(timeline!)
    const path = view() ? mediaOf(view()!, source!).path : null
    if (n?.type !== 'timeline' || !path) return false
    sessionOf(n.id)?.select(null)
    const r = await apply([
      { op: 'update', id: n.id, clips: n.clips.filter((c) => c.path !== path) },
    ])
    return r !== null
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
   * 把 `source` 中的一组节点复制到当前画布：整组中心位于 `at`；`at` 为 `null` 时放在原位置右下方稍作偏移（创建副本）。
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

  /** 粘贴：系统剪贴板中有文件（截图、复制的图片）时上传，否则粘贴本应用剪贴板中的节点。 */
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
  const releaseSpace = () => {
    space = false
    stage.classList.remove('panning')
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.code !== 'Space' || !space) return
    e.preventDefault()
    releaseSpace()
  }

  onMount(() => {
    const ro = new ResizeObserver(() => setSize({ w: stage.clientWidth, h: stage.clientHeight }))
    ro.observe(stage)
    // 滚轮监听必须设为 `passive: false` 才能阻止页面滚动。
    const onWheel = (e: WheelEvent) => {
      if ((e.target as Element).closest('.canvas-panel, .canvas-picker, .canvas-media-notice'))
        return
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
    // 桌面外壳中的系统拖放由外壳截获并提供绝对路径：画布区注册为接收方。
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
          // 拖放到时间线上：先添加到画布，再把其中的视频插入轨道。
          const into = timelineAt(pos.x, pos.y)
          const gap = into ? gapFor(into, pos.x, onTracksAt(into, pos.x, pos.y)) : undefined
          void importToCanvas(props.path, paths, toWorld(pos.x, pos.y)).then(
            async ({ ids }) => {
              setFault(null)
              await load()
              if (!into) return
              const added = ids.flatMap((id) => {
                const n = byId(id)
                return n?.type === 'file' ? [n.path] : []
              })
              await addClips(into, added, gap)
            },
            (e: unknown) => setFault(explainApiError(e, '无法添加到画布')),
          )
        },
      })
      onCleanup(unregister)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', releaseSpace)
    window.addEventListener('paste', onPaste)
    onCleanup(() => {
      ro.disconnect()
      stage.removeEventListener('wheel', onWheel)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', releaseSpace)
      window.removeEventListener('paste', onPaste)
    })
  })

  // ── 指针：平移、选中、拖动、框选 ──

  const onPointerDown = (e: PointerEvent) => {
    const target = e.target as HTMLElement
    // 平移：中键、右键或按住 Space 时的左键，在画布任意位置均可。
    if (e.button === 1 || e.button === 2 || (e.button === 0 && space)) {
      if (target.closest('.canvas-panel, .canvas-rail, .canvas-picker, .canvas-dock')) return
      e.preventDefault()
      drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, px: px(), py: py() }
      if (e.button === 2 && !space) drag.context = contextOf(target)
      stage.classList.add('grabbing')
      stage.setPointerCapture(e.pointerId)
      return
    }
    if (e.button !== 0) return
    if (
      target.closest(
        'button, input, select, audio, .canvas-panel, .canvas-tools, .canvas-frame-bar, .canvas-player, .canvas-dock, .canvas-rail, .canvas-picker',
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
      // 左键拖动空白处为框选；按住 Shift 时叠加到已有选区。
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
      setLinkTarget(over && (linkRole(d.from, over) || clipsInto(d.from, over)) ? over : null)
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
      const ids = new Set(d.start.map((s) => s.id))
      const boxes = d.start.flatMap((s) => {
        const n = byId(s.id)
        return n ? [{ x: s.x + dx, y: s.y + dy, w: n.w, h: n.h }] : []
      })
      const fit = boxes.length
        ? snap(
            boundsOf(boxes),
            nodes().filter((n) => !ids.has(n.id)),
            SNAP / z(),
          )
        : { dx: 0, dy: 0, guides: [] }
      setGuides(fit.guides)
      setMoving(
        Object.fromEntries(
          d.start.map((s) => [s.id, { x: s.x + dx + fit.dx, y: s.y + dy + fit.dy }]),
        ),
      )
      setClipTarget(
        timelineUnder(
          e.clientX,
          e.clientY,
          d.start.map((s) => s.id),
        ),
      )
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
    setGuides([])
    if (d?.mode === 'pan' && d.context && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) {
      openContext(d.context, e.clientX, e.clientY)
      return
    }
    if (d?.mode === 'link') {
      const target = linkTarget()
      setLinking(null)
      setLinkTarget(null)
      if (!d.moved) {
        setMenu({ kind: 'out', anchor: d.anchor, nodeId: d.from })
      } else if (target && byId(target)?.type === 'timeline') {
        const path = mediaOf(view()!, d.from).path
        if (path) {
          void addClips(
            target,
            [path],
            gapFor(target, e.clientX, onTracksAt(target, e.clientX, e.clientY)),
          )
        }
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
    const into = clipTarget()
    setClipTarget(null)
    if (into) {
      // 加入时间线：节点回到原位置，其视频按指针处的间隙插入。
      const paths = d.start.flatMap((s) => mediaOf(view()!, s.id).path ?? [])
      setMoving({})
      void addClips(into, paths, gapFor(into, e.clientX, onTracksAt(into, e.clientX, e.clientY)))
      return
    }
    const moved = moving()
    const ops: CanvasOp[] = Object.entries(moved).map(([id, p]) => ({
      op: 'update',
      id,
      x: Math.round(p.x),
      y: Math.round(p.y),
    }))
    // 松开指针时提交一次；响应体返回之前始终使用本地位置，避免节点先跳回原处再移到新位置。
    void apply(ops).then(() => setMoving({}))
  }

  /** 双击标题重命名，双击内容在主区打开对应文件。 */
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
      // 浏览器中处理从系统拖入的文件；桌面外壳中的系统拖放由外壳截获，经由 shell-drop 处理。
      e.preventDefault()
      const into = timelineAt(e.clientX, e.clientY)
      if (into) void uploadClips(into, files, gapFor(into, e.clientX, dropOnTracks(e)))
      else void uploadFiles(files, toWorld(e.clientX, e.clientY))
      return
    }
    if (!path) return
    e.preventDefault()
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-node]')
    const onto = target ? byId(target.dataset.node!) : undefined
    // 拖放到缺失的文件节点上即替换该节点的路径。
    if (onto?.type === 'file' && view()?.states[onto.id]?.state === 'missing') {
      void apply([{ op: 'update', id: onto.id, path }])
      return
    }
    if (onto?.type === 'timeline') {
      void addClips(onto.id, [path], gapFor(onto.id, e.clientX, dropOnTracks(e)))
      return
    }
    const at = toWorld(e.clientX, e.clientY)
    void apply([{ op: 'add_file', path, x: Math.round(at.x - 110), y: Math.round(at.y - 80) }])
  }

  // ── 新建与后续生成 ──

  // ── 右键菜单 ──

  /** 右键按下处的对象：节点、连线或空白。确定弹出菜单（松开时未拖动）后再修改选区，右键拖动平移不改变选区。 */
  const contextOf = (target: HTMLElement): ContextTarget => {
    const node = target.closest<HTMLElement>('[data-node]')?.dataset.node
    if (node) return { kind: 'node', id: node }
    const edge = target.closest<HTMLElement>('[data-edge]')?.dataset.edge
    if (edge) return { kind: 'edge', id: edge }
    return { kind: 'blank' }
  }

  const openContext = (target: ContextTarget, clientX: number, clientY: number) => {
    if (target.kind === 'node' && !selected().has(target.id)) {
      setSelected(new Set([target.id]))
      setEdgeSelected(null)
    }
    if (target.kind === 'edge') {
      setSelected(new Set<string>())
      setEdgeSelected(target.id)
    }
    const r = stage.getBoundingClientRect()
    dropAnchor.style.left = `${clientX - r.left}px`
    dropAnchor.style.top = `${clientY - r.top}px`
    setMenu({
      kind: 'context',
      anchor: dropAnchor,
      nodeId: '',
      target,
      at: toWorld(clientX, clientY),
    })
  }

  /** 时间线片段的右键菜单：锚点位于指针处，全屏编辑中使用同一菜单。 */
  const openClipMenu = (id: string, index: number, t: number, clientX: number, clientY: number) => {
    const r = stage.getBoundingClientRect()
    dropAnchor.style.left = `${clientX - r.left}px`
    dropAnchor.style.top = `${clientY - r.top}px`
    setMenu({
      kind: 'context',
      anchor: dropAnchor,
      nodeId: '',
      target: { kind: 'clip', id, index, t },
    })
  }

  /** 快捷键的显示形式：macOS 使用 ⌘，其他系统使用 Ctrl+。 */
  const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'

  /** 右键菜单的菜单项，`null` 表示分隔线。菜单项执行的是对应快捷键调用的同一函数。 */
  const contextItems = (
    target: ContextTarget,
    at: { x: number; y: number },
  ): ({ label: string; keys?: string; run: () => void } | null)[] => {
    const v = view()
    const paste = clipboard
      ? [
          {
            label: '粘贴',
            keys: `${MOD}V`,
            run: () => clipboard && void pasteNodes(clipboard.source, clipboard.ids, at, false),
          },
        ]
      : []
    if (target.kind === 'edge') {
      return [
        {
          label: '断开',
          keys: 'Delete',
          run: () => void cutLink(target.id).then((ok) => ok && setEdgeSelected(null)),
        },
      ]
    }
    if (target.kind === 'clip') {
      const n = byId(target.id)
      const clip = n?.type === 'timeline' ? n.clips[target.index] : undefined
      if (n?.type !== 'timeline' || !clip) return []
      const set = (clips: CanvasTimelineNode['clips']) => () =>
        void apply([{ op: 'update', id: n.id, clips }])
      const split = splitAt(n.clips, target.t)
      return [
        ...(split ? [{ label: '在此处分割', run: set(split) }] : []),
        { label: '创建副本', run: set(insertClips(n.clips, target.index + 1, [clip])) },
        null,
        {
          label: '删除',
          keys: 'Delete',
          run: () => {
            sessionOf(n.id)?.select(null)
            set(withoutClip(n.clips, target.index))()
          },
        },
      ]
    }
    if (target.kind === 'blank') {
      return [
        ...paste,
        ...(paste.length ? [null] : []),
        ...GENERATE_OUTPUTS.map((o) => ({
          label: OUTPUT_LABEL[o],
          run: () => void addGenerate(o, at),
        })),
        { label: '时间线', run: () => void addTimeline(at) },
        {
          label: '从设备上传',
          run: () => {
            uploadAt = at
            contextUpload.click()
          },
        },
        null,
        {
          label: '全选',
          keys: `${MOD}A`,
          run: () => setSelected(new Set(nodes().map((n) => n.id))),
        },
      ]
    }
    const ids = [...selected()]
    const single = ids.length === 1 ? byId(ids[0]!) : undefined
    const file = single && v ? mediaOf(v, single.id).path : null
    return [
      { label: '复制', keys: `${MOD}C`, run: () => void copySelection() },
      {
        label: '剪切',
        keys: `${MOD}X`,
        run: () => {
          if (copySelection()) removeSelected()
        },
      },
      ...paste,
      {
        label: '创建副本',
        keys: `${MOD}D`,
        run: () => v && void pasteNodes(v.doc, ids, null, true),
      },
      null,
      ...(file && isDesktopShell()
        ? [
            {
              label: '在资源管理器中显示',
              run: () => {
                setFault(null)
                void revealFile(absPath(file)).catch((err: unknown) =>
                  setFault(explainApiError(err, '无法定位文件')),
                )
              },
            },
          ]
        : []),
      ...(single ? [{ label: '重命名', run: () => setRenaming(single.id) }] : []),
      { label: '删除', keys: 'Delete', run: removeSelected },
    ]
  }

  /** 右键菜单「从设备上传」：选中的文件放在右键点击的位置。 */
  let contextUpload!: HTMLInputElement
  let uploadAt: { x: number; y: number } | null = null

  /** 视野中央在画布坐标中的位置。 */
  const center = () => {
    const { w, h } = size()
    return { x: (w / 2 - px()) / z(), y: (h / 2 - py()) / z() }
  }

  const addGenerate = async (output: GenerateOutput, near = center()) => {
    setMenu(null)
    const r = await apply([{ op: 'add_generate', ref: '$n', output, near }])
    if (r?.refs.$n) setSelected(new Set([r.refs.$n]))
  }

  const addTimeline = async (near = center()) => {
    setMenu(null)
    const r = await apply([{ op: 'add_timeline', ref: '$t', near }])
    if (r?.refs.$t) setSelected(new Set([r.refs.$t]))
  }

  /** 屏幕上该点下方的时间线；`skip` 中的节点（拖动中的节点）不参与判定。 */
  const timelineAt = (clientX: number, clientY: number, skip: string[] = []): string | null => {
    for (const el of document.elementsFromPoint(clientX, clientY)) {
      const id = el.closest<HTMLElement>('[data-node]')?.dataset.node
      if (id && !skip.includes(id)) return byId(id)?.type === 'timeline' ? id : null
    }
    return null
  }

  /** 落点在时间线轨道上时，返回指针处的间隙；落在工具行或预览上时返回 `undefined`（插入末尾）。 */
  const gapFor = (id: string, clientX: number, onTracks: boolean): number | undefined => {
    const n = byId(id)
    if (n?.type !== 'timeline' || !onTracks) return undefined
    const t = sessionOf(id)?.timeAtClient?.(clientX)
    return t === undefined ? undefined : gapAt(n.clips, t)
  }

  /** 屏幕上该点是否位于时间线 `id` 的轨道上。拖动中指针被画布捕获，事件目标不是指针下的元素，只能按坐标判定。 */
  const onTracksAt = (id: string, clientX: number, clientY: number): boolean =>
    document
      .elementsFromPoint(clientX, clientY)
      .some(
        (el) =>
          el.closest('.canvas-tl-tracks') &&
          el.closest<HTMLElement>('[data-node]')?.dataset.node === id,
      )

  /** 拖放事件的目标是否位于轨道上。 */
  const dropOnTracks = (e: DragEvent): boolean =>
    (e.target as Element).closest('.canvas-tl-tracks') !== null

  /** 从 `from` 拖线到时间线 `to` 时能否加入：`from` 必须是有文件的视频。 */
  const clipsInto = (from: string, to: string): boolean => {
    const v = view()
    return (
      !!v &&
      byId(to)?.type === 'timeline' &&
      mediaOf(v, from).kind === 'video' &&
      mediaOf(v, from).path !== null
    )
  }

  /** 拖动节点时指针下的时间线；拖动的节点中没有视频时返回 null。 */
  const timelineUnder = (clientX: number, clientY: number, dragged: string[]): string | null => {
    const v = view()
    if (!v || !dragged.some((id) => mediaOf(v, id).kind === 'video' && mediaOf(v, id).path)) {
      return null
    }
    return timelineAt(clientX, clientY, dragged)
  }

  /**
   * 在时间线的第 `gap` 个间隙（缺省为末尾）插入完整的视频：时长读取自源文件，非视频或无法读取时长的文件被跳过。
   */
  const addClips = async (id: string, paths: string[], gap?: number) => {
    const videos = paths.filter(
      (p) => canvasMediaOf({ id: '', type: 'file', path: p, x: 0, y: 0, w: 0, h: 0 }) === 'video',
    )
    const added = (
      await Promise.all(
        videos.map(async (path) => {
          const d = (await metaOf(client.fileUrl(path))).duration
          return d > 0 ? [{ path, in: 0, out: Math.floor(d * 1000) / 1000 }] : []
        }),
      )
    ).flat()
    const n = byId(id)
    if (n?.type !== 'timeline') return
    if (!added.length) {
      setFault('只有视频可以加入时间线')
      return
    }
    await apply([{ op: 'update', id, clips: insertClips(n.clips, gap ?? n.clips.length, added) }])
  }

  /**
   * 导出视频：浏览器一边编码 mp4 一边写入服务端，完成后保存到 `generated/`，来源节点右侧出现新的视频节点。
   * `encode` 把字节交给 `write`，进度经 `progress` 报告。返回新节点的 id；取消或失败时为 `null`。
   */
  const exportVideo = async (
    id: string,
    failText: string,
    encode: (
      write: (bytes: Uint8Array<ArrayBuffer>, at: number) => Promise<void>,
      progress: (ratio: number) => void,
      signal: AbortSignal,
    ) => Promise<void>,
  ): Promise<string | null> => {
    if (exportAborts.has(id)) return null
    const ac = new AbortController()
    exportAborts.set(id, ac)
    setExports((x) => ({ ...x, [id]: 0 }))
    let upload: string | null = null
    try {
      const session = await exportStart(props.path, id)
      upload = session
      await encode(
        (bytes, at) => exportWrite(session, at, bytes),
        (ratio) => setExports((x) => ({ ...x, [id]: ratio })),
        ac.signal,
      )
      const r = await exportFinish(session)
      upload = null
      setFault(null)
      void load()
      return r.nodeId
    } catch (e) {
      // 未完成的文件由服务端删除；该请求失败时，服务端在空闲超时后同样会删除。
      if (upload) void exportAbort(upload).catch(() => {})
      if ((e as Error).name !== 'AbortError') setFault(explainApiError(e, failText))
      return null
    } finally {
      exportAborts.delete(id)
      setExports(({ [id]: _, ...rest }) => rest)
    }
  }

  /** 导出时间线成片，完成后选中新节点（全屏编辑中不改变选区）。 */
  const exportTimeline = async (id: string) => {
    const n = byId(id)
    if (n?.type !== 'timeline' || !n.clips.length) return
    const created = await exportVideo(id, '导出失败', (write, progress, signal) =>
      renderTimeline(
        n.clips.map((c) => ({
          url: client.fileUrl(c.path),
          name: c.path.split('/').pop() ?? c.path,
          in: c.in,
          out: c.out,
        })),
        !!n.muted,
        progress,
        signal,
        write,
      ),
    )
    if (created && !fullscreen()) setSelected(new Set([created]))
  }

  /**
   * Art 录制：从实时页面当前的状态起录制 `seconds` 秒。Art 节点保持选中：取消选中会关闭实时页面，
   * 用户转好的镜头随之丢失。
   */
  const recordNode = (id: string, seconds: number) => {
    setMenu(null)
    const live = arts.get(id)
    if (!live) return setFault('页面尚未加载')
    void exportVideo(id, '录制失败', async (write, progress, signal) => {
      await live.handle.ready
      await recordArt(live.handle, live.size, seconds, progress, signal, write)
    })
  }

  /** Art 截图：截取实时页面当前的画面，保存为 PNG 节点放在右侧。Art 节点保持选中，理由同 `recordNode`。 */
  const shoot = async (id: string) => {
    const live = arts.get(id)
    if (!live) return setFault('页面尚未加载')
    try {
      await live.handle.ready
      await captureFrame(props.path, id, '截图', await pngOf(await live.handle.capture()))
      setFault(null)
      void load()
    } catch (e) {
      setFault(explainApiError(e, '截图失败'))
    }
  }

  /**
   * 在选择框中连续选择的文件：第一个放在视野中央附近的空位，之后的依次放在上一个右侧的空位。
   * 必须依次提交：前一个的响应体返回后才能取得其 id，并发提交时后一个会放在视野中央并遮挡前一个。
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

  /** 通过时间线的「+」从本机上传的视频：先添加到画布（时间线右侧），再按路径插入轨道。 */
  const uploadClips = async (id: string, files: File[], gap?: number) => {
    const paths: string[] = []
    for (const file of files) {
      try {
        paths.push((await uploadToCanvas(props.path, file, { beside: id })).path)
      } catch (e) {
        setFault(explainApiError(e, `上传失败：${file.name}`))
        break
      }
    }
    await load()
    if (paths.length) await addClips(id, paths, gap)
  }

  /** 逐个上传从本机选择的文件：第一个放在视野中央附近的空位，之后的依次放在上一个右侧。任一文件失败即停止并报告原因。 */
  const uploadFiles = async (files: File[], near = center()) => {
    let prev: string | null = null
    for (const file of files) {
      try {
        const r = await uploadToCanvas(props.path, file, prev ? { beside: prev } : { near })
        prev = r.nodeId
        setFault(null)
      } catch (e) {
        setFault(explainApiError(e, `上传失败：${file.name}`))
        break
      }
    }
    void load()
  }

  /**
   * 从生成面板添加到画布的素材：放在卡片左侧、与卡片中线对齐的空位（连线从左向右进入卡片）。
   * 本机文件先上传；返回新节点的 id，添加失败时返回 `null` 并报告原因。
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
      setFault(explainApiError(e, `上传失败：${source.file.name}`))
      return null
    }
  }

  /**
   * 从节点新建一张后续生成卡，并把该节点连接为输入：视频节点作为参考视频，图片作为首帧（视频生成）或参考（图像生成、Art）。
   * 给出 `at` 时，卡片左边沿中点（输入连线的终点）位于该点，与已有节点重叠时也不移动。
   * 不要改为 `near`：它以该点为卡片中心，且与已有节点相交时下移，落点靠近源节点时卡片被移到源节点下方。
   */
  const extend = async (nodeId: string, output: GenerateOutput, at?: { x: number; y: number }) => {
    setMenu(null)
    const source = byId(nodeId)
    const kind = mediaOf(view()!, nodeId).kind
    if (!source || !kind || kind === 'art') return
    const role: MediaInputRole =
      output === 'image' || output === 'art' ? 'reference' : kind === 'image' ? 'first_frame' : kind
    const place = at
      ? { x: Math.round(at.x), y: Math.round(at.y - blankBox(output).h / 2) }
      : { beside: nodeId }
    const r = await apply([
      { op: 'add_generate', ref: '$n', output, ...place },
      { op: 'connect', from: nodeId, to: '$n', role },
    ])
    if (r?.refs.$n) setSelected(new Set([r.refs.$n]))
  }

  /**
   * 从 `from` 连接到 `to` 时的用途；无法连接时返回 `null`。先按素材类别与目标的模式确定用途，
   * 再交给 core 的操作校验检查一次：能否连接只由 core 判定。
   */
  const linkRole = (from: string, to: string): MediaInputRole | null => {
    const v = view()
    const target = byId(to)
    const kind = v ? mediaOf(v, from).kind : null
    if (!v || !kind || kind === 'art' || target?.type !== 'generate') return null
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

  /** 在连接点按下：拖出为连线，原地松开为点击（打开后续生成菜单）。 */
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

  /** 可以从该节点新建的后续生成卡类别。Art 节点不能作为输入。 */
  const extendable = (nodeId: string): GenerateOutput[] => {
    const kind = view() ? mediaOf(view()!, nodeId).kind : null
    if (kind === null || kind === 'art') return []
    return GENERATE_OUTPUTS.filter((o) =>
      o === 'image' || o === 'art' ? kind === 'image' : o === 'video',
    )
  }

  // ── 取帧 ──

  const capture = async (nodeId: string, at: number, duration: number) => {
    setMenu(null)
    const media = view() ? mediaOf(view()!, nodeId) : null
    if (!media?.path) return
    try {
      const blob = await captureVideoFrame(client.fileUrl(media.path), at)
      const r = await captureFrame(props.path, nodeId, frameLabel(at, duration), blob)
      setFault(null)
      setSelected(new Set([r.nodeId]))
      void load()
    } catch (e) {
      setFault(explainApiError(e, '取帧失败'))
    }
  }

  // ── 派生状态 ──

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
  const panelAt = () => {
    const n = single()
    if (n?.type !== 'generate') return null
    const p = pos(n)
    // 画布区比面板窄时，面板宽度缩小到画布区宽度：更宽的面板无论放在何处都有一部分位于画布区外。
    const width = Math.min(PANEL_W, size().w - 16)
    // 只按节点定位，不按画布区边缘向内收回：收回后面板会遮挡节点本身与相邻节点，平移时也不随节点移动。
    return {
      node: n,
      width,
      left: px() + (p.x + n.w / 2) * z() - width / 2,
      top: py() + (p.y + n.h) * z() + 16,
    }
  }

  /**
   * 绘制的线：连线，以及每条时间线从片段推导出的线，即画布上显示被片段引用的文件的每个节点各有一条线连到时间线。
   * 推导出的线不保存到文件，片段是唯一的数据来源。
   */
  const links = (v: CanvasView): { id: string; from: string; to: string }[] => [
    ...v.doc.edges,
    ...v.doc.nodes.flatMap((t) => {
      if (t.type !== 'timeline' || !t.clips.length) return []
      const used = new Set(t.clips.map((c) => c.path))
      return v.doc.nodes.flatMap((n) => {
        const path = n.id === t.id ? null : mediaOf(v, n.id).path
        return path && used.has(path)
          ? [{ id: `${CLIP_LINK}${t.id}:${n.id}`, from: n.id, to: t.id }]
          : []
      })
    }),
  ]

  const edgePaths = () => {
    const v = view()
    if (!v) return []
    return links(v).flatMap((e) => {
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
          // 曲线 t = 0.5 处：两个控制点的横向偏移相互抵消，该点恰好位于两端的中点。
          mx: (x1 + x2) / 2,
          my: (y1 + y2) / 2,
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

  /** `w` 是节点的画布宽度，图片按该宽度乘以当前缩放与设备像素比解码。 */
  function Media(p: {
    nodeId: string
    path: string
    kind: GenerateOutput | null
    w: number
    h: number
    controls: boolean
  }) {
    const [length, setLength] = createSignal<number | null>(null)
    return (
      <Switch
        fallback={
          <Show
            when={canvasFileKind(p.path) === 'text'}
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
            <Bitmap
              src={client.fileUrl(p.path)}
              width={p.w * z() * window.devicePixelRatio}
              height={p.h * z() * window.devicePixelRatio}
            />
          </div>
        </Match>
        <Match when={p.kind === 'video'}>
          <div class="canvas-media">
            {/* 选中时才挂载播放器：播放与取帧都需要它；未选中时只绘制封面。 */}
            <Show
              when={p.controls}
              fallback={
                <Bitmap
                  kind="video"
                  src={client.fileUrl(p.path)}
                  width={p.w * z() * window.devicePixelRatio}
                  height={p.h * z() * window.devicePixelRatio}
                  onDuration={setLength}
                />
              }
            >
              <VideoPlayer
                src={client.fileUrl(p.path)}
                register={(player) => {
                  players.set(p.nodeId, player)
                  onCleanup(() => players.delete(p.nodeId))
                }}
                onDuration={setLength}
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
        <Match when={p.kind === 'art'}>
          <div class="canvas-media">
            {/* 只在单独选中时运行实时页面：同时运行的 WebGL 页面有数量上限，平移缩放时每个页面都要重绘。 */}
            <ArtView
              url={client.fileUrl(p.path)}
              w={p.w}
              h={p.h}
              z={z()}
              live={p.controls && selected().size === 1}
              register={(live) => {
                if (live) arts.set(p.nodeId, live)
                else arts.delete(p.nodeId)
              }}
            />
          </div>
        </Match>
        <Match when={p.kind === 'audio'}>
          <Show when={client.fileUrl(p.path)} keyed>
            {(src) => <AudioPlayer src={src} active={props.active} />}
          </Show>
        </Match>
      </Switch>
    )
  }

  /**
   * 按 id 取节点：每次写操作返回的文档都是新对象，按对象挂载时每修改一处都会重建全部节点、重新解码全部图片。
   * 删除节点的那次更新中，组件内的计算可能先于列表重新计算，此时沿用最后一次取得的节点。
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
    const kind = (): GenerateOutput | 'text' | 'timeline' | null => {
      const node = n()
      if (node.type === 'generate') return node.output
      if (node.type === 'timeline') return 'timeline'
      return canvasFileKind(node.path)
    }
    const commitName = (value: string) => {
      setRenaming(null)
      const name = value.trim()
      if (name === displayNameOf(n())) return
      if (n().type !== 'file' && !name) return
      void apply([{ op: 'update', id: n().id, name: name || null }])
    }

    return (
      <div
        class="canvas-node"
        classList={{
          selected: isSelected(),
          audio: kind() === 'audio',
          'link-target': linkTarget() === n().id || clipTarget() === n().id,
        }}
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
          when={n().type !== 'timeline'}
          fallback={
            <Timeline
              node={n() as CanvasTimelineNode}
              mode="node"
              showPreview={fullscreen() !== n().id}
              urlOf={(path) => client.fileUrl(path)}
              exporting={exports()[n().id] ?? null}
              setClips={(clips) =>
                apply([{ op: 'update', id: n().id, clips }]).then((r) => r !== null)
              }
              setMuted={(muted) => void apply([{ op: 'update', id: n().id, muted }])}
              onFocus={() => {
                setEdgeSelected(null)
                if (!selected().has(n().id)) setSelected(new Set([n().id]))
              }}
              onAdd={(anchor, gap) => setMenu({ kind: 'clip', anchor, nodeId: n().id, gap })}
              onClipMenu={(index, t, x, y) => openClipMenu(n().id, index, t, x, y)}
              onExport={() => void exportTimeline(n().id)}
              onCancelExport={() => exportAborts.get(n().id)?.abort()}
              onFullscreen={() => setFullscreen(n().id)}
            />
          }
        >
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
                  h={n().h}
                  controls={isSelected()}
                />
              </Show>
            }
          >
            <GenerateBody node={n() as CanvasGenerateNode} selected={isSelected()} />
          </Show>
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
        <Show when={n().type === 'timeline'}>
          <button
            class="canvas-port in"
            type="button"
            aria-label="添加视频"
            onClick={(e) =>
              setMenu({
                kind: 'clip',
                anchor: e.currentTarget,
                nodeId: n().id,
                gap: (n() as CanvasTimelineNode).clips.length,
              })
            }
          >
            <IconPlus stroke={1.8} />
          </button>
        </Show>
        <Show when={extendable(n().id).length}>
          <button
            class="canvas-port out"
            type="button"
            aria-label="从此节点生成"
            onPointerDown={(e) => startLink(e, n().id)}
            onClick={(e) => {
              // 指针的按下与松开由 startLink 与 onPointerUp 处理；此处只处理键盘触发的点击。
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
    const notice = () => {
      const s = st()
      if (s?.state === 'failed')
        return { failed: true, title: '本次生成失败，已保留原结果', message: s.message }
      const warning = current()?.warning
      return warning ? { failed: false, title: '生成结果与设置不符', message: warning } : null
    }
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
                <span class="phase">
                  {s().phase === 'queued' || (!s().phase && p.node.output === 'video')
                    ? '排队中'
                    : '生成中'}
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
              <span class="error" role="alert">
                {s().message}
              </span>
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
                h={p.node.h}
                controls={p.selected}
              />
              <Show when={notice()}>
                {(n) => (
                  <div
                    class="canvas-media-notice"
                    classList={{ failed: n().failed }}
                    role={n().failed ? 'alert' : 'status'}
                    onPointerDown={(e) => e.stopPropagation()}
                  >
                    <strong>{n().title}</strong>
                    <span>{n().message}</span>
                  </div>
                )}
              </Show>
              <Show when={p.node.versions.length > 1}>
                <button
                  class="canvas-badge version"
                  type="button"
                  aria-label={`切换版本（${index()} / ${p.node.versions.length}）`}
                  onClick={(e) =>
                    setMenu({ kind: 'version', anchor: e.currentTarget, nodeId: p.node.id })
                  }
                >
                  {index()} / {p.node.versions.length}
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

  const framing = (nodeId: string) => {
    const m = menu()
    return m?.kind === 'frame' && m.nodeId === nodeId ? players.get(nodeId) : undefined
  }

  /**
   * 选中工具条的按钮：视频取帧；Art 截图与录制。`menu` 为按钮打开的菜单（用于标出展开状态），
   * 录制中按钮显示进度，点击即取消，同时间线的导出按钮。
   */
  const tools = () => {
    const n = single()
    if (!n) return null
    const items: {
      label: string
      tip?: string
      menu?: Menu['kind']
      run: (anchor: HTMLElement) => void
    }[] = []
    if (isVideo(n)) {
      items.push({
        label: '取帧',
        menu: 'frame',
        run: (anchor) => setMenu({ kind: 'frame', anchor, nodeId: n.id }),
      })
    }
    if (view() && mediaOf(view()!, n.id).kind === 'art' && mediaOf(view()!, n.id).path) {
      const progress = exports()[n.id]
      items.push({ label: '截图', run: () => void shoot(n.id) })
      items.push(
        progress === undefined
          ? {
              label: '录制',
              menu: 'record',
              run: (anchor) => setMenu({ kind: 'record', anchor, nodeId: n.id }),
            }
          : {
              label: `${Math.floor(progress * 100)}%`,
              tip: '取消录制',
              run: () => exportAborts.get(n.id)?.abort(),
            },
      )
    }
    if (!items.length) return null
    const p = pos(n)
    return { node: n, items, left: px() + (p.x + n.w / 2) * z(), top: py() + p.y * z() - 26 }
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
      // 画布中禁用浏览器自带的拖拽：选中的文字或图片被拖起后指针事件被接管，节点无法拖动，光标变为禁止符号。
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
            <For each={edgePaths().filter((e) => e.live || e.hot)}>
              {(e) => (
                <linearGradient
                  id={`canvas-flow-${e.id}`}
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
                  // 渐变写在内联样式中：写成 `stroke` 属性会被 `.canvas-edges path` 的描边色覆盖。
                  style={e.live || e.hot ? { stroke: `url("#canvas-flow-${e.id}")` } : {}}
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
          <For each={guides()}>
            {(g) => <line class="canvas-guide" x1={g.x1} y1={g.y1} x2={g.x2} y2={g.y2} />}
          </For>
        </svg>
        <div
          class="canvas-world"
          style={{ transform: `translate(${px()}px, ${py()}px) scale(${z()})` }}
        >
          <For each={nodes().map((n) => n.id)}>{(id) => <Node id={id} />}</For>
        </div>

        <For each={edgePaths().filter((e) => e.id === edgeSelected())}>
          {(e) => (
            <button
              class="canvas-edge-cut"
              type="button"
              aria-label="断开"
              data-edge={e.id}
              style={{ left: `${px() + e.mx * z()}px`, top: `${py() + e.my * z()}px` }}
              onClick={() =>
                void cutLink(e.id).then((ok) => {
                  if (!ok) return
                  if (edgeSelected() === e.id) setEdgeSelected(null)
                })
              }
            >
              <IconScissors size={14} />
            </button>
          )}
        </For>

        <Show when={tools()}>
          {(t) => (
            <Show
              when={framing(t().node.id)}
              fallback={
                <div class="canvas-tools" style={{ left: `${t().left}px`, top: `${t().top}px` }}>
                  <For each={t().items}>
                    {(item) => (
                      <button
                        type="button"
                        aria-expanded={
                          item.menu
                            ? menu()?.kind === item.menu &&
                              (menu() as { nodeId?: string }).nodeId === t().node.id
                            : undefined
                        }
                        aria-label={item.tip}
                        data-tip={item.tip}
                        onClick={(e) => item.run(e.currentTarget)}
                      >
                        {item.label}
                      </button>
                    )}
                  </For>
                </div>
              }
            >
              {(player) => (
                <FrameBar
                  player={player()}
                  style={{ left: `${t().left}px`, top: `${t().top}px` }}
                  onCapture={(at, duration) => void capture(t().node.id, at, duration)}
                />
              )}
            </Show>
          )}
        </Show>

        {/* 按卡片 id 重建：面板中的草稿与菜单只属于当前卡片，选中另一张卡片时不沿用。 */}
        <Show when={panelAt()?.node.id} keyed>
          {(id) => {
            // 卸载时 `panelAt()` 已为 null，此处读取的仍是该卡片最后一次的位置与节点。
            let last = panelAt()!
            const at = () => {
              const now = panelAt()
              if (now?.node.id === id) last = now
              return last
            }
            return (
              <GeneratePanel
                view={view()!}
                node={at().node}
                state={view()?.states[id]}
                left={at().left}
                width={at().width}
                top={at().top}
                tall={tall()}
                onTall={setTall}
                apply={(ops) => apply(ops).then((r) => r !== null)}
                run={(ops) => run(id, ops)}
                cancel={() => cancel(id)}
                place={(source) => placeInput(at().node, source)}
              />
            )
          }}
        </Show>
      </Show>

      <Show
        when={(() => {
          const id = fullscreen()
          const n = id ? byId(id) : undefined
          return n?.type === 'timeline' ? n : null
        })()}
      >
        {(n) => (
          <Portal>
            <div class="canvas-tl-layer">
              <Timeline
                node={n()}
                mode="full"
                showPreview={true}
                urlOf={(path) => client.fileUrl(path)}
                exporting={exports()[n().id] ?? null}
                setClips={(clips) =>
                  apply([{ op: 'update', id: n().id, clips }]).then((r) => r !== null)
                }
                setMuted={(muted) => void apply([{ op: 'update', id: n().id, muted }])}
                onFocus={() => {}}
                onAdd={(anchor, gap) => setMenu({ kind: 'clip', anchor, nodeId: n().id, gap })}
                onClipMenu={(index, t, x, y) => openClipMenu(n().id, index, t, x, y)}
                onExport={() => void exportTimeline(n().id)}
                onCancelExport={() => exportAborts.get(n().id)?.abort()}
                onFullscreen={() => setFullscreen(null)}
              />
            </div>
          </Portal>
        )}
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
        outputs={[...GENERATE_OUTPUTS]}
        disabled={!view() || !!broken()}
        onGenerate={(o) => void addGenerate(o)}
        onTimeline={() => void addTimeline()}
        onPick={pickFile}
        onUpload={(files) => void uploadFiles(files)}
      />

      <span class="canvas-drop-anchor" ref={dropAnchor} />
      <input
        ref={contextUpload}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.currentTarget.files ?? [])]
          e.currentTarget.value = ''
          if (files.length) void uploadFiles(files, uploadAt ?? center())
        }}
      />

      <div class="canvas-dock">
        <button class="zoom" type="button" onClick={() => fit(true)}>
          {Math.round(z() * 100)}%
        </button>
      </div>

      {/* 菜单挂载到文档根节点：画布区自成层叠上下文，菜单留在其中会被全屏时间线（z-index 55）遮挡。
          可见性按本页是否处于前台判定：挂载在根节点后，菜单不再随本页一同隐藏。 */}
      <Portal>
        <Show when={props.active ? menu() : null}>
          {(m) => (
            <Switch>
              <Match when={m().kind === 'context' && m().target}>
                {(target) => (
                  <AnchoredMenu
                    class="canvas-context-menu"
                    anchor={m().anchor}
                    placement="below-start"
                  >
                    <For each={contextItems(target(), m().at ?? center())}>
                      {(item) => (
                        <Show when={item} fallback={<hr />}>
                          {(it) => (
                            <button
                              type="button"
                              onClick={() => {
                                const act = it().run
                                setMenu(null)
                                act()
                              }}
                            >
                              <span>{it().label}</span>
                              <Show when={it().keys}>{(k) => <kbd>{k()}</kbd>}</Show>
                            </button>
                          )}
                        </Show>
                      )}
                    </For>
                  </AnchoredMenu>
                )}
              </Match>
              <Match when={m().kind === 'clip'}>
                <AnchoredMenu class="canvas-pick" anchor={m().anchor} placement="below-start">
                  <SourcePicker
                    nodes={nodes().filter(
                      (n) => mediaOf(view()!, n.id).kind === 'video' && mediaOf(view()!, n.id).path,
                    )}
                    files={true}
                    kinds={['video']}
                    accept="video/*"
                    thumb={(id) => <KindIcon kind={mediaOf(view()!, id).kind} size={14} />}
                    onNode={(id) => {
                      const { nodeId, gap } = m()
                      const path = mediaOf(view()!, id).path
                      setMenu(null)
                      if (path) void addClips(nodeId, [path], gap)
                    }}
                    onFile={(path) => {
                      const { nodeId, gap } = m()
                      setMenu(null)
                      void addClips(nodeId, [path], gap)
                    }}
                    onUpload={(files) => {
                      const { nodeId, gap } = m()
                      setMenu(null)
                      void uploadClips(nodeId, files, gap)
                    }}
                  />
                </AnchoredMenu>
              </Match>
              <Match when={m().kind === 'out' || m().kind === 'version' || m().kind === 'record'}>
                {/* 后续生成菜单从锚点向右展开：连线从左侧进入锚点，新卡片也位于锚点右侧。 */}
                <AnchoredMenu
                  class="canvas-menu"
                  anchor={m().anchor}
                  placement={m().kind === 'out' ? 'below-start' : 'below-end'}
                >
                  <Switch>
                    <Match when={m().kind === 'record'}>
                      <For each={RECORD_SECONDS}>
                        {(seconds) => (
                          <button type="button" onClick={() => recordNode(m().nodeId, seconds)}>
                            {seconds} 秒
                          </button>
                        )}
                      </For>
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
                        {(v, i) => {
                          const current = () =>
                            v.id ===
                            (
                              byId((m() as { nodeId: string }).nodeId) as
                                | CanvasGenerateNode
                                | undefined
                            )?.current
                          return (
                            <button
                              type="button"
                              role="menuitemradio"
                              aria-checked={current()}
                              onClick={() => {
                                // 先取得节点 id 再关闭菜单：关闭之后 `m()` 已失效。
                                const id = (m() as { nodeId: string }).nodeId
                                setMenu(null)
                                void apply([{ op: 'update', id, current: v.id }])
                              }}
                            >
                              <span>
                                {i() + 1} · {madeAt(v.made.at)}
                              </span>
                              <Show when={current()}>
                                <IconCheck size={14} />
                              </Show>
                            </button>
                          )
                        }}
                      </For>
                    </Match>
                  </Switch>
                </AnchoredMenu>
              </Match>
            </Switch>
          )}
        </Show>
      </Portal>
      <Show when={!view() && !broken()}>
        <div class="canvas-note">
          <IconCanvas size={20} />
        </div>
      </Show>
    </div>
  )
}
