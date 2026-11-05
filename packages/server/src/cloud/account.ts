/**
 * 云端账号：电脑端以邮箱密码登录或注册、退出、内置模型的接口，以及账号界面读取的用量、使用记录与充值；
 * 另有不需要登录的本版说明（云端的版本公告）与公告列表。
 *
 * 不变量：
 * - 已登录以配置中存在云端接口为准；本对象只另记「设备已被移除」这一个退出原因。
 * - 设备密钥只保存在配置的云端接口（`CLOUD_PROVIDER`，地址为网关）中，没有第二份。
 * - 配置只经 `writeConfig` 写入；退出与「设备已被移除」使用同一个删除函数，`active` 与 `mediaDefaults` 指向它时一并删除。
 * - 只有网关或隧道明确返回「设备已被移除」时才删除本地接口；其他失败（断网、云端故障）不删除，避免误清空配置。
 * - 写入或删除云端接口后调用 `onChange`：远程访问据此启停隧道。
 * - 云端型号清单（`/v1/catalog`）中带规格的型号，规格写入模型库覆盖层（`catalog`），只写本机模型库没有的型号，
 *   写入的条目带 `cloud` 标记；覆盖层仍是模型库之上唯一的一层，所有权规则见 `withSpecs`。
 */

import { httpStatusName, lookupModel } from '@qywork/ai'
import {
  type Announcement,
  type ChannelSpec,
  CLOUD_MEDIA_KIND,
  type CloudModel,
  type CloudRechargeOrder,
  type CloudRechargeStatus,
  type CloudRequest,
  type CloudState,
  type CloudUsage,
  type MediaBaseSpec,
  type MediaKind,
  type MediaOutput,
  type MediaUnit,
  type ProviderKind,
  type ReleaseNotes,
  type UnitPrice,
} from '@qywork/core'
import {
  catalogKey,
  type QyConfig,
  type StoredCatalogEntry,
  type StoredMediaModel,
  type StoredModel,
  type StoredProvider,
} from '@qywork/runtime'
import { writeConfig } from '../api/config.ts'
import { hostLabel } from '../http-util.ts'

/** 云端接口在配置中的名称。 */
export const CLOUD_PROVIDER = 'qywork'
/** 云端接口的默认协议；网关上协议不同的型号带各自的 `kind`。 */
const DEFAULT_KIND = 'anthropic_messages'

/** 云端 `/v1/catalog` 中的一个生成型号：原协议、规格来源、计费单位与单价（积分 / 单位）。 */
interface CatalogMediaModel {
  id: string
  output: MediaOutput
  protocol: MediaKind
  spec?: ChannelSpec | MediaBaseSpec
  unit: MediaUnit
  unitPrice: UnitPrice
}

/** 云端 `/v1/catalog`；`media` 在云端未提供生成任务时为空。 */
interface Catalog {
  models: CatalogModel[]
  media?: CatalogMediaModel[]
}

/**
 * 云端生成型号在配置中的形状：协议为该类别的云端生成协议，规格中记下原协议、原协议的规格来源与单价，
 * 参数表按原协议取得（`lookupMediaModel`）。
 */
function storedMedia(list: readonly CatalogMediaModel[]): Record<string, StoredMediaModel> {
  const media: Record<string, StoredMediaModel> = {}
  for (const m of list) {
    media[m.id] = {
      kind: CLOUD_MEDIA_KIND[m.output],
      spec: {
        cloud: {
          kind: m.protocol,
          ...(m.spec ? { spec: m.spec } : {}),
          unit: m.unit,
          unitPrice: m.unitPrice,
        },
      },
    }
  }
  return media
}

/** 云端 `/v1/catalog` 中的一个型号。单价为基础档单价乘以倍率，单位为积分 / 百万 token。 */
interface CatalogModel {
  id: string
  protocol: ProviderKind
  /** 售价倍率。 */
  ratio: number
  /** true：云端按模型库的官方价乘以倍率计价；false：按后台填写的单价乘以倍率计价。 */
  official: boolean
  price: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /** 云端为模型库中没有的型号填写的规格。 */
  spec?: { displayName: string; base?: string; contextWindow?: number; maxOutputTokens?: number }
}

/**
 * 云端型号在配置中的形状：协议与默认协议不同时带 `kind`，价格记为积分，与账号余额同一单位。
 * 云端按官方价计价、且本机模型库有该型号单价时只写倍率：运行面板按模型库的长上下文分档计算，与云端扣费一致。
 * 其余写单价。
 */
