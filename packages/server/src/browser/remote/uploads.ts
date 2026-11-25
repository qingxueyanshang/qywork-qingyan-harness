/**
 * 远程查看中交给网页的上传文件：客户端先经 `POST /api/browser/uploads` 上传，查看连接再按编号交给网页的文件输入框
 * （`DOM.setFileInputFiles`）。
 *
 * - 按页面存放在全局数据目录的 `browser/uploads/<tabId>/<编号>/<文件名>`。网页在提交表单时才读取文件，
 *   因此保留到该页关闭。宿主连接或断开时清空整个目录：页面编号随宿主重启从头分配，旧目录会被同编号的新页面取得。
 * - 编号由本模块生成，文件名只保留最后一段；查看连接只接受本模块给出的编号，路径中没有客户端提供的目录部分。
 */

import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { configDir } from '@qywork/runtime'
import type { BrowserBridge } from '../bridge.ts'

const TAB_ID = /^[A-Za-z0-9_-]{1,64}$/
const UPLOAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function root(): string {
  return join(configDir(), 'browser', 'uploads')
}

/** 文件名只保留最后一段，删除 Windows 与 POSIX 不允许的字符；结果为空或只有点时为 `file`。 */
export function uploadName(raw: string): string {
  const last = raw.split(/[\\/]/).pop() ?? ''
  const clean = [...last]
    .filter((ch) => ch >= ' ' && !'<>:"|?*'.includes(ch))
    .join('')
    .trim()
    .slice(0, 200)
  return clean && !/^\.+$/.test(clean) ? clean : 'file'
}

/** 保存一个上传的文件，返回编号。页面编号格式无效时抛出。 */
export async function saveUpload(
  tabId: string,
  name: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<string> {
  if (!TAB_ID.test(tabId)) throw new Error('页面编号无效')
  const id = crypto.randomUUID()
  const dir = join(root(), tabId, id)
  mkdirSync(dir, { recursive: true })
  // 逐块写入，不用 `Bun.write(path, new Response(body))`：后者在 Bun 1.3 上等待请求体时不返回。
  const writer = Bun.file(join(dir, uploadName(name))).writer()
  try {
    if (body) for await (const chunk of body) writer.write(chunk)
  } finally {
    await writer.end()
  }
  return id
}

/** 编号对应的文件路径；编号无效或文件不存在时为 `null`。 */
export function uploadPath(tabId: string, id: string): string | null {
  if (!TAB_ID.test(tabId) || !UPLOAD_ID.test(id)) return null
  const dir = join(root(), tabId, id)
  try {
    const [name] = readdirSync(dir)
    return name ? join(dir, name) : null
  } catch {
    return null
  }
}

function clear(tabId?: string): void {
  rmSync(tabId === undefined ? root() : join(root(), tabId), { recursive: true, force: true })
}

/** 页面关闭时删除该页的上传文件，宿主连接或断开时清空全部；返回注销函数。 */
export function watchUploads(bridge: BrowserBridge): () => void {
  clear()
  const offEvent = bridge.onEvent((frame) => {
    if (frame.kind === 'closed' && TAB_ID.test(frame.tabId)) clear(frame.tabId)
  })
  const offHost = bridge.onHostChange(() => clear())
  return () => {
    offEvent()
    offHost()
  }
}
