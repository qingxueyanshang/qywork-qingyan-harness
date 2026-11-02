/**
 * 云端账号（服务端 `/api/cloud/*`）。界面只有这一份账号状态，侧栏入口、账号弹窗与首次启动的登录页共用；
 * 每次读取与操作后以服务端返回为准。
 */

import type { CloudRequest, CloudState, CloudUsage } from '@qywork/core'
import { createSignal } from 'solid-js'
import { client } from './connection.ts'
import { reloadModelCatalog } from './settings.ts'

/** `null` 表示尚未读取，或读取失败：两者都不显示账号入口。 */
const [cloudState, setCloudState] = createSignal<CloudState | null>(null)
export { cloudState }

export async function refreshCloudState(): Promise<void> {
  setCloudState(await client.api<CloudState>('/api/cloud/state'))
}

/** 登录或注册。失败时抛出可直接显示的原因，状态不变。成功后内置模型已写入配置，模型列表随之刷新。 */
export async function cloudSignIn(
  mode: 'login' | 'register',
  email: string,
  password: string,
): Promise<void> {
  const state = await client.api<CloudState>(`/api/cloud/${mode}`, {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  setCloudState(state)
  void reloadModelCatalog()
}

export async function cloudLogout(): Promise<void> {
  setCloudState(await client.api<CloudState>('/api/cloud/logout', { method: 'POST' }))
  void reloadModelCatalog()
}

/** 读取用量或记录失败时，设备可能已被移除：服务端已删除本地接口，状态随之重新读取。 */
async function readCloud<T>(path: string): Promise<T> {
  try {
    return await client.api<T>(path)
  } catch (e) {
    void refreshCloudState().catch(() => {})
    throw e
  }
}

export function fetchCloudUsage(): Promise<CloudUsage> {
  return readCloud<CloudUsage>('/api/cloud/usage')
}

/** `before` 为上一页最后一条的 `startedAt`；返回空数组表示没有更早的记录。 */
export function fetchCloudRequests(before: string | null): Promise<CloudRequest[]> {
  return readCloud<CloudRequest[]>(
    `/api/cloud/requests${before ? `?before=${encodeURIComponent(before)}` : ''}`,
  )
}

/** 退出登录的原因，显示在登录表单上方。 */
export function signedOutReason(state: CloudState | null): string | null {
  return state?.state === 'signed_out' && state.reason === 'revoked' ? '设备已被移除' : null
}