function storedModels(list: readonly CatalogModel[]): Record<string, StoredModel> {
  const models: Record<string, StoredModel> = {}
  for (const m of list) {
    const local = lookupModel(m.id, m.protocol, Date.now(), m.spec?.base)
    const scaled =
      m.official &&
      local.catalogued !== false &&
      local.pricing.input !== null &&
      local.pricing.output !== null
    models[m.id] = {
      ...(m.protocol !== DEFAULT_KIND ? { kind: m.protocol } : {}),
      price: scaled ? { scale: m.ratio, currency: 'CREDIT' } : { ...m.price, currency: 'CREDIT' },
    }
  }
  return models
}

/** 去掉云端写入的四项与 `cloud` 标记，保留其余字段；不剩任何字段时为 undefined。 */
function withoutCloud(entry: StoredCatalogEntry): StoredCatalogEntry | undefined {
  const {
    displayName: _displayName,
    base: _base,
    contextWindow: _contextWindow,
    maxOutputTokens: _maxOutputTokens,
    cloud: _cloud,
    ...rest
  } = entry
  return Object.keys(rest).length ? rest : undefined
}

const known = (id: string, kind: ProviderKind) => lookupModel(id, kind).catalogued !== false

/**
 * 云端规格写入模型库覆盖层后的 `catalog`。带 `cloud` 标记的条目中，显示名称、对应型号、窗口与输出上限四项归云端同步所有：
 * - 本机模型库已收录该型号时删除这四项，不论该型号是否仍在清单中：否则旧值（尤其是对应型号）继续优先于内置模型库；
 * - 本机模型库没有该型号时，四项与清单一致：清单给出规格则整体替换，不再给出则删除。对应型号不在本机模型库中时
 *   不写该项（配置校验会拒绝）。
 * 条目的其余字段保留。不按值比较判断哪些字段由云端写入：云端修改或清空规格后，旧值无从比较。
 */
