/**
 * docx 解析与逐段排版。覆盖 `load.ts`（部件定位与失败分类、无法解码的图片格式计数）、`parse/`（样式、编号、设置、字体表、节与正文）、
 * `resolve/`（样式继承与切换属性、编号计数与格式、主题字体）与 `layout.ts`（转换为 `layoutParagraph` 的输入，
 * 含字符间距、上下标、基线提升、字距调整、东亚语言、压缩标点与单双字节宽度协调的传递），
 * 以及 `../text/layout.ts` 中为编号字段补充的规则（编号对齐、编号后缀制表符、编号与正文之间的中西文间距、缺字回退）、
 * `table/layout.ts` 的 `layoutStack`（文本框中的段落不悬挂行尾标点）。
 *
 * 期望值取自 WPS 12.1 只读打开同样内容的文档后取得的结果（`Paragraph.Format`、`Range.Font`、`ListFormat.ListString`
 * 与逐字的 `Information`），不由本模块计算；少数按 ISO/IEC 29500 规定的项在用例名中注明。
 * 排版用例读取本机 Windows 字体目录中的真实文件：其他平台跳过（`skipIf`），Windows 上文件不存在时读取抛出，用例失败。
 */

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readFaces, readMetrics, readVerticalMetrics } from '../font/index.ts'
import { MATH_SETTINGS_DEFAULTS } from '../math/index.ts'
import type { TextFace } from '../text/index.ts'
import {
  type Block,
  type DocxDocument,
  layoutDocument,
  type Paragraph,
  parseDocx,
} from './index.ts'
import { ParagraphLayouter } from './layout.ts'
import { formatNumber } from './resolve/number-format.ts'
import { layoutStack, layoutTable } from './table/layout.ts'
import { buildDocx, type DocxParts, numPr, p, r, singleLevel, style, theme } from './test-helper.ts'

const DEFAULTS =
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" ' +
  'w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="21"/><w:szCs w:val="21"/></w:rPr></w:rPrDefault></w:docDefaults>' +
  style('paragraph', 'Normal', '', ' w:default="1"') +
  style('character', 'DefaultParagraphFont', '', ' w:default="1"')

const SECT_LINES =
  '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800" ' +
  'w:header="851" w:footer="992" w:gutter="0"/><w:cols w:space="425"/><w:docGrid w:type="lines" w:linePitch="312"/></w:sectPr>'

async function parse(parts: DocxParts): Promise<DocxDocument> {
  const result = await parseDocx(buildDocx(parts))
  if (!result.ok) throw new Error(`解析失败：${JSON.stringify(result.failure)}`)
  return result.value
}

function paragraphs(doc: DocxDocument): Paragraph[] {
  return doc.body.filter((b): b is Paragraph => b.kind === 'paragraph')
}

const text = (para: Paragraph) => para.runs.map((x) => x.text).join('')

describe('部件定位', () => {
  test('主文档内容类型不是 WordprocessingML 时为 corrupt(document)，XML 结构错误时为 corrupt(xml)', async () => {
    const wrong = await parseDocx(
      buildDocx({
        body: p(r('a')),
        mainType:
          'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml',
      }),
    )
    expect(wrong).toEqual({ ok: false, failure: { kind: 'corrupt', reason: 'document' } })
    const bad = await parseDocx(buildDocx({ body: '<w:p><w:r></w:p>' }))
    expect(bad).toEqual({ ok: false, failure: { kind: 'corrupt', reason: 'xml' } })
  })

  test('缺少样式、编号、设置与主题部件时按缺省值解析', async () => {
    const doc = await parse({ body: p(r('汉字Abc')) })
    const para = paragraphs(doc)[0]!
    expect(para.style).toBe('')
    expect(para.runs[0]!.props.fonts).toEqual({
      ascii: 'Calibri',
      hAnsi: 'Calibri',
      eastAsia: '宋体',
      cs: 'Times New Roman',
    })
    expect(para.runs[0]!.props.size).toBe(10.5)
    expect(doc.settings.defaultTabStop).toBe(25)
    expect(doc.sections).toHaveLength(1)
  })
})

describe('样式继承与切换属性', () => {
  const styles =
    DEFAULTS +
    style('paragraph', 'PB', '<w:basedOn w:val="Normal"/><w:rPr><w:b/></w:rPr>') +
    style('paragraph', 'PBB', '<w:basedOn w:val="PB"/><w:rPr><w:b/></w:rPr>') +
    style('paragraph', 'PBX', '<w:basedOn w:val="PB"/>') +
    style('paragraph', 'PB0', '<w:basedOn w:val="PB"/><w:rPr><w:b w:val="0"/></w:rPr>') +
    style('character', 'CB', '<w:rPr><w:b/></w:rPr>') +
    style('character', 'CB0', '<w:rPr><w:b w:val="0"/></w:rPr>') +
    style('character', 'CBB', '<w:basedOn w:val="CB"/><w:rPr><w:b/></w:rPr>') +
    style('paragraph', 'PI', '<w:rPr><w:i/></w:rPr>') +
    style('character', 'CI0', '<w:rPr><w:i w:val="0"/></w:rPr>') +
    style('paragraph', 'PC', '<w:rPr><w:caps/></w:rPr>') +
    style('character', 'CC', '<w:rPr><w:caps/></w:rPr>') +
    style('paragraph', 'Heading', '<w:rPr><w:sz w:val="32"/></w:rPr>') +
    style(
      'character',
      'HeadingChar',
      '<w:rPr><w:rFonts w:eastAsia="楷体"/><w:sz w:val="28"/></w:rPr>',
    )
  const ps = (id: string) => `<w:pStyle w:val="${id}"/>`
  const rs = (id: string) => `<w:rStyle w:val="${id}"/>`

  test('同一样式链内取最近的值，段落样式与字符样式之间按异或叠加，直接格式取绝对值', async () => {
    const doc = await parse({
      styles,
      body:
        p(r('a'), ps('PB')) +
        p(r('a', rs('CB')), ps('PB')) +
        p(r('a', `${rs('CB')}<w:b/>`), ps('PB')) +
        p(r('a'), ps('PBB')) +
        p(r('a', rs('CB')), ps('PBX')) +
        p(r('a', rs('CB')), ps('PB0')) +
        p(r('a', rs('CB0')), ps('PB')) +
        p(r('a', rs('CBB')), ps('PB')) +
        p(r('a', `${rs('CB')}<w:b w:val="0"/>`)),
    })
    expect(paragraphs(doc).map((x) => x.runs[0]!.props.bold)).toEqual([
      true,
      false,
      true,
      true,
      false,
      true,
      true,
      false,
      false,
    ])
  })

  test('斜体与全部大写同样按异或叠加', async () => {
    const doc = await parse({
      styles,
      body: p(r('a', rs('CI0')), ps('PI')) + p(r('a', rs('CC')), ps('PC')) + p(r('a'), ps('PC')),
    })
    const [i, cc, c] = paragraphs(doc).map((x) => x.runs[0]!.props)
    expect(i!.italic).toBe(true)
    expect(cc!.caps).toBe(false)
    expect(c!.caps).toBe(true)
  })

  test('文档默认为真时切换属性恒为真，只有直接格式可以关闭（ISO/IEC 29500 §17.7.3）', async () => {
    const doc = await parse({
      styles:
        '<w:docDefaults><w:rPrDefault><w:rPr><w:b/></w:rPr></w:rPrDefault></w:docDefaults>' +
        style('paragraph', 'PB', '<w:rPr><w:b/></w:rPr>'),
      body: p(r('a'), ps('PB')) + p(r('a', '<w:b w:val="0"/>'), ps('PB')),
    })
    expect(paragraphs(doc).map((x) => x.runs[0]!.props.bold)).toEqual([true, false])
  })

  test('rStyle 指向段落样式、pStyle 指向字符样式或不存在的样式时按未指定处理，w:link 不参与解决', async () => {
    const doc = await parse({
      styles,
      body:
        p(r('a', rs('Heading'))) +
        p(r('a', rs('HeadingChar'))) +
        p(r('a'), ps('HeadingChar')) +
        p(r('a'), ps('NoSuch')) +
        p(r('a', rs('NoSuch'))),
    })
    const props = paragraphs(doc).map((x) => x.runs[0]!.props)
    expect(props.map((x) => x.size)).toEqual([10.5, 14, 10.5, 10.5, 10.5])
    expect(props[1]!.fonts.eastAsia).toBe('楷体')
    expect(paragraphs(doc).map((x) => x.style)).toEqual([
      'Normal',
      'Normal',
      'Normal',
      'Normal',
      'Normal',
    ])
  })

  test('四类字体逐类继承：样式的主题字体与直接格式的东亚字体名各自生效', async () => {
    const doc = await parse({
      styles:
        DEFAULTS +
        style(
          'paragraph',
          'PTH',
          '<w:rPr><w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia"/></w:rPr>',
        ),
      theme: theme(
        '<a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="楷体"/>',
        '<a:latin typeface="Cambria"/><a:ea typeface=""/><a:cs typeface=""/><a:font script="Hans" typeface="黑体"/>',
      ),
      body: p(r('a', '<w:rFonts w:eastAsia="仿宋"/>'), ps('PTH')),
    })
    expect(paragraphs(doc)[0]!.runs[0]!.props.fonts).toMatchObject({
      ascii: 'Cambria',
      hAnsi: 'Cambria',
      eastAsia: '仿宋',
    })
  })
})

