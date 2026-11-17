/**
 * 按 `\n` 分帧的行缓冲，单行有长度上限。MCP 的 stdio 与 SSE、插件进程、外部 CLI 的 JSONL 输出共用。
 *
 * - 返回的行不含 `\n`，`\r` 与首尾空白原样保留，由调用方决定是否 `trim`。
 * - 长度按字符（UTF-16 码元）计：调用方传入的是已解码的字符串。
 * - 缓冲中未结束的行不超过上限。一行超过上限时丢弃该行与此后的全部输入：不设上限时，
 *   对端只要不再输出换行，缓冲就一直增长到进程内存耗尽。
 */

export interface LineFrames {
  /** 本次输入中已结束的行，按出现顺序。 */
  lines: string[]
  /** 本次输入使某一行超过上限。只在超过的那一次为 true；此后的输入一律丢弃，`lines` 为空。 */
  overflow: boolean
}

export interface LineFramer {
  push(chunk: string): LineFrames
  /** 输入结束：返回尚未以 `\n` 结束的末行，并清空缓冲。 */
  end(): string
}

export function createLineFramer(maxLineChars: number): LineFramer {
  let tail = ''
  let failed = false
  return {
    push(chunk) {
      const lines: string[] = []
      if (failed) return { lines, overflow: false }
      let start = 0
      for (;;) {
        const at = chunk.indexOf('\n', start)
        const end = at < 0 ? chunk.length : at
        // 先比较长度再拼接：拼接之后再比较时，缓冲在比较之前已经超过上限。
        if (tail.length + end - start > maxLineChars) {
          failed = true
          tail = ''
          return { lines, overflow: true }
        }
        if (at < 0) {
          tail += chunk.slice(start)
          return { lines, overflow: false }
        }
        lines.push(tail + chunk.slice(start, at))
        tail = ''
        start = at + 1
      }
    },
    end() {
      const rest = tail
      tail = ''
      return rest
    },
  }
}
