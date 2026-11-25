/**
 * 画布页的控制器：本页的全部状态与对状态的基本操作（读取与提交、撤销与重做、运行、视口、按 id 查询）。
 *
 * 画布区的各部分（节点、连线、浮层、键盘与指针）都以同一个控制器为参数或经 `useCanvas` 取得，不另存副本。
 * 信号以访问器暴露，读取处各自订阅；不要在控制器对象上存放求值后的值，否则读取处不随数据更新。
 * 非响应式的字段（`stage`、`drag` 等）是本函数内的局部变量，经 get/set 暴露，控制器内部直接读写局部变量。
 */
import type { CanvasExcerpt, CanvasNode, CanvasOp, CanvasView } from '@qywork/core'
import { createEffect, createMemo, createSignal, on, onCleanup } from 'solid-js'
import { readSession, SET_CODEC, sessionSignal } from '../../../lib/session.ts'
import {
  type CanvasEdit,
  editCanvas,
  ensureModelCatalog,
  explainApiError,
  readCanvas,
  restoreCanvas,
  retrieveCard,
  runCard,
  state,
  workspace,
} from '../../../lib/store/index.ts'
import type { ArtLive } from '../ArtView.tsx'
import { dismissOnOutside } from '../dismiss.ts'
import { curveOf, pathOf } from '../Flow.tsx'
import { fileUrlOf, mediaOf } from '../GeneratePanel.tsx'
import type { PlayerHandle } from '../Player.tsx'
import type { Guide } from '../snap.ts'

/**
 * 右键点击的对象：节点作用于选区（点击的节点不在选区中时先只选中它），空白处作用于点击位置；
 * 时间线上的片段（`clip`）记录片段序号与指针处的成片时刻 `t`。
 */
export type ContextTarget =
  | { kind: 'node'; id: string }
  | { kind: 'edge'; id: string }
  | { kind: 'blank' }
  | { kind: 'clip'; id: string; index: number; t: number }

/** 从片段推导出的「视频 → 时间线」连线：id 由该前缀、时间线 id 与视频节点 id 组成。画布 id 不含冒号，不会冲突。 */
export const CLIP_LINK = 'clip:'

/** 合并连续变动的等待时长：期间到达的变动只触发一次重新读取。 */
const RELOAD_DELAY_MS = 150

/** 变动路径与卡片路径的比较形式：正斜杠、小写。 */
export const normPath = (p: string) => p.replaceAll('\\', '/').toLowerCase()

/**
 * 内容未变的卡片与卡片状态沿用上一份的对象。每次读取与写操作返回的都是全新的对象，
 * 不沿用时任何一处变化都使全部卡片重新计算。画布中的对象只读，沿用不改变内容。
 */
function shareUnchanged(prev: CanvasView | null, next: CanvasView): CanvasView {
  if (!prev) return next
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  const before = new Map(prev.doc.nodes.map((n) => [n.id, n]))
  const nodes = next.doc.nodes.map((n) => {
    const old = before.get(n.id)
    return old && same(old, n) ? old : n
  })
  const states: CanvasView['states'] = {}
  for (const [id, s] of Object.entries(next.states)) {
    const old = prev.states[id]
    states[id] = old && same(old, s) ? old : s
  }
  return { ...next, doc: { ...next.doc, nodes }, states }
}

/**
 * `at`：从连接点拖到空白处松开时新卡片的输入端位于该点；右键菜单中的粘贴、新建与上传放在该点（画布坐标）。
 * 右键菜单（`context`）的 `nodeId` 为空字符串，作用对象在 `target` 中。
 * 时间线的「+」（`clip`）：选中的视频插入第 `gap` 个间隙。
 */
