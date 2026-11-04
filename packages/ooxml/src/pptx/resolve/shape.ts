/**
 * 形状求值：占位符继承、样式引用、组合坐标换算与组合填充，产出 `Shape`。
 *
 * - 幻灯片上的占位符依次继承匹配到的版式占位符与母版占位符（见 `placeholder.ts`）：`spPr` 的位置尺寸、几何、填充、效果
 *   取链上第一个出现的值，线条按字段逐层覆盖；`p:style` 取链上第一个；`bodyPr` 逐字段继承（见 `../../drawingml/text/resolve.ts`）。
 * - 文字的列表样式依次为：形状 `lstStyle`、`fontRef`、版式占位符与母版占位符的 `lstStyle`，最后一层按占位符类型选择：
 *   标题类取母版 `titleStyle`，正文类取母版 `bodyStyle`，其余占位符与非占位符形状取 `defaultTextStyle`。
 *   母版 `otherStyle` 只用于表格。WPS 实测：标题与正文占位符不回落到 `defaultTextStyle`，文本框与日期、页脚占位符
 *   不使用 `otherStyle`。
 * - 填充、线条、效果与组合坐标的求值规则见 `../../drawingml/shape/resolve.ts`；线条的各层 `ln` 为形状自身与继承来源。
 * - 组合填充（`grpFill`）取最近一级组合的填充；组合未指定填充时沿用上一级组合的填充，顶层为无填充。
 * - 图表：引用的图表部件按幻灯片的主题与颜色映射求值，有主题覆盖时颜色方案与主题字体取自主题覆盖；部件缺失或含不支持的内容时计入 `chart`。
 * - SmartArt：按幻灯片的主题与颜色映射求值（见 `../../drawingml/diagram/resolve.ts`）；数据部件缺失或含未实现的构造时
 *   计入 `smartArt`。
 * - 墨迹：见 `./ink.ts`；部件缺失或没有笔画时计入 `ink`。
 */

import { resolveChart } from '../../drawingml/chart/resolve.ts'
import { resolveDiagram } from '../../drawingml/diagram/resolve.ts'
import {
  type ImageFill,
  resolveFill,
  resolveImageFill,
  type ShapeFill,
} from '../../drawingml/fill.ts'
import type { Geometry } from '../../drawingml/geometry/model.ts'
import { EMPTY_PROPS, type ShapeProps, type StyleRefs } from '../../drawingml/shape/read.ts'
import {
  childTransform,
  countEffects,
  countImage,
  countText,
  EMPTY_XFRM,
  fontRefStyle,
  frameOf,
  IDENTITY_TRANSFORM,
  matrixFill,
  resolveShapeEffects,
  resolveShapeFill,
  resolveShapeLine,
  shapeThreeD,
  type Transform,
  unpaintedVertical,
} from '../../drawingml/shape/resolve.ts'
import type { TextBody } from '../../drawingml/text/model.ts'
import type { RawTextBody } from '../../drawingml/text/read.ts'
import { resolveTextBody } from '../../drawingml/text/resolve.ts'
import { resolveThreeD, visibleThreeD } from '../../drawingml/three/camera.ts'
import { hasUnsupportedMath } from '../../math/index.ts'
import type { Placeholder, Shape } from '../model.ts'
import type { RawPlaceholder, RawShape } from '../parse/shape.ts'
import type { BackgroundSpec } from '../parse/slide.ts'
import { resolveInk } from './ink.ts'
import { matchLayoutPlaceholder, matchMasterPlaceholder, textStyleKind } from './placeholder.ts'
import type { SlideScope } from './scope.ts'
import { resolveTable } from './table.ts'

const NONE: ShapeFill = { kind: 'none' }
const RECT: Geometry = { kind: 'preset', name: 'rect', adjust: [] }

function propsOf(s: RawShape): ShapeProps {
  if (s.kind === 'table' || s.kind === 'graphic' || s.kind === 'ink') {
    return { ...EMPTY_PROPS, xfrm: s.xfrm }
  }
  return s.props
}

function styleOf(s: RawShape): StyleRefs | null {
  return s.kind === 'shape' || s.kind === 'picture' || s.kind === 'connector' ? s.style : null
}

function first<T>(chain: readonly RawShape[], get: (p: ShapeProps) => T | null): T | null {
  for (const s of chain) {
    const v = get(propsOf(s))
    if (v !== null) return v
  }
  return null
}

function textOf(s: RawShape | null): RawTextBody | null {
  return s?.kind === 'shape' ? s.text : null
}

/** 部件不在包中时不登记格式：没有可绘制的内容。 */
function countPicture(image: ImageFill, scope: SlideScope): void {
  countImage(image.part === null ? null : scope.imageDrawable(image.part), scope.found)
  if (image.effects.some((e) => e.kind === 'other')) scope.found.push('imageEffect')
}

function countFill(fill: ShapeFill, scope: SlideScope): void {
  if (fill.kind === 'picture') countPicture(fill.image, scope)
}

function countBullet(part: string | null, scope: SlideScope): void {
  if (part !== null) countImage(scope.imageDrawable(part), scope.found)
}

