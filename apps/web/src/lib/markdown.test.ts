/**
 * Markdown 渲染的回归锁。
 *
 * 这里测的重点不是「渲染得好不好看」，是**净化没被绕过**——渲染结果原样进
 * `innerHTML`，而输入是模型输出（它可能在复述别人仓库里的 README）。
 * 一次白名单改动就能让 `<img onerror>` 活过来，而界面上看不出任何异常。
 *
 * 高亮相关的分支这里不测：`highlight.js` 是异步按需加载的，硬测会变成测桩。
 *
 * **但不许假设它没加载完。** 它什么时候到取决于这个进程里别的模块加载花了多久，
 * 断言里写死未高亮那一支的形状，加一个测试预载就会红。关心转义的那两条用
 * `unspan()` 把高亮切出来的标记去掉再断言，两支都成立。
 */

import { describe, expect, test } from 'bun:test'
import { createStreamRenderer, renderMarkdown } from './markdown.ts'

/** 去掉高亮切出来的 `<span>`。转义测的是实体本身，不是正文被切成几段。 */
const unspan = (html: string) => html.replace(/<\/?span[^>]*>/g, '')

describe('净化', () => {
  test('script 标签不出现在结果里', () => {
    const html = renderMarkdown('正常文字\n\n<script>alert(1)</script>')
    expect(html).not.toContain('<script')
  })

  test('img 的 onerror 事件属性被摘掉', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('onerror')
  })

  test('内联事件属性一律不留 —— 挑几种常见写法', () => {
    for (const attr of ['onclick', 'onload', 'onmouseover', 'onfocus']) {
      const html = renderMarkdown(`<div ${attr}="alert(1)">x</div>`)
      expect(html).not.toContain(attr)
    }
  })

  test('javascript: 伪协议不能留在 href 里', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))')
    expect(html.toLowerCase()).not.toContain('javascript:')
  })

  test('iframe 不放行', () => {
    const html = renderMarkdown('<iframe src="https://example.com"></iframe>')
    expect(html).not.toContain('<iframe')
  })
})

describe('白名单里必须留下的标签', () => {
  test('代码块的 class 要留 —— 不放行 class 等于高亮全废', () => {
    const html = renderMarkdown('```js\nconst a = 1\n```')
    expect(html).toContain('class="code-block"')
    expect(html).toContain('class="hljs"')
  })

  test('语言角标按 lang 标注渲染', () => {
    expect(renderMarkdown('```rust\nfn main() {}\n```')).toContain(
      '<span class="code-lang">rust</span>',
    )
  })

  test('纯文本类的语言不显角标 —— 那是自动检测的噪音', () => {
    const fence = (lang: string) => `\`\`\`${lang}\nhello\n\`\`\``
    for (const lang of ['text', 'plaintext', 'txt', 'plain', '']) {
      expect(renderMarkdown(fence(lang))).not.toContain('code-lang')
    }
  })
})