export type Menu = {
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
  /** 双指缩放：开始时两指的间距、中点（画布区坐标）与视口。 */
  | { mode: 'pinch'; dist: number; mx: number; my: number; z: number; px: number; py: number }

export function createCanvasController(props: { path: string; active: boolean }) {
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
  /** 流动虚线层能否用 WebGL 绘制；不能时生成中的连线在连线层中显示为静止的渐变虚线。 */
  const [flowGl, setFlowGl] = createSignal(false)
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
  /** 按下中的手指（`pointerId` 到屏幕坐标），双指缩放按它计算。 */
  const touches = new Map<number, { x: number; y: number }>()
  /** 按住 Space 时左键拖动是平移。 */
  let space = false
  /**
   * 最近一次按下指针时的目标，供 `onDblClick` 判断双击的卡片与部位。不要改用双击事件的目标：
   * 按下时 `setPointerCapture` 使随后的 click / dblclick 以画布本身为目标（Chromium 实测）。
   */
  let pressed: HTMLElement | null = null
  /** 右键菜单「从设备上传」：选中的文件放在右键点击的位置。 */
  let contextUpload!: HTMLInputElement
  let uploadAt: { x: number; y: number } | null = null
  /**
   * 在选择框中连续选择的文件：第一个放在视野中央附近的空位，之后的依次放在上一个右侧的空位。
   * 必须依次提交：前一个的响应体返回后才能取得其 id，并发提交时后一个会放在视野中央并遮挡前一个。
   */
  let lastPicked: string | null = null
  let picks = Promise.resolve()

  dismissOnOutside(menu, () => setMenu(null))

  // ── 读取与写入 ──

  /** 只采纳最后一次：连续重新读取时先发出的请求可能后返回；读写共用一个序号，按发出顺序计算（见 `write`）。 */
  let seq = 0
  const load = async () => {
    const mine = ++seq
    try {
      const next = await readCanvas(props.path)
      if (mine !== seq) return
      setView((prev) => shareUnchanged(prev, next))
      setBroken(null)
    } catch (e) {
      if (mine === seq) setBroken(explainApiError(e, '无法打开画布'))
    }
  }
  createEffect(
    on(
      () => props.path,
      () => void load(),
    ),
  )

  /**
   * 画布读取结果依赖的文件：画布本身、各卡引用的文件与卡片显示内容所依据的文件（`revisions`，含 Art 页面引用的图片）。
   * 其他文件的变动不影响画布，不重新读取；路径小写比较：Windows 上大小写不敏感。
   */
  const watched = createMemo(() => {
    const set = new Set([normPath(props.path)])
    const v = view()
    if (v) set.add(normPath(v.path))
    for (const p of Object.keys(v?.revisions ?? {})) set.add(normPath(p))
    for (const n of v?.doc.nodes ?? []) {
      if (n.type === 'file') set.add(normPath(n.path))
      else if (n.type === 'generate') for (const v of n.versions) set.add(normPath(v.path))
      else if (n.type === 'timeline') for (const c of n.clips) set.add(normPath(c.path))
    }
    return set
  })

  /**
   * 待重新读取：生成或执行命令时变动连续到达，合并后读取一次；页签不在显示时只记录，切回时再读取。
   * 文本卡与媒体卡按读取结果中各文件的版本（`revisions`）更新，不另设读取序号。
   */
  let pending = false
  let flushTimer: ReturnType<typeof setTimeout> | undefined
  const flushPending = () => {
    flushTimer = undefined
    if (!pending || !props.active) return
    pending = false
    void load()
  }
  const schedule = () => {
    pending = true
    if (props.active && flushTimer === undefined)
      flushTimer = setTimeout(flushPending, RELOAD_DELAY_MS)
  }
  onCleanup(() => clearTimeout(flushTimer))
  createEffect(
    on(
      () => state.fileVersion,
      () => {
        const touched = state.fileTouched
        if (touched === null) return schedule()
        const paths = touched.map(normPath)
        // 工作区之外的文件以绝对路径报告，无法与卡片的相对路径比较，按路径未知处理。
        if (paths.some((p) => /^([a-z]:)?\//.test(p) || p.startsWith('../'))) return schedule()
        // 变动的可能是整个文件夹（删除、重命名）：卡片引用该文件夹中的文件时同样视为相关。
        const hit = [...watched()].some((w) =>
          paths.some((p) => w === p || w.startsWith(`${p.replace(/\/$/, '')}/`)),
        )
        if (hit) schedule()
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => state.canvasVersion,
      () => schedule(),
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => props.active,
      (active) => {
        if (active && pending && flushTimer === undefined) flushPending()
      },
      { defer: true },
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
    if (mine === seq) setView((prev) => shareUnchanged(prev, next))
    setFault(null)
    return next
  }

  /**
   * 本页发起的编辑：每一步记录修改前后两份文档的指纹。撤销恢复修改前的文档，重做恢复修改后的文档，
   * 由服务端核对当前文件仍是记录中的文档。上传、拖入、取帧与生成结果写回不进入栈。
   */
  const undoStack: CanvasEdit['step'][] = []
  const redoStack: CanvasEdit['step'][] = []
  /** 两个栈的深度：栈本身不是响应式的，工具条的撤销、重做按钮按它禁用。每次修改栈之后调用 `syncDepth`。 */
  const [depth, setDepth] = createSignal({ undo: 0, redo: 0 })
  const syncDepth = () => setDepth({ undo: undoStack.length, redo: redoStack.length })
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
          syncDepth()
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
    } finally {
      syncDepth()
    }
  }

  const run = (nodeId: string, ops: CanvasOp[]) => {
    write(runCard(props.path, nodeId, ops)).catch((e: unknown) =>
      setFault(explainApiError(e, '无法开始生成')),
    )
  }

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
  /** 按 id 的索引：每张卡的各项显示都经 `byId` 取节点，逐个遍历时每次重新读取的计算量随卡片数的平方增长。 */
  const index = createMemo(() => new Map(nodes().map((n) => [n.id, n])))
  const byId = (id: string) => index().get(id)
  const pos = (n: CanvasNode) => moving()[n.id] ?? { x: n.x, y: n.y }
  /** 屏幕上的网格点距接近 24px：画布点距取 20 × 2ⁿ，n 取使屏幕点距最接近 24px 的值。 */
  const grid = () => {
    const n = Math.max(-2, Math.min(6, Math.round(Math.log2(24 / (20 * z())))))
    return 20 * 2 ** n * z()
  }
  /**
   * 网格层的位移：平移量对点距取模后减去一个点距，网格层比画布区宽高各多一个点距，始终覆盖画布区。
   * 取整到像素：合成层位于小数位置时按插值绘制，网格点模糊。
   */
  const gridShift = (p: number) => {
    const g = grid()
    return Math.round((((p % g) + g) % g) - g)
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

  /** 以画布区中心为不动点缩放到 `next`。 */
  const zoomAt = (next: number) => {
    const nz = Math.min(3, Math.max(0.1, next))
    const { w, h } = size()
    setPx(w / 2 - (w / 2 - px()) * (nz / z()))
    setPy(h / 2 - (h / 2 - py()) * (nz / z()))
    setZ(nz)
  }

  /** 视野中央在画布坐标中的位置。 */
  const center = () => {
    const { w, h } = size()
    return { x: (w / 2 - px()) / z(), y: (h / 2 - py()) / z() }
  }

  // ── 派生状态 ──

  const single = () => {
    const ids = [...selected()]
    return ids.length === 1 && !Object.keys(moving()).length ? byId(ids[0]!) : undefined
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

  /**
   * 拖动节点时每次移动都返回新对象：按位置渲染（`Index`），只更新几何变化的连线的属性。
   * 不要改用 `For`：`For` 按对象重建全部连线元素，整个连线层随之重新光栅化，开销随连线数与刷新率增长。
   */
  const edgePaths = createMemo(() => {
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
      return [
        {
          id: e.id,
          d: pathOf(curveOf(x1, y1, x2, y2)),
          live: v.states[b.id]?.state === 'running',
          moving: moving()[a.id] !== undefined || moving()[b.id] !== undefined,
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
  })

  const excerptOfNode = (id: string): CanvasExcerpt | undefined => {
    const node = byId(id)
    return node?.type === 'file' ? node.excerpt : undefined
  }

  /** 摘录卡读取的文件全文：同一文件的各张摘录卡共用一次读取，该文件的修改时间变化后重新读取。 */
  const fileTexts = new Map<string, { url: string; text: Promise<string | null> }>()
  const fileText = (path: string): Promise<string | null> => {
    const url = fileUrlOf(view(), path)
    const hit = fileTexts.get(path)
    if (hit?.url === url) return hit.text
    const text = fetch(url, { cache: 'no-store' }).then(
      (r) => (r.ok ? r.text() : null),
      () => null,
    )
    fileTexts.set(path, { url, text })
    return text
  }

  function taskInfo(nodeId: string, versionId: string) {
    const board = view()
    const n = board?.doc.nodes.find((n) => n.id === nodeId)
    const version = n?.type === 'generate' ? n.versions.find((v) => v.id === versionId) : undefined
    const task = board?.tasks?.[versionId]
    const records =
      board?.doc.runs?.filter((r) => r.node === nodeId && r.version === versionId) ?? []
    const taskId = task?.taskId ?? records.findLast((r) => r.task)?.task
    const output = task?.output ?? version?.path
    const message = records.at(-1)?.message
    return {
      taskId,
      message,
      details: [
        '取回原任务，不重新生成；远端费用以平台结算为准',
        ...(taskId ? [`任务号：${taskId}`] : []),
        ...(output ? [`结果位置：${output}`] : []),
        ...(message ? [message] : []),
      ].join('\n'),
    }
  }

  return {
    props,
    view,
    broken,
    fault,
    setFault,
    z,
    setZ,
    px,
    setPx,
    py,
    setPy,
    size,
    setSize,
    selected,
    setSelected,
    moving,
    setMoving,
    marquee,
    setMarquee,
    renaming,
    setRenaming,
    edgeSelected,
    setEdgeSelected,
    linking,
    setLinking,
    linkTarget,
    setLinkTarget,
    guides,
    setGuides,
    menu,
    setMenu,
    tall,
    setTall,
    now,
    flowGl,
    setFlowGl,
    fullscreen,
    setFullscreen,
    exports,
    setExports,
    clipTarget,
    setClipTarget,
    players,
    arts,
    exportAborts,
    get stage() {
      return stage
    },
    set stage(v) {
      stage = v
    },
    get dropAnchor() {
      return dropAnchor
    },
    set dropAnchor(v) {
      dropAnchor = v
    },
    get contextUpload() {
      return contextUpload
    },
    set contextUpload(v) {
      contextUpload = v
    },
    get drag() {
      return drag
    },
    get touches() {
      return touches
    },
    set drag(v) {
      drag = v
    },
    get pointerAt() {
      return pointerAt
    },
    set pointerAt(v) {
      pointerAt = v
    },
    get pasteWithInputs() {
      return pasteWithInputs
    },
    set pasteWithInputs(v) {
      pasteWithInputs = v
    },
    get space() {
      return space
    },
    set space(v) {
      space = v
    },
    get pressed() {
      return pressed
    },
    set pressed(v) {
      pressed = v
    },
    get uploadAt() {
      return uploadAt
    },
    set uploadAt(v) {
      uploadAt = v
    },
    get lastPicked() {
      return lastPicked
    },
    set lastPicked(v) {
      lastPicked = v
    },
    get picks() {
      return picks
    },
    set picks(v) {
      picks = v
    },
    load,
    apply,
    travel,
    depth,
    run,
    retrieve,
    nodes,
    byId,
    pos,
    grid,
    gridShift,
    toWorld,
    fit,
    zoomAt,
    center,
    single,
    edgePaths,
    excerptOfNode,
    fileText,
    taskInfo,
  }
}

export type CanvasController = ReturnType<typeof createCanvasController>
