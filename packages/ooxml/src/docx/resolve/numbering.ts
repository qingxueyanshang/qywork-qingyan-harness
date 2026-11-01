/**
 * 编号计数：按文档顺序为编号段落生成编号文本。规则与 WPS 12.1 实测一致：
 *
 * - 计数按 `num` 引用的 `abstractNumId` 共用：引用同一抽象编号的不同 `num` 接续计数；带 `numStyleLink` 的抽象编号
 *   计数独立，级别定义取自链接的编号样式所引用的编号。
 * - `startOverride`：该 `num` 第一次出现时把对应级别置为未开始，下一段取覆盖后的起始值。
 * - 某级别出现时，尚未开始的更高级别按各自的起始值计入（跳级之后再出现的中间级别取起始值加一）；
 *   更低级别按 `lvlRestart` 重新计数：缺省为任一更高级别出现后，0 为从不，`n` 为第 1 至 `n` 级（`ilvl` 小于 `n`）出现后。
 * - 编号文本中的 `%k` 取第 k 级的计数与格式；`isLgl` 使各级一律按十进制显示。
 */

import type { Level, NumberingDefs } from '../parse/numbering.ts'
import type { Styles } from '../parse/styles.ts'
import { fallbackNumber, formatNumber } from './number-format.ts'

const LEVELS = 9

export interface NumberedText {
  readonly text: string
  readonly level: Level
}

export class NumberingState {
  /** 抽象编号标识到各级计数；`null` 为未开始。 */
  private readonly counters = new Map<number, (number | null)[]>()
  private readonly used = new Set<number>()

  constructor(
    private readonly defs: NumberingDefs,
    private readonly styles: Styles,
    private readonly unsupportedFormat: () => void,
  ) {}

  /** 级别定义：`num` 的 `lvlOverride/lvl` 优先，其次抽象编号（经 `numStyleLink`）的级别。 */
  level(numId: number, ilvl: number): Level | null {
    const num = this.defs.nums.get(numId)
    if (num === undefined) return null
    const override = num.overrides.get(ilvl)?.level
    if (override) return override
    return this.abstractLevels(num.abstractId)?.get(ilvl) ?? null
  }

  /** 关联到段落样式 `style` 的级别（`lvl/pStyle`）；没有时为 `null`。 */
  levelOfStyle(numId: number, style: string): number | null {
    const num = this.defs.nums.get(numId)
    if (num === undefined) return null
    for (const [ilvl, level] of this.abstractLevels(num.abstractId) ?? []) {
      if (level.style === style) return ilvl
    }
    return null
  }

  private abstractLevels(abstractId: number): ReadonlyMap<number, Level> | null {
    const abs = this.defs.abstracts.get(abstractId)
    if (abs === undefined) return null
    if (abs.numStyleLink === null) return abs.levels
    const linked = this.styles.byId.get(abs.numStyleLink)?.pPr.numId
    const target = linked === undefined ? undefined : this.defs.nums.get(linked)
    const levels =
      target === undefined ? undefined : this.defs.abstracts.get(target.abstractId)?.levels
    return levels ?? abs.levels
  }

  /** 推进计数并返回该段的编号文本；`num` 或级别不存在时为 `null`。 */
  next(numId: number, ilvl: number): NumberedText | null {
    const num = this.defs.nums.get(numId)
    const level = this.level(numId, ilvl)
    if (num === undefined || level === null) return null
    let counts = this.counters.get(num.abstractId)
    if (counts === undefined) {
      counts = new Array<number | null>(LEVELS).fill(null)
      this.counters.set(num.abstractId, counts)
    }
    if (!this.used.has(numId)) {
      this.used.add(numId)
      for (const [k, o] of num.overrides) if (o.start !== null && k < LEVELS) counts[k] = null
    }
    const start = (k: number): number =>
      num.overrides.get(k)?.start ?? this.level(numId, k)?.start ?? 0
    for (let k = 0; k < ilvl; k++) if (counts[k] === null) counts[k] = start(k)
    const current = counts[ilvl]
    counts[ilvl] = current === null || current === undefined ? start(ilvl) : current + 1
    for (let k = ilvl + 1; k < LEVELS; k++) {
      const restart = this.level(numId, k)?.restart ?? null
      if (restart === null || (restart !== 0 && ilvl < restart)) counts[k] = null
    }
    const text = level.text.replace(/%([1-9])/g, (_, d: string) => {
      const k = Number(d) - 1
      const value = counts[k] ?? start(k)
      const format = level.legal ? 'decimal' : (this.level(numId, k)?.format ?? 'decimal')
      const formatted = formatNumber(value, format)
      if (formatted !== null) return formatted
      this.unsupportedFormat()
      return fallbackNumber(value)
    })
    return { text, level }
  }
}
