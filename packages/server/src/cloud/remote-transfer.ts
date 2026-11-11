/**
 * 远程监听器的 JSON 响应：经隧道的字节先后经过电脑至云端、云端至手机两段线路，在本机压缩并应答条件请求。
 *
 * - 只处理状态 200、类型为 `application/json` 且尚未编码的响应；文件、媒体与界面文件原样返回。
 * - GET 响应带 `etag` 与 `cache-control: private, no-cache`：浏览器每次都携带 `if-none-match` 重新验证，
 *   内容未变时本机应答 304，正文不再经过隧道。不要改为 `max-age`：会话历史随时变化，不验证即使用会显示旧内容。
 * - `etag` 按未压缩的正文计算，压缩与否是同一个值，因此带 `vary: accept-encoding`。
 */

/** 小于该字节数的正文不压缩：gzip 的固定开销使结果不小于原文。 */
const MIN_GZIP_BYTES = 1024

export async function remoteTransfer(req: Request, res: Response): Promise<Response> {
  if (
    res.status !== 200 ||
    !res.body ||
    res.headers.has('content-encoding') ||
    !res.headers.get('content-type')?.startsWith('application/json')
  ) {
    return res
  }
  const body = new Uint8Array(await res.arrayBuffer())
  const headers = new Headers(res.headers)
  headers.append('vary', 'accept-encoding')
  if (req.method === 'GET') {
    const etag = `"${Bun.hash(body).toString(36)}"`
    headers.set('etag', etag)
    headers.set('cache-control', 'private, no-cache')
    if (req.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers })
    }
  }
  const gzip =
    body.length >= MIN_GZIP_BYTES && /\bgzip\b/.test(req.headers.get('accept-encoding') ?? '')
  if (gzip) headers.set('content-encoding', 'gzip')
  return new Response(gzip ? Bun.gzipSync(body) : body, { status: 200, headers })
}