/** 含未实现结构的公式不绘制，每个公式计一次。 */
function countMath(text: TextBody, scope: SlideScope): void {
  for (const p of text.paragraphs)
    for (const r of p.runs)
      if (r.kind === 'math' && r.zones.some(hasUnsupportedMath)) scope.found.push('math')
}

/**
 * 绘制端不实现的内容：无法解码的图片格式（含图片项目符号）、未实现的图片效果、竖排文字、未绘制的效果（见 `countEffects`）
 * 与含未实现结构的公式。
 */
function countUnpainted(shape: Shape, scope: SlideScope): void {
  switch (shape.kind) {
    case 'shape':
      countFill(shape.fill, scope)
      countEffects(shape.effects, scope.found, shape.threeD === null)
      if (shape.text !== null) {
        countText(
          shape.text,
          scope.found,
          (f) => countFill(f, scope),
          (part) => countBullet(part, scope),
        )
        countMath(shape.text, scope)
      }
      return
    case 'picture':
      countPicture(shape.image, scope)
      countFill(shape.fill, scope)
      countEffects(shape.effects, scope.found, shape.threeD === null)
      return
    case 'connector':
      countEffects(shape.effects, scope.found)
      return
    case 'group':
      // 组合不绘制内部阴影：组合的填充区域是全部后代的合成。
      countEffects(shape.effects, scope.found, true)
      if (shape.effects.some((e) => e.kind === 'innerShadow')) scope.found.push('effect')
      return
    case 'table':
      countFill(shape.fill, scope)
      for (const row of shape.rows) {
        for (const cell of row.cells) {
          if (cell.hMerge || cell.vMerge) continue
          countFill(cell.fill, scope)
          if (unpaintedVertical(cell.vertical)) scope.found.push('verticalText')
          countText(
            cell.text,
            scope.found,
            (f) => countFill(f, scope),
            (part) => countBullet(part, scope),
          )
          countMath(cell.text, scope)
        }
      }
      return
    case 'graphic':
    case 'chart':
    case 'diagram':
    case 'ink':
      return
  }
}

/** 背景：`bgRef` 取主题的背景填充样式，`bgPr` 为组合填充时按无填充。 */
export function resolveBackground(spec: BackgroundSpec, scope: SlideScope): ShapeFill {
  if (spec.kind === 'ref') return matrixFill(scope, spec.idx, spec.color)
  const fill = resolveFill(spec.fill, scope.colors)
  return fill.kind === 'group' ? NONE : fill
}

export class ShapeResolver {
  constructor(private readonly scope: SlideScope) {}

  /**
   * `origin` 为 `slide` 时解决占位符继承；母版与版式只传入非占位符形状。`t` 为所在组合的坐标变换，顶层形状为
   * `IDENTITY_TRANSFORM`。
   */
  resolve(raw: readonly RawShape[], origin: Shape['origin'], t = IDENTITY_TRANSFORM): Shape[] {
    return raw.map((s) => this.shape(s, origin, t, NONE))
  }

  private shape(raw: RawShape, origin: Shape['origin'], t: Transform, group: ShapeFill): Shape {
    const shape = this.build(raw, origin, t, group)
    countUnpainted(shape, this.scope)
    return shape
  }

