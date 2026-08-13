/**
 * 附件上传。
 *
 * ## 先落盘再引用
 *
 * `Attachment` 是 path 型（`core/domain/model.ts`：「外部粘贴的内容先落盘再引用，
 * 不把字节塞进消息」）。所以这条接口的职责就一个：**把字节写进工作区，
 * 回一个可以直接随消息发出去的 `Attachment`**。消息表里从头到尾只有路径。
 *
 * ## 为什么落在 `.qy/attachments/`
 *
 * `.qy/` 是权限边界——`resolveWriteInWorkspace` 挡住 agent 写它，但**读不挡**
 * （`paths.ts` 的 `PROTECTED_DIRS` 只作用于写路径）。这正好是附件要的形状：
 * 用户能放进去、会话能读出来、**agent 自己伪造不了一个附件**。
 *
 * 放在工作区根目录反而不行：那会把用户随手粘的截图混进他的源码树，
 * 还可能被 agent 的 glob 扫到当成项目文件。
 *
 * ## 目录自带 .gitignore
 *
 * **`.qy/` 不是整体忽略的**——`mcp.json` / `team.json` 是项目配置，本来就该入库
 * （见仓库根 `.gitignore` 的注释）。所以附件放进 `.qy/` 之后，用户粘的每一张截图
 * 都会跟着下一次 `git add` 进他的仓库。
 *
 * 修法是**在这个目录里放一个内容为 `*` 的 `.gitignore`**：它忽略自己，
 * 对任何工作区都成立，且不需要去改用户的根 `.gitignore`
 * （那是他的文件，我们没有理由动它）。
 *
 * ## 大小上限挡在写盘之前
 *
 * 超限直接 413 且**一个字节都不写**。写一半再删的话，中途崩溃就会在
 * `.qy/attachments/` 里留下垃圾，而那个目录没有人会去打扫。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Attachment } from '@qywork/core'
import type { ApiHandler } from './types.ts'
import { json } from './types.ts'

export const ATTACHMENT_DIR = '.qy/attachments'

/**
 * 单个附件上限 10 MB。
 *
 * 这个数不是随便定的：图片要整块进模型请求体，10 MB 的 base64 约 13 MB，
 * 已经接近多数 provider 的单请求上限。再大就该让用户先压缩，
 * 而不是让他等一次注定失败的请求。
 */
const MAX_BYTES = 10 * 1024 * 1024

/** 文件名安全化：名字由客户端给，不能让它写到目录外，也不能带控制字符。 */
function safeName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  const cleaned = base
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80)
  return cleaned || 'attachment'
}

/** 按 mime 归类。只分「图片」和「文件」两档——协议里也只有这两种用法。 */
function typeOf(mime: string): Attachment['type'] {
  return mime.startsWith('image/') ? 'image' : 'file'
}

export const handleAttachmentsApi: ApiHandler = async (url, req, d) => {
  if (url.pathname !== '/api/attachments' || req.method !== 'POST') return null

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
  const rel = `${ATTACHMENT_DIR}/${crypto.randomUUID().slice(0, 8)}-${name}`
  const dir = join(d.workspaceRoot, ATTACHMENT_DIR)
  await mkdir(dir, { recursive: true })
  await ensureIgnored(dir)
  await writeFile(join(d.workspaceRoot, rel), bytes)

  const attachment: Attachment = {
    type: typeOf(mime),
    name,
    mime,
    size: bytes.byteLength,
    // 统一用正斜杠：这个值要跨端传（手机也发得到），Windows 的反斜杠在别处会被当转义。
    path: rel,
  }
  return json({ attachment })
}

/**
 * 让附件目录忽略自己。
 *
 * 只在文件不存在时写——用户如果自己改过它（比如想留几张图入库），
 * 不该被我们覆盖回去。
 */
async function ensureIgnored(dir: string): Promise<void> {
  const f = join(dir, '.gitignore')
  if (await Bun.file(f).exists()) return
  // `*` 忽略目录内一切，`!.gitignore` 让这个文件本身留下来说明原因。
  const lines = ['# 粘贴/拖入的附件是本机数据，不入库。', '*', '!.gitignore', '']
  await writeFile(f, lines.join(String.fromCharCode(10)), 'utf8')
}
