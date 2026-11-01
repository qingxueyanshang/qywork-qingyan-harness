/**
 * 云端账号：电脑端登录、退出与内置模型的接口。
 *
 * 不变量：
 * - 登录状态只有一份，在本对象中：`pending` 期间重复登录返回同一个用户码；已登录以配置中存在云端接口为准。
 * - 设备密钥只保存在配置的云端接口（`CLOUD_PROVIDER`，地址为网关）中，没有第二份。
 * - 配置只经 `writeConfig` 写入；退出与「设备已被移除」使用同一个删除函数，`active` 与 `mediaDefaults` 指向它时一并删除。
 * - 只有网关明确返回 `device_revoked` 时才删除本地接口；其他失败（断网、云端故障）不删除，避免误清空配置。
 */

import { pullModels } from '@qywork/ai'
import type { QyConfig, StoredModel, StoredProvider } from '@qywork/runtime'
import { writeConfig } from '../api/config.ts'
import { hostLabel } from '../http-util.ts'
import type { CloudOrigins } from './origins.ts'

/** 云端接口在配置中的名称。 */
export const CLOUD_PROVIDER = 'qywork'
/** 设备授权的客户端 id，与云端 `DESKTOP_CLIENT_ID` 相同。 */
const CLIENT_ID = 'qywork-desktop'
/** 云端接口的默认协议；网关上协议不同的型号带各自的 `kind`（拉取时写入）。 */
const DEFAULT_KIND = 'anthropic_messages'

export type CloudState =
  | { state: 'unavailable' }
  | { state: 'signed_out'; reason?: 'revoked' | 'expired' | 'denied' | 'error'; message?: string }
  | { state: 'pending'; userCode: string; verificationUri: string; expiresAt: number }
  | { state: 'signed_in'; email: string; credits: number | null }

interface Pending {
  deviceCode: string
  userCode: string
  verificationUri: string
  expiresAt: number
  intervalMs: number
}

export interface CloudAccountOptions {
  /** 设备授权的轮询间隔（毫秒），按云端给出的秒数换算。测试中缩短。 */
  intervalMs?: (seconds: number) => number
}

/** 配置中的云端接口：名称为 `CLOUD_PROVIDER` 且地址为网关。 */
export function cloudProviderOf(config: QyConfig, origins: CloudOrigins): StoredProvider | null {
  const p = config.providers[CLOUD_PROVIDER]
  return p && p.baseUrl === origins.api ? p : null
}

const json = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
})

export class CloudAccount {
  private pending: Pending | null = null
  private failure: { reason: 'expired' | 'denied' | 'error'; message?: string } | null = null
  private email: string | null = null
  private refreshed = false
  private readonly intervalMs: (seconds: number) => number

  constructor(
    private readonly live: QyConfig,
    private readonly origins: CloudOrigins,
    options: CloudAccountOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? ((s) => s * 1000)
  }

  async state(): Promise<CloudState> {
    if (this.pending) {
      if (Date.now() <= this.pending.expiresAt) {
        const { userCode, verificationUri, expiresAt } = this.pending
        return { state: 'pending', userCode, verificationUri, expiresAt }
      }
      this.pending = null
      this.failure = { reason: 'expired' }
    }
    const provider = cloudProviderOf(this.live, this.origins)
    if (!provider?.apiKey) return { state: 'signed_out', ...(this.failure ?? {}) }
    const me = await this.me(provider.apiKey)
    if (me === 'revoked') {
      await this.remove()
      this.failure = null
      return { state: 'signed_out', reason: 'revoked' }
    }
    if (me) {
      this.email = me.email
      if (!this.refreshed) {
        this.refreshed = true
        void this.refreshModels(provider.apiKey).catch(() => {})
      }
      return { state: 'signed_in', email: me.email, credits: me.credits }
    }
    // 云端暂时无法访问：仍视为已登录，余额未知。
    return { state: 'signed_in', email: this.email ?? '', credits: null }
  }

  /** 发起登录；已在进行中时返回进行中的那一次。 */
  async login(): Promise<CloudState> {
    if (this.pending || cloudProviderOf(this.live, this.origins)) return this.state()
    this.failure = null
    try {
      const res = await fetch(
        `${this.origins.app}/api/auth/device/code`,
        json({ client_id: CLIENT_ID }),
      )
      if (!res.ok) throw new Error(`账号服务返回 ${res.status}`)
      const code = (await res.json()) as {
        device_code: string
        user_code: string
        verification_uri: string
        verification_uri_complete?: string
        expires_in: number
        interval?: number
      }
      this.pending = {
        deviceCode: code.device_code,
        userCode: code.user_code,
        verificationUri:
          code.verification_uri_complete ?? `${code.verification_uri}?user_code=${code.user_code}`,
        expiresAt: Date.now() + code.expires_in * 1000,
        intervalMs: this.intervalMs(code.interval ?? 5),
      }
      void this.poll(this.pending)
    } catch (err) {
      this.failure = {
        reason: 'error',
        message: `无法连接账号服务：${err instanceof Error ? err.message : String(err)}`,
      }
    }
    return this.state()
  }

  /** 退出：先请求云端吊销本设备（失败时仍在本地退出），再删除本地接口。 */
  async logout(): Promise<void> {
    this.pending = null
    this.failure = null
    this.email = null
    const provider = cloudProviderOf(this.live, this.origins)
    if (provider?.apiKey) {
      await fetch(`${this.origins.api}/v1/device/revoke`, json({}, provider.apiKey)).catch(() => {})
    }
    await this.remove()
  }

