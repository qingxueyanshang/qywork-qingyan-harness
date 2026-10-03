/**
 * 覆盖范围：`writing-style.ts` 的注释与字符串提取、词表判定，以及全仓注释与非测试字符串的一次全量扫描。
 *
 * 这份测试执行 CLAUDE.md B10 与 B11：口语文字不进入仓库依靠它拦截，而非依靠人工在评审中逐条查看。
 * 失败信息给出「文件:行 + 位置 + 命中词 + 改写方向」，无需回头查规则原文。
 */

import { describe, expect, test } from 'bun:test'
import { docLines, extractComments, extractStrings, scanAll, testTitles } from './writing-style.ts'

describe('注释提取', () => {
  test('提取行注释与块注释，并保留对应行号', () => {
    const src = ['const a = 1 // 尾注释', '/*', ' * 块注释', ' */', 'const b = 2'].join('\n')
    expect(extractComments(src, true)).toEqual([
      { line: 1, text: ' 尾注释' },
      { line: 2, text: '' },
      { line: 3, text: ' * 块注释' },
      { line: 4, text: ' ' },
    ])
  })

  test('字符串里的 // 不是注释', () => {
    const src = `const url = 'https://example.com/我们'`
    expect(extractComments(src, true)).toEqual([])
  })

  test('CSS 只认块注释', () => {
    const src = 'a { color: red } /* 注释 */'
    expect(extractComments(src, false)).toEqual([{ line: 1, text: ' 注释 ' }])
  })
})

describe('字符串提取', () => {
  test('只取含汉字的字面量；注释里的引号不算字符串；模板串跨行时行号取起始行', () => {
    const src = [
      "const a = 'plain'",
      "const b = '中文提示' // 注释里的 '引号'",
      'const c = `第一行',
      '第二行`',
      'const d = "双引号文字"',
    ].join('\n')
    expect(extractStrings(src, '.ts')).toEqual([
      { line: 2, text: '中文提示' },
      { line: 3, text: '第一行\n第二行' },
      { line: 5, text: '双引号文字' },
    ])
  })

  test('Rust 的单引号是字符或生命周期，不当字符串；双引号串可跨行', () => {
    const src = ["fn f<'a>(x: &'a str) -> &'a str {", '  "第一行', '第二行"', '}'].join('\n')
    expect(extractStrings(src, '.rs')).toEqual([{ line: 2, text: '第一行\n第二行' }])
  })

  test('Python 取单行字符串，三引号块与 # 注释不算', () => {
    const src = ['"""文档字符串"""', "x = '运行失败'  # 注释 '引号'"].join('\n')
    expect(extractStrings(src, '.py')).toEqual([{ line: 2, text: '运行失败' }])
  })

  test('正则字面量里的引号不当字符串起点，之后的注释与字符串不错位', () => {
    const src = [
      "const re = s.replace(/\"(?:`[\\s\\S]|[^\"`])*\"|'(?:''|[^'])*'/g, '')",
      '// 注释',
      "const t = '中文'",
      'const half = a / b / c',
      "const u = '另一段'",
    ].join('\n')
    expect(extractStrings(src, '.ts')).toEqual([
      { line: 3, text: '中文' },
      { line: 5, text: '另一段' },
    ])
    expect(extractComments(src, true)).toEqual([{ line: 2, text: ' 注释' }])
  })

  test('JSX 标签之间的文本按界面文案取出；比较运算之后的代码不算', () => {
    const src = [
      'const ok = a > b',
      'return <button type="button">立即运行一次</button>',
      'const s = x > 0 ? 1 : 2',
    ].join('\n')
    expect(extractStrings(src, '.tsx')).toEqual([{ line: 2, text: '立即运行一次' }])
  })

  test('长于 50 字且不含中文标点的字面量视为数据，不检查', () => {
    const table =
      '啊阿埃挨哎唉哀皑癌蔼矮艾碍爱隘鞍氨安俺按暗岸胺案肮昂盎凹敖熬翱袄傲奥懊澳芭捌扒叭吧笆八疤巴拔跋靶'
    expect(extractStrings(`const t = '${table.repeat(2)}'`, '.ts')).toEqual([])
  })
})

describe('测试名', () => {
  test('取 test / it / describe 的第一个参数，含 each 与 skip；测试体里的样例字符串不取', () => {
    const src = [
      "describe('分组名', () => {",
      "  test('普通测试名', () => {",
      "    send('帮我跑一下这个')",
      '  })',
      "  test.each(['a', 'b'])('参数化 %s', () => {})",
      "  it.skip('跳过的测试', () => {})",
      '})',
    ].join('\n')
    expect(testTitles(src)).toEqual([
      { line: 1, text: '分组名' },
      { line: 2, text: '普通测试名' },
      { line: 5, text: '参数化 %s' },
      { line: 6, text: '跳过的测试' },
    ])
  })
})

describe('规则与记忆文档', () => {
  test('围栏代码、反引号片段、「」引文与标 ✗ 的反例行不算本文表述', () => {
    const src = [
      '正文一句。',
      '```',
      '代码块里的跑',
      '```',
      '引文「跑一遍」与 `跑` 都去掉。',
      '> ✗ 反例：鼠标移开还赖着。',
      '> ✓ 正例。',
    ].join('\n')
    expect(docLines(src)).toEqual([
      { line: 1, text: '正文一句。' },
      { line: 5, text: '引文与  都去掉。' },
      { line: 7, text: '> ✓ 正例。' },
    ])
  })
})

describe('全仓书面语', () => {
  /**
   * 命中即失败，没有豁免名单。
   *
   * 改写方向逐条写在 `writing-style.ts` 的词表中；无法改写通常说明该句不应出现在此处。
   */
  test('注释、非测试字符串与规则记忆文档里不出现口语、第一人称自述、拟人比喻、场景铺陈与外部出处', () => {
    const lines = scanAll().map((v) => `${v.file}:${v.line} ${v.kind}「${v.word}」 → ${v.hint}`)
    expect(lines).toEqual([])
  })
})
