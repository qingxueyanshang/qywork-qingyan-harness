/**
 * 时间线的片段编辑与本地播放。
 *
 * 片段编辑是纯函数：返回新的一组片段，由调用方提交为一次 `update clips`。
 * 播放头、播放状态与选中的片段只保存在本地，不写入磁盘；同一条时间线的节点与全屏编辑共用一个会话（`useSession`）。
 */

import type { CanvasClip } from '@qywork/core'
import { type Accessor, createSignal, onCleanup } from 'solid-js'
import { type VideoMeta, videoMeta } from './frame.ts'

/** 片段最短 0.1 秒：更短的段在轨道上无法选中，导出也不足 3 帧。 */
export const MIN_CLIP = 0.1

/** 源视频的元数据按地址缓存：裁剪出点的上限、新片段的整段长度、预览画框的比例都依赖它。无法读取时各项为 0。 */
const metas = new Map<string, Promise<VideoMeta>>()
export function metaOf(url: string): Promise<VideoMeta> {
  let m = metas.get(url)
  if (!m) {
    m = videoMeta(url).catch(() => ({ duration: 0, width: 0, height: 0 }))
    metas.set(url, m)
  }
  return m
}

/** 入点出点精确到毫秒：拖动换算出的秒数带十几位小数，写入画布文件没有意义。 */
function ms(seconds: number): number {
  return Math.round(seconds * 1000) / 1000
}

export function lengthOf(c: CanvasClip): number {
  return c.out - c.in
}

export function totalOf(clips: readonly CanvasClip[]): number {
  return clips.reduce((n, c) => n + lengthOf(c), 0)
}

/** 每段在成片中的起点。 */
export function startsOf(clips: readonly CanvasClip[]): number[] {
  let at = 0
  return clips.map((c) => {
    const start = at
    at += lengthOf(c)
    return start
  })
}

/** 成片时刻 `t` 所在的段序号与对应的源文件时间；`t` 位于终点时对应最后一段的出点。没有片段时返回 `null`。 */
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

/** 在成片时刻 `t` 把所在的段一分为二；距段的两端不足 `MIN_CLIP` 时不分割，返回 `null`。 */
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

/** 片段缩略图画布的最大宽度（块宽单位）。 */
const THUMB_MAX = 2048

/**
 * 片段缩略图画布的像素宽高：块在页面上的宽高各乘 2。宽高必须按同一倍数计算，倍数不同时帧会被拉伸或压缩。
 * 块宽超过 `THUMB_MAX` 时宽高按同一比例缩小，显示时再缩放回块的大小：全屏放大后块可能很宽，画布尺寸超出浏览器上限时无法绘制。
 */
export function thumbCanvas(w: number, h: number): { width: number; height: number } {
  const scale = Math.min(1, THUMB_MAX / Math.max(1, w))
  return {
    width: Math.max(8, Math.round(w * scale * 2)),
    height: Math.max(8, Math.round(h * scale * 2)),
  }
}

/**
 * 分割按钮是否可用。播放中不按播放头判断：距段的两端不足 `MIN_CLIP` 时不能分割，逐帧判断会使按钮在每个片段交界处
 * 禁用约 0.2 秒。播放中点击时由调用方先暂停，再按暂停位置分割。
 */
export function canSplit(clips: readonly CanvasClip[], t: number, playing: boolean): boolean {
  return playing ? clips.length > 0 : splitAt(clips, t) !== null
}

export function withoutClip(clips: readonly CanvasClip[], index: number): CanvasClip[] {
  return clips.filter((_, i) => i !== index)
}

/** 把第 `from` 段移动到第 `to` 个间隙（0 为最前，`clips.length` 为最后）。位置不变时返回 `null`。 */
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
 * 把第 `index` 段的入点（`edge` 为 `in`）或出点拖动到源时间 `value`：入点不小于 0，出点不超过源时长 `duration`，
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

/** 成片时刻 `t` 位于片段之间的第几个间隙：统计中点在 `t` 之前的段，不计 `skip` 指定的段（拖动中的段）。 */
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
  /** 预览：两个 `<video>` 叠放、轮流播放。同一时刻只挂载在一处（节点或全屏），移动它会暂停播放。 */
  preview: HTMLDivElement
  /** 节点修改片段或静音时调用：片段变化时暂停，并按原播放头重新定位。 */
  sync(urls: string[], clips: CanvasClip[], muted: boolean): void
  seek(t: number): void
  toggle(): void
  pause(): void
  /** 由当前显示的视图注册：屏幕横坐标对应的成片时刻。拖入片段的插入位置、右键「在此处分割」的分割位置均按它计算。 */
  timeAtClient?: (clientX: number) => number
}

const sessions = new Map<string, { session: TimelineSession; users: number; dispose(): void }>()

/** 在组件中获取该时间线的会话；最后一个使用它的组件卸载时释放。 */
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

/** 已挂载的时间线的会话；不存在时返回 `undefined`。画布处理 Delete 时据此判断删除片段还是删除节点。 */
export function sessionOf(id: string): TimelineSession | undefined {
  return sessions.get(id)?.session
}

/** 终点停在最后一帧之前：定位到恰好出点时常无法解码出画面。 */
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
  /** 预览画框的比例取第一段：导出的成片按第一段确定尺寸，其余段在画框中等比缩放并留边。 */
  let framed = ''
  const frameTo = (url: string | undefined) => {
    if (url === framed) return
    framed = url ?? ''
    if (!url) {
      preview.style.removeProperty('--tl-ratio')
      return
    }
    void metaOf(url).then(({ width, height }) => {
      if (framed === url && width && height) {
        preview.style.setProperty('--tl-ratio', String(width / height))
      }
    })
  }
  let active = 0
  /** 两个视频元素各自载入的段序号；-1 表示空。 */
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
      // 先切换显示再暂停旧元素：旧元素的 pause 事件到达时它已不是当前元素，不会被视为意外暂停。
      show(other)
      videos[other]!.play().catch(pause)
      v.pause()
      preload(index + 2)
    }
    const now = holds[active]!
    setPlayhead(startsOf(clips)[now]! + videos[active]!.currentTime - clips[now]!.in)
    raf = requestAnimationFrame(tick)
  }
  // 当前元素被浏览器暂停（预览挂载到别处、系统暂停）时，播放状态随之停止。
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
      frameTo(urls[0])
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