describe('主题字体', () => {
  const minor =
    '<a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/>' +
    '<a:font script="Jpan" typeface="MS Mincho"/><a:font script="Hans" typeface="楷体"/>'
  const major =
    '<a:latin typeface="Cambria"/><a:ea typeface=""/><a:cs typeface=""/>' +
    '<a:font script="Jpan" typeface="MS Gothic"/><a:font script="Hans" typeface="黑体"/>'
  const minorRun =
    '<w:rFonts w:asciiTheme="minorHAnsi" w:hAnsiTheme="minorHAnsi" w:eastAsiaTheme="minorEastAsia" w:cstheme="minorBidi"/>'
  const majorRun =
    '<w:rFonts w:asciiTheme="majorHAnsi" w:hAnsiTheme="majorHAnsi" w:eastAsiaTheme="majorEastAsia" w:cstheme="majorBidi"/>'
  const fontsOf = async (settings: string | undefined) => {
    const parts: DocxParts = {
      styles: DEFAULTS,
      theme: theme(minor, major),
      body: p(r('a', minorRun)) + p(r('a', majorRun)),
      ...(settings === undefined ? {} : { settings }),
    }
    return paragraphs(await parse(parts)).map((x) => x.runs[0]!.props.fonts)
  }

  test('东亚主题字体为空时按 themeFontLang 的东亚语言取文种字体，缺少该设置时按 zh-CN；cs 为空时取缺省字体', async () => {
    const zh = await fontsOf('<w:themeFontLang w:val="en-US" w:eastAsia="zh-CN"/>')
    expect(zh).toEqual([
      { ascii: 'Calibri', hAnsi: 'Calibri', eastAsia: '楷体', cs: 'Times New Roman' },
      { ascii: 'Cambria', hAnsi: 'Cambria', eastAsia: '黑体', cs: 'Times New Roman' },
    ])
    const ja = await fontsOf('<w:themeFontLang w:val="en-US" w:eastAsia="ja-JP"/>')
    expect(ja.map((f) => f.eastAsia)).toEqual(['MS Mincho', 'MS Gothic'])
    expect((await fontsOf(undefined)).map((f) => f.eastAsia)).toEqual(['楷体', '黑体'])
  })

  test('未指定的字体取主题的次要字体，没有主题时取缺省字体；rPrDefault 中有 rPr 而没有字号时为 10 磅，否则为 10.5 磅', async () => {
    // WPS 实测（w7-nostyles、w7-nostyles-theme、w7-emptystyles-theme、w7-partial-theme、w7-sz-*）：有主题时东亚文字为
    // 主题的 Hans 字体（行高 14.2 磅）；空的 rPrDefault/rPr 使字号为 10 磅，只有 docDefaults 或 rPrDefault 时为 10.5 磅。
    const run = async (parts: Omit<DocxParts, 'body'>) =>
      paragraphs(await parse({ ...parts, body: p(r('汉')) }))[0]!.runs[0]!.props
    const none = await run({})
    expect(none.fonts).toEqual({
      ascii: 'Calibri',
      hAnsi: 'Calibri',
      eastAsia: '宋体',
      cs: 'Times New Roman',
    })
    expect(none.size).toBe(10.5)
    const themed = await run({ theme: theme(minor, major) })
    expect(themed.fonts).toEqual({
      ascii: 'Calibri',
      hAnsi: 'Calibri',
      eastAsia: '楷体',
      cs: 'Times New Roman',
    })
    const partial = await run({
      theme: theme(minor, major),
      styles:
        '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr></w:rPrDefault></w:docDefaults>',
    })
    expect(partial.fonts).toMatchObject({ ascii: 'Arial', eastAsia: '楷体' })
    expect(partial.size).toBe(10)
    const bare = await run({ styles: '<w:docDefaults><w:rPrDefault/></w:docDefaults>' })
    expect(bare.size).toBe(10.5)
  })

  test('同一层同时给出主题字体与字体名时取主题字体', async () => {
    const doc = await parse({
      styles: DEFAULTS,
      theme: theme(minor, major),
      body: p(
        r(
          'a',
          '<w:rFonts w:ascii="Arial" w:asciiTheme="minorHAnsi" w:eastAsia="黑体" w:eastAsiaTheme="minorEastAsia"/>',
        ),
      ),
    })
    expect(paragraphs(doc)[0]!.runs[0]!.props.fonts).toMatchObject({
      ascii: 'Calibri',
      eastAsia: '楷体',
    })
  })
})

