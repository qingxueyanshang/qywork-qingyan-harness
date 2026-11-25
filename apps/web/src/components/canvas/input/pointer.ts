/** 画布区的指针与滚轮：平移、缩放、选中、拖动、框选、从连接点连线与双击。 */

import {
  applyCanvasOps,
  type CanvasEdgeRole,
  type CanvasOp,
  excerptOf,
  inputsOf,
  isTextCard,
  type MediaInputRole,
  modeOf,
} from '@qywork/core'
import { TOUCH_SLOP } from '../../../lib/long-press.ts'
import { openFileInPanel, setFileSelectRequest } from '../../../lib/store/index.ts'
import type { CanvasController } from '../board/controller.ts'
import { mediaOf } from '../GeneratePanel.tsx'
import { boundsOf, snap } from '../snap.ts'
import { addClips, clipsInto, gapFor, onTracksAt, timelineUnder } from './clips.ts'
import { contextOf, openContext } from './context-menu.ts'
import { extendable } from './create.ts'
import { touchDown, touchMove, touchUp } from './touch.ts'

/** 拖动节点时的吸附范围（屏幕像素）：按缩放换算为画布单位，缩放后吸附距离不变。 */
const SNAP = 6

export const onPointerDown = (canvas: CanvasController, e: PointerEvent) => {
  if (e.pointerType === 'touch' && touchDown(canvas, e)) return
  const target = e.target as HTMLElement
  canvas.pressed = target
  // 平移：中键、右键或按住 Space 时的左键，在画布任意位置均可。
  if (e.button === 1 || e.button === 2 || (e.button === 0 && canvas.space)) {
    if (target.closest('.canvas-panel, .canvas-rail, .canvas-picker, .canvas-dock')) return
    e.preventDefault()
    canvas.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, px: canvas.px(), py: canvas.py() }
    if (e.button === 2 && !canvas.space) canvas.drag.context = contextOf(target)
    canvas.stage.classList.add('grabbing')
    canvas.stage.setPointerCapture(e.pointerId)
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
    canvas.setSelected(new Set<string>())
    canvas.setEdgeSelected(hit.dataset.edge!)
    return
  }
  canvas.setEdgeSelected(null)
  const nodeEl = target.closest<HTMLElement>('[data-node]')
  const pressedId = nodeEl?.dataset.node
  if (e.pointerType === 'touch' && !(pressedId && canvas.selected().has(pressedId))) {
    // 单指拖动空白处或未选中的节点为平移：触屏没有中键、右键与 Space，卡片铺满视野时滑动多从卡片上开始。
    // 只有已选中的节点可以拖动；轻点节点选中它，轻点空白处取消选中。
    canvas.setSelected(new Set<string>())
    canvas.drag = {
      mode: 'pan',
      sx: e.clientX,
      sy: e.clientY,
      px: canvas.px(),
      py: canvas.py(),
      ...(pressedId ? { tap: pressedId } : {}),
    }
  } else if (nodeEl) {
    const id = nodeEl.dataset.node!
    let next = canvas.selected()
    if (e.shiftKey) {
      next = new Set(next)
      if (next.has(id)) (next as Set<string>).delete(id)
      else (next as Set<string>).add(id)
    } else if (!next.has(id)) next = new Set([id])
    canvas.setSelected(next)
    const start = [...next].flatMap((s) => {
      const n = canvas.byId(s)
      return n ? [{ id: n.id, ...canvas.pos(n) }] : []
    })
    canvas.drag = { mode: 'move', sx: e.clientX, sy: e.clientY, start, moved: false }
  } else {
    // 左键拖动空白处为框选；按住 Shift 时叠加到已有选区。
    const base = e.shiftKey ? canvas.selected() : new Set<string>()
    if (!e.shiftKey) canvas.setSelected(base)
    const r = canvas.stage.getBoundingClientRect()
    canvas.drag = { mode: 'box', sx: e.clientX - r.left, sy: e.clientY - r.top, base }
  }
  canvas.stage.setPointerCapture(e.pointerId)
}

