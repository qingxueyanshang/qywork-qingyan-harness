/**
 * 把 zip 解压到目录，保留 Unix 的权限位与符号链接（压缩包在 Unix 系统上制作时，中央目录的外部属性高 16 位是文件模式）。
 * 用于 Linux 上解压专用 Chromium：其中的可执行文件缺少执行权限时浏览器无法启动。
 *
 * - 只支持存储与 deflate 两种压缩方法，不支持 zip64、加密与分卷，遇到时整体失败。
 * - 条目路径为绝对路径、含 `..` 段或反斜杠时整体失败；符号链接指向目标目录之外时同样失败，
 *   写入位置不会经由链接离开目标目录。
 */

import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { inflateRawSync } from 'node:zlib'

const EOCD = 0x06054b50
const CENTRAL = 0x02014b50
const LOCAL = 0x04034b50
const S_IFMT = 0o170000
const S_IFLNK = 0o120000
const S_IFDIR = 0o040000

interface Entry {
  name: string
  method: number
  compressed: number
  offset: number
  /** Unix 文件模式；压缩包不是在 Unix 系统上制作时为 0。 */
  mode: number
}

function entries(data: Uint8Array): Entry[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let end = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === EOCD) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('不是 zip 文件')
  const count = view.getUint16(end + 10, true)
  let at = view.getUint32(end + 16, true)
  if (count === 0xffff || at === 0xffffffff) throw new Error('不支持 zip64 格式')
  const list: Entry[] = []
  const decoder = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error('zip 中央目录已损坏')
    const madeBy = view.getUint16(at + 4, true) >> 8
    const flags = view.getUint16(at + 8, true)
    const method = view.getUint16(at + 10, true)
    const compressed = view.getUint32(at + 20, true)
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    const external = view.getUint32(at + 38, true)
    const offset = view.getUint32(at + 42, true)
    if (flags & 1) throw new Error('不支持加密的 zip')
    const name = decoder.decode(data.subarray(at + 46, at + 46 + nameLength))
    list.push({ name, method, compressed, offset, mode: madeBy === 3 ? external >>> 16 : 0 })
    at += 46 + nameLength + extraLength + commentLength
  }
  return list
}

function safePath(dest: string, name: string): string {
  const parts = name.split('/').filter((p) => p !== '')
  if (name.startsWith('/') || name.includes('\\') || parts.some((p) => p === '..' || p === '.')) {
    throw new Error(`压缩包中的路径无效：${name}`)
  }
  return join(dest, ...parts)
}

export async function unzip(file: string, dest: string): Promise<void> {
  const data = new Uint8Array(await Bun.file(file).arrayBuffer())
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  mkdirSync(dest, { recursive: true })
  for (const entry of entries(data)) {
    const path = safePath(dest, entry.name)
    const type = entry.mode & S_IFMT
    if (entry.name.endsWith('/') || type === S_IFDIR) {
      mkdirSync(path, { recursive: true })
      continue
    }
    if (view.getUint32(entry.offset, true) !== LOCAL)
      throw new Error(`zip 条目已损坏：${entry.name}`)
    const start =
      entry.offset +
      30 +
      view.getUint16(entry.offset + 26, true) +
      view.getUint16(entry.offset + 28, true)
    const raw = data.subarray(start, start + entry.compressed)
    let content: Uint8Array
    if (entry.method === 0) content = raw
    else if (entry.method === 8) content = inflateRawSync(raw)
    else throw new Error(`不支持的压缩方法 ${entry.method}：${entry.name}`)
    mkdirSync(dirname(path), { recursive: true })
    if (type === S_IFLNK) {
      const target = new TextDecoder().decode(content)
      const inside = relative(dest, resolve(dirname(path), target))
      if (isAbsolute(target) || inside.startsWith('..') || isAbsolute(inside)) {
        throw new Error(`压缩包中的链接指向目标目录之外：${entry.name}`)
      }
      symlinkSync(target, path)
      continue
    }
    writeFileSync(path, content)
    const permissions = entry.mode & 0o777
    if (permissions) chmodSync(path, permissions)
  }
}
