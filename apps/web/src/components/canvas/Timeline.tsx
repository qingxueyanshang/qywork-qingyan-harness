/**
 * 时间线的界面：画布上的节点与全屏编辑是同一个组件的两种布局（`mode`）。
 *
 * 工具行（分割、删除、播放与时间、导出、全屏）、预览（有片段时）、刻度与一条视频轨。片段的增删、裁剪、换位、分割
 * 均提交为一次 `update clips`；播放头、播放状态与选中的片段保存在会话中（`timeline.ts`），两种布局共用。
 *
 * 指针横坐标按内容层的实际外框与其画布宽度之比换算为时刻，画布缩放与全屏的时间轴缩放均已包含在该比值中。
 */

import { type CanvasClip, type CanvasTimelineNode, TIMELINE_W } from '@qywork/core'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Index,
  on,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'
import {
  IconDownload,
  IconExpand,
  IconPause,
  IconPlay,
  IconPlus,
  IconScissors,
  IconTrash,
  IconVolume,
  IconVolumeOff,
  IconX,
} from '../Icons.tsx'
import { drawFilmstrip } from './frame.ts'
import { clock } from './Player.tsx'
import {
  canSplit,
  gapAt,
  lengthOf,
  metaOf,
  moveClip,
  splitAt,
  startsOf,
  thumbCanvas,
  totalOf,
  trimClip,
  useSession,
  withoutClip,
} from './timeline.ts'

/** 节点中轨道区的宽度：节点宽度减去左侧静音按钮与两侧内边距。 */
const LANE_W = TIMELINE_W - 48
/** 轨道至少显示 30 秒；片段总长更长时按总长加 10%，末尾留出「+」的位置。 */
const MIN_SPAN = 30
/** 刻度的候选间隔（秒），取使相邻标签间距不小于 `LABEL_GAP` 的最小一档。 */
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]
const LABEL_GAP = 64
/** 「+」按钮的宽度（画布单位）。 */
const ADD_W = 28

/** `mm:ss.s`。 */
function clockTenths(seconds: number): string {
  const t = Math.round(seconds * 10) / 10
  return `${clock(Math.floor(t) * 1000)}.${Math.round((t % 1) * 10)}`
}

export interface TimelineProps {
  node: CanvasTimelineNode
  mode: 'node' | 'full'
  /** 预览挂载在此处：全屏打开时节点把预览让给全屏视图。 */
  showPreview: boolean
  urlOf: (path: string) => string
  /** 导出进度 0–1；未在导出时为 `null`。 */
  exporting: number | null
  /** 提交新的一组片段，成功时返回 `true`。 */
  setClips: (clips: CanvasClip[]) => Promise<boolean>
  setMuted: (muted: boolean) => void
  /** 点击轨道时调用：在画布上选中节点。 */
  onFocus: () => void
  /** 「+」：打开素材选择框，选中的视频按 `gap` 插入。 */
  onAdd: (anchor: HTMLElement, gap: number) => void
  /** 右键点击片段：第 `index` 段、指针处的成片时刻与屏幕坐标。 */
  onClipMenu: (index: number, t: number, clientX: number, clientY: number) => void
  onExport: () => void
  onCancelExport: () => void
  /** 节点中为「全屏编辑」，全屏中为「退出全屏」。 */
  onFullscreen: () => void
}

/** 拖动中的状态：裁剪修改该段的入点或出点；换位记录指针相对段左端的偏移。 */
type Gesture =
  | { kind: 'scrub' }
  | {
      kind: 'trim'
      index: number
      edge: 'in' | 'out'
      sx: number
      base: CanvasClip[]
      duration: number
    }
  | { kind: 'move'; index: number; sx: number; moved: boolean; t: number }

