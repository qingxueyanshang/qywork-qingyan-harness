/**
 * 皮肤库：`<configDir>/skins/<id>/skin.json` 加该皮肤的图片。设置页（经 HTTP 接口）与 `skin` 工具
 * 读写同一份，均经由本文件。
 *
 * 不变量：
 * - 校验先于落盘：皮肤内容、图片文件名与引用关系全部通过后才写入，任何一项不通过都不改动磁盘。
 * - `skin.json` 先写临时文件再重命名，读方只会读到完整的旧文件或新文件。
 * - 目录中只保留当前引用的图片：换图后旧图片随同一次保存删除，皮肤目录不随修改次数增长。
 */

import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isSkinId,
  isSkinImageName,
  parseSkin,
  SKIN_IMAGE_EXTENSIONS,
  type Skin,
  type SkinEntry,
} from '@qywork/core'
import { configDir } from '../config.ts'

/** 单张图片的上限。背景图按窗口尺寸显示，超过该值的图片不带来可见差异，只拖慢首帧。 */
export const SKIN_IMAGE_MAX_BYTES = 20 * 1024 * 1024

const SKIN_FILE = 'skin.json'

export function skinsDir(): string {
  return join(configDir(), 'skins')
}

export interface SkinImage {
  name: string
  bytes: Uint8Array
}

export type SkinSaveResult =
  | { ok: true; entry: SkinEntry }
  | { ok: false; status: 404 | 422; error: string }

export interface SkinList {
  skins: SkinEntry[]
  /** 无法读取或校验失败的皮肤目录。列出它们而不是跳过：手动修改出错的皮肤需要能被看到。 */
  failures: { id: string; reason: string }[]
}

function isImageFile(name: string): boolean {
  return (SKIN_IMAGE_EXTENSIONS as readonly string[]).some((ext) =>
    name.toLowerCase().endsWith(ext),
  )
}

function newSkinId(): string {
  return `skin-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

async function readEntry(id: string): Promise<{ entry: SkinEntry } | { reason: string } | null> {
  const file = join(skinsDir(), id, SKIN_FILE)
  const info = await stat(file).catch(() => null)
  if (!info) return null
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    return { reason: `skin.json 无法解析：${e instanceof Error ? e.message : String(e)}` }
  }
  const parsed = parseSkin(raw)
  if (!parsed.ok) return { reason: parsed.error }
  return { entry: { id, skin: parsed.value, updatedAt: info.mtimeMs } }
}

export async function listSkins(): Promise<SkinList> {
  const names = await readdir(skinsDir()).catch(() => [] as string[])
  const skins: SkinEntry[] = []
  const failures: SkinList['failures'] = []
  for (const id of names.sort()) {
    if (!isSkinId(id)) continue
    const r = await readEntry(id)
    if (!r) continue
    if ('entry' in r) skins.push(r.entry)
    else failures.push({ id, reason: r.reason })
  }
  return { skins, failures }
}

export async function readSkin(id: string): Promise<SkinEntry | null> {
  if (!isSkinId(id)) return null
  const r = await readEntry(id)
  return r && 'entry' in r ? r.entry : null
}

/** 皮肤图片的绝对路径。id 或文件名不合法、文件不存在时返回 null。 */
export async function skinImagePath(id: string, name: string): Promise<string | null> {
  if (!isSkinId(id) || !isSkinImageName(name)) return null
  const file = join(skinsDir(), id, name)
  return (await stat(file).catch(() => null))?.isFile() ? file : null
}

/**
 * 新建（`id` 为 null）或整体替换一套皮肤，可同时写入图片。
 *
 * 图片背景引用的文件必须在本次写入的图片中，或已存在于该皮肤目录中。
 */
export async function saveSkin(
  id: string | null,
  raw: unknown,
  images: SkinImage[] = [],
): Promise<SkinSaveResult> {
  const parsed = parseSkin(raw)
  if (!parsed.ok) return { ok: false, status: 422, error: parsed.error }
  const skin: Skin = parsed.value
  for (const img of images) {
    if (!isSkinImageName(img.name)) {
      return { ok: false, status: 422, error: `图片文件名不合法：${img.name}` }
    }
    if (img.bytes.byteLength > SKIN_IMAGE_MAX_BYTES) {
      return {
        ok: false,
        status: 422,
        error: `图片超过 ${SKIN_IMAGE_MAX_BYTES / 1024 / 1024} MB：${img.name}`,
      }
    }
  }

  if (id !== null) {
    if (!isSkinId(id)) return { ok: false, status: 422, error: `皮肤 id 不合法：${id}` }
    if (!(await stat(join(skinsDir(), id, SKIN_FILE)).catch(() => null))) {
      return { ok: false, status: 404, error: `皮肤不存在：${id}` }
    }
  }
  const target = id ?? newSkinId()
  const dir = join(skinsDir(), target)

  const referenced = skin.background.kind === 'image' ? skin.background.file : null
  if (
    referenced &&
    !images.some((img) => img.name === referenced) &&
    !(await stat(join(dir, referenced)).catch(() => null))
  ) {
    return { ok: false, status: 422, error: `背景图片不存在：${referenced}` }
  }

  await mkdir(dir, { recursive: true })
  for (const img of images) await writeFile(join(dir, img.name), img.bytes)
  const file = join(dir, SKIN_FILE)
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(skin, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  for (const name of await readdir(dir)) {
    if (name !== referenced && isImageFile(name))
      await unlink(join(dir, name)).catch(() => undefined)
  }

  const info = await stat(file)
  return { ok: true, entry: { id: target, skin, updatedAt: info.mtimeMs } }
}

/** 删除一套皮肤。不存在时返回 false，由调用方返回 404。 */
export async function deleteSkin(id: string): Promise<boolean> {
  if (!isSkinId(id)) return false
  const dir = join(skinsDir(), id)
  if (!(await stat(join(dir, SKIN_FILE)).catch(() => null))) return false
  await rm(dir, { recursive: true, force: true })
  return true
}
