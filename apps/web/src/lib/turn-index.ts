import type { ConversationTurnRef } from '@qywork/core'
import type { TranscriptItem } from './store/index.ts'

/**
 * 会话索引的数据：整条会话的每条用户输入对应一个索引项。
 *
 * 索引项有两个来源，按时间先后相接：`earlier` 是早于已加载内容的条目（历史页响应的
 * `earlierTurns`），`items` 是已加载的会话流。更早的一页加载后，对应条目从前者移到后者。
 */

/** 索引项的 id 序列。回执（`receipt`）不是用户输入，不计入。 */
export function turnIds(
  earlier: readonly ConversationTurnRef[],
  items: readonly TranscriptItem[],
): string[] {
  const ids: string[] = earlier.map((turn) => turn.id)
  for (const item of items) if (item.kind === 'user') ids.push(item.id)
  return ids
}

export interface TurnPreview {
  /** 用户输入的开头；只有附件时为附件名。 */
  title: string
  /** 该输入之后第一段回复正文的开头；尚无回复或该条尚未加载时为空串。 */
  reply: string
}

/** 只取开头一段再合并空白：正文可达数万字，摘要不需要扫描全文。 */
function excerpt(text: string, length: number): string {
  return text
    .slice(0, length * 3)
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, length)
}

/** 指定索引项的摘要；`id` 不是索引项时返回 null。 */
export function turnPreview(
  earlier: readonly ConversationTurnRef[],
  items: readonly TranscriptItem[],
  id: string,
): TurnPreview | null {
  const at = items.findIndex((item) => item.kind === 'user' && item.id === id)
  if (at < 0) {
    const turn = earlier.find((entry) => entry.id === id)
    return turn ? { title: excerpt(turn.text, 80), reply: '' } : null
  }
  const user = items[at]!
  let reply = ''
  for (let i = at + 1; i < items.length; i++) {
    const item = items[i]!
    if (item.kind === 'user') break
    if (item.kind === 'text' && item.text.trim()) {
      // 摘要按纯文本显示，去掉 Markdown 的强调、代码与标题标记。
      reply = excerpt(item.text.replace(/[*`]+|^[#>]+\s*/gm, ''), 120)
      break
    }
  }
  const title = excerpt(user.text, 80) || (user.attachments ?? []).map((a) => a.name).join('、')
  return { title, reply }
}

/**
 * 当前所在的索引项：顶边不低于 `line` 的最后一项的下标。`tops` 按文档顺序排列。
 * 全部位于 `line` 以下时取第一项；`tops` 为空时返回 -1。
 */
export function activeTurn(tops: readonly number[], line: number): number {
  if (tops.length === 0) return -1
  let current = 0
  for (let i = 0; i < tops.length; i++) {
    if (tops[i]! > line) break
    current = i
  }
  return current
}
