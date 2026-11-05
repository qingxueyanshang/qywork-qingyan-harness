/**
 * 覆盖范围：`cloud/account.ts`、`cloud/origin.ts`，`api/cloud.ts` 的错误返回、充值、本版说明与公告列表。云端是本文件中的模拟服务，接口与云端仓库的账号、设备与网关接口相同；
 * 配置经 `writeConfig` 写入测试进程的 `QYWORK_HOME`。
 */

import { afterAll, beforeEach, expect, test } from 'bun:test'
import { stat } from 'node:fs/promises'
import type { Announcement } from '@qywork/core'
import { configPath, loadConfig, type QyConfig } from '@qywork/runtime'
import { handleCloudApi } from '../api/cloud.ts'
import { writeConfig } from '../api/config.ts'
import type { ApiRequestDeps } from '../api/types.ts'
import { CLOUD_PROVIDER, CloudAccount, CloudAccountError } from './account.ts'
import { cloudOrigin } from './origin.ts'

const PASSWORD = 'password-123'

/** 云端公开的公告列表，新者在前。 */
const ANNOUNCEMENTS: Announcement[] = [
  {
    id: '2',
    kind: 'notice',
    version: null,
    title: '服务维护',
    body: '今晚 23:00 维护。',
    publishedAt: '2026-11-05T08:00:00.000Z',
  },
  {
    id: '1',
    kind: 'release',
    version: '0.3.11',
    title: 'qywork 0.3.11 更新',
    body: '- 安装包改从官网下载',
    publishedAt: '2026-11-04T11:22:21.544Z',
  },
]

const cloud = {
  me: 'ok' as 'ok' | 'revoked' | 'invalid',
  revoked: 0,
  /** 云端收到的登录与注册请求。 */
  logins: [] as { email: string; password: string; name: string; platform: string }[],
  /** 云端收到的最后一次 `/v1/usage` 查询串与 `/v1/requests` 查询串。 */
  usageQuery: '',
  requestsQuery: '',
  /** 型号清单中是否包含后上架的型号。 */
  extraModel: false,
  /** 型号清单中模型库没有的型号是否带规格，以及规格中的对应型号。 */
  nextSpec: true,
  nextBase: 'claude-sonnet-5-5',
  /** 后上架的型号（模型库已收录）是否带规格。 */
  opusSpec: false,
  avatar: null as string | null,
  /** 云端收到的版本公告查询次数。 */
  notesQueries: 0,
  /** claude-sonnet-5-5 的售价倍率，后台可随时调整。 */
  sonnetRatio: 0.5,
  /** 云端收到的型号清单请求次数。 */
  catalogReads: 0,
}

