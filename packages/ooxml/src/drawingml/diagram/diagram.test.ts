/**
 * 覆盖 `read.ts`（部件引用、数据部件、布局定义、颜色与样式定义）、`resolve.ts`（按数据实例化布局、样式与颜色、
 * 文字默认格式、不绘制的情形）与 `layout.ts`（`lin` 缩放与截高、相邻平移、`composite` 定位、整磅字号适配与同组最小值、
 * `h` 规则、`conn` 箭头、反向时的边距方向）。
 *
 * 文字排版用按字计宽的测量函数代替（每字一个字号宽，行高 1.21 倍字号），只检验引擎的求值规则；与 WPS 的对照见 pptx 的对比基准。
 */

import { describe, expect, test } from 'bun:test'
import type { Relationships } from '../../opc/package.ts'
import { PartScanner } from '../../opc/scanner.ts'
import { colorToHex } from '../color.ts'
import type { ShapeFill } from '../fill.ts'
import { layoutDiagram, type PlacedShape, type TextMeasure } from './layout.ts'
import type { Diagram } from './model.ts'
import { readDiagram, readDiagramParts } from './read.ts'
import { collectDiagramFonts, resolveDiagram } from './resolve.ts'
import {
  A,
  CHEVRON,
  colorsXml,
  type DataOptions,
  DGM,
  dataXml,
  NO_RELS,
  PROCESS,
  R,
  SCOPE,
  STYLES,
} from './test-helper.ts'

function build(data: string, layout: string, colors = colorsXml()): Diagram | null {
  return resolveDiagram(
    readDiagram({ data, dataRels: NO_RELS, layout, style: STYLES, colors }),
    SCOPE,
  )
}

function diagram(data: string, layout: string, colors?: string): Diagram {
  const d = build(data, layout, colors)
  if (d === null) throw new Error('未绘制')
  return d
}

/** 每字一个字号宽、行高 1.21 倍字号、段间 0.35 倍行高；行宽不足一个字时为单词被断开。 */
const measure: TextMeasure = (text, width) => {
  let height = 0
  let broken = false
  text.paragraphs.forEach((p, i) => {
    const size = p.end.size
    const chars = p.runs.reduce((n, r) => n + (r.kind === 'text' ? [...r.text].length : 0), 0)
    const perLine = Math.floor(width / size + 1e-9)
    if (perLine < 1) broken = true
    if (i > 0) height += 0.35 * 1.21 * size
    height += Math.max(1, Math.ceil(chars / Math.max(1, perLine))) * 1.21 * size
  })
  return { height, broken }
}

function hex(fill: ShapeFill): string | null {
  return fill.kind === 'solid' ? colorToHex(fill.color) : null
}

function texts(shapes: readonly PlacedShape[]): PlacedShape[] {
  return shapes.filter((s) => s.text !== null)
}

const W = 8151495
const H = 660920
const FIVE = Array.from({ length: 5 }, () => ['国国国国国国国国'])

