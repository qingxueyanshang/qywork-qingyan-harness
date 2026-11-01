/**
 * 文字样式链：把 `RawTextBody` 解决为每个段落与字段都带完整属性的 `TextBody`。
 *
 * - 段落属性按「段落 `pPr` → 各列表样式中同一层级的 `lvlNpPr`」取第一个出现的值，不跨层级回落；
 *   列表样式的顺序由调用方给出（`TextScope.listStyles`）。
 * - 字段属性按「字段 `rPr` → 段落 `pPr` 的 `defRPr` → 各列表样式同一层级的 `defRPr`」取值；段落结束符同理。
 * - `bodyPr` 的边距只取形状自身的值，其余属性逐字段继承：WPS 不从版式与母版占位符继承 `lIns`、`tIns`、`rIns`、`bIns`，
 *   而方向、换行、锚定、自动调整照常继承（实测）。
 * - 主题字体名（`+mj-lt`、`+mn-ea` 等）换算为主题字体方案中的字体名。东亚字体为空串时按字段的 `lang`、`altLang`
 *   中第一个东亚语言取按文种的字体（`zh-CN` → `Hans` 等），仍没有时为空串。
 * - 链上都未指定的西文字体为 Arial，东亚、复杂文种与符号字体为空串。
 * - 项目符号只在段落有非空文字时显示；编号在同一层级连续的编号段落之间递增，遇到更浅层级的段落或同层级的非编号段落时重新开始，
 *   空段落不影响编号。
 */

import type { ColorContext } from '../color.ts'
import { resolveColor } from '../color.ts'
import { resolveEffects, resolveFill, resolveLine, type ShapeFill } from '../fill.ts'
import type { FontCollection, Theme } from '../theme.ts'
import type {
  BodyProperties,
  Bullet,
  Paragraph,
  Run,
  RunStyle,
  Spacing,
  TextBody,
} from './model.ts'
import type {
  BodySpec,
  ListStyleSpec,
  ParagraphSpec,
  RawParagraph,
  RawTextBody,
  RunSpec,
} from './read.ts'

export interface TextScope {
  readonly theme: Theme
  readonly colors: ColorContext
  /** 形状自身 `lstStyle` 之后的列表样式，按优先级从高到低；`null` 项跳过。 */
  readonly listStyles: readonly (ListStyleSpec | null)[]
  /** 形状自身 `bodyPr` 之后的继承来源，按优先级从高到低，边距之外的字段取第一个出现的值。 */
  readonly bodies: readonly BodySpec[]
}

const BLACK_FILL: ShapeFill = { kind: 'solid', color: { r: 0, g: 0, b: 0, a: 1 } }
/** 链上都未指定西文字体时 WPS 显示的字体（实测）。 */
const DEFAULT_LATIN = 'Arial'

const EAST_ASIAN_SCRIPTS: readonly [RegExp, string][] = [
  [/^zh-(TW|HK|MO)$/i, 'Hant'],
  [/^zh(-|$)/i, 'Hans'],
  [/^ja(-|$)/i, 'Jpan'],
  [/^ko(-|$)/i, 'Hang'],
]

function pick<T, K extends keyof T>(chain: readonly T[], key: K): T[K] | undefined {
  for (const item of chain) {
    const v = item[key]
    if (v !== undefined) return v
  }
  return undefined
}

function eastAsianScript(langs: readonly (string | undefined)[]): string | null {
  for (const lang of langs) {
    if (lang === undefined) continue
    for (const [re, script] of EAST_ASIAN_SCRIPTS) if (re.test(lang)) return script
  }
  return null
}

