/**
 * 测试夹具：SmartArt 四个部件的最小 XML。数据部件按 PowerPoint 写出的结构生成（每个布局节点实例都有同名的 pres 点）；
 * 布局定义为 chevron1 与 process1 的单层结构（process1 的节点为矩形，便于按框计算文字区）。
 */

import type { Relationships } from '../../opc/package.ts'
import { parseTheme } from '../theme.ts'

export const DGM = 'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"'
export const A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
export const R = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'

export const NO_RELS: Relationships = {
  source: '',
  list: [],
  byId: () => null,
  ofKind: () => [],
  part: () => null,
}

/** 主题部件：方案颜色、次要字体 `Minor` 与 `MinorEA`，三级填充与线条样式均为 `phClr`。 */
export const THEME_XML =
  `<a:theme ${A} name="t"><a:themeElements><a:clrScheme name="c">` +
  '<a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  '<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>' +
  '<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>' +
  '<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>' +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  '</a:clrScheme><a:fontScheme name="f"><a:majorFont><a:latin typeface="Major"/><a:ea typeface=""/>' +
  '<a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Minor"/><a:ea typeface="MinorEA"/>' +
  '<a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="m"><a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst>' +
  '<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst>' +
  '<a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme>' +
  '</a:themeElements></a:theme>'
export const THEME = parseTheme(THEME_XML)
export const SCOPE = { theme: THEME, colors: { scheme: THEME.colors } }

const STYLE_REFS = (ln: number, fill: number) =>
  `<dgm:style><a:lnRef idx="${ln}"><a:scrgbClr r="0" g="0" b="0"/></a:lnRef>` +
  `<a:fillRef idx="${fill}"><a:scrgbClr r="0" g="0" b="0"/></a:fillRef>` +
  '<a:effectRef idx="0"><a:scrgbClr r="0" g="0" b="0"/></a:effectRef>' +
  '<a:fontRef idx="minor"><a:schemeClr val="lt1"/></a:fontRef></dgm:style>'
export const STYLES =
  `<dgm:styleDef ${DGM} ${A} uniqueId="s"><dgm:styleLbl name="node1">${STYLE_REFS(2, 1)}</dgm:styleLbl>` +
  `<dgm:styleLbl name="sibTrans2D1">${STYLE_REFS(0, 1)}</dgm:styleLbl></dgm:styleDef>`

export function colorsXml(
  nodeFill = '<dgm:fillClrLst meth="repeat"><a:schemeClr val="accent1"/></dgm:fillClrLst>',
): string {
  return (
    `<dgm:colorsDef ${DGM} ${A} uniqueId="c"><dgm:styleLbl name="node1">${nodeFill}` +
    '<dgm:linClrLst meth="repeat"><a:schemeClr val="lt1"/></dgm:linClrLst><dgm:effectClrLst/><dgm:txFillClrLst/>' +
    '</dgm:styleLbl><dgm:styleLbl name="sibTrans2D1"><dgm:fillClrLst meth="repeat"><a:schemeClr val="accent2"/>' +
    '</dgm:fillClrLst><dgm:linClrLst/><dgm:effectClrLst/><dgm:txFillClrLst/></dgm:styleLbl></dgm:colorsDef>'
  )
}

/** 与 PowerPoint 写出的结构相同：每个布局节点实例都有同名的 pres 点。 */
export interface DataOptions {
  readonly node: string
  /** 每个节点之后（最后一个除外）的 sibTrans 实例所在的布局节点名。 */
  readonly trans: readonly string[]
  readonly rev?: boolean
  readonly cust?: Readonly<Record<number, string>>
  readonly spPr?: Readonly<Record<number, string>>
  readonly runProps?: string
  readonly omitPres?: boolean
  readonly extra?: string
}