describe('读取', () => {
  test('部件引用按图形框所在部件的关系表解析，数据部件无效时为 null', () => {
    const rels: Relationships = {
      ...NO_RELS,
      byId: (id) =>
        id === 'rId9'
          ? null
          : {
              id,
              type: '',
              kind: '',
              target: id,
              external: false,
              part: `/ppt/diagrams/${id}.xml`,
            },
    }
    const parts = (attrs: string) => {
      const x = new PartScanner(`<dgm:relIds ${DGM} ${R} ${attrs}/>`)
      x.next()
      return readDiagramParts(x, rels)
    }
    expect(parts('r:dm="dm" r:lo="lo" r:qs="qs" r:cs="cs"')).toEqual({
      data: '/ppt/diagrams/dm.xml',
      layout: '/ppt/diagrams/lo.xml',
      style: '/ppt/diagrams/qs.xml',
      colors: '/ppt/diagrams/cs.xml',
    })
    expect(parts('r:dm="rId9" r:lo="lo"')).toBeNull()
  })

  test('数据部件：点的种类、文字、pres 点的属性、布局变量与 cust 属性，连接的顺序与转换点', () => {
    const raw = readDiagram({
      data: dataXml([['甲'], ['乙']], {
        node: 'node',
        trans: ['space'],
        cust: { 1: ' custLinFactNeighborX="-33636" custScaleX="136476"' },
      }),
      dataRels: NO_RELS,
      layout: null,
      style: null,
      colors: null,
    })
    const byId = new Map(raw.data.points.map((p) => [p.id, p]))
    expect(byId.get('doc')?.type).toBe('doc')
    expect(byId.get('n0')?.text?.paragraphs[0]?.runs[0]).toMatchObject({ kind: 'text', text: '甲' })
    expect(byId.get('root')?.vars).toEqual({ dir: '' })
    expect(byId.get('pn1')).toMatchObject({
      type: 'pres',
      presName: 'node',
      presAssoc: 'n1',
      styleLabel: 'node1',
      custom: { custLinFactNeighborX: -33636, custScaleX: 136476 },
    })
    expect(raw.data.connections[1]).toEqual({
      type: 'parOf',
      src: 'doc',
      dest: 'n1',
      srcOrd: 1,
      parTrans: 'p1',
      sibTrans: 's1',
    })
    expect(raw.layout).toBeNull()
    expect(raw.data.decorated).toBe(false)
  })

  test('布局定义：布局节点、算法参数、条件分支、遍历属性与约束规则的缺省值', () => {
    const raw = readDiagram({
      data: dataXml([], { node: 'node', trans: [] }),
      dataRels: NO_RELS,
      layout: CHEVRON(),
      style: STYLES,
      colors: colorsXml(),
    })
    const root = raw.layout
    if (root?.kind !== 'layoutNode') throw new Error('没有布局节点')
    expect(root.name).toBe('Name0')
    const choose = root.children.find((a) => a.kind === 'choose')
    expect(choose).toMatchObject({
      branches: [
        { condition: { func: 'var', arg: 'dir', op: 'equ', val: 'norm' } },
        { condition: null, children: [{ kind: 'alg', type: 'lin', params: { linDir: 'fromR' } }] },
      ],
    })
    const constraints = root.children.find((a) => a.kind === 'constraints')
    expect(constraints?.kind === 'constraints' ? constraints.list[1] : null).toEqual({
      type: 'h',
      for: 'des',
      forName: 'node',
      ptType: 'all',
      refType: 'none',
      refFor: 'self',
      refForName: '',
      refPtType: 'all',
      op: 'equ',
      val: null,
      fact: 1,
    })
    const each = root.children.find((a) => a.kind === 'forEach')
    if (each?.kind !== 'forEach') throw new Error('没有 forEach')
    expect(each.iteration).toEqual({
      axis: 'ch',
      ptType: 'node',
      start: 1,
      count: 0,
      step: 1,
      hideLastTrans: true,
    })
    const node = each.children[0]
    if (node?.kind !== 'layoutNode') throw new Error('没有节点')
    const rules = node.children.find((a) => a.kind === 'rules')
    expect(rules?.kind === 'rules' ? rules.list[0] : null).toMatchObject({
      type: 'primFontSz',
      val: 5,
    })
    expect(Number.isNaN(rules?.kind === 'rules' ? rules.list[0]?.fact : 0)).toBe(true)
    expect(Object.keys(raw.styles)).toEqual(['node1', 'sibTrans2D1'])
    expect(raw.colors.node1?.fill.colors).toHaveLength(1)
  })
})

