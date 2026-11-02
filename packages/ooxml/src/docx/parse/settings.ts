/**
 * 设置部件与字体表：影响排版的文档设置、主题字体语言与字体字符集。
 *
 * - `defaultTabStop` 缺失时为 500 缇：WPS 打开没有该项的文档时默认制表位间距为 25 磅（实测）。
 * - `themeFontLang` 缺失的语言按 `zh-CN` 处理：WPS 对没有该项的文档用主题的 `Hans` 字体作为东亚主题字体（实测）。
 * - 自定义禁则字符（`noLineBreaksBefore`、`noLineBreaksAfter`）不区分 `w:lang`，出现即替换缺省表。
 * - 公式设置（`m:mathPr`）缺失时取 `MATH_SETTINGS_DEFAULTS`。
 */

import { MATH_SETTINGS_DEFAULTS, type MathSettings, readMathSettings } from '../../math/index.ts'
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

/** GB2312 与 Big5 的 `w:charset` 取值（十六进制）。 */
const CHINESE_CHARSETS = new Set(['86', '88'])

/** 根元素为 `fonts` 的部件：返回字符集为 GB2312 或 Big5 的字体名。 */
export function readChineseCharsetFonts(x: Scanner): string[] {
  const out: string[] = []
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start' || x.depth !== 2 || x.local !== 'font') continue
    const name = wAttr(x, 'name')
    eachChild(x, (local) => {
      if (local === 'charset') {
        const v = wAttr(x, 'val')?.toUpperCase()
        if (name !== null && v !== undefined && CHINESE_CHARSETS.has(v)) out.push(name)
      }
      skip(x)
    })
  }
  return out
}
