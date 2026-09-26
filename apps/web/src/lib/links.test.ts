import { describe, expect, test } from 'bun:test'
import { localHtmlUrl, localPath, workspaceFile } from './links.ts'

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

describe('聊天中的本机文件地址', () => {
  test('相对路径去掉查询与锚点、解码后原样作工作区路径', () => {
    expect(workspaceFile('generated/20260926-000432.png', 'C:\\ws')).toBe(
      'generated/20260926-000432.png',
    )
    expect(workspaceFile('./out/%E5%9B%BE%201.png?x=1#a', 'C:\\ws')).toBe('out/图 1.png')
    expect(workspaceFile('out\\a.png', 'C:\\ws')).toBe('out/a.png')
  })

  test('绝对路径落在工作区里才换成相对路径，大小写按 Windows 不敏感', () => {
    expect(workspaceFile('C:\\WS\\generated\\a.png', 'c:\\ws')).toBe('generated/a.png')
    expect(workspaceFile('/work/generated/a.png', '/work/')).toBe('generated/a.png')
    expect(workspaceFile('D:\\other\\a.png', 'C:\\ws')).toBeNull()
    expect(workspaceFile('/workspace2/a.png', '/work')).toBeNull()
  })

  test('网址、协议地址、网络地址与页内锚点不算本机文件', () => {
    for (const href of [
      'https://example.com/a.png',
      '//example.com/a.png',
      '#scene',
      'javascript:a.png',
      'java\nscript:a.png',
      'data:image/png;base64,AAAA',
      'file:///C:/ws/a.png',
      'mailto:a@b.com',
    ]) {
      expect(localPath(href)).toBeNull()
    }
  })
})
