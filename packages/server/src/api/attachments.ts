/**
 * 附件。
 *
 * **只有拿不到源路径时才落盘。** 附件在消息里只有一条路径（`core` 的 `Attachment.path`）。桌面端拖
 * 入和原生选择器给的是**源文件的绝对路径**，那种情况前端直接组装 `Attachment`，不经过这里——一个
 * 字节都不搬。
 *
 * 走到这条上传的只剩两种：剪贴板里只有位图（截图没有源文件），以及浏览器出于安全
 * 不给绝对路径。这两种「唯一的一份就在内存里」，落盘是第一次存储不是第二次。
 *
 * **落在 `~/.qywork/attachments/<会话id>/`。** 与会话库（`~/.qywork/qywork.sqlite3`）同一棵树。**这
 * 是「附件属于会话」这件事的全部实现**：删会话时按目录删（`api/conversations.ts`），不需要「扫目录
 * 找没人引用的孤儿」那套回收。
 *
 * 放在工作区里（`.qy/attachments/`）不行：会话在全局库、附件在项目里，删掉项目目录
 * 或换工作区之后会话还在而附件全断，历史只剩一行「附件已不存在」。
 *
 * 请求体直接流式写入同目录临时文件，完成后原子改名。不要先读进 ArrayBuffer；浏览器兜底上传
 * 的文件大小不应决定模型协议的媒体限制，且整块缓冲会让大视频占用等量内存。
 */

import { mkdir, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { type Attachment, attachmentTypeOf, toPosixPath } from '@qywork/core'
import { configDir } from '@qywork/runtime'
import type { ApiHandler } from './types.ts'
import { json } from './types.ts'

/**
 * 缩略图回读的上限，4 MB。
 *
 * 这不是模型输入上限：只约束 `attachmentBlobUrl()` 为一张缩略图在浏览器内存里
 * 创建多大的 Blob。原始附件照常保留，发送时由 Provider 协议决定内联还是上传。
 */
const MAX_PREVIEW_BYTES = 4 * 1024 * 1024

/** 这条会话的附件目录。删会话时整个删掉。 */
export function attachmentsDirOf(conversationId: string): string {
  return join(configDir(), 'attachments', conversationId)
}

/**
 * 会话 id 要进路径，按外部输入校验。
 *
 * 分隔符与 `..` 一律拒——它们能把写入点带到目录之外，而这个值是客户端给的。
 */
function safeConversationId(raw: string | null): string | null {
  if (!raw) return null
  if (raw.includes('/') || raw.includes('\\') || raw.includes('..')) return null
  return raw
}

/** 文件名安全化：名字由客户端给，不能让它写到目录外，也不能带控制字符。 */
function safeName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  const cleaned = base
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80)
  return cleaned || 'attachment'
}

/**
 * 把附件路径解析成绝对路径。
 *
 * **不做工作区归属判定。** 那道边界约束的是模型——它挡的是模型自己构造出来的路径；
 * 附件路径来自用户在界面上的拖 / 选 / 粘，是一次显式授权，与系统文件选择器同性质。
 * 判据是「字节会不会被发出去」，而按下拖放的正是决定这件事的那个人。
 *
 * 前提是**模型不得构造附件**：附件只能来自客户端手势，不能由任何工具调用产出。
 * 这条一旦破了，上面整段理由跟着失效。
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
    return json({ error: 'invalid', message: '附件必须挂在一条会话上' }, 422)
  }

  const mime = req.headers.get('content-type') ?? 'application/octet-stream'
  const name = safeName(decodeURIComponent(req.headers.get('x-attachment-name') ?? ''))

  // 前缀去重：同名文件反复粘贴不能互相覆盖，否则上一条消息引用的图会被下一条换掉。
  const dir = attachmentsDirOf(conversationId)
  const id = crypto.randomUUID()
  const fileName = `${id.slice(0, 8)}-${name}`
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
    // 分类按扩展名，与「发出去时内联哪些」同一份判据（`core` 的 `attachmentTypeOf`）。
    // 不按上传时的 mime：路径型附件没有 mime，两条入口必须给出同一个答案。
    type: attachmentTypeOf(name),
    name,
    mime,
    size,
    path: toPosixPath(path),
  }
  return json({ attachment })
}

/**
 * 按路径回原始字节，供界面显示缩略图。
 *
 * **回字节不回 base64 JSON**：不涨三分之一，浏览器自己管缓存，前端拿到就能
 * `createObjectURL`。`/api/files/preview` 那条只吃工作区相对路径且回 dataUri，
 * 够不着工作区外的源文件。
 */
async function serveRaw(url: URL, workspaceRoot: string): Promise<Response> {
  const rel = url.searchParams.get('path')
  if (!rel) return json({ error: 'invalid', message: '要读的路径得给' }, 422)

  const abs = resolveAttachmentPath(workspaceRoot, rel)
  const info = await stat(abs).catch(() => null)
  if (!info?.isFile()) return json({ error: 'not_found' }, 404)
  if (info.size > MAX_PREVIEW_BYTES) return json({ error: 'too_large' }, 413)

  const file = Bun.file(abs)
  return new Response(file, {
    headers: {
      'content-type': file.type || 'application/octet-stream',
      // 附件内容按路径寻址且不会原地改名，缓存一小时省掉切会话时的重复回读。
      'cache-control': 'private, max-age=3600',
    },
  })
}
