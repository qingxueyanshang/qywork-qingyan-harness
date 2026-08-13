/**
 * 附件目录的回收。
 *
 * ## 判据是「有没有被引用」，不是「有多久」
 *
 * 附件从上传到被消息引用只隔几秒（上传 → 挂在草稿上 → 发送）。所以
 * **没有任何消息引用它，就说明那条消息从来没发出去**——用户选了图、
 * 改主意了、或者关掉了窗口。那份字节永远不会再被读到。
 *
 * 按时间清理反而危险：一条三个月前的消息里的图仍然要能被重放
 * （历史投影会把它读回请求里）。**被引用的一律留下，不看年龄。**
 *
 * ## 只在启动时跑
 *
 * 运行期跑会误删「刚上传、还挂在输入框上没发出去」的那一份——那时它确实
 * 没有任何消息引用，但用户正要用它。启动时不存在这种未提交状态。
 *
 * ## 删不掉不是错误
 *
 * 文件被占用、权限不足、目录不存在都可能发生。GC 失败**不该阻断服务启动**——
 * 它回收的是磁盘空间，不是正确性。
 */

import { readdir, stat, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { referencedAttachmentPaths, type Store } from '@qywork/store'
import { ATTACHMENT_DIR } from './api/attachments.ts'

export interface GcResult {
  removed: number
  bytes: number
}

export async function sweepAttachments(store: Store, workspaceRoot: string): Promise<GcResult> {
  const dir = join(workspaceRoot, ATTACHMENT_DIR)
  const names = await readdir(dir).catch(() => [] as string[])
  if (names.length === 0) return { removed: 0, bytes: 0 }

  const referenced = referencedAttachmentPaths(store)
  let removed = 0
  let bytes = 0

  for (const name of names) {
    // 目录自己的 .gitignore 不是附件，别把它删了——删了下次粘的图就会进版本控制。
    if (name === '.gitignore') continue
    const rel = `${ATTACHMENT_DIR}/${name}`
    if (referenced.has(rel)) continue
    const abs = join(dir, name)
    const size = await stat(abs)
      .then((st) => st.size)
      .catch(() => 0)
    const ok = await unlink(abs).then(
      () => true,
      () => false,
    )
    if (ok) {
      removed++
      bytes += size
    }
  }
  return { removed, bytes }
}
