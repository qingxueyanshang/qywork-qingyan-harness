/**
 * 测试夹具：按部件 XML 生成最小 pptx。
 *
 * - ZIP 按存储方式（不压缩）写入，CRC 使用 `Bun.hash.crc32`，与被测的 ZIP 读取互相独立。
 * - `buildPptx` 生成一个母版、若干版式与幻灯片；未给出的部件使用默认内容：Office 配色与字体的主题（含格式方案）、
 *   带标题、正文、日期、页脚、页码占位符的母版与 `txStyles`、一个标题加正文的版式。
 */

const encoder = new TextEncoder()

export const NS_DECL =
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" ' +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" ' +
  'xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'

const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const CT = 'application/vnd.openxmlformats-officedocument.presentationml'

export function buildZip(members: Record<string, string | Uint8Array>): Uint8Array<ArrayBuffer> {
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
  const directorySize = centrals.reduce((n, c) => n + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, centrals.length, true)
  ev.setUint16(10, centrals.length, true)
  ev.setUint32(12, directorySize, true)
  ev.setUint32(16, offset, true)
  const out = new Uint8Array(offset + directorySize + 22)
  let p = 0
  for (const chunk of [...locals, ...centrals, end]) {
    out.set(chunk, p)
    p += chunk.length
  }
  return out
}

function rels(items: readonly [string, string, string][]): string {
  const body = items
    .map(
      ([id, type, target]) => `<Relationship Id="${id}" Type="${REL}/${type}" Target="${target}"/>`,
    )
    .join('')
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`
}

export function xfrm(x: number, y: number, cx: number, cy: number, attrs = ''): string {
  return `<a:xfrm${attrs}><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
}

/** 一个形状：`ph` 为 `<p:ph .../>` 的属性串，`spPr` 与 `body` 为子元素内容。 */
export function sp(
  id: number,
  options: {
    name?: string
    ph?: string
    txBox?: boolean
    spPr?: string
    style?: string
    body?: string
  } = {},
): string {
  const ph = options.ph === undefined ? '<p:nvPr/>' : `<p:nvPr><p:ph ${options.ph}/></p:nvPr>`
  const txBox = options.txBox ? ' txBox="1"' : ''
  const body = options.body === undefined ? '' : `<p:txBody>${options.body}</p:txBody>`
  const style = options.style === undefined ? '' : `<p:style>${options.style}</p:style>`
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${options.name ?? `形状 ${id}`}"/><p:cNvSpPr${txBox}/>${ph}</p:nvSpPr>` +
    `<p:spPr>${options.spPr ?? ''}</p:spPr>${style}${body}</p:sp>`
  )
}

/** 文本框内容：`bodyPr`、`lstStyle` 与段落。 */
export function text(
  paragraphs: string,
  bodyPr = '<a:bodyPr/>',
  lstStyle = '<a:lstStyle/>',
): string {
  return `${bodyPr}${lstStyle}${paragraphs}`
}

export function para(runs: string, pPr = ''): string {
  return `<a:p>${pPr}${runs}</a:p>`
}

export function run(t: string, rPr = '<a:rPr lang="zh-CN"/>'): string {
  return `<a:r>${rPr}<a:t>${t}</a:t></a:r>`
}

export function tree(shapes: string): string {
  return (
    '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    `<p:grpSpPr/>${shapes}</p:spTree>`
  )
}

export const THEME_FMT =
  '<a:fmtScheme name="测试">' +
  '<a:fillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:gs>' +
  '<a:gs pos="100000"><a:schemeClr val="phClr"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>' +
  '<a:solidFill><a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr></a:solidFill>' +
  '</a:fillStyleLst>' +
  '<a:lnStyleLst>' +
  '<a:ln w="6350" cap="flat"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>' +
  '<a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>' +
  '<a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="dash"/></a:ln>' +
  '</a:lnStyleLst>' +
  '<a:effectStyleLst>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst/></a:effectStyle>' +
  '<a:effectStyle><a:effectLst><a:outerShdw blurRad="57150" dist="19050" dir="5400000" algn="ctr" rotWithShape="0">' +
  '<a:srgbClr val="000000"><a:alpha val="63000"/></a:srgbClr></a:outerShdw></a:effectLst>' +
  '<a:scene3d><a:camera prst="orthographicFront"/><a:lightRig rig="threePt" dir="t"/></a:scene3d>' +
  '<a:sp3d><a:bevelT w="63500" h="25400"/></a:sp3d></a:effectStyle>' +
  '</a:effectStyleLst>' +
  '<a:bgFillStyleLst>' +
  '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>' +
  '<a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill>' +
  '<a:blipFill><a:blip r:embed="rIdBg"/><a:stretch><a:fillRect/></a:stretch></a:blipFill>' +
  '</a:bgFillStyleLst>' +
  '</a:fmtScheme>'

