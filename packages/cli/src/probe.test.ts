/** 覆盖 CLI 读取自定义模型规格、发送探针及 --save 写回传输结论。 */
import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAdapter } from '@qywork/ai'
import type { QyConfig } from '@qywork/runtime'

test.each([true, false])(
  'qy probe 保存后用于实际请求，手动规格=%s',
  async (manual) => {
    const home = await mkdtemp(join(tmpdir(), 'qy-probe-'))
    const seen: (string | undefined)[] = []
    const bodies: Record<string, unknown>[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as {
          reasoning_effort?: string
          thinking?: { type: string }
        }
        bodies.push(body)
        seen.push(body.reasoning_effort)
        if (!manual && body.reasoning_effort && body.thinking?.type !== 'enabled') {
          return Response.json({ error: { message: 'thinking must be enabled' } }, { status: 400 })
        }
        if (body.reasoning_effort && !['low', 'high', 'max'].includes(body.reasoning_effort)) {
          return new Response(JSON.stringify({ error: { message: 'unsupported effort' } }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok', ...(body.reasoning_effort ? { reasoning_content: '计算完成' } : {}) }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
          { headers: { 'content-type': 'text/event-stream' } },
        )
      },
    })
    const catalog: QyConfig['catalog'] = manual
      ? {
          'custom|openai_chat_completions': {
            thinking: 'reasoning_effort',
            effortLevels: ['high', 'max'],
          },
        }
      : {}
    try {
      await writeFile(
        join(home, 'config.json'),
        JSON.stringify({
          active: { provider: 'test', model: 'custom' },
          providers: {
            test: {
              kind: 'openai_chat_completions',
              baseUrl: `http://127.0.0.1:${server.port}/v1`,
              models: { custom: { transport: { effort: false } } },
            },
          },
          catalog,
          mode: 'auto',
        }),
      )
      const child = Bun.spawn(
        [process.execPath, 'packages/cli/src/index.ts', 'probe', 'custom', '--save', '--json'],
        {
          cwd: join(import.meta.dir, '../../..'),
          env: { ...process.env, QYWORK_HOME: home },
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const [code, out, err] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      expect({ code, err: code === 0 ? '' : err }).toEqual({ code: 0, err: '' })
      expect(JSON.parse(out).effortLevels).toEqual(
        manual ? ['high', 'max'] : ['low', 'high', 'max'],
      )
      expect(JSON.parse(out).thinkingObserved).toBe(true)
      if (manual)
        expect(seen).toEqual([undefined, 'high', 'max', '__qy_probe_invalid_effort__', undefined])
      const saved = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as QyConfig
      expect(saved.catalog).toEqual(catalog)
      expect(saved.providers.test?.models.custom?.transport).toMatchObject({
        effort: true,
        effortLevels: manual ? ['high', 'max'] : ['low', 'high', 'max'],
        thinking: manual ? 'reasoning_effort' : 'deepseek_thinking',
        toolCalls: {
          kind: 'openai_chat_completions',
          model: 'custom',
          schema: 'native',
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
          status: 'inconclusive',
        },
      })
      const adapter = buildAdapter({
        kind: 'openai_chat_completions',
        model: 'custom',
        apiKey: '',
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        transport: saved.providers.test!.models.custom!.transport!,
      })
      for await (const _ of adapter.stream({
        model: 'custom',
        system: [],
        messages: [{ role: 'user', content: '继续使用' }],
        tools: [],
        effort: 'high',
        maxOutputTokens: 2048,
        idleTimeoutMs: 1000,
      })) {
      }
      expect(bodies.at(-1)?.reasoning_effort).toBe('high')
      expect(bodies.at(-1)?.thinking).toEqual(manual ? undefined : { type: 'enabled' })
    } finally {
      server.stop(true)
      await rm(home, { recursive: true, force: true })
    }
  },
  10_000,
)