describe('编号', () => {
  test('编号格式与 WPS 的显示一致', () => {
    const cases: [string, number[], string[]][] = [
      [
        'chineseCounting',
        [1, 10, 11, 19, 20, 21, 99, 100, 101, 110, 111, 120, 999, 1000, 1001, 1010, 10000],
        [
          '一',
          '十',
          '十一',
          '十九',
          '二十',
          '二十一',
          '九十九',
          '一百',
          '一百〇一',
          '一百一十',
          '一百一十一',
          '一百二十',
          '九百九十九',
          '一千',
          '一千〇一',
          '一千〇一十',
          '一万',
        ],
      ],
      [
        'chineseCountingThousand',
        [1100, 10001, 12345],
        ['一千一百', '一万〇一', '一万二千三百四十五'],
      ],
      ['ideographDigital', [10, 105, 2026], ['十', '一百〇五', '二千〇二十六']],
      [
        'chineseLegalSimplified',
        [1, 10, 11, 20, 100, 101, 1000, 10000],
        ['壹', '壹拾', '壹拾壹', '贰拾', '壹佰', '壹佰零壹', '壹仟', '壹万'],
      ],
      ['taiwaneseDigital', [105], ['壹佰零伍']],
      ['japaneseCounting', [1, 10, 11, 100, 1000], ['一', '十', '十一', '百', '千']],
      ['decimalEnclosedCircle', [1, 20, 21], ['①', '⑳', '21']],
      ['decimalEnclosedCircleChinese', [11, 21], ['⑪', '21']],
      ['decimalEnclosedFullstop', [1, 20, 21], ['⒈', '⒛', '21']],
      ['decimalEnclosedParen', [1, 20, 21], ['⑴', '⒇', '21']],
      ['ideographEnclosedCircle', [1, 10, 11], ['㈠', '㈩', '11']],
      ['ideographTraditional', [1, 10, 11], ['甲', '癸', '11']],
      ['ideographZodiac', [1, 12, 13], ['子', '亥', '13']],
      ['upperRoman', [4, 999, 1000, 1001], ['IV', 'CMXCIX', 'M', '1001']],
      ['lowerRoman', [9, 300], ['ix', 'ccc']],
      ['upperLetter', [1, 26, 27, 53], ['A', 'Z', 'AA', 'BA']],
      ['lowerLetter', [28], ['ab']],
      ['ordinal', [1, 2, 3, 11, 22], ['1st', '2nd', '3rd', '11th', '22nd']],
      ['decimalZero', [3, 12], ['03', '12']],
      ['decimalFullWidth', [12], ['１２']],
      ['hex', [255], ['FF']],
      ['numberInDash', [5], ['- 5 -']],
      ['none', [1], ['']],
      ['chicago', [4], ['四']],
      ['ganada', [15], ['十五']],
    ]
    for (const [format, values, expected] of cases) {
      expect(values.map((v) => formatNumber(v, format))).toEqual(expected)
    }
    expect(formatNumber(1, 'aiueo')).toBeNull()
  })

  const multi =
    '<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="multilevel"/>' +
    '<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="upperRoman"/><w:pStyle w:val="PLVL"/><w:lvlText w:val="%1."/></w:lvl>' +
    '<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:isLgl/><w:lvlText w:val="%1.%2"/></w:lvl>' +
    '<w:lvl w:ilvl="2"><w:start w:val="1"/><w:numFmt w:val="lowerLetter"/><w:lvlRestart w:val="1"/><w:lvlText w:val="%3)"/></w:lvl>' +
    '<w:lvl w:ilvl="3"><w:start w:val="1"/><w:numFmt w:val="chineseCounting"/><w:lvlRestart w:val="0"/>' +
    '<w:lvlText w:val="第%4章"/><w:suff w:val="nothing"/></w:lvl></w:abstractNum>' +
    '<w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>'

  test('多级编号：跳级后的中间级别从起始值加一，lvlRestart 指定重新计数的级别，isLgl 一律十进制', async () => {
    const seq = [0, 1, 1, 2, 2, 0, 2, 1, 2, 3, 3, 0, 3]
    const doc = await parse({
      styles: DEFAULTS + style('paragraph', 'PLVL', `<w:pPr>${numPr(1)}</w:pPr>`),
      numbering: multi,
      body:
        seq.map((l) => p(r('文'), numPr(1, l))).join('') + p(r('文'), '<w:pStyle w:val="PLVL"/>'),
    })
    expect(paragraphs(doc).map((x) => x.numbering?.text)).toEqual([
      'I.',
      '1.1',
      '1.2',
      'a)',
      'b)',
      'II.',
      'a)',
      '2.2',
      'b)',
      '第一章',
      '第二章',
      'III.',
      '第三章',
      'IV.',
    ])
    expect(paragraphs(doc)[9]!.numbering?.suffix).toBe('nothing')
  })

  test('引用同一抽象编号的 num 接续计数；startOverride 在该 num 首次出现时重新开始；lvlOverride 的 lvl 整体替换', async () => {
    const level =
      '<w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1)"/><w:pPr><w:ind w:left="420" w:hanging="420"/></w:pPr>'
    const doc = await parse({
      styles: DEFAULTS,
      numbering:
        `<w:abstractNum w:abstractNumId="2"><w:lvl w:ilvl="0">${level}</w:lvl></w:abstractNum>` +
        '<w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>' +
        '<w:num w:numId="3"><w:abstractNumId w:val="2"/></w:num>' +
        '<w:num w:numId="4"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride></w:num>' +
        '<w:num w:numId="5"><w:abstractNumId w:val="2"/><w:lvlOverride w:ilvl="0"><w:lvl w:ilvl="0"><w:start w:val="3"/>' +
        '<w:numFmt w:val="upperLetter"/><w:lvlText w:val="%1]"/></w:lvl></w:lvlOverride></w:num>',
      body: [2, 2, 3, 3, 4, 4, 2, 5, 5].map((n) => p(r('文'), numPr(n))).join(''),
    })
    const list = paragraphs(doc)
    expect(list.map((x) => x.numbering?.text)).toEqual([
      '1)',
      '2)',
      '3)',
      '4)',
      '1)',
      '2)',
      '3)',
      'D]',
      'E]',
    ])
    expect(list[0]!.props).toMatchObject({ left: 21, firstLine: -21 })
    expect(list[7]!.props).toMatchObject({ left: 0, firstLine: 0 })
  })

  test('numStyleLink 的抽象编号计数独立、级别取自链接的编号；numId 为 0 与编号样式用作 pStyle 时不编号', async () => {
    const doc = await parse({
      styles: DEFAULTS + style('numbering', 'NumStyle', `<w:pPr>${numPr(5)}</w:pPr>`),
      numbering:
        '<w:abstractNum w:abstractNumId="5"><w:styleLink w:val="NumStyle"/><w:lvl w:ilvl="0"><w:start w:val="5"/>' +
        '<w:numFmt w:val="lowerRoman"/><w:lvlText w:val="(%1)"/></w:lvl></w:abstractNum>' +
        '<w:abstractNum w:abstractNumId="6"><w:numStyleLink w:val="NumStyle"/></w:abstractNum>' +
        '<w:num w:numId="5"><w:abstractNumId w:val="5"/></w:num><w:num w:numId="6"><w:abstractNumId w:val="6"/></w:num>',
      body:
        [5, 6, 6].map((n) => p(r('文'), numPr(n))).join('') +
        p(r('文'), '<w:pStyle w:val="NumStyle"/>') +
        p(r('文'), numPr(0)),
    })
    expect(paragraphs(doc).map((x) => x.numbering?.text ?? null)).toEqual([
      '(v)',
      '(v)',
      '(vi)',
      null,
      null,
    ])
  })

  test('编号的字段属性取段落标记的属性叠加级别的 rPr，不取字段的属性', async () => {
    const doc = await parse({
      styles: DEFAULTS + style('paragraph', 'PS28', '<w:rPr><w:sz w:val="28"/></w:rPr>'),
      numbering:
        singleLevel(
          1,
          '<w:start w:val="1"/><w:lvlText w:val="%1."/><w:rPr><w:sz w:val="16"/></w:rPr>',
        ) +
        singleLevel(
          2,
          '<w:start w:val="1"/><w:lvlText w:val="%1."/><w:lvlJc w:val="right"/><w:suff w:val="space"/>',
        ),
      body:
        p(r('文'), numPr(1)) +
        p(r('文'), `${numPr(2)}<w:rPr><w:sz w:val="32"/></w:rPr>`) +
        p(r('文'), `<w:pStyle w:val="PS28"/>${numPr(2)}`) +
        p(r('文', '<w:sz w:val="32"/>'), numPr(2)),
    })
    const list = paragraphs(doc)
    expect(list.map((x) => x.numbering!.props.size)).toEqual([8, 16, 14, 10.5])
    expect(list[1]!.numbering).toMatchObject({ suffix: 'space', align: 'right' })
  })

  test('未实现的编号格式按中文计数显示并计数', async () => {
    const doc = await parse({
      styles: DEFAULTS,
      numbering: singleLevel(
        1,
        '<w:start w:val="47"/><w:numFmt w:val="aiueo"/><w:lvlText w:val="%1"/>',
      ),
      body: p(r('文'), numPr(1)),
    })
    expect(paragraphs(doc)[0]!.numbering!.text).toBe('四十七')
    expect(doc.unsupported.numberFormat).toBe(1)
  })
})

