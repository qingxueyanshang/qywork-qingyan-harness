/**
 * 云端账号：电脑端以邮箱密码登录或注册、退出、内置模型的接口，以及账号界面读取的用量与使用记录。
 *
 * 不变量：
 * - 已登录以配置中存在云端接口为准；本对象只另记「设备已被移除」这一个退出原因。
 * - 设备密钥只保存在配置的云端接口（`CLOUD_PROVIDER`，地址为网关）中，没有第二份。
 * - 配置只经 `writeConfig` 写入；退出与「设备已被移除」使用同一个删除函数，`active` 与 `mediaDefaults` 指向它时一并删除。
 * - 只有网关或隧道明确返回「设备已被移除」时才删除本地接口；其他失败（断网、云端故障）不删除，避免误清空配置。
 * - 写入或删除云端接口后调用 `onChange`：远程访问据此启停隧道。
 */

import { httpStatusName, pullModels } from '@qywork/ai'
import type { CloudModel, CloudRequest, CloudState, CloudUsage } from '@qywork/core'
import type { QyConfig, StoredModel, StoredProvider } from '@qywork/runtime'
import { writeConfig } from '../api/config.ts'
import { hostLabel } from '../http-util.ts'

/** 云端接口在配置中的名称。 */
export const CLOUD_PROVIDER = 'qywork'
/** 云端接口的默认协议；网关上协议不同的型号带各自的 `kind`（拉取时写入）。 */
const DEFAULT_KIND = 'anthropic_messages'

/** 登录、注册或读取用量失败；`message` 直接显示给用户。 */
export class CloudAccountError extends Error {}

export interface CloudAccountOptions {
  /** 云端接口写入或删除之后。 */
  onChange?: () => void
}

/** 网关返回的请求记录：失败以状态码与网关的错误码表示，转为界面文字后交给账号界面。 */
type GatewayRequest = Omit<CloudRequest, 'failure'> & { status: number; errorCode: string | null }

/** 网关错误码对应的说明。`upstream_<状态码>` 写成「状态码 名称」，与运行页的报错写法相同。 */
function failure(status: number, errorCode: string | null): string | null {
  if (!errorCode) return null
  if (errorCode === 'stream_interrupted') return '连接中断'
  if (errorCode === 'upstream_unreachable') return '无法连接模型服务'
  if (errorCode.startsWith('upstream_')) return `${status} ${httpStatusName(status)}`
  return errorCode
}

/** Better Auth 的错误码对应的说明；未列出的错误码显示状态码与原文。 */
const AUTH_ERRORS: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: '邮箱或密码错误',
  INVALID_EMAIL: '邮箱格式不正确',
  USER_ALREADY_EXISTS: '该邮箱已注册',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: '该邮箱已注册',
  PASSWORD_TOO_SHORT: '密码至少 8 位',
  BANNED_USER: '账号已被停用',
}

/** 配置中的云端接口：名称为 `CLOUD_PROVIDER` 且地址为网关。 */
export function cloudProviderOf(config: QyConfig, origin: string): StoredProvider | null {
  const p = config.providers[CLOUD_PROVIDER]
  return p && p.baseUrl === origin ? p : null
}

const json = (body: unknown, token?: string): RequestInit => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  },
  body: JSON.stringify(body),
})

function unreachable(err: unknown): CloudAccountError {
  return new CloudAccountError(
    `无法连接账号服务：${err instanceof Error ? err.message : String(err)}`,
  )
}

export class CloudAccount {
  private wasRevoked = false
  private email: string | null = null
  private refreshed = false
  private readonly onChange: () => void

  constructor(
    private readonly live: QyConfig,
    private readonly origin: string,
    options: CloudAccountOptions = {},
  ) {
    this.onChange = options.onChange ?? (() => {})
  }

