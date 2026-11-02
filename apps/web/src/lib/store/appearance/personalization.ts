/**
 * 个性化在界面一侧的读写：读取服务端的一套个性化交给外观权威（`../theme.ts`）应用，编辑时立即预览、
 * 停顿后保存，并在个性化变更时重新读取。
 */

import {
  DEFAULT_PERSONALIZATION,
  type Personalization,
  type PersonalizationEntry,
} from '@qywork/core'
import { createEffect, createRoot, createSignal, on } from 'solid-js'
import { client, personalizationChange } from '../connection.ts'
import { explainApiError } from '../settings.ts'
import { state } from '../state.ts'
import { paintedPersonalization, paintPersonalization } from '../theme.ts'

/** 最近一次保存或读取失败的说明（`explainApiError`）。成功后清空。 */
export const [personalizationError, setPersonalizationError] = createSignal<string | null>(null)

/** 编辑停顿多久后保存。拖动滑块时每一帧都预览，只在停顿后写入一次。 */
const DRAFT_SAVE_MS = 250

let draftTimer: ReturnType<typeof setTimeout> | undefined
let draftsInFlight = 0

/**
 * 有尚未写入或正在写入的编辑。
 *
 * 期间不按 `personalization.changed` 重新读取：先到达的是较早一次保存的结果，
 * 重新读取会使正在拖动的滑块跳回旧值，再随下一次保存跳回。
 */
function drafting(): boolean {
  return draftTimer !== undefined || draftsInFlight > 0
}

/** 图片背景的直链。`v` 取修改时间：同名图片被替换后地址随之变化，浏览器不沿用缓存。 */
function imageUrlOf(entry: PersonalizationEntry): string | null {
  const bg = entry.personalization.background
  if (bg.kind !== 'image') return null
  const path = `/api/personalization/files/${encodeURIComponent(bg.file)}`
  return client.assetUrl(`${path}?v=${Math.round(entry.updatedAt)}`)
}

function paint(entry: PersonalizationEntry): void {
  paintPersonalization({ personalization: entry.personalization, imageUrl: imageUrlOf(entry) })
}

/** 当前生效的个性化。尚未读取时为默认值。 */
export function currentPersonalization(): Personalization {
  return paintedPersonalization()?.personalization ?? DEFAULT_PERSONALIZATION
}

async function reload(): Promise<void> {
  try {
    paint(await client.api<PersonalizationEntry>('/api/personalization'))
    setPersonalizationError(null)
  } catch (e) {
    setPersonalizationError(explainApiError(e, '读取失败'))
  }
}

/**
 * 编辑个性化：立即预览，停顿后保存。
 *
 * 图片背景沿用正在显示的直链：编辑控件不更换图片文件，更换经 `setPersonalImage` 由服务端完成。
 */
export function editPersonalization(next: Personalization): void {
  const imageUrl =
    next.background.kind === 'image' ? (paintedPersonalization()?.imageUrl ?? null) : null
  paintPersonalization({ personalization: next, imageUrl })
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    draftTimer = undefined
    draftsInFlight++
    client
      .api<PersonalizationEntry>('/api/personalization', {
        method: 'PUT',
        body: JSON.stringify(next),
      })
      .then(() => setPersonalizationError(null))
      .catch((e: unknown) => setPersonalizationError(explainApiError(e, '保存失败')))
      .finally(() => {
        draftsInFlight--
      })
  }, DRAFT_SAVE_MS)
}

/** 恢复默认。未写入的编辑一并丢弃。 */
export async function resetPersonalization(): Promise<void> {
  clearTimeout(draftTimer)
  draftTimer = undefined
  paint(await client.api<PersonalizationEntry>('/api/personalization', { method: 'DELETE' }))
}

/** 把一张图片设为背景。文件名取原文件名，服务端校验扩展名。 */
export async function setPersonalImage(name: string, bytes: Blob): Promise<void> {
  paint(
    await client.api<PersonalizationEntry>(
      `/api/personalization/image?name=${encodeURIComponent(name)}`,
      { method: 'PUT', body: bytes, headers: { 'content-type': 'application/octet-stream' } },
    ),
  )
}

/**
 * 连接就绪时读取；个性化变更时重新读取（有未写入的编辑时不读）。
 *
 * 由入口在挂载后调用，不在模块顶层执行：顶层的 effect 会随 import 在单测中运行并发起请求。
 * 每次重新连接都重新读取：断线期间个性化可能已在别处修改，期间的 `personalization.changed` 已丢失。
 */
export function observePersonalization(): () => void {
  return createRoot((dispose) => {
    createEffect(
      on(
        () => state.connection === 'ready',
        (ready) => {
          if (ready) void reload()
        },
      ),
    )
    createEffect(
      on(
        personalizationChange,
        (seq) => {
          if (seq !== null && !drafting()) void reload()
        },
        { defer: true },
      ),
    )
    return dispose
  })
}
