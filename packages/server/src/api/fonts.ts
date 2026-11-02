/**
 * 主机字体：按字体名查找主机已安装的字体，按内容哈希下发单个字体的字节；下发主机显示器的 ClearType 设置。
 * Office 文档预览在没有该字体的设备上以 `FontFace` 注册这些字节，按原字体排版，按主机的 ClearType 设置绘制文字。
 *
 * - `GET /api/fonts?name=<字体名>`：该家族在主机上的各个字体，`{ faces: [{ id, bold, italic }] }`。
 *   `id` 是下发字节的 SHA-256。主机上没有该家族时返回 404。
 * - `GET /api/fonts/file?name=<字体名>&id=<SHA-256>`：单个字体的字节，`.ttc` 中的字体拆为独立的 sfnt。
 *   地址由内容决定，响应按一年缓存并标为不可变；文件内容改变后哈希随之改变，原地址返回 404。
 * - `GET /api/fonts/smoothing`：`{ clearType: { contrast } | null }`，每次请求时读取系统的当前值（见 `fontSmoothing`），
 *   不缓存。系统接口调用失败时返回 500。
 * - `GET /api/fonts/families`：主机字体的族名（`hostFamilies`），`{ local, names }`：`local` 为各字体按界面语言取的族名
 *   （区分大小写，见 `localFamilyName`），`names` 为全部语言的族名（小写，与 `?name=` 的查找方式相同）。
 *
 * 边界：
 * - 只读取系统与当前用户的字体目录（`fontRoots`），不跟随符号链接。字体名只用于查询内存中的索引，
 *   不参与拼接路径；含 `..`、`/`、`\` 或控制字符的参数返回 422。
 * - 字节与哈希在每次请求时由文件计算，响应后释放，不常驻、不落盘。
 * - 索引（家族名到文件与合集序号）只在内存中。每次请求核对已扫描目录的修改时间，有变化即重建：
 *   字体安装到上述目录后，下一次请求即可见。原地覆盖同名文件不改变目录修改时间，
 *   此时家族名沿用索引中的值，字节与哈希仍取自当前文件。
 */