describe('段落属性', () => {
  const level =
    '<w:start w:val="1"/><w:lvlText w:val="%1."/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr>'
  const styles =
    DEFAULTS +
    style('paragraph', 'PIND', '<w:pPr><w:ind w:left="1440" w:firstLine="0"/></w:pPr>') +
    style('paragraph', 'PNUM', `<w:pPr>${numPr(1)}<w:ind w:left="2160" w:hanging="0"/></w:pPr>`) +
    style('paragraph', 'PNUM2', `<w:pPr>${numPr(1)}</w:pPr>`) +
    style('paragraph', 'PS32', '<w:rPr><w:sz w:val="32"/></w:rPr>') +
    style('paragraph', 'PS28', '<w:rPr><w:sz w:val="28"/></w:rPr>') +
    style('paragraph', 'PFLC', '<w:pPr><w:ind w:firstLineChars="200"/></w:pPr>') +
    style('paragraph', 'PHANG', '<w:pPr><w:ind w:left="840" w:hanging="840"/></w:pPr>') +
    style('paragraph', 'PLINE', '<w:pPr><w:spacing w:line="480" w:lineRule="exact"/></w:pPr>') +
    style(
      'paragraph',
      'PTABS',
      '<w:pPr><w:tabs><w:tab w:val="left" w:pos="1000"/><w:tab w:val="left" w:pos="3000"/></w:tabs></w:pPr>',
    )
  const ps = (id: string) => `<w:pStyle w:val="${id}"/>`
  const indents = (list: Paragraph[]) => list.map((x) => [x.props.left, x.props.firstLine])

  test('编号来自直接格式时编号的缩进位于样式之后，来自样式时样式的缩进优先；直接格式最后', async () => {
    const doc = await parse({
      styles,
      numbering: singleLevel(1, level),
      body:
        p(r('a'), numPr(1)) +
        p(r('a'), ps('PIND') + numPr(1)) +
        p(r('a'), ps('PNUM')) +
        p(r('a'), ps('PNUM2')) +
        p(r('a'), `${ps('PNUM2')}<w:ind w:left="2880"/>`) +
        p(r('a'), `${ps('PIND')}${numPr(1)}<w:ind w:firstLine="200"/>`),
    })
    expect(indents(paragraphs(doc))).toEqual([
      [36, -18],
      [36, -18],
      [108, 0],
      [36, -18],
      [144, -18],
      [36, 10],
    ])
  })

  test('字符单位的缩进：字符数优先于缇，首行的字符单位为段落第一个字段的字号、左右为段落样式的字号；按字符的悬挂缩进与左字符数使左缩进为两者之和', async () => {
    const ind = (attrs: string, extra = '') => p(r('a'), `${extra}<w:ind ${attrs}/>`)
    const doc = await parse({
      styles,
      body:
        ind('w:firstLineChars="200"') +
        ind('w:firstLineChars="200"', ps('PS32')) +
        p(r('a') + r('b', '<w:sz w:val="32"/>'), '<w:ind w:firstLineChars="200"/>') +
        p(r('a'), `${ps('PS28')}<w:ind w:firstLineChars="200"/><w:rPr><w:sz w:val="32"/></w:rPr>`) +
        ind('w:firstLineChars="200" w:firstLine="1000"') +
        ind('w:firstLine="600"', ps('PFLC')) +
        ind('w:hanging="300"', ps('PFLC')) +
        ind('w:leftChars="200" w:left="100"') +
        ind('w:hangingChars="150"') +
        ind('w:left="840" w:hangingChars="200"') +
        ind('w:leftChars="400" w:hangingChars="200"') +
        ind('w:left="420" w:firstLineChars="-100"') +
        ind('w:left="840" w:firstLineChars="200"') +
        ind('w:left="840" w:leftChars="100" w:hanging="420"') +
        ind('w:left="840" w:firstLineChars="0" w:hanging="420"') +
        ind('w:firstLine="200"', ps('PHANG')) +
        p(r('a', '<w:sz w:val="32"/>'), '<w:ind w:firstLineChars="200" w:firstLine="640"/>') +
        p(r('a', '<w:sz w:val="36"/>'), '<w:ind w:firstLineChars="700" w:firstLine="2530"/>') +
        p(
          r('a', '<w:sz w:val="30"/>'),
          '<w:ind w:left="480" w:leftChars="200" w:firstLineChars="0"/>',
        ),
    })
    expect(indents(paragraphs(doc))).toEqual([
      [0, 21],
      [0, 32],
      [0, 21],
      [0, 28],
      [0, 21],
      [0, 21],
      [0, 21],
      [21, 0],
      [15.75, -15.75],
      [21, -21],
      [63, -21],
      [10.5, -10.5],
      [42, 21],
      [31.5, -21],
      [42, -21],
      [42, 10],
      [0, 32],
      [0, 126],
      [21, 0],
    ])
  })

  test('字符间距、上下标、基线提升、字距调整与东亚语言；首行字符单位为第一个字段的字号加两倍字符间距，上标按原字号', async () => {
    const doc = await parse({
      styles: DEFAULTS,
      body:
        p(
          r(
            'a',
            '<w:spacing w:val="20"/><w:vertAlign w:val="superscript"/><w:position w:val="-6"/>',
          ) + r('b', '<w:kern w:val="2"/><w:lang w:val="en-US" w:eastAsia="zh-CN"/>'),
          '<w:ind w:firstLineChars="200"/>',
        ) +
        p(r('a', '<w:sz w:val="24"/><w:spacing w:val="10"/>'), '<w:ind w:firstLineChars="200"/>') +
        p(
          r('1', '<w:sz w:val="24"/><w:vertAlign w:val="superscript"/>'),
          '<w:ind w:firstLineChars="200"/>',
        ),
    })
    const [a, b] = paragraphs(doc)[0]!.runs.map((x) => x.props)
    expect([a!.spacing, a!.vertAlign, a!.position, a!.kern, a!.eastAsiaLanguage]).toEqual([
      1,
      'superscript',
      -3,
      0,
      '',
    ])
    expect([b!.spacing, b!.vertAlign, b!.kern, b!.eastAsiaLanguage]).toEqual([
      0,
      'baseline',
      1,
      'zh-CN',
    ])
    // WPS 实测：12 磅间距 1 磅时为 28 磅、0.5 磅时为 26 磅，12 磅上标为 24 磅；10.5 磅间距 1 磅按同一规则为 25 磅。
    expect(paragraphs(doc).map((x) => x.props.firstLine)).toEqual([25, 26, 24])
  })

  test('右缩进的字符数优先于缇', async () => {
    const doc = await parse({
      styles,
      body: p(r('a'), '<w:ind w:rightChars="200" w:right="100"/>'),
    })
    expect(paragraphs(doc)[0]!.props.right).toBe(21)
  })

  test('段前段后：*Lines 不为 0 时取其值乘行单位，网格类型不为 default 时为 linePitch，为 default 或没有 docGrid 时为 12 磅', async () => {
    const sect = (grid: string) =>
      `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1800" w:bottom="1440" w:left="1800"/>${grid}</w:sectPr>`
    const sp = (attrs: string, section = '') => p(r('a'), `<w:spacing ${attrs}/>${section}`)
    const doc = await parse({
      styles,
      body:
        sp('w:beforeLines="100"') +
        sp('w:before="200" w:beforeLines="50"') +
        sp('w:afterLines="30"', sect('<w:docGrid w:type="lines" w:linePitch="312"/>')) +
        sp('w:beforeLines="100"', sect('<w:docGrid w:type="lines" w:linePitch="400"/>')) +
        sp('w:beforeLines="100"', sect('<w:docGrid w:linePitch="360"/>')) +
        sp('w:before="200" w:beforeLines="100"') +
        sect(''),
    })
    const list = paragraphs(doc)
    expect(list.map((x) => x.props.before)).toEqual([15.6, 7.8, 0, 20, 12, 12])
    expect(list[2]!.props.after).toBeCloseTo(4.68, 10)
    expect(list.map((x) => x.section)).toEqual([0, 0, 0, 1, 2, 3])
    expect(list.map((x) => x.props.snapToGrid)).toEqual([true, true, true, true, false, false])
  })

  test('行距：给出 line 而未给出 lineRule 时为 auto，不继承上层的规则', async () => {
    const doc = await parse({
      styles,
      body:
        p(r('a'), '<w:spacing w:line="360"/>') +
        p(r('a'), `${ps('PLINE')}<w:spacing w:line="300"/>`) +
        p(r('a'), ps('PLINE')),
    })
    expect(paragraphs(doc).map((x) => x.props.lineSpacing)).toEqual([
      { rule: 'multiple', value: 1.5 },
      { rule: 'multiple', value: 1.25 },
      { rule: 'exact', value: 24 },
    ])
  })

  test('制表位按位置合并，clear 移除继承的同位置制表位；点前导符为「.」，其余前导符计入 tabLeader', async () => {
    const doc = await parse({
      styles,
      body: p(
        r('a'),
        `${ps('PTABS')}<w:tabs><w:tab w:val="clear" w:pos="1000"/><w:tab w:val="right" w:pos="2000" w:leader="dot"/><w:tab w:val="bar" w:pos="2500"/><w:tab w:val="left" w:pos="4000" w:leader="hyphen"/></w:tabs>`,
      ),
    })
    expect(paragraphs(doc)[0]!.props.tabs).toEqual([
      { position: 100, align: 'right', leader: '.' },
      { position: 150, align: 'left', leader: null },
      { position: 200, align: 'left', leader: null },
    ])
    expect(doc.unsupported).toMatchObject({ tabLeader: 1, barTab: 1 })
  })

  test('对齐取值：start 与 end 换算为左右，kashida 类为两端对齐', async () => {
    const doc = await parse({
      styles,
      body: ['start', 'end', 'center', 'both', 'distribute', 'mediumKashida']
        .map((v) => p(r('a'), `<w:jc w:val="${v}"/>`))
        .join(''),
    })
    expect(paragraphs(doc).map((x) => x.props.align)).toEqual([
      'left',
      'right',
      'center',
      'both',
      'distribute',
      'both',
    ])
  })
})

