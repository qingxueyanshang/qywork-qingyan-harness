/** 用户附件转换为 provider 可接受的内容：图片缩放编码为图像块，视频为路径块，正文保留每个附件的名称与路径。 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { videoMetaOf } from '@qywork/agent'
import type { ContentBlock } from '@qywork/ai'
import type { Attachment } from '@qywork/core'
import { imageSizeOf, isInlineImage, isInlineVideo, mimeOf, toPosixPath } from '@qywork/core'
import { downscaleNote, shrinkImage } from '@qywork/tools'

const NEWLINE = String.fromCharCode(10)

/**
 * 附件图片缩放并编码后的结果，按「路径 + 修改时间 + 大小」缓存在进程内。
 *
 * 附件按路径引用：文件修改后键随之改变，下一轮读取的是新内容。每一轮装配都要将历史中的附件
 * 全部编码一次，不缓存时含数十张照片的会话每轮开始都要重新解码与缩放。
 * 条目数有上限，超出时丢弃最早写入的条目。
 */
const ATTACHMENT_CACHE_LIMIT = 64
const attachmentCache = new Map<string, { data: string; mime: string; note: string }>()

async function encodedAttachment(
  path: string,
  mtimeMs: number,
  size: number,
  mime: string,
): Promise<{ data: string; mime: string; note: string } | null> {
  const key = `${path}|${mtimeMs}|${size}`
  const hit = attachmentCache.get(key)
  if (hit) return hit
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) return null
  const raw = new Uint8Array(bytes)
  const fit = await shrinkImage(raw, mime)
  // 缩小发送的截图写明原图尺寸：模型只看到缩小图，不说明时会把看不清的描边、残影判为没有。
  const note = downscaleNote(imageSizeOf(raw), imageSizeOf(fit.bytes))
  const out = { data: Buffer.from(fit.bytes).toString('base64'), mime: fit.mime, note }
  if (attachmentCache.size >= ATTACHMENT_CACHE_LIMIT) {
    const oldest = attachmentCache.keys().next().value
    if (oldest !== undefined) attachmentCache.delete(oldest)
  }
  attachmentCache.set(key, out)
  return out
}

/**
 * 将附件转换为 provider 可接受的内容。
 *
 * 每一轮的图片都进入内容块，按与工具图片相同的规则缩放编码（`tools` 的 `shrinkImage`）；视频进入路径块并带上
 * 时长与画面尺寸（`videoMetaOf`，供估算），发送前由 `materialize` 读取字节。去留不在此处决定：保留的媒体超过上限时，由装配
 * （`agent` 的 `evictedMedia`）将最早的整批缩小为缩略图或替换为说明。每个附件都在正文中保留一行名称与路径，
 * 媒体被换出之后模型依据这一行找到原文件。
 *
 * 路径不按工作区裁决。`resolveInWorkspace` 的边界约束的是模型：它拦截模型自行构造
 * 的路径。附件路径来自用户在界面上的拖放、选择或粘贴，是一次显式授权，与系统文件选择器性质相同；判据
 * 是「字节是否会被发出」，而执行拖放的用户正是对此作出决定的人。
 *
 * 前提：模型不得构造附件。附件只能来自客户端操作，不能由任何工具调用产出
 * （`Attachment` 目前只来自 composer）。该前提一旦不成立，上述理由随之失效，
 * 此处必须改为按工作区裁决。
 *
 * 三种无法读取的情况都保留一行说明，不抛出错误。文件被删除、被改名、事后超过上限都可能发生。跳过该附件并
 * 在正文中保留一行说明，而不是使整轮无法启动：模型看到「此处原有一张图片，现在无法读取」仍能继续执行，
 * 收到 500 则只能重新开始。
 *
 * 大小上限不在此处判定，而在 `materialize` 时判定：路径型附件指向用户自己的文件，
 * 该文件在被引用之后仍可能继续增大，而此处只记录位置。
 */
export async function withAttachments(
  workspaceRoot: string,
  text: string,
  attachments: Attachment[],
): Promise<string | ContentBlock[]> {
  const blocks: ContentBlock[] = []
  const notes: string[] = []

  for (const a of attachments) {
    const abs = isAbsolute(a.path) ? resolve(a.path) : resolve(workspaceRoot, a.path)
    const info = await stat(abs).catch(() => null)
    if (!info?.isFile()) {
      notes.push(`（附件 ${a.name} 已不存在，跳过）`)
      continue
    }
    // 提供路径：模型无法读取时 `read_file` 会明确报告越界或不存在，而不是静默失败。
    // 附件路径在本会话中可由 `read_file` 读取（`readOnlyRoots`），缩小发送的截图据此截取局部放大。
    const line = notes.push(`（附件 ${a.name}：${toPosixPath(abs)}）`) - 1
    // 按扩展名分类，与界面附件入口使用同一判据。
    // 按 `a.type` 判定会读取历史行中按 mime 计算的旧值，两处结果不一致。
    if (isInlineVideo(a.path)) {
      blocks.push({
        type: 'video',
        mimeType: mimeOf(a.path),
        source: { kind: 'path', path: toPosixPath(abs) },
        meta: videoMetaOf(abs),
      })
      continue
    }
    if (!isInlineImage(a.path)) continue
    const fit = await encodedAttachment(abs, info.mtimeMs, info.size, mimeOf(a.path))
    if (!fit) {
      notes.push(`（附件 ${a.name} 读取失败，跳过）`)
      continue
    }
    if (fit.note) notes[line] = `（附件 ${a.name}：${toPosixPath(abs)}${fit.note}）`
    blocks.push({ type: 'image', mimeType: fit.mime, source: { kind: 'base64', data: fit.data } })
  }

  // 文本块放在最后：附件是该消息的上下文，先看附件再读要求更符合阅读顺序。
  const body = notes.length ? [text, ...notes].join(NEWLINE) : text
  if (blocks.length === 0) return body
  blocks.push({ type: 'text', text: body })
  return blocks
}
