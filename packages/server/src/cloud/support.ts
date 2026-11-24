/**
 * 客服对话：经云端 `/v1/support*` 读写，设备密钥只在本机服务中（`CloudAccount.call`、`request`）。
 * 对话不在本机保存：云端是唯一的来源，界面每次打开与收到 `support.changed` 时重新读取。
 */

import type { CloudState, SupportMessage } from '@qywork/core'
import pkg from '../../package.json' with { type: 'json' }
import type { CloudAccount } from './account.ts'

/** 本账号最近的客服消息，旧者在前。 */
export function supportThread(account: CloudAccount): Promise<SupportMessage[]> {
  return account.call<SupportMessage[]>('/v1/support')
}

/**
 * 发送一条消息。`form` 是界面提交的 multipart 表单（`body`、`files`），转发时另附本机的应用版本，供客服排查问题。
 * 正文与附件的上限由云端校验，超出时以 `CloudAccountError` 返回原因。
 */
export function sendSupport(
  account: CloudAccount,
  form: Awaited<ReturnType<Request['formData']>>,
): Promise<SupportMessage> {
  const out = new FormData()
  const body = form.get('body')
  out.set('body', typeof body === 'string' ? body : '')
  out.set('appVersion', pkg.version)
  for (const file of form.getAll('files')) if (typeof file !== 'string') out.append('files', file)
  return account.call<SupportMessage>('/v1/support', { method: 'POST', body: out })
}

/** 写入已读位置，返回写入后的账号状态（未读数随之更新）。 */
export async function markSupportRead(account: CloudAccount, id: string): Promise<CloudState> {
  await account.call('/v1/support/read', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  return account.state()
}

/** 附件的内容，类型与下载方式取云端的响应头。 */
export async function supportFile(account: CloudAccount, id: string): Promise<Response> {
  const res = await account.request(`/v1/support/files/${encodeURIComponent(id)}`)
  const headers = new Headers()
  for (const name of [
    'content-type',
    'content-disposition',
    'x-content-type-options',
    'content-security-policy',
    'cache-control',
  ]) {
    const value = res.headers.get(name)
    if (value) headers.set(name, value)
  }
  return new Response(res.body, { headers })
}
