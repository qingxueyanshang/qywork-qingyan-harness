/**
 * 生成端口、参数表快照与生成花费的记账。
 *
 * 覆盖范围：`media.ts` 的 `makeMediaPort`（选模型、发出前校验、接口错误的转述、成功时交出花费）与 `operationOf`，
 * `prompt.ts` 里「可用的生成模型」那一节，以及 `session.ts` 把生成花费写进本轮 usage、`runs` 行与账本。
 *
 * 端口对面是一个本机假百炼端点：参数不合法时它必须一次都没收到请求。
 * 记账那一组另起一个假的对话接口，脚本化地先调出图工具、再收尾，跑完整的一轮。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type AgentEvent, runCosts } from '@qywork/core'
import { getRun, Store } from '@qywork/store'
import type { QyConfig } from './config.ts'
import { listMediaModels } from './config.ts'
import { makeMediaPort, operationOf } from './media.ts'
import { buildTailNotes } from './prompt.ts'
import { Session } from './session.ts'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1])

let server: ReturnType<typeof Bun.serve>
let hits: string[] = []
let reply: () => Response = () => Response.json({})
/** 对话接口的回复，按调用次序给出 SSE 正文。 */
let chat: () => string = () => ''

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req) {
      const path = new URL(req.url).pathname
      if (path === '/files/out.jpg') return new Response(JPEG)
      if (path.endsWith('/chat/completions')) {
        return new Response(chat(), { headers: { 'content-type': 'text/event-stream' } })
      }
      hits.push(path)
      return reply()
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  hits = []
  reply = () =>
    Response.json({
      output: {
        choices: [
          { message: { content: [{ image: `http://127.0.0.1:${server.port}/files/out.jpg` }] } },
        ],
      },
    })
})

const config = (over: Partial<QyConfig> = {}): QyConfig => ({
  providers: {
    qwen: {
      kind: 'openai_chat_completions',
      apiKey: 'sk-qwen',
      baseUrl: `http://127.0.0.1:${server.port}/compatible-mode/v1`,
      models: {},
      media: {
        'qwen-image-3.0': { kind: 'dashscope_images' },
        'wan2.7-image': { kind: 'dashscope_images' },
      },
    },
  },
  mediaDefaults: { image: { provider: 'qwen', model: 'qwen-image-3.0' } },
  ...over,
})

const signal = () => new AbortController().signal
const call = (over: Record<string, unknown> = {}) => ({
  type: 'image' as const,
  prompt: '一只猫',
  inputs: [],
  params: {},
  ...over,
})