const server: ReturnType<typeof Bun.serve> = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req): Promise<Response> {
    const url = new URL(req.url)
    const path = url.pathname
    const authed = req.headers.get('authorization') === 'Bearer qyd_device_key'
    if (path === '/v1/login' || path === '/v1/register') {
      const body = (await req.json()) as {
        email: string
        password: string
        name: string
        platform: string
      }
      cloud.logins.push(body)
      if (path === '/v1/login' && body.password !== PASSWORD) {
        return Response.json(
          { error: { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' } },
          { status: 401 },
        )
      }
      if (path === '/v1/register' && body.email === 'taken@example.com') {
        return Response.json(
          {
            error: {
              code: 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
              message: 'User already exists.',
            },
          },
          { status: 422 },
        )
      }
      return Response.json({ key: 'qyd_device_key' })
    }
    if (path === '/api/announcements') {
      cloud.notesQueries++
      const version = url.searchParams.get('version')
      if (version === null) return Response.json(ANNOUNCEMENTS)
      if (version === '9.9.9') return Response.json({ error: 'boom' }, { status: 500 })
      return Response.json(
        version === '0.3.11'
          ? {
              id: '1',
              kind: 'release',
              version,
              title: 'qywork 0.3.11 更新',
              body: '- 安装包改从官网下载',
              publishedAt: '2026-11-04T11:22:21.544Z',
            }
          : null,
      )
    }
    if (path === '/v1/device/revoke') {
      cloud.revoked++
      return new Response(null, { status: 204 })
    }
    if (path.startsWith('/v1/') && cloud.me !== 'ok') {
      const code = cloud.me === 'revoked' ? 'device_revoked' : 'invalid_key'
      return Response.json({ error: { code, message: code } }, { status: 401 })
    }
    if (path === '/v1/me') {
      return Response.json({
        email: 'me@example.com',
        credits: 12.5,
        avatar: cloud.avatar,
        recharge: true,
      })
    }
    if (path === '/v1/recharge' && req.method === 'POST' && authed) {
      const { amount } = (await req.json()) as { amount: number }
      if (!Number.isInteger(amount) || amount < 1) {
        return Response.json(
          { error: { code: 'invalid_request', message: '充值金额须为 1–10000 的整数（元）' } },
          { status: 400 },
        )
      }
      return Response.json({
        orderNo: 'QY20261104120000abcdef0123456789',
        codeUrl: 'weixin://wxpay/bizpayurl?pr=TEST',
        amount,
        expiresAt: '2026-11-04T04:05:00.000Z',
      })
    }
    if (path === '/v1/recharge/QY20261104120000abcdef0123456789' && authed) {
      return Response.json({ status: 'paid' })
    }
    if (path === '/v1/me/avatar' && req.method === 'PUT' && authed) {
      const { image } = (await req.json()) as { image: string }
      if (!image.startsWith('data:image/')) {
        return Response.json(
          { error: { code: 'invalid_request', message: '头像须为 PNG、JPEG 或 WebP 图片' } },
          { status: 400 },
        )
      }
      cloud.avatar = image
      return new Response(null, { status: 204 })
    }
    if (path === '/v1/usage' && authed) {
      cloud.usageQuery = url.search
      return Response.json({ requests: 3, credits: 1.5, days: [] })
    }
    if (path === '/v1/requests' && authed) {
      cloud.requestsQuery = url.search
      return Response.json([
        { id: 'r1', credits: 0.5, status: 200, errorCode: null },
        { id: 'r2', credits: 0, status: 429, errorCode: 'upstream_429' },
        { id: 'r3', credits: 0.1, status: 200, errorCode: 'stream_interrupted' },
        { id: 'r4', credits: 0, status: 0, errorCode: 'service_interrupted' },
      ])
    }
    if (path === '/v1/catalog' && authed) {
      cloud.catalogReads++
      const price = { input: 300, output: 1500, cacheRead: 30, cacheWrite: 375 }
      const flat = { ratio: 1, official: false, price }
      return Response.json({
        models: [
          {
            id: 'claude-sonnet-5-5',
            protocol: 'anthropic_messages',
            ratio: cloud.sonnetRatio,
            official: true,
            price,
          },
          { id: 'gpt-5', protocol: 'openai_responses', ...flat },
          {
            id: 'claude-next',
            protocol: 'anthropic_messages',
            ...flat,
            ...(cloud.nextSpec
              ? {
                  spec: {
                    displayName: 'Claude Next',
                    base: cloud.nextBase,
                    contextWindow: 2_000_000,
                    maxOutputTokens: 128_000,
                  },
                }
              : {}),
          },
          ...(cloud.extraModel
            ? [
                {
                  id: 'claude-opus-5-5',
                  protocol: 'anthropic_messages',
                  price,
                  ...(cloud.opusSpec
                    ? { spec: { displayName: 'Opus', base: 'claude-sonnet-5-5' } }
                    : {}),
                },
              ]
            : []),
        ],
      })
    }
    return new Response('not found', { status: 404 })
  },
})
const origin: string = `http://127.0.0.1:${server.port}`

afterAll(() => {
  server.stop(true)
})

let live: QyConfig
let account: CloudAccount

beforeEach(async () => {
  Object.assign(cloud, {
    me: 'ok',
    revoked: 0,
    logins: [],
    usageQuery: '',
    requestsQuery: '',
    extraModel: false,
    nextSpec: true,
    nextBase: 'claude-sonnet-5-5',
    opusSpec: false,
    avatar: null,
    notesQueries: 0,
    sonnetRatio: 0.5,
    catalogReads: 0,
  })
  live = await loadConfig()
  delete live.catalog
  delete live.providers[CLOUD_PROVIDER]
  delete live.active
  account = new CloudAccount(live, origin)
})