describe('求值', () => {
  test('按 ch 轴实例化：节点与其后的 sibTrans 交替，最后一个 sibTrans 不实例化', () => {
    const d = diagram(dataXml(FIVE, { node: 'node', trans: ['space'] }), CHEVRON())
    expect(d.root.children.map((c) => c.name)).toEqual([
      'node',
      'space',
      'node',
      'space',
      'node',
      'space',
      'node',
      'space',
      'node',
    ])
    expect(d.root.algorithm).toEqual({ type: 'lin', params: {} })
  })

  test('样式：fillRef、lnRef 按颜色定义取色，文字颜色取 fontRef，字体取主题次要字体，段落居中', () => {
    const node = diagram(dataXml(FIVE, { node: 'node', trans: ['space'] }), CHEVRON()).root
      .children[0]!
    expect(hex(node.shape!.fill)).toBe('4472C4')
    expect(node.shape!.line?.width).toBe(12700)
    expect(hex(node.shape!.line!.fill)).toBe('FFFFFF')
    const p = node.text!.paragraphs[0]!
    expect(p.align).toBe('ctr')
    expect(p.spaceBefore).toEqual({ unit: 'percent', value: 0.35 })
    const run = p.runs[0]!
    expect(hex(run.style.fill)).toBe('FFFFFF')
    expect(run.style.latin).toBe('Minor')
    expect(run.style.ea).toBe('MinorEA')
    const fonts = new Set<string>()
    collectDiagramFonts(
      fonts,
      diagram(dataXml(FIVE, { node: 'node', trans: ['space'] }), CHEVRON()),
    )
    expect(fonts.has('MinorEA')).toBe(true)
  })

  test('颜色定义 repeat 按列表循环取色；数据点 spPr 覆盖样式', () => {
    const colors = colorsXml(
      '<dgm:fillClrLst meth="repeat"><a:srgbClr val="FF0000"/><a:srgbClr val="00FF00"/></dgm:fillClrLst>',
    )
    const d = diagram(
      dataXml(FIVE, {
        node: 'node',
        trans: ['space'],
        spPr: { 3: '<a:solidFill><a:srgbClr val="0000FF"/></a:solidFill><a:ln><a:noFill/></a:ln>' },
      }),
      CHEVRON(),
      colors,
    )
    const nodes = d.root.children.filter((c) => c.name === 'node')
    expect(nodes.map((n) => hex(n.shape!.fill))).toEqual([
      'FF0000',
      '00FF00',
      'FF0000',
      '0000FF',
      'FF0000',
    ])
    expect(nodes[3]!.shape!.line).toBeNull()
  })

  test('dir 为 rev 时取 else 分支：fromR 与旋转 180° 的形状', () => {
    const d = diagram(dataXml(FIVE, { node: 'node', trans: ['space'], rev: true }), CHEVRON())
    expect(d.root.algorithm.params).toEqual({ linDir: 'fromR' })
    expect(d.root.children[0]!.shape!.rotation).toBe(180)
    expect(d.root.children[0]!.text!.body.rotation).toBe(-180)
  })

  test('不绘制的情形返回 null', () => {
    const base = { node: 'node', trans: ['space'] }
    expect(build(dataXml(FIVE, { ...base, omitPres: true }), CHEVRON())).toBeNull()
    expect(build(dataXml(FIVE, { ...base, runProps: ' sz="1200"' }), CHEVRON())).toBeNull()
    expect(build(dataXml(FIVE, { ...base, cust: { 0: ' custSzX="100"' } }), CHEVRON())).toBeNull()
    expect(
      build(
        dataXml(FIVE, base),
        CHEVRON().replace('<dgm:alg type="tx"/>', '<dgm:alg type="snake"/>'),
      ),
    ).toBeNull()
    expect(
      build(
        dataXml(FIVE, base),
        CHEVRON().replace('<dgm:varLst>', '<dgm:unknownAtom/><dgm:varLst>'),
      ),
    ).toBeNull()
    expect(
      build(
        dataXml(FIVE, base),
        CHEVRON().replace('<dgm:presOf/>', '<dgm:presOf axis="ch" ptType="node"/>'),
      ),
    ).toBeNull()
    const span = colorsXml(
      '<dgm:fillClrLst meth="span"><a:srgbClr val="FF0000"/><a:srgbClr val="0000FF"/></dgm:fillClrLst>',
    )
    expect(build(dataXml(FIVE, base), CHEVRON(), span)).toBeNull()
    const decorated = dataXml(FIVE, base).replace(
      '<dgm:bg/>',
      '<dgm:bg><a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></dgm:bg>',
    )
    expect(build(decorated, CHEVRON())).toBeNull()
    expect(
      resolveDiagram(
        readDiagram({
          data: dataXml(FIVE, base),
          dataRels: NO_RELS,
          layout: null,
          style: null,
          colors: null,
        }),
        SCOPE,
      ),
    ).toBeNull()
  })
})

