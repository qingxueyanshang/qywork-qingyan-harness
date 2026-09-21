import { describe, expect, test } from 'bun:test'
import { localHtmlUrl } from './links.ts'

describe('聊天中的本地 HTML 链接', () => {
  test('相对路径以工作区为基准，保留编码、查询和锚点', () => {
    expect(localHtmlUrl('flying-bird.html', 'C:\\项目 空格\\ces1')).toBe(
      'file:///C:/%E9%A1%B9%E7%9B%AE%20%E7%A9%BA%E6%A0%BC/ces1/flying-bird.html',
    )
    expect(localHtmlUrl('./pages/预览%20a.html?mode=1#scene', '/work/#100%20')).toBe(
      'file:///work/%23100%2520/pages/%E9%A2%84%E8%A7%88%20a.html?mode=1#scene',
    )
  })

  test('绝对路径和 file URL 不重复拼接工作区', () => {
    expect(localHtmlUrl('C:\\a\\#100%20.html', 'C:/ws')).toBe('file:///C:/a/%23100%2520.html')
    expect(localHtmlUrl('file:///C:/a/a%20b.HTML?x=1#s', 'C:/ws')).toBe(
      'file:///C:/a/a%20b.HTML?x=1#s',
    )
    expect(localHtmlUrl('/work/page.htm', '/other')).toBe('file:///work/page.htm')
    expect(localHtmlUrl('\\\\server\\share\\page.html', 'C:/ws')).toBe(
      'file://server/share/page.html',
    )
  })

  test('网页、其他文件、页内锚点和脚本协议不当成本地 HTML', () => {
    for (const href of [
      'https://example.com/a.html',
      '//example.com/a.html',
      'readme.md',
      '#scene',
      'javascript:a.html',
      'java\nscript:a.html',
      'data:text/html,a.html',
      'mailto:a.html',
    ]) {
      expect(localHtmlUrl(href, 'C:/ws')).toBeNull()
    }
  })
})
