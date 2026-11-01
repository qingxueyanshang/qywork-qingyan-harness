/**
 * 覆盖 `index.ts`（`XmlScanner` 与 `XmlSyntaxError`）：事件顺序与层数、自闭合标签、前缀与本地名、属性、
 * 实体与字符引用、换行规范化、CDATA、注释、处理指令、XML 声明、字节序标记与结构错误。
 */

import { describe, expect, test } from 'bun:test'
import { XmlScanner, XmlSyntaxError } from './index.ts'

/** 把全部事件展开为可比较的字符串，文本事件取解码后的内容。 */
function events(xml: string): string[] {
  const x = new XmlScanner(xml)
  const out: string[] = []
  for (let t = x.next(); t !== null; t = x.next()) {
    if (t === 'text') out.push(`text:${x.text}`)
    else if (t === 'start') {
      const attrs: string[] = []
      for (let i = 0; i < x.attrCount; i++) attrs.push(`${x.attrName(i)}=${x.attrValue(i)}`)
      out.push(`start:${x.name}@${x.depth}${attrs.length ? ` ${attrs.join(' ')}` : ''}`)
    } else out.push(`end:${x.name}@${x.depth}`)
  }
  return out
}

function syntaxError(xml: string): XmlSyntaxError {
  try {
    events(xml)
  } catch (e) {
    if (e instanceof XmlSyntaxError) return e
    throw e
  }
  throw new Error('期望抛出 XmlSyntaxError')
}

describe('事件', () => {
  test('开始标签、结束标签与文本依次产出，层数包含当前元素', () => {
    expect(events('<a><b>x</b>y</a>')).toEqual([
      'start:a@1',
      'start:b@2',
      'text:x',
      'end:b@2',
      'text:y',
      'end:a@1',
    ])
  })

  test('自闭合标签依次产出开始与结束', () => {
    expect(events('<a><b x="1"/><c /></a>')).toEqual([
      'start:a@1',
      'start:b@2 x=1',
      'end:b@2',
      'start:c@2',
      'end:c@2',
      'end:a@1',
    ])
  })

  test('结束事件不带属性', () => {
    const x = new XmlScanner('<a k="v"/>')
    expect(x.next()).toBe('start')
    expect(x.attr('k')).toBe('v')
    expect(x.next()).toBe('end')
    expect(x.attr('k')).toBeNull()
    expect(x.attrCount).toBe(0)
    expect(x.next()).toBeNull()
    expect(x.next()).toBeNull()
  })

  test('元素之间的空白作为文本产出，根元素之外的空白跳过', () => {
    expect(events('\n<a>\n  <b/>\n</a>\n')).toEqual([
      'start:a@1',
      'text:\n  ',
      'start:b@2',
      'end:b@2',
      'text:\n',
      'end:a@1',
    ])
  })

  test('前缀与本地名分开读取，没有前缀时前缀为空串', () => {
    const x = new XmlScanner('<x:worksheet xmlns:x="urn:x"><sheetData/></x:worksheet>')
    expect(x.next()).toBe('start')
    expect([x.name, x.prefix, x.local]).toEqual(['x:worksheet', 'x', 'worksheet'])
    expect(x.attr('xmlns:x')).toBe('urn:x')
    expect(x.next()).toBe('start')
    expect([x.name, x.prefix, x.local]).toEqual(['sheetData', '', 'sheetData'])
    x.next()
    expect(x.next()).toBe('end')
    expect([x.prefix, x.local]).toEqual(['x', 'worksheet'])
  })
})

describe('属性', () => {
  test('按限定名取值，不存在时返回 null', () => {
    const x = new XmlScanner('<c r="A1" s="3" t="s" r:id="rId1"/>')
    x.next()
    expect(x.attr('r')).toBe('A1')
    expect(x.attr('t')).toBe('s')
    expect(x.attr('r:id')).toBe('rId1')
    expect(x.attr('id')).toBeNull()
    expect(x.attr('s ')).toBeNull()
  })

  test('单引号、等号两侧空白、值中的 > 与 /', () => {
    expect(events(`<n formatCode='[>=100]0/0' a = "x" b='"'/>`)).toEqual([
      'start:n@1 formatCode=[>=100]0/0 a=x b="',
      'end:n@1',
    ])
  })

  test('实体解码，制表符与换行替换为空格，字符引用的换行保留', () => {
    const x = new XmlScanner('<a v="&lt;&amp;&gt;&quot;&apos;" w="1\t2\r\n3\n4" z="&#10;&#x9;"/>')
    x.next()
    expect(x.attr('v')).toBe(`<&>"'`)
    expect(x.attr('w')).toBe('1 2 3 4')
    expect(x.attr('z')).toBe('\n\t')
  })

  test('格式错误的属性抛出', () => {
    expect(syntaxError('<a b/>').message).toContain('属性格式错误')
    expect(syntaxError('<a b=1/>').message).toContain('缺少引号')
    expect(syntaxError('<a b="1/>').message).toContain('属性值未结束')
  })
})

