/**
 * 三种协议共用的 SSE 帧解析。
 *
 * 只负责分帧：按空行分帧、合并多条 `data:` 行、配对 `event:` 与 `data:`、跳过 `:` 注释行。
 * 哪个事件是终态、用量位于哪一帧，由适配器解释：两处分别解释终态必然产生不一致，因此此处不解析协议语义。
 * 分帧规则只有 `SseSplitter` 一处：`readSse` 与需要原样转发字节的云端网关共用，网关据此识别的帧与电脑端读到的帧相同。
 *
 * 调用方必须了解以下三条边界：
 *
 * - **协议终态到达即 `break`**：生成器的 `finally` 取消上游 body，连接随即释放，
 *   无需等待 HTTP EOF。工具调用与用量因此在终态处交付。
 * - **`[DONE]` 原样返回**（`data` 等于 `SSE_DONE`），由调用方决定终止还是忽略：
 *   它是 chat/completions 的终止标记，另两种协议不发送。
 * - **正文出错时原样抛出**，包括传输层判定的 `stream_idle_timeout`。不要在此处改写为
 *   协议错误：断流与流内错误事件的重试语义不同。
 */

/** chat/completions 的终止标记。它不是协议事件，没有 JSON 体。 */
export const SSE_DONE = '[DONE]'

export interface SseFrame {
  /** `event:` 行的值；该帧没有此行时省略。 */
  event?: string
  /** 多条 `data:` 行以换行合并后的原文。 */
  data: string
}

/** 一段原始字节：一帧（含结束它的空行），或帧之外的注释行与空行。 */
export interface SseBlock {
  bytes: Uint8Array
  /** 该段中的帧；帧之外的行与没有 `data:` 行的帧为 null。 */
  frame: SseFrame | null
}

const LF = 0x0a
const CR = 0x0d
const COLON = 0x3a

/**
 * 按字节分帧，交出每一段的原始字节与其中的帧。
 *
 * - 行以 LF 结束，其前的一个 CR 不属于行；一帧从第一个字段行开始，到其后的第一个空行（含）结束。
 * - 帧之外的注释行与空行读到即交出，不随下一帧等待：上游以注释行发送心跳，电脑端按收到字节判定连接是否空闲。
 * - 一帧读完之后才解码：一个多字节字符可能被分割在两个分片中，LF 不会出现在多字节字符内部。
 *   只有位于流开头的 BOM 被去除，与按整条流解码相同。
 * - `end` 交出流结束时剩余的字节：末帧后没有空行时同样成帧，中转站在最后一个事件之后直接发送 FIN 是常见情形。
 */
export class SseSplitter {
  private buffer: Uint8Array = new Uint8Array(0)
  /** `buffer` 中下一行的起点：此前的行已检查。 */
  private scanned = 0
  /** `buffer` 中已有字段行，即处于一帧之中。 */
  private inFrame = false
  /** 已交出的字节数。 */
  private emitted = 0
  private readonly leading = new TextDecoder()
  private readonly rest = new TextDecoder('utf-8', { ignoreBOM: true })

  push(chunk: Uint8Array): SseBlock[] {
    if (this.buffer.byteLength === 0) {
      this.buffer = chunk
    } else {
      const joined = new Uint8Array(this.buffer.byteLength + chunk.byteLength)
      joined.set(this.buffer)
      joined.set(chunk, this.buffer.byteLength)
      this.buffer = joined
    }
    const out: SseBlock[] = []
    let start = 0
    for (;;) {
      const lf = this.buffer.indexOf(LF, this.scanned)
      if (lf < 0) break
      const lineStart = this.scanned
      const lineEnd = lf > lineStart && this.buffer[lf - 1] === CR ? lf - 1 : lf
      this.scanned = lf + 1
      const blank = lineEnd === lineStart
      if (this.inFrame) {
        if (!blank) continue
        out.push(this.block(start, lf + 1))
        this.inFrame = false
        start = lf + 1
      } else if (blank || this.buffer[lineStart] === COLON) {
        out.push({ bytes: this.buffer.subarray(start, lf + 1), frame: null })
        this.emitted += lf + 1 - start
        start = lf + 1
      } else {
        this.inFrame = true
      }
    }
    this.buffer = this.buffer.subarray(start)
    this.scanned -= start
    return out
  }

  end(): SseBlock[] {
    if (this.buffer.byteLength === 0) return []
    const last = this.block(0, this.buffer.byteLength)
    this.buffer = new Uint8Array(0)
    this.scanned = 0
    this.inFrame = false
    return [last]
  }

  private block(from: number, to: number): SseBlock {
    const bytes = this.buffer.subarray(from, to)
    const text = (this.emitted === 0 ? this.leading : this.rest).decode(bytes)
    this.emitted += bytes.byteLength
    return { bytes, frame: frameOf(text) }
  }
}

/** 一帧各行的解析：`event:` 取最后一行的值，多条 `data:` 行以换行合并；没有 `data:` 行时为 null。 */
function frameOf(text: string): SseFrame | null {
  let event: string | undefined
  const data: string[] = []
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    // 冒号后的第一个空格是分隔符的一部分，不属于值。
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'event') event = value
    else if (field === 'data') data.push(value)
  }
  return data.length ? { ...(event === undefined ? {} : { event }), data: data.join('\n') } : null
}

export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, unknown> {
  const reader = body.getReader()
  const splitter = new SseSplitter()
  try {
    for (;;) {
      const result = await reader.read()
      const blocks = result.done ? splitter.end() : splitter.push(result.value)
      for (const block of blocks) if (block.frame) yield block.frame
      if (result.done) return
    }
  } finally {
    // 调用方提前结束时，此步骤取消上游 body；流已出错时取消操作本身会被拒绝，不得覆盖原错误。
    await reader.cancel().catch(() => {})
  }
}

/**
 * 将一帧的 `data` 解析为对象。非 JSON 与非对象一律返回 null。
 *
 * 心跳与半行不构成协议错误：因一条心跳中断整轮 run，代价不成比例。
 */
export function sseJson(data: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(data)
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
