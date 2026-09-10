/** 覆盖 CLI 读取自定义模型规格、发送探针及 --save 写回传输结论。 */
import { expect, test } from 'bun:test'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QyConfig } from '@qywork/runtime'

test('qy probe 使用配置中的未知模型档位，保存不覆盖模型规格', async () => {
  const home = await mkdtemp(join(tmpdir(), 'qy-probe-'))
  const seen: (string | undefined)[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as { reasoning_effort?: string }
      seen.push(body.reasoning_effort)
      if (body.reasoning_effort && !['low', 'high', 'max'].includes(body.reasoning_effort)) {
        return new Response(JSON.stringify({ error: { message: 'unsupported effort' } }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  const catalog: QyConfig['catalog'] = {
    'custom|openai_chat_completions': {
      thinking: 'reasoning_effort',
      effortLevels: ['high', 'max'],
    },
  }
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
    expect(JSON.parse(out).effortLevels).toEqual(['high', 'max'])
    expect(seen).toEqual([undefined, 'high', 'max', '__qy_probe_invalid_effort__'])
    const saved = JSON.parse(await readFile(join(home, 'config.json'), 'utf8')) as QyConfig
    expect(saved.catalog).toEqual(catalog)
    expect(saved.providers.test?.models.custom?.transport).toEqual({
      effort: true,
      effortLevels: ['high', 'max'],
      thinking: 'reasoning_effort',
    })
  } finally {
    server.stop(true)
    await rm(home, { recursive: true, force: true })
  }
})
