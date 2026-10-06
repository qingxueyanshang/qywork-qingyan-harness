/**
 * 输入区 `#` / `@` 引用的纯字符串判定。
 *
 * 与斜杠命令相同，单独放在 lib：候选表会 import Solid 图标与 store，字符串边界判定
 * 不应因此无法测试。当前 textarea 只在光标位于草稿末尾时弹出补全，因此引用必然是
 * 草稿的最后一个连续词；选中后替换该词，之前的用户正文逐字保留。
 */

export type MentionKind = 'skill' | 'target'

export interface MentionQuery {
  kind: MentionKind
  sigil: '#' | '@'
  query: string
  start: number
}

/** 取得草稿末尾正在输入的 `#技能` 或 `@调用目标`。 */
export function mentionQuery(draft: string): MentionQuery | null {
  const match = /([#@])([^\s#@]*)$/u.exec(draft)
  if (!match) return null

  const sigil = match[1] as '#' | '@'
  const start = match.index
  /*
   * 邮箱地址不是调用：`name@example.com` 中的 @ 紧接在 ASCII 用户名字符之后。
   * 中文正文中的「让@reviewer 看」仍可触发，用户无需先补一个空格。
   */
  if (sigil === '@' && start > 0 && /[A-Za-z0-9._%+-]/.test(draft[start - 1]!)) return null

  return {
    kind: sigil === '#' ? 'skill' : 'target',
    sigil,
    query: match[2] ?? '',
    start,
  }
}

/** 用候选的精确注册名替换当前引用词，末尾保留一个空格供用户继续输入。 */
export function replaceMention(draft: string, query: MentionQuery, name: string): string {
  return `${draft.slice(0, query.start)}${query.sigil}${name} `
}

/** 名称、说明与来源都参与检索；用户无需记住注册名属于哪一部分。 */
export function matchesMention(query: string, ...fields: string[]): boolean {
  const needle = query.trim().toLocaleLowerCase()
  if (!needle) return true
  return fields.some((field) => field.toLocaleLowerCase().includes(needle))
}