test('登录后写入云端接口：设备密钥只在该接口中，型号带各自的协议，未选模型时设为当前模型', async () => {
  const state = await account.login('me@example.com', PASSWORD)
  expect(state).toEqual({
    state: 'signed_in',
    email: 'me@example.com',
    credits: 12.5,
    avatar: null,
    provider: CLOUD_PROVIDER,
    origin,
    recharge: true,
  })
  const provider = live.providers[CLOUD_PROVIDER]!
  expect(provider).toMatchObject({ baseUrl: origin, apiKey: 'qyd_device_key' })
  expect(provider.models['claude-sonnet-5-5']?.kind).toBeUndefined()
  expect(provider.models['gpt-5']?.kind).toBe('openai_responses')
  // 网关清单的单价单位是积分：价格记为积分，与账号余额同一单位。
  expect(provider.models['gpt-5']?.price).toEqual({
    input: 300,
    output: 1500,
    cacheRead: 30,
    cacheWrite: 375,
    currency: 'CREDIT',
  })
  expect(live.active?.provider).toBe(CLOUD_PROVIDER)
  // 一次请求完成登录与登记本设备，只发往接口主机，带本机名称与平台。
  expect(cloud.logins).toEqual([
    {
      email: 'me@example.com',
      password: PASSWORD,
      name: expect.any(String),
      platform: process.platform,
    },
  ])
  // 写入的是磁盘上的配置，而不只是内存中的对象。
  expect((await loadConfig()).providers[CLOUD_PROVIDER]?.apiKey).toBe('qyd_device_key')
})

test('密码错误时给出原因，不写入接口，状态仍为未登录', async () => {
  const failed = account.login('me@example.com', 'wrong-password')
  await expect(failed).rejects.toThrow(new CloudAccountError('邮箱或密码错误'))
  expect(live.providers[CLOUD_PROVIDER]).toBeUndefined()
  expect(await account.state()).toEqual({ state: 'signed_out' })
})

test('已有名为 qywork 但地址不同的接口时：不请求云端（不登记设备），不覆盖该接口，提示中写明其地址', async () => {
  live.providers[CLOUD_PROVIDER] = {
    kind: 'anthropic_messages',
    baseUrl: 'http://localhost:8080',
    apiKey: 'old-key',
    models: {},
  }
  await expect(account.login('me@example.com', PASSWORD)).rejects.toThrow(
    new CloudAccountError(
      '已有名为「qywork」的接口（http://localhost:8080），请先在模型设置中改名或删除',
    ),
  )
  expect(cloud.logins).toEqual([])
  expect(live.providers[CLOUD_PROVIDER]).toMatchObject({
    baseUrl: 'http://localhost:8080',
    apiKey: 'old-key',
  })
  expect(await account.state()).toEqual({ state: 'signed_out' })
})

test('注册：邮箱已注册时给出原因；新邮箱注册后直接登录', async () => {
  await expect(account.register('taken@example.com', PASSWORD)).rejects.toThrow('该邮箱已注册')
  expect((await account.register('new@example.com', PASSWORD)).state).toBe('signed_in')
  expect(live.providers[CLOUD_PROVIDER]?.apiKey).toBe('qyd_device_key')
})

test('账号服务无法连接时给出原因', async () => {
  const offline = new CloudAccount(live, 'http://127.0.0.1:9')
  await expect(offline.login('me@example.com', PASSWORD)).rejects.toThrow('无法连接账号服务')
})

test('账号服务接受连接但不响应时，读取在超时后失败并给出原因；状态仍为已登录、余额未知', async () => {
  const stalled = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Promise<Response>(() => {}),
  })
  try {
    const origin = `http://127.0.0.1:${stalled.port}`
    live.providers[CLOUD_PROVIDER] = {
      kind: 'anthropic_messages',
      baseUrl: origin,
      apiKey: 'qyd_device_key',
      models: {},
    }
    const slow = new CloudAccount(live, origin, { timeoutMs: 50 })
    await expect(slow.models()).rejects.toThrow('无法连接账号服务')
    await expect(slow.usage()).rejects.toThrow('无法连接账号服务')
    expect(await slow.state()).toMatchObject({ state: 'signed_in', credits: null })
  } finally {
    stalled.stop(true)
  }
})