export const THEME = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme ${NS_DECL} name="测试主题"><a:themeElements>
<a:clrScheme name="测试">
<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>
<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
<a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2>
<a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4>
<a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6>
<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>
</a:clrScheme>
<a:fontScheme name="测试">
<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线 Light"/></a:majorFont>
<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="等线"/><a:font script="Jpan" typeface="游ゴシック"/></a:minorFont>
</a:fontScheme>
${THEME_FMT}
</a:themeElements></a:theme>`

const DEFAULT_MASTER_SHAPES =
  sp(2, {
    name: '标题占位符',
    ph: 'type="title"',
    spPr: xfrm(838200, 365125, 10515600, 1325563),
    body: text(para(run('母版标题')), '<a:bodyPr anchor="ctr"/>'),
  }) +
  sp(3, {
    name: '正文占位符',
    ph: 'type="body" idx="1"',
    spPr: xfrm(838200, 1825625, 10515600, 4351338),
    body: text(para(run('母版正文')), '<a:bodyPr lIns="10000"/>'),
  }) +
  sp(4, {
    name: '日期占位符',
    ph: 'type="dt" sz="half" idx="2"',
    spPr: xfrm(838200, 6356350, 2743200, 365125),
    body: text(
      para(run('')),
      '<a:bodyPr anchor="ctr"/>',
      '<a:lstStyle><a:lvl1pPr algn="l"><a:defRPr sz="1200"/></a:lvl1pPr></a:lstStyle>',
    ),
  }) +
  sp(5, {
    name: '页脚占位符',
    ph: 'type="ftr" sz="quarter" idx="3"',
    spPr: xfrm(4038600, 6356350, 4114800, 365125),
  }) +
  sp(6, {
    name: '页码占位符',
    ph: 'type="sldNum" sz="quarter" idx="4"',
    spPr: xfrm(8610600, 6356350, 2743200, 365125),
  })

export const DEFAULT_TX_STYLES =
  '<p:txStyles>' +
  '<p:titleStyle><a:lvl1pPr algn="l"><a:lnSpc><a:spcPct val="90000"/></a:lnSpc><a:buNone/>' +
  '<a:defRPr sz="4400" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
  '<a:latin typeface="+mj-lt"/><a:ea typeface="+mj-ea"/><a:cs typeface="+mj-cs"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
  '<p:bodyStyle>' +
  '<a:lvl1pPr marL="228600" indent="-228600" algn="l"><a:spcBef><a:spcPts val="1000"/></a:spcBef>' +
  '<a:buFont typeface="Arial"/><a:buChar char="•"/>' +
  '<a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
  '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>' +
  '<a:lvl2pPr marL="685800" indent="-228600"><a:buFont typeface="Arial"/><a:buChar char="–"/>' +
  '<a:defRPr sz="2400"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
  '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl2pPr>' +
  '</p:bodyStyle>' +
  '<p:otherStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1800"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill>' +
  '<a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/></a:defRPr></a:lvl1pPr></p:otherStyle>' +
  '</p:txStyles>'

const DEFAULT_CLR_MAP =
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>'

export function masterXml(
  options: {
    shapes?: string
    bg?: string
    clrMap?: string
    txStyles?: string
    layouts?: number
  } = {},
): string {
  const bg = options.bg ?? '<p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>'
  const ids = Array.from(
    { length: options.layouts ?? 1 },
    (_, i) => `<p:sldLayoutId id="${2147483649 + i}" r:id="rId${i + 1}"/>`,
  ).join('')
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster ${NS_DECL}>` +
    `<p:cSld>${bg}${tree(options.shapes ?? DEFAULT_MASTER_SHAPES)}</p:cSld>` +
    `${options.clrMap ?? DEFAULT_CLR_MAP}<p:sldLayoutIdLst>${ids}</p:sldLayoutIdLst>` +
    `${options.txStyles ?? DEFAULT_TX_STYLES}</p:sldMaster>`
  )
}

export const DEFAULT_LAYOUT_SHAPES =
  sp(2, { name: '版式标题', ph: 'type="title"', body: text(para('')) }) +
  sp(3, {
    name: '版式正文',
    ph: 'idx="1"',
    spPr: xfrm(838200, 1900000, 10515600, 4000000),
    body: text(para(''), '<a:bodyPr tIns="20000"/>'),
  })

export function layoutXml(
  options: { shapes?: string; attrs?: string; extra?: string } = {},
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout ${NS_DECL}${options.attrs ?? ''}>` +
    `<p:cSld>${tree(options.shapes ?? DEFAULT_LAYOUT_SHAPES)}</p:cSld>` +
    `${options.extra ?? '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'}</p:sldLayout>`
  )
}

export function slideXml(
  shapes: string,
  options: { attrs?: string; extra?: string; bg?: string } = {},
): string {
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld ${NS_DECL}${options.attrs ?? ''}>` +
    `<p:cSld>${options.bg ?? ''}${tree(shapes)}</p:cSld>` +
    `${options.extra ?? '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>'}</p:sld>`
  )
}

