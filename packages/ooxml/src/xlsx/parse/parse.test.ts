/**
 * 覆盖：`workbook.ts`（部件定位、工作表顺序与可见性、未实现内容计数、失败分类）、`styles.ts`（字体、主题字体、填充、边框、
 * 对齐、数字格式、差异样式、「常规」样式、索引色覆盖）、`color.ts`（主题色编号、tint、索引色）、
 * `shared-strings.ts`（富文本、注音、`_xHHHH_` 转义）、`worksheet.ts`（各单元格类型、没有值与样式的单元格、公式缓存值与共享公式、
 * 行列、合并、冻结窗格、网格线、条件格式、自动筛选）、`drawing.ts`（图片锚点与裁剪、锚点序号、形状的几何与样式引用、
 * 组合坐标换算、形状文字与字体名、形状文字的默认字号与字体、隐藏对象、图表与未绘制内容的计数）、
 * `refs.ts`（引用解析与共享公式平移）。
 */

import { describe, expect, test } from 'bun:test'
import { colorToHex } from '../../drawingml/color.ts'
import type { ShapeFill } from '../../drawingml/fill.ts'
import { placeableWmf, RED_RECT_WMF } from '../../drawingml/paint/test-helper.ts'
import { MISSING_LATIN } from '../../drawingml/text/fonts.ts'
import type { Workbook, Worksheet } from '../model.ts'
import { applyTint, DEFAULT_PALETTE } from './color.ts'
import { parseCellRef, parseRange, shiftFormula } from './refs.ts'
import { parseStyles } from './styles.ts'
import { parseXlsx } from './workbook.ts'

const encoder = new TextEncoder()

