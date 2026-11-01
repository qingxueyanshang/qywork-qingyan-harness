/**
 * 云端账号（服务端 `/api/cloud/*`）。状态以服务端为准，界面不另存登录状态。
 */

import { client } from './connection.ts'
import { reloadModelCatalog } from './settings.ts'
import { isDesktopShell } from './shell.ts'

export type CloudState =
  | { state: 'unavailable' }
  | { state: 'signed_out'; reason?: 'revoked' | 'expired' | 'denied' | 'error'; message?: string }
  | { state: 'pending'; userCode: string; verificationUri: string; expiresAt: number }
  /** `provider` 是配置中云端接口的名称：模型设置页不提供它的编辑与删除，移除只经退出。 */
  | { state: 'signed_in'; email: string; credits: number | null; provider: string }

export function fetchCloudState(): Promise<CloudState> {
  return client.api<CloudState>('/api/cloud/state')
}

/** 发起登录。桌面外壳中由服务端打开系统浏览器；其他情况下界面显示链接。 */
export function startCloudLogin(): Promise<CloudState> {
  return client.api<CloudState>('/api/cloud/login', {
    method: 'POST',
    body: JSON.stringify({ openBrowser: isDesktopShell() }),
  })
}

export async function cloudLogout(): Promise<CloudState> {
  const state = await client.api<CloudState>('/api/cloud/logout', { method: 'POST' })
  void reloadModelCatalog()
  return state
}

/** 退出登录或设备被移除时的原因，显示在账号区块中。 */
export function signedOutReason(state: CloudState): string | null {
  if (state.state !== 'signed_out' || !state.reason) return null
  return {
    revoked: '设备已被移除',
    expired: '登录码已过期',
    denied: '已在浏览器中拒绝',
    error: state.message ?? '登录失败',
  }[state.reason]
}
