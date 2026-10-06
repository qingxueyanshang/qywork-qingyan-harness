/**
 * 生成端口、参数表快照与生成花费的记账。
 *
 * 覆盖范围：`media.ts` 的 `makeMediaPort`（模型选择、发送前校验、接口错误的转述、成功时返回花费）与 `operationOf`，
 * `prompt.ts` 中「可用的生成模型」一节，`session.ts` 按 `mediaEnabled` 注册画布与生成工具，
 * 以及 `session.ts` 将生成花费写入本轮 usage、`runs` 行与账本。
 *
 * 端口的对端是本机模拟的百炼端点：参数不合法时该端点不得收到任何请求。
 * 记账一组另行启动模拟的对话接口，按脚本先调用图片生成工具、再结束本轮，执行完整的一轮。
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanvasPort } from '@qywork/agent'
import { lookupMediaModel, validateMediaCall } from '@qywork/ai'
import { type AgentEvent, type MediaInputRole, runCosts } from '@qywork/core'
import { getRun, Store } from '@qywork/store'
import type { QyConfig } from './config.ts'
import { listMediaModels } from './config.ts'
import { makeMediaPort, operationOf } from './media.ts'
import { buildTailNotes } from './prompt.ts'
import { Session } from './session.ts'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 1])

let server: ReturnType<typeof Bun.serve>
let hits: string[] = []
let reply: (req: Request) => Response | Promise<Response> = () => Response.json({})
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
      return reply(req)
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
  test('Gemini 与 Grok 图片生成通过同一端口返回文件与费用', async () => {
    const models = [
      {
        id: 'gemini-3.1-flash-image',
        kind: 'gemini_images' as const,
        body: {
          id: 'google-task',
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [
                {
                  type: 'image',
                  mime_type: 'image/jpeg',
                  data: Buffer.from(JPEG).toString('base64'),
                },
              ],
            },
          ],
          usage: {
            total_input_tokens: 100,
            total_output_tokens: 1000,
            total_thought_tokens: 0,
            output_tokens_by_modality: [{ modality: 'image', tokens: 1000 }],
          },
        },
        cost: 0.06005,
      },
      {
        id: 'grok-imagine-image-2.0',
        kind: 'xai_images' as const,
        body: {
          data: [{ b64_json: Buffer.from(JPEG).toString('base64') }],
          usage: { cost_in_usd_ticks: 400000000 },
        },
        cost: 0.04,
      },
    ]
    for (const model of models) {
      reply = () => Response.json(model.body)
      const cfg: QyConfig = {
        providers: {
          native: {
            kind: 'openai_chat_completions',
            apiKey: 'test-key',
            baseUrl: `http://127.0.0.1:${server.port}/v1beta`,
            models: {},
            media: { [model.id]: { kind: model.kind } },
          },
        },
        mediaDefaults: { image: { provider: 'native', model: model.id } },
      }
      expect(listMediaModels(cfg)).toMatchObject([
        { provider: 'native', model: model.id, output: 'image' },
      ])
      const spends: { cost: number; kind: string; quantity: number | null }[] = []
      const result = await makeMediaPort(cfg, (s) => spends.push(s)).generate(call(), signal())
      expect(result).toMatchObject({
        ok: true,
        model: model.id,
        files: [{ bytes: JPEG, mime: 'image/jpeg' }],
      })
      expect(spends).toHaveLength(1)
      expect(spends[0]!.kind).toBe(model.kind)
      expect(spends[0]!.quantity).toBe(1)
      expect(spends[0]!.cost).toBeCloseTo(model.cost, 8)
    }
  })

  test('未指定模型时使用默认模型，结果为已下载的字节', async () => {
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

  /** 生成按次计费：参数错误的调用不得发出。 */
  test('参数不合法时不发送请求，消息中给出合法取值', async () => {
    const out = await makeMediaPort(config()).generate(
      call({ params: { n: 9, quality: 'high' } }),
      signal(),
    )
    expect(out.ok).toBe(false)
    expect(!out.ok && out.message).toContain('范围 1–6')
    expect(!out.ok && out.message).toContain('可用参数：size')
    expect(hits).toEqual([])
  })

  test('指定的模型不存在、没有默认模型、接口未配置 key 时，分别说明修改方法', async () => {
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
    expect(!keyless.ok && keyless.message).toContain('未配置 API Key')
    expect(hits).toEqual([])
  })

  test('接口报错时附带模型名与接口原文', async () => {
    reply = () =>
      Response.json({ code: 'InvalidParameter', message: 'size 不合法' }, { status: 400 })
    const out = await makeMediaPort(config()).generate(call(), signal())
    expect(!out.ok && out.message).toBe('qwen / qwen-image-3.0：HTTP 400：size 不合法')
  })

  test('成功时按接口返回的计量给出花费（记账与本次调用各一份，数值相同），失败时不给出', async () => {
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
    const own: unknown[] = []
    await makeMediaPort(config(), (s) => spends.push(s)).generate(
      { ...call(), onSpend: (s) => own.push(s) },
      signal(),
    )
    expect(own).toEqual(spends)
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
    await makeMediaPort(config(), (s) => spends.push(s)).generate(
      { ...call(), onSpend: (s) => own.push(s) },
      signal(),
    )
    expect(spends).toHaveLength(1)
    expect(own).toHaveLength(1)
  })
})