export function dataXml(texts: readonly (readonly string[])[], o: DataOptions): string {
  const pts: string[] = [
    '<dgm:pt modelId="doc" type="doc"><dgm:prSet loTypeId="urn:l"/><dgm:spPr/></dgm:pt>',
    `<dgm:pt modelId="root" type="pres"><dgm:prSet presAssocID="doc" presName="Name0"><dgm:presLayoutVars>` +
      `${o.rev === true ? '<dgm:dir val="rev"/>' : '<dgm:dir/>'}</dgm:presLayoutVars></dgm:prSet><dgm:spPr/></dgm:pt>`,
  ]
  const cxns: string[] = []
  texts.forEach((paragraphs, i) => {
    const t = paragraphs
      .map((p) => `<a:p><a:r><a:rPr lang="zh-CN"${o.runProps ?? ''}/><a:t>${p}</a:t></a:r></a:p>`)
      .join('')
    pts.push(
      `<dgm:pt modelId="n${i}"><dgm:prSet/><dgm:spPr>${o.spPr?.[i] ?? ''}</dgm:spPr>` +
        `<dgm:t><a:bodyPr/><a:lstStyle/>${t}</dgm:t></dgm:pt>`,
      `<dgm:pt modelId="p${i}" type="parTrans" cxnId="c${i}"><dgm:prSet/><dgm:spPr/></dgm:pt>`,
      `<dgm:pt modelId="s${i}" type="sibTrans" cxnId="c${i}"><dgm:prSet/><dgm:spPr/>` +
        '<dgm:t><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></dgm:t></dgm:pt>',
    )
    cxns.push(
      `<dgm:cxn modelId="c${i}" srcId="doc" destId="n${i}" srcOrd="${i}" destOrd="0" parTransId="p${i}" sibTransId="s${i}"/>`,
    )
    if (o.omitPres === true) return
    pts.push(
      `<dgm:pt modelId="pn${i}" type="pres"><dgm:prSet presAssocID="n${i}" presName="${o.node}" ` +
        `presStyleLbl="node1"${o.cust?.[i] ?? ''}/><dgm:spPr/></dgm:pt>`,
    )
    if (i < texts.length - 1) {
      for (const name of o.trans) {
        const lbl = name === 'space' ? '' : ' presStyleLbl="sibTrans2D1"'
        pts.push(
          `<dgm:pt modelId="ps${i}${name}" type="pres"><dgm:prSet presAssocID="s${i}" presName="${name}"${lbl}/><dgm:spPr/></dgm:pt>`,
        )
      }
    }
  })
  return (
    `<dgm:dataModel ${DGM} ${A}><dgm:ptLst>${pts.join('')}</dgm:ptLst><dgm:cxnLst>${cxns.join('')}</dgm:cxnLst>` +
    `<dgm:bg/><dgm:whole/>${o.extra ?? ''}</dgm:dataModel>`
  )
}

/** chevron1 去掉多层分支后的结构：节点按 0.4 宽高比，节点之间的空白为节点宽度的 -0.1 倍。 */
export const CHEVRON = (shapeType = 'chevron') =>
  `<dgm:layoutDef ${DGM} ${A} uniqueId="urn:l"><dgm:layoutNode name="Name0"><dgm:varLst><dgm:dir/></dgm:varLst>` +
  '<dgm:choose name="a"><dgm:if name="b" func="var" arg="dir" op="equ" val="norm"><dgm:alg type="lin"/></dgm:if>' +
  '<dgm:else name="c"><dgm:alg type="lin"><dgm:param type="linDir" val="fromR"/></dgm:alg></dgm:else></dgm:choose>' +
  '<dgm:shape><dgm:adjLst/></dgm:shape><dgm:presOf/><dgm:constrLst>' +
  '<dgm:constr type="w" for="ch" forName="node" refType="w"/>' +
  '<dgm:constr type="h" for="des" forName="node" op="equ"/>' +
  '<dgm:constr type="primFontSz" for="des" forName="node" op="equ" val="65"/>' +
  '<dgm:constr type="w" for="ch" forName="space" refType="w" refFor="ch" refForName="node" fact="-0.1"/>' +
  '</dgm:constrLst><dgm:ruleLst/><dgm:forEach name="d" axis="ch" ptType="node">' +
  '<dgm:layoutNode name="node"><dgm:alg type="tx"/><dgm:choose name="e">' +
  `<dgm:if name="f" func="var" arg="dir" op="equ" val="norm"><dgm:shape type="${shapeType}"><dgm:adjLst/></dgm:shape></dgm:if>` +
  `<dgm:else name="g"><dgm:shape rot="180" type="${shapeType}"><dgm:adjLst/></dgm:shape></dgm:else></dgm:choose>` +
  '<dgm:presOf axis="self" ptType="node"/><dgm:constrLst>' +
  '<dgm:constr type="h" refType="w" op="equ" fact="0.4"/>' +
  '<dgm:constr type="tMarg" refType="primFontSz" fact="0.105"/><dgm:constr type="bMarg" refType="primFontSz" fact="0.105"/>' +
  '<dgm:constr type="lMarg" refType="primFontSz" fact="0.315"/><dgm:constr type="rMarg" refType="primFontSz" fact="0.105"/>' +
  '</dgm:constrLst><dgm:ruleLst><dgm:rule type="primFontSz" val="5" fact="NaN" max="NaN"/></dgm:ruleLst></dgm:layoutNode>' +
  '<dgm:forEach name="h" axis="followSib" ptType="sibTrans" cnt="1"><dgm:layoutNode name="space"><dgm:alg type="sp"/>' +
  '<dgm:shape><dgm:adjLst/></dgm:shape><dgm:presOf/><dgm:constrLst/><dgm:ruleLst/></dgm:layoutNode></dgm:forEach>' +
  '</dgm:forEach></dgm:layoutNode></dgm:layoutDef>'

