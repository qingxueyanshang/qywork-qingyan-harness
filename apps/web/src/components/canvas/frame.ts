/**
 * 从视频截一帧并导出 PNG。在浏览器里做：本机没有 FFmpeg，服务端没有解码器。
 *
 * 视频元素必须带 `crossOrigin = 'anonymous'`：服务端对 `/api/` 放行任意源（CORS `*`），
 * 这样画进 `<canvas>` 之后画布不被污染，`toBlob` 才导得出来；不带就是跨源污染，导出直接抛错。
 */

/** 取帧菜单的三项。 */
export type FrameAt = 'first' | 'last' | number

/**
 * 截哪一刻。尾帧取 `duration - 1/30` 秒：定位到恰好 `duration` 时常解不出画面或是黑帧。
 */
export function frameTime(at: FrameAt, duration: number): number {
  if (at === 'first') return 0
  if (at === 'last') return Math.max(0, duration - 1 / 30)
  return Math.min(Math.max(0, at), Math.max(0, duration - 1 / 30))
}

/** 帧的名字，进文件名：`首帧` / `尾帧` / `12.4s`。与服务端取帧接口收的三种形状一致。 */
export function frameLabel(at: FrameAt): string {
  if (at === 'first') return '首帧'
  if (at === 'last') return '尾帧'
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
export async function seekVideo(src: string, at: FrameAt): Promise<HTMLVideoElement> {
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
export async function captureVideoFrame(src: string, at: FrameAt): Promise<Blob> {
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