describe('排版', () => {
  const chevron = (o: Partial<DataOptions> = {}, items = FIVE) =>
    layoutDiagram(
      diagram(dataXml(items, { node: 'node', trans: ['space'], ...o }), CHEVRON()),
      W,
      H,
      measure,
    )

  test('lin：宽度按同一比例缩小到排满，高度按缩小后的宽度求值后截为框高，sp 的负宽度使相邻形状重叠', () => {
    const shapes = chevron()
    const w = W / 4.6
    expect(shapes).toHaveLength(5)
    shapes.forEach((s, i) => {
      expect(s.x).toBeCloseTo(i * 0.9 * w, 3)
      expect(s.width).toBeCloseTo(w, 3)
      expect(s.height).toBe(H)
      expect(s.y).toBe(0)
    })
  })

  test('字号取能排入的最大整磅，同组取最小值；边距按字号求值', () => {
    const shapes = chevron({}, [['国国'], ['国国国国国国国国'], ['国'], ['国国'], ['国国']])
    for (const s of shapes) {
      expect(s.text!.paragraphs[0]!.runs[0]!.style.size).toBe(19)
      expect(s.text!.body.insetLeft).toBe(Math.round(0.315 * 19 * 12700))
      expect(s.text!.body.insetTop).toBe(Math.round(0.105 * 19 * 12700))
    }
  })

  test('custLinFactNeighborX 使形状平移「系数 × 相邻 sp 的宽度」，custScaleX 不改变尺寸', () => {
    const shapes = chevron({ cust: { 2: ' custLinFactNeighborX="50000" custScaleX="150000"' } })
    const w = W / 4.6
    expect(shapes[2]!.x).toBeCloseTo(2 * 0.9 * w - 0.05 * w, 3)
    expect(shapes[2]!.width).toBeCloseTo(w, 3)
  })

  test('反向：形状从右向左排列，旋转 180° 时左右边距对调', () => {
    const shapes = chevron({ rev: true })
    const w = W / 4.6
    expect(shapes[0]!.x).toBeCloseTo(W - w, 3)
    expect(shapes[0]!.rotation).toBe(180)
    const body = shapes[0]!.text!.body
    expect(body.insetLeft).toBeLessThan(body.insetRight)
  })

  test('conn：箭头位于两节点之间，两端留 begPad 与 endPad，高度为间距的 0.62 倍', () => {
    const d = diagram(
      dataXml([['国国'], ['国国'], ['国国']], {
        node: 'node',
        trans: ['sibTrans', 'connectorText'],
      }),
      PROCESS,
    )
    const shapes = layoutDiagram(d, 5880735, 3000000, measure)
    const nodeW = 5880735 / 3.8
    const gap = 0.4 * nodeW
    const arrow = shapes.find(
      (s) => s.geometry.kind === 'preset' && s.geometry.name === 'rightArrow',
    )!
    expect(arrow.x).toBeCloseTo(nodeW + 0.25 * gap, 3)
    expect(arrow.width).toBeCloseTo(gap * 0.53, 3)
    expect(arrow.height).toBeCloseTo(gap * 0.62, 3)
    expect(arrow.y).toBeCloseTo((3000000 - gap * 0.62) / 2, 3)
    expect(hex(arrow.fill)).toBe('ED7D31')
    expect(
      shapes.filter((s) => s.geometry.kind === 'preset' && s.geometry.name === 'rect'),
    ).toHaveLength(3)
  })

  test('h 规则：字号降到 18 磅仍排不入时，节点高度增加到能排入的最小值，同组取最大值并重新居中', () => {
    const items = [['国'.repeat(20)], ['国国'], ['国国']]
    const d = diagram(
      dataXml(items, { node: 'node', trans: ['sibTrans', 'connectorText'] }),
      PROCESS,
    )
    const nodes = texts(layoutDiagram(d, 5880735, 3000000, measure))
    const nodeW = 5880735 / 3.8
    // 18 磅时每行 6 字，20 字 4 行：4 × 1.21 × 18 + 上下边距 2 × 0.3 × 18。
    const needed = (4 * 1.21 * 18 + 0.6 * 18) * 12700
    expect(needed).toBeGreaterThan(0.6 * nodeW)
    expect(needed).toBeLessThan(0.9 * nodeW)
    for (const n of nodes) {
      expect(n.text!.paragraphs[0]!.runs[0]!.style.size).toBe(18)
      expect(n.height).toBeCloseTo(needed, 0)
      expect(n.y).toBeCloseTo((3000000 - needed) / 2, 0)
    }
  })

  test('h 规则受父节点框高限制：高度无法增加时继续按下一条规则缩小字号', () => {
    const items = [['国'.repeat(20)], ['国国'], ['国国']]
    const d = diagram(
      dataXml(items, { node: 'node', trans: ['sibTrans', 'connectorText'] }),
      PROCESS,
    )
    const nodes = texts(layoutDiagram(d, 5880735, 521970, measure))
    for (const n of nodes) {
      expect(n.height).toBe(521970)
      expect(n.text!.paragraphs[0]!.runs[0]!.style.size).toBeLessThan(18)
    }
  })

  test('没有测量函数时不适配字号', () => {
    const d = diagram(dataXml(FIVE, { node: 'node', trans: ['space'] }), CHEVRON())
    const shapes = layoutDiagram(d, W, H, null)
    expect(shapes[0]!.text!.paragraphs[0]!.runs[0]!.style.size).toBe(65)
  })
})

