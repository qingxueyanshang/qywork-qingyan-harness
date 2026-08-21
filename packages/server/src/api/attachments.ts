/**
 * 附件。
 *
 * ## 只有拿不到源路径时才落盘
 *
 * 附件在消息里只有一条路径（`core` 的 `Attachment.path`）。桌面端拖入和原生选择器
 * 给的是**源文件的绝对路径**，那种情况前端直接组装 `Attachment`，根本不经过这里——
 * 一个字节都不搬。
 *
 * 走到这条上传的只剩两种：剪贴板里只有位图（截图没有源文件），以及浏览器出于安全
 * 不给绝对路径。这两种「唯一的一份就在内存里」，落盘是第一次存储不是第二次。
 *
 * ## 落在 `~/.qywork/attachments/<会话id>/`
 *
 * 与会话库（`~/.qywork/qywork.sqlite3`）同一棵树。**这是「附件属于会话」这件事的
 * 全部实现**：删会话时按目录删（`api/conversations.ts`），不需要「扫目录找没人引用
 * 的孤儿」那套回收。
 *
 * 放在工作区里（`.qy/attachments/`）不行：会话在全局库、附件在项目里，删掉项目目录
 * 或换工作区之后会话还在而附件全断，历史只剩一行「附件已不存在」。
 *
 * ## 大小上限挡在写盘之前
 *
 * 超限直接 413 且**一个字节都不写**。写一半再删的话，中途崩溃就会留下垃圾，
 * 而现在没有任何东西会去打扫那种垃圾。
 */

import { mkdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { type Attachment, attachmentTypeOf, toPosixPath } from '@qywork/core'
import { configDir } from '@qywork/runtime'
import type { ApiHandler } from './types.ts'
import { json } from './types.ts'

/**
 * 单个附件上限 10 MB。
 *
 * 图片要整块进模型请求体，10 MB 的 base64 约 13 MB，已经接近多数 provider 的单请求
 * 上限。再大就该让用户先压缩，而不是让他等一次注定失败的请求。
 */
const MAX_BYTES = 10 * 1024 * 1024

/**
 * 预览回读的上限，4 MB。
 *
 * 与 `files.ts` 的 `MAX_INLINE_BYTES` 是同一个数：同一张图走文件预览和走这条路
 * 不该给出两种答案。超过就不给字节，界面退回文件名 chip。
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

  const bytes = new Uint8Array(await req.arrayBuffer())
  if (bytes.byteLength === 0) return json({ error: 'invalid', message: '空文件' }, 422)
  if (bytes.byteLength > MAX_BYTES) {
    return json(
      {
        error: 'too_large',
        message: `附件最大 ${Math.floor(MAX_BYTES / 1024 / 1024)} MB，当前 ${(
          bytes.byteLength / 1024 / 1024
        ).toFixed(1)} MB——先压缩一下`,
      },
      413,
    )
  }

  // 前缀去重：同名文件反复粘贴不能互相覆盖，否则上一条消息引用的图会被下一条换掉。
  const dir = attachmentsDirOf(conversationId)
  const fileName = `${crypto.randomUUID().slice(0, 8)}-${name}`
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, fileName), bytes)

  const attachment: Attachment = {
    // 分类按扩展名，与「发出去时内联哪些」同一份判据（`core` 的 `attachmentTypeOf`）。
    // 不按上传时的 mime：路径型附件根本没有 mime，两条入口必须给出同一个答案。
    type: attachmentTypeOf(name),
    name,
    mime,
    size: bytes.byteLength,
    path: toPosixPath(join(dir, fileName)),
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
