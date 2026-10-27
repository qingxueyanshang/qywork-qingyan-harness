/** 覆盖 `pull.ts`：按已保存的接口拉取，凭证只在服务端使用，失败返回地址、状态码与对端说明。 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import type { PullResult } from '@qywork/ai'
import type { QyConfig } from '@qywork/runtime'
import { handlePullApi } from './pull.ts'
import type { ApiRequestDeps } from './types.ts'

const KEY = 'sk-pull-secret-value'
let server: ReturnType<typeof Bun.serve>
let models = true
let unauthorized = false
beforeAll(() => {
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      if (unauthorized)
        return Response.json(
          { error: { message: `Incorrect API key provided: ${KEY}`, code: 'invalid_api_key' } },
          { status: 401 },
        )
      if (path === '/v1/models' && models && req.headers.get('authorization') === `Bearer ${KEY}`)
        return Response.json({ data: [{ id: 'gpt-5.6-sol' }] })
      return new Response('not found', { status: 404 })
    },
  })
})
afterAll(() => server.stop(true))

const config = (baseUrl?: string): QyConfig => ({
  providers: {
    relay: {
      kind: 'openai_chat_completions',
      apiKey: KEY,
      ...(baseUrl ? { baseUrl } : {}),
      models: {},
    },
  },
})

async function pull(cfg: QyConfig, provider = 'relay') {
  const req = new Request('http://localhost/api/models/pull', {
    method: 'POST',
    body: JSON.stringify({ provider }),
  })
  return (await handlePullApi(new URL(req.url), req, { config: cfg } as ApiRequestDeps))!
}

test('按已保存的接口拉取型号，凭证由服务端读取', async () => {
  models = true
  const res = await pull(config(`http://127.0.0.1:${server.port}/v1`))
  expect(res.status).toBe(200)
  expect((await res.json()) as PullResult).toEqual({
    source: 'models',
    models: [{ id: 'gpt-5.6-sol', output: 'chat', known: true }],
  })
})

test('接口不存在、未填写地址、两种来源都失败时分别报错，不回显凭证', async () => {
  expect((await pull(config(), 'missing')).status).toBe(404)
  expect((await pull(config())).status).toBe(400)
  models = false
  const res = await pull(config(`http://127.0.0.1:${server.port}/v1`))
  expect(res.status).toBe(502)
  const text = await res.text()
  expect(text).toContain('/v1/models 返回 HTTP 404')
  expect(text).not.toContain(KEY)
})

/** 原始失败形状：拉取失败只报「/v1/models 返回 HTTP 401」，对端说明的原因（Key 无效）丢失。 */
test('对端拒绝时报告状态码名称与对端说明，说明中回显的凭证被替换', async () => {
  unauthorized = true
  try {
    const res = await pull(config(`http://127.0.0.1:${server.port}/v1`))
    expect(res.status).toBe(502)
    const body = (await res.json()) as { message: string }
    expect(body.message).toBe('/v1/models 返回 HTTP 401 未授权：Incorrect API key provided: ***')
  } finally {
    unauthorized = false
  }
})
