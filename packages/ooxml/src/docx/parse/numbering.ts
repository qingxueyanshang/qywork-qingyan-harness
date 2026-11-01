/**
 * 编号部件：`abstractNum` 的各级定义与 `num` 的级别覆盖。编号计数与文本生成在 `../resolve/numbering.ts` 中。
 *
 * - 级别缺少的项取缺省值：`start` 0、`numFmt` `decimal`、`lvlText` 空串、`suff` `tab`、`lvlJc` `left`；
 *   `lvlRestart` 缺省为 `null`（任一更高级别出现后重新计数），0 为从不重新计数。
 * - `lvlOverride` 中的 `lvl` 整体替换该级别（不与抽象定义逐项合并）；`startOverride` 只改变起始值。
 */

import { type RawParaProps, type RawRunProps, readParaProps, readRunProps } from './properties.ts'
import { eachChild, onOff, type Scanner, skip, wAttr, wNum } from './xml.ts'

export interface Level {
  readonly start: number
  readonly format: string
  readonly text: string
  readonly restart: number | null
  readonly legal: boolean
  readonly suffix: 'tab' | 'space' | 'nothing'
  readonly align: 'left' | 'center' | 'right'
  /** 级别关联的段落样式（`w:pStyle`）。 */
  readonly style: string | null
  readonly pPr: RawParaProps
  readonly rPr: RawRunProps
}

export interface AbstractNum {
  readonly levels: ReadonlyMap<number, Level>
  /** `numStyleLink`：级别定义取自该编号样式所引用的编号。 */
  readonly numStyleLink: string | null
}

export interface LevelOverride {
  readonly start: number | null
  readonly level: Level | null
}

export interface NumInstance {
  readonly abstractId: number
  readonly overrides: ReadonlyMap<number, LevelOverride>
}

export interface NumberingDefs {
  readonly abstracts: ReadonlyMap<number, AbstractNum>
  readonly nums: ReadonlyMap<number, NumInstance>
}

export const EMPTY_NUMBERING: NumberingDefs = { abstracts: new Map(), nums: new Map() }

function readLevel(x: Scanner): Level {
  let start = 0
  let format = 'decimal'
  let text = ''
  let restart: number | null = null
  let legal = false
  let suffix: Level['suffix'] = 'tab'
  let align: Level['align'] = 'left'
  let style: string | null = null
  let pPr: RawParaProps = {}
  let rPr: RawRunProps = {}
  eachChild(x, (local) => {
    switch (local) {
      case 'start':
        start = wNum(x, 'val') ?? start
        break
      case 'numFmt':
        format = wAttr(x, 'val') ?? format
        break
      case 'lvlText':
        text = wAttr(x, 'val') ?? ''
        break
      case 'lvlRestart':
        restart = wNum(x, 'val')
        break
      case 'isLgl':
        legal = onOff(x)
        break
      case 'suff': {
        const v = wAttr(x, 'val')
        if (v === 'space' || v === 'nothing' || v === 'tab') suffix = v
        break
      }
      case 'lvlJc': {
        const v = wAttr(x, 'val')
        if (v === 'center') align = 'center'
        else if (v === 'right' || v === 'end') align = 'right'
        else align = 'left'
        break
      }
      case 'pStyle':
        style = wAttr(x, 'val')
        break
      case 'pPr':
        pPr = readParaProps(x)
        return
      case 'rPr':
        rPr = readRunProps(x)
        return
    }
    skip(x)
  })
  return { start, format, text, restart, legal, suffix, align, style, pPr, rPr }
}

function readAbstract(x: Scanner): AbstractNum {
  const levels = new Map<number, Level>()
  let numStyleLink: string | null = null
  eachChild(x, (local) => {
    if (local === 'lvl') {
      const ilvl = wNum(x, 'ilvl') ?? 0
      const level = readLevel(x)
      if (!levels.has(ilvl)) levels.set(ilvl, level)
    } else {
      if (local === 'numStyleLink') numStyleLink = wAttr(x, 'val')
      skip(x)
    }
  })
  return { levels, numStyleLink }
}

function readNum(x: Scanner): NumInstance | null {
  let abstractId: number | null = null
  const overrides = new Map<number, LevelOverride>()
  eachChild(x, (local) => {
    if (local === 'abstractNumId') {
      abstractId = wNum(x, 'val')
      skip(x)
    } else if (local === 'lvlOverride') {
      const ilvl = wNum(x, 'ilvl') ?? 0
      let start: number | null = null
      let level: Level | null = null
      eachChild(x, (inner) => {
        if (inner === 'startOverride') {
          start = wNum(x, 'val')
          skip(x)
        } else if (inner === 'lvl') level = readLevel(x)
        else skip(x)
      })
      overrides.set(ilvl, { start, level })
    } else skip(x)
  })
  return abstractId === null ? null : { abstractId, overrides }
}

/** 根元素为 `numbering` 的部件。 */
export function readNumbering(x: Scanner): NumberingDefs {
  const abstracts = new Map<number, AbstractNum>()
  const nums = new Map<number, NumInstance>()
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t !== 'start' || x.depth !== 2) continue
    if (x.local === 'abstractNum') {
      const id = wNum(x, 'abstractNumId')
      const def = readAbstract(x)
      if (id !== null && !abstracts.has(id)) abstracts.set(id, def)
    } else if (x.local === 'num') {
      const id = wNum(x, 'numId')
      const def = readNum(x)
      if (id !== null && def !== null && !nums.has(id)) nums.set(id, def)
    }
  }
  return { abstracts, nums }
}
