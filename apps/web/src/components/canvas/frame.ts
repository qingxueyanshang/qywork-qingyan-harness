/**
 * 从视频截一帧并导出 PNG。在浏览器里做：本机没有 FFmpeg，服务端没有解码器。
 *
 * 视频元素必须带 `crossOrigin = 'anonymous'`：服务端对 `/api/` 放行任意源（CORS `*`），
 * 这样画进 `<canvas>` 之后画布不被污染，`toBlob` 才导得出来；不带就是跨源污染，导出直接抛错。
 */

/**
 * 截哪一刻：限在 `[0, duration - 1/30]` 秒。定位到恰好 `duration` 时常解不出画面或是黑帧。
 */
export function frameTime(at: number, duration: number): number {
  return Math.min(Math.max(0, at), Math.max(0, duration - 1 / 30))
}

/**
 * 帧的名字，进文件名：时刻在起点为 `首帧`、在终点为 `尾帧`，其余为 `12.4s`。
 * 与服务端取帧接口收的三种形状一致。
 */
export function frameLabel(at: number, duration: number): string {
  if (at <= 0) return '首帧'
  if (at >= duration) return '尾帧'
  return `${Math.round(at * 10) / 10}s`
}

function once(target: HTMLVideoElement, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const done = () => {
      target.removeEventListener(event, done)
      target.removeEventListener('error', fail)
      resolve()
    }
    const fail = () => {
      target.removeEventListener(event, done)
      target.removeEventListener('error', fail)
      reject(new Error('视频加载失败'))
    }
    target.addEventListener(event, done)
    target.addEventListener('error', fail)
  })
}

/**
 * 载入视频并定位到那一刻，回一个停在该帧上的视频元素。
 * 用完必须调 `releaseVideo`：不释放的话解码器一直占着。
 */
export async function seekVideo(src: string, at: number): Promise<HTMLVideoElement> {
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.preload = 'auto'
  video.src = src
  try {
    await once(video, 'loadedmetadata')
    const seeked = once(video, 'seeked')
    video.currentTime = frameTime(at, video.duration || 0)
    await seeked
    return video
  } catch (e) {
    releaseVideo(video)
    throw e
  }
}

export function releaseVideo(video: HTMLVideoElement): void {
  video.removeAttribute('src')
  video.load()
}

/** 载入视频、定位到那一刻、画进画布导出 PNG。 */
export async function captureVideoFrame(src: string, at: number): Promise<Blob> {
  const video = await seekVideo(src, at)
  const canvas = document.createElement('canvas')
  canvas.width = video.videoWidth
  canvas.height = video.videoHeight
  canvas.getContext('2d')!.drawImage(video, 0, 0)
  releaseVideo(video)
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('导出图片失败'))),
      'image/png',
    ),
  )
}

/** 视频时长（秒）。只读元数据，读完即释放。 */
export async function videoDuration(src: string): Promise<number> {
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.src = src
  try {
    await once(video, 'loadedmetadata')
    return Number.isFinite(video.duration) ? video.duration : 0
  } finally {
    releaseVideo(video)
  }
}

/**
 * 在 `canvas` 上从左到右排一行帧：格数取按视频比例铺满所需，第 i 格取第 i 段时长的中点，
 * 格比视频窄时从画面中间截取。`range` 限定取帧的时间段（秒），缺省是整段。
 * 用一个临时视频元素逐格定位；`signal` 中止后不再定位，元素随即释放。
 */
export async function drawFilmstrip(
  src: string,
  canvas: HTMLCanvasElement,
  signal: AbortSignal,
  range?: { from: number; to: number },
): Promise<void> {
  const ctx = canvas.getContext('2d')
  if (!ctx || !canvas.width || !canvas.height) return
  const video = await seekVideo(src, 0)
  try {
    const { videoWidth: vw, videoHeight: vh, duration } = video
    if (!vw || !vh) return
    const from = range?.from ?? 0
    const span = (range?.to ?? duration) - from
    const count = Math.max(1, Math.ceil(canvas.width / ((canvas.height * vw) / vh)))
    const cell = canvas.width / count
    const sw = Math.min(vw, (vh * cell) / canvas.height)
    for (let i = 0; i < count && !signal.aborted; i++) {
      const seeked = once(video, 'seeked')
      video.currentTime = frameTime(from + ((i + 0.5) / count) * span, duration)
      await seeked
      ctx.drawImage(video, (vw - sw) / 2, 0, sw, vh, i * cell, 0, cell, canvas.height)
    }
  } finally {
    releaseVideo(video)
  }
}
