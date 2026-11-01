/**
 * 覆盖范围：`login.ts`（`qy login` / `qy logout`）。云端是本文件中的模拟服务，用户在浏览器中的确认以第一次轮询即批准代替；
 * 配置写入测试进程的 `QYWORK_HOME`。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { loadConfig } from '@qywork/runtime'
import { runLogin, runLogout } from './login.ts'

let revoked = 0
const server: ReturnType<typeof Bun.serve> = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(req): Response {
    const path = new URL(req.url).pathname
    if (path === '/api/auth/device/code') {
      return Response.json({
        device_code: 'dc',
        user_code: 'ABCD1234',
        verification_uri: `${origin}/device`,
        expires_in: 600,
        interval: 0,
      })
    }
    if (path === '/api/auth/device/token') return Response.json({ access_token: 'session' })
    if (path === '/api/devices') return Response.json({ id: 'dv_1', key: 'qyd_cli_key' })
    if (path === '/api/auth/sign-out') return Response.json({ success: true })
    if (path === '/v1/me') return Response.json({ email: 'cli@example.com', credits: 3 })
    if (path === '/v1/device/revoke') {
      revoked++
      return new Response(null, { status: 204 })
    }
    if (path === '/api/pricing') {
      return Response.json({
        data: [
          {
            model_name: 'claude-sonnet-5-5',
            quota_type: 0,
            model_ratio: 150,
            completion_ratio: 5,
            enable_groups: ['default'],
            supported_endpoint_types: ['anthropic'],
          },
        ],
        group_ratio: { default: 1 },
      })
    }
    if (path === '/api/status') return Response.json({ data: {} })
    return new Response('not found', { status: 404 })
  },
})
const origin: string = `http://127.0.0.1:${server.port}`
const previous = process.env.QYWORK_CLOUD

beforeAll(() => {
  process.env.QYWORK_CLOUD = `${origin},${origin}`
})

afterAll(() => {
  server.stop(true)
  if (previous === undefined) delete process.env.QYWORK_CLOUD
  else process.env.QYWORK_CLOUD = previous
})

test('登录后配置中有云端接口；退出时吊销设备并删除接口', async () => {
  expect(await runLogin({ pollMs: 10 })).toBe(0)
  expect((await loadConfig()).providers.qywork?.apiKey).toBe('qyd_cli_key')
  expect(await runLogout()).toBe(0)
  expect(revoked).toBe(1)
  expect((await loadConfig()).providers.qywork).toBeUndefined()
})

test('未配置云端服务时失败退出', async () => {
  const saved = process.env.QYWORK_CLOUD
  delete process.env.QYWORK_CLOUD
  try {
    expect(await runLogin()).toBe(1)
  } finally {
    process.env.QYWORK_CLOUD = saved
  }
})
