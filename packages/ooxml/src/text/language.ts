/**
 * Windows 语言标识（LCID）到语言标记：.doc 的 sprm 与 .ppt 的 TextSpecialInfoAtom 共用。
 *
 * - 只区分排版与字体选择用到的中日韩语言，其余为空串（按没有语言处理）。
 * - 先按完整的语言标识区分繁体与简体中文；其余子语言按主语言（低 10 位）取标记。
 */

const BY_LCID: ReadonlyMap<number, string> = new Map([
  [0x0804, 'zh-CN'],
  [0x1004, 'zh-CN'],
  [0x0404, 'zh-TW'],
  [0x0c04, 'zh-HK'],
  [0x1404, 'zh-MO'],
  [0x0411, 'ja-JP'],
  [0x0412, 'ko-KR'],
])

const BY_PRIMARY: ReadonlyMap<number, string> = new Map([
  [0x04, 'zh-CN'],
  [0x11, 'ja-JP'],
  [0x12, 'ko-KR'],
])

export function languageTag(lcid: number): string {
  return BY_LCID.get(lcid) ?? BY_PRIMARY.get(lcid & 0x3ff) ?? ''
}