  async state(): Promise<CloudState> {
    const provider = cloudProviderOf(this.live, this.origin)
    if (!provider?.apiKey) {
      return this.wasRevoked ? { state: 'signed_out', reason: 'revoked' } : { state: 'signed_out' }
    }
    const me = await this.me(provider.apiKey)
    if (me === 'revoked') {
      await this.revoked()
      return { state: 'signed_out', reason: 'revoked' }
    }
    if (me) {
      this.email = me.email
      if (!this.refreshed) {
        this.refreshed = true
        void this.refreshModels(provider.apiKey).catch(() => {})
      }
      return {
        state: 'signed_in',
        email: me.email,
        credits: me.credits,
        avatar: me.avatar,
        provider: CLOUD_PROVIDER,
      }
    }
    // 云端暂时无法访问：仍视为已登录，余额与头像未知。
    return {
      state: 'signed_in',
      email: this.email ?? '',
      credits: null,
      avatar: null,
      provider: CLOUD_PROVIDER,
    }
  }

  /** 以邮箱密码登录。已登录时直接返回当前状态。 */
  login(email: string, password: string): Promise<CloudState> {
    return this.signIn('/v1/login', email, password)
  }

  /** 注册并登录。 */
  register(email: string, password: string): Promise<CloudState> {
    return this.signIn('/v1/register', email, password)
  }

  /**
   * 云端当前提供的对话型号与单价（积分 / 百万 token）。读取的同时更新配置中的云端接口：
   * 账号弹窗列出的型号与模型下拉列表一致，管理员调价或上架后无需重启。
   */
  async models(): Promise<CloudModel[]> {
    const provider = cloudProviderOf(this.live, this.origin)
    if (!provider?.apiKey) throw new CloudAccountError('未登录')
    let pulled: Record<string, StoredModel>
    try {
      pulled = await this.pulled(provider.apiKey)
    } catch (err) {
      throw unreachable(err)
    }
    await this.applyModels(pulled)
    return Object.entries(pulled).map(([id, m]) => ({
      id,
      price: m.price
        ? {
            input: m.price.input,
            output: m.price.output,
            cacheRead: m.price.cacheRead,
            cacheWrite: m.price.cacheWrite,
          }
        : null,
    }))
  }