describe('正文内容', () => {
  const fld = (type: string) => `<w:r><w:fldChar w:fldCharType="${type}"/></w:r>`
  const instr = (t: string) => `<w:r><w:instrText xml:space="preserve">${t}</w:instrText></w:r>`

  test('域只取结果文字：fldSimple、三段式、嵌套与没有结果的域；打开时重新计算的域另行计数', async () => {
    const doc = await parse({
      styles: DEFAULTS,
      body:
        p(`<w:fldSimple w:instr=" PAGE "><w:r><w:t>九</w:t></w:r></w:fldSimple>${r('后')}`) +
        p(
          `${fld('begin')}${instr(' DATE ')}${fld('separate')}${r('结果')}${fld('end')}${r('后')}`,
        ) +
        p(
          `${fld('begin')}${instr(' IF ')}${fld('begin')}${instr(' PAGE ')}${fld('separate')}${r('内')}${fld('end')}` +
            `${instr(' = 1 ')}${fld('separate')}${r('外')}${fld('end')}${r('后')}`,
        ) +
        p(`${fld('begin')}${instr(' XE "a" ')}${fld('end')}${r('后')}`) +
        p(`${r('甲')}${fld('begin')}${instr(' TOC ')}${fld('separate')}${r('乙')}`) +
        p(r('丙')) +
        p(`${r('丁')}${fld('end')}${r('戊')}`),
    })
    expect(paragraphs(doc).map(text)).toEqual([
      '九后',
      '结果后',
      '外后',
      '后',
      '甲乙',
      '丙',
      '丁戊',
    ])
    expect(doc.unsupported.dynamicField).toBe(2)
  })

  test('制表符、换行（分页符为 \\f）、不间断连字符、可选连字符与符号；没有 xml:space 时去掉首尾空白', async () => {
    const doc = await parse({
      styles: DEFAULTS,
      body:
        p(
          '<w:r><w:t>a</w:t><w:noBreakHyphen/><w:t>b</w:t><w:softHyphen/><w:t>c</w:t><w:br/><w:t>d</w:t>' +
            '<w:cr/><w:t>e</w:t><w:tab/><w:t>f</w:t><w:br w:type="page"/></w:r>',
        ) +
        p(`<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>${r('后')}`) +
        p('<w:r><w:t>  x  </w:t></w:r><w:r><w:t>a  b</w:t></w:r>'),
    })
    const [special, sym, space] = paragraphs(doc)
    expect(text(special!)).toBe('a\u2011bc\nd\ne\tf\f')
    expect(sym!.runs[0]!.text).toBe('\uf0fc')
    expect(sym!.runs[0]!.props.fonts).toEqual({
      ascii: 'Wingdings',
      hAnsi: 'Wingdings',
      eastAsia: 'Wingdings',
      cs: 'Wingdings',
    })
    expect(sym!.runs[1]!.props.fonts.ascii).toBe('Times New Roman')
    expect(text(space!)).toBe('xa  b')
    expect(doc.unsupported).toEqual({ softHyphen: 1 })
  })

  test('隐藏文字与删除的修订不显示，插入的修订显示，修订计数', async () => {
    const doc = await parse({
      styles: DEFAULTS,
      body: p(
        `${r('显')}${r('隐', '<w:vanish/>')}<w:del w:id="1"><w:r><w:delText>删</w:delText></w:r></w:del>` +
          `<w:ins w:id="2">${r('增')}</w:ins><w:hyperlink>${r('链')}</w:hyperlink>`,
      ),
    })
    expect(text(paragraphs(doc)[0]!)).toBe('显增链')
    expect(doc.unsupported.revision).toBe(2)
  })

  test('段落中的 sectPr 结束所在的节；版心按页宽减左右页边距与装订线，等宽分栏均分', async () => {
    const doc = await parse({
      styles: DEFAULTS,
      body:
        p(
          r('a'),
          '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1191" w:bottom="1134" w:left="1247" w:gutter="100"/></w:sectPr>',
        ) +
        p(r('b')) +
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/>' +
        '<w:cols w:num="2" w:space="720"/></w:sectPr>',
    })
    expect(paragraphs(doc).map((x) => x.section)).toEqual([0, 1])
    expect(doc.sections[0]!.columns).toHaveLength(1)
    expect(doc.sections[0]!.columns[0]!.width).toBeCloseTo((11906 - 1191 - 1247 - 100) / 20, 9)
    expect(doc.sections[1]!.columns).toEqual([
      { width: 216, space: 36 },
      { width: 216, space: 0 },
    ])
    expect(doc.unsupported.columns).toBe(1)
  })

  test('设置：默认制表位、doNotExpandShiftReturn、自定义禁则字符、压缩标点、单双字节宽度协调；字体表中 GB2312 与 Big5 字体', async () => {
    const doc = await parse({
      styles: DEFAULTS,
      settings:
        '<w:defaultTabStop w:val="420"/><w:characterSpacingControl w:val="compressPunctuation"/>' +
        '<w:noLineBreaksBefore w:lang="zh-CN" w:val="!)"/>' +
        '<w:compat><w:doNotExpandShiftReturn/><w:balanceSingleByteDoubleByteWidth/></w:compat>',
      fonts:
        '<w:font w:name="宋体"><w:charset w:val="86"/></w:font><w:font w:name="新細明體"><w:charset w:val="88"/></w:font>' +
        '<w:font w:name="Times New Roman"><w:charset w:val="00"/></w:font>',
      body: p(r('a')),
    })
    expect(doc.settings).toEqual({
      defaultTabStop: 21,
      expandLineBreak: false,
      noLineBreakBefore: '!)',
      noLineBreakAfter: null,
      compressPunctuation: true,
      balanceSingleByte: true,
      compatibilityMode: 0,
      evenAndOddHeaders: false,
      gridInTables: false,
      math: MATH_SETTINGS_DEFAULTS,
    })
    expect(doc.chineseCharsetFonts).toEqual(['宋体', '新細明體'])
    expect(doc.unsupported).toEqual({})
  })

  test('目录域结果中的字段不取超链接字符样式，其他字符样式与直接格式照常；目录域之外照常取超链接样式', async () => {
    // WPS：目录项（超链接样式、颜色 0563C1 与单下划线）显示为黑色无下划线；自定义字符样式的红色双下划线与直接给出的
    // 绿色照常显示；页码域（PAGEREF）结果与目录域之外的超链接样式照常显示。
    const styles =
      DEFAULTS +
      '<w:style w:type="character" w:styleId="af7"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0563C1"/><w:u w:val="single"/></w:rPr></w:style>' +
      '<w:style w:type="character" w:styleId="red"><w:name w:val="Red Char"/><w:rPr><w:color w:val="FF0000"/><w:u w:val="double"/></w:rPr></w:style>'
    const run = (t: string, rPr: string) => `<w:r><w:rPr>${rPr}</w:rPr><w:t>${t}</w:t></w:r>`
    const link = (inner: string) => `<w:hyperlink w:anchor="_Toc1">${inner}</w:hyperlink>`
    const HYP = '<w:rStyle w:val="af7"/>'
    const doc = await parse({
      styles,
      body:
        p(
          `${fld('begin')}${instr(' TOC \\o "1-3" \\h ')}${fld('separate')}${link(run('甲', HYP))}`,
        ) +
        p(link(run('乙', '<w:rStyle w:val="red"/>'))) +
        p(link(run('丙', `${HYP}<w:color w:val="00B050"/>`))) +
        p(fld('end')) +
        p(
          `${fld('begin')}${instr(' PAGEREF _Toc1 \\h ')}${fld('separate')}${run('丁', HYP)}${fld('end')}`,
        ) +
        p(link(run('戊', HYP))),
    })
    const props = paragraphs(doc).flatMap((x) => x.runs.map((rn) => rn.props))
    expect(props.map((x) => [x.color, x.underline?.style ?? null])).toEqual([
      [null, null],
      ['#ff0000', 'double'],
      ['#00b050', null],
      ['#0563c1', 'single'],
      ['#0563c1', 'single'],
    ])
  })
})

describe('未实现元素计数', () => {
  test('表格与可绘制的浮动对象不计数，表格内的段落推进编号；未实现的对象按种类计数；未开启背景显示时没有页面背景', async () => {
    const drawing = (anchor: boolean, uri: string, inner = '') =>
      `<w:r><w:drawing><wp:${anchor ? 'anchor' : 'inline'}><a:graphic><a:graphicData uri="${uri}">${inner}</a:graphicData></a:graphic></wp:${anchor ? 'anchor' : 'inline'}></w:drawing></w:r>`
    const doc = await parse({
      styles: DEFAULTS,
      numbering: singleLevel(1, '<w:start w:val="1"/><w:lvlText w:val="%1."/>'),
      before: '<w:background w:color="FFFFFF"/>',
      body:
        p(r('a'), numPr(1)) +
        `<w:tbl><w:tr><w:tc>${p(r('b'), numPr(1))}<w:tbl><w:tr><w:tc>${p(r('c'))}</w:tc></w:tr></w:tbl></w:tc></w:tr></w:tbl>` +
        p(r('d'), numPr(1)) +
        p(
          drawing(false, 'http://schemas.openxmlformats.org/drawingml/2006/picture') +
            drawing(
              true,
              'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
              '<wps:wsp><wps:txbx/></wps:wsp>',
            ) +
            drawing(false, 'http://schemas.openxmlformats.org/drawingml/2006/chart') +
            '<w:r><w:pict><v:shape/></w:pict></w:r><m:oMath><m:r><m:t>x</m:t></m:r></m:oMath>' +
            '<w:r><w:footnoteReference w:id="1"/></w:r>' +
            r('e'),
        ) +
        '<w:sectPr><w:headerReference w:type="default" r:id="rId9"/><w:footerReference w:type="default" r:id="rId10"/>' +
        '<w:docGrid w:type="linesAndChars" w:linePitch="312" w:charSpace="0"/></w:sectPr>',
    })
    expect(doc.body.map((b) => b.kind)).toEqual(['paragraph', 'table', 'paragraph', 'paragraph'])
    expect(paragraphs(doc).map((x) => x.numbering?.text ?? null)).toEqual(['1.', '3.', null])
    expect(text(paragraphs(doc)[2]!)).toBe('e')
    expect(doc.unsupported).toEqual({
      picture: 1,
      chart: 1,
      vml: 1,
      footnote: 1,
      charGrid: 1,
    })
    expect(doc.background).toBeNull()
    expect(paragraphs(doc)[2]!.anchors).toHaveLength(1)
  })

  test('影响排版的文字效果按字段计数', async () => {
    const doc = await parse({
      styles: DEFAULTS,
      body: p(
        r('a', '<w:spacing w:val="20"/>') +
          r('b', '<w:w w:val="80"/>') +
          r('c', '<w:vertAlign w:val="superscript"/>') +
          r('d', '<w:smallCaps/>') +
          r('e', '<w:em w:val="dot"/>') +
          r('f', '<w:spacing w:val="0"/><w:w w:val="100"/>'),
        '<w:framePr w:w="2000"/>',
      ),
    })
    expect(doc.unsupported).toEqual({
      characterScale: 1,
      smallCaps: 1,
      emphasisMark: 1,
      frame: 1,
    })
  })

  test('形状、图片与组合中改变外观的三维设置计入 effect；正视且不旋转、没有棱台的 scene3d 不计', async () => {
    const scene = (camera: string) =>
      `<a:scene3d><a:camera prst="${camera}"/><a:lightRig rig="threePt" dir="t"/></a:scene3d>`
    const drawing = (uri: string, inner: string) =>
      `<w:r><w:drawing><wp:anchor><a:graphic><a:graphicData uri="${uri}">${inner}</a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>`
    const wsp = (spPr: string) =>
      drawing(
        'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
        `<wps:wsp><wps:spPr><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${spPr}</wps:spPr></wps:wsp>`,
      )
    const group = drawing(
      'http://schemas.microsoft.com/office/word/2010/wordprocessingGroup',
      `<wpg:wgp><wpg:grpSpPr>${scene('isometricLeftDown')}</wpg:grpSpPr></wpg:wgp>`,
    )
    const doc = await parse({
      styles: DEFAULTS,
      body: p(
        wsp(scene('perspectiveFront')) +
          wsp(scene('orthographicFront')) +
          wsp(`${scene('orthographicFront')}<a:sp3d><a:bevelT/></a:sp3d>`) +
          group,
      ),
    })
    expect(doc.unsupported.effect).toBe(3)
  })
})

