/**
 * 创作广场：`/api/square/*`，以本机登录的云端账号调用云端的创作广场接口（`/v1/square/*`）。
 *
 * - `GET items`、`GET items/:id`、`GET mine`、`DELETE items/:id`：原样转交云端，应答的形状见 `@qywork/core` 的 `square.ts`。
 * - `GET files/:hash`：文件内容，按哈希保存在本机后提供（`square/files.ts`）；`content-type` 按文件头判定图片与视频。
 * - `POST install`：正文 `{ id }`，安装该条目的最新已上架版本（`square/install.ts`），返回 `{ message, canvas? }`。
 * - `POST publish`：multipart，`manifest` 为 `{ title, summary, source, itemId? }`（`source` 见 `square/publish.ts`），
 *   视频作品另带 `cover`（PNG）。打包、校验后上传，返回云端的 `{ id, version, status }`；校验不通过时 422。
 *
 * 未配置云端地址时 404；云端返回的失败按云端的状态码与说明返回，未取得云端答复时 400；安装失败以 409 或 422 返回原因。
 */

import type { SquareDetail } from '@qywork/core'
import { CanvasFailure } from '../canvas/docs.ts'
import { CloudAccountError } from '../cloud/account.ts'
import { SquareFileError, squareFileResponse } from '../square/files.ts'
import { installSquareItem } from '../square/install.ts'
import { parsePublishSource, publishToSquare } from '../square/publish.ts'
import { type ApiHandler, json } from './types.ts'

const PREFIX = '/api/square/'
/** multipart 字段中的 JSON；不是字符串或无法解析时为 null。 */
function parseJson(field: unknown): unknown {
  if (typeof field !== 'string') return null
  try {
    return JSON.parse(field)
  } catch {
    return null
  }
}
const LIST_PARAMS = ['kind', 'q', 'before'] as const

export const handleSquareApi: ApiHandler = async (url, req, d) => {
  if (!url.pathname.startsWith(PREFIX)) return null
  const account = d.cloud
  if (!account) return json({ error: 'unavailable', message: '未配置云端服务' }, 404)
  const rest = url.pathname.slice(PREFIX.length)
  const [section = '', id = '', ...extra] = rest.split('/').map(decodeURIComponent)
  if (extra.length) return null
  try {
    if (section === 'items' && !id && req.method === 'GET') {
      const query = new URLSearchParams()
      for (const key of LIST_PARAMS) {
        const value = url.searchParams.get(key)
        if (value) query.set(key, value)
      }
      return json(await account.call(`/v1/square/items?${query}`))
    }
    if (section === 'items' && id && req.method === 'GET') {
      return json(await account.call(`/v1/square/items/${encodeURIComponent(id)}`))
    }
    if (section === 'items' && id && req.method === 'DELETE') {
      await account.call(`/v1/square/items/${encodeURIComponent(id)}`, { method: 'DELETE' })
      return json({ ok: true })
    }
    if (section === 'mine' && !id && req.method === 'GET') {
      return json(await account.call('/v1/square/mine'))
    }
    if (section === 'files' && id && req.method === 'GET') {
      return await squareFileResponse(account, id, req.headers.get('range'))
    }
    if (section === 'publish' && !id && req.method === 'POST') {
      const form = await req.formData().catch(() => null)
      const manifest = parseJson(form?.get('manifest')) as {
        title?: unknown
        summary?: unknown
        itemId?: unknown
        source?: unknown
      } | null
      const source = parsePublishSource(manifest?.source)
      if (!manifest || typeof source === 'string') {
        return json(
          { error: 'invalid_request', message: typeof source === 'string' ? source : '缺少清单' },
          400,
        )
      }
      const cover = form?.get('cover')
      const result = await publishToSquare(
        {
          title: String(manifest.title ?? ''),
          summary: String(manifest.summary ?? ''),
          source,
          ...(typeof manifest.itemId === 'string' && manifest.itemId
            ? { itemId: manifest.itemId }
            : {}),
          ...(cover instanceof Blob ? { cover: new Uint8Array(await cover.arrayBuffer()) } : {}),
        },
        { account, config: d.config, workspaceRoot: d.workspaceRoot, office: d.office },
      )
      return result.ok
        ? json({ id: result.id, version: result.version, status: result.status })
        : json({ error: 'invalid', message: result.error }, 422)
    }
    if (section === 'install' && !id && req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as { id?: unknown } | null
      if (typeof body?.id !== 'string' || !body.id) {
        return json({ error: 'invalid_request', message: '缺少条目 id' }, 400)
      }
      const detail = await account.call<SquareDetail>(
        `/v1/square/items/${encodeURIComponent(body.id)}`,
      )
      const result = await installSquareItem(detail, {
        account,
        canvas: d.canvas,
        workspaceRoot: d.workspaceRoot,
      })
      return result.ok
        ? json({ message: result.message, ...(result.canvas ? { canvas: result.canvas } : {}) })
        : json({ error: 'install_failed', message: result.error }, result.status)
    }
  } catch (err) {
    // 创作广场的失败（审核状态、许可证、校验）按云端的状态码与说明返回，不加账号服务的前缀。
    if (err instanceof CloudAccountError) {
      return json(
        { error: 'cloud', message: err.reply?.message ?? err.message },
        err.reply?.status ?? 400,
      )
    }
    if (err instanceof CanvasFailure) {
      return json({ error: 'install_failed', message: err.message }, err.status)
    }
    if (err instanceof SquareFileError) return json({ error: 'file', message: err.message }, 502)
    throw err
  }
  return null
}
