/**
 * 覆盖 `request-fields.ts`：内置目录中每个型号经其协议的适配器发出的请求体，顶层字段都在名单内。
 * 每个型号按「不指定思考档位」与「指定第一个可用档位」各发送一次，带系统提示词、工具、输出上限与缓存键，
 * 覆盖各适配器全部按条件出现的字段。上游返回 400，适配器在读取响应前已发出请求体。
 */
import { expect, test } from 'bun:test'
import { builtinCatalog } from './catalog.ts'
import { buildAdapter } from './factory.ts'
import { REQUEST_FIELDS } from './request-fields.ts'
import { STREAM_IDLE_TIMEOUT_MS } from './transport.ts'

test('各适配器发出的顶层字段都在云端网关的名单内', async () => {
  let keys: string[] = []
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      keys = Object.keys((await req.json()) as Record<string, unknown>)
      return Response.json(
        { type: 'error', error: { type: 'invalid_request_error', message: 'rejected' } },
        { status: 400 },
      )
    },
  })
  const outside: string[] = []
  try {
    for (const spec of builtinCatalog()) {
      for (const effort of [undefined, spec.effortLevels[0]]) {
        keys = []
        const adapter = buildAdapter({
          model: spec.id,
          kind: spec.provider,
          apiKey: 'test',
          baseUrl: `http://127.0.0.1:${server.port}`,
        })
        try {
          for await (const _ of adapter.stream({
            model: spec.id,
            system: [{ text: '系统提示词' }],
            messages: [{ role: 'user', content: '你好' }],
            maxOutputTokens: 1000,
            idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
            tools: [
              {
                name: 'read_file',
                description: '读取文件',
                parameters: { type: 'object', properties: { path: { type: 'string' } } },
              },
            ],
            ...(effort ? { effort } : {}),
            cacheKey: 'conversation',
          })) {
            // 只需要请求体，不读取响应。
          }
        } catch {
          // 上游返回 400，请求体已收到。
        }
        expect(keys.length).toBeGreaterThan(0)
        for (const key of keys) {
          if (!REQUEST_FIELDS[spec.provider].includes(key)) {
            outside.push(`${spec.provider} ${spec.id}：${key}`)
          }
        }
      }
    }
  } finally {
    server.stop(true)
  }
  expect(outside).toEqual([])
}, 60_000)