/** 主题字体引用换算为字体名；不是主题字体引用时原样返回。 */
export function themeFont(
  theme: Theme,
  typeface: string,
  langs: readonly (string | undefined)[],
): string {
  const m = /^\+(mj|mn)-(lt|ea|cs)$/.exec(typeface)
  if (m === null) return typeface
  const fonts: FontCollection = m[1] === 'mj' ? theme.fonts.major : theme.fonts.minor
  if (m[2] === 'lt') return fonts.latin
  if (m[2] === 'cs') return fonts.cs
  if (fonts.ea !== '') return fonts.ea
  const script = eastAsianScript(langs)
  return script === null ? '' : (fonts.scripts.get(script) ?? '')
}

function resolveBody(own: BodySpec, inherited: readonly BodySpec[]): BodyProperties {
  const bodies = [own, ...inherited]
  return {
    rotation: pick(bodies, 'rotation') ?? 0,
    vertical: pick(bodies, 'vertical') ?? 'horz',
    wrap: pick(bodies, 'wrap') ?? true,
    insetLeft: own.insetLeft ?? 91440,
    insetTop: own.insetTop ?? 45720,
    insetRight: own.insetRight ?? 91440,
    insetBottom: own.insetBottom ?? 45720,
    anchor: pick(bodies, 'anchor') ?? 't',
    anchorCenter: pick(bodies, 'anchorCenter') ?? false,
    columns: pick(bodies, 'columns') ?? 1,
    columnSpacing: pick(bodies, 'columnSpacing') ?? 0,
    rtlColumns: pick(bodies, 'rtlColumns') ?? false,
    upright: pick(bodies, 'upright') ?? false,
    autofit: pick(bodies, 'autofit') ?? { kind: 'none' },
  }
}

function paragraphChain(p: RawParagraph, listStyles: TextScope['listStyles']): ParagraphSpec[] {
  const out: ParagraphSpec[] = [p.props]
  for (const ls of listStyles) {
    if (ls === null) continue
    const level = ls.levels[p.level]
    if (level !== null && level !== undefined) out.push(level)
  }
  return out
}

function resolveRun(chain: readonly RunSpec[], scope: TextScope): RunStyle {
  const lang = pick(chain, 'lang')
  const langs = [lang, pick(chain, 'altLang')]
  const font = (key: 'latin' | 'ea' | 'cs' | 'sym') => {
    const v = pick(chain, key)
    if (v === undefined) return key === 'latin' ? DEFAULT_LATIN : ''
    return themeFont(scope.theme, v, langs)
  }
  const fillSpec = pick(chain, 'fill')
  const fill = fillSpec === undefined ? BLACK_FILL : resolveFill(fillSpec, scope.colors)
  const highlight = pick(chain, 'highlight')
  const outline = pick(chain, 'outline')
  return {
    latin: font('latin'),
    ea: font('ea'),
    cs: font('cs'),
    sym: font('sym'),
    size: pick(chain, 'size') ?? 18,
    bold: pick(chain, 'bold') ?? false,
    italic: pick(chain, 'italic') ?? false,
    underline: pick(chain, 'underline') ?? 'none',
    strike: pick(chain, 'strike') ?? 'noStrike',
    baseline: pick(chain, 'baseline') ?? 0,
    caps: pick(chain, 'caps') ?? 'none',
    spacing: pick(chain, 'spacing') ?? 0,
    kern: pick(chain, 'kern') ?? 0,
    fill: fill.kind === 'group' ? { kind: 'none' } : fill,
    highlight:
      highlight === undefined || highlight === null ? null : resolveColor(highlight, scope.colors),
    outline: outline === undefined ? null : resolveLine(outline, scope.colors),
    effects: resolveEffects(pick(chain, 'effects') ?? [], scope.colors),
    lang: lang ?? '',
  }
}

function sizeOf(spec: Spacing | null | undefined, text: RunStyle): number {
  if (spec === undefined || spec === null) return text.size
  return spec.unit === 'points' ? spec.value : text.size * spec.value
}

