/**
 * 云端账号（服务端 `/api/cloud/*`）。界面只有这一份账号状态，侧栏入口、账号弹窗与首次启动的登录页共用；
 * 每次读取与操作后以服务端返回为准。
 */

import type {
  CloudAccountOverview,
  CloudRechargeOrder,
  CloudRechargeStatus,
  CloudRedeemResult,
  CloudRequest,
  CloudState,
} from '@qywork/core'
import { createSignal } from 'solid-js'
import { client } from './client.ts'
import { reloadModelCatalog } from './settings.ts'

/** `null` 表示尚未读取，或读取失败：两者都不显示账号入口。 */
const [cloudState, setCloudState] = createSignal<CloudState | null>(null)
export { cloudState }

/**
 * 上一次读取的账号概览（账号窗口的全部内容）；本页尚未读取过为 null。账号窗口再次打开时先显示它、同时重新读取：
 * 到云端的读取常需数秒。登录与退出时清除，不显示上一个账号的内容。
 */
const [cloudOverview, setCloudOverview] = createSignal<CloudAccountOverview | null>(null)
export { cloudOverview }

export async function refreshCloudState(): Promise<void> {
  const state = await client.api<CloudState>('/api/cloud/state')
  setCloudState(state)
  // 不再是同一账号（已退出、设备被移除、另一端换了账号）：不再显示上一个账号的概览。
  if (state.state !== 'signed_in' || state.email !== cloudOverview()?.state.email) {
    setCloudOverview(null)
  }
}

/**
 * 把公告的已读位置写到云端账号。先改本地状态使圆点立即消失，再以服务端返回为准；
 * 写入失败时保留本地的值，下一次读取账号状态时恢复为云端的值。
 */
export async function markAnnouncementSeen(id: string): Promise<void> {
  const current = cloudState()
  if (current?.state !== 'signed_in') return
  setCloudState({ ...current, announcementSeen: id })
  setCloudState(
    await client.api<CloudState>('/api/cloud/announcements/seen', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  )
}

/**
 * 把客服对话的已读位置写到云端账号，返回后以服务端的账号状态为准（未读数随之更新）。先清除本地的未读数使圆点立即消失；
 * 写入失败时保留本地的值，下一次读取账号状态时恢复为云端的值。
 */
export async function markSupportRead(id: string): Promise<void> {
  const current = cloudState()
  if (current?.state !== 'signed_in') return
  setCloudState({ ...current, supportUnread: 0 })
  setCloudState(
    await client.api<CloudState>('/api/cloud/support/read', {
      method: 'POST',
      body: JSON.stringify({ id }),
    }),
  )
}

/** 登录或注册。失败时抛出可直接显示的原因，状态不变。成功后内置模型已写入配置，模型列表随之刷新。 */
export async function cloudSignIn(
  mode: 'login' | 'register',
  email: string,
  password: string,
  inviteCode = '',
): Promise<void> {
  const state = await client.api<CloudState>(`/api/cloud/${mode}`, {
    method: 'POST',
    body: JSON.stringify({
      email,
      password,
      ...(mode === 'register' && inviteCode ? { inviteCode } : {}),
    }),
  })
  setCloudOverview(null)
  setCloudState(state)
  void reloadModelCatalog()
}

export async function cloudLogout(): Promise<void> {
  setCloudOverview(null)
  setCloudState(await client.api<CloudState>('/api/cloud/logout', { method: 'POST' }))
  void reloadModelCatalog()
}

/** 更换头像：`image` 为裁剪编码后的 data URL。失败时抛出可直接显示的原因，状态不变。 */
export async function setCloudAvatar(image: string): Promise<void> {
  setCloudState(
    await client.api<CloudState>('/api/cloud/avatar', {
      method: 'PUT',
      body: JSON.stringify({ image }),
    }),
  )
}

/** 修改用户名，空字符串表示清除。失败时抛出可直接显示的原因，状态不变。 */
export async function setCloudName(name: string): Promise<void> {
  setCloudState(
    await client.api<CloudState>('/api/cloud/name', {
      method: 'PUT',
      body: JSON.stringify({ name }),
    }),
  )
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

/**
 * 读取账号窗口的全部内容：服务端经一次云端请求取得，不要拆成多个请求（理由见 `CloudAccountOverview`）。
 * 账号状态随之更新；服务端同时把型号清单写入配置，模型列表经 `config.changed` 刷新。
 */
export async function refreshCloudOverview(): Promise<CloudAccountOverview> {
  const overview = await readCloud<CloudAccountOverview>('/api/cloud/account')
  setCloudState(overview.state)
  setCloudOverview(overview)
  return overview
}

/** `before` 为上一页最后一条的 `startedAt`；返回空数组表示没有更早的记录。 */
export function fetchCloudRequests(before: string | null): Promise<CloudRequest[]> {
  return readCloud<CloudRequest[]>(
    `/api/cloud/requests${before ? `?before=${encodeURIComponent(before)}` : ''}`,
  )
}

/** 微信支付充值下单，`amount` 为整数元。失败时抛出可直接显示的原因。 */
export function createRecharge(amount: number): Promise<CloudRechargeOrder> {
  return client.api<CloudRechargeOrder>('/api/cloud/recharge', {
    method: 'POST',
    body: JSON.stringify({ amount }),
  })
}

/** 充值订单的状态；到账后余额以 `refreshCloudState` 重新读取。 */
export async function fetchRechargeStatus(orderNo: string): Promise<CloudRechargeStatus> {
  const reply = await client.api<{ status: CloudRechargeStatus }>(
    `/api/cloud/recharge/${encodeURIComponent(orderNo)}`,
  )
  return reply.status
}

/** 以兑换码兑换积分，返回得到的积分；账号状态随之更新。失败时抛出可直接显示的原因，状态不变。 */
export async function redeemCode(code: string): Promise<number> {
  const reply = await client.api<CloudRedeemResult>('/api/cloud/redeem', {
    method: 'POST',
    body: JSON.stringify({ code }),
  })
  setCloudState(reply.state)
  return reply.credits
}

/** 退出登录的原因，显示在登录表单上方。 */
export function signedOutReason(state: CloudState | null): string | null {
  return state?.state === 'signed_out' && state.reason === 'revoked' ? '设备已被移除' : null
}