test('网关返回 device_revoked 时删除本地接口并清除当前模型；其他 401 不删除', async () => {
  await account.login('me@example.com', PASSWORD)
  cloud.me = 'invalid'
  expect((await account.state()).state).toBe('signed_in')
  expect(live.providers[CLOUD_PROVIDER]).toBeDefined()
  cloud.me = 'revoked'
  expect(await account.state()).toEqual({ state: 'signed_out', reason: 'revoked' })
  expect(live.providers[CLOUD_PROVIDER]).toBeUndefined()
  expect(live.active?.provider).not.toBe(CLOUD_PROVIDER)
})

test('退出时请求云端吊销本设备并删除本地接口', async () => {
  await account.login('me@example.com', PASSWORD)
  await account.logout()
  expect(cloud.revoked).toBe(1)
  expect(live.providers[CLOUD_PROVIDER]).toBeUndefined()
  expect((await loadConfig()).providers[CLOUD_PROVIDER]).toBeUndefined()
  expect((await account.state()).state).toBe('signed_out')
})

test('用量与使用记录以设备密钥读取：用量带本机时区，记录带页长与续页位置，失败转为文字', async () => {
  await account.login('me@example.com', PASSWORD)
  expect(await account.usage()).toMatchObject({ requests: 3, credits: 1.5 })
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  expect(new URLSearchParams(cloud.usageQuery).get('tz')).toBe(tz)
  expect(await account.requests('2026-11-01T00:00:00.000Z', 50)).toEqual([
    { id: 'r1', credits: 0.5, failure: null },
    { id: 'r2', credits: 0, failure: '429 请求过多' },
    { id: 'r3', credits: 0.1, failure: '连接中断' },
    { id: 'r4', credits: 0, failure: '服务中断，积分已退回' },
  ] as never)
  expect(Object.fromEntries(new URLSearchParams(cloud.requestsQuery))).toEqual({
    limit: '50',
    before: '2026-11-01T00:00:00.000Z',
  })
})

test('读取用量时设备已被移除：删除本地接口，接口以 400 返回原因', async () => {
  await account.login('me@example.com', PASSWORD)
  cloud.me = 'revoked'
  const deps = { cloud: account } as unknown as ApiRequestDeps
  const res = await handleCloudApi(
    new URL('http://x/api/cloud/usage'),
    new Request('http://x/api/cloud/usage'),
    deps,
  )
  expect(res?.status).toBe(400)
  expect(await res?.json()).toEqual({ error: 'cloud', message: '设备已被移除' })
  expect(live.providers[CLOUD_PROVIDER]).toBeUndefined()
  expect(await account.state()).toEqual({ state: 'signed_out', reason: 'revoked' })
})

test('本版说明：未登录也可读取；没有该版本的公告时为 null；版本号无效时不请求云端；云端出错时给出原因', async () => {
  expect(await account.releaseNotes('0.3.11')).toEqual({
    version: '0.3.11',
    title: 'qywork 0.3.11 更新',
    body: '- 安装包改从官网下载',
    publishedAt: '2026-11-04T11:22:21.544Z',
  })
  expect(await account.releaseNotes('0.3.12')).toBeNull()
  expect(cloud.notesQueries).toBe(2)
  await expect(account.releaseNotes('0.3.12&x=1')).rejects.toThrow('版本号无效')
  expect(cloud.notesQueries).toBe(2)
  await expect(account.releaseNotes('9.9.9')).rejects.toThrow('账号服务返回 500')
  await expect(new CloudAccount(live, 'http://127.0.0.1:9').releaseNotes('0.3.11')).rejects.toThrow(
    '无法连接账号服务',
  )
})

test('本版说明接口：未配置云端时为 null；版本号无效时以 400 返回原因', async () => {
  const get = (cloud: CloudAccount | null, version: string) =>
    handleCloudApi(
      new URL(`http://x/api/cloud/release-notes?version=${encodeURIComponent(version)}`),
      new Request('http://x/api/cloud/release-notes'),
      { cloud } as unknown as ApiRequestDeps,
    )
  const none = await get(null, '0.3.11')
  expect(none?.status).toBe(200)
  expect(await none?.json()).toBeNull()
  expect(await (await get(account, '0.3.11'))?.json()).toMatchObject({ version: '0.3.11' })
  const bad = await get(account, 'latest')
  expect(bad?.status).toBe(400)
  expect(await bad?.json()).toEqual({ error: 'cloud', message: '版本号无效：latest' })
})