export interface SlideSpec {
  readonly xml: string
  /** 版式序号，缺省为 0。 */
  readonly layout?: number
  /** 额外的关系：`[Id, 类型简称, 目标]`，目标相对 `ppt/slides/`。 */
  readonly rels?: readonly [string, string, string][]
}

export interface DeckSpec {
  readonly slides: readonly SlideSpec[]
  readonly layouts?: readonly string[]
  readonly master?: string
  readonly theme?: string
  readonly presentationAttrs?: string
  readonly defaultTextStyle?: string
  readonly tableStyles?: string
  /** `sldIdLst` 中的顺序，按 `slides` 下标；缺省为原顺序。 */
  readonly order?: readonly number[]
  /** 其他成员：ZIP 成员名到内容。 */
  readonly media?: Readonly<Record<string, string | Uint8Array>>
  /** 演示文稿部件的额外关系：`[Id, 类型简称, 目标]`，目标相对 `ppt/`。 */
  readonly presentationRels?: readonly [string, string, string][]
  /** 插入 `presentation.xml` 中 `defaultTextStyle` 之前的内容。 */
  readonly presentationExtra?: string
}

export const DEFAULT_TEXT_STYLE =
  '<p:defaultTextStyle><a:defPPr><a:defRPr lang="zh-CN"/></a:defPPr>' +
  '<a:lvl1pPr marL="0" algn="l" defTabSz="914400"><a:defRPr sz="1800" kern="1200">' +
  '<a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/>' +
  '<a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr></p:defaultTextStyle>'

export function buildPptx(spec: DeckSpec): Uint8Array<ArrayBuffer> {
  const layouts = spec.layouts ?? [layoutXml()]
  const members: Record<string, string | Uint8Array> = {}
  const overrides: string[] = [
    `<Override PartName="/ppt/presentation.xml" ContentType="${CT}.presentation.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${CT}.slideMaster+xml"/>`,
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
  ]
  members['_rels/.rels'] = rels([['rId1', 'officeDocument', 'ppt/presentation.xml']])
  const presRels: [string, string, string][] = [
    ['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'],
    ...(spec.presentationRels ?? []),
  ]
  const order = spec.order ?? spec.slides.map((_, i) => i)
  spec.slides.forEach((slide, i) => {
    const n = i + 1
    members[`ppt/slides/slide${n}.xml`] = slide.xml
    members[`ppt/slides/_rels/slide${n}.xml.rels`] = rels([
      ['rIdLayout', 'slideLayout', `../slideLayouts/slideLayout${(slide.layout ?? 0) + 1}.xml`],
      ...(slide.rels ?? []),
    ])
    overrides.push(`<Override PartName="/ppt/slides/slide${n}.xml" ContentType="${CT}.slide+xml"/>`)
    presRels.push([`rIdS${n}`, 'slide', `slides/slide${n}.xml`])
  })
  if (spec.tableStyles !== undefined) {
    members['ppt/tableStyles.xml'] = spec.tableStyles
    presRels.push(['rIdTs', 'tableStyles', 'tableStyles.xml'])
    overrides.push(
      `<Override PartName="/ppt/tableStyles.xml" ContentType="${CT}.tableStyles+xml"/>`,
    )
  }
  const sldIds = order.map((i, k) => `<p:sldId id="${256 + k}" r:id="rIdS${i + 1}"/>`).join('')
  members['ppt/presentation.xml'] =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation ${NS_DECL}${spec.presentationAttrs ?? ''}>` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>` +
    `${spec.presentationExtra ?? ''}${spec.defaultTextStyle ?? DEFAULT_TEXT_STYLE}</p:presentation>`
  members['ppt/_rels/presentation.xml.rels'] = rels(presRels)
  members['ppt/slideMasters/slideMaster1.xml'] =
    spec.master ?? masterXml({ layouts: layouts.length })
  members['ppt/slideMasters/_rels/slideMaster1.xml.rels'] = rels([
    ...layouts.map((_, i): [string, string, string] => [
      `rId${i + 1}`,
      'slideLayout',
      `../slideLayouts/slideLayout${i + 1}.xml`,
    ]),
    ['rIdTheme', 'theme', '../theme/theme1.xml'],
  ])
  layouts.forEach((layout, i) => {
    members[`ppt/slideLayouts/slideLayout${i + 1}.xml`] = layout
    members[`ppt/slideLayouts/_rels/slideLayout${i + 1}.xml.rels`] = rels([
      ['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml'],
    ])
    overrides.push(
      `<Override PartName="/ppt/slideLayouts/slideLayout${i + 1}.xml" ContentType="${CT}.slideLayout+xml"/>`,
    )
  })
  members['ppt/theme/theme1.xml'] = spec.theme ?? THEME
  members['ppt/theme/_rels/theme1.xml.rels'] = rels([['rIdBg', 'image', '../media/bg.png']])
  for (const [name, content] of Object.entries(spec.media ?? {})) members[name] = content
  members['[Content_Types].xml'] =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/>' +
    '<Default Extension="emf" ContentType="image/x-emf"/>' +
    `${overrides.join('')}</Types>`
  return buildZip(members)
}
