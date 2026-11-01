/**
 * 覆盖范围：`cloud/account.ts`。云端是本文件中的模拟服务，接口与云端仓库的账号、设备与网关接口相同；
 * 配置经 `writeConfig` 写入测试进程的 `QYWORK_HOME`。
 */

import { afterAll, beforeEach, expect, test } from 'bun:test'
import { loadConfig, type QyConfig } from '@qywork/runtime'
import { CLOUD_PROVIDER, CloudAccount, type CloudState } from './account.ts'

type TokenReply = 'pending' | 'denied' | 'expired' | 'ok'

const cloud = {
  token: 'pending' as TokenReply,
  me: 'ok' as 'ok' | 'revoked' | 'invalid',
  codes: 0,
  revoked: 0,
  signedOut: 0,
}

const server: ReturnType<typeof Bun.serve> = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === '/api/auth/device/code') {
      cloud.codes++
      return Response.json({
        device_code: 'dc',
        user_code: 'ABCD1234',
        verification_uri: `${origin}/device`,
        verification_uri_complete: `${origin}/device?user_code=ABCD1234`,
        expires_in: 600,
        interval: 5,
      })
    }
    if (path === '/api/auth/device/token') {
      if (cloud.token === 'ok') return Response.json({ access_token: 'session-token' })
      const error = {
        pending: 'authorization_pending',
        denied: 'access_denied',
        expired: 'expired_token',
      }[cloud.token]
      return Response.json({ error, error_description: error }, { status: 400 })
    }
    if (path === '/api/devices') return Response.json({ id: 'dv_1', key: 'qyd_device_key' })
    if (path === '/api/auth/sign-out') {
      cloud.signedOut++
      return Response.json({ success: true })
    }
    if (path === '/v1/device/revoke') {
      cloud.revoked++
      return new Response(null, { status: 204 })
    }
    if (path === '/v1/me') {
      if (cloud.me === 'ok') return Response.json({ email: 'me@example.com', credits: 12.5 })
      const code = cloud.me === 'revoked' ? 'device_revoked' : 'invalid_key'
      return Response.json({ error: { code } }, { status: 401 })
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
        data: [entry('claude-sonnet-5-5', 'anthropic'), entry('gpt-5', 'openai-response')],
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
  Object.assign(cloud, { token: 'pending', me: 'ok', codes: 0, revoked: 0, signedOut: 0 })
  live = await loadConfig()
  delete live.providers[CLOUD_PROVIDER]
  account = new CloudAccount(live, { app: origin, api: origin }, { intervalMs: () => 10 })
})

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return
    await Bun.sleep(10)
  }
  throw new Error('等待超时')
}

const stateIs = (s: CloudState['state']) => async () => (await account.state()).state === s

test('登录进行中时重复点击返回同一个用户码，只申请一次', async () => {
  const first = await account.login()
  const second = await account.login()
  expect(first).toMatchObject({ state: 'pending', userCode: 'ABCD1234' })
  expect(second).toMatchObject({ state: 'pending', userCode: 'ABCD1234' })
  expect((first as { verificationUri: string }).verificationUri).toBe(
    `${origin}/device?user_code=ABCD1234`,
  )
  expect(cloud.codes).toBe(1)
  await account.logout()
})

test('批准后写入云端接口：设备密钥只在该接口中，型号带各自的协议，未选模型时设为当前模型', async () => {
  await account.login()
  cloud.token = 'ok'
  await until(stateIs('signed_in'))
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
  expect(await account.state()).toEqual({
    state: 'signed_in',
    email: 'me@example.com',
    credits: 12.5,
    provider: CLOUD_PROVIDER,
  })
  expect(cloud.signedOut).toBe(1)
  // 写入的是磁盘上的配置，而不只是内存中的对象。
  expect((await loadConfig()).providers[CLOUD_PROVIDER]?.apiKey).toBe('qyd_device_key')
})

test('在浏览器中拒绝或用户码过期时结束等待并给出原因', async () => {
  await account.login()
  cloud.token = 'denied'
  await until(stateIs('signed_out'))
  expect(await account.state()).toEqual({ state: 'signed_out', reason: 'denied' })
  cloud.token = 'pending'
  await account.login()
  cloud.token = 'expired'
  await until(stateIs('signed_out'))
  expect(await account.state()).toEqual({ state: 'signed_out', reason: 'expired' })
})

test('网关返回 device_revoked 时删除本地接口并清除当前模型；其他 401 不删除', async () => {
  await account.login()
  cloud.token = 'ok'
  await until(stateIs('signed_in'))
  cloud.me = 'invalid'
  expect((await account.state()).state).toBe('signed_in')
  expect(live.providers[CLOUD_PROVIDER]).toBeDefined()
  cloud.me = 'revoked'
  expect(await account.state()).toEqual({ state: 'signed_out', reason: 'revoked' })
  expect(live.providers[CLOUD_PROVIDER]).toBeUndefined()
  expect(live.active?.provider).not.toBe(CLOUD_PROVIDER)
})

test('退出时请求云端吊销本设备并删除本地接口', async () => {
  await account.login()
  cloud.token = 'ok'
  await until(stateIs('signed_in'))
  await account.logout()
  expect(cloud.revoked).toBe(1)
  expect(live.providers[CLOUD_PROVIDER]).toBeUndefined()
  expect((await loadConfig()).providers[CLOUD_PROVIDER]).toBeUndefined()
  expect((await account.state()).state).toBe('signed_out')
})