describe('composite', () => {
  test('子节点按 l、t、w、h 或 ctrX、ctrY 相对复合节点的框定位；以父节点宽度为参照的高度不随 lin 缩小', () => {
    const layout =
      `<dgm:layoutDef ${DGM} ${A} uniqueId="urn:l"><dgm:layoutNode name="Name0"><dgm:alg type="lin"/>` +
      '<dgm:shape><dgm:adjLst/></dgm:shape><dgm:presOf/><dgm:constrLst>' +
      '<dgm:constr type="w" for="ch" forName="node" refType="w"/>' +
      '<dgm:constr type="h" for="ch" forName="node" refType="w" fact="0.1"/></dgm:constrLst><dgm:ruleLst/>' +
      '<dgm:forEach name="a" axis="ch" ptType="node"><dgm:layoutNode name="node"><dgm:alg type="composite"/>' +
      '<dgm:shape><dgm:adjLst/></dgm:shape><dgm:presOf/><dgm:constrLst>' +
      '<dgm:constr type="l" for="ch" forName="txt" refType="w" fact="0.2"/>' +
      '<dgm:constr type="t" for="ch" forName="txt" refType="h" fact="0.5"/>' +
      '<dgm:constr type="w" for="ch" forName="txt" refType="w" fact="0.5"/>' +
      '<dgm:constr type="h" for="ch" forName="txt" refType="h" fact="0.4"/>' +
      '<dgm:constr type="ctrX" for="ch" forName="dot" refType="w" fact="0.5"/>' +
      '<dgm:constr type="ctrY" for="ch" forName="dot" refType="h" fact="0.25"/>' +
      '<dgm:constr type="w" for="ch" forName="dot" refType="h" fact="0.2"/>' +
      '<dgm:constr type="h" for="ch" forName="dot" refType="h" fact="0.2"/></dgm:constrLst><dgm:ruleLst/>' +
      '<dgm:layoutNode name="txt" styleLbl="node1"><dgm:alg type="tx"/><dgm:shape type="rect"><dgm:adjLst/></dgm:shape>' +
      '<dgm:presOf axis="self" ptType="node"/><dgm:constrLst/><dgm:ruleLst/></dgm:layoutNode>' +
      '<dgm:layoutNode name="dot" styleLbl="node1"><dgm:alg type="tx"/><dgm:shape type="ellipse"><dgm:adjLst/>' +
      '</dgm:shape><dgm:presOf/><dgm:constrLst/><dgm:ruleLst/></dgm:layoutNode></dgm:layoutNode></dgm:forEach>' +
      '</dgm:layoutNode></dgm:layoutDef>'
    const data = dataXml([['国'], ['国']], { node: 'txt', trans: [] }).replace(
      /<dgm:pt modelId="pn(\d)"[\s\S]*?<\/dgm:pt>/g,
      (m, i) =>
        m +
        m.replaceAll(`pn${i}`, `pd${i}`).replace('presName="txt"', 'presName="dot"') +
        m.replaceAll(`pn${i}`, `pc${i}`).replace('presName="txt"', 'presName="node"'),
    )
    const shapes = layoutDiagram(diagram(data, layout), 1000000, 400000, measure)
    const [txt, dot] = shapes
    const w = 500000
    const h = 100000
    expect(txt).toMatchObject({ x: 0.2 * w, width: 0.5 * w })
    expect(txt!.y).toBeCloseTo(150000 + 0.5 * h, 3)
    expect(txt!.height).toBeCloseTo(0.4 * h, 3)
    expect(dot!.geometry).toEqual({ kind: 'preset', name: 'ellipse', adjust: [] })
    expect(dot!.x).toBeCloseTo(0.5 * w - 0.1 * h, 3)
    expect(dot!.y).toBeCloseTo(150000 + 0.25 * h - 0.1 * h, 3)
    expect(shapes[2]!.x).toBeCloseTo(w + 0.2 * w, 3)
  })
})
