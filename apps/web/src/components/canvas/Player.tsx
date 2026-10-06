/**
 * 音视频节点的播放控件与视频取帧条。
 *
 * 不使用浏览器自带控件：自带控件按固定像素绘制，在高 169 的节点中占去近一半高度，且按住控件时无法拖动节点。
 */

import {
  type Accessor,
  createEffect,
  createSignal,
  type JSX,
  onCleanup,
  onMount,
  Show,
} from 'solid-js'
import { IconAudio, IconPause, IconPlay, IconVolume, IconVolumeOff } from '../Icons.tsx'
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

/** 静音是整个界面共用的偏好：切换选中节点、播放器重新挂载时均沿用上一次的选择。 */
const [muted, setMuted] = createSignal(false)

/**
 * 已挂载的播放器。`at` 是所选时刻：播放时随播放进度更新，暂停时为最后一次定位的值。
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

/** 音频常驻紧凑卡片；切换来源时由调用方重新挂载，离开画布或卸载时停止播放。 */
export function AudioPlayer(props: { src: string; active: boolean }) {
  let audio!: HTMLAudioElement
  let disposed = false
  const [at, setAt] = createSignal(0)
  const [length, setLength] = createSignal(0)
  const [playing, setPlaying] = createSignal(false)
  const [failed, setFailed] = createSignal(false)
  const duration = () => setLength(Number.isFinite(audio.duration) ? audio.duration : 0)
  const toggle = () => {
    if (!audio.paused) {
      audio.pause()
      return
    }
    setFailed(false)
    if (audio.error) audio.load()
    if (audio.ended) audio.currentTime = 0
    void audio.play().catch((error: unknown) => {
      if (error instanceof Error && error.name === 'AbortError') return
      if (!disposed && props.active) setFailed(true)
    })
  }
  createEffect(() => {
    if (!props.active) audio.pause()
  })
  onCleanup(() => {
    disposed = true
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  })
  return (
    <div class="canvas-media canvas-audio">
      <audio
        ref={audio}
        src={props.src}
        preload="metadata"
        muted={muted()}
        onLoadedMetadata={duration}
        onDurationChange={duration}
        onTimeUpdate={() => setAt(audio.currentTime)}
        onPlay={() => {
          setPlaying(true)
          setFailed(false)
        }}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false)
          setAt(length())
        }}
        onError={() => {
          setPlaying(false)
          setFailed(true)
        }}
      />
      <div class="canvas-audio-label" classList={{ failed: failed() }}>
        <IconAudio size={12} />
        <output>{failed() ? '无法播放，请重试' : '音频'}</output>
      </div>
      <div class="canvas-audio-controls">
        <button
          type="button"
          class="canvas-audio-play"
          aria-label={playing() ? '暂停' : '播放'}
          onClick={toggle}
          onKeyDown={(e) => e.stopPropagation()}
          onKeyUp={(e) => e.stopPropagation()}
        >
          <Show when={playing()} fallback={<IconPlay size={16} />}>
            <IconPause size={16} />
          </Show>
        </button>
        <div class="canvas-audio-track">
          <div class="canvas-audio-time">
            <span>{clock(at() * 1000)}</span>
            <span>{length() ? clock(length() * 1000) : '--:--'}</span>
          </div>
          <input
            type="range"
            min="0"
            max={length() || 1}
            step="any"
            value={at()}
            disabled={!length()}
            aria-label="音频进度"
            onKeyDown={(e) => e.stopPropagation()}
            onKeyUp={(e) => e.stopPropagation()}
            aria-valuetext={`${clock(at() * 1000)} / ${clock(length() * 1000)}`}
            style={{ '--p': `${length() ? (at() / length()) * 100 : 0}%` }}
            onInput={(e) => {
              const next = Math.min(length(), Math.max(0, Number(e.currentTarget.value)))
              audio.currentTime = next
              setAt(next)
            }}
          />
        </div>
        <button
          type="button"
          class="canvas-audio-volume"
          aria-label={muted() ? '开启声音' : '静音'}
          onClick={() => setMuted(!muted())}
          onKeyDown={(e) => e.stopPropagation()}
          onKeyUp={(e) => e.stopPropagation()}
        >
          <Show when={muted()} fallback={<IconVolume size={16} />}>
            <IconVolumeOff size={16} />
          </Show>
        </button>
      </div>
    </div>
  )
}

/** 帧缩略图区域的 CSS 尺寸：取帧条宽 320，减去两侧内边距与边框。 */
const STRIP = { w: 306, h: 40 }

/**
 * 取帧条：在一行帧缩略图上拖动选择时刻，节点中的播放器同步定位，当前画面即所取的帧。
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