/** process1 的结构（矩形节点，便于按框计算文字区）：节点高为宽的 0.6 倍，箭头占节点宽度的 0.4 倍。 */
export const PROCESS =
  `<dgm:layoutDef ${DGM} ${A} uniqueId="urn:l"><dgm:layoutNode name="Name0"><dgm:varLst><dgm:dir/></dgm:varLst>` +
  '<dgm:alg type="lin"/><dgm:shape><dgm:adjLst/></dgm:shape><dgm:presOf/><dgm:constrLst>' +
  '<dgm:constr type="w" for="ch" ptType="node" refType="w"/><dgm:constr type="h" for="ch" ptType="node" op="equ"/>' +
  '<dgm:constr type="primFontSz" for="ch" ptType="node" op="equ" val="65"/>' +
  '<dgm:constr type="w" for="ch" ptType="sibTrans" refType="w" refFor="ch" refPtType="node" op="equ" fact="0.4"/>' +
  '<dgm:constr type="h" for="ch" ptType="sibTrans" op="equ"/></dgm:constrLst><dgm:ruleLst/>' +
  '<dgm:forEach name="a" axis="ch" ptType="node"><dgm:layoutNode name="node"><dgm:alg type="tx"/>' +
  '<dgm:shape type="rect"><dgm:adjLst/></dgm:shape><dgm:presOf axis="desOrSelf" ptType="node"/><dgm:constrLst>' +
  '<dgm:constr type="h" refType="w" fact="0.6"/><dgm:constr type="tMarg" refType="primFontSz" fact="0.3"/>' +
  '<dgm:constr type="bMarg" refType="primFontSz" fact="0.3"/><dgm:constr type="lMarg" refType="primFontSz" fact="0.3"/>' +
  '<dgm:constr type="rMarg" refType="primFontSz" fact="0.3"/></dgm:constrLst><dgm:ruleLst>' +
  '<dgm:rule type="primFontSz" val="18" fact="NaN" max="NaN"/><dgm:rule type="h" val="NaN" fact="1.5" max="NaN"/>' +
  '<dgm:rule type="primFontSz" val="5" fact="NaN" max="NaN"/></dgm:ruleLst></dgm:layoutNode>' +
  '<dgm:forEach name="b" axis="followSib" ptType="sibTrans" cnt="1"><dgm:layoutNode name="sibTrans">' +
  '<dgm:alg type="conn"><dgm:param type="begPts" val="auto"/><dgm:param type="endPts" val="auto"/></dgm:alg>' +
  '<dgm:shape type="conn"><dgm:adjLst/></dgm:shape><dgm:presOf axis="self"/><dgm:constrLst>' +
  '<dgm:constr type="h" refType="w" fact="0.62"/><dgm:constr type="connDist"/>' +
  '<dgm:constr type="begPad" refType="connDist" fact="0.25"/><dgm:constr type="endPad" refType="connDist" fact="0.22"/>' +
  '</dgm:constrLst><dgm:ruleLst/><dgm:layoutNode name="connectorText"><dgm:alg type="tx"/>' +
  '<dgm:shape type="conn" hideGeom="1"><dgm:adjLst/></dgm:shape><dgm:presOf axis="self"/><dgm:constrLst>' +
  '<dgm:constr type="lMarg"/><dgm:constr type="rMarg"/></dgm:constrLst><dgm:ruleLst/></dgm:layoutNode>' +
  '</dgm:layoutNode></dgm:forEach></dgm:forEach></dgm:layoutNode></dgm:layoutDef>'
