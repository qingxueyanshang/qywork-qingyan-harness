/**
 * 从视频截取一帧并导出 PNG。在浏览器中执行：本机没有 FFmpeg，服务端没有解码器。
 *
 * 视频元素必须设置 `crossOrigin = 'anonymous'`：服务端对 `/api/` 允许任意源（CORS `*`），
 * 绘制到 `<canvas>` 后画布不被污染，`toBlob` 才能导出；不设置时画布被跨源污染，导出直接抛错。
 */

/**
 * 截取的时刻：限定在 `[0, duration - 1/30]` 秒。定位到恰好 `duration` 时常无法解码出画面或得到黑帧。
 */
export function frameTime(at: number, duration: number): number {
  return Math.min(Math.max(0, at), Math.max(0, duration - 1 / 30))
}

/**
 * 帧的名称，用于文件名：时刻在起点为 `首帧`、在终点为 `尾帧`，其余为 `12.4s`。
 * 与服务端取帧接口接受的三种格式一致。
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
 * 载入视频并定位到指定时刻，返回停在该帧上的视频元素。
 * 使用后必须调用 `releaseVideo`：不释放时解码器一直被占用。
 */
export async function seekVideo(src: string, at: number): Promise<HTMLVideoElement> {
  const video = document.createElement('video')
  video.crossOrigin = 'anonymous'
  video.muted = true
  video.preload = 'auto'
  video.src = src
  try {
    await once(video, 'loadedmetadata')
    await seekTo(video, at)
    return video
  } catch (e) {
    releaseVideo(video)
    throw e
  }
}

/**
 * 定位到指定时刻，等到画面可绘制时才返回。
 * 不要只等待 `seeked`：解码器延后输出帧时它先于画面到达，此时 `drawImage` 绘制出空白、`createImageBitmap`
 * 报告「图像源不可用」。呈现回调必须在定位前注册：定位前后位置相同时不会再次呈现，但此时画面已存在，探测一次即可通过。
 */
async function seekTo(video: HTMLVideoElement, at: number): Promise<void> {
  const presented = new Promise<void>((resolve, reject) => {
    video.requestVideoFrameCallback(() => resolve())
    video.addEventListener('error', () => reject(new Error('视频加载失败')), { once: true })
  })
  presented.catch(() => {})
  const seeked = once(video, 'seeked')
  video.currentTime = frameTime(at, video.duration || 0)
  await seeked
  if (!(await drawable(video))) await presented
}

/** 当前画面是否可绘制：读取左上角 1×1 像素检测一次。 */
async function drawable(video: HTMLVideoElement): Promise<boolean> {
  try {
    const probe = await createImageBitmap(video, 0, 0, 1, 1)
    probe.close()
    return true
  } catch {
    return false
  }
}

export function releaseVideo(video: HTMLVideoElement): void {
  video.removeAttribute('src')
  video.load()
}

/** 载入视频、定位到指定时刻、绘制到画布并导出 PNG。 */
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

/** 视频的时长（秒）与显示宽高（已按旋转转正）。无法读取的项为 0。 */
export interface VideoMeta {
  duration: number
  width: number
  height: number
}

/** 读取视频元数据，读取后即释放。 */
export async function videoMeta(src: string): Promise<VideoMeta> {
  const video = document.createElement('video')
  video.preload = 'metadata'
  video.muted = true
  video.src = src
  try {
    await once(video, 'loadedmetadata')
    return {
      duration: Number.isFinite(video.duration) ? video.duration : 0,
      width: video.videoWidth,
      height: video.videoHeight,
    }
  } finally {
    releaseVideo(video)
  }
}

/**
 * 在 `canvas` 上从左到右排列一行帧：格数取按视频比例铺满所需的数量，第 i 格取第 i 段时长的中点，
 * 格比视频窄时从画面中间截取。`range` 限定取帧的时间段（秒），缺省为整段。
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
      await seekTo(video, from + ((i + 0.5) / count) * span)
      ctx.drawImage(video, (vw - sw) / 2, 0, sw, vh, i * cell, 0, cell, canvas.height)
    }
  } finally {
    releaseVideo(video)
  }
}
