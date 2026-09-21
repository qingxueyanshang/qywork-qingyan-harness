/** 把 Markdown 中的本地 HTML 链接解析到所属工作区，不使用应用页面的 HTTP 地址作基准。 */
export function localHtmlUrl(href: string, workspaceRoot: string): string | null {
  const value = href.trim()
  if (!value || /\p{Cc}/u.test(value)) return null
  const windowsPath = /^[a-z]:[/\\]/i.test(value) || value.startsWith('\\\\')
  if (!windowsPath && /^[^/?#\\]*:/.test(value) && !/^file:/i.test(value)) return null
  // //host/path 是网络链接；UNC 文件路径使用反斜杠或显式 file URL。
  if (value.startsWith('//')) return null
  try {
    const url = windowsPath
      ? fileUrl(value)
      : new URL(value.replaceAll('\\', '/'), fileUrl(`${workspaceRoot.replace(/[/\\]+$/, '')}/`))
    return url.protocol === 'file:' && /\.html?$/i.test(url.pathname) ? url.href : null
  } catch {
    return null
  }
}

/** 根目录和裸 Windows 路径是文件系统字面值，其中的百分号、问号和井号不是 URL 分隔符。 */
function fileUrl(path: string): URL {
  const normalized = path.replaceAll('\\', '/')
  const encoded = encodeURI(normalized).replaceAll('?', '%3F').replaceAll('#', '%23')
  return new URL(
    normalized.startsWith('//') ? `file:${encoded}` : `file:///${encoded.replace(/^\/+/, '')}`,
  )
}