  /** 更换头像。`image` 是客户端裁剪编码后的 data URL，格式与大小由云端校验。 */
  async setAvatar(image: string): Promise<CloudState> {
    await this.call('/v1/me/avatar', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image }),
    })
    return this.state()
  }

  /** 用量汇总，按本机时区分日。 */
  usage(): Promise<CloudUsage> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return this.call<CloudUsage>(`/v1/usage?tz=${encodeURIComponent(tz)}`)
  }

  /** 使用记录，按时间倒序；`before` 为上一页最后一条的 `startedAt`。 */
  async requests(before: string | null, limit: number): Promise<CloudRequest[]> {
    const query = new URLSearchParams({ limit: String(limit) })
    if (before) query.set('before', before)
    const rows = await this.call<GatewayRequest[]>(`/v1/requests?${query}`)
    return rows.map(({ status, errorCode, ...r }) => ({
      ...r,
      failure: failure(status, errorCode),
    }))
  }

  /** 云端答复本设备已被移除（网关或隧道）：删除本地接口，账号界面显示原因。 */
  async revoked(): Promise<void> {
    this.email = null
    await this.remove()
    this.wasRevoked = true
  }

  /** 退出：先请求云端吊销本设备（失败时仍在本地退出），再删除本地接口。 */
  async logout(): Promise<void> {
    this.wasRevoked = false
    this.email = null
    const provider = cloudProviderOf(this.live, this.origin)
    if (provider?.apiKey) {
      await fetch(`${this.origin}/v1/device/revoke`, json({}, provider.apiKey)).catch(() => {})
    }
    await this.remove()
  }

  /**
   * 登录或注册：云端在一次请求中完成登录与登记本设备，返回设备密钥（`/v1/login`、`/v1/register`）。
   * 失败抛出 `CloudAccountError`，状态仍为未登录。
   */
  private async signIn(path: string, email: string, password: string): Promise<CloudState> {
    if (cloudProviderOf(this.live, this.origin)) return this.state()
    let res: Response
    try {
      res = await fetch(
        `${this.origin}${path}`,
        json({ email, password, name: hostLabel(), platform: process.platform }),
      )
    } catch (err) {
      throw unreachable(err)
    }
    const reply = (await res.json().catch(() => ({}))) as {
      key?: string
      error?: { code?: string; message?: string }
    }
    if (!res.ok || !reply.key) {
      const known = reply.error?.code ? AUTH_ERRORS[reply.error.code] : undefined
      if (known) throw new CloudAccountError(known)
      if (res.status === 429) throw new CloudAccountError('尝试次数过多，请稍后再试')
      throw new CloudAccountError(
        `账号服务返回 ${res.status}${reply.error?.message ? `：${reply.error.message}` : ''}`,
      )
    }
    try {
      await this.complete(reply.key)
    } catch (err) {
      throw new CloudAccountError(err instanceof Error ? err.message : String(err))
    }
    this.wasRevoked = false
    return this.state()
  }

  /** 以设备密钥调用云端接口；204 返回 undefined。云端答复设备已被移除时删除本地接口。 */
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const provider = cloudProviderOf(this.live, this.origin)
    if (!provider?.apiKey) throw new CloudAccountError('未登录')
    let res: Response
    try {
      res = await fetch(`${this.origin}${path}`, {
        ...init,
        headers: { ...init.headers, authorization: `Bearer ${provider.apiKey}` },
      })
    } catch (err) {
      throw unreachable(err)
    }
    if (res.status === 204) return undefined as T
    if (res.ok) return (await res.json()) as T
    const body = (await res.json().catch(() => null)) as {
      error?: { code?: string; message?: string }
    } | null
    if (res.status === 401 && body?.error?.code === 'device_revoked') {
      await this.revoked()
      throw new CloudAccountError('设备已被移除')
    }
    throw new CloudAccountError(
      `账号服务返回 ${res.status}${body?.error?.message ? `：${body.error.message}` : ''}`,
    )
  }

  /** 登录完成：以设备密钥写入云端接口与型号。 */
  private async complete(key: string): Promise<void> {
    const existing = this.live.providers[CLOUD_PROVIDER]
    if (existing && existing.baseUrl !== this.origin) {
      throw new Error(`已有名为「${CLOUD_PROVIDER}」的接口，请先在模型设置中改名`)
    }
    const models = await this.pulled(key)
    const result = await writeConfig(this.live, (current) => {
      const first = Object.keys(models)[0]
      return {
        ...current,
        providers: {
          ...current.providers,
          [CLOUD_PROVIDER]: { kind: DEFAULT_KIND, baseUrl: this.origin, apiKey: key, models },
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
    this.onChange()
  }

  /**
   * 网关上的对话型号：协议与价格。网关价格清单的额度单位是积分，拉取按清单格式得到美元币种，
   * 此处改记为积分：费用与账号余额须使用同一单位显示。
   */
  private async pulled(key: string): Promise<Record<string, StoredModel>> {
    const result = await pullModels(
      { kind: DEFAULT_KIND, baseUrl: this.origin, apiKey: key },
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
   * 更新配置中网关上的型号：协议与价格随拉取结果更新，用户的思考档位等设置保留；新增的型号加入；
   * 网关上已停用的型号标记 `delisted`。每个进程首次确认已登录时执行一次，账号弹窗每次读取可用模型时再执行一次。
   */
  private async refreshModels(key: string): Promise<void> {
    await this.applyModels(await this.pulled(key))
  }

  private async applyModels(pulled: Record<string, StoredModel>): Promise<void> {
    await writeConfig(this.live, (current) => {
      const provider = cloudProviderOf(current, this.origin)
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

  private async me(
    key: string,
  ): Promise<{ email: string; credits: number; avatar: string | null } | 'revoked' | null> {
    try {
      const res = await fetch(`${this.origin}/v1/me`, {
        headers: { authorization: `Bearer ${key}` },
      })
      if (res.ok) {
        const me = (await res.json()) as { email: string; credits: number; avatar?: string | null }
        return { email: me.email, credits: me.credits, avatar: me.avatar ?? null }
      }
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
      return res.status === 401 && body?.error?.code === 'device_revoked' ? 'revoked' : null
    } catch {
      return null
    }
  }

  /** 删除本地的云端接口；`active` 与 `mediaDefaults` 指向它时一并删除，规则与设置页删除接口相同。 */
  private async remove(): Promise<void> {
    const result = await writeConfig(this.live, (current) => {
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
    if (!(result instanceof Response) && 'config' in result) this.onChange()
  }
}