  private build(raw: RawShape, origin: Shape['origin'], t: Transform, group: ShapeFill): Shape {
    const scope = this.scope
    scope.found.push(...raw.found)
    let layoutPh: RawShape | null = null
    let masterPh: RawShape | null = null
    if (origin === 'slide' && raw.placeholder !== null) {
      layoutPh = matchLayoutPlaceholder(raw.placeholder, scope.layout.shapes)
      masterPh = matchMasterPlaceholder(
        layoutPh?.placeholder ?? raw.placeholder,
        scope.master.shapes,
      )
    }
    const chain = [raw, layoutPh, masterPh].filter((s): s is RawShape => s !== null)
    const xfrm = first(chain, (p) => p.xfrm)
    const placeholder: Placeholder | null =
      raw.placeholder === null
        ? null
        : {
            type: raw.placeholder.type,
            idx: raw.placeholder.idx,
            layoutShape: layoutPh?.id ?? null,
            masterShape: masterPh?.id ?? null,
          }
    const common = {
      id: raw.id,
      name: raw.name,
      origin,
      hidden: raw.hidden,
      frame: frameOf(xfrm ?? EMPTY_XFRM, t),
      placeholder,
    }
    let style: StyleRefs | null = null
    for (const s of chain) style ??= styleOf(s)
    const geometry = first(chain, (p) => p.geometry)
    const fillSpec = first(chain, (p) => p.fill)
    const effectSpec = first(chain, (p) => p.effects)
    const lines = chain.map((s) => propsOf(s).line)
    const three = shapeThreeD(chain.map(propsOf), style, scope)

    switch (raw.kind) {
      case 'shape': {
        const text =
          raw.text === null
            ? null
            : this.text(raw.text, textStyleKind(raw.placeholder), layoutPh, masterPh, style)
        return {
          kind: 'shape',
          ...common,
          geometry: geometry ?? RECT,
          fill: resolveShapeFill(fillSpec, style, group, scope),
          line: resolveShapeLine(lines, style, scope),
          effects: resolveShapeEffects(effectSpec, style, scope),
          threeD: resolveThreeD(three.scene, three.shape, scope.found),
          textBox: raw.textBox,
          text,
        }
      }
      case 'picture':
        return {
          kind: 'picture',
          ...common,
          image: resolveImageFill(raw.image, scope.colors),
          geometry: geometry ?? RECT,
          fill: resolveShapeFill(fillSpec, style, group, scope),
          line: resolveShapeLine(lines, style, scope),
          effects: resolveShapeEffects(effectSpec, style, scope),
          threeD: resolveThreeD(three.scene, three.shape, scope.found),
        }
      case 'connector':
        if (visibleThreeD(three.scene, three.shape)) scope.found.push('effect3d')
        return {
          kind: 'connector',
          ...common,
          geometry: geometry ?? { kind: 'preset', name: 'line', adjust: [] },
          line: resolveShapeLine(lines, style, scope),
          effects: resolveShapeEffects(effectSpec, style, scope),
          start: raw.start,
          end: raw.end,
        }
      case 'group': {
        if (visibleThreeD(three.scene, three.shape)) scope.found.push('effect3d')
        const fill =
          raw.props.fill === null ? group : resolveShapeFill(raw.props.fill, null, group, scope)
        const inner = childTransform(raw.props.xfrm, t)
        return {
          kind: 'group',
          ...common,
          fill,
          effects: resolveShapeEffects(raw.props.effects, null, scope),
          children: raw.children.map((c) => this.shape(c, origin, inner, fill)),
        }
      }
      case 'table': {
        const table = resolveTable(raw.table, scope)
        return {
          kind: 'table',
          ...common,
          columns: raw.table.columns,
          rows: table.rows,
          styleId: table.styleId,
          flags: raw.table.flags,
          fill: table.fill,
        }
      }
      case 'graphic': {
        if (raw.diagram !== null) {
          const rawDiagram = scope.diagrams.get(raw.diagram.data)
          const diagram =
            rawDiagram === undefined
              ? null
              : resolveDiagram(rawDiagram, { theme: scope.theme, colors: scope.colors })
          if (diagram !== null) return { kind: 'diagram', ...common, diagram }
          scope.found.push('smartArt')
          return { kind: 'graphic', ...common, content: raw.content }
        }
        const part = raw.chart === null ? undefined : scope.charts.get(raw.chart)
        const chart =
          part === undefined
            ? null
            : resolveChart(part.raw, {
                theme: part.theme ?? scope.theme,
                colors:
                  part.theme === null
                    ? scope.colors
                    : { ...scope.colors, scheme: part.theme.colors },
                host: 'slide',
                cells: null,
              })
        if (chart !== null) return { kind: 'chart', ...common, chart }
        if (raw.chart !== null) scope.found.push('chart')
        return { kind: 'graphic', ...common, content: raw.content }
      }
      case 'ink': {
        const raws = raw.part === null ? undefined : scope.inks.get(raw.part)
        const strokes = raws === undefined ? [] : resolveInk(raws, common.frame)
        if (strokes.length === 0) scope.found.push('ink')
        return { kind: 'ink', ...common, strokes }
      }
    }
  }

  /**
   * 幻灯片上不是 DrawingML 形状的文字（.ppt 旧格式记录换算的文字规格）：按 `placeholder` 匹配版式与母版占位符（不是占位符时为
   * `null`），经与幻灯片形状的文字相同的继承链求值；母版文字样式的类别由调用方给出（.ppt 按文字类型）。
   */
  slideText(
    raw: RawTextBody,
    placeholder: RawPlaceholder | null,
    kind: 'title' | 'body' | 'other',
  ): TextBody {
    const layoutPh =
      placeholder === null ? null : matchLayoutPlaceholder(placeholder, this.scope.layout.shapes)
    const masterPh =
      placeholder === null
        ? null
        : matchMasterPlaceholder(layoutPh?.placeholder ?? placeholder, this.scope.master.shapes)
    let style: StyleRefs | null = null
    for (const ph of [layoutPh, masterPh]) if (ph !== null) style ??= styleOf(ph)
    return this.text(raw, kind, layoutPh, masterPh, style)
  }

  private text(
    raw: RawTextBody,
    kind: 'title' | 'body' | 'other',
    layoutPh: RawShape | null,
    masterPh: RawShape | null,
    style: StyleRefs | null,
  ): TextBody {
    const scope = this.scope
    const layoutText = textOf(layoutPh)
    const masterText = textOf(masterPh)
    const bodies = [layoutText?.body, masterText?.body].filter((b) => b !== undefined)
    return resolveTextBody(raw, {
      theme: scope.theme,
      colors: scope.colors,
      listStyles: [
        fontRefStyle(style?.font ?? null),
        layoutText?.listStyle ?? null,
        masterText?.listStyle ?? null,
        kind === 'other' ? scope.defaultTextStyle : (scope.master.textStyles?.[kind] ?? null),
      ],
      bodies,
    })
  }
}