export function Timeline(props: TimelineProps) {
  const session = useSession(props.node.id)
  /** 拖动中的片段（裁剪时）；松开指针提交前一直使用它。 */
  const [draft, setDraft] = createSignal<CanvasClip[] | null>(null)
  /** 换位拖动中：被拖动的段、其横向偏移（画布单位）与插入的间隙。 */
  const [moving, setMoving] = createSignal<{ index: number; dx: number; gap: number } | null>(null)
  /** 全屏中的时间轴缩放倍数；节点中恒为 1。 */
  const [zoom, setZoom] = createSignal(1)
  /** 全屏中轨道区的实际宽度（画布单位）；节点中为 `LANE_W`。 */
  const [laneW, setLaneW] = createSignal(LANE_W)
  let inner!: HTMLDivElement
  let scroller!: HTMLDivElement
  /** 预览的容器：仅在有片段（或全屏）时存在，出现时把会话的预览挂载到其中。 */
  const [view, setView] = createSignal<HTMLDivElement>()
  let gesture: Gesture | null = null

  const clips = () => draft() ?? props.node.clips
  const total = () => totalOf(clips())
  const span = () => Math.max(MIN_SPAN, total() * 1.1 + 1)
  const pps = () => (laneW() / span()) * (props.mode === 'full' ? zoom() : 1)
  const contentW = () => Math.max(laneW(), total() * pps() + ADD_W + 8)
  const starts = () => startsOf(clips())

  createEffect(() => {
    session.sync(
      props.node.clips.map((c) => props.urlOf(c.path)),
      props.node.clips,
      !!props.node.muted,
    )
  })
  createEffect(() => {
    const el = view()
    if (props.showPreview && props.node.clips.length && el) el.append(session.preview)
  })
  const timeAtClient = (clientX: number) => timeAt(clientX)
  createEffect(() => {
    if (props.showPreview) session.timeAtClient = timeAtClient
  })
  onCleanup(() => {
    if (session.timeAtClient === timeAtClient) delete session.timeAtClient
  })

  onMount(() => {
    if (props.mode !== 'full') return
    const ro = new ResizeObserver(() => setLaneW(scroller.clientWidth))
    ro.observe(scroller)
    onCleanup(() => ro.disconnect())
  })

  /** 屏幕横坐标对应的成片时刻。 */
  const timeAt = (clientX: number) => {
    const r = inner.getBoundingClientRect()
    return Math.max(0, ((clientX - r.left) * (contentW() / r.width)) / pps())
  }
  /** 屏幕上的横向位移换算为画布单位。 */
  const unitsOf = (dx: number) => dx * (contentW() / inner.getBoundingClientRect().width)

  const ticks = () => {
    const step = STEPS.find((s) => s * pps() >= LABEL_GAP) ?? STEPS.at(-1)!
    const minor = step / 5
    const out: { x: number; label: string | null }[] = []
    const end = contentW() / pps()
    for (let k = 0; k * minor <= end; k++) {
      const t = k * minor
      // 末端无法容纳完整标签的位置只绘制刻度线。
      const major = k % 5 === 0 && t * pps() + 34 <= contentW()
      if (!major && minor * pps() < 8) continue
      out.push({ x: t * pps(), label: major ? clock(t * 1000) : null })
    }
    return out
  }

  const commit = async (next: CanvasClip[] | null) => {
    if (!next) return
    await props.setClips(next)
  }

  // ── 指针 ──

  const begin = (e: PointerEvent, g: Gesture) => {
    e.stopPropagation()
    e.preventDefault()
    props.onFocus()
    gesture = g
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onScrubDown = (e: PointerEvent) => {
    if (e.button !== 0) return
    begin(e, { kind: 'scrub' })
    session.select(null)
    session.seek(timeAt(e.clientX))
  }
  const onClipDown = (e: PointerEvent, index: number) => {
    if (e.button !== 0) return
    begin(e, { kind: 'move', index, sx: e.clientX, moved: false, t: timeAt(e.clientX) })
    session.select(index)
  }
  const onTrimDown = (e: PointerEvent, index: number, edge: 'in' | 'out') => {
    if (e.button !== 0) return
    const base = props.node.clips
    begin(e, { kind: 'trim', index, edge, sx: e.clientX, base, duration: Number.POSITIVE_INFINITY })
    session.select(index)
    const g = gesture
    void metaOf(props.urlOf(base[index]!.path)).then(({ duration }) => {
      if (g?.kind === 'trim' && duration > 0) g.duration = duration
    })
  }
  const onMove = (e: PointerEvent) => {
    const g = gesture
    if (!g) return
    if (g.kind === 'scrub') {
      session.seek(timeAt(e.clientX))
      return
    }
    if (g.kind === 'trim') {
      const c = g.base[g.index]!
      const dt = unitsOf(e.clientX - g.sx) / pps()
      const value = (g.edge === 'in' ? c.in : c.out) + dt
      const next = trimClip(g.base, g.index, g.edge, value, g.duration)
      setDraft(next)
      // 预览随之定位到拖动的一端。
      const t = startsOf(next)[g.index]! + (g.edge === 'in' ? 0 : lengthOf(next[g.index]!) - 1 / 30)
      session.seek(t)
      return
    }
    const dx = unitsOf(e.clientX - g.sx)
    if (!g.moved && Math.abs(e.clientX - g.sx) < 3) return
    g.moved = true
    setMoving({ index: g.index, dx, gap: gapAt(props.node.clips, timeAt(e.clientX), g.index) })
  }
  const onUp = (e: PointerEvent) => {
    const g = gesture
    gesture = null
    if (!g) return
    if (g.kind === 'trim') {
      const next = draft()
      void commit(next).then(() => setDraft(null))
      return
    }
    if (g.kind === 'move') {
      const m = moving()
      setMoving(null)
      const moved = m ? moveClip(props.node.clips, m.index, m.gap) : null
      if (m && moved) {
        session.select(m.gap > m.index ? m.gap - 1 : m.gap)
        void commit(moved)
      } else if (!m) session.seek(timeAt(e.clientX))
    }
  }

  // ── 操作 ──

  const split = () => {
    session.pause()
    void commit(splitAt(props.node.clips, session.playhead()))
  }
  const remove = () => {
    const i = session.selected()
    if (i === null) return
    session.select(null)
    void commit(withoutClip(props.node.clips, i))
  }
  const splittable = () => canSplit(props.node.clips, session.playhead(), session.playing())

  // 全屏：Space 播放、Delete 删片段、Esc 退出；Ctrl+滚轮缩放时间轴，滚轮横向滚动。
  onMount(() => {
    if (props.mode !== 'full') return
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null
      if (target?.closest('input, textarea, [contenteditable="true"]')) return
      if (e.code === 'Space') {
        e.preventDefault()
        session.toggle()
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        remove()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        props.onFullscreen()
      }
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      if (e.ctrlKey || e.metaKey) {
        setZoom((z) => Math.min(20, Math.max(1, z * Math.exp(-e.deltaY * 0.002))))
      } else {
        scroller.scrollLeft += e.deltaY + e.deltaX
      }
    }
    window.addEventListener('keydown', onKey)
    scroller.addEventListener('wheel', onWheel, { passive: false })
    onCleanup(() => {
      window.removeEventListener('keydown', onKey)
      scroller.removeEventListener('wheel', onWheel)
    })
  })

  const exportButton = () => (
    <button
      type="button"
      class="canvas-tl-export"
      data-tip={props.exporting === null ? '导出' : '取消导出'}
      aria-label={props.exporting === null ? '导出' : '取消导出'}
      disabled={!props.node.clips.length}
      onClick={() => (props.exporting === null ? props.onExport() : props.onCancelExport())}
    >
      <Show when={props.exporting !== null} fallback={<IconDownload size={14} />}>
        <span>{Math.floor((props.exporting ?? 0) * 100)}%</span>
      </Show>
    </button>
  )

  return (
    <div class="canvas-tl" classList={{ full: props.mode === 'full' }}>
      <Show when={props.mode === 'full'}>
        <div class="canvas-tl-head">
          <span class="truncate">{props.node.name}</span>
          {exportButton()}
          <button type="button" class="canvas-tl-close" onClick={() => props.onFullscreen()}>
            <IconX size={14} />
            退出全屏
          </button>
        </div>
      </Show>
      <Show when={props.mode === 'full' || props.node.clips.length}>
        <div class="canvas-tl-view" ref={setView} />
      </Show>
      <div class="canvas-tl-bar">
        <button
          type="button"
          data-tip="分割"
          aria-label="分割"
          disabled={!splittable()}
          onClick={split}
        >
          <IconScissors size={14} />
        </button>
        <button
          type="button"
          data-tip="删除片段"
          aria-label="删除片段"
          disabled={session.selected() === null}
          onClick={remove}
        >
          <IconTrash size={14} />
        </button>
        <div class="canvas-tl-play">
          <button
            type="button"
            aria-label={session.playing() ? '暂停' : '播放'}
            disabled={!props.node.clips.length}
            onClick={() => session.toggle()}
          >
            <Show when={session.playing()} fallback={<IconPlay size={14} />}>
              <IconPause size={14} />
            </Show>
          </button>
          <span>
            {props.mode === 'full'
              ? clockTenths(session.playhead())
              : clock(session.playhead() * 1000)}{' '}
            / {clock(total() * 1000)}
          </span>
        </div>
        <Show
          when={props.mode === 'node'}
          fallback={
            <input
              class="canvas-tl-zoom"
              type="range"
              min="1"
              max="20"
              step="0.1"
              value={zoom()}
              aria-label="时间轴缩放"
              onInput={(e) => setZoom(Number(e.currentTarget.value))}
            />
          }
        >
          {exportButton()}
          <button type="button" class="canvas-tl-full-btn" onClick={() => props.onFullscreen()}>
            <IconExpand size={14} />
            全屏编辑
          </button>
        </Show>
      </div>
      <div class="canvas-tl-tracks">
        <div class="canvas-tl-gutter">
          <button
            type="button"
            data-tip={props.node.muted ? '开启声音' : '静音'}
            aria-label={props.node.muted ? '开启声音' : '静音'}
            onClick={() => props.setMuted(!props.node.muted)}
          >
            <Show when={props.node.muted} fallback={<IconVolume size={14} />}>
              <IconVolumeOff size={14} />
            </Show>
          </button>
        </div>
        <div class="canvas-tl-scroll" ref={scroller}>
          <div
            class="canvas-tl-inner"
            ref={inner}
            style={{ width: `${contentW()}px` }}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onPointerCancel={onUp}
          >
            <div class="canvas-tl-ruler" onPointerDown={onScrubDown}>
              <For each={ticks()}>
                {(tick) => (
                  <>
                    <i classList={{ major: !!tick.label }} style={{ left: `${tick.x}px` }} />
                    <Show when={tick.label}>
                      <span style={{ left: `${tick.x}px` }}>{tick.label}</span>
                    </Show>
                  </>
                )}
              </For>
            </div>
            <div class="canvas-tl-lane" onPointerDown={onScrubDown}>
              <Show
                when={clips().length}
                fallback={
                  <button
                    type="button"
                    class="canvas-tl-empty"
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={(e) => props.onAdd(e.currentTarget, 0)}
                  >
                    <IconPlus size={14} />
                    添加视频
                  </button>
                }
              >
                {/* 按位置创建块：每次重新读取画布时片段都是新对象，按对象创建会使缩略图全部重绘。 */}
                <Index each={clips()}>
                  {(clip, i) => (
                    <ClipBlock
                      clip={clip()}
                      url={props.urlOf(clip().path)}
                      left={starts()[i]! * pps() + (moving()?.index === i ? moving()!.dx : 0)}
                      width={lengthOf(clip()) * pps()}
                      selected={session.selected() === i}
                      lifted={moving()?.index === i}
                      onDown={(e) => onClipDown(e, i)}
                      onTrim={(e, edge) => onTrimDown(e, i, edge)}
                      onMenu={(e) => {
                        props.onFocus()
                        session.select(i)
                        props.onClipMenu(i, timeAt(e.clientX), e.clientX, e.clientY)
                      }}
                      onSelect={() => {
                        props.onFocus()
                        session.select(i)
                      }}
                    />
                  )}
                </Index>
                <button
                  type="button"
                  class="canvas-tl-add"
                  aria-label="添加视频"
                  style={{ left: `${total() * pps() + 4}px` }}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => props.onAdd(e.currentTarget, props.node.clips.length)}
                >
                  <IconPlus size={14} />
                </button>
                <Show when={moving()}>
                  {(m) => (
                    <span
                      class="canvas-tl-gap"
                      style={{
                        left: `${(startsOf(props.node.clips)[m().gap] ?? total()) * pps()}px`,
                      }}
                    />
                  )}
                </Show>
              </Show>
            </div>
            <Show when={clips().length}>
              <span
                class="canvas-tl-playhead"
                style={{ left: `${session.playhead() * pps()}px` }}
              />
            </Show>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 轨道上的一段：宽度按时长确定，内部绘制该段的帧缩略图，两端可拖动裁剪。 */
function ClipBlock(props: {
  clip: CanvasClip
  url: string
  left: number
  width: number
  selected: boolean
  lifted: boolean
  onDown: (e: PointerEvent) => void
  onTrim: (e: PointerEvent, edge: 'in' | 'out') => void
  onMenu: (e: MouseEvent) => void
  /** 键盘选中（Enter / Space）。指针按下时已在 `onDown` 中选中。 */
  onSelect: () => void
}) {
  const [missing, setMissing] = createSignal(false)
  let canvas!: HTMLCanvasElement
  // 缩略图只在地址、入点出点或宽度（取 8 的倍数）变化时重绘；拖动裁剪时块被拉伸，松开指针提交后才重绘。
  const key = createMemo(() =>
    JSON.stringify([
      props.url,
      props.clip.in,
      props.clip.out,
      Math.max(8, Math.round(props.width / 8) * 8),
    ]),
  )
  createEffect(
    on(key, (k) => {
      const [url, from, to] = JSON.parse(k) as [string, number, number, number]
      const ac = new AbortController()
      // 先绘制到另一块画布上，完成后再复制过来：直接修改宽度会清空画布，取帧期间块为空白。
      const timer = setTimeout(() => {
        // 块高在节点中与全屏中不同，按块在页面上的实际宽高计算。
        const size = thumbCanvas(canvas.clientWidth, canvas.clientHeight)
        const next = document.createElement('canvas')
        next.width = size.width
        next.height = size.height
        drawFilmstrip(url, next, ac.signal, { from, to }).then(
          () => {
            if (ac.signal.aborted) return
            canvas.width = next.width
            canvas.height = next.height
            canvas.getContext('2d')?.drawImage(next, 0, 0)
            setMissing(false)
          },
          () => setMissing(true),
        )
      }, 150)
      onCleanup(() => {
        clearTimeout(timer)
        ac.abort()
      })
    }),
  )
  return (
    <button
      type="button"
      class="canvas-tl-clip"
      aria-label={`${props.clip.path.split('/').pop()} ${props.clip.in}–${props.clip.out} 秒`}
      classList={{ selected: props.selected, lifted: props.lifted, missing: missing() }}
      style={{ left: `${props.left}px`, width: `${props.width}px` }}
      onPointerDown={(e) => {
        // 右键交给片段菜单处理，不交给画布平移。
        if (e.button === 2) e.stopPropagation()
        else props.onDown(e)
      }}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        props.onMenu(e)
      }}
      onClick={(e) => {
        // 只处理键盘触发的点击：指针的按下与拖动由 `onDown` 处理，换位后再处理点击会选中原位置上的另一段。
        if (e.detail === 0) props.onSelect()
      }}
    >
      <canvas ref={canvas} />
      <Show when={missing()}>
        <span class="canvas-tl-missing">缺失</span>
      </Show>
      <span class="canvas-tl-trim in" onPointerDown={(e) => props.onTrim(e, 'in')} />
      <span class="canvas-tl-trim out" onPointerDown={(e) => props.onTrim(e, 'out')} />
    </button>
  )
}
