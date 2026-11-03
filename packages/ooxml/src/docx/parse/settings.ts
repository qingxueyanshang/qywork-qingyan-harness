/**
 * 设置部件与字体表：影响排版的文档设置、主题字体语言与字体表条目。
 *
 * - `defaultTabStop` 缺失时为 500 缇：WPS 打开没有该项的文档时默认制表位间距为 25 磅（实测）。
 * - `themeFontLang` 缺失的语言按 `zh-CN` 处理：WPS 对没有该项的文档用主题的 `Hans` 字体作为东亚主题字体（实测）。
 * - 自定义禁则字符（`noLineBreaksBefore`、`noLineBreaksAfter`）不区分 `w:lang`，出现即替换缺省表。
 * - 公式设置（`m:mathPr`）缺失时取 `MATH_SETTINGS_DEFAULTS`。
 * - 字体表中同名的条目只取第一个：WPS 实测（构造文档 f4、f5）两个同名条目的 `w:altName` 不同时按第一个替代。
 *   嵌入字体（`w:embedRegular` 等）同样只取第一个条目中的。
 */

import { MATH_SETTINGS_DEFAULTS, type MathSettings, readMathSettings } from '../../math/index.ts'
import { relAttr } from '../../opc/read.ts'
import type { FontTableEntry } from '../model.ts'
import { eachChild, onOff, type Scanner, skip, wAttr, wNum } from './xml.ts'

const DEFAULT_TAB_STOP = 500

export interface RawSettings {
  /** 缇。 */
  readonly defaultTabStop: number
  readonly doNotExpandShiftReturn: boolean
  /** `characterSpacingControl` 为压缩标点（含压缩标点与假名）。 */
  readonly compressPunctuation: boolean
  readonly balanceSingleByte: boolean
  /** `compatSetting` 中的 `compatibilityMode`；没有该项时为 0。 */
  readonly compatibilityMode: number
  readonly evenAndOddHeaders: boolean
  readonly noLineBreakBefore: string | null
  readonly noLineBreakAfter: string | null
  readonly eastAsiaLanguage: string
  readonly bidiLanguage: string
  readonly adjustLineHeightInTable: boolean
  readonly displayBackgroundShape: boolean
  readonly math: MathSettings
}

export const DEFAULT_SETTINGS: RawSettings = {
  defaultTabStop: DEFAULT_TAB_STOP,
  doNotExpandShiftReturn: false,
  compressPunctuation: false,
  balanceSingleByte: false,
  compatibilityMode: 0,
  evenAndOddHeaders: false,
  noLineBreakBefore: null,
  noLineBreakAfter: null,
  eastAsiaLanguage: 'zh-CN',
  bidiLanguage: '',
  adjustLineHeightInTable: false,
  displayBackgroundShape: false,
  math: MATH_SETTINGS_DEFAULTS,
}

/** 根元素为 `settings` 的部件。 */
export function readSettings(x: Scanner): RawSettings {
  let defaultTabStop = DEFAULT_TAB_STOP
  let doNotExpandShiftReturn = false
  let compressPunctuation = false
  let balanceSingleByte = false
  let compatibilityMode = 0
  let evenAndOddHeaders = false
  let noLineBreakBefore: string | null = null
  let noLineBreakAfter: string | null = null
  let eastAsiaLanguage = 'zh-CN'
  let bidiLanguage = ''
  let adjustLineHeightInTable = false
  let displayBackgroundShape = false
  let math = MATH_SETTINGS_DEFAULTS
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start' || x.depth !== 2) continue
    switch (x.local) {
      case 'defaultTabStop':
        defaultTabStop = wNum(x, 'val') ?? defaultTabStop
        break
      case 'evenAndOddHeaders':
        evenAndOddHeaders = onOff(x)
        break
      case 'displayBackgroundShape':
        displayBackgroundShape = onOff(x)
        break
      case 'mathPr':
        math = readMathSettings(x)
        break
      case 'characterSpacingControl':
        compressPunctuation = (wAttr(x, 'val') ?? '').startsWith('compressPunctuation')
        break
      case 'noLineBreaksBefore':
        noLineBreakBefore = wAttr(x, 'val')
        break
      case 'noLineBreaksAfter':
        noLineBreakAfter = wAttr(x, 'val')
        break
      case 'themeFontLang':
        eastAsiaLanguage = wAttr(x, 'eastAsia') ?? eastAsiaLanguage
        bidiLanguage = wAttr(x, 'bidi') ?? bidiLanguage
        break
      case 'compat':
        eachChild(x, (local) => {
          if (local === 'doNotExpandShiftReturn') doNotExpandShiftReturn = onOff(x)
          else if (local === 'balanceSingleByteDoubleByteWidth') balanceSingleByte = onOff(x)
          else if (local === 'adjustLineHeightInTable') adjustLineHeightInTable = onOff(x)
          else if (local === 'compatSetting' && wAttr(x, 'name') === 'compatibilityMode')
            compatibilityMode = wNum(x, 'val') ?? compatibilityMode
          skip(x)
        })
        break
    }
  }
  return {
    defaultTabStop,
    doNotExpandShiftReturn,
    compressPunctuation,
    balanceSingleByte,
    compatibilityMode,
    evenAndOddHeaders,
    noLineBreakBefore,
    noLineBreakAfter,
    eastAsiaLanguage,
    bidiLanguage,
    adjustLineHeightInTable,
    displayBackgroundShape,
    math,
  }
}

/** 字体表中的嵌入字体：字形由元素名给出，部件为字体表部件的关系 `id`。 */
export interface RawEmbeddedFont {
  readonly name: string
  readonly bold: boolean
  readonly italic: boolean
  readonly id: string
  /** `w:fontKey`；没有该属性时部件未混淆。 */
  readonly key: string | null
}

const EMBED_STYLES: ReadonlyMap<string, readonly [bold: boolean, italic: boolean]> = new Map([
  ['embedRegular', [false, false]],
  ['embedBold', [true, false]],
  ['embedItalic', [false, true]],
  ['embedBoldItalic', [true, true]],
])

/**
 * 根元素为 `fonts` 的部件：各字体名的第一个条目与其中的嵌入字体。`w:charset` 为十六进制，不是十六进制数时按未指定。
 */
export function readFontTable(x: Scanner): {
  entries: Map<string, FontTableEntry>
  embedded: RawEmbeddedFont[]
} {
  const entries = new Map<string, FontTableEntry>()
  const embedded: RawEmbeddedFont[] = []
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start' || x.depth !== 2 || x.local !== 'font') continue
    const name = wAttr(x, 'name')
    let altName = ''
    let charset: number | null = null
    const embeds: RawEmbeddedFont[] = []
    eachChild(x, (local) => {
      const style = EMBED_STYLES.get(local)
      if (local === 'altName') altName = (wAttr(x, 'val') ?? '').trim()
      else if (local === 'charset') {
        const v = wAttr(x, 'val') ?? ''
        if (/^[0-9a-f]{1,2}$/i.test(v)) charset = Number.parseInt(v, 16)
      } else if (style !== undefined && name !== null) {
        const id = relAttr(x, 'id')
        if (id !== null)
          embeds.push({ name, bold: style[0], italic: style[1], id, key: wAttr(x, 'fontKey') })
      }
      skip(x)
    })
    if (name === null || entries.has(name)) continue
    entries.set(name, { altName, charset })
    embedded.push(...embeds)
  }
  return { entries, embedded }
}
