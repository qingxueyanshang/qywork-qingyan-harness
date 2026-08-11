/**
 * Markdown 渲染的回归锁。
 *
 * 这里测的重点不是「渲染得好不好看」，是**净化没被绕过**——渲染结果原样进
 * `innerHTML`，而输入是模型输出（它可能在复述别人仓库里的 README）。
 * 一次白名单改动就能让 `<img onerror>` 活过来，而界面上看不出任何异常。
 *
 * 高亮相关的分支这里不测：`highlight.js` 是异步按需加载的，测试进程里
 * `hljsReady()` 恒为 false，走的永远是未高亮那一支。硬测会变成测桩。
 */

import { describe, expect, test } from 'bun:test'
import { renderMarkdown } from './markdown.ts'

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

describe('白名单里必须留下的东西', () => {
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
    const html = renderMarkdown('```html\n<script>alert(1)</script>\n```')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
  })

  test('& 先转义，不会产生二次实体', () => {
    expect(renderMarkdown('```\na && b\n```')).toContain('a &amp;&amp; b')
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
