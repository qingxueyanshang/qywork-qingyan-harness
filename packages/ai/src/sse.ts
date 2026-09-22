/**
 * 三条协议共用的 SSE 帧解析。
 *
 * 只做分帧：按空行切帧、多条 `data:` 行合并、`event:` 与 `data:` 配对、`:` 注释行跳过。
 * 哪个事件是终态、用量挂在哪一帧，由适配器解释——两处解释终态必然漂移，所以这里不认协议。
 *
 * 边界三条，调用方必须知道：
 *
 * - **协议终态到达就 `break`**：生成器的 `finally` 取消上游 body，连接随即释放，
 *   不必等 HTTP EOF。工具调用与用量因此在终态处交付。
 * - **`[DONE]` 原样交出**（`data` 等于 `SSE_DONE`），由调用方决定终止还是忽略：
 *   它是 chat/completions 的终止标记，另两条协议不发它。
 * - **正文出错原样抛出**，包括传输层判定的 `stream_idle_timeout`。不要在这里改写成
 *   协议错误：断流与流内错误事件的重试语义不同。
 */

/** chat/completions 的终止标记。它不是协议事件，没有 JSON 体。 */
export const SSE_DONE = '[DONE]'

export interface SseFrame {
  /** `event:` 行的值；这一帧没有该行时缺席。 */
  event?: string
  /** 多条 `data:` 行以换行合并后的原文。 */
  data: string
}

export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, unknown> {
  const reader = body.getReader()
  // stream 模式：一个多字节字符可能被切在两个分片之间，逐片独立解码会得到替换字符。
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let data: string[] = []

  const take = (): SseFrame | null => {
    const frame = data.length
      ? { ...(event === undefined ? {} : { event }), data: data.join('\n') }
      : null
    event = undefined
    data = []
    return frame
  }

  try {
    for (let eof = false; !eof; ) {
      const result = await reader.read()
      if (result.done) {
        eof = true
        buffer += decoder.decode()
        // 末帧后面没有空行时照样交付：中转在最后一个事件之后直接 FIN 是常见形状。
        if (buffer && !buffer.endsWith('\n')) buffer += '\n'
      } else {
        buffer += decoder.decode(result.value, { stream: true })
      }

      for (;;) {
        const idx = buffer.indexOf('\n')
        if (idx < 0) break
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        if (line === '') {
          const frame = take()
          if (frame) yield frame
          continue
        }
        if (line.startsWith(':')) continue
        const colon = line.indexOf(':')
        const field = colon < 0 ? line : line.slice(0, colon)
        // 冒号后的第一个空格是分隔符的一部分，不属于值。
        const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '')
        if (field === 'event') event = value
        else if (field === 'data') data.push(value)
      }

      if (eof) {
        const frame = take()
        if (frame) yield frame
      }
    }
  } finally {
    // 调用方提前结束时这一步取消上游 body；流已出错时取消本身会拒绝，不能盖掉原错误。
    await reader.cancel().catch(() => {})
  }
}

/**
 * 把一帧的 `data` 读成对象。非 JSON 与非对象一律返回 null。
 *
 * 心跳与半行不构成协议错误：一条心跳把整轮 run 打断，代价完全不成比例。
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
