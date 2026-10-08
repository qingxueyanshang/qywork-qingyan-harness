/**
 * 时间线导出：按片段顺序读取源视频，拼接为一个 mp4（H.264 + AAC）。在浏览器中执行：编解码使用 WebCodecs，
 * mp4 的读写使用 mediabunny，按需加载，不进入首屏资源。
 *
 * - 画面：输出尺寸取第一段的显示宽高（按旋转转正，超过 4K 等比缩小），其余段等比缩放并留黑边。按每秒 30 帧逐个时刻取
 *   该时刻正在显示的帧，帧率不固定的源也能得到均匀的输出。
 * - 声音：按成片时间每 `WINDOW` 秒一段进行离线混音（48 kHz 双声道），没有音轨的段为静音；`muted` 时不含音轨。
 *   每混完一段即送入编码器并随即释放，与画面按时间交替写入：内存只占用一段，不随成片时长增长。
 * - 输出：编码后的字节按块交给 `write`（写入成片文件的指定位置），成片不整段保留在内存中。
 *   索引（moov）预留在文件开头、结束时回填，与整段在内存中生成的文件同为 faststart 布局。
 */

/** 一段：源视频的地址与入点出点（秒）。 */
export interface RenderClip {
  url: string
  /** 报错时用于指明出错的片段。 */
  name: string
  in: number
  out: number
}

/** 导出与录制的帧率。 */
export const FPS = 30
const RATE = 48000
/** 交给 `write` 的每块大小上限：每块对应一次上传请求。 */
const CHUNK = 4 * 1024 * 1024
/** AAC 每个包 1024 个采样。预留索引按包数计算；多估计的包数只在索引后留出一段空白（`free`），不影响播放。 */
const AAC_FRAME = 1024
/** 混音一段的长度（秒）：一段 48 kHz 双声道约 3.8 MB。 */
const WINDOW = 10
/**
 * 获取源文件失败时重试两次、间隔各半秒，之后报错。不要使用缺省策略：它按指数退避无限重试，
 * 文件被删除或服务端停止时导出停滞在 0%，不会结束。
 */
const RETRY = (attempts: number) => (attempts < 2 ? 0.5 : null)

/** H.264 编码器支持的最大画面（长边、短边）。8K 源按比例缩小到此范围内，超出时编码器直接拒绝。 */
const MAX_SIDES = [3840, 2160] as const

/** 输出宽高：不超过 `MAX_SIDES`、保持比例、取偶数（H.264 的 4:2:0 采样要求宽高为偶数）。 */
export function outputSize(w: number, h: number): { width: number; height: number } {
  const scale = Math.min(1, MAX_SIDES[0] / Math.max(w, h), MAX_SIDES[1] / Math.min(w, h))
  const even = (n: number) => Math.max(2, Math.floor((n * scale) / 2) * 2)
  return { width: even(w), height: even(h) }
}

/**
 * 导出成片。`onProgress` 接收 0–1 的进度（按已编码的帧数）；`signal` 中止时停止并抛出 `AbortError`。
 * `write(bytes, at)` 把一块写入成片文件的 `at` 处，结束前会回写文件开头，因此不是追加写入；它返回的 promise
 * 完成之前不输出下一块。中途失败时已写入的部分由调用方丢弃。
 */
export async function renderTimeline(
  clips: RenderClip[],
  muted: boolean,
  onProgress: (ratio: number) => void,
  signal: AbortSignal,
  write: (bytes: Uint8Array<ArrayBuffer>, at: number) => Promise<void>,
): Promise<void> {
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
        throw new Error(`「${clips[i]!.name}」的视频编码（${track.codec ?? '未知'}）无法在本机解码`)
      }
    }
    const first = tracks.find(Boolean)
    if (!first) throw new Error('片段中没有画面')
    const { width, height } = outputSize(first.displayWidth, first.displayHeight)

    const total = clips.reduce((n, c) => n + Math.max(1, Math.round((c.out - c.in) * FPS)), 0)
    const length = clips.reduce((n, c) => n + c.out - c.in, 0)
    const { output, video, ctx } = mp4Output(mb, width, height, total, write)
    const audio = muted
      ? null
      : new mb.AudioBufferSource({ codec: 'aac', bitrate: mb.QUALITY_HIGH })
    // 编码器在开头输出预热包、在结尾补齐最后一包：按时长计算的包数再加 10% 与固定余量。
    const packets = Math.ceil(((length * RATE) / AAC_FRAME) * 1.1) + 64
    if (audio) output.addAudioTrack(audio, { maximumPacketCount: packets })

    try {
      const voices = audio
        ? await Promise.all(
            inputs.map(async (input) => {
              const track = await input.getPrimaryAudioTrack()
              return track && (await track.canDecode()) ? track : null
            }),
          )
        : []
      /** 声音已写入到成片的第几秒。 */
      let mixedTo = 0
      const mixUntil = async (t: number) => {
        while (audio && mixedTo < Math.min(t, length)) {
          const to = Math.min(mixedTo + WINDOW, length)
          await audio.add(await mixWindow(mb, voices, clips, mixedTo, to, signal))
          mixedTo = to
        }
      }
      await output.start()

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
          // 声音领先画面一段：写入该帧之前，先写入其所在段的声音。
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
  } finally {
    for (const input of inputs) input.dispose()
  }
}

/**
 * mp4 输出与其画面轨道：画面画到 `ctx` 后由 `video.add` 编码（H.264，30 帧/秒），字节按块交给 `write`。
 * 索引按 `frames` 预留在文件开头（见文件头说明）。声音轨道由调用方在 `output.start()` 之前添加。
 */
export function mp4Output(
  mb: typeof import('mediabunny'),
  width: number,
  height: number,
  frames: number,
  write: (bytes: Uint8Array<ArrayBuffer>, at: number) => Promise<void>,
) {
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  const target = new mb.StreamTarget(
    new WritableStream({ write: (chunk) => write(chunk.data, chunk.position) }),
    { chunked: true, chunkSize: CHUNK },
  )
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: 'reserve' }), target })
  const video = new mb.CanvasSource(canvas, { codec: 'avc', bitrate: mb.QUALITY_HIGH })
  output.addVideoTrack(video, { frameRate: FPS, maximumPacketCount: frames })
  return { output, video, ctx }
}

/**
 * 成片 `[from, to)` 区间的离线混音：每段视频在成片中的位置与该区间相交的部分，取对应的源音频排入。
 * `voices[i]` 为 `null` 的段（没有音轨或无法解码）为静音。
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
      // 该区间在源文件中对应的时间。
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
