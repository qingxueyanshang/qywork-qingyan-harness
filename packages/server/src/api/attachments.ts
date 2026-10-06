/**
 * 附件。
 *
 * 只有无法取得源路径时才写入磁盘。附件在消息中只有一条路径（`core` 的 `Attachment.path`）。桌面端拖
 * 入与原生选择器提供的是源文件的绝对路径，此时前端直接组装 `Attachment`，不经过此处，
 * 不复制任何字节。
 *
 * 经由此上传接口的只有两种情况：剪贴板中只有位图（截图没有源文件），以及浏览器出于安全原因
 * 不提供绝对路径。这两种情况下唯一的副本位于内存中，写入磁盘是第一次存储而不是第二次。
 *
 * 存放在 `~/.qywork/attachments/<会话id>/`，与会话库（`~/.qywork/qywork.sqlite3`）位于同一目录树。
 * 「附件属于会话」完全由此实现：删除会话时按目录删除（`api/conversations.ts`），无需扫描目录
 * 回收无人引用的孤儿文件。
 *
 * 不能放在工作区中（`.qy/attachments/`）：会话位于全局库而附件位于项目中，删除项目目录
 * 或更换工作区之后会话仍在而附件全部失效，历史中只剩一行「附件已不存在」。
 *
 * 请求体直接流式写入同目录的临时文件，完成后原子重命名。不要先读入 ArrayBuffer：浏览器后备上传
 * 的文件大小不应决定模型协议的媒体限制，且整块缓冲会使大视频占用等量内存。
 */

import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { type Attachment, attachmentTypeOf, toPosixPath } from '@qywork/core'
import { configDir } from '@qywork/runtime'
import type { ApiHandler } from './types.ts'
import { json } from './types.ts'

/**
 * 缩略图读取的上限，4 MB。
 *
 * 该值不是模型输入上限，只约束 `attachmentBlobUrl()` 为一张缩略图在浏览器内存中
 * 创建的 Blob 大小。原始附件照常保留，发送时由 Provider 协议决定内联或上传。
 */
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024

/** 该会话的附件目录。删除会话时整个目录一并删除。 */
export function attachmentsDirOf(conversationId: string): string {
  return join(configDir(), 'attachments', conversationId)
}

/**
 * 会话 id 会写入路径，按外部输入校验。
 *
 * 分隔符与 `..` 一律拒绝：它们能使写入位置越出目录，而该值由客户端提供。
 */
function safeConversationId(raw: string | null): string | null {
  if (!raw) return null
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) return null
  return raw
}

/** 仅安全化存储名；从尾部截取以保留扩展名，显示名称不使用此结果。 */
function safeName(name: string): string {
  const cleaned = name
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+/, '')
    .slice(-80)
  return cleaned || 'attachment'
}

/**
 * 将附件路径解析为绝对路径。
 *
 * 不做工作区归属判定。工作区边界约束的是模型，它拦截模型自行构造的路径；
 * 附件路径来自用户在界面上的拖放、选择或粘贴，是一次显式授权，与系统文件选择器性质相同。
 * 判据是「字节是否会被发出」，而执行拖放的用户正是对此作出决定的人。
 *
 * 前提是模型不得构造附件：附件只能来自客户端操作，不能由任何工具调用产出。
 * 该前提一旦不成立，上述理由随之失效。
 */
function resolveAttachmentPath(workspaceRoot: string, p: string): string {
  return isAbsolute(p) ? resolve(p) : resolve(workspaceRoot, p)
}

export const handleAttachmentsApi: ApiHandler = async (url, req, d) => {
  if (url.pathname === '/api/attachments/raw' && req.method === 'GET') {
    return serveRaw(url, d.workspaceRoot)
  }
  if (url.pathname !== '/api/attachments' || req.method !== 'POST') return null

  const conversationId = safeConversationId(url.searchParams.get('conversation'))
  if (!conversationId) {
    return json({ error: 'invalid', message: '附件必须属于一个会话' }, 422)
  }

  const mime = req.headers.get('content-type') ?? 'application/octet-stream'
  const name =
    decodeURIComponent(req.headers.get('x-attachment-name') ?? '')
      .split(/[/\\]/)
      .pop() || 'attachment'

  // 加前缀去重：多次粘贴同名文件时不得互相覆盖，否则上一条消息引用的图片会被下一条替换。
  const dir = attachmentsDirOf(conversationId)
  const id = crypto.randomUUID()
  const fileName = `${id.slice(0, 8)}-${safeName(name)}`
  const path = join(dir, fileName)
  const pending = join(dir, `.${id}.part`)
  await mkdir(dir, { recursive: true })
  if (!req.body) return json({ error: 'invalid', message: '空文件' }, 422)
  const reader = req.body.getReader()
  const writer = Bun.file(pending).writer({ highWaterMark: 1024 * 1024 })
  let size = 0
  let writerClosed = false
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      writer.write(chunk.value)
    }
    await writer.end()
    writerClosed = true
    if (size === 0) {
      await rm(pending, { force: true })
      return json({ error: 'invalid', message: '空文件' }, 422)
    }
    await rename(pending, path)
  } catch (error) {
    if (!writerClosed) {
      await Promise.resolve(
        writer.end(error instanceof Error ? error : new Error(String(error))),
      ).catch(() => {})
    }
    await rm(pending, { force: true }).catch(() => {})
    throw error
  } finally {
    reader.releaseLock()
  }

  const attachment: Attachment = {
    // 按扩展名分类，与发送时判定是否内联使用同一判据（`core` 的 `attachmentTypeOf`）。
    // 不按上传时的 mime 分类：路径型附件没有 mime，两个入口必须给出相同的结果。
    type: attachmentTypeOf(name),
    name,
    mime,
    size,
    path: toPosixPath(path),
  }
  return json({ attachment })
}

/**
 * 按路径返回原始字节，供界面显示缩略图。
 *
 * 返回字节而不是 base64 JSON：体积不增加三分之一，浏览器自行管理缓存，前端取得后即可调用
 * `createObjectURL`。`/api/files/preview` 只接受工作区相对路径且不返回字节，
 * 无法访问工作区外的源文件。
 */
async function serveRaw(url: URL, workspaceRoot: string): Promise<Response> {
  const rel = url.searchParams.get('path')
  if (!rel) return json({ error: 'invalid', message: '缺少要读取的路径' }, 422)

  const abs = resolveAttachmentPath(workspaceRoot, rel)
  const info = await stat(abs).catch(() => null)
  if (!info?.isFile()) return json({ error: 'not_found' }, 404)
  if (info.size > MAX_PREVIEW_BYTES) return json({ error: 'too_large' }, 413)

  const file = Bun.file(abs)
  return new Response(file, {
    headers: {
      'content-type': file.type || 'application/octet-stream',
      // 附件内容按路径寻址且不会原地重命名，缓存一小时可避免切换会话时重复读取。
      'cache-control': 'private, max-age=3600',
    },
  })
}
