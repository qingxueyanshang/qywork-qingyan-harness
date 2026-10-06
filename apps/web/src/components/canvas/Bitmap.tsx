/**
 * 画布上的图片与视频封面按显示宽度解码后绘制到 `<canvas>`。
 *
 * 不要改用 `<img>` 或常驻的 `<video>`：`<img>` 按原图分辨率解码，一张 4K 图约 33 MB，五十张 4K 图实测进程树
 * 内存增量 1.5 GB，缩放时解码缓存被逐出后重新解码，单帧停滞数秒；每个 `<video>` 各占一套解码器，二十个视频节点
 * 实测约 500 MB。此处取得原文件（视频定位到开头一帧）后用 `createImageBitmap` 缩小到档位宽度，只保留缩小后的位图。
 */

import { createEffect, createMemo, createSignal, onCleanup, Show } from 'solid-js'
import { IconImage, IconVideo } from '../Icons.tsx'
import { releaseVideo, seekVideo } from './frame.ts'

/** 档位是 2 的幂，最小 256、最大 4096。放大越过更高一档时才重新解码，缩小时不重新解码。 */
const MIN_TIER = 256
const MAX_TIER = 4096
/** 同时解码的数量上限：每次解码期间原文件与完整画面同时占用内存。 */
const PARALLEL = 4
/** 缩放停止该时长后才按新档位解码，连续滚动滚轮时不逐档解码。 */
const SETTLE_MS = 150
/** 视频封面所取的时刻（秒）：第 0 秒常为黑帧。 */
const POSTER_AT = 0.1

export function tierOf(px: number): number {
  let t = MIN_TIER
  while (t < px && t < MAX_TIER) t *= 2
  return t
}

let active = 0
const waiting: (() => void)[] = []

/** 在并发上限内执行。名额直接移交给下一个等待者，不先释放再重新竞争。 */
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

/** 解码框：以设备像素计的宽高，媒体按 `object-fit: cover` 填满该框。 */
export interface DecodeBox {
  w: number
  h: number
}

/**
 * 按 cover 方式填满一个框所需的解码宽度：按宽度填满需要框宽，按高度填满需要框高按画面宽高比
 * 换算的宽度，取两者中的较大值。不要只按框宽：横图放入偏竖的框时按高度填满，只解码到框宽的
 * 位图会被放大而模糊。
 */
export function coverWidth(box: DecodeBox, natural: DecodeBox): number {
  return Math.ceil(Math.max(box.w, (box.h * natural.w) / natural.h))
}

/** 等比缩小到 `width` 宽；原画面窄于该宽度时保持原尺寸。 */
async function shrink(
  source: ImageBitmap | HTMLVideoElement,
  natural: number,
  width: number,
): Promise<ImageBitmap> {
  if (natural <= width && source instanceof ImageBitmap) return source
  return createImageBitmap(source, { resizeWidth: Math.min(width, natural), resizeQuality: 'high' })
}

/** 获取图片并等比缩小到填满 `box` 所需的宽度。 */
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

/** 取视频开头一帧并等比缩小到填满 `box` 所需的宽度，与时长一起返回。 */
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
 * `width` / `height` 是框的设备像素宽高（CSS 尺寸 × 缩放 × `devicePixelRatio`）。档位按框的长边确定，
 * 解码宽度按填满框所需的宽度确定（`coverWidth`）。视频绘制开头一帧，时长经 `onDuration` 报告。
 * 解码失败时显示类别图标。
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
  // 地址与类别经 memo 取值：`props.src` 的取值依赖整个画布文档，不经 memo 隔离时，画布上任何一处修改都会触发重新解码。
  const src = createMemo(() => props.src)
  const video = createMemo(() => props.kind === 'video')
  let held = { src: '', tier: 0 }
  // 宽高比单独计算并取到千分位：缩放只改变框的大小、不改变比例，解码只随档位与比例重新执行；
  // 不取整时宽高各乘缩放后再相除，末位误差会使每次缩放都重新解码。
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