test('公告列表：未登录也可读取，原样返回云端的顺序；未配置云端时接口返回空数组', async () => {
  expect(await account.announcements()).toEqual(ANNOUNCEMENTS)
  const get = (cloud: CloudAccount | null) =>
    handleCloudApi(
      new URL('http://x/api/cloud/announcements'),
      new Request('http://x/api/cloud/announcements'),
      { cloud } as unknown as ApiRequestDeps,
    )
  expect(await (await get(account))?.json()).toEqual(ANNOUNCEMENTS)
  const none = await get(null)
  expect(none?.status).toBe(200)
  expect(await none?.json()).toEqual([])
})

test('可用模型实时读取云端型号清单，单价为积分 / 百万 token；新上架的型号同时写入配置', async () => {
  await account.login('me@example.com', PASSWORD)
  cloud.extraModel = true
  const models = await account.models()
  expect(models.map((m) => m.id)).toEqual([
    'claude-sonnet-5-5',
    'gpt-5',
    'claude-next',
    'claude-opus-5-5',
  ])
  expect(models[1]?.price).toMatchObject({ input: 300, output: 1500 })
  expect(models[0]?.ratio).toBe(0.5)
  expect(models.map((m) => m.official)).toEqual([true, false, false, false])
  // 云端按官方价计价且本机模型库有单价的型号只写倍率；其余写单价。
  const stored = live.providers[CLOUD_PROVIDER]?.models ?? {}
  expect(stored['claude-sonnet-5-5']?.price).toEqual({ scale: 0.5, currency: 'CREDIT' })
  expect(stored['gpt-5']?.price).toEqual({
    input: 300,
    output: 1500,
    cacheRead: 30,
    cacheWrite: 375,
    currency: 'CREDIT',
  })
  expect(Object.keys(stored)).toContain('claude-opus-5-5')
  expect(Object.keys((await loadConfig()).providers[CLOUD_PROVIDER]?.models ?? {})).toContain(
    'claude-opus-5-5',
  )
})

/** 原始失败形状：后台把倍率从 0.5 改为 0.35 后，电脑端仍按 0.5 记账，直到打开账号窗口。 */
test('同步型号清单：后台调价后配置中的倍率随之更新；清单未变时不重写配置文件；未登录时不请求云端', async () => {
  await account.syncModels()
  expect(cloud.catalogReads).toBe(0)
  await account.login('me@example.com', PASSWORD)
  const price = () => live.providers[CLOUD_PROVIDER]?.models['claude-sonnet-5-5']?.price
  expect(price()).toEqual({ scale: 0.5, currency: 'CREDIT' })
  cloud.sonnetRatio = 0.35
  await account.syncModels()
  expect(price()).toEqual({ scale: 0.35, currency: 'CREDIT' })
  expect(
    (await loadConfig()).providers[CLOUD_PROVIDER]?.models['claude-sonnet-5-5']?.price,
  ).toEqual({ scale: 0.35, currency: 'CREDIT' })
  const before = (await stat(configPath())).mtimeMs
  await Bun.sleep(20)
  await account.syncModels()
  expect((await stat(configPath())).mtimeMs).toBe(before)
})

/** 以配置接口写入一条模型库覆盖，与用户在模型库中修改的写入路径相同。 */
async function setCatalog(key: string, entry: Record<string, unknown>): Promise<void> {
  await writeConfig(live, (c) => ({ ...c, catalog: { ...c.catalog, [key]: entry } }))
}

test('模型库没有的型号：云端规格带来源标记写入覆盖层；云端修改规格后四项整体替换，清空后删除，其余字段保留', async () => {
  await account.login('me@example.com', PASSWORD)
  const key = 'claude-next|anthropic_messages'
  expect(live.catalog?.[key]).toEqual({
    displayName: 'Claude Next',
    base: 'claude-sonnet-5-5',
    contextWindow: 2_000_000,
    maxOutputTokens: 128_000,
    cloud: true,
  })
  // 模型库已有的型号不写入覆盖层。
  expect(live.catalog?.['claude-sonnet-5-5|anthropic_messages']).toBeUndefined()
  expect((await loadConfig()).catalog?.[key]?.contextWindow).toBe(2_000_000)

  await setCatalog(key, { ...live.catalog?.[key], thinksByDefault: true })
  // 对应型号不在本机模型库中：不写该项，也不保留此前写入的对应型号。
  cloud.nextBase = 'model-unknown-here'
  await account.models()
  expect(live.catalog?.[key]).toEqual({
    displayName: 'Claude Next',
    contextWindow: 2_000_000,
    maxOutputTokens: 128_000,
    thinksByDefault: true,
    cloud: true,
  })
  cloud.nextSpec = false
  await account.models()
  expect(live.catalog?.[key]).toEqual({ thinksByDefault: true })
})

