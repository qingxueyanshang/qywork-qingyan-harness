/**
 * 界面偏好：`<configDir>/preferences.json`。界面偏好接口经由本文件读写。
 *
 * 不变量：
 * - 文件不存在即默认值，`updatedAt` 为 0。
 * - 校验先于落盘：合并后的内容整体通过校验才写入，不通过时不改动磁盘。
 * - 先写临时文件再重命名，读取方只会读取到完整的旧文件或新文件。
 * - 修改逐个执行（`queue`）。不要改为并发执行：两次修改读取到同一份内容时，后写入的一次会覆盖先写入的字段。
 */

import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_UI_PREFERENCES,
  mergeUiPreferences,
  parseUiPreferences,
  type UiPreferencesEntry,
} from '@qywork/core'
import { configDir } from '../config.ts'

const FILE = 'preferences.json'

export type UiPreferencesRead =
  | { ok: true; entry: UiPreferencesEntry }
  | { ok: false; error: string }

function preferencesFile(): string {
  return join(configDir(), FILE)
}

/**
 * 读取界面偏好。无法解析或校验失败时返回错误而不是默认值：返回默认值时界面显示默认外观，且不给出任何原因。
 */
export async function readUiPreferences(): Promise<UiPreferencesRead> {
  const file = preferencesFile()
  const info = await stat(file).catch(() => null)
  if (!info) return { ok: true, entry: { preferences: DEFAULT_UI_PREFERENCES, updatedAt: 0 } }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch (e) {
    return { ok: false, error: `${FILE} 无法解析：${e instanceof Error ? e.message : String(e)}` }
  }
  const parsed = parseUiPreferences(raw)
  if (!parsed.ok) return { ok: false, error: `${FILE}：${parsed.error}` }
  return { ok: true, entry: { preferences: parsed.value, updatedAt: info.mtimeMs } }
}

let queue: Promise<unknown> = Promise.resolve()

/**
 * 把部分修改合并到已保存的界面偏好上并写入。已保存的文件无法读取时以默认值为基础：
 * 修改是用户在界面上的新选择，以它覆盖无法读取的文件即恢复为可用状态。
 */
export function saveUiPreferences(patch: unknown): Promise<UiPreferencesRead> {
  const run = queue.then(async (): Promise<UiPreferencesRead> => {
    const current = await readUiPreferences()
    const base = current.ok ? current.entry.preferences : DEFAULT_UI_PREFERENCES
    const merged = mergeUiPreferences(base, patch)
    if (!merged.ok) return merged
    const file = preferencesFile()
    await mkdir(configDir(), { recursive: true })
    const temporary = `${file}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(merged.value, null, 2)}\n`, 'utf8')
      await rename(temporary, file)
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
    const info = await stat(file)
    return { ok: true, entry: { preferences: merged.value, updatedAt: info.mtimeMs } }
  })
  queue = run.catch(() => undefined)
  return run
}