/** 对话接口的 SSE 正文：第一次请求调用图片生成工具，下一次请求结束本轮。 */
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
   * 原始失败形状：一轮中生成了图片，读数条、「运行」面板与账本均不显示这笔花费。
   * 此处执行完整的一轮：花费随本轮 usage 事件与收尾事件发出，写入 `runs` 行，收尾时记入账本；
   * 账本中 `run` 类型的行仍只记录模型调用。
   */
  test('一次图片生成的花费计入本轮 usage、runs 行与账本', async () => {
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
      // 轮次运行期间已发出一次携带该笔花费的 usage 事件。
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

describe('画布与生成开关', () => {
  /** 设置页「画布与生成」分组标题上的开关写入 `mediaEnabled`；会话据此决定是否注册这组工具。 */
  test('mediaEnabled 为 false 时不注册画布与生成工具；缺省时按启用处理', async () => {
    const names = async (over: Partial<QyConfig>) => {
      const store = new Store({ path: ':memory:' })
      const s = new Session({
        store,
        config: config(over),
        workspaceRoot: await mkdtemp(join(tmpdir(), 'qywork-media-switch-')),
        signal: signal(),
        canvas: {} as CanvasPort,
      })
      const list = (s as unknown as { registry: { schemas(): { name: string }[] } }).registry
        .schemas()
        .map((t) => t.name)
      store.close()
      return list
    }
    const tools = ['read_canvas', 'edit_canvas', 'run_canvas', 'retrieve_canvas', 'generate_image']
    expect(await names({})).toEqual(expect.arrayContaining(tools))
    expect(await names({ mediaEnabled: true })).toEqual(expect.arrayContaining(tools))
    const off = await names({ mediaEnabled: false })
    for (const name of tools) expect(off).not.toContain(name)
    expect(off).toContain('read_file')
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
    // 参数表排在工作区状态行之前：参数表排在最后时，紧随其后的用户请求会被模型视为参数表的一部分。
    expect(text.indexOf('可用的生成模型')).toBeLessThan(text.indexOf('工作区：'))
  })

  test('没有生成模型时不输出该节', () => {
    const notes = buildTailNotes({ workspaceRoot: '/w', platform: 'linux', mode: 'auto' })
    expect(notes.map((n) => n.content).join('\n')).not.toContain('可用的生成模型')
  })

  test('登记了指代写法的模型额外输出一行写法，未登记的不输出', () => {
    const notes = buildTailNotes({
      workspaceRoot: '/w',
      platform: 'linux',
      mode: 'auto',
      mediaModels: [
        {
          provider: 'ark',
          model: 'doubao-seedance-2-5-260628',
          kind: 'ark_videos',
          output: 'video',
          isDefault: true,
        },
        {
          provider: 'qwen',
          model: 'wan3.0-video',
          kind: 'dashscope_videos',
          output: 'video',
          isDefault: false,
        },
        {
          provider: 'qwen',
          model: 'kling/kling-v3-video-generation',
          kind: 'dashscope_videos',
          output: 'video',
          isDefault: false,
        },
      ],
    })
    const text = notes.map((n) => n.content).join('\n')
    expect(text).toContain(
      '提示词中指代参考素材：图像写「@图片1」「@图片2」，视频写「@视频1」「@视频2」',
    )
    expect(text).toContain('图像写「图1」「图2」')
    const kling = text.slice(text.indexOf('kling/kling-v3-video-generation'))
    expect(kling.split('\n- ')[0]).not.toContain('指代参考素材')
  })
})

describe('视频：由输入推断操作', () => {
  const input = (role: MediaInputRole) => ({
    role,
    bytes: new Uint8Array([1]),
    mime: role === 'video' ? 'video/mp4' : role === 'audio' ? 'audio/wav' : 'image/png',
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

  test('尾帧与参考组合由具体型号校验，重复帧仍直接拒绝', () => {
    expect(operationOf('video', [input('last_frame')])).toEqual({
      operation: 'first_last_frame',
    })
    expect(operationOf('video', [input('first_frame'), input('reference')])).toEqual({
      operation: 'reference_to_video',
    })
    expect(operationOf('video', [input('first_frame'), input('first_frame')])).toMatchObject({
      problem: expect.any(String),
    })
  })

  test('参考音频参与操作推断，组合限制由型号决定', () => {
    expect(operationOf('video', [input('reference'), input('audio')])).toEqual({
      operation: 'reference_to_video',
    })
    expect(operationOf('video', [input('video'), input('audio')])).toEqual({
      operation: 'video_to_video',
    })
    expect(operationOf('video', [input('audio')])).toEqual({
      operation: 'reference_to_video',
    })
    expect(operationOf('video', [input('first_frame'), input('audio')])).toMatchObject({
      operation: 'reference_to_video',
    })
    const counts = { images: 0, videos: 0, audios: 1 }
    for (const [id, kind] of [
      ['wan3.0-video-prime', 'dashscope_videos'],
      ['doubao-seedance-2-5-260628', 'ark_videos'],
    ] as const) {
      expect(
        validateMediaCall(lookupMediaModel(id, kind), 'reference_to_video', {}, counts),
      ).toEqual([])
    }
    expect(
      validateMediaCall(
        lookupMediaModel('doubao-seedance-2-0-260128', 'ark_videos'),
        'reference_to_video',
        {},
        counts,
      ),
    ).toContain('参考音频必须与参考图或参考视频同时提供')
  })
})

describe('生成模型协议映射', () => {
  test('百炼素材上传失败作为生成失败返回，不提交视频任务', async () => {
    reply = () => new Response('upload denied', { status: 403 })
    const cfg = config()
    cfg.providers.qwen!.media!['wan3.0-video-prime'] = { kind: 'dashscope_videos' }
    const out = await makeMediaPort(cfg).generate(
      {
        type: 'video',
        provider: 'qwen',
        model: 'wan3.0-video-prime',
        prompt: '音乐',
        params: {},
        inputs: [
          { role: 'audio', bytes: new Uint8Array([1]), mime: 'audio/wav', path: '/w/a.wav' },
        ],
      },
      signal(),
    )
    expect(!out.ok && out.message).toContain('素材上传失败：upload denied')
    expect(hits).toEqual(['/api/v1/uploads'])
  })
  const image = (role: MediaInputRole = 'reference') => ({
    role,
    bytes: JPEG,
    mime: 'image/jpeg',
    path: '/w/input.jpg',
  })
  const mappedConfig = (
    model: string,
    kind: NonNullable<QyConfig['providers'][string]['media']>[string]['kind'],
  ): QyConfig => ({
    providers: {
      relay: {
        kind: 'openai_chat_completions',
        apiKey: 'test',
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        models: {},
        media: { [model]: { kind } },
      },
    },
    mediaDefaults: { video: { provider: 'relay', model } },
  })

  test('Prime 两张参考图通过校验并发送，时长、尺寸与声音设置完整保留，成功后下载产物', async () => {
    let body: Record<string, unknown> = {}
    reply = async (req) => {
      if (req.method === 'POST') {
        body = (await req.json()) as Record<string, unknown>
        return Response.json({ id: 'wan-task' })
      }
      if (req.url.endsWith('/content'))
        return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'video/mp4' } })
      return Response.json({ status: 'completed', seconds: '20' })
    }
    const result = await makeMediaPort(
      mappedConfig('wan3.0-video-prime', 'openai_videos'),
    ).generate(
      {
        type: 'video',
        prompt: '两个人物对战',
        inputs: [image(), image()],
        params: { resolution: '480P', ratio: '9:16', duration: 20, audio: false },
      },
      signal(),
    )
    expect(result.ok).toBe(true)
    expect(body).toEqual({
      model: 'wan3.0-video-prime',
      prompt: '两个人物对战',
      metadata: {
        input: {
          prompt: '两个人物对战',
          media: [
            {
              type: 'reference_image',
              url: `data:image/jpeg;base64,${Buffer.from(JPEG).toString('base64')}`,
            },
            {
              type: 'reference_image',
              url: `data:image/jpeg;base64,${Buffer.from(JPEG).toString('base64')}`,
            },
          ],
        },
        parameters: { resolution: '480P', ratio: '9:16', duration: 20, audio: false },
      },
    })
    expect(hits).toEqual(['/v1/videos', '/v1/videos/wan-task', '/v1/videos/wan-task/content'])
  })

  test('Seedance 2.5 的单独音频能到达中转，2.0 的同类输入在发送前拒绝', async () => {
    let body: Record<string, unknown> = {}
    reply = async (req) => {
      body = (await req.json()) as Record<string, unknown>
      return Response.json({ error: { message: 'request captured' } }, { status: 400 })
    }
    const input = {
      role: 'audio' as const,
      bytes: new Uint8Array([1]),
      mime: 'audio/mpeg',
      path: '/w/voice.mp3',
    }
    const generate = (model: string) =>
      makeMediaPort(mappedConfig(model, 'openai_videos')).generate(
        {
          type: 'video',
          prompt: '随音乐生成',
          inputs: [input],
          params: { duration: 10, generate_audio: true },
        },
        signal(),
      )
    await generate('doubao-seedance-2-5-260628')
    expect(hits).toHaveLength(1)
    expect(body.metadata).toMatchObject({
      duration: 10,
      generate_audio: true,
      content: [
        { type: 'text', text: '随音乐生成' },
        {
          type: 'audio_url',
          role: 'reference_audio',
          audio_url: { url: 'data:audio/mp3;base64,AQ==' },
        },
      ],
    })
    hits = []
    const bad = await generate('doubao-seedance-2-0-260128')
    expect(!bad.ok && bad.message).toContain('参考音频必须')
    expect(hits).toHaveLength(0)
  })

  test('Grok 尾帧单独输入和帧与参考图组合会发送，万相仍保留互斥限制', async () => {
    let body: Record<string, unknown> = {}
    reply = async (req) => {
      body = (await req.json()) as Record<string, unknown>
      return Response.json({ message: 'captured' }, { status: 400 })
    }
    for (const inputs of [
      [image('last_frame')],
      [image('first_frame'), image('last_frame'), image()],
    ]) {
      await makeMediaPort(mappedConfig('grok-imagine-video-1.5', 'xai_videos')).generate(
        { type: 'video', prompt: '动作', inputs, params: { resolution: '720p' } },
        signal(),
      )
      expect(body.last_frame).toMatchObject({ url: expect.stringContaining('data:image/jpeg') })
    }
    expect(body.reference_images).toHaveLength(1)
    expect(hits).toHaveLength(2)
    hits = []
    const bad = await makeMediaPort(mappedConfig('wan3.0-video-prime', 'openai_videos')).generate(
      { type: 'video', prompt: '动作', inputs: [image('first_frame'), image()], params: {} },
      signal(),
    )
    expect(!bad.ok && bad.message).toContain('首尾帧不能')
    expect(hits).toHaveLength(0)
  })

  test('Veo 中转传递首帧和参数，千问多图兼容请求使用 JSON 并保留所有参考图', async () => {
    let body: Record<string, unknown> = {}
    reply = async (req) => {
      body = (await req.json()) as Record<string, unknown>
      return Response.json({ message: 'captured' }, { status: 400 })
    }
    await makeMediaPort(mappedConfig('veo-3.1-generate-preview', 'openai_videos')).generate(
      {
        type: 'video',
        prompt: '动作',
        inputs: [image('first_frame')],
        params: { durationSeconds: 8, resolution: '1080p', aspectRatio: '9:16' },
      },
      signal(),
    )
    expect(body).toMatchObject({
      seconds: '8',
      images: [expect.stringContaining('data:image/jpeg')],
      metadata: { durationSeconds: 8, resolution: '1080p', aspectRatio: '9:16' },
    })
    const cfg = mappedConfig('qwen-image-3.0', 'openai_images')
    await makeMediaPort(cfg).generate(
      {
        type: 'image',
        provider: 'relay',
        model: 'qwen-image-3.0',
        prompt: '合成',
        inputs: [image(), image()],
        params: { size: '1024x1024', prompt_extend: false },
      },
      signal(),
    )
    expect(hits.at(-1)).toBe('/v1/images/generations')
    expect(body).toMatchObject({
      size: '1024x1024',
      image: [expect.any(String), expect.any(String)],
      prompt_extend: false,
    })
  })
})

test('语音合成不接受输入文件', () => {
  expect(operationOf('audio', [])).toEqual({ operation: 'speech' })
  expect(
    operationOf('audio', [
      { role: 'reference', bytes: new Uint8Array([1]), mime: 'image/png', path: '/w/a' },
    ]),
  ).toEqual({ problem: '语音合成不接受输入文件' })
})