export const onPointerMove = (canvas: CanvasController, e: PointerEvent) => {
  canvas.pointerAt = canvas.toWorld(e.clientX, e.clientY)
  if (e.pointerType === 'touch' && touchMove(canvas, e)) return
  const d = canvas.drag
  if (!d || d.mode === 'pinch') return
  if (d.mode === 'link') {
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return
    d.moved = true
    canvas.setLinking({ from: d.from, ...canvas.toWorld(e.clientX, e.clientY) })
    const over = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest<HTMLElement>('[data-node]')?.dataset.node
    canvas.setLinkTarget(
      over && (linkRole(canvas, d.from, over) || clipsInto(canvas, d.from, over)) ? over : null,
    )
    return
  }
  if (d.mode === 'pan') {
    canvas.setPx(d.px + e.clientX - d.sx)
    canvas.setPy(d.py + e.clientY - d.sy)
    return
  }
  if (d.mode === 'move') {
    if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) return
    d.moved = true
    const dx = (e.clientX - d.sx) / canvas.z()
    const dy = (e.clientY - d.sy) / canvas.z()
    const ids = new Set(d.start.map((s) => s.id))
    const boxes = d.start.flatMap((s) => {
      const n = canvas.byId(s.id)
      return n ? [{ x: s.x + dx, y: s.y + dy, w: n.w, h: n.h }] : []
    })
    const fit = boxes.length
      ? snap(
          boundsOf(boxes),
          canvas.nodes().filter((n) => !ids.has(n.id)),
          SNAP / canvas.z(),
        )
      : { dx: 0, dy: 0, guides: [] }
    canvas.setGuides(fit.guides)
    canvas.setMoving(
      Object.fromEntries(
        d.start.map((s) => [s.id, { x: s.x + dx + fit.dx, y: s.y + dy + fit.dy }]),
      ),
    )
    canvas.setClipTarget(
      timelineUnder(
        canvas,
        e.clientX,
        e.clientY,
        d.start.map((s) => s.id),
      ),
    )
    return
  }
  const r = canvas.stage.getBoundingClientRect()
  const x = e.clientX - r.left
  const y = e.clientY - r.top
  const box = {
    x: Math.min(x, d.sx),
    y: Math.min(y, d.sy),
    w: Math.abs(x - d.sx),
    h: Math.abs(y - d.sy),
  }
  canvas.setMarquee(box)
  const x1 = (box.x - canvas.px()) / canvas.z()
  const y1 = (box.y - canvas.py()) / canvas.z()
  const x2 = (box.x + box.w - canvas.px()) / canvas.z()
  const y2 = (box.y + box.h - canvas.py()) / canvas.z()
  canvas.setSelected(
    new Set([
      ...d.base,
      ...canvas
        .nodes()
        .filter((n) => n.x < x2 && n.x + n.w > x1 && n.y < y2 && n.y + n.h > y1)
        .map((n) => n.id),
    ]),
  )
}

/**
 * 触屏长按（`lib/long-press.ts`）：按下节点或空白处后按住不动时，在按下处弹出右键菜单。结束进行中的拖动或平移并撤销其预览，
 * 松开时 `onPointerUp` 不再提交移动。按下处不是节点或空白（工具条、面板中的控件）时不处理。
 */
export const pressContext = (
  canvas: CanvasController,
  x: number,
  y: number,
  target: HTMLElement,
) => {
  const d = canvas.drag
  if (d?.mode !== 'move' && d?.mode !== 'pan') return
  canvas.drag = null
  if (d.mode === 'move') {
    canvas.setMoving({})
    canvas.setGuides([])
    canvas.setClipTarget(null)
  } else {
    canvas.setPx(d.px)
    canvas.setPy(d.py)
  }
  canvas.stage.classList.remove('grabbing')
  openContext(canvas, contextOf(target), x, y)
}

export const onPointerUp = (canvas: CanvasController, e: PointerEvent) => {
  if (e.pointerType === 'touch') touchUp(canvas, e)
  const d = canvas.drag
  canvas.drag = null
  canvas.stage.classList.remove('grabbing')
  canvas.setMarquee(null)
  canvas.setGuides([])
  if (d?.mode === 'pan' && d.context && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 3) {
    openContext(canvas, d.context, e.clientX, e.clientY)
    return
  }
  if (d?.mode === 'pan' && d.tap && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < TOUCH_SLOP) {
    canvas.setSelected(new Set([d.tap]))
    return
  }
  if (d?.mode === 'link') {
    const target = canvas.linkTarget()
    canvas.setLinking(null)
    canvas.setLinkTarget(null)
    if (!d.moved) {
      canvas.setMenu({ kind: 'out', anchor: d.anchor, nodeId: d.from })
    } else if (target && canvas.byId(target)?.type === 'timeline') {
      const path = mediaOf(canvas.view()!, d.from).path
      if (path) {
        void addClips(
          canvas,
          target,
          [path],
          gapFor(canvas, target, e.clientX, onTracksAt(target, e.clientX, e.clientY)),
        )
      }
    } else if (target) {
      void connect(canvas, d.from, target)
    } else if (e.type === 'pointerup' && extendable(canvas, d.from).length) {
      const r = canvas.stage.getBoundingClientRect()
      canvas.dropAnchor.style.left = `${e.clientX - r.left}px`
      canvas.dropAnchor.style.top = `${e.clientY - r.top}px`
      canvas.setMenu({
        kind: 'out',
        anchor: canvas.dropAnchor,
        nodeId: d.from,
        at: canvas.toWorld(e.clientX, e.clientY),
      })
    }
    return
  }
  if (d?.mode !== 'move' || !d.moved) return
  const into = canvas.clipTarget()
  canvas.setClipTarget(null)
  if (into) {
    // 加入时间线：节点回到原位置，其视频按指针处的间隙插入。
    const paths = d.start.flatMap((s) => mediaOf(canvas.view()!, s.id).path ?? [])
    canvas.setMoving({})
    void addClips(
      canvas,
      into,
      paths,
      gapFor(canvas, into, e.clientX, onTracksAt(into, e.clientX, e.clientY)),
    )
    return
  }
  const moved = canvas.moving()
  const ops: CanvasOp[] = Object.entries(moved).map(([id, p]) => ({
    op: 'update',
    id,
    x: Math.round(p.x),
    y: Math.round(p.y),
  }))
  // 松开指针时提交一次；响应体返回之前始终使用本地位置，避免节点先跳回原处再移到新位置。
  void canvas.apply(ops).then(() => canvas.setMoving({}))
}