function withSpecs(
  catalog: QyConfig['catalog'],
  list: readonly CatalogModel[],
): QyConfig['catalog'] {
  const next: Record<string, StoredCatalogEntry> = { ...catalog }
  const put = (key: string, entry: StoredCatalogEntry | undefined) => {
    if (entry) next[key] = entry
    else delete next[key]
  }
  for (const [key, entry] of Object.entries(next)) {
    const at = key.lastIndexOf('|')
    if (entry.cloud && known(key.slice(0, at), key.slice(at + 1) as ProviderKind)) {
      put(key, withoutCloud(entry))
    }
  }
  for (const m of list) {
    if (known(m.id, m.protocol)) continue
    const key = catalogKey(m.id, m.protocol)
    const entry = next[key]
    const rest = entry?.cloud ? withoutCloud(entry) : entry
    if (!m.spec) {
      if (entry?.cloud) put(key, rest)
      continue
    }
    const { displayName, base, contextWindow, maxOutputTokens } = m.spec
    put(key, {
      ...rest,
      displayName,
      ...(base && known(base, m.protocol) ? { base } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
      cloud: true,
    })
  }
  return Object.keys(next).length ? next : undefined
}

/** 登录、注册或读取用量失败；`message` 直接显示给用户。 */
export class CloudAccountError extends Error {}

export interface CloudAccountOptions {
  /** 云端接口写入或删除之后。 */
  onChange?: () => void
  /**
   * 每个云端请求的超时，默认 20 秒。请求都必须带上：账号窗口与登录按钮等待请求返回，
   * 连接停滞而没有超时时，界面一直停在读取中，不显示失败原因，也无法重试。
   */
  timeoutMs?: number
}

/** 网关返回的请求记录：失败以状态码与网关的错误码表示，转为界面文字后交给账号界面。 */
type GatewayRequest = Omit<CloudRequest, 'failure'> & { status: number; errorCode: string | null }

/** 网关错误码对应的说明。`upstream_<状态码>` 写成「状态码 名称」，与运行页的报错写法相同。 */
function failure(status: number, errorCode: string | null): string | null {
  if (!errorCode) return null
  if (errorCode === 'insufficient_credits') return '积分不足'
  if (errorCode === 'stream_interrupted') return '连接中断'
  // 本机停止本轮或连接断开，云端随即中止上游并按估算结算。
  if (errorCode === 'client_disconnected') return '已中断'
  // 云端服务在请求进行中崩溃，预扣已全额退回（云端 `gateway/holds.ts`）。
  if (errorCode === 'service_interrupted') return '服务中断，积分已退回'
  if (errorCode === 'upstream_unreachable') return '无法连接模型服务'
  if (errorCode.startsWith('upstream_')) return `${status} ${httpStatusName(status)}`
  // 生成任务的三种不计费终态（云端 `media/runner.ts`）：预扣全额退回。
  if (errorCode === 'media_failed') return '生成失败，积分已退回'
  if (errorCode === 'media_cancelled') return '已撤销，积分已退回'
  if (errorCode.startsWith('media_unknown_')) return '结果不明，积分已退回'
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
  private readonly timeoutMs: number

  constructor(
    private readonly live: QyConfig,
    private readonly origin: string,
    options: CloudAccountOptions = {},
  ) {
    this.onChange = options.onChange ?? (() => {})
    this.timeoutMs = options.timeoutMs ?? 20_000
  }

  private timeout(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs)
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
        origin: this.origin,
        recharge: me.recharge,
      }
    }
    // 云端暂时无法访问：仍视为已登录，余额与头像未知。
    return {
      state: 'signed_in',
      email: this.email ?? '',
      credits: null,
      avatar: null,
      provider: CLOUD_PROVIDER,
      origin: this.origin,
      recharge: false,
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
   * 云端当前提供的对话型号与单价（积分 / 百万 token）。读取的同时更新配置中的云端接口与型号规格：
   * 账号弹窗列出的型号与模型下拉列表一致，管理员调价或上架后无需重启。
   */
  async models(): Promise<CloudModel[]> {
    const list = await this.call<Catalog>('/v1/catalog')
    await this.applyModels(list)
    const media: CloudModel[] = (list.media ?? []).map((m) => ({
      output: m.output,
      id: m.id,
      unit: m.unit,
      unitPrice: m.unitPrice,
    }))
    return list.models
      .map(
        (m): CloudModel => ({
          output: 'chat',
          id: m.id,
          ratio: m.ratio,
          official: m.official === true,
          price: m.price,
        }),
      )
      .concat(media)
  }

  /**
   * 该版本已发布的版本公告（云端 `GET /api/announcements?version=`），不需要登录；没有时为 null。
   * 版本号须为 `x.y.z`。
   */
  async releaseNotes(version: string): Promise<ReleaseNotes | null> {
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new CloudAccountError(`版本号无效：${version}`)
    const notes = await this.publicGet<Omit<ReleaseNotes, 'version'> | null>(
      `/api/announcements?version=${version}`,
    )
    return (
      notes && { version, title: notes.title, body: notes.body, publishedAt: notes.publishedAt }
    )
  }

  /** 云端已发布的公告（`GET /api/announcements`），新者在前，不需要登录。 */
  announcements(): Promise<Announcement[]> {
    return this.publicGet<Announcement[]>('/api/announcements')
  }

  /** 读取云端不需要登录的接口。 */
  private async publicGet<T>(path: string): Promise<T> {
    let res: Response
    try {
      res = await fetch(`${this.origin}${path}`, { signal: this.timeout() })
    } catch (err) {
      throw unreachable(err)
    }
    if (!res.ok) {
      throw new CloudAccountError(`账号服务返回 ${res.status} ${httpStatusName(res.status)}`)
    }
    return (await res.json()) as T
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

  /** 微信支付充值下单，金额为整数元，范围由云端校验。 */
  recharge(amount: number): Promise<CloudRechargeOrder> {
    return this.call<CloudRechargeOrder>('/v1/recharge', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount }),
    })
  }

  /** 充值订单的状态。云端在未到账时向微信支付查单，支付成功即入账。 */
  async rechargeStatus(orderNo: string): Promise<CloudRechargeStatus> {
    const reply = await this.call<{ status: CloudRechargeStatus }>(
      `/v1/recharge/${encodeURIComponent(orderNo)}`,
    )
    return reply.status
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
      await fetch(`${this.origin}/v1/device/revoke`, {
        ...json({}, provider.apiKey),
        signal: this.timeout(),
      }).catch(() => {})
    }
    await this.remove()
  }

  /**
   * 登录或注册：云端在一次请求中完成登录与登记本设备，返回设备密钥（`/v1/login`、`/v1/register`）。
   * 失败抛出 `CloudAccountError`，状态仍为未登录。
   *
   * 已有名为 `CLOUD_PROVIDER` 但地址不是本云端的接口时拒绝：它可能是用户自建的接口，不覆盖。
   * 这项检查须在请求云端之前：云端登录成功即登记本设备，本地拒绝写入时该设备记录不再使用。
   */
  private async signIn(path: string, email: string, password: string): Promise<CloudState> {
    if (cloudProviderOf(this.live, this.origin)) return this.state()
    const existing = this.live.providers[CLOUD_PROVIDER]
    if (existing) {
      throw new CloudAccountError(
        `已有名为「${CLOUD_PROVIDER}」的接口（${existing.baseUrl}），请先在模型设置中改名或删除`,
      )
    }
    let res: Response
    try {
      res = await fetch(`${this.origin}${path}`, {
        ...json({ email, password, name: hostLabel(), platform: process.platform }),
        signal: this.timeout(),
      })
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
        signal: this.timeout(),
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
    const list = await this.catalog(key)
    const models = storedModels(list.models)
    const media = storedMedia(list.media ?? [])
    const result = await writeConfig(this.live, (current) => {
      const first = Object.keys(models)[0]
      const catalog = withSpecs(current.catalog, list.models)
      const { catalog: _catalog, ...rest } = current
      return {
        ...rest,
        ...(catalog ? { catalog } : {}),
        providers: {
          ...current.providers,
          [CLOUD_PROVIDER]: {
            kind: DEFAULT_KIND,
            baseUrl: this.origin,
            apiKey: key,
            models,
            ...(Object.keys(media).length ? { media } : {}),
          },
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

  /** 以设备密钥读取云端型号清单（登录完成时尚未写入接口，因此不经 `call`）。 */
  private async catalog(key: string, signal = this.timeout()): Promise<Catalog> {
    const res = await fetch(`${this.origin}/v1/catalog`, {
      headers: { authorization: `Bearer ${key}` },
      signal,
    })
    if (!res.ok) throw new Error(`读取型号清单失败：${res.status} ${httpStatusName(res.status)}`)
    return (await res.json()) as Catalog
  }

  /**
   * 更新配置中网关上的型号：协议与价格随清单更新，用户的思考档位等设置保留；新增的型号加入；
   * 网关上已停用的型号标记 `delisted`；型号规格写入模型库覆盖层（`withSpecs`）。
   * 每个进程首次确认已登录时执行一次，账号弹窗每次读取可用模型时再执行一次。
   */
  private async refreshModels(key: string): Promise<void> {
    await this.applyModels(await this.catalog(key))
  }

  /**
   * 一轮使用云端型号之前读取当前的型号与倍率。后台可随时调整倍率，配置中的副本只在登录、进程首次确认登录与
   * 打开账号窗口时更新；不在开始前同步时，调价之后的轮次按旧倍率记账，与云端扣费不一致。
   * 读取超时 3 秒，失败时抛出，由调用方沿用已保存的价格。
   */
  async syncModels(): Promise<void> {
    const provider = cloudProviderOf(this.live, this.origin)
    if (!provider?.apiKey) return
    await this.applyModels(await this.catalog(provider.apiKey, AbortSignal.timeout(3000)))
  }

  /** 写入清单中的型号与价格；与配置中已有的内容相同时不写入。 */
  private async applyModels(list: Catalog): Promise<void> {
    const listed = storedModels(list.models)
    const listedMedia = storedMedia(list.media ?? [])
    await writeConfig(this.live, (current) => {
      const provider = cloudProviderOf(current, this.origin)
      if (!provider) return current
      const models: Record<string, StoredModel> = {}
      for (const [id, m] of Object.entries(provider.models)) {
        const { kind: _kind, price: _price, delisted: _delisted, ...rest } = m
        const hit = listed[id]
        models[id] = hit ? { ...rest, ...hit } : { ...m, delisted: true }
      }
      for (const [id, m] of Object.entries(listed)) models[id] ??= m
      // 生成型号的协议与规格全部由清单决定；清单中已没有的型号标记已下架。
      const media: Record<string, StoredMediaModel> = {}
      for (const [id, m] of Object.entries(provider.media ?? {}))
        media[id] = listedMedia[id] ?? { ...m, delisted: true }
      for (const [id, m] of Object.entries(listedMedia)) media[id] ??= m
      const catalog = withSpecs(current.catalog, list.models)
      if (
        JSON.stringify(models) === JSON.stringify(provider.models) &&
        JSON.stringify(media) === JSON.stringify(provider.media ?? {}) &&
        JSON.stringify(catalog) === JSON.stringify(current.catalog)
      ) {
        return current
      }
      const { catalog: _catalog, ...rest } = current
      const { media: _media, ...base } = provider
      return {
        ...rest,
        ...(catalog ? { catalog } : {}),
        providers: {
          ...current.providers,
          [CLOUD_PROVIDER]: { ...base, models, ...(Object.keys(media).length ? { media } : {}) },
        },
      }
    })
  }

  private async me(
    key: string,
  ): Promise<
    { email: string; credits: number; avatar: string | null; recharge: boolean } | 'revoked' | null
  > {
    try {
      const res = await fetch(`${this.origin}/v1/me`, {
        headers: { authorization: `Bearer ${key}` },
        signal: this.timeout(),
      })
      if (res.ok) {
        const me = (await res.json()) as {
          email: string
          credits: number
          avatar?: string | null
          recharge?: boolean
        }
        return {
          email: me.email,
          credits: me.credits,
          avatar: me.avatar ?? null,
          recharge: me.recharge === true,
        }
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