import { dlopen, FFIType, ptr } from 'bun:ffi'
import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { type FileHandle, open, readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { log } from '@qywork/core'
import {
  extractFace,
  isCffOutline,
  LANGUAGE_EN_US,
  localFamilyName,
  readFaces,
  readFamilyNames,
  readHead,
  type TableRecord,
  tableRecord,
} from '@qywork/ooxml/font'
import { type ApiHandler, json } from './types.ts'

/** 系统与当前用户的字体目录。环境变量缺失时略去对应目录。 */
export function fontRoots(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string[] {
  if (platform === 'win32') {
    const roots: string[] = []
    const windir = env.WINDIR ?? env.SystemRoot
    if (windir) roots.push(win32.join(windir, 'Fonts'))
    if (env.LOCALAPPDATA) roots.push(win32.join(env.LOCALAPPDATA, 'Microsoft', 'Windows', 'Fonts'))
    return roots
  }
  if (platform === 'darwin') {
    return ['/System/Library/Fonts', '/Library/Fonts', posix.join(home, 'Library', 'Fonts')]
  }
  return [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    posix.join(home, '.local', 'share', 'fonts'),
    posix.join(home, '.fonts'),
  ]
}

const FONT_FILE = /\.(ttf|otf|ttc|otc)$/i

/**
 * 建立索引时每个文件只读取开头这一段，从中解析合集头与全部表目录，再按表记录单独读取 `name` 与 `head`。
 * 实测 Windows 字体目录（164 个文件，2026-11-01）中表目录的最大结束位置为 1944 字节；
 * 表目录超出这一段的文件按无法解析处理。
 */
const DIRECTORY_PROBE = 64 * 1024

interface FaceLocation {
  path: string
  /** 合集中的序号；单个字体文件为 0。 */
  index: number
  bold: boolean
  italic: boolean
  contentType: 'font/otf' | 'font/ttf'
}

interface FontIndex {
  /** 已扫描的目录及其修改时间；不存在的目录记为 -1，之后出现时同样触发重建。 */
  dirs: Map<string, number>
  /** 键为 `familyKey` 处理后的家族名。同一家族中粗体与斜体组合相同的字体只保留先扫描到的一个。 */
  families: Map<string, FaceLocation[]>
  /** 各字体按界面语言取的族名（`localFamilyName`）。 */
  local: Set<string>
}

/** 家族名不区分大小写，与 Office 按名称引用字体的方式一致。 */
function familyKey(name: string): string {
  return name.trim().toLowerCase()
}

async function dirMtime(dir: string): Promise<number> {
  return stat(dir).then(
    (s) => s.mtimeMs,
    () => -1,
  )
}

async function readAt(fh: FileHandle, offset: number, length: number): Promise<Uint8Array> {
  const buf = new Uint8Array(length)
  const { bytesRead } = await fh.read(buf, 0, length, offset)
  if (bytesRead !== length) throw new Error('文件长度不足')
  return buf
}

type IndexedFace = FaceLocation & { names: string[]; local: string }

let uiLanguage: number | null = null

/** 主机的界面语言标识：Windows 取 `GetUserDefaultUILanguage`，其他平台为 en-US。 */
function hostLanguage(): number {
  if (process.platform !== 'win32') return LANGUAGE_EN_US
  uiLanguage ??= dlopen('kernel32.dll', {
    GetUserDefaultUILanguage: { args: [], returns: FFIType.u16 },
  }).symbols.GetUserDefaultUILanguage()
  return uiLanguage
}

async function readFileFaces(path: string): Promise<IndexedFace[]> {
  const fh = await open(path, 'r')
  try {
    const { size } = await fh.stat()
    const faces = readFaces(await readAt(fh, 0, Math.min(size, DIRECTORY_PROBE)), size)
    const table = (record: TableRecord) => readAt(fh, record.offset, record.length)
    const out: IndexedFace[] = []
    for (const [index, face] of faces.entries()) {
      const nameTable = await table(tableRecord(face, 'name'))
      const names = readFamilyNames(nameTable)
      const { bold, italic } = readHead(await table(tableRecord(face, 'head')))
      const contentType = isCffOutline(face) ? 'font/otf' : 'font/ttf'
      const local = localFamilyName(nameTable, hostLanguage()) ?? names[0]
      if (local === undefined) continue
      out.push({ path, index, bold, italic, contentType, names, local })
    }
    return out
  } finally {
    await fh.close()
  }
}

function reason(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 递归扫描一个目录。`Dirent` 按 lstat 判定类型，符号链接既不算文件也不算目录，因此不被跟随。
 * 无法读取的目录与无法解析的文件只跳过自身并记录日志：字体目录中存在扩展名为 `.ttf`
 * 而内容不是字体的文件（如 Windows 的 mstmc.ttf）。
 */
async function scanDir(dir: string, index: FontIndex): Promise<void> {
  const mtime = await dirMtime(dir)
  index.dirs.set(dir, mtime)
  if (mtime < 0) return
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch (err) {
    log.warn('fonts', '字体目录无法读取，已跳过', { dir, reason: reason(err) })
    return
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1))
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      await scanDir(path, index)
      continue
    }
    if (!entry.isFile() || !FONT_FILE.test(entry.name)) continue
    let faces: IndexedFace[]
    try {
      faces = await readFileFaces(path)
    } catch (err) {
      log.warn('fonts', '字体文件无法解析，已跳过', { path, reason: reason(err) })
      continue
    }
    for (const { names, local, ...location } of faces) {
      index.local.add(local)
      for (const name of names) {
        const key = familyKey(name)
        const list = index.families.get(key) ?? []
        if (list.some((f) => f.bold === location.bold && f.italic === location.italic)) continue
        list.push(location)
        index.families.set(key, list)
      }
    }
  }
}

async function buildIndex(): Promise<FontIndex> {
  const index: FontIndex = { dirs: new Map(), families: new Map(), local: new Set() }
  for (const root of fontRoots()) await scanDir(root, index)
  return index
}

async function unchanged(index: FontIndex): Promise<boolean> {
  const checks = await Promise.all(
    [...index.dirs].map(async ([dir, mtime]) => (await dirMtime(dir)) === mtime),
  )
  return checks.every(Boolean)
}

let current: FontIndex | null = null
/** 并发请求共用同一次核对与重建。 */
let checking: Promise<FontIndex> | null = null

function fontIndex(): Promise<FontIndex> {
  checking ??= (async () => {
    if (!current || !(await unchanged(current))) current = await buildIndex()
    return current
  })().finally(() => {
    checking = null
  })
  return checking
}

/** 主机字体的族名（见文件头 `/api/fonts/families`），各自按 UTF-16 码元排序。 */
export async function hostFamilies(): Promise<{ local: string[]; names: string[] }> {
  const index = await fontIndex()
  return { local: [...index.local].sort(), names: [...index.families.keys()].sort() }
}

/** 字体名只用于查询索引；与路径形状相关的值一律拒绝，不做改写。 */
function validName(name: string | null): name is string {
  return (
    name !== null &&
    name.trim() !== '' &&
    !name.includes('..') &&
    !/[/\\]/.test(name) &&
    !/\p{Cc}/u.test(name)
  )
}

const SHA256_HEX = /^[0-9a-f]{64}$/

