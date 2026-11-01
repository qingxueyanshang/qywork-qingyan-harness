/**
 * 个性化：`<configDir>/personalization/personalization.json` 加当前引用的一张图片。设置页（经 HTTP 接口）
 * 与 `personalize` 工具读写同一份，均经由本文件。
 *
 * 不变量：
 * - 只有一套。文件不存在即默认值，恢复默认即删除整个目录。
 * - 校验先于落盘：内容、图片文件名与引用关系全部通过后才写入，任何一项不通过都不改动磁盘。
 * - `personalization.json` 先写临时文件再重命名，读方只会读到完整的旧文件或新文件。
 * - 目录中只保留当前引用的图片：换图后旧图片随同一次保存删除，目录不随修改次数增长。
 */

import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_PERSONALIZATION,
  isPersonalImageName,
  PERSONAL_IMAGE_EXTENSIONS,
  type Personalization,
  type PersonalizationEntry,
  parsePersonalization,
} from '@qywork/core'
import { configDir } from '../config.ts'

/** 单张图片的上限。背景图按窗口尺寸显示，超过该值的图片不带来可见差异，只拖慢首帧。 */
export const PERSONAL_IMAGE_MAX_BYTES = 20 * 1024 * 1024

const FILE = 'personalization.json'

export function personalizationDir(): string {
  return join(configDir(), 'personalization')
}

export interface PersonalImage {
  name: string
  bytes: Uint8Array
}

export type PersonalizationSaveResult =
  | { ok: true; entry: PersonalizationEntry }
  | { ok: false; error: string }

export type PersonalizationRead =
  | { ok: true; entry: PersonalizationEntry }
  | { ok: false; error: string }

function isImageFile(name: string): boolean {
  return (PERSONAL_IMAGE_EXTENSIONS as readonly string[]).some((ext) =>
    name.toLowerCase().endsWith(ext),
  )
}

/**
 * 读取个性化。文件不存在时返回默认值；无法解析或校验失败时返回错误而不是默认值：
 * 手动修改出错的文件需要能被看到；返回默认值时界面显示默认外观，且不给出任何原因。
 */
export async function readPersonalization(): Promise<PersonalizationRead> {
  const file = join(personalizationDir(), FILE)
  const info = await stat(file).catch(() => null)
  if (!info) return { ok: true, entry: { personalization: DEFAULT_PERSONALIZATION, updatedAt: 0 } }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    return { ok: false, error: `${FILE} 无法解析：${e instanceof Error ? e.message : String(e)}` }
  }
  const parsed = parsePersonalization(raw)
  if (!parsed.ok) return { ok: false, error: `${FILE}：${parsed.error}` }
  return { ok: true, entry: { personalization: parsed.value, updatedAt: info.mtimeMs } }
}

/** 背景图片的绝对路径。文件名不合法、文件不存在时返回 null。 */
export async function personalImagePath(name: string): Promise<string | null> {
  if (!isPersonalImageName(name)) return null
  const file = join(personalizationDir(), name)
  return (await stat(file).catch(() => null))?.isFile() ? file : null
}

/**
 * 整体替换个性化，可同时写入图片。图片背景引用的文件必须在本次写入的图片中，或已存在于目录中。
 */
export async function savePersonalization(
  raw: unknown,
  images: PersonalImage[] = [],
): Promise<PersonalizationSaveResult> {
  const parsed = parsePersonalization(raw)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const value: Personalization = parsed.value
  for (const img of images) {
    if (!isPersonalImageName(img.name)) return { ok: false, error: `图片文件名不合法：${img.name}` }
    if (img.bytes.byteLength > PERSONAL_IMAGE_MAX_BYTES) {
      return {
        ok: false,
        error: `图片超过 ${PERSONAL_IMAGE_MAX_BYTES / 1024 / 1024} MB：${img.name}`,
      }
    }
  }

  const dir = personalizationDir()
  const referenced = value.background.kind === 'image' ? value.background.file : null
  if (
    referenced &&
    !images.some((img) => img.name === referenced) &&
    !(await stat(join(dir, referenced)).catch(() => null))
  ) {
    return { ok: false, error: `背景图片不存在：${referenced}` }
  }

  await mkdir(dir, { recursive: true })
  for (const img of images) await writeFile(join(dir, img.name), img.bytes)
  const file = join(dir, FILE)
  const temporary = `${file}.${crypto.randomUUID()}.tmp`
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => undefined)
  }
  for (const name of await readdir(dir)) {
    if (name !== referenced && isImageFile(name))
      await unlink(join(dir, name)).catch(() => undefined)
  }

  const info = await stat(file)
  return { ok: true, entry: { personalization: value, updatedAt: info.mtimeMs } }
}

/** 恢复默认：删除整个目录，包括图片。 */
export async function resetPersonalization(): Promise<PersonalizationEntry> {
  await rm(personalizationDir(), { recursive: true, force: true })
  return { personalization: DEFAULT_PERSONALIZATION, updatedAt: 0 }
}
