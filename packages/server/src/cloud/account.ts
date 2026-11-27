/**
 * 云端账号：电脑端以邮箱密码登录或注册、退出、内置模型的接口，以及账号界面读取的用量、使用记录、充值与兑换码；
 * 另有不需要登录的本版说明（云端的版本公告）与公告列表。
 *
 * 不变量：
 * - 已登录以配置中存在云端接口为准；本对象只另记「设备已被移除」这一个退出原因。
 * - 设备密钥只保存在配置的云端接口（`CLOUD_PROVIDER`，地址为网关）中，没有第二份。
 * - 配置只经 `writeConfig` 写入；退出与「设备已被移除」使用同一个删除函数，`active` 与 `mediaDefaults` 指向它时一并删除。
 * - 只有网关或隧道明确返回「设备已被移除」时才删除本地接口；其他失败（断网、云端故障）不删除，避免误清空配置。
 * - 写入或删除云端接口后调用 `onChange`：隧道据此按登录状态启停。
 * - 云端型号清单（`/v1/catalog`）中带规格的型号，规格写入模型库覆盖层（`catalog`），只写本机模型库没有的型号，
 *   写入的条目带 `cloud` 标记；覆盖层仍是模型库之上唯一的一层，所有权规则见 `withSpecs`。
 * - 每个型号的显示名称写入云端接口下该型号的条目（`displayName`），不写入覆盖层：覆盖层为所有接口共用，
 *   写入后用户自建接口中的同名型号也显示云端的名称。
 * - 型号清单中的内置技能只保存在本对象中（`builtinSkills`），与型号在同一次读取中更新，退出时清除。
 * - 型号清单不等用户打开账号窗口才同步：推送通道（隧道）连上时与收到 `catalog.changed` 时立即同步；
 *   读取账号状态（窗口获得焦点、连接可用）时，清单不再最新（`fresh`）则在后台同步。写入配置后界面经
 *   `config.changed` 重新读取模型目录。
 */

