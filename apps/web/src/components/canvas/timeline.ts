/**
 * 时间线的片段编辑与本地播放。
 *
 * 片段编辑是纯函数：返回新的一组片段，由调用方提交成一次 `update clips`。
 * 播放头、播放状态与选中的片段只在本地、不存盘；同一条时间线的节点与全屏编辑共用一份会话（`useSession`）。
 */

import type { CanvasClip } from '@qywork/core'
import { type Accessor, createSignal, onCleanup } from 'solid-js'

/** 片段最短 0.1 秒：再短的段在轨道上抓不住，导出也不足 3 帧。 */
export const MIN_CLIP = 0.1

/** 入点出点取到毫秒：拖动换算出的秒数带十几位小数，写进画布文件没有意义。 */
function ms(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

export function lengthOf(c: CanvasClip): number {
  return c.out - c.in
}

export function totalOf(clips: readonly CanvasClip[]): number {
  return clips.reduce((n, c) => n + lengthOf(c), 0)
}

/** 每段在成片里的起点。 */
export function startsOf(clips: readonly CanvasClip[]): number[] {
  let at = 0
  return clips.map((c) => {
    const start = at
    at += lengthOf(c)
    return start
  })
}

/** 成片时刻 `t` 落在第几段、对应源文件里的哪一秒；`t` 在终点时落在最后一段的出点。没有片段回 `null`。 */
export function locate(
  clips: readonly CanvasClip[],
  t: number,
): { index: number; source: number } | null {
  if (!clips.length) return null
  const starts = startsOf(clips)
  for (let i = clips.length - 1; i >= 0; i--) {
    if (t >= starts[i]! || i === 0) {
      const c = clips[i]!
      return { index: i, source: Math.min(c.out, c.in + Math.max(0, t - starts[i]!)) }
    }
  }
  return null
}

/** 在成片时刻 `t` 把所在的段一分为二；离段的两端不足 `MIN_CLIP` 时不分，回 `null`。 */
export function splitAt(clips: readonly CanvasClip[], t: number): CanvasClip[] | null {
  const at = locate(clips, t)
  if (!at) return null
  const c = clips[at.index]!
  const cut = ms(at.source)
  if (cut - c.in < MIN_CLIP || c.out - cut < MIN_CLIP) return null
  return [
    ...clips.slice(0, at.index),
    { path: c.path, in: c.in, out: cut },
    { path: c.path, in: cut, out: c.out },
    ...clips.slice(at.index + 1),
  ]
}

export function withoutClip(clips: readonly CanvasClip[], index: number): CanvasClip[] {
  return clips.filter((_, i) => i !== index)
}

/** 把第 `from` 段挪到第 `to` 个间隙（0 是最前，`clips.length` 是最后）。位置不变时回 `null`。 */
export function moveClip(
  clips: readonly CanvasClip[],
  from: number,
  to: number,
): CanvasClip[] | null {
  if (to === from || to === from + 1) return null
  const next = [...clips]
  const [moved] = next.splice(from, 1)
  next.splice(to > from ? to - 1 : to, 0, moved!)
  return next
}

export function insertClips(
  clips: readonly CanvasClip[],
  at: number,
  added: readonly CanvasClip[],
): CanvasClip[] {
  return [...clips.slice(0, at), ...added, ...clips.slice(at)]
}

/**
 * 拖第 `index` 段的入点（`edge` 为 `in`）或出点到源时间 `value`：入点不小于 0，出点不超过源时长 `duration`，
 * 段长不短于 `MIN_CLIP`。
 */
export function trimClip(
  clips: readonly CanvasClip[],
  index: number,
  edge: 'in' | 'out',
  value: number,
  duration: number,
): CanvasClip[] {
  const c = clips[index]!
  const next =
    edge === 'in'
      ? { ...c, in: ms(Math.min(Math.max(0, value), c.out - MIN_CLIP)) }
      : { ...c, out: ms(Math.max(Math.min(duration, value), c.in + MIN_CLIP)) }
  return clips.map((x, i) => (i === index ? next : x))
}

/** 成片时刻 `t` 落在片段之间的第几个间隙：数中点在 `t` 之前的段，`skip` 那段不算（拖动中的段）。 */
export function gapAt(clips: readonly CanvasClip[], t: number, skip = -1): number {
  const starts = startsOf(clips)
  let gap = 0
  for (const [i, c] of clips.entries()) {
    if (i !== skip && starts[i]! + lengthOf(c) / 2 < t) gap = i + 1
  }
  return gap
}

// ── 本地播放 ──

export interface TimelineSession {
  playhead: Accessor<number>
  playing: Accessor<boolean>
  selected: Accessor<number | null>
  select(index: number | null): void
  /** 预览：两个 `<video>` 叠放、轮流播放。同一时刻只挂在一处（节点或全屏），移动它会暂停播放。 */
  preview: HTMLDivElement
  /** 节点改了片段或静音时调用：片段变了就停下、按原播放头重新定位。 */
  sync(urls: string[], clips: CanvasClip[], muted: boolean): void
  seek(t: number): void
  toggle(): void
  pause(): void
  /** 当前显示的视图登记的：屏幕横坐标对应的成片时刻。拖进来的片段插在哪、右键「在此处分割」分在哪，都按它算。 */
  timeAtClient?: (clientX: number) => number
}

const sessions = new Map<string, { session: TimelineSession; users: number; dispose(): void }>()

/** 在组件里取这条时间线的会话；最后一个使用它的组件卸载时释放。 */
export function useSession(id: string): TimelineSession {
  let entry = sessions.get(id)
  if (!entry) {
    entry = { ...createSession(), users: 0 }
    sessions.set(id, entry)
  }
  entry.users += 1
  const held = entry
  onCleanup(() => {
    held.users -= 1
    if (held.users > 0) return
    held.dispose()
    sessions.delete(id)
  })
  return held.session
}

/** 已挂载的时间线的会话；没有回 `undefined`。画布按 Delete 时据此判断是删片段还是删节点。 */
export function sessionOf(id: string): TimelineSession | undefined {
  return sessions.get(id)?.session
}

/** 终点停在最后一帧之前：定位到恰好出点时常解不出画面。 */
const LAST_FRAME = 1 / 30

function createSession(): { session: TimelineSession; dispose(): void } {
  const [playhead, setPlayhead] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const [selected, setSelected] = createSignal<number | null>(null)
  const preview = document.createElement('div')
  preview.className = 'canvas-tl-screen'
  const videos = [0, 1].map(() => {
    const v = document.createElement('video')
    v.playsInline = true
    v.preload = 'auto'
    preview.append(v)
    return v
  })
  let urls: string[] = []
  let clips: CanvasClip[] = []
  let key = ''
  let active = 0
  /** 两个视频元素各装着第几段；-1 是空。 */
  const holds = [-1, -1]
  let raf = 0

  const load = (slot: number, index: number, time: number) => {
    const v = videos[slot]!
    if (v.getAttribute('src') !== urls[index]) v.src = urls[index]!
    holds[slot] = index
    v.currentTime = time
  }
  const show = (slot: number) => {
    active = slot
    for (const [k, v] of videos.entries()) v.style.visibility = k === slot ? 'visible' : 'hidden'
  }
  const preload = (index: number) => {
    const next = clips[index]
    if (next) load(1 - active, index, next.in)
  }
  const pause = () => {
    setPlaying(false)
    cancelAnimationFrame(raf)
    for (const v of videos) v.pause()
  }
  const seek = (t: number) => {
    const next = Math.min(Math.max(0, t), totalOf(clips))
    setPlayhead(next)
    const at = locate(clips, next)
    if (!at) return
    const c = clips[at.index]!
    load(active, at.index, Math.min(at.source, c.out - LAST_FRAME))
    show(active)
    preload(at.index + 1)
    if (playing()) videos[active]!.play().catch(pause)
  }
  const tick = () => {
    const index = holds[active]!
    const c = clips[index]
    const v = videos[active]!
    if (!c) return pause()
    if (v.ended || v.currentTime >= c.out - 1 / 60) {
      if (index + 1 >= clips.length) {
        pause()
        setPlayhead(totalOf(clips))
        return
      }
      const other = 1 - active
      if (holds[other] !== index + 1) load(other, index + 1, clips[index + 1]!.in)
      // 先切显示再停旧的：旧元素的 pause 事件到达时它已不是当前元素，不会被当成意外暂停。
      show(other)
      videos[other]!.play().catch(pause)
      v.pause()
      preload(index + 2)
    }
    const now = holds[active]!
    setPlayhead(startsOf(clips)[now]! + videos[active]!.currentTime - clips[now]!.in)
    raf = requestAnimationFrame(tick)
  }
  // 当前元素被浏览器停下（预览挂到别处、系统暂停）时，播放状态跟着停。
  for (const v of videos) {
    v.addEventListener('pause', () => {
      if (playing() && v === videos[active] && !v.ended) pause()
    })
  }

  const session: TimelineSession = {
    playhead,
    playing,
    selected,
    select: setSelected,
    preview,
    sync(nextUrls, nextClips, muted) {
      for (const v of videos) v.muted = muted
      const nextKey = JSON.stringify([nextUrls, nextClips])
      if (nextKey === key) return
      key = nextKey
      pause()
      urls = nextUrls
      clips = nextClips
      holds[0] = -1
      holds[1] = -1
      const sel = selected()
      if (sel !== null && sel >= clips.length) setSelected(null)
      if (clips.length) seek(playhead())
      else setPlayhead(0)
    },
    seek,
    toggle() {
      if (playing()) return pause()
      if (!clips.length) return
      if (playhead() >= totalOf(clips) - LAST_FRAME) seek(0)
      setPlaying(true)
      videos[active]!.play().catch(pause)
      raf = requestAnimationFrame(tick)
    },
    pause,
  }
  return {
    session,
    dispose() {
      pause()
      for (const v of videos) {
        v.removeAttribute('src')
        v.load()
      }
      preview.remove()
    },
  }
}
