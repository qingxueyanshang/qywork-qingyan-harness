/**
 * 时间线导出：按片段顺序读源视频，接成一个 mp4（H.264 + AAC）。在浏览器里做：编解码用 WebCodecs，
 * mp4 的读写用 mediabunny，按需加载，不进首屏。
 *
 * - 画面：输出尺寸取第一段的显示宽高（按旋转转正，超过 4K 等比缩小），其余段等比缩放、留黑边。按每秒 30 帧逐个时刻取
 *   「这一刻正在显示的那一帧」，帧率不固定的源也得到均匀的输出。
 * - 声音：按成片时间每 `WINDOW` 秒一段做离线混音（48 kHz 双声道），没有音轨的段是静音；`muted` 时不带音轨。
 *   混好一段就送编码器、随即释放，与画面按时间交替写入：内存只占一段，不随成片时长增长。
 */

/** 一段：源视频的地址与入点出点（秒）。 */
export interface RenderClip {
  url: string
  /** 报错时指明是哪一段。 */
  name: string
  in: number
  out: number
}

const FPS = 30
const RATE = 48000
/** 混音一段的长度（秒）：一段 48 kHz 双声道约 3.8 MB。 */
const WINDOW = 10
/**
 * 取源文件失败时重试两次、各隔半秒，之后报错。不要用缺省：它按指数退避一直重试，
 * 文件被删或服务端停了时导出停在 0% 不结束。
 */
const RETRY = (attempts: number) => (attempts < 2 ? 0.5 : null)

/** H.264 编码器能接的最大画面（长边、短边）。8K 源按比例缩到这个范围内，超出时编码器直接拒绝。 */
const MAX_SIDES = [3840, 2160] as const

/** 输出宽高：不超过 `MAX_SIDES`、保持比例、取偶数（H.264 的 4:2:0 采样要求宽高为偶数）。 */
function outputSize(w: number, h: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_SIDES[0] / Math.max(w, h), MAX_SIDES[1] / Math.min(w, h))
  const even = (n: number) => Math.max(2, Math.floor((n * scale) / 2) * 2)
  return { width: even(w), height: even(h) }
}

/**
 * 导出成片。`onProgress` 收 0–1 的进度（按已编码的帧数）；`signal` 中止时丢弃已写的内容并抛出 `AbortError`。
 */
export async function renderTimeline(
  clips: RenderClip[],
  muted: boolean,
  onProgress: (ratio: number) => void,
  signal: AbortSignal,
): Promise<Blob> {
  const mb = await import('mediabunny')
  const inputs = clips.map(
    (c) =>
      new mb.Input({
        source: new mb.UrlSource(c.url, { getRetryDelay: RETRY }),
        formats: mb.ALL_FORMATS,
      }),
  )
  const aborted = () => new DOMException('导出已取消', 'AbortError')
  try {
    const tracks = await Promise.all(inputs.map((i) => i.getPrimaryVideoTrack()))
    for (const [i, track] of tracks.entries()) {
      if (track && !(await track.canDecode())) {
        throw new Error(
          `「${clips[i]!.name}」的视频编码（${track.codec ?? '未知'}）在这台电脑上解不了`,
        )
      }
    }
    const first = tracks.find(Boolean)
    if (!first) throw new Error('片段里没有画面')
    const { width, height } = outputSize(first.displayWidth, first.displayHeight)

    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')!
    const target = new mb.BufferTarget()
    const output = new mb.Output({
      format: new mb.Mp4OutputFormat({ fastStart: 'in-memory' }),
      target,
    })
    const video = new mb.CanvasSource(canvas, { codec: 'avc', bitrate: mb.QUALITY_HIGH })
    output.addVideoTrack(video, { frameRate: FPS })
    const audio = muted
      ? null
      : new mb.AudioBufferSource({ codec: 'aac', bitrate: mb.QUALITY_HIGH })
    if (audio) output.addAudioTrack(audio)

    try {
      const voices = audio
        ? await Promise.all(
            inputs.map(async (input) => {
              const track = await input.getPrimaryAudioTrack()
              return track && (await track.canDecode()) ? track : null
            }),
          )
        : []
      const length = clips.reduce((n, c) => n + c.out - c.in, 0)
      /** 声音已写到成片的哪一秒。 */
      let mixedTo = 0
      const mixUntil = async (t: number) => {
        while (audio && mixedTo < Math.min(t, length)) {
          const to = Math.min(mixedTo + WINDOW, length)
          await audio.add(await mixWindow(mb, voices, clips, mixedTo, to, signal))
          mixedTo = to
        }
      }
      await output.start()

      const total = clips.reduce((n, c) => n + Math.max(1, Math.round((c.out - c.in) * FPS)), 0)
      let done = 0
      for (const [i, c] of clips.entries()) {
        const track = tracks[i]
        const frames = Math.max(1, Math.round((c.out - c.in) * FPS))
        const times = Array.from({ length: frames }, (_, k) => c.in + k / FPS)
        const sink = track
          ? new mb.CanvasSink(track, { width, height, fit: 'contain', poolSize: 1 })
          : null
        const pictures = sink ? sink.canvasesAtTimestamps(times) : null
        for (let k = 0; k < frames; k++) {
          if (signal.aborted) throw aborted()
          // 声音领先画面一段：写到这一帧之前，先把它所在那一段的声音写好。
          if (done / FPS >= mixedTo) await mixUntil(mixedTo + WINDOW)
          const picture = pictures ? (await pictures.next()).value : null
          ctx.fillStyle = '#000'
          ctx.fillRect(0, 0, width, height)
          if (picture) ctx.drawImage(picture.canvas, 0, 0)
          await video.add(done / FPS, 1 / FPS)
          done++
          onProgress(done / total)
        }
        await pictures?.return(undefined)
      }
      await mixUntil(length)
      await output.finalize()
    } catch (err) {
      await output.cancel().catch(() => {})
      throw err
    }
    return new Blob([target.buffer!], { type: 'video/mp4' })
  } finally {
    for (const input of inputs) input.dispose()
  }
}

/**
 * 成片 `[from, to)` 这一段的离线混音：每段视频在成片里的位置与这一段相交的部分，取对应的源音频排进去。
 * `voices[i]` 为 `null` 的段（没有音轨或解不了）是静音。
 */
async function mixWindow(
  mb: typeof import('mediabunny'),
  voices: (InstanceType<typeof mb.InputAudioTrack> | null)[],
  clips: RenderClip[],
  from: number,
  to: number,
  signal: AbortSignal,
): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(2, Math.max(1, Math.round((to - from) * RATE)), RATE)
  let start = 0
  for (const [i, c] of clips.entries()) {
    const end = start + c.out - c.in
    const track = voices[i]
    const a = Math.max(from, start)
    const b = Math.min(to, end)
    if (track && a < b) {
      // 这一段在源文件里对应的时间。
      const srcFrom = c.in + (a - start)
      const srcTo = c.in + (b - start)
      for await (const { buffer, timestamp, duration } of new mb.AudioBufferSink(track).buffers(
        srcFrom,
        srcTo,
      )) {
        if (signal.aborted) throw new DOMException('导出已取消', 'AbortError')
        const skip = Math.max(0, srcFrom - timestamp)
        const length = Math.min(duration - skip, srcTo - Math.max(timestamp, srcFrom))
        if (length <= 0) continue
        const node = ctx.createBufferSource()
        node.buffer = buffer
        node.connect(ctx.destination)
        node.start(start + Math.max(timestamp, srcFrom) - c.in - from, skip, length)
      }
    }
    start = end
  }
  return ctx.startRendering()
}
