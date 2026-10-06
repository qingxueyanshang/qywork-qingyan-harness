/**
 * Markdown 渲染的回归测试。
 *
 * 测试重点不是渲染效果，而是净化未被绕过：渲染结果原样写入
 * `innerHTML`，而输入是模型输出（可能复述其他仓库的 README）。
 * 一次白名单改动即可使 `<img onerror>` 重新生效，而界面上没有任何异常。
 *
 * 此处不测试高亮相关的分支：`highlight.js` 异步按需加载，强行测试只能测到测试桩。
 *
 * 但不得假设它尚未加载完成。加载完成的时刻取决于同一进程中其他模块的加载耗时，
 * 断言中写死未高亮分支的形状，增加一个测试预载就会失败。涉及转义的两条测试先用
 * `unspan()` 去除高亮生成的标记再断言，两个分支下都成立。
 */

import { describe, expect, test } from 'bun:test'
import { createStreamRenderer, renderMarkdown } from './markdown.ts'

/** 去除高亮生成的 `<span>`。转义测试针对实体本身，不针对正文被拆分成几段。 */
const unspan = (html: string) => html.replace(/<\/?span[^>]*>/g, '')

describe('净化', () => {
  test('script 标签不出现在结果中', () => {
    const html = renderMarkdown('正常文字\n\n<script>alert(1)</script>')
    expect(html).not.toContain('<script')
  })

  test('img 的 onerror 事件属性被移除', () => {
    const html = renderMarkdown('<img src=x onerror="alert(1)">')
    expect(html).not.toContain('onerror')
  })

  test('常见写法的内联事件属性全部移除', () => {
    for (const attr of ['onclick', 'onload', 'onmouseover', 'onfocus']) {
      const html = renderMarkdown(`<div ${attr}="alert(1)">x</div>`)
      expect(html).not.toContain(attr)
    }
  })

  test('href 中不保留 javascript: 伪协议', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))')
    expect(html.toLowerCase()).not.toContain('javascript:')
  })

  test('iframe 不放行', () => {
    const html = renderMarkdown('<iframe src="https://example.com"></iframe>')
    expect(html).not.toContain('<iframe')
  })
})

describe('白名单中必须保留的标签', () => {
  test('保留代码块的 class，否则高亮完全失效', () => {
    const html = renderMarkdown('```js\nconst a = 1\n```')
    expect(html).toContain('class="code-block"')
    expect(html).toContain('class="hljs"')
  })

  test('语言角标按 lang 标注渲染', () => {
    expect(renderMarkdown('```rust\nfn main() {}\n```')).toContain(
      '<span class="code-lang">rust</span>',
    )
  })

  test('纯文本类语言是自动检测的噪声，不显示角标', () => {
    const fence = (lang: string) => `\`\`\`${lang}\nhello\n\`\`\``
    for (const lang of ['text', 'plaintext', 'txt', 'plain', '']) {
      expect(renderMarkdown(fence(lang))).not.toContain('code-lang')
    }
  })
  test('复制按钮不被净化移除：白名单须放行 button', () => {
    const html = renderMarkdown('```js\nconst a = 1\n```')
    expect(html).toContain('<button class="code-copy" type="button"')
    expect(html).toContain('aria-label="复制代码"')
  })

  test('没有语言角标的块同样有复制按钮', () => {
    const html = renderMarkdown('```\nhello\n```')
    expect(html).not.toContain('code-lang')
    expect(html).toContain('code-copy')
  })

  test('横向滚动由 pre 承担，工具栏位于 pre 之外，不随代码滚动', () => {
    const html = renderMarkdown('```js\nconst a = 1\n```')
    expect(html).toContain('<pre class="code-body">')
    expect(html.indexOf('code-tools')).toBeGreaterThan(html.indexOf('</pre>'))
  })
})

