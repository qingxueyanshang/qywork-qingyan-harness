/**
 * 三种协议共用的 SSE 帧解析。
 *
 * 只负责分帧：按空行分帧、合并多条 `data:` 行、配对 `event:` 与 `data:`、跳过 `:` 注释行。
 * 哪个事件是终态、用量位于哪一帧，由适配器解释：两处分别解释终态必然产生不一致，因此此处不解析协议语义。
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

export async function* readSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, unknown> {
  const reader = body.getReader()
  // stream 模式：一个多字节字符可能被分割在两个分片中，逐片独立解码会得到替换字符。
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
        // 末帧后没有空行时同样交付：中转站在最后一个事件之后直接发送 FIN 是常见情形。
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