function resolveBullet(
  chain: readonly ParagraphSpec[],
  first: RunStyle,
  number: number,
  scope: TextScope,
): Bullet {
  const bullet = pick(chain, 'bullet') ?? { kind: 'none' }
  const size = sizeOf(pick(chain, 'bulletSize'), first)
  if (bullet.kind === 'none') return bullet
  if (bullet.kind === 'picture') return { kind: 'picture', part: bullet.part, size }
  const fontSpec = pick(chain, 'bulletFont')
  const font =
    fontSpec === undefined || fontSpec === null
      ? first.latin
      : themeFont(scope.theme, fontSpec, [first.lang])
  const colorSpec = pick(chain, 'bulletColor')
  const resolved =
    colorSpec === undefined || colorSpec === null ? null : resolveColor(colorSpec, scope.colors)
  const color: ShapeFill = resolved === null ? first.fill : { kind: 'solid', color: resolved }
  if (bullet.kind === 'char') return { kind: 'char', char: bullet.char, font, color, size }
  return { kind: 'number', scheme: bullet.scheme, number, font, color, size }
}

function hasText(p: RawParagraph): boolean {
  return p.runs.some((r) => r.kind !== 'break' && r.text !== '')
}

export function resolveTextBody(raw: RawTextBody, scope: TextScope): TextBody {
  const listStyles =
    raw.listStyle === null ? scope.listStyles : [raw.listStyle, ...scope.listStyles]
  const counters = new Map<number, { scheme: string; next: number }>()
  const paragraphs: Paragraph[] = []
  for (const p of raw.paragraphs) {
    const chain = paragraphChain(p, listStyles)
    const runChain = (spec: RunSpec | null): RunSpec[] => {
      const out: RunSpec[] = spec === null ? [] : [spec]
      for (const c of chain) if (c.run !== undefined) out.push(c.run)
      return out
    }
    const runs: Run[] = p.runs.map((r) => {
      const style = resolveRun(runChain(r.props), scope)
      if (r.kind === 'break') return { kind: 'break', style }
      if (r.kind === 'field')
        return { kind: 'field', field: r.type, text: r.text, style, link: r.link }
      return { kind: 'text', text: r.text, style, link: r.link }
    })
    const end = resolveRun(runChain(p.end), scope)
    const first = runs.find((r) => r.kind !== 'break')?.style ?? end
    let number = 0
    let bullet: Bullet = { kind: 'none' }
    if (hasText(p)) {
      for (const level of counters.keys()) if (level > p.level) counters.delete(level)
      const spec = pick(chain, 'bullet')
      if (spec?.kind === 'number') {
        const previous = counters.get(p.level)
        number =
          previous !== undefined && previous.scheme === spec.scheme ? previous.next : spec.startAt
        counters.set(p.level, { scheme: spec.scheme, next: number + 1 })
      } else {
        counters.delete(p.level)
      }
      bullet = resolveBullet(chain, first, number, scope)
    }
    paragraphs.push({
      level: p.level,
      align: pick(chain, 'align') ?? 'l',
      marginLeft: pick(chain, 'marginLeft') ?? 0,
      marginRight: pick(chain, 'marginRight') ?? 0,
      indent: pick(chain, 'indent') ?? 0,
      rtl: pick(chain, 'rtl') ?? false,
      defaultTabSize: pick(chain, 'defaultTabSize') ?? 914400,
      tabs: pick(chain, 'tabs') ?? [],
      lineSpacing: pick(chain, 'lineSpacing') ?? { unit: 'percent', value: 1 },
      spaceBefore: pick(chain, 'spaceBefore') ?? { unit: 'points', value: 0 },
      spaceAfter: pick(chain, 'spaceAfter') ?? { unit: 'points', value: 0 },
      eaLineBreak: pick(chain, 'eaLineBreak') ?? true,
      latinLineBreak: pick(chain, 'latinLineBreak') ?? false,
      hangingPunctuation: pick(chain, 'hangingPunctuation') ?? false,
      fontAlign: pick(chain, 'fontAlign') ?? 'auto',
      bullet,
      runs,
      end,
    })
  }
  return { body: resolveBody(raw.body, scope.bodies), paragraphs }
}