import { httpStatusName, lookupModel, transportFailureKind } from '@qywork/ai'
import {
  type Announcement,
  CLOUD_MEDIA_KIND,
  type CloudAccountOverview,
  type CloudModel,
  type CloudModelSpec,
  type CloudRechargeOrder,
  type CloudRechargeStatus,
  type CloudRedeemResult,
  type CloudRequest,
  type CloudSkill,
  type CloudState,
  type CloudUsage,
  log,
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

/**
 * 云端 `/v1/catalog` 中的一个生成型号：对外编号、显示名称、云端下发的规格、计费单位与单价（积分 / 单位）。
 * 清单中的上游协议与规格来源（`protocol`、`spec`）不读取：配置中不保存上游协议与渠道规格。
 */
interface CatalogMediaModel {
  id: string
  /** 后台填写的显示名称。 */
  displayName: string
  output: MediaOutput
  /** 参数表、能力与计量参数名，不含上游协议与渠道。 */
  cloudSpec: CloudModelSpec
  unit: MediaUnit
  unitPrice: UnitPrice
}

/** 云端 `/v1/catalog`；`media` 在云端未提供生成任务时为空。 */
interface Catalog {
  models: CatalogModel[]
  media?: CatalogMediaModel[]
  skills: CloudSkill[]
}

/**
 * 云端生成型号在配置中的形状：协议为该类别的云端生成协议，规格中记录云端下发的规格与单价，
 * 参数表、能力与报价由此取得（`lookupMediaModel`）。
 */
function storedMedia(list: readonly CatalogMediaModel[]): Record<string, StoredMediaModel> {
  const media: Record<string, StoredMediaModel> = {}
  for (const m of list) {
    media[m.id] = {
      kind: CLOUD_MEDIA_KIND[m.output],
      spec: { cloud: { spec: m.cloudSpec, unit: m.unit, unitPrice: m.unitPrice } },
      displayName: m.displayName,
    }
  }
  return media
}

/** 云端 `/v1/catalog` 中的一个型号。单价为基础档单价乘以倍率，单位为积分 / 百万 token。 */
interface CatalogModel {
  id: string
  /** 后台填写的显示名称。 */
  displayName: string
  protocol: ProviderKind
  /** 售价倍率。 */
  ratio: number
  /** true：云端按模型库的官方价乘以倍率计价；false：按后台填写的单价乘以倍率计价。 */
  official: boolean
  price: { input: number; output: number; cacheRead: number; cacheWrite: number }
  /**
   * 对应型号（`base`，模型库 id，能力与官方价据此取得）与后台填写的窗口、输出上限。型号 id 是对外编号，不在模型库中。
   * 其中的显示名称不读取，以顶层的 `displayName` 为准。
   */
  spec?: { base?: string; contextWindow?: number; maxOutputTokens?: number }
}

/**
 * 云端型号在配置中的形状：带后台填写的显示名称，协议与默认协议不同时带 `kind`，价格记为积分，与账号余额同一单位。
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
      displayName: m.displayName,
    }
  }
  return models
}

/** 去掉归云端同步所有的四项与 `cloud` 标记，保留其余字段；不剩任何字段时为 undefined。 */
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
 * 「旧型号 id → 对外编号」。云端型号使用对外编号之前，配置与会话按云端的内部 id 记录型号；内部 id 是模型库 id 时，
 * 清单中该型号的对应型号（`spec.base`）即该 id。对应型号为该 id 的型号恰有一个、且该 id 不是清单中的型号时列入；
 * 对应型号相同的型号有多个时无法确定是哪一个，不列入。
 */
function renamedModels(list: readonly CatalogModel[]): Map<string, string> {
  const listed = new Set(list.map((m) => m.id))
  const byBase = new Map<string, string[]>()
  for (const m of list) {
    const base = m.spec?.base
    if (base && !listed.has(base)) byBase.set(base, [...(byBase.get(base) ?? []), m.id])
  }
  return new Map(
    [...byBase].flatMap(([base, ids]) => (ids.length === 1 ? [[base, ids[0] as string]] : [])),
  )
}

/**
 * 云端规格写入模型库覆盖层后的 `catalog`。带 `cloud` 标记的条目中，显示名称、对应型号、窗口与输出上限四项归云端同步所有，
 * 同步只写入后三项：显示名称写在云端接口的型号条目上（`storedModels`），写入覆盖层会使用户自建接口中的同名型号也显示云端的名称。
 * - 本机模型库已收录该型号时删除这四项，不论该型号是否仍在清单中：否则旧值（尤其是对应型号）继续优先于内置模型库；
 * - 本机模型库没有该型号时，四项与清单一致：清单给出规格则整体替换，不再给出则删除。对应型号不在本机模型库中时
 *   不写该项（配置校验会拒绝）；
 * - 清单中已没有该型号时删除这四项：云端型号使用对外编号之前按内部 id 写入的条目随之清除，内部 id 可能透露上游供应商。
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
  const listed = new Set(list.map((m) => catalogKey(m.id, m.protocol)))
  for (const [key, entry] of Object.entries(next)) {
    const at = key.lastIndexOf('|')
    if (
      entry.cloud &&
      (!listed.has(key) || known(key.slice(0, at), key.slice(at + 1) as ProviderKind))
    ) {
      put(key, withoutCloud(entry))
    }
  }
  for (const m of list) {
    if (known(m.id, m.protocol)) continue
    const key = catalogKey(m.id, m.protocol)
    const entry = next[key]
    const rest = entry?.cloud ? withoutCloud(entry) : entry
    const { base, contextWindow, maxOutputTokens } = m.spec ?? {}
    const owned = {
      ...(base && known(base, m.protocol) ? { base } : {}),
      ...(contextWindow ? { contextWindow } : {}),
      ...(maxOutputTokens ? { maxOutputTokens } : {}),
    }
    if (Object.keys(owned).length) put(key, { ...rest, ...owned, cloud: true })
    else if (entry?.cloud) put(key, rest)
  }
  return Object.keys(next).length ? next : undefined
}

/** 登录、注册或读取用量失败；`message` 直接显示给用户。 */
export class CloudAccountError extends Error {}

export interface CloudAccountOptions {
  /** 云端接口写入或删除之后。 */
  onChange?: () => void
  /**
   * 每次写入型号清单之后，传入「旧型号 id → 对外编号」（`renamedModels`），没有时不调用。装配方据此改写会话记录的型号：
   * 会话按记录的型号 id 发送，云端只接受对外编号。
   */
  onModelsRenamed?: (renamed: ReadonlyMap<string, string>) => void
  /**
   * 每个云端请求的超时，默认 20 秒。每个请求都必须设置：账号窗口与登录按钮等待请求返回，
   * 连接停滞而没有超时时，界面持续显示读取中，不显示失败原因，也无法重试。
   */
  timeoutMs?: number
  /** 读取请求连接失败后各次重发之前的等待，毫秒；默认重发两次。 */
  resendDelaysMs?: readonly number[]
}

/** 网关返回的请求记录：失败以状态码与网关的错误码表示，转为界面文字后交给账号界面。 */
type GatewayRequest = Omit<CloudRequest, 'failure'> & { status: number; errorCode: string | null }

function toRequest({ status, errorCode, ...r }: GatewayRequest): CloudRequest {
  return { ...r, failure: failure(status, errorCode) }
}

/** 云端 `/v1/me` 的应答；云端未返回的可选字段取缺省值（`meOf`）。 */
interface MeReply {
  email: string
  name?: string
  credits: number
  avatar?: string | null
  recharge?: boolean
  announcementSeen?: string | null
  support?: boolean
  supportUnread?: number
  square?: boolean
}

type Me = Required<Omit<MeReply, 'avatar' | 'announcementSeen'>> & {
  avatar: string | null
  announcementSeen: string | null
}

function meOf(me: MeReply): Me {
  return {
    email: me.email,
    name: me.name ?? '',
    credits: me.credits,
    avatar: me.avatar ?? null,
    recharge: me.recharge === true,
    announcementSeen: me.announcementSeen ?? null,
    support: me.support === true,
    supportUnread: me.supportUnread ?? 0,
    square: me.square === true,
  }
}

/** 账号窗口列出的型号与单价：对话型号在前、生成型号在后，各自按清单的顺序。 */
function cloudModels(list: Catalog): CloudModel[] {
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

/** 没有推送通道时，配置中的型号清单视为最新的时长。 */
const STALE_MS = 60_000

/**
 * 推送通道连接期间，配置中的型号清单视为最新的时长。不是无限长：云端部署重叠期间，电脑仍连在旧进程上，
 * 无法收到新进程发出的推送。
 */
const PUSH_TRUST_MS = 10 * 60_000

/** 网关错误码对应的说明。`upstream_<状态码>` 写成「状态码 名称」，与运行页的报错写法相同。 */
function failure(status: number, errorCode: string | null): string | null {
  if (!errorCode) return null
  if (errorCode === 'insufficient_credits') return '积分不足'
  if (errorCode === 'stream_interrupted') return '连接中断'
  // 本机停止本轮或连接断开，云端随即中止上游并按估算结算。
  if (errorCode === 'client_disconnected') return '已中断'
  // 云端服务在请求进行中崩溃，预扣已全额退回。
  if (errorCode === 'service_interrupted') return '服务中断，积分已退回'
  if (errorCode === 'upstream_unreachable') return '无法连接模型服务'
  if (errorCode.startsWith('upstream_')) return `${status} ${httpStatusName(status)}`
  // 生成任务的三种不计费终态：预扣全额退回。
  if (errorCode === 'media_failed') return '生成失败，积分已退回'
  if (errorCode === 'media_cancelled') return '已撤销，积分已退回'
  if (errorCode.startsWith('media_unknown_')) return '结果不明，积分已退回'
  return errorCode
}

/** Better Auth 的错误码与云端注册的 `invite_not_found` 对应的说明；未列出的错误码显示状态码与原文。 */
const AUTH_ERRORS: Record<string, string> = {
  INVALID_EMAIL_OR_PASSWORD: '邮箱或密码错误',
  INVALID_EMAIL: '邮箱格式不正确',
  USER_ALREADY_EXISTS: '该邮箱已注册',
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: '该邮箱已注册',
  PASSWORD_TOO_SHORT: '密码至少 8 位',
  BANNED_USER: '账号已被停用',
  invite_not_found: '邀请码不存在',
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

/** 连接失败的原因，按传输层失败的类别给出；无法归类时不附原因，不显示运行时的英文原文。 */
const UNREACHABLE_REASON = {
  tls: '：TLS 握手失败，网络不稳定或代理证书未被信任',
  closed: '：连接被断开',
  timeout: '：请求超时',
  unreachable: '',
} as const

function unreachable(err: unknown): CloudAccountError {
  const kind = transportFailureKind(err)
  return new CloudAccountError(`无法连接账号服务${kind ? UNREACHABLE_REASON[kind] : ''}`)
}

export class CloudAccount {
  private wasRevoked = false
  private email: string | null = null
  /** 上一次从云端取得的用户名，云端暂时无法访问时沿用；退出或设备被移除时清除。 */
  private name = ''
  /**
   * 上一次从云端取得的公告已读位置及取得它所用的设备密钥，云端暂时无法访问时沿用。按密钥对应：退出、设备被移除或
   * 换账号登录后密钥不同，不沿用上一个账号的值。
   */
  private seen: { key: string; id: string | null } | null = null
  /** 上一次把云端型号清单写入配置的时刻；本进程尚未写入过为 0。 */
  private syncedAt = 0
  /**
   * 上一次取得的型号清单中的内置技能，与型号在同一次读取中更新。不写入配置：它是云端清单的副本，不是用户设置；
   * 进程启动后第一次使用云端型号时 `syncedAt` 为 0，`syncModels` 必然读取清单。
   */
  private builtin: readonly CloudSkill[] = []
  /** 推送通道（隧道）连上的时刻；未连接为 null。 */
  private pushSince: number | null = null
  /** 进行中的后台同步，同一时刻只有一个。 */
  private syncing: Promise<void> | null = null
  private readonly onChange: () => void
  private readonly onModelsRenamed: (renamed: ReadonlyMap<string, string>) => void
  private readonly timeoutMs: number
  private readonly resendDelaysMs: readonly number[]

  constructor(
    private readonly live: QyConfig,
    private readonly origin: string,
    options: CloudAccountOptions = {},
  ) {
    this.onChange = options.onChange ?? (() => {})
    this.onModelsRenamed = options.onModelsRenamed ?? (() => {})
    this.timeoutMs = options.timeoutMs ?? 20_000
    this.resendDelaysMs = options.resendDelaysMs ?? [300, 1000]
  }

  private timeout(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs)
  }

  /**
   * 发出读取请求（GET），连接失败时重发。
   * 网络不稳定时 TLS 握手失败（Bun 报 `unknown certificate verification error`），随后的重发通常成功；
   * 不重发时账号窗口的每项读取都以该错误结束，须由用户逐次重试。
   * 超时不重发：等待时间会按重发次数成倍增加。不要用于写入请求：连接失败时无法确定云端是否已收到。
   */
  private async read(path: string, headers: Record<string, string> = {}): Promise<Response> {
    for (const delay of this.resendDelaysMs) {
      try {
        return await fetch(`${this.origin}${path}`, { headers, signal: this.timeout() })
      } catch (err) {
        if ((err as { name?: string } | null)?.name === 'TimeoutError') throw err
        await Bun.sleep(delay)
      }
    }
    return fetch(`${this.origin}${path}`, { headers, signal: this.timeout() })
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
      this.remember(me, provider.apiKey)
      if (!this.fresh()) void this.refresh()
      return this.signedIn(me)
    }
    // 云端暂时无法访问：仍视为已登录，余额与头像未知；用户名与公告已读位置沿用本设备上一次取得的值，
    // 公告已读位置未取得过时缺省。
    return {
      state: 'signed_in',
      email: this.email ?? '',
      name: this.name,
      credits: null,
      avatar: null,
      provider: CLOUD_PROVIDER,
      origin: this.origin,
      recharge: false,
      ...(this.seen?.key === provider.apiKey ? { announcementSeen: this.seen.id } : {}),
      support: false,
      supportUnread: 0,
      square: false,
    }
  }

  /** 记录本次取得的账号资料，云端暂时无法访问时沿用。 */
  private remember(me: Me, key: string): void {
    this.email = me.email
    this.name = me.name
    this.seen = { key, id: me.announcementSeen }
  }

  private signedIn(me: Me): Extract<CloudState, { state: 'signed_in' }> {
    return {
      state: 'signed_in',
      email: me.email,
      name: me.name,
      credits: me.credits,
      avatar: me.avatar,
      provider: CLOUD_PROVIDER,
      origin: this.origin,
      recharge: me.recharge,
      announcementSeen: me.announcementSeen,
      support: me.support,
      supportUnread: me.supportUnread,
      square: me.square,
    }
  }

  /** 以邮箱密码登录。已登录时直接返回当前状态。 */
  login(email: string, password: string): Promise<CloudState> {
    return this.signIn('/v1/login', email, password)
  }

  /** 注册并登录。`inviteCode` 为邀请人的邀请码，可省略；云端在创建账号之前检查，不存在时注册失败。 */
  register(email: string, password: string, inviteCode?: string): Promise<CloudState> {
    return this.signIn('/v1/register', email, password, inviteCode)
  }

  /**
   * 账号窗口的全部内容：账号与余额、用量（按本机时区分日）、型号与单价、前 `limit` 条使用记录，
   * 经云端 `/v1/account` 一次取得。不要拆成多个并行请求：每个请求各自新建到云端的连接，经代理的 TLS 握手
   * 实测每次 4–15 秒。读取的同时把型号清单写入配置，账号窗口列出的型号与模型选择一致。
   */
  async overview(limit: number): Promise<CloudAccountOverview> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    const query = new URLSearchParams({ tz, limit: String(limit) })
    const reply = await this.call<{
      me: MeReply
      usage: CloudUsage
      catalog: Catalog
      requests: GatewayRequest[]
    }>(`/v1/account?${query}`)
    await this.applyModels(reply.catalog)
    const me = meOf(reply.me)
    const key = cloudProviderOf(this.live, this.origin)?.apiKey
    if (key) this.remember(me, key)
    return {
      state: this.signedIn(me),
      usage: reply.usage,
      models: cloudModels(reply.catalog),
      skills: reply.catalog.skills,
      requests: reply.requests.map(toRequest),
    }
  }

  /** 内置技能（上一次取得的型号清单）；未登录或尚未取得清单时为空。 */
  builtinSkills(): readonly CloudSkill[] {
    return this.builtin
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

  /**
   * 把已读位置写到云端账号（`PUT /v1/me/announcement-seen`），返回写入后的账号状态。写入成功即更新沿用的值：
   * 随后读取账号状态失败时，返回的仍是刚写入的位置。
   */
  async markAnnouncementSeen(id: string): Promise<CloudState> {
    const key = cloudProviderOf(this.live, this.origin)?.apiKey
    await this.call('/v1/me/announcement-seen', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    if (key) this.seen = { key, id }
    return this.state()
  }

  /** 读取云端不需要登录的接口。 */
  private async publicGet<T>(path: string): Promise<T> {
    let res: Response
    try {
      res = await this.read(path)
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

  /** 修改用户名，空字符串表示清除。长度与字符由云端校验，首尾空白由云端删除。 */
  async setName(name: string): Promise<CloudState> {
    await this.call('/v1/me/name', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name }),
    })
    return this.state()
  }

  /** 使用记录，按时间倒序；`before` 为上一页最后一条的 `startedAt`。第一页随 `overview` 返回。 */
  async requests(before: string | null, limit: number): Promise<CloudRequest[]> {
    const query = new URLSearchParams({ limit: String(limit) })
    if (before) query.set('before', before)
    const rows = await this.call<GatewayRequest[]>(`/v1/requests?${query}`)
    return rows.map(toRequest)
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

  /** 以兑换码兑换积分（`POST /v1/redeem`），返回得到的积分与兑换之后的账号状态。次数、期限与适用账号由云端判定。 */
  async redeem(code: string): Promise<CloudRedeemResult> {
    const { credits } = await this.call<{ credits: number }>('/v1/redeem', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    })
    return { credits, state: await this.state() }
  }

  /** 云端答复本设备已被移除（网关或隧道）：删除本地接口，账号界面显示原因。 */
  async revoked(): Promise<void> {
    this.email = null
    this.name = ''
    await this.remove()
    this.wasRevoked = true
  }

  /** 退出：先请求云端吊销本设备（失败时仍在本地退出），再删除本地接口。 */
  async logout(): Promise<void> {
    this.wasRevoked = false
    this.email = null
    this.name = ''
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
  private async signIn(
    path: string,
    email: string,
    password: string,
    inviteCode?: string,
  ): Promise<CloudState> {
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
        ...json({
          email,
          password,
          name: hostLabel(),
          platform: process.platform,
          ...(inviteCode ? { inviteCode } : {}),
        }),
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

  /**
   * 以设备密钥调用云端接口，返回成功的原始响应（附件等非 JSON 内容）。失败时抛出 `CloudAccountError`；
   * 云端答复设备已被移除时删除本地接口。`timeoutMs` 只用于写入请求，缺省为本对象的超时；上传大文件时由调用方加长。
   */
  async request(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<Response> {
    const provider = cloudProviderOf(this.live, this.origin)
    if (!provider?.apiKey) throw new CloudAccountError('未登录')
    let res: Response
    const authorization = `Bearer ${provider.apiKey}`
    try {
      res = init.method
        ? await fetch(`${this.origin}${path}`, {
            ...init,
            headers: { ...init.headers, authorization },
            signal: timeoutMs === undefined ? this.timeout() : AbortSignal.timeout(timeoutMs),
          })
        : await this.read(path, { authorization })
    } catch (err) {
      throw unreachable(err)
    }
    if (res.ok) return res
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

  /** 以设备密钥调用云端接口并解析 JSON；204 返回 undefined。失败的处理与 `timeoutMs` 同 `request`。 */
  async call<T>(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<T> {
    const res = await this.request(path, init, timeoutMs)
    if (res.status === 204) return undefined as T
    return (await res.json()) as T
  }

  /**
   * 登录完成：以设备密钥写入云端接口与型号。不设置默认对话模型：清单按显示名称排序，
   * 取第一个型号作默认值会使新用户的新会话使用一个用户从未选择的型号并按它计费。
   */
  private async complete(key: string): Promise<void> {
    const list = await this.catalog(key)
    const models = storedModels(list.models)
    const media = storedMedia(list.media ?? [])
    const result = await writeConfig(this.live, (current) => {
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
      }
    })
    if (result instanceof Response || 'problems' in result) {
      throw new Error(
        `写入配置失败：${'problems' in result ? result.problems.join('；') : result.status}`,
      )
    }
    this.syncedAt = Date.now()
    this.builtin = list.skills
    this.reportRenamed(list.models)
    this.onChange()
  }

  private reportRenamed(list: readonly CatalogModel[]): void {
    const renamed = renamedModels(list)
    if (renamed.size) this.onModelsRenamed(renamed)
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
   * 推送通道（隧道，登录后连接）连上或断开。连上时立即同步一次：断开期间云端的改动没有推送到本机。
   * 云端重新部署后隧道重连，内置模型库随部署更新的规格也由这次同步取得。
   */
  setPushChannel(online: boolean): void {
    if (!online) {
      this.pushSince = null
      return
    }
    if (this.pushSince !== null) return
    this.pushSince = Date.now()
    void this.refresh()
  }

  /** 云端推送型号清单已改变。不并入进行中的同步：那次同步可能读取到改动之前的清单。失败只记录日志，不拒绝。 */
  catalogChanged(): Promise<void> {
    return this.sync()
  }

  /**
   * 配置中的型号清单是否可视为最新：推送通道连上之后同步过且不超过 `PUSH_TRUST_MS`，
   * 或没有推送通道时距上次同步不超过 `STALE_MS`。
   */
  private fresh(): boolean {
    if (this.syncedAt === 0) return false
    const age = Date.now() - this.syncedAt
    if (this.pushSince !== null && this.syncedAt >= this.pushSince) return age < PUSH_TRUST_MS
    return age < STALE_MS
  }

  /** 在后台同步型号清单；进行中时不另发。 */
  private refresh(): Promise<void> {
    this.syncing ??= this.sync().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  /** 同步失败时记录原因，沿用已保存的型号与价格。 */
  private async sync(): Promise<void> {
    const key = cloudProviderOf(this.live, this.origin)?.apiKey
    if (!key) return
    try {
      await this.applyModels(await this.catalog(key))
    } catch (err) {
      log.warn('cloud', '同步云端型号清单失败，沿用已保存的型号', {
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /**
   * 一轮使用云端型号之前确认配置中的型号与倍率是最新的：后台可随时调整倍率，按旧倍率记账时与云端扣费不一致。
   * 已是最新（`fresh`）时不读取：经代理新建到云端的连接常需数秒，每轮都读取时一轮要先等待这段时间。
   * 读取超时 3 秒，失败时抛出，由调用方沿用已保存的价格。
   */
  async syncModels(): Promise<void> {
    const provider = cloudProviderOf(this.live, this.origin)
    if (!provider?.apiKey || this.fresh()) return
    await this.applyModels(await this.catalog(provider.apiKey, AbortSignal.timeout(3000)))
  }

  /** 写入清单中的型号与价格；与配置中已有的内容相同时不写入。 */
  private async applyModels(list: Catalog): Promise<void> {
    const listed = storedModels(list.models)
    const listedMedia = storedMedia(list.media ?? [])
    await writeConfig(this.live, (current) => {
      const provider = cloudProviderOf(current, this.origin)
      if (!provider) return current
      // 按清单的顺序写入，清单中已没有的型号排在其后：输入框的模型选择按配置中的顺序列出，
      // 按已有的顺序写入时新上架的型号排在最后，与账号窗口中按清单排列的型号表不一致。
      const models: Record<string, StoredModel> = {}
      for (const [id, hit] of Object.entries(listed)) {
        const kept = provider.models[id]
        if (!kept) {
          models[id] = hit
          continue
        }
        const { kind: _kind, price: _price, delisted: _delisted, ...rest } = kept
        models[id] = { ...rest, ...hit }
      }
      // 清单中已没有的型号标记已下架，引用它的设置显示已下架。没有显示名称的条目是云端型号使用对外编号之前按内部 id 写入的，
      // 删除：内部 id 可能透露上游供应商，且不会再出现在清单中。
      for (const [id, m] of Object.entries(provider.models))
        if (m.displayName) models[id] ??= { ...m, delisted: true }
      // 生成型号的规格与显示名称全部由清单决定；清单中已没有的型号标记已下架，规则同上。顺序与对话型号相同。
      const media: Record<string, StoredMediaModel> = { ...listedMedia }
      for (const [id, m] of Object.entries(provider.media ?? {}))
        if (m.displayName) media[id] ??= { ...m, delisted: true }
      const catalog = withSpecs(current.catalog, list.models)
      // 默认对话模型与默认生成模型指向已删除的条目时删除该默认值。不要改用清单中的其他型号：
      // 默认模型由用户选定，替换会静默改变新会话使用的模型与计费。默认对话模型是旧型号 id 时改为该型号的对外编号
      // （`renamedModels`）：两者是同一个型号。
      const gone = (ref: { provider: string; model: string } | undefined, kept: object) =>
        ref?.provider === CLOUD_PROVIDER && !(ref.model in kept)
      // 默认对话模型指向已下架的型号时同样删除：新会话的请求必然被拒绝，模型选择不列出已下架的型号，界面上无处显示该默认值。
      // 默认生成模型不在此列：画布在默认型号已下架时显示并固定另一个可用的型号。
      const retired =
        current.active?.provider === CLOUD_PROVIDER && models[current.active.model]?.delisted
      const renamed = gone(current.active, models)
        ? renamedModels(list.models).get(current.active?.model ?? '')
        : undefined
      const active = renamed
        ? { provider: CLOUD_PROVIDER, model: renamed }
        : gone(current.active, models) || retired
          ? undefined
          : current.active
      const mediaDefaults = current.mediaDefaults
        ? Object.fromEntries(
            Object.entries(current.mediaDefaults).filter(([, ref]) => !gone(ref, media)),
          )
        : undefined
      if (
        JSON.stringify(models) === JSON.stringify(provider.models) &&
        JSON.stringify(media) === JSON.stringify(provider.media ?? {}) &&
        JSON.stringify(catalog) === JSON.stringify(current.catalog) &&
        active === current.active &&
        JSON.stringify(mediaDefaults) === JSON.stringify(current.mediaDefaults)
      ) {
        return current
      }
      const { catalog: _catalog, active: _active, mediaDefaults: _mediaDefaults, ...rest } = current
      const { media: _media, ...base } = provider
      return {
        ...rest,
        ...(catalog ? { catalog } : {}),
        ...(active ? { active } : {}),
        ...(mediaDefaults && Object.keys(mediaDefaults).length ? { mediaDefaults } : {}),
        providers: {
          ...current.providers,
          [CLOUD_PROVIDER]: { ...base, models, ...(Object.keys(media).length ? { media } : {}) },
        },
      }
    })
    this.syncedAt = Date.now()
    this.builtin = list.skills
    this.reportRenamed(list.models)
  }

  private async me(key: string): Promise<Me | 'revoked' | null> {
    try {
      const res = await this.read('/v1/me', { authorization: `Bearer ${key}` })
      if (res.ok) return meOf((await res.json()) as MeReply)
      const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null
      return res.status === 401 && body?.error?.code === 'device_revoked' ? 'revoked' : null
    } catch {
      return null
    }
  }

  /**
   * 删除本地的云端接口；`active` 与 `mediaDefaults` 指向它时一并删除，规则与设置页删除接口相同。
   * 模型库覆盖层中由云端同步写入的字段按空清单清除（`withSpecs`），否则退出后模型库仍列出云端型号。
   */
  private async remove(): Promise<void> {
    this.builtin = []
    const result = await writeConfig(this.live, (current) => {
      if (!(CLOUD_PROVIDER in current.providers)) return current
      const { catalog: _catalog, ...rest } = current
      const { [CLOUD_PROVIDER]: _removed, ...providers } = current.providers
      const catalog = withSpecs(current.catalog, [])
      const next: QyConfig = { ...rest, providers, ...(catalog ? { catalog } : {}) }
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
