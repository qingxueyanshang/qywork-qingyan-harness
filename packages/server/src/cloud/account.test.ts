/**
 * 覆盖范围：`cloud/account.ts` 与 `api/cloud.ts` 的错误返回。云端是本文件中的模拟服务，接口与云端仓库的账号、设备与网关接口相同；
 * 配置经 `writeConfig` 写入测试进程的 `QYWORK_HOME`。
 */

import { afterAll, beforeEach, expect, test } from 'bun:test'
import { loadConfig, type QyConfig } from '@qywork/runtime'
import { handleCloudApi } from '../api/cloud.ts'
import type { ApiRequestDeps } from '../api/types.ts'
import { CLOUD_PROVIDER, CloudAccount, CloudAccountError } from './account.ts'

const PASSWORD = 'password-123'

const cloud = {
  me: 'ok' as 'ok' | 'revoked' | 'invalid',
  revoked: 0,
  /** 云端收到的登录与注册请求。 */
  logins: [] as { email: string; password: string; name: string; platform: string }[],
  /** 云端收到的最后一次 `/v1/usage` 查询串与 `/v1/requests` 查询串。 */
  usageQuery: '',
  requestsQuery: '',
  /** 价格清单中是否包含后上架的型号。 */
  extraModel: false,
  avatar: null as string | null,
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
    if (path === '/v1/device/revoke') {
      cloud.revoked++
      return new Response(null, { status: 204 })
    }
    if (path.startsWith('/v1/') && cloud.me !== 'ok') {
      const code = cloud.me === 'revoked' ? 'device_revoked' : 'invalid_key'
      return Response.json({ error: { code, message: code } }, { status: 401 })
    }
    if (path === '/v1/me') {
      return Response.json({ email: 'me@example.com', credits: 12.5, avatar: cloud.avatar })
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
      ])
    }
    if (path === '/api/pricing') {
      const entry = (model_name: string, type: string) => ({
        model_name,
        quota_type: 0,
        model_ratio: 150,
        completion_ratio: 5,
        enable_groups: ['default'],
        supported_endpoint_types: [type],
      })
      return Response.json({
        data: [
          entry('claude-sonnet-5-5', 'anthropic'),
          entry('gpt-5', 'openai-response'),
          ...(cloud.extraModel ? [entry('claude-opus-5-5', 'anthropic')] : []),
        ],
        group_ratio: { default: 1 },
      })
    }
    if (path === '/api/status') return Response.json({ data: {} })
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
    avatar: null,
  })
  live = await loadConfig()
  delete live.providers[CLOUD_PROVIDER]
  delete live.active
  account = new CloudAccount(live, { site: 'http://site.invalid', api: origin })
})

test('登录后写入云端接口：设备密钥只在该接口中，型号带各自的协议，未选模型时设为当前模型', async () => {
  const state = await account.login('me@example.com', PASSWORD)
  expect(state).toEqual({
    state: 'signed_in',
    email: 'me@example.com',
    credits: 12.5,
    avatar: null,
    provider: CLOUD_PROVIDER,
  })
  const provider = live.providers[CLOUD_PROVIDER]!
  expect(provider).toMatchObject({ baseUrl: origin, apiKey: 'qyd_device_key' })
  expect(provider.models['claude-sonnet-5-5']?.kind).toBeUndefined()
  expect(provider.models['gpt-5']?.kind).toBe('openai_responses')
  // 网关清单的额度单位是积分：价格记为积分，与账号余额同一单位。
  expect(provider.models['gpt-5']?.price).toMatchObject({
    input: 300,
    output: 1500,
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

test('注册：邮箱已注册时给出原因；新邮箱注册后直接登录', async () => {
  await expect(account.register('taken@example.com', PASSWORD)).rejects.toThrow('该邮箱已注册')
  expect((await account.register('new@example.com', PASSWORD)).state).toBe('signed_in')
  expect(live.providers[CLOUD_PROVIDER]?.apiKey).toBe('qyd_device_key')
})

test('账号服务无法连接时给出原因', async () => {
  const offline = new CloudAccount(live, { site: 'http://site.invalid', api: 'http://127.0.0.1:9' })
  await expect(offline.login('me@example.com', PASSWORD)).rejects.toThrow('无法连接账号服务')
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

test('可用模型实时读取云端价格清单，单价为积分 / 百万 token；新上架的型号同时写入配置', async () => {
  await account.login('me@example.com', PASSWORD)
  cloud.extraModel = true
  const models = await account.models()
  expect(models.map((m) => m.id)).toEqual(['claude-sonnet-5-5', 'gpt-5', 'claude-opus-5-5'])
  expect(models[1]?.price).toMatchObject({ input: 300, output: 1500 })
  expect(Object.keys(live.providers[CLOUD_PROVIDER]?.models ?? {})).toContain('claude-opus-5-5')
  expect(Object.keys((await loadConfig()).providers[CLOUD_PROVIDER]?.models ?? {})).toContain(
    'claude-opus-5-5',
  )
})

test('更换头像：以设备密钥写入云端，状态中带头像；格式不对时给出云端的原因', async () => {
  await account.login('me@example.com', PASSWORD)
  const image = 'data:image/webp;base64,UklGRg=='
  expect(await account.setAvatar(image)).toMatchObject({ state: 'signed_in', avatar: image })
  await expect(account.setAvatar('data:text/html;base64,PGI+')).rejects.toThrow(
    '头像须为 PNG、JPEG 或 WebP 图片',
  )
})
