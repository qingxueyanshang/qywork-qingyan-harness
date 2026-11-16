/**
 * 结构守卫的基线：记录现状上限，只减不增。
 *
 * `baseline.json` 有四部分：文件行数、中心清单计数、组件内的状态数、组件内的内嵌组件数。
 * 未列入基线的条目不得超过上限；列入的条目不得超过基线值。条目已变小、已不超过上限或已不存在时同样判为失败，
 * 提示下调或移除，基线因此不留余量。中心清单没有上限：每个计数项都必须在基线中。
 * 基线不是豁免名单：它不免除任何新增内容的检查，列入的条目只能变小。
 *
 * 命令行：
 * - `--update`：按现状下调或移除条目。需要上调或新增条目时拒绝，不写入任何内容，退出码非零。
 * - `--init`：只用于首次建立基线，写入超过上限的条目与全部中心清单计数项。基线文件已存在时拒绝。
 *
 * 门禁中的测试只读取基线，不修改文件。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { keyOf, measureCentralLists, TARGETS } from './central-lists.ts'
import { INNER_CAP, measureComponents, STATE_CAP } from './components.ts'
import { LINE_CAP, measureFileLines } from './file-size.ts'

export const BASELINE_FILE = join(import.meta.dir, 'baseline.json')
const UPDATE = 'bun run scripts/structure/baseline.ts --update'

export const SECTIONS = ['fileLines', 'centralLists', 'componentStates', 'innerComponents'] as const
export type Section = (typeof SECTIONS)[number]
export type Entries = Record<string, number>
export type Baseline = Record<Section, Entries>

export interface Rule {
  /** 未列入基线的条目允许的最大值；null 表示每个条目都必须在基线中。 */
  cap: number | null
  /** 计量的对象，写在现状值之前，如「状态 12 个」中的「状态」；键已说明对象时为空串。 */
  what: string
  unit: string
  /** 超过上限或基线时的处理方向。 */
  hint(key: string): string
}

export const RULES: Record<Section, Rule> = {
  fileLines: { cap: LINE_CAP, what: '', unit: '行', hint: () => '按职责拆分' },
  centralLists: {
    cap: null,
    what: '',
    unit: '个',
    hint: (key) => TARGETS.find((t) => keyOf(t) === key)?.hint ?? '',
  },
  componentStates: {
    cap: STATE_CAP,
    what: '状态',
    unit: '个',
    hint: () => '状态移入组件之外的控制器，或拆分出子组件',
  },
  innerComponents: {
    cap: INNER_CAP,
    what: '内嵌组件',
    unit: '个',
    hint: () => '内嵌组件移到独立文件，经 props 或 context 取得状态',
  },
}

/**
 * 一处不符。`over-cap`、`over-baseline`、`unregistered` 须修改代码或登记；
 * `below-cap`、`shrunk`、`stale` 由 `--update` 处理。
 */
export interface Finding {
  key: string
  kind: 'over-cap' | 'over-baseline' | 'unregistered' | 'below-cap' | 'shrunk' | 'stale'
  /** 现状值；条目已不存在时为 null。 */
  current: number | null
  /** 基线值或上限。 */
  allowed: number
}