describe('生成端口', () => {
  test('不点名用默认模型，结果是下载好的字节', async () => {
    const out = await makeMediaPort(config()).generate(
      call({ params: { size: '1024*1536' } }),
      signal(),
    )
    expect(out).toEqual({
      ok: true,
      provider: 'qwen',
      model: 'qwen-image-3.0',
      files: [{ bytes: JPEG, mime: 'image/jpeg' }],
    })
    expect(hits).toEqual(['/api/v1/services/aigc/multimodal-generation/generation'])
  })

  /** 生成按次计费：参数错的调用一次都不能发出去。 */
  test('参数不合法时不发请求，消息里给出合法取值', async () => {
    const out = await makeMediaPort(config()).generate(
      call({ params: { n: 9, quality: 'high' } }),
      signal(),
    )
    expect(out.ok).toBe(false)
    expect(!out.ok && out.message).toContain('范围 1–6')
    expect(!out.ok && out.message).toContain('可用：size')
    expect(hits).toEqual([])
  })

  test('点名的模型不存在、没有默认模型、接口没有 key，各自说清怎么改', async () => {
    const port = makeMediaPort(config())
    const missing = await port.generate(call({ provider: 'qwen', model: '没有' }), signal())
    expect(!missing.ok && missing.message).toContain(
      '可选：qwen / qwen-image-3.0、qwen / wan2.7-image',
    )
    const noDefault = await makeMediaPort(config({ mediaDefaults: {} })).generate(call(), signal())
    expect(!noDefault.ok && noDefault.message).toContain('没有默认的图像模型')
    const noKey = config()
    delete noKey.providers.qwen!.apiKey
    const keyless = await makeMediaPort(noKey).generate(call(), signal())
    expect(!keyless.ok && keyless.message).toContain('没有配置 API Key')
    expect(hits).toEqual([])
  })

  test('接口报错时带模型名与接口原文', async () => {
    reply = () =>
      Response.json({ code: 'InvalidParameter', message: 'size 不合法' }, { status: 400 })
    const out = await makeMediaPort(config()).generate(call(), signal())
    expect(!out.ok && out.message).toBe('qwen / qwen-image-3.0：HTTP 400：size 不合法')
  })

  test('成功时按接口回报的计量交出花费，失败时不交', async () => {
    reply = () =>
      Response.json({
        output: {
          choices: [
            { message: { content: [{ image: `http://127.0.0.1:${server.port}/files/out.jpg` }] } },
          ],
        },
        usage: {
          output_image_count: 1,
          input_image_count: 0,
          output_image_type: 'qima_output_2k',
        },
      })
    const spends: unknown[] = []
    await makeMediaPort(config(), (s) => spends.push(s)).generate(call(), signal())
    expect(spends).toEqual([
      {
        kind: 'dashscope_images',
        provider: 'qwen',
        model: 'qwen-image-3.0',
        output: 'image',
        quantity: 1,
        cost: 0.18,
        currency: 'CNY',
        at: expect.any(Number),
      },
    ])

    reply = () => Response.json({ code: 'InvalidParameter', message: 'x' }, { status: 400 })
    await makeMediaPort(config(), (s) => spends.push(s)).generate(call(), signal())
    expect(spends).toHaveLength(1)
  })
})