describe('代码块正文按字面转义', () => {
  test('代码里的标签不会变成真标签', () => {
    const html = unspan(renderMarkdown('```html\n<script>alert(1)</script>\n```'))
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  test('& 先转义，不会产生二次实体', () => {
    expect(unspan(renderMarkdown('```\na && b\n```'))).toContain('a &amp;&amp; b')
  })
})

describe('外链', () => {
  test('一律新窗口打开并断开 opener —— 模型给的链接不可信', () => {
    const html = renderMarkdown('[example](https://example.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
  })
})

describe('表格', () => {
  test('包一层 table-wrap，让宽表自己横向滚', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('<div class="table-wrap">')
    expect(html).toContain('</table></div>')
  })
})

describe('边界输入', () => {
  test('空串直接回空串，不产生任何标签', () => {
    expect(renderMarkdown('')).toBe('')
  })

  test('未闭合的代码围栏不抛异常', () => {
    expect(() => renderMarkdown('```js\nconst a = 1')).not.toThrow()
  })

  test('流式与定稿两种模式对同一段纯文本给出同样的结果', () => {
    const src = '# 标题\n\n一段话。'
    expect(renderMarkdown(src, { streaming: true })).toBe(renderMarkdown(src))
  })
})

/**
 * 流式增量渲染与整段渲染必须逐字相等。
 *
 * 这套渲染唯一不可接受的失败是**流式期渲染出与定稿不同的结构**——用户会看到列表编号
 * 从头数、代码块被切成两段，而没有任何报错。所以这里不抽样：**每个用例逐字符喂**，
 * 每一步都和 `renderMarkdown` 的整段结果比。
 *
 * 用例挑的是「跨空行的块」——它们正是「按空行切」那种写法会切错的地方。
 */
describe('增量渲染与整段渲染一致', () => {
  const CASES: [string, string][] = [
    ['松散列表', '1. 一\n\n2. 二\n\n3. 三\n'],
    ['有序列表续号', '1. 甲\n\n中间一段\n\n2. 乙\n'],
    ['列表续行缩进', '1. 装依赖\n\n    bun install\n\n2. 跑\n'],
    ['缩进代码含空行', '    a\n\n    b\n\n后面一段\n'],
    ['HTML 块跨空行', '<pre>\n第一行\n\n第二行\n</pre>\n\n之后\n'],
    ['引用式链接', '见[规范][spec]说明。\n\n[spec]: https://example.com "标题"\n\n后文\n'],
    ['段落后的分隔线', '一段话\n\n---\n\n另一段\n'],
    ['围栏含空行', '```ts\nconst a = 1\n\nconst b = 2\n```\n\n后面\n'],
    ['表格', '| a | b |\n| - | - |\n| 1 | 2 |\n\n后面\n'],
    ['嵌套引用', '> 引用一\n>\n> 引用二\n\n正文\n'],
    ['典型混合', '## 标题\n\n正文 `code` **粗**。\n\n- 甲\n- 乙\n\n```js\nx()\n```\n\n收尾。\n'],
  ]

  for (const [name, doc] of CASES) {
    test(`逐字符喂：${name}`, () => {
      const stream = createStreamRenderer()
      let settledHtml = ''
      for (let i = 1; i <= doc.length; i++) {
        const chunk = stream.push(doc.slice(0, i))
        if (chunk.reset) settledHtml = ''
        settledHtml += chunk.settled
        expect(settledHtml + chunk.live).toBe(renderMarkdown(doc.slice(0, i), { streaming: true }))
      }
    })
  }

  /**
   * 已知偏差：use 已定稿、def 隔两个块以上才到。流式期保持字面文本，
   * 定稿时的整段渲染纠正它。这条锁的是「偏差只在流式期」，不是「没有偏差」。
   */
  test('远隔的前向引用：流式期是字面文本，定稿后是链接', () => {
    const doc = '见[规范][spec]。\n\n甲段\n\n乙段\n\n丙段\n\n[spec]: https://example.com\n\n尾\n'
    const stream = createStreamRenderer()
    let settledHtml = ''
    for (let i = 1; i <= doc.length; i++) {
      const chunk = stream.push(doc.slice(0, i))
      if (chunk.reset) settledHtml = ''
      settledHtml += chunk.settled
    }
    expect(settledHtml).toContain('[规范][spec]')
    expect(renderMarkdown(doc)).toContain('href="https://example.com"')
  })

  /** 文本变短说明换了一份，整份重来——否则前缀会永远停在上一份的内容上。 */
  test('文本变短时整份重来', () => {
    const stream = createStreamRenderer()
    stream.push('第一段\n\n第二段\n\n第三段\n')
    const chunk = stream.push('另一份\n')
    expect(chunk.reset).toBe(true)
    expect(chunk.settled + chunk.live).toBe(renderMarkdown('另一份\n', { streaming: true }))
  })

  /** 半截的 def 不许占住引用表：marked 那张表先到先得，占住了补全的那条就再也进不来。 */
  test('半截的 def 补全之后仍然解析成链接', () => {
    const doc = '[spec]: https://example.com\n\n见[规范][spec]。\n\n尾\n'
    const stream = createStreamRenderer()
    let settledHtml = ''
    let whole = ''
    for (let i = 1; i <= doc.length; i++) {
      const chunk = stream.push(doc.slice(0, i))
      if (chunk.reset) settledHtml = ''
      settledHtml += chunk.settled
      whole = settledHtml + chunk.live
      expect(whole).toBe(renderMarkdown(doc.slice(0, i), { streaming: true }))
    }
    expect(whole).toContain('href="https://example.com"')
  })
})
