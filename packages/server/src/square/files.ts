/**
 * 创作广场的文件：从云端（`GET /v1/square/files/<hash>`）取得，按哈希保存在 `<configDir>/square/files/`。
 *
 * 不变量：
 * - 文件按内容的 SHA-256 命名，取得后先核对哈希再改名到位；哈希不一致时不保存，按失败返回。
 * - 内容不会改变，保存后不再重新取得：列表中的封面与安装时的快照都从这里读取。
 * - 快照是版本的全部文件按快照内的路径放入一个新目录（`stageSnapshot`），交给各类型的安装入口；用完由调用方删除。
 */

import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SquareFile } from '@qywork/core'
import { configDir } from '@qywork/runtime'
import type { CloudAccount } from '../cloud/account.ts'

const HASH = /^[0-9a-f]{64}$/

/** 哈希格式不合法，或取得的内容与哈希不一致。 */
export class SquareFileError extends Error {}

export function squareDir(): string {
  return join(configDir(), 'square')
}

/**
 * 已保存文件的路径；尚未保存时从云端取得。哈希格式不合法或内容与哈希不一致时抛出 `SquareFileError`，
 * 云端拒绝时抛出 `CloudAccountError`。
 */
export async function squareFile(account: CloudAccount, hash: string): Promise<string> {
  if (!HASH.test(hash)) throw new SquareFileError(`文件哈希不合法：${hash}`)
  const path = join(squareDir(), 'files', hash)
  if ((await stat(path).catch(() => null))?.isFile()) return path
  const res = await account.request(`/v1/square/files/${hash}`)
  const bytes = new Uint8Array(await res.arrayBuffer())
  if (createHash('sha256').update(bytes).digest('hex') !== hash) {
    throw new SquareFileError('取得的文件与哈希不一致')
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${crypto.randomUUID()}.part`
  try {
    await writeFile(temporary, bytes)
    await rename(temporary, path)
  } finally {
    await rm(temporary, { force: true })
  }
  return path
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
      await copyFile(await squareFile(account, f.hash), dest)
    }
  } catch (err) {
    await rm(dirname(root), { recursive: true, force: true })
    throw err
  }
  return root
}
