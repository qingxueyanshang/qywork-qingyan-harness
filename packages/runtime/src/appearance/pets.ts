/**
 * 宠物库：`<configDir>/pets/<id>/pet.json` 加该宠物的帧图片。设置页（经 HTTP 接口）与 `pet` 工具
 * 读写同一份，均经由本文件。
 *
 * 不变量与皮肤库相同（见 `skins.ts`）：校验先于落盘；`pet.json` 先写临时文件再重命名；
 * 目录中只保留当前引用的帧图片。
 */

import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  isPetId,
  isPetImageName,
  PET_IMAGE_EXTENSIONS,
  type PetEntry,
  parsePetPack,
  petFrameFiles,
} from '@qywork/core'
import { configDir } from '../config.ts'

/** 单张帧图片的上限。宠物显示尺寸不超过 160 像素，更大的图片不带来可见差异。 */
export const PET_IMAGE_MAX_BYTES = 4 * 1024 * 1024

const PET_FILE = 'pet.json'

export function petsDir(): string {
  return join(configDir(), 'pets')
}

export interface PetImage {
  name: string
  bytes: Uint8Array
}

export type PetSaveResult =
  | { ok: true; entry: PetEntry }
  | { ok: false; status: 404 | 422; error: string }

export interface PetList {
  pets: PetEntry[]
  failures: { id: string; reason: string }[]
}

function isImageFile(name: string): boolean {
  return (PET_IMAGE_EXTENSIONS as readonly string[]).some((ext) => name.toLowerCase().endsWith(ext))
}

function newPetId(): string {
  return `pet-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`
}

async function readEntry(id: string): Promise<{ entry: PetEntry } | { reason: string } | null> {
  const file = join(petsDir(), id, PET_FILE)
  const info = await stat(file).catch(() => null)
  if (!info) return null
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    return { reason: `pet.json 无法解析：${e instanceof Error ? e.message : String(e)}` }
  }
  const parsed = parsePetPack(raw)
  if (!parsed.ok) return { reason: parsed.error }
  return { entry: { id, pack: parsed.value, updatedAt: info.mtimeMs } }
}

export async function listPets(): Promise<PetList> {
  const names = await readdir(petsDir()).catch(() => [] as string[])
  const pets: PetEntry[] = []
  const failures: PetList['failures'] = []
  for (const id of names.sort()) {
    if (!isPetId(id)) continue
    const r = await readEntry(id)
    if (!r) continue
    if ('entry' in r) pets.push(r.entry)
    else failures.push({ id, reason: r.reason })
  }
  return { pets, failures }
}

export async function readPet(id: string): Promise<PetEntry | null> {
  if (!isPetId(id)) return null
  const r = await readEntry(id)
  return r && 'entry' in r ? r.entry : null
}

export async function petImagePath(id: string, name: string): Promise<string | null> {
  if (!isPetId(id) || !isPetImageName(name)) return null
  const file = join(petsDir(), id, name)
  return (await stat(file).catch(() => null))?.isFile() ? file : null
}

/**
 * 新建（`id` 为 null）或整体替换一只宠物，可同时写入帧图片。
 * 引用的每个文件都必须在本次写入的图片中，或已存在于该宠物目录中。
 */
export async function savePet(
  id: string | null,
  raw: unknown,
  images: PetImage[] = [],
): Promise<PetSaveResult> {
  const parsed = parsePetPack(raw)
  if (!parsed.ok) return { ok: false, status: 422, error: parsed.error }
  const pack = parsed.value
  for (const img of images) {
    if (!isPetImageName(img.name))
      return { ok: false, status: 422, error: `图片文件名不合法：${img.name}` }
    if (img.bytes.byteLength > PET_IMAGE_MAX_BYTES) {
      return {
        ok: false,
        status: 422,
        error: `图片超过 ${PET_IMAGE_MAX_BYTES / 1024 / 1024} MB：${img.name}`,
      }
    }
  }
  if (id !== null) {
    if (!isPetId(id)) return { ok: false, status: 422, error: `宠物 id 不合法：${id}` }
    if (!(await stat(join(petsDir(), id, PET_FILE)).catch(() => null))) {
      return { ok: false, status: 404, error: `宠物不存在：${id}` }
    }
  }
  const target = id ?? newPetId()
  const dir = join(petsDir(), target)
  const referenced = petFrameFiles(pack)
  for (const name of referenced) {
    if (
      !images.some((img) => img.name === name) &&
      !(await stat(join(dir, name)).catch(() => null))
    ) {
      return { ok: false, status: 422, error: `帧图片不存在：${name}` }
    }
  }

  await mkdir(dir, { recursive: true })
  for (const img of images) await writeFile(join(dir, img.name), img.bytes)
  const file = join(dir, PET_FILE)
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(pack, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  for (const name of await readdir(dir)) {
    if (!referenced.includes(name) && isImageFile(name))
      await unlink(join(dir, name)).catch(() => undefined)
  }
  const info = await stat(file)
  return { ok: true, entry: { id: target, pack, updatedAt: info.mtimeMs } }
}

export async function deletePet(id: string): Promise<boolean> {
  if (!isPetId(id)) return false
  const dir = join(petsDir(), id)
  if (!(await stat(join(dir, PET_FILE)).catch(() => null))) return false
  await rm(dir, { recursive: true, force: true })
  return true
}