describe('分页与绘制所需的属性', () => {
  const W =
    'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
  const picture = (embed: string, extra = '') =>
    '<w:r><w:drawing><wp:inline><wp:extent cx="1270000" cy="635000"/>' +
    `<wp:effectExtent l="0" t="12700" r="0" b="25400"/>${extra}<a:graphic>` +
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">' +
    `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:blipFill><a:blip r:embed="${embed}"/></pic:blipFill></pic:pic>` +
    '</a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'

  test('字段的颜色、下划线、突出显示、底纹与双删除线；段落的分页属性、底纹与边框，未指定孤行控制时为开启', async () => {
    const doc = await parse({
      styles:
        DEFAULTS +
        style('paragraph', 'Keep', '<w:pPr><w:keepNext/><w:widowControl w:val="0"/></w:pPr>'),
      body:
        p(
          r('a', '<w:color w:val="FF0000"/><w:u w:val="double" w:color="00FF00"/>') +
            r('b', '<w:color w:val="auto"/><w:highlight w:val="yellow"/><w:dstrike/>') +
            r('c', '<w:shd w:val="clear" w:color="auto" w:fill="DDEEFF"/>') +
            r('d', '<w:shd w:val="solid" w:color="112233"/><w:u w:val="none"/>'),
        ) +
        p(r('e'), '<w:pStyle w:val="Keep"/><w:keepLines/><w:pageBreakBefore/>') +
        p(
          r('f'),
          '<w:shd w:val="clear" w:fill="EEEEEE"/><w:pBdr><w:top w:val="single" w:sz="8" w:space="2" w:color="0000FF"/>' +
            '<w:bottom w:val="none"/></w:pBdr>',
        ),
    })
    const [runs, keep, box] = paragraphs(doc)
    expect(
      runs!.runs.map((x) => [
        x.props.color,
        x.props.underline,
        x.props.highlight,
        x.props.shading,
        x.props.doubleStrike,
      ]),
    ).toEqual([
      ['#ff0000', { style: 'double', color: '#00ff00' }, null, null, false],
      [null, null, '#ffff00', null, true],
      [null, null, null, '#ddeeff', false],
      [null, null, null, '#112233', false],
    ])
    expect(runs!.props).toMatchObject({
      keepNext: false,
      keepLines: false,
      widowControl: true,
      pageBreakBefore: false,
    })
    expect(keep!.props).toMatchObject({
      keepNext: true,
      keepLines: true,
      widowControl: false,
      pageBreakBefore: true,
    })
    expect(box!.props.shading).toBe('#eeeeee')
    expect(box!.props.borders).toEqual({
      top: { style: 'single', width: 1, color: '#0000ff', space: 2 },
      bottom: null,
      left: null,
      right: null,
    })
  })

  test('分页符为 \\f、分栏符为 \\v；字段记录所在域名；节的开始方式、首页、页码与页眉页脚引用；奇偶页设置', async () => {
    const fld = (t: string) => `<w:r><w:fldChar w:fldCharType="${t}"/></w:r>`
    const doc = await parse({
      styles: DEFAULTS,
      settings: '<w:evenAndOddHeaders/>',
      body:
        p(
          `${r('a')}<w:r><w:br w:type="page"/><w:t>b</w:t><w:br w:type="column"/></w:r>` +
            `${fld('begin')}<w:r><w:instrText> PAGE \\* MERGEFORMAT </w:instrText></w:r>${fld('separate')}${r('7')}${fld('end')}`,
          '<w:sectPr><w:headerReference w:type="first" r:id="rId8"/><w:footerReference w:type="default" r:id="rId9"/>' +
            '<w:type w:val="oddPage"/><w:pgNumType w:fmt="upperRoman" w:start="3"/><w:titlePg/></w:sectPr>',
        ) + p(r('c')),
    })
    const [first] = paragraphs(doc)
    expect(first!.runs.map((x) => [x.text, x.field])).toEqual([
      ['a', null],
      ['\fb\v', null],
      ['7', 'PAGE'],
    ])
    expect(doc.settings.evenAndOddHeaders).toBe(true)
    expect(doc.sections[0]).toMatchObject({
      start: 'oddPage',
      titlePage: true,
      numberFormat: 'upperRoman',
      numberStart: 3,
      headers: { default: null, first: 'rId8', even: null },
      footers: { default: 'rId9', first: null, even: null },
    })
    expect(doc.sections[1]).toMatchObject({
      start: 'nextPage',
      titlePage: false,
      numberStart: null,
    })
  })

  test('表格：网格、单元格边距、行高与标题行、跨列与纵向合并、单元格中的段落与嵌套表格', async () => {
    const doc = await parse({
      styles: DEFAULTS,
      body:
        '<w:tbl><w:tblPr><w:tblCellMar><w:left w:w="100" w:type="dxa"/><w:right w:w="60" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
        '<w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="3000"/></w:tblGrid>' +
        `<w:tr><w:trPr><w:tblHeader/><w:trHeight w:val="400" w:hRule="exact"/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p(r('h'))}</w:tc></w:tr>` +
        `<w:tr><w:trPr><w:cantSplit/><w:trHeight w:val="300"/></w:trPr><w:tc><w:tcPr><w:vMerge w:val="restart"/></w:tcPr>${p(r('a'))}${p(r('b'))}</w:tc>` +
        `<w:tc>${p(r('c'))}<w:tbl><w:tr><w:tc>${p(r('n'))}</w:tc></w:tr></w:tbl></w:tc></w:tr>` +
        `<w:tr><w:tc><w:tcPr><w:vMerge/></w:tcPr>${p('')}</w:tc><w:tc>${p(r('d'))}</w:tc></w:tr>` +
        '</w:tbl>',
    })
    const t = doc.body[0]!
    if (t.kind !== 'table') throw new Error('不是表格')
    expect(t.grid).toEqual([100, 150])
    expect(t.margins).toEqual({ left: 5, right: 3, top: 0, bottom: 0 })
    expect(t.rows.map((row) => [row.height, row.header, row.cantSplit])).toEqual([
      [{ rule: 'exact', value: 20 }, true, false],
      [{ rule: 'atLeast', value: 15 }, false, true],
      [null, false, false],
    ])
    const content = (blocks: readonly Block[]): string =>
      blocks
        .map((b) =>
          b.kind === 'paragraph'
            ? text(b)
            : `[${b.rows.map((row) => row.cells.map((c) => content(c.content)).join(',')).join(';')}]`,
        )
        .join('|')
    expect(
      t.rows.map((row) => row.cells.map((c) => [c.span, c.vMerge, content(c.content)])),
    ).toEqual([
      [[2, null, 'h']],
      [
        [1, 'restart', 'a|b'],
        [1, null, 'c|[n]'],
      ],
      [
        [1, 'continue', ''],
        [1, null, 'd'],
      ],
    ])
    expect(doc.unsupported).toEqual({})
  })

  test('嵌入式图片：位置、对象框与图片部件；没有部件的图片与无法绘制的浮动对象计数；页眉页脚部件的段落按关系标识', async () => {
    const doc = await parse({
      styles: DEFAULTS,
      extra: [
        {
          id: 'rIdImg',
          type: 'image',
          name: 'media/image1.png',
          content: 'PNGDATA',
          contentType: 'image/png',
        },
        {
          id: 'rIdHdr',
          type: 'header',
          name: 'header1.xml',
          content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W}><w:p><w:r><w:t>页眉</w:t></w:r></w:p></w:hdr>`,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
        },
      ],
      body:
        p(`${r('前')}${picture('rIdImg')}${picture('rIdMissing')}`) +
        p(
          '<w:r><w:drawing><wp:anchor><a:graphic><a:graphicData uri="x"/></a:graphic></wp:anchor></w:drawing></w:r>',
        ) +
        '<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/></w:sectPr>',
    })
    const [withImages, anchored] = paragraphs(doc)
    expect(withImages!.images).toEqual([
      {
        run: 1,
        raise: 0,
        media: 0,
        graphic: null,
        width: 100,
        height: 50,
        effect: { left: 0, top: 1, right: 0, bottom: 2 },
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
      {
        run: 1,
        raise: 0,
        media: -1,
        graphic: null,
        width: 100,
        height: 50,
        effect: { left: 0, top: 1, right: 0, bottom: 2 },
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    ])
    expect(doc.media).toHaveLength(1)
    expect(doc.media[0]!.part).toBe('/word/media/image1.png')
    expect(doc.media[0]!.contentType).toBe('image/png')
    expect(new TextDecoder().decode(doc.media[0]!.bytes)).toBe('PNGDATA')
    expect(anchored!.anchors).toHaveLength(1)
    expect(anchored!.anchors[0]!.drawing).toBeNull()
    expect(doc.unsupported).toMatchObject({ picture: 1, drawing: 1 })
    expect(Object.keys(doc.parts)).toEqual(['rIdHdr'])
    expect(doc.parts.rIdHdr!.map((b) => (b.kind === 'paragraph' ? text(b) : ''))).toEqual(['页眉'])
  })

  test('浏览器无法解码的图片格式：每次引用计一次 imageFormat，图片仍登记为部件；页眉部件中的引用按部件计一次', async () => {
    const emf = {
      id: 'rIdEmf',
      type: 'image',
      name: 'media/image1.emf',
      content: 'EMF',
      contentType: 'image/x-emf',
    }
    const doc = await parse({
      styles: DEFAULTS,
      extra: [
        emf,
        { ...emf, id: 'rIdPng', name: 'media/image2.png', contentType: 'image/png' },
        {
          id: 'rIdHdr',
          type: 'header',
          name: 'header1.xml',
          content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:hdr ${W}><w:p>${picture('rIdEmf')}</w:p></w:hdr>`,
          contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
        },
        {
          id: 'rIdHdrRels',
          type: 'x',
          name: '_rels/header1.xml.rels',
          content:
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rIdEmf" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image1.emf"/></Relationships>',
        },
      ],
      body:
        p(picture('rIdEmf')) +
        p(picture('rIdEmf')) +
        p(picture('rIdPng')) +
        '<w:sectPr><w:headerReference w:type="default" r:id="rIdHdr"/></w:sectPr>',
    })
    expect(doc.unsupported).toEqual({ imageFormat: 3 })
    expect(doc.media.map((m) => m.part)).toEqual([
      '/word/media/image1.emf',
      '/word/media/image2.png',
    ])
  })

  test('w:object：其中 VML 形状的宽高为嵌入式对象框，图片为 v:imagedata；没有形状时计为 ole（语料 0824436d 封面）', async () => {
    // WPS（语料 0824436d）：封面第一段为 345×66.1 磅的 OLE 对象，其后各段的位置与把它当作同样大小的嵌入式图片时一致。
    const wmf = {
      id: 'rIdWmf',
      type: 'image',
      name: 'media/image1.wmf',
      content: 'WMF',
      contentType: 'image/x-wmf',
    }
    const shape =
      '<v:shape id="s1" style="height:66.1pt;width:345pt;" filled="f" stroked="f"><v:imagedata r:id="rIdWmf"/></v:shape>'
    const doc = await parse({
      styles: DEFAULTS,
      extra: [wmf],
      body:
        p(`<w:r><w:object>${shape}</w:object></w:r>`) +
        p('<w:r><w:object><o:OLEObject Type="Embed" ProgID="Word.Picture.8"/></w:object></w:r>'),
    })
    const [first, second] = doc.body
    if (first?.kind !== 'paragraph' || second?.kind !== 'paragraph') throw new Error('不是段落')
    expect(first.images).toEqual([
      {
        run: 0,
        raise: 0,
        media: 0,
        graphic: null,
        width: 345,
        height: 66.1,
        effect: { left: 0, top: 0, right: 0, bottom: 0 },
        crop: { left: 0, top: 0, right: 0, bottom: 0 },
      },
    ])
    expect(second.images).toEqual([])
    expect(doc.unsupported).toEqual({ imageFormat: 1, ole: 1 })
  })
})