  private async poll(p: Pending): Promise<void> {
    let interval = p.intervalMs
    while (this.pending === p) {
      await Bun.sleep(interval)
      if (this.pending !== p) return
      if (Date.now() > p.expiresAt) {
        this.pending = null
        this.failure = { reason: 'expired' }
        return
      }
      let status: number
      let body: { access_token?: string; error?: string; error_description?: string }
      try {
        const res = await fetch(
          `${this.origins.app}/api/auth/device/token`,
          json({
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
            device_code: p.deviceCode,
            client_id: CLIENT_ID,
          }),
        )
        status = res.status
        body = (await res.json().catch(() => ({}))) as typeof body
      } catch {
        continue
      }
      if (status === 200 && body.access_token) {
        try {
          await this.complete(body.access_token)
        } catch (err) {
          this.failure = {
            reason: 'error',
            message: err instanceof Error ? err.message : String(err),
          }
        }
        if (this.pending === p) this.pending = null
        return
      }
      if (body.error === 'authorization_pending') continue
      if (body.error === 'slow_down') {
        interval += this.intervalMs(5)
        continue
      }
      this.pending = null
      this.failure =
        body.error === 'access_denied'
          ? { reason: 'denied' }
          : body.error === 'expired_token'
            ? { reason: 'expired' }
            : { reason: 'error', message: body.error_description ?? `账号服务返回 ${status}` }
      return
    }
  }

  /** 授权完成：登记设备取得设备密钥，注销这次的会话，写入云端接口与型号。 */
  private async complete(sessionToken: string): Promise<void> {
    const existing = this.live.providers[CLOUD_PROVIDER]
    if (existing && existing.baseUrl !== this.origins.api) {
      throw new Error(`已有名为「${CLOUD_PROVIDER}」的接口，请先在模型设置中改名`)
    }
    const res = await fetch(
      `${this.origins.app}/api/devices`,
      json({ name: hostLabel(), platform: process.platform }, sessionToken),
    )
    if (!res.ok) throw new Error(`登记设备失败（${res.status}）`)
    const { key } = (await res.json()) as { key: string }
    void fetch(`${this.origins.app}/api/auth/sign-out`, json({}, sessionToken)).catch(() => {})
    const models = await this.pulled(key)
    const result = await writeConfig(this.live, (current) => {
      const first = Object.keys(models)[0]
      return {
        ...current,
        providers: {
          ...current.providers,
          [CLOUD_PROVIDER]: { kind: DEFAULT_KIND, baseUrl: this.origins.api, apiKey: key, models },
        },
        ...(current.active || !first ? {} : { active: { provider: CLOUD_PROVIDER, model: first } }),
      }
    })
    if (result instanceof Response || 'problems' in result) {
      throw new Error(
        `写入配置失败：${'problems' in result ? result.problems.join('；') : result.status}`,
      )
    }
    this.refreshed = true
  }

  /**
   * 网关上的对话型号：协议与价格。网关价格清单的额度单位是积分，拉取按清单格式得到美元币种，
   * 此处改记为积分：费用与账号余额须使用同一单位显示。
   */
  private async pulled(key: string): Promise<Record<string, StoredModel>> {
    const result = await pullModels(
      { kind: DEFAULT_KIND, baseUrl: this.origins.api, apiKey: key },
      AbortSignal.timeout(20_000),
    )
    const models: Record<string, StoredModel> = {}
    for (const m of result.models) {
      if (m.output !== 'chat') continue
      models[m.id] = {
        ...(m.kind ? { kind: m.kind } : {}),
        ...(m.price ? { price: { ...m.price, currency: 'CREDIT' } } : {}),
      }
    }
    return models
  }

  /**
   * 更新网关上的型号：协议与价格随拉取结果更新，用户的思考档位等设置保留；新增的型号加入；
   * 网关上已停用的型号标记 `delisted`。每个进程只执行一次（首次确认已登录时），管理员调价后在下次启动时生效。
   */
  private async refreshModels(key: string): Promise<void> {
    const pulled = await this.pulled(key)
    await writeConfig(this.live, (current) => {
      const provider = cloudProviderOf(current, this.origins)
      if (!provider) return current
      const models: Record<string, StoredModel> = {}
      for (const [id, m] of Object.entries(provider.models)) {
        const { kind: _kind, price: _price, delisted: _delisted, ...rest } = m
        const hit = pulled[id]
        models[id] = hit ? { ...rest, ...hit } : { ...m, delisted: true }
      }
      for (const [id, m] of Object.entries(pulled)) models[id] ??= m
      return {
        ...current,
        providers: { ...current.providers, [CLOUD_PROVIDER]: { ...provider, models } },
      }
    })
  }

  private async me(key: string): Promise<{ email: string; credits: number } | 'revoked' | null> {
    try {
      const res = await fetch(`${this.origins.api}/v1/me`, {
        headers: { authorization: `Bearer ${key}` },
      })
      if (res.ok) return (await res.json()) as { email: string; credits: number }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
      return res.status === 401 && body?.error?.code === 'device_revoked' ? 'revoked' : null
    } catch {
      return null
    }
  }

  /** 删除本地的云端接口；`active` 与 `mediaDefaults` 指向它时一并删除，规则与设置页删除接口相同。 */
  private async remove(): Promise<void> {
    await writeConfig(this.live, (current) => {
      if (!(CLOUD_PROVIDER in current.providers)) return current
      const { [CLOUD_PROVIDER]: _removed, ...providers } = current.providers
      const next: QyConfig = { ...current, providers }
      if (next.active?.provider === CLOUD_PROVIDER) delete next.active
      if (next.mediaDefaults) {
        const kept = Object.fromEntries(
          Object.entries(next.mediaDefaults).filter(([, ref]) => ref?.provider !== CLOUD_PROVIDER),
        )
        if (Object.keys(kept).length) next.mediaDefaults = kept
        else delete next.mediaDefaults
      }
      return next
    })
  }
}
