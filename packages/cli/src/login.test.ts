/**
 * 覆盖范围：`login.ts`（`qy login` / `qy logout`）。云端是本文件中的模拟服务，终端输入以固定答案代替；
 * 配置写入测试进程的 `QYWORK_HOME`。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { loadConfig } from '@qywork/runtime'
import { type Ask, runLogin, runLogout } from './login.ts'

let revoked = 0
const server: ReturnType<typeof Bun.serve> = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req): Promise<Response> {
    const path = new URL(req.url).pathname
    if (path === '/v1/login') {
      const body = (await req.json()) as { password: string }
      return body.password === 'password-123'
        ? Response.json({ key: 'qyd_cli_key' })
        : Response.json({ error: { code: 'INVALID_EMAIL_OR_PASSWORD' } }, { status: 401 })
    }
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

/** 依次回答邮箱与密码，并记录每次询问是否要求不回显。 */
function answers(email: string, password: string, hidden: boolean[] = []): Ask {
  return async (_question, isHidden) => {
    hidden.push(isHidden)
    return hidden.length === 1 ? email : password
  }
}

test('密码错误时失败退出，不写入接口', async () => {
  expect(await runLogin(answers('cli@example.com', 'wrong-password'))).toBe(1)
  expect((await loadConfig()).providers.qywork).toBeUndefined()
})

test('登录后配置中有云端接口，密码不回显；退出时吊销设备并删除接口', async () => {
  const hidden: boolean[] = []
  expect(await runLogin(answers('cli@example.com', 'password-123', hidden))).toBe(0)
  expect(hidden).toEqual([false, true])
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