export function findings(
  rule: Rule,
  measured: ReadonlyMap<string, number>,
  baseline: Readonly<Entries>,
): Finding[] {
  const out: Finding[] = []
  for (const [key, current] of measured) {
    const base = baseline[key]
    if (base === undefined) {
      if (rule.cap === null) out.push({ key, kind: 'unregistered', current, allowed: 0 })
      else if (current > rule.cap) out.push({ key, kind: 'over-cap', current, allowed: rule.cap })
    } else if (current > base) {
      out.push({ key, kind: 'over-baseline', current, allowed: base })
    } else if (rule.cap !== null && current <= rule.cap) {
      out.push({ key, kind: 'below-cap', current, allowed: rule.cap })
    } else if (current < base) {
      out.push({ key, kind: 'shrunk', current, allowed: base })
    }
  }
  for (const [key, base] of Object.entries(baseline)) {
    if (!measured.has(key)) out.push({ key, kind: 'stale', current: null, allowed: base })
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
}

/** 失败信息：条目、现状、允许的值与处理方向。 */
export function messageOf(rule: Rule, f: Finding): string {
  const now = `${rule.what ? `${rule.what} ` : ''}${f.current} ${rule.unit}`
  const allowed = `${f.allowed} ${rule.unit}`
  switch (f.kind) {
    case 'over-cap':
      return `${f.key}：${now}，上限 ${allowed} → ${rule.hint(f.key)}`
    case 'over-baseline':
      return `${f.key}：${now}，基线 ${allowed} → ${rule.hint(f.key)}；基线只能下调`
    case 'unregistered':
      return `${f.key}：${now}，没有基线值 → 在 baseline.json 中登记现状值`
    case 'below-cap':
      return `${f.key}：${now}，已不超过上限 ${allowed} → 运行 ${UPDATE} 移除该条目`
    case 'shrunk':
      return `${f.key}：${now}，基线 ${allowed} → 运行 ${UPDATE} 下调基线`
    case 'stale':
      return `${f.key}：已不存在，基线 ${allowed} → 运行 ${UPDATE} 移除该条目`
  }
}

export function check(
  rule: Rule,
  measured: ReadonlyMap<string, number>,
  baseline: Readonly<Entries>,
): string[] {
  return findings(rule, measured, baseline).map((f) => messageOf(rule, f))
}

export interface Update {
  next: Entries
  /** 须修改代码或登记、`--update` 不处理的不符。非空时不写入。 */
  refused: string[]
  /** 已下调或移除的条目。 */
  changes: string[]
}

/** 下调与移除；上调与新增一律拒绝。 */
export function update(
  rule: Rule,
  measured: ReadonlyMap<string, number>,
  baseline: Readonly<Entries>,
): Update {
  const next: Entries = { ...baseline }
  const refused: string[] = []
  const changes: string[] = []
  for (const f of findings(rule, measured, baseline)) {
    if (f.kind === 'shrunk' && f.current !== null) {
      next[f.key] = f.current
      changes.push(`${f.key}：${f.allowed} ${rule.unit} → ${f.current} ${rule.unit}`)
    } else if (f.kind === 'below-cap' || f.kind === 'stale') {
      delete next[f.key]
      changes.push(`${f.key}：移除`)
    } else {
      refused.push(messageOf(rule, f))
    }
  }
  return { next, refused, changes }
}

/** 首次建立：超过上限的条目全部写入；没有上限时写入全部条目。 */
export function init(rule: Rule, measured: ReadonlyMap<string, number>): Entries {
  const out: Entries = {}
  for (const [key, n] of measured) if (rule.cap === null || n > rule.cap) out[key] = n
  return out
}

/** 按固定的部分顺序与键的顺序输出，一行一个条目。 */
export function serialize(b: Baseline): string {
  const sorted = Object.fromEntries(
    SECTIONS.map((s) => [
      s,
      Object.fromEntries(Object.entries(b[s]).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))),
    ]),
  )
  return `${JSON.stringify(sorted, null, 2)}\n`
}

export function readBaseline(): Baseline {
  return JSON.parse(readFileSync(BASELINE_FILE, 'utf8')) as Baseline
}

/** 四部分的现状。 */
function measureAll(): { measured: Record<Section, Map<string, number>>; missing: string[] } {
  const central = measureCentralLists()
  const components = measureComponents()
  return {
    measured: {
      fileLines: measureFileLines(),
      centralLists: central.counts,
      componentStates: components.states,
      innerComponents: components.inner,
    },
    missing: central.missing,
  }
}

function main(mode: string | undefined): number {
  if (mode !== '--update' && mode !== '--init') {
    console.error('用法：bun run scripts/structure/baseline.ts --update | --init')
    return 2
  }
  const { measured, missing } = measureAll()
  if (missing.length > 0) {
    for (const line of missing) console.error(line)
    return 1
  }
  if (mode === '--init') {
    if (existsSync(BASELINE_FILE)) {
      console.error('基线已存在。--init 只用于首次建立，之后只能用 --update 下调或移除条目')
      return 1
    }
    const b = Object.fromEntries(SECTIONS.map((s) => [s, init(RULES[s], measured[s])])) as Baseline
    writeFileSync(BASELINE_FILE, serialize(b))
    for (const s of SECTIONS) console.log(`${s}：${Object.keys(b[s]).length} 条`)
    return 0
  }
  if (!existsSync(BASELINE_FILE)) {
    console.error('基线不存在。首次建立使用 --init')
    return 1
  }
  const current = readBaseline()
  const results = SECTIONS.map((s) => [s, update(RULES[s], measured[s], current[s])] as const)
  const refused = results.flatMap(([, r]) => r.refused)
  if (refused.length > 0) {
    console.error('以下条目需要上调或新增，--update 不处理，基线未修改：')
    for (const line of refused) console.error(`  ${line}`)
    return 1
  }
  const changes = results.flatMap(([, r]) => r.changes)
  if (changes.length === 0) {
    console.log('基线与现状一致，无需修改')
    return 0
  }
  writeFileSync(
    BASELINE_FILE,
    serialize(Object.fromEntries(results.map(([s, r]) => [s, r.next])) as Baseline),
  )
  for (const line of changes) console.log(line)
  return 0
}

if (import.meta.main) process.exit(main(process.argv[2]))
