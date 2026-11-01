/**
 * 皮肤库在界面一侧的读写：把当前选用的皮肤定义交给外观权威（`../theme.ts`）应用，
 * 维护设置页使用的皮肤列表，并在皮肤库变更时重新读取。
 *
 * 本模块不记录选用了哪套皮肤：选择只由外观权威记录，此处只读取定义并调用 `paintSkin`。
 */

import type { Skin, SkinEntry } from '@qywork/core'
import { createEffect, createRoot, createSignal, on } from 'solid-js'
import { ApiError } from '../../client.ts'
import { client, skinApply, skinsChange } from '../connection.ts'
import { state } from '../state.ts'
import { chooseSkin, paintedSkin, paintSkin, skinChoice } from '../theme.ts'

/** 设置页显示的皮肤列表。未读取时为 null。 */
export const [skinLibrary, setSkinLibrary] = createSignal<SkinEntry[] | null>(null)

/** 最近一次保存编辑失败的原因。保存成功后清空。 */
export const [skinSaveError, setSkinSaveError] = createSignal<string | null>(null)

/** 编辑停顿多久后保存。拖动滑块时每一帧都预览，只在停顿后写入一次。 */
const DRAFT_SAVE_MS = 250

let draftTimer: ReturnType<typeof setTimeout> | undefined
let draftsInFlight = 0

/**
 * 有尚未写入或正在写入的编辑。
 *
 * 期间不按 `skins.changed` 重新读取当前皮肤：先到达的是较早一次保存的结果，
 * 重新读取会使正在拖动的滑块跳回旧值，再随下一次保存跳回。
 */
function drafting(): boolean {
  return draftTimer !== undefined || draftsInFlight > 0
}

/** 图片背景的直链。`v` 取修改时间：同名图片被替换后地址随之变化，浏览器不沿用缓存。 */
export function skinImageUrl(entry: SkinEntry): string | null {
  const bg = entry.skin.background
  if (bg.kind !== 'image') return null
  const path = `/api/skins/${encodeURIComponent(entry.id)}/files/${encodeURIComponent(bg.file)}`
  return client.assetUrl(`${path}?v=${Math.round(entry.updatedAt)}`)
}

function paint(entry: SkinEntry): void {
  paintSkin({ id: entry.id, skin: entry.skin, imageUrl: skinImageUrl(entry) })
}

/** 选用一套皮肤并立即应用；传入 null 取消皮肤。 */
export function selectSkin(entry: SkinEntry | null): void {
  chooseSkin(entry ? { id: entry.id, base: entry.skin.base } : null)
  if (entry) paint(entry)
}

/** 按 id 读取并选用。皮肤已不存在时抛出 `ApiError`（404）。 */
export async function selectSkinById(id: string): Promise<void> {
  selectSkin(await client.api<SkinEntry>(`/api/skins/${encodeURIComponent(id)}`))
}

/**
 * 重新读取当前选用的皮肤并应用。皮肤已被删除（404）时取消选用，恢复主题偏好；
 * 其他错误保留当前外观，连接恢复后再次读取。
 */
async function repaintChosen(): Promise<void> {
  const choice = skinChoice()
  if (!choice) return
  try {
    paint(await client.api<SkinEntry>(`/api/skins/${encodeURIComponent(choice.id)}`))
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && skinChoice()?.id === choice.id)
      chooseSkin(null)
  }
}

/**
 * 编辑当前选用的皮肤：立即预览，停顿后保存。
 *
 * 图片背景沿用正在显示的直链：编辑控件不更换图片文件，更换经 `setSkinImage` 由服务端完成。
 */
export function editChosenSkin(skin: Skin): void {
  const choice = skinChoice()
  if (!choice) return
  const id = choice.id
  const imageUrl = skin.background.kind === 'image' ? (paintedSkin()?.imageUrl ?? null) : null
  paintSkin({ id, skin, imageUrl })
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    draftTimer = undefined
    draftsInFlight++
    saveSkin(id, skin)
      .then(() => setSkinSaveError(null))
      .catch((e: unknown) => setSkinSaveError(e instanceof ApiError ? e.message : String(e)))
      .finally(() => {
        draftsInFlight--
      })
  }, DRAFT_SAVE_MS)
}

export async function refreshSkinLibrary(): Promise<void> {
  const r = await client.api<{ skins: SkinEntry[] }>('/api/skins')
  setSkinLibrary(r.skins)
}

export function createSkin(skin: Skin): Promise<SkinEntry> {
  return client.api<SkinEntry>('/api/skins', { method: 'POST', body: JSON.stringify(skin) })
}

export function saveSkin(id: string, skin: Skin): Promise<SkinEntry> {
  return client.api<SkinEntry>(`/api/skins/${encodeURIComponent(id)}`, {
    method: 'PUT',
    body: JSON.stringify(skin),
  })
}

export async function removeSkin(id: string): Promise<void> {
  await client.api(`/api/skins/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** 把一张图片设为背景。文件名取原文件名，服务端校验扩展名。 */
export function setSkinImage(id: string, name: string, bytes: Blob): Promise<SkinEntry> {
  return client.api<SkinEntry>(
    `/api/skins/${encodeURIComponent(id)}/image?name=${encodeURIComponent(name)}`,
    { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' } },
  )
}

/**
 * 连接就绪时应用选用的皮肤；皮肤库变更时，若变更的是选用的皮肤则重新读取，列表已读取时一并刷新。
 *
 * 由入口在挂载后调用，不在模块顶层执行：顶层的 effect 会随 import 在单测中运行并发起请求。
 * 每次重新连接都重新读取：断线期间皮肤可能已在别处修改，期间的 `skins.changed` 已丢失。
 */
export function observeSkins(): () => void {
  return createRoot((dispose) => {
    createEffect(
      on(
        () => state.connection === 'ready',
        (ready) => {
          if (ready) void repaintChosen()
        },
      ),
    )
    // 对话中的 `skin` 工具切换皮肤：皮肤已不存在时（读取失败）保留当前外观。
    createEffect(
      on(
        skinApply,
        (req) => {
          if (!req) return
          if (req.id === null) selectSkin(null)
          else void selectSkinById(req.id).catch(() => undefined)
        },
        { defer: true },
      ),
    )
    createEffect(
      on(
        skinsChange,
        (change) => {
          if (!change) return
          if (change.id === skinChoice()?.id) {
            if (change.removed) chooseSkin(null)
            else if (!drafting()) void repaintChosen()
          }
          if (skinLibrary() !== null) void refreshSkinLibrary().catch(() => undefined)
        },
        { defer: true },
      ),
    )
    return dispose
  })
}