describe.skipIf(process.platform !== 'win32')('排版（本机字体）', () => {
  const FONTS = join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts')
  const FILES: Record<string, string> = {
    'Times New Roman': 'times.ttf',
    宋体: 'simsun.ttc',
    Arial: 'arial.ttf',
  }
  const cache = new Map<string, TextFace>()
  const load = (file: string): TextFace => {
    let f = cache.get(file)
    if (!f) {
      const bytes = new Uint8Array(readFileSync(join(FONTS, file)))
      const sf = readFaces(bytes)[0]!
      f = { metrics: readMetrics(bytes, sf), vertical: readVerticalMetrics(bytes, sf) }
      cache.set(file, f)
    }
    return f
  }
  const source = {
    face: (name: string) =>
      FILES[name] === undefined ? null : { face: load(FILES[name]!), bold: false },
    math: () => null,
    outlines: () => null,
    get fallback() {
      return load('simsun.ttc')
    },
  }
  const SETTINGS =
    '<w:defaultTabStop w:val="420"/><w:compat><w:compatSetting w:name="compatibilityMode" w:val="14"/></w:compat>'

  /** 各段第一个正文字符相对版心左边的横坐标。 */
  const firstX = (doc: DocxDocument) =>
    layoutDocument(doc, source).paragraphs.map((pl) => {
      for (const line of pl.text.lines) {
        for (const f of line.fragments) if (pl.runs[f.run]! >= 0) return pl.left + f.x
      }
      return Number.NaN
    })

  test('编号后缀制表符在悬挂缩进的隐含制表位与默认制表位中取较近者，正文中的制表符优先取隐含制表位', async () => {
    // WPS：左缩进 50、悬挂 25 磅时三种对齐的正文都从 42 磅起；左缩进与悬挂均为 45 磅时编号「1、」之后从 21 磅起；
    // 无悬挂时取下一个默认制表位 84；正文「ab」之后的制表符取隐含制表位 45；左缩进 36、悬挂 18 时从 36 起。
    const lvl = (id: number, jc: string, ind: string, text = '%1.') =>
      singleLevel(
        id,
        `<w:start w:val="1"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="${jc}"/><w:pPr>${ind}</w:pPr>`,
      )
    const doc = await parse({
      styles: DEFAULTS,
      settings: SETTINGS,
      numbering:
        lvl(1, 'left', '<w:ind w:left="1000" w:hanging="500"/>') +
        lvl(2, 'center', '<w:ind w:left="1000" w:hanging="500"/>') +
        lvl(3, 'right', '<w:ind w:left="1000" w:hanging="500"/>') +
        lvl(4, 'left', '<w:ind w:left="900" w:hanging="900"/>', '%1、') +
        lvl(5, 'left', '<w:ind w:left="1000" w:firstLine="0"/>', '%1、') +
        lvl(6, 'left', '<w:ind w:left="720" w:hanging="360"/>'),
      body:
        [1, 2, 3, 4, 5, 6].map((n) => p(r('文'), numPr(n))).join('') +
        p('<w:r><w:t>ab</w:t><w:tab/><w:t>c</w:t></w:r>', '<w:ind w:left="900" w:hanging="900"/>'),
    })
    const xs = firstX(doc)
    expect(xs.slice(0, 6).map((x) => Math.round(x * 100) / 100)).toEqual([42, 42, 42, 21, 84, 36])
    const last = layoutDocument(doc, source).paragraphs[6]!
    const c = last.text.lines[0]!.fragments.at(-1)!
    expect(last.left + c.x).toBeCloseTo(45, 6)
  })

  test('编号居中与右对齐时向左伸出首行起点；编号与正文之间不加中西文间距', async () => {
    // WPS：首行起点 25 磅、后缀为空时，居中的「1.」之后正文从 28.95 起，右对齐的从 25 起；「第一章」之后的数字从 31.5 起。
    const lvl = (
      id: number,
      jc: string,
      text = '%1.',
      fmt = 'decimal',
      ind = '<w:ind w:left="1000" w:hanging="500"/>',
    ) =>
      singleLevel(
        id,
        `<w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="${jc}"/><w:suff w:val="nothing"/><w:pPr>${ind}</w:pPr>`,
      )
    const doc = await parse({
      styles: DEFAULTS,
      settings: SETTINGS,
      numbering:
        lvl(1, 'center') +
        lvl(2, 'right') +
        lvl(3, 'left', '第%1章', 'chineseCounting', '<w:ind w:left="0" w:firstLine="0"/>'),
      body: p(r('文'), numPr(1)) + p(r('文'), numPr(2)) + p(r('201'), numPr(3)),
    })
    const xs = firstX(doc)
    expect(xs[0]).toBeCloseTo(25 + (5.25 + 2.625) / 2, 6)
    expect(xs[1]).toBeCloseTo(25, 6)
    expect(xs[2]).toBeCloseTo(31.5, 6)
  })

  test('宋体与 Times New Roman 都缺少字形的编号按宋体的 1 em 排版', async () => {
    // WPS：编号「⑳」与空格之后正文从 13.10 起。
    const doc = await parse({
      styles: DEFAULTS,
      settings: SETTINGS,
      numbering: singleLevel(
        1,
        '<w:start w:val="20"/><w:numFmt w:val="decimalEnclosedCircle"/><w:lvlText w:val="%1"/><w:suff w:val="space"/>',
      ),
      body: p(r('文'), numPr(1)),
    })
    expect(firstX(doc)[0]).toBeCloseTo(10.5 + 2.625, 6)
  })

  test('相邻段落样式相同且设置了 contextualSpacing 时不留该侧的段间距；缺少的字体改用 fallback 并列出', async () => {
    const doc = await parse({
      styles:
        DEFAULTS +
        style(
          'paragraph',
          'PCTX',
          '<w:pPr><w:spacing w:before="240" w:after="240"/><w:contextualSpacing/></w:pPr>',
        ),
      settings: SETTINGS,
      body:
        p(r('a'), '<w:pStyle w:val="PCTX"/>') +
        p(r('b'), '<w:pStyle w:val="PCTX"/>') +
        p(r('c', '<w:rFonts w:ascii="NoSuchFont" w:hAnsi="NoSuchFont"/>')) +
        SECT_LINES,
    })
    const layout = layoutDocument(doc, source)
    expect(layout.paragraphs.map((x) => [x.spaceBefore, x.spaceAfter])).toEqual([
      [12, 0],
      [0, 12],
      [0, 0],
    ])
    expect(layout.missingFonts).toEqual(['NoSuchFont'])
    expect(layout.paragraphs[2]!.text.lines[0]!.fragments[0]!.face).toBe(source.fallback)
    expect(layout.paragraphs[0]!.width).toBeCloseTo((11906 - 3600) / 20, 9)
  })

  test('全部大写按大写字母排版', async () => {
    const doc = await parse({
      styles: DEFAULTS,
      settings: SETTINGS,
      body: p(r('abc', '<w:caps/>')) + p(r('ABC')),
    })
    const [a, b] = layoutDocument(doc, source).paragraphs
    expect(a!.text.lines[0]!.width).toBeCloseTo(b!.text.lines[0]!.width, 9)
  })

  test('文档设置的压缩标点与兼容模式、字段的字距调整与东亚语言传入排版', async () => {
    // WPS：kern 使相邻的「）：」中「）」去掉右半；压缩标点使逗号压缩到 7.3 磅以容纳第 35 个字；
    // 东亚语言为中文时越过行宽的逗号悬挂，没有该语言时连同前一字移到下一行。
    const defaults =
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" ' +
      'w:eastAsia="宋体" w:cs="Times New Roman"/><w:kern w:val="2"/><w:sz w:val="24"/><w:szCs w:val="24"/>' +
      '<w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault></w:docDefaults>' +
      style('paragraph', 'Normal', '<w:pPr><w:jc w:val="both"/></w:pPr>', ' w:default="1"')
    const H = '汉'
    const doc = await parse({
      styles: defaults,
      settings: `${SETTINGS}<w:characterSpacingControl w:val="compressPunctuation"/>`,
      body:
        p(r('字）：字')) +
        p(r(`${H.repeat(17)}，${H.repeat(37)}`)) +
        p(r(`${H.repeat(34)}，${H.repeat(20)}`), '<w:ind w:right="138"/>') +
        p(
          r(`${H.repeat(34)}，${H.repeat(20)}`, '<w:lang w:eastAsia=""/>'),
          '<w:ind w:right="138"/>',
        ) +
        SECT_LINES,
    })
    const [kern, squeeze, hung, plain] = layoutDocument(doc, source).paragraphs.map((x) => x.text)
    expect(kern!.lines[0]!.fragments.flatMap((f) => f.advances)).toEqual([12, 6, 12, 12])
    expect(squeeze!.lines[0]!.end - squeeze!.lines[0]!.start).toBe(35)
    expect(squeeze!.lines[0]!.fragments.flatMap((f) => f.advances)[17]).toBeCloseTo(7.3, 9)
    expect(hung!.lines[0]!.end - hung!.lines[0]!.start).toBe(35)
    expect(plain!.lines[0]!.end - plain!.lines[0]!.start).toBe(33)
    // WPS：兼容模式 14 时左对齐的段落同样悬挂，15 时不悬挂。
    const left = async (mode: number) => {
      const d = await parse({
        styles: defaults,
        settings: `<w:compat><w:compatSetting w:name="compatibilityMode" w:val="${mode}"/></w:compat>`,
        body:
          p(r(`${H.repeat(34)}，${H.repeat(20)}`), '<w:jc w:val="left"/><w:ind w:right="138"/>') +
          SECT_LINES,
      })
      const line = layoutDocument(d, source).paragraphs[0]!.text.lines[0]!
      return line.end - line.start
    }
    expect(await left(14)).toBe(35)
    expect(await left(15)).toBe(33)
  })

  test('没有粗体字形的字体加粗时每字步进增加字号的 1/256', async () => {
    // WPS：宋体 12 磅加粗时每字步进 12.047，30 磅时 30.115；常规为字号本身。
    const doc = await parse({
      styles: DEFAULTS,
      settings: SETTINGS,
      body: p(r('汉汉汉', '<w:b/><w:sz w:val="24"/>')) + p(r('汉汉汉', '<w:sz w:val="24"/>')),
    })
    const [bold, plain] = layoutDocument(doc, source).paragraphs.map(
      (x) => x.text.lines[0]!.fragments[0]!.advances[0]!,
    )
    expect(bold).toBeCloseTo(12 + 12 / 256, 9)
    expect(plain).toBe(12)
  })

  test('表格单元格中的段落不悬挂行尾标点：同样宽度与文字的正文段落悬挂逗号，单元格中逗号连同前一字移到下一行', async () => {
    // WPS：兼容模式 14 与 15 相同，单元格中显式设置 overflowPunct 也不悬挂。
    const defaults =
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" ' +
      'w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/>' +
      '<w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault></w:docDefaults>' +
      style('paragraph', 'Normal', '<w:pPr><w:jc w:val="both"/></w:pPr>', ' w:default="1"')
    const H = '汉'
    const words = `${H.repeat(34)}，${H.repeat(20)}`
    // 正文版心 415.3 磅减右缩进 6.9 磅，与单元格的文字区同为 408.4 磅（8168 缇，左右边距 0）。
    const cell =
      '<w:tbl><w:tblPr><w:tblW w:w="8168" w:type="dxa"/><w:tblLayout w:type="fixed"/>' +
      '<w:tblCellMar><w:left w:w="0" w:type="dxa"/><w:right w:w="0" w:type="dxa"/></w:tblCellMar></w:tblPr>' +
      '<w:tblGrid><w:gridCol w:w="8168"/></w:tblGrid><w:tr><w:tc><w:tcPr><w:tcW w:w="8168" w:type="dxa"/></w:tcPr>' +
      `${p(r(words), '<w:overflowPunct w:val="1"/>')}</w:tc></w:tr></w:tbl>`
    for (const mode of [14, 15]) {
      const doc = await parse({
        styles: defaults,
        settings: `<w:compat><w:compatSetting w:name="compatibilityMode" w:val="${mode}"/></w:compat>`,
        body: p(r(words), '<w:ind w:right="138"/>') + cell + p(r('后')) + SECT_LINES,
      })
      const body = layoutDocument(doc, source).paragraphs[0]!.text.lines[0]!
      const t = doc.body[1]!
      if (t.kind !== 'table') throw new Error('不是表格')
      const layouter = new ParagraphLayouter(doc, source)
      const laid = layoutTable(t, doc.sections[0]!.columns[0]!.width, {
        layouter,
        compatibilityMode: mode,
      })
      const item = laid.rows[0]!.cells[0]!.content.items[0]!
      if (item.kind !== 'paragraph') throw new Error('不是段落')
      const inCell = item.layout.text.lines[0]!
      expect([mode, body.end - body.start]).toEqual([mode, 35])
      expect([mode, inCell.end - inCell.start]).toEqual([mode, 33])
    }
  })

  test('文本框中的段落同样不悬挂行尾标点：越界的逗号连同前一字移到下一行', async () => {
    // WPS（构造文档 w11d，兼容模式 14，文本框宽 200 磅、内缩 0）：同样宽度的正文段落悬挂越界的「、，。）」，
    // 文本框中这些标点连同前一字移到下一行；doNotUseEastAsianBreakRules 与 doNotWrapTextWithPunct 不改变结果。
    const defaults =
      '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" ' +
      'w:eastAsia="宋体" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/>' +
      '<w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault></w:docDefaults>' +
      style('paragraph', 'Normal', '<w:pPr><w:jc w:val="both"/></w:pPr>', ' w:default="1"')
    const words = `${'汉'.repeat(34)}，${'汉'.repeat(20)}`
    const emu = 408.4 * 12700
    const box =
      '<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="0" distR="0" simplePos="0" relativeHeight="1" ' +
      'behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/>' +
      '<wp:positionH relativeFrom="margin"><wp:posOffset>0</wp:posOffset></wp:positionH>' +
      '<wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV>' +
      `<wp:extent cx="${emu}" cy="1828800"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapNone/>` +
      '<wp:docPr id="1" name="文本框"/><a:graphic><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">' +
      `<wps:wsp><wps:cNvSpPr txBox="1"/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu}" cy="1828800"/></a:xfrm>` +
      '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></wps:spPr>' +
      `<wps:txbx><w:txbxContent>${p(r(words))}</w:txbxContent></wps:txbx>` +
      '<wps:bodyPr wrap="square" lIns="0" tIns="0" rIns="0" bIns="0"><a:noAutofit/></wps:bodyPr>' +
      '</wps:wsp></a:graphicData></a:graphic></wp:anchor></w:drawing></w:r>'
    const doc = await parse({
      styles: defaults,
      settings: '<w:compat><w:compatSetting w:name="compatibilityMode" w:val="14"/></w:compat>',
      body: p(r(words), '<w:ind w:right="138"/>') + p(box + r('段')) + SECT_LINES,
    })
    const anchored = doc.body[1]
    if (anchored?.kind !== 'paragraph') throw new Error('不是段落')
    const shape = anchored.anchors[0]!.drawing
    if (shape?.kind !== 'shape' || shape.text === null) throw new Error('不是文本框')
    const layouter = new ParagraphLayouter(doc, source)
    const inBox = layoutStack(shape.text.content, 408.4, { layouter, compatibilityMode: 14 })
      .items[0]!
    if (inBox.kind !== 'paragraph') throw new Error('不是段落')
    const body = layoutDocument(doc, source).paragraphs[0]!.text.lines[0]!
    const line = inBox.layout.text.lines[0]!
    expect(body.end - body.start).toBe(35)
    expect(line.end - line.start).toBe(33)
  })
})
