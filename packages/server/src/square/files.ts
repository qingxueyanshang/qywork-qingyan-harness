/**
 * 创作广场的文件：从云端（`GET /v1/square/files/<hash>`）取得，按流传输，不整体读入内存。
 *
 * 不变量：
 * - 界面查看的文件（`squareFileResponse`）原样转发云端的响应，透传 Range，视频边下边播；不在本机保存。
 *   类型只取图片与视频，其余按二进制下载：本机服务与界面同源，不能以发布者提供的类型显示其内容。
 * - 安装时的快照是版本的全部文件按快照内的路径写入一个新目录（`stageSnapshot`），逐个核对哈希，交给各类型的安装入口；
 *   用完由调用方删除。下载按进展计时，连接中断时按 Range 从已收到处续传。
 */

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, rm, truncate } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DOWNLOAD_IDLE_MS, TransferStalled } from '@qywork/ai'
import type { SquareFile } from '@qywork/core'
import { configDir } from '@qywork/runtime'
import { type CloudAccount, CloudAccountError } from '../cloud/account.ts'

const HASH = /^[0-9a-f]{64}$/
/** 安装时每个文件的下载次数上限：连接中断后续传，至多再试两次。 */
const DOWNLOAD_ATTEMPTS = 3
/** 界面可直接显示的类型。 */
const SHOWN = /^(image\/(png|jpeg|gif|webp)|video\/(mp4|webm))$/

/** 哈希格式不合法，或取得的内容与哈希不一致。 */
export class SquareFileError extends Error {}

export function squareDir(): string {
  return join(configDir(), 'square')
}

const filePath = (hash: string) => {
  if (!HASH.test(hash)) throw new SquareFileError(`文件哈希不合法：${hash}`)
  return `/v1/square/files/${hash}`
}

/** 界面查看文件：转发云端的响应（含 206 与 `content-range`），云端拒绝时抛出 `CloudAccountError`。 */
export async function squareFileResponse(
  account: CloudAccount,
  hash: string,
  range: string | null,
): Promise<Response> {
  const res = await account.request(
    filePath(hash),
    range ? { headers: { range } } : {},
    DOWNLOAD_IDLE_MS,
  )
  const type = res.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
  const headers = new Headers({
    'content-type': SHOWN.test(type) ? type : 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'content-security-policy': 'sandbox',
    'cache-control': 'private, max-age=31536000, immutable',
    'accept-ranges': 'bytes',
  })
  for (const name of ['content-length', 'content-range']) {
    const value = res.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(res.body, { status: res.status, headers })
}

/** 是否为连接中断（可续传）：云端按状态码拒绝的不是。 */
const interrupted = (err: unknown) =>
  err instanceof TransferStalled || !(err instanceof CloudAccountError) || !err.reply

/** 把文件下载到 `dest` 并核对哈希；连接中断时按 Range 续传，至多 `DOWNLOAD_ATTEMPTS` 次。 */
async function download(account: CloudAccount, hash: string, dest: string): Promise<void> {
  const path = filePath(hash)
  const out = await open(dest, 'w')
  let received = 0
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await account.request(
          path,
          received ? { headers: { range: `bytes=${received}-` } } : {},
          DOWNLOAD_IDLE_MS,
        )
        // 云端未按 Range 答复时从头写入。
        if (received && res.status !== 206) {
          await truncate(dest, 0)
          received = 0
        }
        if (res.body) {
          for await (const chunk of res.body) {
            await out.write(chunk, 0, chunk.byteLength, received)
            received += chunk.byteLength
          }
        }
        break
      } catch (err) {
        if (attempt >= DOWNLOAD_ATTEMPTS || !interrupted(err)) {
          if (err instanceof TransferStalled) {
            throw new CloudAccountError(`${err.message}，请检查网络后重试`)
          }
          throw err
        }
      }
    }
  } finally {
    await out.close()
  }
  const hasher = createHash('sha256')
  for await (const chunk of Bun.file(dest).stream()) hasher.update(chunk)
  if (hasher.digest('hex') !== hash) throw new SquareFileError('取得的文件与哈希不一致')
}

/**
 * 把一个版本的全部文件按快照内的路径放入新目录 `<configDir>/square/stage/<随机>/<name>`，返回该目录。
 * `name` 是目录的最后一段：技能安装按它确定技能目录名。调用方用完后删除 `dirname(返回值)`。
 */
export async function stageSnapshot(
  account: CloudAccount,
  files: readonly SquareFile[],
  name: string,
): Promise<string> {
  const parent = join(squareDir(), 'stage')
  await mkdir(parent, { recursive: true })
  const root = join(await mkdtemp(join(parent, 'v-')), name)
  try {
    for (const f of files) {
      const dest = join(root, ...f.path.split('/'))
      await mkdir(dirname(dest), { recursive: true })
      await download(account, f.hash, dest)
    }
  } catch (err) {
    await rm(dirname(root), { recursive: true, force: true })
    throw err
  }
  return root
}