describe('代码块正文按字面转义', () => {
  test('代码中的标签不会成为实际的 HTML 标签', () => {
    const html = unspan(renderMarkdown('```html\n<script>alert(1)</script>\n```'))
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  test('& 优先转义，不产生重复转义的实体', () => {
    expect(unspan(renderMarkdown('```\na && b\n```'))).toContain('a &amp;&amp; b')
  })
})

describe('外部链接', () => {
  test('本地 HTML 链接的相对路径、Windows 路径和 file URL 在净化后保留', () => {
    for (const href of ['flying-bird.html', 'C:/ws/flying-bird.html', 'file:///C:/ws/a%20b.html']) {
      const md = `[预览](${href})`
      expect(renderMarkdown(md)).toContain(`href="${href}"`)
      const stream = createStreamRenderer()
      const { settled, live } = stream.push(`${md}\n\n第二段\n\n第三段\n\n第四段`)
      expect(settled + live).toContain(`href="${href}"`)
    }
  })

  test('本地链接的属性仍转义，图片 src 不放行 file 协议', () => {
    const html = renderMarkdown('[预览](<file:///C:/ws/a"onclick="alert.html>)')
    expect(html).not.toContain('"onclick=')
    expect(renderMarkdown('<img src="file:///C:/ws/a.html" onerror="alert(1)">')).not.toContain(
      'file:',
    )
    expect(renderMarkdown('[坏链接](javascript:page.html)')).not.toContain('javascript:')
    for (const href of [
      'javascript&colon;page.html',
      'javascript&#58;page.html',
      'java&#9;script:page.html',
    ]) {
      expect(renderMarkdown(`<a href="${href}">预览</a>`)).not.toContain('href=')
    }
  })

  /** 原始失败形状：生成图片后模型回复中的 `![…](generated/x.png)` 渲染为损坏的图片，`[查看原图](…)` 的地址被净化清空。 */
  test('本机文件的图片显示为路径链接，本机文件链接的地址保留；网络图片仍内嵌显示', () => {
    const md = '![设计图](generated/a.png)\n\n[查看原图](generated/a.png)'
    for (const html of [
      renderMarkdown(md),
      (() => {
        const { settled, live } = createStreamRenderer().push(`${md}\n\n第三段\n\n第四段`)
        return settled + live
      })(),
    ]) {
      expect(html).not.toContain('<img')
      expect(html).toContain(
        'href="generated/a.png" target="_blank" rel="noreferrer noopener">generated/a.png</a>',
      )
      expect(html).toContain(
        'href="generated/a.png" target="_blank" rel="noreferrer noopener">查看原图</a>',
      )
    }
    expect(renderMarkdown('![图](https://example.com/a.png)')).toContain(
      '<img src="https://example.com/a.png"',
    )
  })

  test('模型提供的链接不可信，一律在新窗口打开并断开 opener', () => {
    const html = renderMarkdown('[example](https://example.com)')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noreferrer noopener"')
  })

  test('自动链接在全角标点处截止，其后的正文不进入 href', () => {
    const html = renderMarkdown('刷新 http://localhost:8000，选「循环」开一局。')
    expect(html).toContain('href="http://localhost:8000"')
    expect(html).toContain('</a>，选「循环」开一局。</p>')
  })

  test('路径中的汉字仍属于地址', () => {
    const html = renderMarkdown('见 https://zh.wikipedia.org/wiki/中文，然后回来')
    expect(html).toContain('href="https://zh.wikipedia.org/wiki/中文"')
    expect(html).toContain('</a>，然后回来</p>')
  })

  test('流式期的增量渲染使用相同的边界', () => {
    const stream = createStreamRenderer()
    const blocks = ['刷新 http://localhost:8000，选「循环」。', '第二段', '第三段', '第四段']
    const { settled, live } = stream.push(blocks.join('\n\n'))
    expect(settled + live).toContain('href="http://localhost:8000"')
  })
})

describe('表格', () => {
  test('外层包裹 table-wrap，宽表格独立横向滚动', () => {
    const html = renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')
    expect(html).toContain('<div class="table-wrap">')
    expect(html).toContain('</table></div>')
  })
})

describe('边界输入', () => {
  test('空字符串返回空字符串，不产生任何标签', () => {
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
 * 该渲染唯一不可接受的失败是流式期渲染出与定稿不同的结构：列表编号重新从头计数、
 * 代码块被拆成两段，且没有任何报错。因此不抽样：每个用例逐字符输入，
 * 每一步都与 `renderMarkdown` 的整段结果比较。
 *
 * 用例选取跨空行的块：按空行切分的实现恰好会在这些位置切错。
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
    test(`逐字符输入：${name}`, () => {
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
   * 已知偏差：引用（use）已定稿，而定义（def）在两个块以上之后才到达。流式期保持字面文本，
   * 定稿时由整段渲染纠正。本测试锁定的是「偏差只存在于流式期」，而不是「没有偏差」。
   */
  test('相隔较远的前向引用：流式期为字面文本，定稿后为链接', () => {
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

  /** 文本变短表示内容已替换，须整份重新渲染；否则前缀会一直停留在上一份内容上。 */
  test('文本变短时整份重新渲染', () => {
    const stream = createStreamRenderer()
    stream.push('第一段\n\n第二段\n\n第三段\n')
    const chunk = stream.push('另一份\n')
    expect(chunk.reset).toBe(true)
    expect(chunk.settled + chunk.live).toBe(renderMarkdown('另一份\n', { streaming: true }))
  })

  /** 不完整的 def 不得占用引用表：marked 的引用表以先写入者为准，被占用后补全的 def 无法写入。 */
  test('不完整的 def 补全之后仍解析为链接', () => {
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