test('本机模型库已收录的型号：带来源标记的条目删除云端写入的四项，不论是否仍在清单中；不带标记的条目不变', async () => {
  await account.login('me@example.com', PASSWORD)
  const opus = 'claude-opus-5-5|anthropic_messages'
  const haiku = 'claude-haiku-5-5|anthropic_messages'
  const sonnet = 'claude-sonnet-5-5|anthropic_messages'
  await setCatalog(opus, {
    displayName: 'Opus',
    base: 'claude-sonnet-5-5',
    contextWindow: 1,
    thinksByDefault: true,
    cloud: true,
  })
  await setCatalog(haiku, { contextWindow: 5, cloud: true })
  await setCatalog(sonnet, { base: 'claude-haiku-5-5' })
  cloud.extraModel = true
  cloud.opusSpec = true
  await account.models()
  expect(live.catalog?.[opus]).toEqual({ thinksByDefault: true })
  expect(live.catalog?.[haiku]).toBeUndefined()
  expect(live.catalog?.[sonnet]).toEqual({ base: 'claude-haiku-5-5' })
  expect((await loadConfig()).catalog?.[haiku]).toBeUndefined()
})

test('更换头像：以设备密钥写入云端，状态中带头像；格式不对时给出云端的原因', async () => {
  await account.login('me@example.com', PASSWORD)
  const image = 'data:image/webp;base64,UklGRg=='
  expect(await account.setAvatar(image)).toMatchObject({ state: 'signed_in', avatar: image })
  await expect(account.setAvatar('data:text/html;base64,PGI+')).rejects.toThrow(
    '头像须为 PNG、JPEG 或 WebP 图片',
  )
})

test('充值：经本机接口下单与读取状态；缺少金额时不请求云端，云端拒绝的金额以 400 返回原因', async () => {
  await account.login('me@example.com', PASSWORD)
  const deps = { cloud: account } as unknown as ApiRequestDeps
  const call = (path: string, init?: RequestInit) =>
    handleCloudApi(new URL(`http://x${path}`), new Request(`http://x${path}`, init), deps)
  const post = (body: unknown) => ({ method: 'POST', body: JSON.stringify(body) })

  const created = await call('/api/cloud/recharge', post({ amount: 50 }))
  expect(await created?.json()).toEqual({
    orderNo: 'QY20261104120000abcdef0123456789',
    codeUrl: 'weixin://wxpay/bizpayurl?pr=TEST',
    amount: 50,
    expiresAt: '2026-11-04T04:05:00.000Z',
  })
  const status = await call('/api/cloud/recharge/QY20261104120000abcdef0123456789')
  expect(await status?.json()).toEqual({ status: 'paid' })

  const missing = await call('/api/cloud/recharge', post({}))
  expect(missing?.status).toBe(400)
  expect(await missing?.json()).toEqual({ error: 'invalid_request', message: '缺少充值金额' })
  const refused = await call('/api/cloud/recharge', post({ amount: 0 }))
  expect(refused?.status).toBe(400)
  expect(await refused?.json()).toEqual({
    error: 'cloud',
    message: '账号服务返回 400：充值金额须为 1–10000 的整数（元）',
  })
})

test('云端地址：去掉首尾空白与末尾斜杠；带路径或多个地址时报错', () => {
  expect(cloudOrigin({ QYWORK_CLOUD: ' http://localhost:8080/ ' })).toBe('http://localhost:8080')
  for (const raw of ['http://localhost:8080/v1', 'http://localhost:8080,http://127.0.0.1:8080']) {
    expect(() => cloudOrigin({ QYWORK_CLOUD: raw })).toThrow('QYWORK_CLOUD 须为云端服务的地址')
  }
})
