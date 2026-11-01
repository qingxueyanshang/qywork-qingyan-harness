/**
 * 本机字体索引：按家族名（`name` 表 nameID 1，含本地化名称）查找字体文件与合集序号。
 * 只读取文件开头的表目录与 `name`、`head` 两张表，不读入整个文件。供候选截图脚本向页面提供字体。
 */

import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readFaces,
  readFamilyNames,
  readHead,
  type SfntFace,
} from '../../packages/ooxml/src/font/index.ts'

export interface IndexedFace {
  readonly file: string
  readonly index: number
  readonly families: readonly string[]
  readonly bold: boolean
  readonly italic: boolean
}

const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i
const HEADER_BYTES = 256 * 1024

export function defaultFontRoots(env: Record<string, string | undefined> = process.env): string[] {
  const roots: string[] = []
  const windir = env.WINDIR ?? env.SystemRoot
  if (windir) roots.push(join(windir, 'Fonts'))
  if (env.LOCALAPPDATA) roots.push(join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'))
  return roots
}

async function readRange(file: string, offset: number, length: number): Promise<Uint8Array> {
  const handle = await open(file, 'r')
  try {
    const buf = new Uint8Array(length)
    const { bytesRead } = await handle.read(buf, 0, length, offset)
    return buf.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function tableAt(file: string, face: SfntFace, tag: string): Promise<Uint8Array | null> {
  const rec = face.tables.get(tag)
  return rec ? readRange(file, rec.offset, rec.length) : null
}

export async function indexFonts(
  roots: readonly string[] = defaultFontRoots(),
): Promise<IndexedFace[]> {
  const out: IndexedFace[] = []
  for (const root of roots) {
    let names: string[]
    try {
      names = await readdir(root)
    } catch {
      continue
    }
    for (const name of names) {
      if (!FONT_FILE.test(name)) continue
      const file = join(root, name)
      try {
        const handle = await open(file, 'r')
        const size = (await handle.stat()).size
        await handle.close()
        const head = await readRange(file, 0, Math.min(size, HEADER_BYTES))
        const faces = readFaces(head, size)
        for (const [index, face] of faces.entries()) {
          const nameTable = await tableAt(file, face, 'name')
          const headTable = await tableAt(file, face, 'head')
          if (!nameTable || !headTable) continue
          const style = readHead(headTable)
          out.push({
            file,
            index,
            families: readFamilyNames(nameTable),
            bold: style.bold,
            italic: style.italic,
          })
        }
      } catch {
        // 无法解析的文件不是可用字体，跳过。
      }
    }
  }
  return out
}

export function facesFor(index: readonly IndexedFace[], family: string): IndexedFace[] {
  const key = family.trim().toLowerCase()
  return index.filter((f) => f.families.some((n) => n.toLowerCase() === key))
}
