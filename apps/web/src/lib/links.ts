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

/**
 * Markdown 里指向本机文件的地址：相对路径、Windows 或 POSIX 绝对路径。去掉查询与锚点、解码后以正斜杠返回；
 * 网址、带协议的地址、`//` 开头的网络地址与页内锚点返回 null。
 */
export function localPath(href: string): string | null {
  const value = href.trim()
  if (!value || value.startsWith('#') || value.startsWith('//') || /\p{Cc}/u.test(value))
    return null
  if (!/^[a-z]:[/\\]/i.test(value) && /^[^/?#\\]*:/.test(value)) return null
  try {
    return decodeURI(value.replace(/[?#].*$/s, '')).replaceAll('\\', '/') || null
  } catch {
    return null
  }
}

/** 本机文件地址 → 工作区相对路径，交给右侧文件预览；落在工作区外返回 null。 */
export function workspaceFile(href: string, workspaceRoot: string): string | null {
  const path = localPath(href)
  if (!path) return null
  const windows = /^[a-z]:\//i.test(path)
  if (!windows && !path.startsWith('/')) return path.replace(/^(\.\/)+/, '')
  const root = workspaceRoot.replaceAll('\\', '/').replace(/\/+$/, '')
  if (!root) return null
  const inside = windows
    ? path.toLowerCase().startsWith(`${root.toLowerCase()}/`)
    : path.startsWith(`${root}/`)
  return inside ? path.slice(root.length + 1) : null
}

/** 根目录和裸 Windows 路径是文件系统字面值，其中的百分号、问号和井号不是 URL 分隔符。 */
function fileUrl(path: string): URL {
  const normalized = path.replaceAll('\\', '/')
  const encoded = encodeURI(normalized).replaceAll('?', '%3F').replaceAll('#', '%23')
  return new URL(
    normalized.startsWith('//') ? `file:${encoded}` : `file:///${encoded.replace(/^\/+/, '')}`,
  )
}
