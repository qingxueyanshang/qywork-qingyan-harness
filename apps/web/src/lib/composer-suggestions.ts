/**
 * 输入区 `#` / `@` 引用的纯字符串判定。
 *
 * 和斜杠命令一样单独放在 lib：候选表会 import Solid 图标与 store，字符串边界不该
 * 因此变得不可测。当前 textarea 只在光标位于草稿末尾时弹补全，所以引用一定是
 * 草稿最后一个连续词；选中后替换这个词，前面的用户正文逐字保留。
 */

export type MentionKind = 'skill' | 'target'

export interface MentionQuery {
  kind: MentionKind
  sigil: '#' | '@'
  query: string
  start: number
}

/** 取草稿末尾正在输入的 `#技能` 或 `@调用目标`。 */
export function mentionQuery(draft: string): MentionQuery | null {
  const match = /([#@])([^\s#@]*)$/u.exec(draft)
  if (!match) return null

  const sigil = match[1] as '#' | '@'
  const start = match.index
  /*
   * 邮箱不是调用：`name@example.com` 的 @ 前面紧挨 ASCII 用户名字符。
   * 中文正文里的「让@reviewer 看」仍允许触发，用户不必被迫先补一个空格。
   */
  if (sigil === '@' && start > 0 && /[A-Za-z0-9._%+-]/.test(draft[start - 1]!)) return null

  return {
    kind: sigil === '#' ? 'skill' : 'target',
    sigil,
    query: match[2] ?? '',
    start,
  }
}

/** 用候选的精确注册名替换当前引用词，末尾留空格供用户继续写。 */
export function replaceMention(draft: string, query: MentionQuery, name: string): string {
  return `${draft.slice(0, query.start)}${query.sigil}${name} `
}

/** 名字、说明与来源都参与检索；用户不必记得注册名属于哪一段。 */
export function matchesMention(query: string, ...fields: string[]): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return fields.some((field) => field.toLocaleLowerCase().includes(needle))
}