describe('文本', () => {
  test('五个预定义实体与十进制、十六进制字符引用', () => {
    expect(events('<t>&lt;a&gt; &amp; &quot;&apos; &#20013;&#x6587; &#x1F600;</t>')).toEqual([
      'start:t@1',
      `text:<a> & "' 中文 \u{1F600}`,
      'end:t@1',
    ])
  })

  test('换行 CRLF 与单独的 CR 规范化为 LF，字符引用 &#13; 保留', () => {
    expect(events('<t>a\r\nb\rc&#13;d</t>')).toEqual(['start:t@1', 'text:a\nb\nc\rd', 'end:t@1'])
  })

  test('CDATA 作为文本产出，内容不做实体解码', () => {
    expect(events('<t>a<![CDATA[<b>&amp;]]]>c</t>')).toEqual([
      'start:t@1',
      'text:a',
      'text:<b>&amp;]',
      'text:c',
      'end:t@1',
    ])
  })

  test('非法实体在读取文本时抛出，未读取时不报错', () => {
    const x = new XmlScanner('<t>&nbsp;</t>')
    x.next()
    expect(x.next()).toBe('text')
    expect(() => x.text).toThrow(XmlSyntaxError)
    expect(x.next()).toBe('end')
    for (const bad of ['&#0;', '&#xD800;', '&#x110000;', '&#X41;', '&#;', '&amp', '&#12a;']) {
      const y = new XmlScanner(`<t>${bad}</t>`)
      y.next()
      y.next()
      expect(() => y.text).toThrow(XmlSyntaxError)
    }
  })
})

describe('跳过的结构', () => {
  test('XML 声明、注释、处理指令与字节序标记不产出事件', () => {
    expect(
      events(
        '﻿<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<!-- c --><a><?pi x?><!-- <b> -->t</a><!-- e -->',
      ),
    ).toEqual(['start:a@1', 'text:t', 'end:a@1'])
  })

  test('OOXML 共享字符串部件', () => {
    const xml =
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">' +
      '<si><t>纯文本</t></si>' +
      '<si><r><rPr><b/></rPr><t xml:space="preserve"> 加粗 </t></r><r><t>&amp;常规</t></r>' +
      '<rPh sb="0" eb="1"><t>ふりがな</t></rPh></si></sst>'
    const x = new XmlScanner(xml)
    const strings: string[] = []
    let current = ''
    let inPhonetic = false
    for (let t = x.next(); t !== null; t = x.next()) {
      if (t === 'start' && x.local === 'rPh') inPhonetic = true
      else if (t === 'end' && x.local === 'rPh') inPhonetic = false
      else if (t === 'text' && !inPhonetic) current += x.text
      else if (t === 'end' && x.local === 'si') {
        strings.push(current)
        current = ''
      }
    }
    expect(strings).toEqual(['纯文本', ' 加粗 &常规'])
  })
})

describe('结构错误', () => {
  test('结束标签不匹配或没有对应的开始标签', () => {
    expect(syntaxError('<a><b></a>').message).toContain('与 <b> 不匹配')
    expect(syntaxError('<a></a></b>').message).toContain('没有对应的开始标签')
  })

  test('输入结束时元素未闭合', () => {
    const e = syntaxError('<a><b>text')
    expect(e.message).toContain('<b> 未闭合')
    expect(e.offset).toBe(10)
  })

  test('标签、注释、CDATA、处理指令未结束', () => {
    expect(syntaxError('<a><b').message).toContain('未结束')
    expect(syntaxError('<a b="1"').message).toContain('未结束')
    expect(syntaxError('<a><!-- x</a>').message).toContain('注释未结束')
    expect(syntaxError('<a><![CDATA[x</a>').message).toContain('CDATA 未结束')
    expect(syntaxError('<?xml version="1.0"').message).toContain('处理指令未结束')
    expect(syntaxError('<a></a').message).toContain('结束标签未结束')
  })

  test('DTD 不支持', () => {
    expect(syntaxError('<!DOCTYPE a [<!ENTITY e "x">]><a>&e;</a>').offset).toBe(0)
  })

  test('缺少根元素、根元素之外的文本与多个根元素', () => {
    expect(syntaxError('').message).toContain('缺少根元素')
    expect(syntaxError('<?xml version="1.0"?>  ').message).toContain('缺少根元素')
    expect(syntaxError('x<a/>').message).toContain('根元素之外出现文本')
    expect(syntaxError('<a/>x').message).toContain('根元素之外出现文本')
    expect(syntaxError('<![CDATA[x]]><a/>').message).toContain('根元素之外出现 CDATA')
    expect(syntaxError('<a/><b/>').message).toContain('根元素之后出现元素')
  })

  test('标签缺少名称', () => {
    expect(syntaxError('<a>< b/></a>').message).toContain('标签缺少名称')
  })
})