/** 不压缩的 ZIP，成员按给出的顺序写入。 */
function buildZip(members: Record<string, string | Uint8Array>): Uint8Array<ArrayBuffer> {
  const locals: Uint8Array[] = []
  const centrals: Uint8Array[] = []
  let offset = 0
  for (const [name, content] of Object.entries(members)) {
    const nameBytes = encoder.encode(name)
    const data = typeof content === 'string' ? encoder.encode(content) : content
    const crc = Bun.hash.crc32(data)
    const local = new Uint8Array(30 + nameBytes.length + data.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true)
    lv.setUint16(4, 20, true)
    lv.setUint16(6, 0x800, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, data.length, true)
    lv.setUint32(22, data.length, true)
    lv.setUint16(26, nameBytes.length, true)
    local.set(nameBytes, 30)
    local.set(data, 30 + nameBytes.length)
    const central = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(central.buffer)
    cv.setUint32(0, 0x02014b50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0x800, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, data.length, true)
    cv.setUint32(24, data.length, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint32(42, offset, true)
    central.set(nameBytes, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const size = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, centrals.length, true)
  ev.setUint16(10, centrals.length, true)
  ev.setUint32(12, size, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + size + 22)
  let p = 0
  for (const chunk of [...locals, ...centrals, end]) {
    out.set(chunk, p)
    p += chunk.length
  }
  return out
}

const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const rel = (id: string, type: string, target: string) =>
  `<Relationship Id="${id}" Type="${R}/${type}" Target="${target}"/>`
const rels = (...items: string[]) =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`

const CONTENT_TYPES = `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="png" ContentType="image/png"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`

const THEME = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="t"><a:themeElements>
<a:clrScheme name="c"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1>
<a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink>
<a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme>
<a:fontScheme name="f"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线"/></a:minorFont></a:fontScheme>
</a:themeElements></a:theme>`

const STYLES = `<styleSheet xmlns="${NS}">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0&quot;件&quot;"/></numFmts>
<fonts count="3">
  <font><sz val="11"/><color theme="1"/><name val="宋体"/></font>
  <font><b/><i val="0"/><u/><sz val="14"/><color theme="4" tint="0.39997558519241921"/><name val="Arial"/></font>
  <font><strike/><sz val="9"/><color indexed="10"/><name val="Calibri"/><vertAlign val="superscript"/></font>
</fonts>
<fills count="4">
  <fill><patternFill patternType="none"/></fill>
  <fill><patternFill patternType="gray125"/></fill>
  <fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>
  <fill><patternFill patternType="lightGray"><fgColor indexed="2"/><bgColor theme="0" tint="-0.5"/></patternFill></fill>
</fills>
<borders count="2">
  <border><left/><right/><top/><bottom/><diagonal/></border>
  <border diagonalUp="1"><left style="thin"><color auto="1"/></left><right style="medium"><color rgb="FFFF0000"/></right>
    <top style="dashed"/><bottom style="double"><color theme="4"/></bottom><diagonal style="hair"/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
  <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
  <xf numFmtId="164" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1"><alignment horizontal="center" vertical="top" wrapText="1" textRotation="45" indent="2"/></xf>
  <xf numFmtId="14" fontId="2" fillId="3" borderId="0" xfId="0"/>
  <xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0"><alignment shrinkToFit="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="1"><dxf><font><b/><color rgb="FF9C0006"/></font><fill><patternFill><bgColor rgb="FFFFC7CE"/></patternFill></fill></dxf></dxfs>
<colors><indexedColors><rgbColor rgb="FF010203"/><rgbColor rgb="FF111111"/><rgbColor rgb="FF222222"/></indexedColors></colors>
</styleSheet>`

const SST = `<sst xmlns="${NS}" count="3" uniqueCount="3">
<si><t>甲</t></si>
<si><r><t xml:space="preserve">普通 </t></r><r><rPr><b/><sz val="12"/><color rgb="FFFF0000"/><rFont val="黑体"/></rPr><t>加粗</t></r><rPh sb="0" eb="1"><t>ジャ</t></rPh></si>
<si><t>行一_x000D_行二</t></si>
</sst>`

const SHEET1 = `<worksheet xmlns="${NS}" xmlns:r="${R}">
<sheetPr><tabColor rgb="FFFF0000"/></sheetPr>
<sheetViews><sheetView showGridLines="0" zoomScale="85" defaultGridColor="1" colorId="1" workbookViewId="0"><pane xSplit="1" ySplit="2" topLeftCell="C5" activePane="bottomRight" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="13.5" baseColWidth="10" customHeight="1"/>
<cols><col min="1" max="2" width="12.5" customWidth="1"/><col min="4" max="4" width="9" hidden="1" style="3"/></cols>
<sheetData>
  <row r="1" ht="30" customHeight="1">
    <c r="A1" t="s"><v>0</v></c><c r="B1" s="1"><v>12.25</v></c><c r="C1" t="b"><v>1</v></c>
    <c r="D1" t="e"><v>#DIV/0!</v></c><c r="E1" t="str"><f>A1&amp;""</f><v>甲</v></c>
    <c r="F1" t="inlineStr"><is><t>内联</t></is></c><c r="G1" t="d"><v>2024-10-18T12:00:00</v></c>
  </row>
  <row r="2" hidden="1"><c r="A2" s="2"><f>SUM(B1:B3)</f></c><c r="B2" t="s"><v>1</v></c><c r="C2" t="s"><v>2</v></c></row>
  <row r="3" ht="20" s="3" customFormat="1">
    <c r="A3"><f t="shared" ref="A3:A5" si="0">B3*2+$C$1</f><v>4</v></c><c r="B3"><v>2</v></c>
  </row>
  <row r="4"><c r="A4"><f t="shared" si="0"/></c><c s="2"/></row>
  <row r="6"><c r="A6" t="str"><f>""</f><v></v></c><c r="B6"><f>NOW()</f><v></v></c></row>
</sheetData>
<autoFilter ref="A1:G4"/>
<mergeCells count="1"><mergeCell ref="B5:D6"/></mergeCells>
<conditionalFormatting sqref="B1:B3 D1"><cfRule type="cellIs" dxfId="0" priority="2" operator="greaterThan"><formula>$C$1*10</formula></cfRule>
<cfRule type="expression" dxfId="0" priority="1" stopIfTrue="1"><formula>INDIRECT("A1")</formula></cfRule></conditionalFormatting>
<conditionalFormatting sqref="A1:A10"><cfRule type="colorScale" priority="3"><colorScale><cfvo type="min"/><cfvo type="max"/><color rgb="FFF8696B"/><color theme="4"/></colorScale></cfRule></conditionalFormatting>
<drawing r:id="rId1"/>
<extLst><ext uri="{05C60535-1F16-4fd2-B633-F4F36F0B64E0}"><x14:sparklineGroups xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:sparklineGroup><x14:sparklines><x14:sparkline><xm:f xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">S!A1:B1</xm:f></x14:sparkline></x14:sparklines></x14:sparklineGroup></x14:sparklineGroups></ext>
<ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}" xmlns:x14="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main"><x14:conditionalFormattings><x14:conditionalFormatting xmlns:xm="http://schemas.microsoft.com/office/excel/2006/main">
<x14:cfRule type="expression" priority="4" id="{1}"><xm:f>$B$1&gt;隐藏!$A$1</xm:f><x14:dxf><font><b/></font><fill><patternFill><bgColor rgb="FFEBF1DF"/></patternFill></fill></x14:dxf></x14:cfRule>
<x14:cfRule type="dataBar" id="{2}"><x14:dataBar><x14:cfvo type="autoMin"/><x14:cfvo type="num"><xm:f>5</xm:f></x14:cfvo></x14:dataBar></x14:cfRule>
<xm:sqref>C1:C2</xm:sqref></x14:conditionalFormatting></x14:conditionalFormattings></ext></extLst>
</worksheet>`

const DRAWING = `<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>1</xdr:col><xdr:colOff>9525</xdr:colOff><xdr:row>2</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:to><xdr:col>3</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>5</xdr:row><xdr:rowOff>19050</xdr:rowOff></xdr:to>
<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="图片 1"/><xdr:cNvPicPr/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/><a:srcRect l="10000" b="25000"/><a:stretch/></xdr:blipFill><xdr:spPr/></xdr:pic><xdr:clientData/></xdr:twoCellAnchor>
<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:ext cx="952500" cy="476250"/>
<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="3" name="图表 1"/></xdr:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>
<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="10" cy="10"/><xdr:grpSp><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="4" name="矩形"/></xdr:nvSpPr></xdr:sp>
<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="5" name="组内图片"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic>
<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="6" name="隐藏" hidden="1"/></xdr:nvSpPr></xdr:sp></xdr:grpSp><xdr:clientData/></xdr:absoluteAnchor>
<mc:AlternateContent><mc:Choice Requires="a14"><xdr:twoCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from><xdr:to><xdr:col>1</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>1</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:to><xdr:sp><xdr:nvSpPr><xdr:cNvPr id="7" name="控件"/></xdr:nvSpPr></xdr:sp><xdr:clientData/></xdr:twoCellAnchor></mc:Choice></mc:AlternateContent>
</xdr:wsDr>`

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

/** 以 Verdana 字体绘制「A」的 WMF。 */
const TEXT_WMF = placeableWmf([
  [0x02fb, -20 & 0xffff, 0, 0, 0, 400, 0, 0, 0, 0, 0x6556, 0x6472, 0x6e61, 0x0061],
  [0x012d, 0],
  [0x0a32, 0, 20, 1, 0, 0x41, 12],
])

function workbookPackage(
  overrides: Record<string, string | Uint8Array> = {},
): Uint8Array<ArrayBuffer> {
  return buildZip({
    '[Content_Types].xml': CONTENT_TYPES,
    '_rels/.rels': rels(rel('rId1', 'officeDocument', 'xl/workbook.xml')),
    'xl/workbook.xml': `<workbook xmlns="${NS}" xmlns:r="${R}"><workbookPr date1904="0"/><bookViews><workbookView activeTab="1"/></bookViews>
<sheets><sheet name="数据" sheetId="1" r:id="rId1"/><sheet name="图表" sheetId="2" r:id="rId5"/><sheet name="隐藏" sheetId="3" state="hidden" r:id="rId2"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': rels(
      rel('rId1', 'worksheet', 'worksheets/sheet1.xml'),
      rel('rId2', 'worksheet', 'worksheets/sheet2.xml'),
      rel('rId5', 'chartsheet', 'chartsheets/sheet1.xml'),
      rel('rId3', 'styles', 'styles.xml'),
      rel('rId4', 'sharedStrings', 'sharedStrings.xml'),
      rel('rId6', 'theme', 'theme/theme1.xml'),
    ),
    'xl/theme/theme1.xml': THEME,
    'xl/styles.xml': STYLES,
    'xl/sharedStrings.xml': SST,
    'xl/worksheets/sheet1.xml': SHEET1,
    'xl/worksheets/_rels/sheet1.xml.rels': rels(
      rel('rId1', 'drawing', '../drawings/drawing1.xml'),
      rel('rId2', 'comments', '../comments1.xml'),
      rel('rId3', 'table', '../tables/table1.xml'),
      rel('rId4', 'ctrlProp', '../ctrlProps/ctrlProp1.xml'),
    ),
    'xl/comments1.xml': `<comments xmlns="${NS}"><authors><author>a</author></authors><commentList><comment ref="A1" authorId="0"><text><t>x</t></text></comment><comment ref="B1" authorId="0"><text><t>y</t></text></comment></commentList></comments>`,
    'xl/drawings/drawing1.xml': DRAWING,
    'xl/drawings/_rels/drawing1.xml.rels': rels(rel('rId1', 'image', '../media/image1.png')),
    'xl/media/image1.png': PNG,
    'xl/worksheets/sheet2.xml': `<worksheet xmlns="${NS}"><sheetData/></worksheet>`,
    ...overrides,
  })
}

/** 第 `index` 个页面，须为工作表。 */
function worksheetAt(wb: Workbook, index: number): Worksheet {
  const s = wb.sheets[index]
  if (s?.kind !== 'worksheet') throw new Error(`第 ${index} 个页面不是工作表`)
  return s
}

async function parsed(overrides: Record<string, string> = {}): Promise<Workbook> {
  const r = await parseXlsx(workbookPackage(overrides))
  if (!r.ok) throw new Error(JSON.stringify(r.failure))
  return r.value
}

const CHART_NS = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const CHART_FRAME =
  '<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="图表 1"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>' +
  '<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic>' +
  `<a:graphicData uri="${CHART_NS}"><c:chart xmlns:c="${CHART_NS}" r:id="rId1"/></a:graphicData></a:graphic></xdr:graphicFrame>`
/** 柱形图：值取「数据」B1，缓存值为 1。 */
const BAR_CHART =
  `<c:chartSpace xmlns:c="${CHART_NS}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart><c:plotArea><c:layout/>` +
  '<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/>' +
  '<c:val><c:numRef><c:f>数据!$B$1</c:f><c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="1"/>' +
  '<c:pt idx="0"><c:v>1</c:v></c:pt></c:numCache></c:numRef></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>' +
  '<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>' +
  '<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>' +
  '</c:plotArea></c:chart></c:chartSpace>'
/** 「图表」的部件：缩放 87% 且带 zoomToFit；绘图部件中一个绝对锚点的柱形图与一个单元格锚点的图表。 */
const CHARTSHEET: Record<string, string> = {
  'xl/chartsheets/sheet1.xml': `<chartsheet xmlns="${NS}" xmlns:r="${R}"><sheetViews><sheetView zoomScale="87" workbookViewId="0" zoomToFit="1"/></sheetViews><drawing r:id="rId1"/></chartsheet>`,
  'xl/chartsheets/_rels/sheet1.xml.rels': rels(rel('rId1', 'drawing', '../drawings/drawing2.xml')),
  'xl/drawings/drawing2.xml':
    `<xdr:wsDr xmlns:xdr="${DRAWING_NS}" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}">` +
    `<xdr:absoluteAnchor><xdr:pos x="12700" y="25400"/><xdr:ext cx="3810000" cy="2540000"/>${CHART_FRAME}<xdr:clientData/></xdr:absoluteAnchor>` +
    '<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>' +
    `<xdr:ext cx="10" cy="10"/>${CHART_FRAME}<xdr:clientData/></xdr:oneCellAnchor></xdr:wsDr>`,
  'xl/drawings/_rels/drawing2.xml.rels': rels(rel('rId1', 'chart', '../charts/chart1.xml')),
  'xl/charts/chart1.xml': BAR_CHART,
}

describe('工作簿结构', () => {
  test('工作表与图表工作表按工作簿顺序，隐藏状态与打开时的工作表；图表工作表取绝对锚点的图表与缩放比例', async () => {
    const wb = await parsed(CHARTSHEET)
    expect(wb.sheets.map((s) => [s.kind, s.name, s.state])).toEqual([
      ['worksheet', '数据', 'visible'],
      ['chartsheet', '图表', 'visible'],
      ['worksheet', '隐藏', 'hidden'],
    ])
    expect(wb.activeSheet).toBe(1)
    const chartsheet = wb.sheets[1]!
    expect(chartsheet.kind === 'chartsheet' && chartsheet.view).toEqual({ zoom: 87 })
    expect(chartsheet.charts.map((c) => c.anchor)).toEqual([
      { kind: 'absolute', x: 12700, y: 25400, width: 3810000, height: 2540000 },
    ])
    // 系列按引用从工作表取值，不取缓存值。
    expect(chartsheet.charts[0]!.chart.plot.groups[0]!.series[0]!.values).toEqual([12.25])
    expect(chartsheet.unsupported).toEqual({ chart: 1 })
    expect(wb.unsupported.otherSheet).toBeUndefined()
    expect(wb.minorFont).toEqual({ latin: 'Calibri', eastAsian: '等线' })
  })
  test('部件缺失的图表工作表计入其他工作表；绘图部件中没有图表的图表工作表计入 chart', async () => {
    const missing = await parsed()
    expect(missing.sheets.map((s) => s.name)).toEqual(['数据', '隐藏'])
    expect(missing.activeSheet).toBe(0)
    expect(missing.unsupported.otherSheet).toBe(1)
    const empty = await parsed({
      'xl/chartsheets/sheet1.xml': `<chartsheet xmlns="${NS}"><sheetViews><sheetView workbookViewId="0"/></sheetViews></chartsheet>`,
    })
    const chartsheet = empty.sheets[1]!
    expect([chartsheet.kind, chartsheet.charts, chartsheet.unsupported]).toEqual([
      'chartsheet',
      [],
      { chart: 1 },
    ])
    expect(chartsheet.kind === 'chartsheet' && chartsheet.view.zoom).toBe(100)
  })
  test('未实现的内容按种类计数', async () => {
    const s = worksheetAt(await parsed(), 0)
    expect(s.unsupported).toEqual({
      chart: 1,
      graphic: 1,
      image: 1,
      comment: 2,
      table: 1,
      control: 1,
      sparkline: 1,
      conditionalFormat: 1,
    })
  })
  test('主文档不是工作簿与 XML 结构错误的失败分类', async () => {
    const docx = workbookPackage({
      '[Content_Types].xml': CONTENT_TYPES.replace(
        'spreadsheetml.sheet.main',
        'wordprocessingml.document.main',
      ),
    })
    expect(await parseXlsx(docx)).toEqual({
      ok: false,
      failure: { kind: 'corrupt', reason: 'workbook' },
    })
    const broken = workbookPackage({
      'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row></sheetData>`,
    })
    expect(await parseXlsx(broken)).toEqual({
      ok: false,
      failure: { kind: 'corrupt', reason: 'xml' },
    })
    expect((await parseXlsx(new Uint8Array([1, 2, 3, 4]))).ok).toBe(false)
  })
})

describe('样式', () => {
  test('字体、颜色与「常规」样式', async () => {
    const wb = await parsed()
    expect(wb.defaultFont).toMatchObject({ name: '宋体', size: 11, color: '#000000' })
    const f1 = wb.styles[1]!.font
    expect(f1).toMatchObject({
      name: 'Arial',
      size: 14,
      bold: true,
      italic: false,
      underline: 'single',
    })
    expect(f1.color).toBe(applyTint('#4472c4', 0.39997558519241921))
    const f2 = wb.styles[2]!.font
    expect(f2).toMatchObject({ strike: true, vertAlign: 'superscript', color: DEFAULT_PALETTE[10] })
    expect(wb.fontNames).toContain('黑体')
  })
  test('主题色编号 0 与 1 对应浅色与深色槽位，tint 按 HSL 亮度计算', () => {
    expect(applyTint('#ffffff', -0.5)).toBe('#808080')
    expect(applyTint('#000000', 0.5)).toBe('#808080')
    expect(applyTint('#4472c4', 0)).toBe('#4472c4')
  })
  test('填充、边框、对齐与数字格式', async () => {
    const wb = await parsed()
    const s1 = wb.styles[1]!
    expect(s1.fill).toEqual({ kind: 'pattern', pattern: 'solid', fg: '#ffff00', bg: '#ffff00' })
    expect(s1.border).toMatchObject({
      left: { style: 'thin', color: '#000000' },
      right: { style: 'medium', color: '#ff0000' },
      top: { style: 'dashed', color: '#000000' },
      bottom: { style: 'double', color: '#4472c4' },
      diagonalUp: { style: 'hair' },
      diagonalDown: null,
    })
    expect(s1.alignment).toEqual({
      horizontal: 'center',
      vertical: 'top',
      wrap: true,
      shrink: false,
      rotation: 45,
      indent: 2,
    })
    expect(s1.numFmt).toBe('0.0"件"')
    const s2 = wb.styles[2]!
    // indexedColors 覆盖调色板前 3 项，背景色为主题浅色加 tint。
    expect(s2.fill).toEqual({ kind: 'pattern', pattern: 'lightGray', fg: '#222222', bg: '#808080' })
    expect(s2.numFmt).toBe('yyyy/m/d')
    expect(wb.styles[0]!.alignment).toMatchObject({ horizontal: 'general', vertical: 'bottom' })
    expect(wb.styles[3]!.alignment.shrink).toBe(true)
    expect(wb.palette.slice(0, 4)).toEqual(['#010203', '#111111', '#222222', DEFAULT_PALETTE[3]!])
  })
  test('带 scheme 的字体换为主题字体：依次取 Hans 文种、ea、latin，富文本同样换算', async () => {
    const wb = await parsed({
      'xl/styles.xml': `<styleSheet xmlns="${NS}"><fonts count="3">
<font><sz val="11"/><name val="Calibri"/><scheme val="minor"/></font>
<font><sz val="14"/><name val="Cambria"/><scheme val="major"/></font>
<font><sz val="9"/><name val="Calibri"/></font></fonts>
<cellXfs count="3"><xf fontId="0"/><xf fontId="1"/><xf fontId="2"/></cellXfs></styleSheet>`,
      'xl/sharedStrings.xml': `<sst xmlns="${NS}"><si><r><rPr><rFont val="Arial"/><scheme val="minor"/></rPr><t>甲</t></r></si></sst>`,
    })
    // 主题正文字体 Hans 为等线；标题字体没有 Hans 文种且 ea 为空，取 latin。
    expect(wb.styles.map((s) => s.font.name)).toEqual(['等线', 'Calibri Light', 'Calibri'])
    expect(wb.defaultFont.name).toBe('等线')
    const a1 = worksheetAt(wb, 0).cells.get(0)?.get(0)?.value
    expect(a1?.type === 'string' && a1.runs?.map((r) => r.font?.name)).toEqual(['等线'])
  })
  test('没有主题部件时带 scheme 的字体取宋体（WPS 实测）', () => {
    const sheet = parseStyles(
      `<styleSheet xmlns="${NS}"><fonts count="2">` +
        '<font><sz val="11"/><name val="Calibri"/><scheme val="minor"/></font>' +
        '<font><sz val="11"/><name val="Calibri"/></font></fonts>' +
        '<cellXfs count="2"><xf fontId="0"/><xf fontId="1"/></cellXfs></styleSheet>',
      null,
    )
    expect(sheet.styles.map((s) => s.font.name)).toEqual(['宋体', 'Calibri'])
  })

  test('差异样式缺失的填充颜色保留为 null，纯色只取 bgColor（WPS 实测）', () => {
    const sheet = parseStyles(
      `<styleSheet xmlns="${NS}"><dxfs count="3">` +
        '<dxf><fill><patternFill patternType="lightUp"/></fill></dxf>' +
        '<dxf><fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/></patternFill></fill></dxf>' +
        '<dxf><fill><patternFill patternType="lightUp"><fgColor rgb="FFFF0000"/></patternFill></fill></dxf>' +
        '</dxfs></styleSheet>',
      null,
    )
    expect(sheet.dxfs.map((d) => d.fill)).toEqual([
      { kind: 'pattern', pattern: 'lightUp', fg: null, bg: null },
      { kind: 'pattern', pattern: 'solid', fg: null, bg: null },
      { kind: 'pattern', pattern: 'lightUp', fg: '#ff0000', bg: null },
    ])
  })
  test('差异样式的纯色填充取背景色', async () => {
    const wb = await parsed()
    expect(worksheetAt(wb, 0).conditionalFormats[0]!.rules[0]!.dxf).toMatchObject({
      bold: true,
      italic: null,
      color: '#9c0006',
      fill: { kind: 'pattern', pattern: 'solid', fg: '#ffc7ce' },
    })
  })
})

describe('单元格', () => {
  test('各类型的值与共享字符串', async () => {
    const s = worksheetAt(await parsed(), 0)
    const v = (ref: string) => {
      const p = parseCellRef(ref)!
      return s.cells.get(p.row)?.get(p.col)?.value
    }
    expect(v('A1')).toEqual({ type: 'string', value: '甲', runs: null })
    expect(v('B1')).toEqual({ type: 'number', value: 12.25 })
    expect(v('C1')).toEqual({ type: 'boolean', value: true })
    expect(v('D1')).toEqual({ type: 'error', value: '#DIV/0!' })
    expect(v('E1')).toEqual({ type: 'string', value: '甲', runs: null })
    expect(v('F1')).toEqual({ type: 'string', value: '内联', runs: null })
    expect(v('G1')).toEqual({ type: 'number', value: 45583.5 })
    const rich = v('B2')
    expect(rich?.type === 'string' && rich.value).toBe('普通 加粗')
    expect(
      rich?.type === 'string' && rich.runs?.map((r) => [r.text, r.font?.name ?? null]),
    ).toEqual([
      ['普通 ', null],
      ['加粗', '黑体'],
    ])
    expect(v('C2')).toEqual({ type: 'string', value: '行一\r行二', runs: null })
  })
  test('公式：有缓存值时显示缓存值，没有时显示公式文本，共享公式按偏移平移', async () => {
    const s = worksheetAt(await parsed(), 0)
    const v = (ref: string) => {
      const p = parseCellRef(ref)!
      return s.cells.get(p.row)?.get(p.col)?.value
    }
    expect(v('A2')).toEqual({ type: 'formula', value: '=SUM(B1:B3)' })
    expect(v('A3')).toEqual({ type: 'number', value: 4 })
    expect(v('A4')).toEqual({ type: 'formula', value: '=B4*2+$C$1' })
    expect(v('A6')).toEqual({ type: 'string', value: '', runs: null })
    expect(v('B6')).toEqual({ type: 'formula', value: '=NOW()' })
    // 缺少 r 的单元格按前一个单元格的下一列计；只有样式的单元格保留。
    expect(s.cells.get(3)?.get(1)).toEqual({ value: null, style: 2 })
  })
  test('没有值也没有样式的单元格保留为样式 0，不计入已用区域', async () => {
    const wb = await parsed({
      'xl/worksheets/sheet2.xml': `<worksheet xmlns="${NS}"><sheetData>
<row r="3"><c r="A3" s="1"/><c r="C3"/></row><row r="5"><c r="B5"/></row></sheetData></worksheet>`,
    })
    const s = worksheetAt(wb, 1)
    expect(s.cells.get(2)?.get(2)).toEqual({ value: null, style: 0 })
    expect(s.cells.get(4)?.get(1)).toEqual({ value: null, style: 0 })
    expect([s.maxRow, s.maxCol]).toEqual([2, 0])
  })
  test('行列、合并、冻结窗格、网格线、自动筛选与条件格式', async () => {
    const s = worksheetAt(await parsed(), 0)
    expect(s.cols).toEqual([
      { min: 0, max: 1, width: 12.5, hidden: false, style: null },
      { min: 3, max: 3, width: 9, hidden: true, style: 3 },
    ])
    expect(s.rows.get(0)).toEqual({ height: 30, custom: true, hidden: false, style: null })
    expect(s.rows.get(1)?.hidden).toBe(true)
    expect(s.rows.get(2)).toEqual({ height: 20, custom: false, hidden: false, style: 3 })
    expect(s.format).toEqual({
      defaultRowHeight: 13.5,
      zeroHeight: false,
      customHeight: true,
      defaultColWidth: null,
      baseColWidth: 10,
      declared: true,
    })
    expect(s.merges).toEqual([{ top: 4, left: 1, bottom: 5, right: 3 }])
    expect(s.view).toEqual({
      showGridLines: false,
      gridColor: '#111111',
      zoom: 85,
      rightToLeft: false,
      frozenRows: 2,
      frozenCols: 1,
      topLeft: { row: 4, col: 2 },
    })
    expect(s.autoFilter).toEqual({ top: 0, left: 0, bottom: 3, right: 6 })
    expect(s.conditionalFormats[0]!.ranges).toEqual([
      { top: 0, left: 1, bottom: 2, right: 1 },
      { top: 0, left: 3, bottom: 0, right: 3 },
    ])
    expect(s.conditionalFormats[0]!.rules[0]).toMatchObject({
      type: 'cellIs',
      operator: 'greaterThan',
      formulas: ['$C$1*10'],
      dxf: { bold: true, color: '#9c0006' },
      priority: 2,
    })
    expect(s.conditionalFormats[1]!.rules[0]).toMatchObject({
      type: 'colorScale',
      colors: ['#f8696b', '#4472c4'],
      dxf: null,
    })
    expect(s.maxRow).toBe(5)
    expect(s.maxCol).toBe(6)
  })
  test('2010 扩展条件格式：公式在 xm:f、差异样式内嵌、区域在规则之后；数据条扩展不读入', async () => {
    const s = worksheetAt(await parsed(), 0)
    expect(s.conditionalFormats).toHaveLength(3)
    expect(s.conditionalFormats[2]).toMatchObject({
      ranges: [{ top: 0, left: 2, bottom: 1, right: 2 }],
      rules: [
        {
          type: 'expression',
          formula: '$B$1>隐藏!$A$1',
          priority: 4,
          dxf: { bold: true, fill: { kind: 'pattern', pattern: 'solid', fg: '#ebf1df' } },
        },
      ],
    })
    expect(s.conditionalFormats[2]!.rules).toHaveLength(1)
  })
  test('图片的锚点、裁剪与字节', async () => {
    const s = worksheetAt(await parsed(), 0)
    expect(s.images).toHaveLength(1)
    expect(s.images[0]).toMatchObject({
      anchor: {
        kind: 'twoCell',
        from: { col: 1, colOff: 9525, row: 2, rowOff: 0 },
        to: { col: 3, colOff: 0, row: 5, rowOff: 19050 },
      },
      contentType: 'image/png',
      crop: { left: 0.1, top: 0, right: 0, bottom: 0.25 },
    })
    expect([...s.images[0]!.bytes]).toEqual([...PNG])
  })
  test('图元文件图片中文字的字体加入 fontNames；ActiveX 控件的替代图片按 x14 分支的锚点排在绘图对象之后，没有替代图片的计入 control', async () => {
    const mc = 'http://schemas.openxmlformats.org/markup-compatibility/2006'
    const x14 = 'http://schemas.microsoft.com/office/spreadsheetml/2009/9/main'
    const xdr = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
    const at = (tag: string, col: number, row: number) =>
      `<${tag}><xdr:col>${col}</xdr:col><xdr:colOff>9525</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></${tag}>`
    const sheet = `<worksheet xmlns="${NS}" xmlns:r="${R}" xmlns:mc="${mc}" xmlns:ext="${x14}" xmlns:xdr="${xdr}">
<sheetData/><drawing r:id="rId1"/><controls>
<mc:AlternateContent><mc:Choice Requires="ext"><control shapeId="1025" r:id="rId5" name="复选框"><controlPr r:id="rId6"><anchor>${at('from', 2, 3)}${at('to', 3, 4)}</anchor></controlPr></control></mc:Choice>
<mc:Fallback><control shapeId="1025" r:id="rId5" name="复选框"/></mc:Fallback></mc:AlternateContent>
<control shapeId="1026" r:id="rId7" name="没有替代图片"/></controls></worksheet>`
    const r = await parseXlsx(
      workbookPackage({
        'xl/worksheets/sheet1.xml': sheet,
        'xl/worksheets/_rels/sheet1.xml.rels': rels(
          rel('rId1', 'drawing', '../drawings/drawing1.xml'),
          rel('rId4', 'ctrlProp', '../ctrlProps/ctrlProp1.xml'),
          rel('rId5', 'control', '../activeX/activeX1.xml'),
          rel('rId6', 'image', '../media/image2.wmf'),
          rel('rId7', 'control', '../activeX/activeX2.xml'),
        ),
        'xl/media/image1.png': TEXT_WMF,
        'xl/media/image2.wmf': RED_RECT_WMF,
      }),
    )
    if (!r.ok) throw new Error('解析失败')
    const s = worksheetAt(r.value, 0)
    expect(r.value.fontNames).toContain('Verdana')
    expect(s.images.map((i) => i.order)).toEqual([0, 3])
    expect(s.images[1]!.anchor).toEqual({
      kind: 'twoCell',
      from: { col: 2, colOff: 9525, row: 3, rowOff: 0 },
      to: { col: 3, colOff: 9525, row: 4, rowOff: 0 },
    })
    expect([...s.images[1]!.bytes]).toEqual([...RED_RECT_WMF])
    expect(s.unsupported.control).toBe(2)
  })
  test('图表照常求值，图片填充引用的图片按部件计入 image', async () => {
    const C = 'http://schemas.openxmlformats.org/drawingml/2006/chart'
    const A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
    const blip = '<c:spPr><a:blipFill><a:blip r:embed="rId1"/><a:stretch/></a:blipFill></c:spPr>'
    const chart = `<c:chartSpace xmlns:c="${C}" xmlns:a="${A}" xmlns:r="${R}"><c:chart><c:plotArea><c:layout/>
<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:ser><c:idx val="0"/><c:order val="0"/>${blip}
<c:val><c:numLit><c:ptCount val="1"/><c:pt idx="0"><c:v>1</c:v></c:pt></c:numLit></c:val></c:ser><c:axId val="1"/><c:axId val="2"/></c:barChart>
<c:catAx><c:axId val="1"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx><c:valAx><c:axId val="2"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>
${blip}</c:plotArea></c:chart>${blip}</c:chartSpace>`
    const drawing = `<xdr:wsDr ${XDR}>${two(`<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="2" name="图表"/></xdr:nvGraphicFramePr>
<a:graphic><a:graphicData uri="${C}"><c:chart xmlns:c="${C}" r:id="rId2"/></a:graphicData></a:graphic></xdr:graphicFrame>`)}</xdr:wsDr>`
    const r = await parseXlsx(
      workbookPackage({
        'xl/drawings/drawing1.xml': drawing,
        'xl/drawings/_rels/drawing1.xml.rels': rels(rel('rId2', 'chart', '../charts/chart1.xml')),
        'xl/charts/chart1.xml': chart,
        'xl/charts/_rels/chart1.xml.rels': rels(rel('rId1', 'image', '../media/image1.png')),
      }),
    )
    if (!r.ok) throw new Error('解析失败')
    const s = worksheetAt(r.value, 0)
    expect(s.charts).toHaveLength(1)
    expect(s.unsupported.image).toBe(1)
    expect(r.value.unsupported.image).toBe(1)
  })
})

/** 带格式方案的主题：填充样式 1 为 `phClr` 纯色，线条样式 1 为 1 磅 `phClr` 实线，效果样式 1 为空。 */
const THEME_WITH_FORMATS = THEME.replace(
  '</a:themeElements>',
  `<a:fmtScheme name="m"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst>
<a:lnStyleLst><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>
<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst>
<a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements>`,
)

const XDR = `xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${R}"`
const cell = (tag: string, col: number, row: number) =>
  `<xdr:${tag}><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:${tag}>`
const two = (body: string) =>
  `<xdr:twoCellAnchor>${cell('from', 1, 1)}${cell('to', 3, 4)}${body}<xdr:clientData/></xdr:twoCellAnchor>`
const xfrm = (x: number, y: number, w: number, h: number, attrs = '') =>
  `<a:xfrm${attrs}><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`

const SHAPES = `<xdr:wsDr ${XDR}>
${two('<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="2" name="图片"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill><xdr:spPr/></xdr:pic>')}
${two(`<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="3" name="按钮"/><xdr:cNvSpPr/></xdr:nvSpPr>
<xdr:spPr>${xfrm(1000, 2000, 3000, 4000)}<a:prstGeom prst="roundRect"><a:avLst/></a:prstGeom></xdr:spPr>
<xdr:style><a:lnRef idx="1"><a:schemeClr val="accent2"/></a:lnRef><a:fillRef idx="1"><a:schemeClr val="accent1"/></a:fillRef>
<a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></xdr:style>
<xdr:txBody><a:bodyPr anchor="ctr"/><a:lstStyle/><a:p><a:pPr algn="ctr"/><a:r><a:rPr lang="zh-CN" sz="1100"/><a:t>登录</a:t></a:r></a:p></xdr:txBody></xdr:sp>`)}
<xdr:oneCellAnchor>${cell('from', 0, 6)}<xdr:ext cx="952500" cy="9525"/><xdr:cxnSp><xdr:nvCxnSpPr><xdr:cNvPr id="4" name="连接线"/><xdr:cNvCxnSpPr/></xdr:nvCxnSpPr>
<xdr:spPr>${xfrm(0, 0, 952500, 0, ' flipH="1"')}<a:prstGeom prst="straightConnector1"><a:avLst/></a:prstGeom><a:ln><a:tailEnd type="arrow"/></a:ln></xdr:spPr>
<xdr:style><a:lnRef idx="1"><a:schemeClr val="accent1"/></a:lnRef><a:fillRef idx="0"><a:schemeClr val="accent1"/></a:fillRef>
<a:effectRef idx="0"><a:schemeClr val="accent1"/></a:effectRef><a:fontRef idx="minor"><a:schemeClr val="tx1"/></a:fontRef></xdr:style></xdr:cxnSp><xdr:clientData/></xdr:oneCellAnchor>
<xdr:absoluteAnchor><xdr:pos x="0" y="0"/><xdr:ext cx="2000" cy="1000"/><xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="5" name="组合"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr>
<xdr:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="2000" cy="1000"/><a:chOff x="0" y="0"/><a:chExt cx="4000" cy="2000"/></a:xfrm></xdr:grpSpPr>
<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="6" name="组内"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr>${xfrm(2000, 0, 2000, 2000)}<a:solidFill><a:srgbClr val="FF0000"/></a:solidFill></xdr:spPr></xdr:sp>
<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="7" name="组内隐藏" hidden="1"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr>${xfrm(0, 0, 10, 10)}</xdr:spPr></xdr:sp>
<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="8" name="组内图表"/></xdr:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></xdr:graphicFrame>
<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="9" name="组内图片"/></xdr:nvPicPr><xdr:blipFill><a:blip r:embed="rId1"/></xdr:blipFill></xdr:pic>
</xdr:grpSp><xdr:clientData/></xdr:absoluteAnchor>
${two(`<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="10" name="艺术字"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr>${xfrm(0, 0, 100, 100)}
<a:effectLst><a:glow rad="12700"><a:srgbClr val="FF0000"/></a:glow></a:effectLst>
<a:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></a:scene3d><a:sp3d><a:bevelT/></a:sp3d></xdr:spPr>
<xdr:txBody><a:bodyPr vert="wordArtVert"><a:prstTxWarp prst="textWave1"><a:avLst/></a:prstTxWarp></a:bodyPr><a:p><a:r><a:t>波浪</a:t></a:r></a:p></xdr:txBody></xdr:sp>`)}
${two(`<xdr:grpSp><xdr:nvGrpSpPr><xdr:cNvPr id="11" name="隐藏" hidden="1"/><xdr:cNvGrpSpPr/></xdr:nvGrpSpPr><xdr:grpSpPr>${xfrm(0, 0, 100, 100)}</xdr:grpSpPr>
<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="13" name="隐藏组内"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr>${xfrm(0, 0, 100, 100)}<a:effectLst><a:glow rad="12700"><a:srgbClr val="FF0000"/></a:glow></a:effectLst><a:sp3d><a:bevelT/></a:sp3d></xdr:spPr></xdr:sp>
<xdr:graphicFrame><xdr:nvGraphicFramePr><xdr:cNvPr id="14" name="隐藏组内图表"/></xdr:nvGraphicFramePr><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"/></a:graphic></xdr:graphicFrame></xdr:grpSp>`)}
${two('<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="12" name="无位置"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr/></xdr:sp>')}
</xdr:wsDr>`

function solidHex(fill: ShapeFill): string | null {
  return fill.kind === 'solid' ? colorToHex(fill.color) : null
}

describe('形状', () => {
  test('锚点序号与图片共用；几何、样式引用、文字与字体名；连接线；组合内按子坐标系换算，隐藏对象与图表不进入形状', async () => {
    const wb = await parsed({
      'xl/drawings/drawing1.xml': SHAPES,
      'xl/theme/theme1.xml': THEME_WITH_FORMATS,
    })
    const s = worksheetAt(wb, 0)
    expect(s.images.map((i) => i.order)).toEqual([0])
    expect(s.shapes.map((x) => x.order)).toEqual([1, 2, 3, 4])
    const [button, connector, group, warp] = s.shapes.map((x) => x.shape)
    if (button?.kind !== 'shape') throw new Error('第一个形状应为自选图形')
    expect(s.shapes[0]!.anchor).toEqual({
      kind: 'twoCell',
      from: { col: 1, colOff: 0, row: 1, rowOff: 0 },
      to: { col: 3, colOff: 0, row: 4, rowOff: 0 },
    })
    expect(button.frame).toEqual({
      x: 1000,
      y: 2000,
      width: 3000,
      height: 4000,
      rotation: 0,
      flipH: false,
      flipV: false,
    })
    expect(button.geometry).toEqual({ kind: 'preset', name: 'roundRect', adjust: [] })
    expect(solidHex(button.fill)).toBe('4472C4')
    expect(button.line?.width).toBe(12700)
    expect(button.line?.fill.kind === 'solid' && colorToHex(button.line.fill.color)).toBe('ED7D31')
    const run = button.text?.paragraphs[0]?.runs[0]
    expect(run?.kind === 'text' && run.text).toBe('登录')
    expect(run?.style).toMatchObject({ size: 11, latin: 'Calibri', ea: '等线' })
    expect(run && solidHex(run.style.fill)).toBe('FFFFFF')
    expect(button.text?.body.anchor).toBe('ctr')
    expect(wb.fontNames).toEqual(expect.arrayContaining(['Calibri', '等线', MISSING_LATIN]))

    expect(connector).toMatchObject({
      kind: 'connector',
      frame: { flipH: true, width: 952500, height: 0 },
    })
    expect(connector?.kind === 'connector' && connector.line?.tail?.type).toBe('arrow')
    expect(s.shapes[1]!.anchor).toEqual({
      kind: 'oneCell',
      from: { col: 0, colOff: 0, row: 6, rowOff: 0 },
      width: 952500,
      height: 9525,
    })

    if (group?.kind !== 'group') throw new Error('第三个形状应为组合')
    expect(group.children).toHaveLength(1)
    expect(group.children[0]?.frame).toMatchObject({ x: 1000, y: 0, width: 1000, height: 1000 })
    expect(group.children[0]?.kind === 'shape' && solidHex(group.children[0].fill)).toBe('FF0000')

    expect(warp?.kind).toBe('shape')
    // 组内图表、组内图片、缺少 xfrm 的顶层形状；艺术字的变形、竖排与棱台（发光经效果图层绘制，不计）。隐藏的组合及其中的
    // 棱台与图表不计数。
    expect(s.unsupported).toEqual({
      comment: 2,
      table: 1,
      control: 1,
      sparkline: 1,
      conditionalFormat: 1,
      chart: 1,
      image: 1,
      graphic: 1,
      textWarp: 1,
      verticalText: 1,
      effect3d: 1,
    })
  })
  test('自选图形与组合的发光、柔化边缘与映像经效果图层绘制，不计数；连接线上的计为 effect', async () => {
    const glow =
      '<a:effectLst><a:glow rad="12700"><a:srgbClr val="FF0000"/></a:glow><a:softEdge rad="12700"/></a:effectLst>'
    const drawing = (body: string) => `<xdr:wsDr ${XDR}>${two(body)}</xdr:wsDr>`
    const shape = drawing(
      `<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="2" name="形状"/><xdr:cNvSpPr/></xdr:nvSpPr><xdr:spPr>${xfrm(0, 0, 100, 100)}${glow}</xdr:spPr></xdr:sp>`,
    )
    const connector = drawing(
      `<xdr:cxnSp><xdr:nvCxnSpPr><xdr:cNvPr id="2" name="连接线"/><xdr:cNvCxnSpPr/></xdr:nvCxnSpPr><xdr:spPr>${xfrm(0, 0, 100, 0)}${glow}</xdr:spPr></xdr:cxnSp>`,
    )
    const of = async (xml: string) =>
      worksheetAt(await parsed({ 'xl/drawings/drawing1.xml': xml }), 0).unsupported.effect
    expect(await of(shape)).toBeUndefined()
    expect(await of(connector)).toBe(2)
  })

  test('形状文字未指定的字号为 11 磅，字体为主题正文字体', async () => {
    const plain = `<xdr:wsDr ${XDR}>${two(`<xdr:sp><xdr:nvSpPr><xdr:cNvPr id="3" name="文本"/><xdr:cNvSpPr/></xdr:nvSpPr>
<xdr:spPr>${xfrm(0, 0, 3000, 4000)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
<xdr:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="zh-CN"/><a:t>默认</a:t></a:r></a:p></xdr:txBody></xdr:sp>`)}</xdr:wsDr>`
    const s = worksheetAt(await parsed({ 'xl/drawings/drawing1.xml': plain }), 0)
    const shape = s.shapes[0]?.shape
    const run = shape?.kind === 'shape' ? shape.text?.paragraphs[0]?.runs[0] : undefined
    expect(run?.style).toMatchObject({ size: 11, latin: 'Calibri', ea: '等线' })
  })
})

describe('引用', () => {
  test('单元格与区域', () => {
    expect(parseCellRef('$AB$12')).toEqual({ row: 11, col: 27 })
    expect(parseCellRef('XFD1048576')).toEqual({ row: 1_048_575, col: 16_383 })
    expect(parseCellRef('A0')).toBeNull()
    expect(parseRange('C3:A1')).toEqual({ top: 0, left: 0, bottom: 2, right: 2 })
    expect(parseRange('B:C')).toEqual({ top: 0, left: 1, bottom: 1_048_575, right: 2 })
    expect(parseRange('2:3')).toEqual({ top: 1, left: 0, bottom: 2, right: 16_383 })
  })
  test('共享公式平移：相对引用随偏移变化，锁定部分、引号文本与函数名不变', () => {
    expect(shiftFormula('A1+$B1+C$1+$D$1', 2, 1)).toBe('B3+$B3+D$1+$D$1')
    expect(shiftFormula('LOG10(A1)&"A1"', 1, 0)).toBe('LOG10(A2)&"A1"')
    expect(shiftFormula('Sheet2!A1', 0, 2)).toBe('Sheet2!C1')
  })
})