/** 双击标题重命名，双击内容在主区打开对应文件；摘录卡打开后选中摘录的一段。 */
export const onDblClick = (canvas: CanvasController) => {
  const target = canvas.pressed
  const nodeEl = target?.closest<HTMLElement>('[data-node]')
  if (!target || !nodeEl) return
  const id = nodeEl.dataset.node!
  if (target.closest('.canvas-node-title')) {
    canvas.setRenaming(id)
    return
  }
  const media = canvas.view() ? mediaOf(canvas.view()!, id) : null
  if (!media?.path) return
  const path = media.path
  // 先读取摘录与文件全文再打开：打开文件会把面板切换到文件页，画布在面板中时随之卸载，之后无法读取节点。
  const excerpt = canvas.excerptOfNode(id)
  const text = excerpt ? canvas.fileText(path) : null
  openFileInPanel(path)
  void text?.then((whole) => {
    const r = whole === null ? null : excerptOf(whole, excerpt)
    if (r?.ok) setFileSelectRequest({ path, from: r.from, to: r.to })
  })
}

/**
 * 从 `from` 连接到 `to` 时的用途；无法连接时返回 `null`。先按素材类别与目标的模式确定用途，
 * 再交给 core 的操作校验检查一次：能否连接只由 core 判定。
 */
const linkRole = (canvas: CanvasController, from: string, to: string): CanvasEdgeRole | null => {
  const v = canvas.view()
  const target = canvas.byId(to)
  const source = canvas.byId(from)
  // 文本卡连接即在提示词末尾插入引用（core `syncTextInputs`），任何生成卡都可以连接。
  if (v && source && isTextCard(source) && target?.type === 'generate') {
    return applyCanvasOps(v.doc, [{ op: 'connect', from, to, role: 'text' }]).ok ? 'text' : null
  }
  const kind = v ? mediaOf(v, from).kind : null
  if (!v || !kind || kind === 'art' || target?.type !== 'generate') return null
  let role: MediaInputRole = kind === 'image' ? 'reference' : kind
  if (target.output === 'video' && kind === 'image' && modeOf(v.doc, to) === 'first_last') {
    const used = new Set(inputsOf(v.doc, to).map((e) => e.role))
    role = used.has('first_frame') ? 'last_frame' : 'first_frame'
  }
  return applyCanvasOps(v.doc, [{ op: 'connect', from, to, role }]).ok ? role : null
}

const connect = async (canvas: CanvasController, from: string, to: string) => {
  const role = linkRole(canvas, from, to)
  if (role) await canvas.apply([{ op: 'connect', from, to, role }])
}

/** 在连接点按下：拖出为连线，原地松开为点击（打开后续生成菜单）。 */
export const startLink = (canvas: CanvasController, e: PointerEvent, from: string) => {
  if (e.button !== 0) return
  e.stopPropagation()
  e.preventDefault()
  canvas.drag = {
    mode: 'link',
    from,
    sx: e.clientX,
    sy: e.clientY,
    moved: false,
    anchor: e.currentTarget as HTMLElement,
  }
  canvas.stage.setPointerCapture(e.pointerId)
}

export const onWheel = (canvas: CanvasController, e: WheelEvent) => {
  if ((e.target as Element).closest('.canvas-panel, .canvas-picker, .canvas-media-notice')) return
  e.preventDefault()
  const r = canvas.stage.getBoundingClientRect()
  const mx = e.clientX - r.left
  const my = e.clientY - r.top
  if (e.ctrlKey || e.metaKey) {
    const nz = Math.min(3, Math.max(0.1, canvas.z() * Math.exp(-e.deltaY * 0.0015)))
    canvas.setPx(mx - (mx - canvas.px()) * (nz / canvas.z()))
    canvas.setPy(my - (my - canvas.py()) * (nz / canvas.z()))
    canvas.setZ(nz)
  } else {
    canvas.setPx(canvas.px() - e.deltaX)
    canvas.setPy(canvas.py() - e.deltaY)
  }
}