/** 对话接口的一段 SSE：先调一次出图工具，下一次请求收尾。 */
function chatTurn(turn: number): string {
  const chunk = (body: unknown) => `data: ${JSON.stringify(body)}\n\n`
  if (turn === 1) {
    return (
      chunk({
        choices: [
          {
            delta: {
              tool_calls: [
                {
                  index: 0,
                  id: 'call_img',
                  type: 'function',
                  function: {
                    name: 'generate_image',
                    arguments: JSON.stringify({ prompt: '一只猫' }),
                  },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      }) +
      chunk({
        choices: [{ delta: {}, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }) +
      'data: [DONE]\n\n'
    )
  }
  return (
    chunk({ choices: [{ delta: { content: '画好了' }, finish_reason: null }] }) +
    chunk({
      choices: [{ delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 20, completion_tokens: 3 },
    }) +
    'data: [DONE]\n\n'
  )
}

describe('生成花费', () => {
  /**
   * 原始失败形状：一轮里生成了图片，读数条、「运行」面板与账本都看不到这笔花费。
   * 这里跑完整的一轮：花费随本轮 usage 事件与收尾事件带出，写进 `runs` 行，收尾时记进账本；
   * 记账的 `run` 那一行仍只是模型调用。
   */
  test('一次出图的花费进本轮 usage、runs 行与账本', async () => {
    let turn = 0
    chat = () => chatTurn(++turn)
    reply = () =>
      Response.json({
        output: {
          choices: [
            { message: { content: [{ image: `http://127.0.0.1:${server.port}/files/out.jpg` }] } },
          ],
        },
        usage: { output_image_count: 1, input_image_count: 0, output_image_type: 'qima_output_1k' },
      })
    const store = new Store({ path: ':memory:' })
    const s = new Session({
      store,
      config: {
        ...config(),
        active: { provider: 'qwen', model: 'qwen-test' },
        providers: {
          qwen: { ...config().providers.qwen!, models: { 'qwen-test': {} } },
        },
        mode: 'full',
      },
      workspaceRoot: await mkdtemp(join(tmpdir(), 'qywork-media-spend-')),
      signal: new AbortController().signal,
    })
    try {
      const events: AgentEvent[] = []
      for await (const ev of s.ask('画一只猫')) events.push(ev)
      const finished = events.find((e) => e.type === 'run.finished')
      if (finished?.type !== 'run.finished') throw new Error('没有收尾事件')
      const spend = {
        kind: 'dashscope_images',
        provider: 'qwen',
        model: 'qwen-image-3.0',
        output: 'image',
        quantity: 1,
        cost: 0.18,
        currency: 'CNY',
      }
      expect(finished.usage.media).toEqual([expect.objectContaining(spend)])
      expect(runCosts(finished.usage)).toEqual({ CNY: 0.18 })
      // 轮次还在跑时就有一次带着这笔花费的 usage 事件。
      expect(events.some((e) => e.type === 'usage' && e.usage.media?.length === 1)).toBe(true)
      expect(getRun(store, finished.runId)?.usage.media).toEqual([expect.objectContaining(spend)])
      expect(
        store.db
          .query('SELECT kind, run_id, model, cost, currency FROM usage_ledger ORDER BY kind')
          .all(),
      ).toEqual([
        {
          kind: 'media',
          run_id: finished.runId,
          model: 'qwen-image-3.0',
          cost: 0.18,
          currency: 'CNY',
        },
        { kind: 'run', run_id: finished.runId, model: 'qwen-test', cost: 0, currency: 'USD' },
      ])
    } finally {
      s.dispose()
      store.close()
    }
  })
})

describe('参数表快照', () => {
  test('按类别列出模型、默认标记与该模型的原生参数', () => {
    const notes = buildTailNotes({
      workspaceRoot: '/w',
      platform: 'linux',
      mode: 'auto',
      mediaModels: listMediaModels(config()),
    })
    const text = notes.map((n) => n.content).join('\n')
    expect(text).toContain('### 图像 · generate_image')
    expect(text).toContain('model `qwen-image-3.0`（默认）：生成、修改，参考图最多 3 张')
    expect(text).toContain('  - prompt_extend：true | false')
    expect(text).toContain('model `wan2.7-image`：生成、修改，参考图最多 9 张')
    // 参数表排在工作区状态行之前：排在最后时，紧跟的用户请求被模型读成参数表的一部分。
    expect(text.indexOf('可用的生成模型')).toBeLessThan(text.indexOf('工作区：'))
  })

  test('没有生成模型时不出现这一节', () => {
    const notes = buildTailNotes({ workspaceRoot: '/w', platform: 'linux', mode: 'auto' })
    expect(notes.map((n) => n.content).join('\n')).not.toContain('可用的生成模型')
  })
})

describe('视频：由输入推操作', () => {
  const input = (role: 'reference' | 'first_frame' | 'last_frame' | 'video') => ({
    role,
    bytes: new Uint8Array([1]),
    mime: role === 'video' ? 'video/mp4' : 'image/png',
    path: `/w/${role}`,
  })

  test('各种输入组合对应的操作', () => {
    expect(operationOf('video', [])).toEqual({ operation: 'text_to_video' })
    expect(operationOf('video', [input('first_frame')])).toEqual({ operation: 'image_to_video' })
    expect(operationOf('video', [input('first_frame'), input('last_frame')])).toEqual({
      operation: 'first_last_frame',
    })
    expect(operationOf('video', [input('reference')])).toEqual({ operation: 'reference_to_video' })
    expect(operationOf('video', [input('video'), input('reference')])).toEqual({
      operation: 'video_to_video',
    })
    expect(operationOf('image', [input('reference')])).toEqual({ operation: 'edit' })
  })

  test('不成立的组合直接退回', () => {
    expect(operationOf('video', [input('last_frame')])).toEqual({ problem: '给了尾帧就要给首帧' })
    expect(operationOf('video', [input('first_frame'), input('reference')])).toMatchObject({
      problem: expect.stringContaining('不能与参考图'),
    })
  })
})

test('语音合成不收输入文件', () => {
  expect(operationOf('audio', [])).toEqual({ operation: 'speech' })
  expect(
    operationOf('audio', [
      { role: 'reference', bytes: new Uint8Array([1]), mime: 'image/png', path: '/w/a' },
    ]),
  ).toEqual({ problem: '语音合成不收输入文件' })
})
