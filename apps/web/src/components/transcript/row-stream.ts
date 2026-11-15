import { createContext } from 'solid-js'
import { isRunning, type TranscriptItem, transcript } from '../../lib/store/index.ts'

/**
 * 本列正文所属的流，以及该流是否仍在增长。
 *
 * `Prose` 与 `ThinkingFold` 判定某一条是否仍在流式输出时，必须与本列的末项比较。默认是
 * 当前会话的列；右侧子会话页传入子会话自身的列。与当前会话的末项比较时，子会话的每一段
 * 正文都会被判定为已定稿，每到达一批文字就整段重新排版一次。
 */
export const RowStream = createContext<{
  items: () => TranscriptItem[]
  live: () => boolean
  generatingToolCall: () => boolean
}>({
  items: transcript,
  live: isRunning,
  generatingToolCall: () => false,
})
