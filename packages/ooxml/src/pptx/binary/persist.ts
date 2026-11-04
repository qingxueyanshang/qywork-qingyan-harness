/**
 * .ppt 的持久对象定位：`Current User` 流的 CurrentUserAtom 给出最近一次保存的 UserEditAtom，
 * 自它起经 `offsetLastEdit` 上溯到最早一次保存；各次保存的 PersistDirectoryAtom 给出持久对象编号到流内位置的对应，
 * 较晚的保存覆盖较早的同一编号（快速保存只写出改动的对象）。文档容器为最近一次 UserEditAtom 的 `docPersistIdRef`。
 *
 * - 加密：CurrentUserAtom 的 `headerToken` 为 0xF3D1C4DF，或最近一次 UserEditAtom 带 `encryptSessionPersistIdRef`
 *   （记录长度 0x20）且它指向 CryptSession10Container。加密的文件中持久对象本身已加密，不读取。
 * - 结构错误（缺少 `Current User` 流、记录类型不符、上溯成环、文档容器不存在）为 `null`。
 */

import { type ArtRecord, readArtRecord } from '../../officeart/records.ts'
import { Fields, RT } from './records.ts'

const TOKEN_PLAIN = 0xe391c05f
const TOKEN_ENCRYPTED = 0xf3d1c4df

export type Persist =
  | { readonly kind: 'encrypted' }
  | {
      readonly kind: 'ok'
      /** 持久对象编号到记录。 */
      object(id: number): ArtRecord | null
      readonly document: ArtRecord
    }

export function readPersist(stream: Uint8Array, currentUser: Uint8Array | null): Persist | null {
  const user = currentUser === null ? null : readArtRecord(currentUser, 0)
  if (user === null || user.type !== RT.CURRENT_USER_ATOM) return null
  const head = new Fields(user.data)
  const token = head.u32(4)
  if (token === TOKEN_ENCRYPTED) return { kind: 'encrypted' }
  if (token !== TOKEN_PLAIN) return null

  const edits: Fields[] = []
  const seen = new Set<number>()
  for (let offset = head.u32(8); ; ) {
    const edit = readArtRecord(stream, offset)
    if (edit === null || edit.type !== RT.USER_EDIT_ATOM || seen.has(offset)) return null
    seen.add(offset)
    const f = new Fields(edit.data)
    edits.push(f)
    offset = f.u32(8)
    if (offset === 0) break
  }

  const newest = edits[0]!
  const offsets = new Map<number, number>()
  for (const edit of edits.reverse()) {
    const dir = readArtRecord(stream, edit.u32(12))
    if (dir === null || dir.type !== RT.PERSIST_DIRECTORY_ATOM) return null
    const f = new Fields(dir.data)
    for (let p = 0; p + 4 <= f.length; ) {
      const head = f.u32(p)
      const first = head & 0xfffff
      const count = head >>> 20
      p += 4
      for (let k = 0; k < count && p + 4 <= f.length; k++, p += 4) offsets.set(first + k, f.u32(p))
    }
  }

  const object = (id: number): ArtRecord | null => {
    const offset = offsets.get(id)
    return offset === undefined ? null : readArtRecord(stream, offset)
  }
  if (newest.length >= 0x20 && object(newest.u32(28))?.type === RT.CRYPT_SESSION) {
    return { kind: 'encrypted' }
  }
  const document = object(newest.u32(16))
  if (document === null || document.type !== RT.DOCUMENT) return null
  return { kind: 'ok', object, document }
}
