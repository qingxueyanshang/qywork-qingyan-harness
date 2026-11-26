/**
 * 界面偏好在界面一侧的读写：主题、字体大小与跟进处理方式。
 *
 * - 权威在电脑上（服务端 `/api/preferences`），全部屏幕读写同一份。连接就绪时读取，
 *   `preferences.changed` 推送保存后的内容，直接应用。
 * - 各项的当前值与本机记录由 `../theme.ts`、`font-scale.ts`、`../ui.ts` 持有，只经本文件修改。
 *   本机记录只用于连接之前的首次渲染，取得电脑上的值后即被覆盖。
 * - 电脑上从未保存（`updatedAt` 为 0）时，以本端当前的值作为初值写入：这三项此前只记录在各端，
 *   直接采用默认值会使用户已有的设置失效。
 * - 修改先应用到本端，停顿后只提交改动的字段。有尚未提交或正在提交的修改时不应用读取与推送的结果：
 *   先到达的是较早一次保存的结果，应用后正在拖动的滑块会回到旧值。
 * - 提交失败时显示原因并重新读取，本端回到电脑上的值；原因保留到下一次读取或保存成功。
 */

import { DEFAULT_UI_PREFERENCES, type UiPreferences, type UiPreferencesEntry } from '@qywork/core'
import { createEffect, createRoot, createSignal, on } from 'solid-js'
import { client } from '../client.ts'
import { explainApiError } from '../settings.ts'
import { state } from '../state.ts'
import { applyTheme, theme } from '../theme.ts'
import { applyFollowUpMode, followUpMode } from '../ui.ts'
import { applyFontScale, fontScale } from './font-scale.ts'

/** 最近一次读取或保存失败的说明。连接就绪时读取成功或保存成功后清空。 */
export const [preferencesError, setPreferencesError] = createSignal<string | null>(null)

/** 修改停顿达到该时长后提交。拖动字体大小滑块时每一帧都应用，只在停顿后提交一次。 */
const DRAFT_SAVE_MS = 250

let draftTimer: ReturnType<typeof setTimeout> | undefined
let draftsInFlight = 0
let pending: Partial<UiPreferences> = {}

function drafting(): boolean {
  return draftTimer !== undefined || draftsInFlight > 0
}

function current(): UiPreferences {
  return { theme: theme(), fontScale: fontScale(), followUpMode: followUpMode() }
}

function apply(p: UiPreferences): void {
  if (p.theme !== theme()) applyTheme(p.theme)
  if (p.fontScale !== fontScale()) applyFontScale(p.fontScale)
  applyFollowUpMode(p.followUpMode)
}

function isDefault(p: UiPreferences): boolean {
  return (
    p.theme === DEFAULT_UI_PREFERENCES.theme &&
    p.fontScale === DEFAULT_UI_PREFERENCES.fontScale &&
    p.followUpMode === DEFAULT_UI_PREFERENCES.followUpMode
  )
}

async function read(): Promise<UiPreferencesEntry | null> {
  try {
    return await client.api<UiPreferencesEntry>('/api/preferences')
  } catch (e) {
    setPreferencesError(explainApiError(e, '读取失败'))
    return null
  }
}

/**
 * 连接就绪时读取。电脑上从未保存时以本端当前的值作为初值写入，理由见文件头。
 * 只在此处写入初值，不要在提交失败后的重新读取中写入：写入持续失败时两者交替执行，不会停止。
 */
async function load(): Promise<void> {
  const entry = await read()
  if (!entry) return
  setPreferencesError(null)
  if (drafting()) return
  if (entry.updatedAt === 0 && !isDefault(current())) submit(current())
  else apply(entry.preferences)
}

function submit(patch: Partial<UiPreferences>): void {
  draftsInFlight++
  client
    .api<UiPreferencesEntry>('/api/preferences', { method: 'PUT', body: JSON.stringify(patch) })
    .then((entry) => {
      setPreferencesError(null)
      draftsInFlight--
      if (!drafting()) apply(entry.preferences)
    })
    .catch(async (e: unknown) => {
      setPreferencesError(explainApiError(e, '保存失败'))
      draftsInFlight--
      if (drafting()) return
      const entry = await read()
      if (entry && !drafting()) apply(entry.preferences)
    })
}

/** 修改界面偏好：立即应用到本端，停顿后提交改动的字段。 */
export function editPreferences(patch: Partial<UiPreferences>): void {
  apply({ ...current(), ...patch })
  pending = { ...pending, ...patch }
  clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    draftTimer = undefined
    const sent = pending
    pending = {}
    submit(sent)
  }, DRAFT_SAVE_MS)
}

/** 应用 `preferences.changed` 推送的内容。有未提交的修改时不应用，理由见文件头。 */
export function receivePreferences(p: UiPreferences): void {
  if (!drafting()) apply(p)
}

/**
 * 连接就绪时读取。由入口在挂载后调用，不在模块顶层执行：顶层的 effect 会随 import 在单测中运行并发起请求。
 * 每次重新连接都重新读取：断线期间界面偏好可能已在别处修改，期间的 `preferences.changed` 已丢失。
 */
export function observePreferences(): () => void {
  return createRoot((dispose) => {
    createEffect(
      on(
        () => state.connection === 'ready',
        (ready) => {
          if (ready) void load()
        },
      ),
    )
    return dispose
  })
}