async function faceBytes(location: FaceLocation): Promise<Uint8Array> {
  return extractFace(new Uint8Array(await readFile(location.path)), location.index)
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** 系统的字体平滑设置：Windows `SystemParametersInfoW` 的三项读取结果。 */
export interface SmoothingParameters {
  /** `SPI_GETFONTSMOOTHING`：字体平滑是否开启。 */
  readonly enabled: boolean
  /** `SPI_GETFONTSMOOTHINGTYPE`：1 为标准（灰度），2 为 ClearType。 */
  readonly type: number
  /** `SPI_GETFONTSMOOTHINGCONTRAST`：ClearType 对比度，1000–2200。 */
  readonly contrast: number
}

/** 主机显示器的 ClearType 设置；不使用 ClearType 时 `clearType` 为 `null`。 */
export interface FontSmoothing {
  readonly clearType: { readonly contrast: number } | null
}

const SPI_GETFONTSMOOTHING = 0x004a
const SPI_GETFONTSMOOTHINGTYPE = 0x200a
const SPI_GETFONTSMOOTHINGCONTRAST = 0x200c
const FE_FONTSMOOTHINGCLEARTYPE = 2

/**
 * 字体平滑开启且方式为 ClearType 时取其对比度，否则为 `null`：标准方式为灰度抗锯齿，关闭时不平滑，两者都不是 ClearType。
 * `parameters` 为 `null` 表示平台没有 ClearType：macOS 的文字由 Core Text 绘制，Linux 由 FreeType 绘制，两者的子像素
 * 处理都不是 GDI 的 ClearType。
 */
export function fontSmoothing(parameters: SmoothingParameters | null): FontSmoothing {
  if (parameters === null || !parameters.enabled || parameters.type !== FE_FONTSMOOTHINGCLEARTYPE) {
    return { clearType: null }
  }
  return { clearType: { contrast: parameters.contrast } }
}

let systemParametersInfo:
  | ((action: number, param: number, out: ReturnType<typeof ptr>, winIni: number) => number)
  | null = null

/**
 * 读取系统的字体平滑设置。只调用 `SPI_GET*`，不修改系统设置。Windows 以外的平台返回 `null`；
 * 系统接口调用失败时抛出。
 */
export function readSmoothingParameters(
  platform: string = process.platform,
): SmoothingParameters | null {
  if (platform !== 'win32') return null
  systemParametersInfo ??= dlopen('user32.dll', {
    SystemParametersInfoW: {
      args: [FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
  }).symbols.SystemParametersInfoW
  const read = (action: number): number => {
    const out = new Uint32Array(1)
    if (systemParametersInfo!(action, 0, ptr(out), 0) === 0) {
      throw new Error(`SystemParametersInfoW(0x${action.toString(16)}) 调用失败`)
    }
    return out[0]!
  }
  return {
    enabled: read(SPI_GETFONTSMOOTHING) !== 0,
    type: read(SPI_GETFONTSMOOTHINGTYPE),
    contrast: read(SPI_GETFONTSMOOTHINGCONTRAST),
  }
}

export const handleFontsApi: ApiHandler = async (url, req) => {
  const p = url.pathname
  if (req.method === 'GET' && p === '/api/fonts/smoothing') {
    try {
      return json(fontSmoothing(readSmoothingParameters()))
    } catch (err) {
      log.error('fonts', '无法读取系统的字体平滑设置', { reason: reason(err) })
      return json({ error: 'unavailable', message: '无法读取系统的字体平滑设置' }, 500)
    }
  }
  if (req.method === 'GET' && p === '/api/fonts/families') return json(await hostFamilies())
  if (req.method !== 'GET' || (p !== '/api/fonts' && p !== '/api/fonts/file')) return null

  const name = url.searchParams.get('name')
  if (!validName(name)) return json({ error: 'invalid', message: '字体名不合法' }, 422)
  const id = url.searchParams.get('id')
  if (p === '/api/fonts/file' && (id === null || !SHA256_HEX.test(id))) {
    return json({ error: 'invalid', message: '字体标识不合法' }, 422)
  }

  const locations = (await fontIndex()).families.get(familyKey(name))
  if (!locations) return json({ error: 'not_found', message: `主机上没有字体 ${name}` }, 404)

  if (p === '/api/fonts') {
    const faces: { id: string; bold: boolean; italic: boolean }[] = []
    for (const location of locations) {
      faces.push({
        id: sha256(await faceBytes(location)),
        bold: location.bold,
        italic: location.italic,
      })
    }
    return json({ faces })
  }

  for (const location of locations) {
    const bytes = await faceBytes(location)
    if (sha256(bytes) !== id) continue
    return new Response(bytes, {
      headers: {
        'content-type': location.contentType,
        'cache-control': 'private, max-age=31536000, immutable',
      },
    })
  }
  return json({ error: 'not_found', message: '主机上没有该字体文件' }, 404)
}
