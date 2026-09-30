/**
 * 画布上的图片与视频封面按显示宽度解码后画进 `<canvas>`。
 *
 * 不要改用 `<img>` 或常驻的 `<video>`：`<img>` 按原图分辨率解码，一张 4K 图约 33 MB，五十张 4K 图实测进程树
 * 内存增量 1.5 GB，缩放时解码缓存被逐出后重解，单帧卡住数秒；每个 `<video>` 各占一套解码器，二十个视频节点实测
 * 约 500 MB。这里取回原文件（视频定位到开头一帧）后用 `createImageBitmap` 缩到档位宽度，只留缩小后的位图。
 */

import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import { IconImage, IconVideo } from '../Icons.tsx'
import { releaseVideo, seekVideo } from './frame.ts'

/** 档位是 2 的幂，最小 256、最大 4096。缩放越过更高一档才重新解码，缩小不重解。 */
const MIN_TIER = 256
const MAX_TIER = 4096
/** 同时解码的个数上限：每个解码期间原文件与整幅画面同时在内存里。 */
const PARALLEL = 4
/** 缩放停下这么久之后才按新档位解码，连续滚轮不逐档解码。 */
const SETTLE_MS = 150
/** 视频封面取这一刻：第 0 秒常是黑帧。 */
const POSTER_AT = 0.1

export function tierOf(px: number): number {
  let t = MIN_TIER
  while (t < px && t < MAX_TIER) t *= 2
  return t
}

let active = 0
const waiting: (() => void)[] = []

/** 并发上限内执行。名额直接交给下一个等待者，不先释放再抢。 */
async function limited<T>(work: () => Promise<T>): Promise<T> {
  if (active < PARALLEL) active += 1
  else await new Promise<void>((resolve) => waiting.push(resolve))
  try {
    return await work()
  } finally {
    const next = waiting.shift()
    if (next) next()
    else active -= 1
  }
}

/** 解码框：设备像素宽高，媒体按 `object-fit: cover` 铺满它。 */
export interface DecodeBox {
  w: number
  h: number
}

/**
 * 铺满（cover）一个框要解到多宽：宽度铺满要框宽，高度铺满要框高按画面宽高比折成的宽，取大者。
 * 不要只按框宽：横图放进偏竖的框时按高度铺满，只解到框宽的位图会被放大、发糊。
 */
export function coverWidth(box: DecodeBox, natural: DecodeBox): number {
  return Math.ceil(Math.max(box.w, (box.h * natural.w) / natural.h))
}

/** 等比缩到 `width` 宽；原画面不到这个宽度时保持原尺寸。 */
async function shrink(
  source: ImageBitmap | HTMLVideoElement,
  natural: number,
  width: number,
): Promise<ImageBitmap> {
  if (natural <= width && source instanceof ImageBitmap) return source
  return createImageBitmap(source, { resizeWidth: Math.min(width, natural), resizeQuality: 'high' })
}

/** 取回图片并等比缩到铺满 `box` 所需的宽度。 */
export function decodeImage(
  url: string,
  box: DecodeBox,
  signal?: AbortSignal,
): Promise<ImageBitmap> {
  return limited(async () => {
    const res = await fetch(url, signal ? { signal } : {})
    if (!res.ok) throw new Error(`图片读取失败：${res.status}`)
    const full = await createImageBitmap(await res.blob())
    const width = coverWidth(box, { w: full.width, h: full.height })
    const small = await shrink(full, full.width, width)
    if (small !== full) full.close()
    return small
  })
}

/** 取视频开头一帧并等比缩到铺满 `box` 所需的宽度，连同时长一起回。 */
export function decodeVideo(
  url: string,
  box: DecodeBox,
): Promise<{ bitmap: ImageBitmap; duration: number }> {
  return limited(async () => {
    const video = await seekVideo(url, POSTER_AT)
    try {
      const natural = { w: video.videoWidth, h: video.videoHeight }
      const bitmap = await shrink(video, video.videoWidth, coverWidth(box, natural))
      return { bitmap, duration: video.duration }
    } finally {
      releaseVideo(video)
    }
  })
}

/** 把位图交给画布，位图随之失效。 */
export function paint(canvas: HTMLCanvasElement, bitmap: ImageBitmap): void {
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  canvas.getContext('bitmaprenderer')?.transferFromImageBitmap(bitmap)
}

/**
 * `width` / `height` 是框的设备像素宽高（CSS 尺寸 × 缩放 × `devicePixelRatio`）。档位按框的长边取，
 * 解码宽度按铺满框所需（`coverWidth`）。视频画开头一帧，时长经 `onDuration` 报出。解码失败显示类别图标。
 */
export function Bitmap(props: {
  src: string
  width: number
  height: number
  kind?: 'image' | 'video'
  onDuration?: (seconds: number) => void
}) {
  let canvas!: HTMLCanvasElement
  const [failed, setFailed] = createSignal(false)
  // 地址与类别经 memo 取值：`props.src` 的取值依赖整份画布，不隔一层的话画布上任何一处改动都会重新解码。
  const src = createMemo(() => props.src)
  const video = createMemo(() => props.kind === 'video')
  let held = { src: '', tier: 0 }
  // 宽高比单独取、取到千分位：缩放只改框的大小不改比例，解码只随档位与比例重跑；
  // 不取整的话宽高各乘缩放后相除，末位抖动会让每次缩放都重解。
  const aspect = createMemo(() => Math.round((props.width / props.height) * 1000) / 1000)
  const tier = createMemo(() => {
    const need = tierOf(Math.max(props.width, props.height))
    if (held.src !== src() || need > held.tier) held = { src: src(), tier: need }
    return held.tier
  })
  createEffect(() => {
    const url = src()
    const long = tier()
    const r = aspect()
    const box = r >= 1 ? { w: long, h: long / r } : { w: long * r, h: long }
    const isVideo = video()
    const abort = new AbortController()
    const timer = setTimeout(() => {
      const work = isVideo
        ? decodeVideo(url, box).then((r) => {
            if (!abort.signal.aborted) props.onDuration?.(r.duration)
            return r.bitmap
          })
        : decodeImage(url, box, abort.signal)
      work.then(
        (bitmap) => {
          if (abort.signal.aborted) bitmap.close()
          else {
            paint(canvas, bitmap)
            setFailed(false)
          }
        },
        () => {
          if (!abort.signal.aborted) setFailed(true)
        },
      )
    }, SETTLE_MS)
    onCleanup(() => {
      clearTimeout(timer)
      abort.abort()
    })
  })
  return (
    <>
      <canvas ref={canvas} class="canvas-bitmap" classList={{ failed: failed() }} />
      <Show when={failed()}>
        <span class="canvas-bitmap-failed">
          <Show when={props.kind === 'video'} fallback={<IconImage size={20} />}>
            <IconVideo size={20} />
          </Show>
        </span>
      </Show>
    </>
  )
}
