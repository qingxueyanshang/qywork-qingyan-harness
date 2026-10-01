/**
 * 视频节点的播放控件与取帧条。
 *
 * 不用浏览器自带控件：那套控件按固定像素绘制，在 169 高的节点里占去近一半，且按住它拖不动节点。
 */

import { type Accessor, createSignal, type JSX, onCleanup, onMount, Show } from 'solid-js'
import { IconPause, IconPlay, IconVolume, IconVolumeOff } from '../Icons.tsx'
import { drawFilmstrip, frameTime } from './frame.ts'

/** `mm:ss`。 */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

/** `mm:ss.s`，与帧名的精度一致。 */
function clockTenths(seconds: number): string {
  const t = Math.round(seconds * 10) / 10
  return `${clock(Math.floor(t) * 1000)}.${Math.round((t % 1) * 10)}`
}

/** 静音是整个界面的一项偏好：换选节点、播放器重新挂载都沿用上一次的选择。 */
const [muted, setMuted] = createSignal(false)

/**
 * 一个已挂载的播放器。`at` 是所选时刻：播放时跟着走，暂停时是最后一次定位的值。
 * 定位到终点时 `at` 等于 `length`，画面停在终点前一帧（`frameTime`）。
 */
export interface PlayerHandle {
  src: string
  at: Accessor<number>
  length: Accessor<number>
  playing: Accessor<boolean>
  seek(at: number): void
  toggle(): void
}

/** `register` 在挂载时同步调用一次，调用方可在其中 `onCleanup` 注销。 */
export function VideoPlayer(props: {
  src: string
  register: (player: PlayerHandle) => void
  onDuration: (seconds: number) => void
}) {
  let video!: HTMLVideoElement
  let raf = 0
  const [at, setAt] = createSignal(0)
  const [length, setLength] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const follow = () => {
    setAt(video.currentTime)
    raf = requestAnimationFrame(follow)
  }
  onCleanup(() => cancelAnimationFrame(raf))
  const player: PlayerHandle = {
    src: props.src,
    at,
    length,
    playing,
    seek(t) {
      const next = Math.min(Math.max(0, t), length())
      setAt(next)
      video.currentTime = frameTime(next, length())
    },
    toggle() {
      if (!video.paused) {
        video.pause()
        return
      }
      if (at() >= length()) video.currentTime = 0
      video.play().catch(() => {})
    },
  }
  props.register(player)
  return (
    <>
      <video
        ref={video}
        src={`${props.src}#t=0.1`}
        preload="metadata"
        muted={muted()}
        playsinline
        crossOrigin="anonymous"
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration
          setLength(Number.isFinite(d) ? d : 0)
          props.onDuration(d)
        }}
        onPlay={() => {
          setPlaying(true)
          follow()
        }}
        onPause={() => {
          setPlaying(false)
          cancelAnimationFrame(raf)
        }}
        onEnded={() => setAt(length())}
      />
      <div class="canvas-player">
        <button type="button" aria-label={playing() ? '暂停' : '播放'} onClick={player.toggle}>
          <Show when={playing()} fallback={<IconPlay size={12} />}>
            <IconPause size={12} />
          </Show>
        </button>
        <span>
          {clock(at() * 1000)} / {clock(length() * 1000)}
        </span>
        <input
          type="range"
          min="0"
          max={length()}
          step="any"
          value={at()}
          aria-label="进度"
          style={{ '--p': `${length() ? (at() / length()) * 100 : 0}%` }}
          onInput={(e) => player.seek(Number(e.currentTarget.value))}
        />
        <button
          type="button"
          aria-label={muted() ? '开启声音' : '静音'}
          onClick={() => setMuted(!muted())}
        >
          <Show when={muted()} fallback={<IconVolume size={12} />}>
            <IconVolumeOff size={12} />
          </Show>
        </button>
      </div>
    </>
  )
}

/** 帧缩略图那一格的 CSS 尺寸：取帧条宽 320，减去两侧内边距与边框。 */
const STRIP = { w: 306, h: 40 }

/**
 * 取帧条：在一行帧缩略图上拖动时刻，节点里的播放器同步定位，画面即所取的帧。
 * 拖到最左、最右分别记为首帧、尾帧（`frameLabel`）。
 */
export function FrameBar(props: {
  player: PlayerHandle
  style: JSX.CSSProperties
  onCapture: (at: number, duration: number) => void
}) {
  const p = props.player
  let strip!: HTMLCanvasElement
  const abort = new AbortController()
  onMount(() => void drawFilmstrip(p.src, strip, abort.signal).catch(() => {}))
  onCleanup(() => abort.abort())
  const pause = () => {
    if (p.playing()) p.toggle()
  }
  return (
    <div class="canvas-frame-bar" style={props.style}>
      <div class="canvas-frame-strip">
        <canvas
          ref={strip}
          width={STRIP.w * window.devicePixelRatio}
          height={STRIP.h * window.devicePixelRatio}
        />
        <input
          type="range"
          min="0"
          max={p.length()}
          step="any"
          value={p.at()}
          aria-label="时刻"
          disabled={!p.length()}
          onInput={(e) => {
            pause()
            p.seek(Number(e.currentTarget.value))
          }}
        />
      </div>
      <div class="canvas-frame-row">
        <button type="button" aria-label={p.playing() ? '暂停' : '播放'} onClick={p.toggle}>
          <Show when={p.playing()} fallback={<IconPlay size={14} />}>
            <IconPause size={14} />
          </Show>
        </button>
        <span>
          {clockTenths(p.at())} / {clock(p.length() * 1000)}
        </span>
        <button
          type="button"
          class="canvas-frame-take"
          disabled={!p.length()}
          onClick={() => {
            pause()
            props.onCapture(p.at(), p.length())
          }}
        >
          取帧
        </button>
      </div>
    </div>
  )
}
