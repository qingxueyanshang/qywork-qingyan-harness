import { describe, expect, test } from 'bun:test'
import type { ToolContext } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { htmlToText, parseDuckDuckGo, webFetchTool } from './web.ts'

function ctx(): ToolContext {
  return {
    workspaceRoot: '/tmp',
    conversationId: 'cv',
    runId: 'rn',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
  }
}

describe('HTML 转纯文本', () => {
  test('剥掉 script/style 的内容 —— 那不是正文', () => {
    const out = htmlToText('<p>正文</p><script>var evil = 1</script><style>.a{color:red}</style>')
    expect(out).toBe('正文')
    expect(out).not.toContain('evil')
    expect(out).not.toContain('color')
  })

  test('块级标签换成换行 —— 否则整页挤成一行', () => {
    expect(htmlToText('<p>第一段</p><p>第二段</p>')).toBe('第一段\n\n第二段')
  })

  test('列表项加前缀', () => {
    expect(htmlToText('<ul><li>甲</li><li>乙</li></ul>')).toContain('- 甲')
  })

  test('&amp; 最后替换 —— 否则 &amp;lt; 会被两步还原成标签', () => {
    // 页面里想显示的是字面量 "&lt;"，不是一个 < 号。
    expect(htmlToText('<p>&amp;lt;script&amp;gt;</p>')).toBe('&lt;script&gt;')
  })

  test('常见实体还原', () => {
    expect(htmlToText('<p>a&nbsp;b &quot;c&quot; &#39;d&#39;</p>')).toBe('a b "c" \'d\'')
  })

  test('注释被剥掉', () => {
    expect(htmlToText('<p>见<!-- 内部备注 -->正文</p>')).toBe('见正文')
  })

  test('多余空行压成两个', () => {
    expect(htmlToText('<p>a</p><br><br><br><br><p>b</p>')).toBe('a\n\nb')
  })
})

describe('搜索结果解析', () => {
  const page = `
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fdocs&rut=x">示例 <b>文档</b></a>
    <a class="result__snippet" href="#">这是一段摘要</a>
    <a class="result__a" href="/l/?uddg=https%3A%2F%2Fother.dev%2Fapi">另一个结果</a>
  `

  test('解出跳转背后的真实地址', () => {
    const hits = parseDuckDuckGo(page, 10)
    expect(hits).toHaveLength(2)
    // 把跳转链接交给模型，它下一步会抓到跳转页而不是目标页。
    expect(hits[0]!.url).toBe('https://example.com/docs')
    expect(hits[1]!.url).toBe('https://other.dev/api')
  })

  test('标题里的标签被剥掉', () => {
    expect(parseDuckDuckGo(page, 10)[0]!.title).toBe('示例 文档')
  })

  test('摘要尽力取，取不到不算失败', () => {
    expect(parseDuckDuckGo(page, 10)[0]!.snippet).toBe('这是一段摘要')
    expect(parseDuckDuckGo(page, 10)[1]!.snippet).toBe('')
  })

  test('limit 生效', () => {
    expect(parseDuckDuckGo(page, 1)).toHaveLength(1)
  })

  test('空页面返回空数组而不是抛', () => {
    expect(parseDuckDuckGo('<html></html>', 10)).toEqual([])
  })
})

describe('web_fetch 的安全闸', () => {
  test('内网地址被挡，且说清是哪条规则', async () => {
    const r = await webFetchTool.fn({ url: 'http://169.254.169.254/latest/meta-data/' }, ctx())
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('blocked_by_policy')
    // 只说「失败了」的话模型会原地重试同一个地址。
    expect(r.message).toContain('cloud_metadata')
  })

  test('回环地址被挡', async () => {
    const r = await webFetchTool.fn({ url: 'http://127.0.0.1:8080/admin' }, ctx())
    expect(r.errorKind).toBe('blocked_by_policy')
  })

  test('file:// 被挡', async () => {
    const r = await webFetchTool.fn({ url: 'file:///etc/passwd' }, ctx())
    expect(r.errorKind).toBe('blocked_by_policy')
  })

  test('缺 url 直接失败', async () => {
    expect((await webFetchTool.fn({}, ctx())).status).toBe('failure')
  })

  test('声明为出网副作用 —— 要过权限闸', () => {
    expect(webFetchTool.permissionEffect).toBe('network')
  })
})
