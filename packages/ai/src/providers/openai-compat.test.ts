/**
 * 覆盖 `openai-compat.ts` 的 `buildReasoning`（实际发送的思考控制字段）
 * 与 `createThinkingSplitter`（将正文中带思考标签的内容移到思考通道）、strict 参数约束、
 * `buildMessages` 对工具结果媒体的编码（观察消息），
 * 以及判定百炼官方端点所用的 `@qywork/core` 的 `isDashScopeEndpoint`。
 *
 * 必须检查真实请求体，不能只测试纯函数：目录声明了档位、界面渲染了控件
 * 而请求中没有对应字段时，两端均正确而取值在中间环节丢失，
 * 任何一端的单元测试都无法发现。
 *
 * 因此此处启动本机 server 作为端点，原样保存收到的 body。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDashScopeEndpoint } from '@qywork/core'
import { lookupModel, unknownModel } from '../catalog.ts'
import { STREAM_IDLE_TIMEOUT_MS } from '../transport.ts'
import type { ChatRequest, ProviderProfile, ToolSchema, WireMessage } from '../types.ts'
import {
  createThinkingSplitter,
  dashScopeMediaHeaders,
  normalizeBaseUrl,
  OpenAICompatAdapter,
  prepareDashScopeMedia,
  strictify,
  TOOL_MEDIA_NOTE,
  uploadDashScopeMedia,
} from './openai-compat.ts'

const bodies: Record<string, unknown>[] = []
const requestHeaders: Headers[] = []
let server: ReturnType<typeof Bun.serve>
let base = ''

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      requestHeaders.push(new Headers(req.headers))
      bodies.push((await req.json()) as Record<string, unknown>)
      // 最小可解析的 SSE：一个 delta 与一个终止标记。适配器只需能够读完。
      const body =
        'data: {"choices":[{"delta":{"content":"ok"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
        'data: [DONE]\n\n'
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  base = `http://127.0.0.1:${server.port}/v1`
})

afterAll(() => server.stop(true))

async function send(
  model: string,
  effort?: string,
  tools: ToolSchema[] = [],
  messages: WireMessage[] = [{ role: 'user', content: '嗨' }],
): Promise<Record<string, unknown>> {
  bodies.length = 0
  requestHeaders.length = 0
  const profile: ProviderProfile = {
    kind: 'openai_chat_completions',
    apiKey: 'sk-x',
    model,
    baseUrl: base,
  }
  const adapter = new OpenAICompatAdapter(profile, lookupModel(model, 'openai_chat_completions'))
  for await (const _ of adapter.stream({
    model,
    system: [],
    messages,
    tools,
    maxOutputTokens: 64,
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    ...(effort ? { effort: effort as never } : {}),
    signal: new AbortController().signal,
  })) {
    // 只需读完，不检查输出。
  }
  return bodies[0]!
}

/** 输出上限的请求值与规格上限均可单独指定的发送函数。上方的 `send` 固定为 64，无法测试不发送该字段的情形。 */
async function sendWithCap(
  model: string,
  requested: number | null,
  spec = lookupModel(model, 'openai_chat_completions'),
): Promise<Record<string, unknown>> {
  bodies.length = 0
  const adapter = new OpenAICompatAdapter(
    { kind: 'openai_chat_completions', apiKey: 'sk-x', model, baseUrl: base },
    spec,
  )
  for await (const _ of adapter.stream({
    model,
    system: [],
    messages: [{ role: 'user', content: '嗨' }],
    tools: [],
    maxOutputTokens: requested,
    idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    signal: new AbortController().signal,
  })) {
    // 只需读完。
  }
  return bodies[0]!
}

/*
 * ── 输出上限：未经测定则不发送 ──
 *
 * 原始失败形状：未收录模型被填入无依据的 8192，长回答在该处被静默截断，
 * 停止原因为 `max_tokens`，而任何位置都未说明该值由客户端填入。
 */
describe('输出上限：未经测定则不发送该字段', () => {
  test('未收录模型不发送该字段，body 中没有 max_tokens', async () => {
    const spec = unknownModel('中转站上的某个模型', 'openai_chat_completions')
    const body = await sendWithCap('中转站上的某个模型', null, spec)
    expect('max_tokens' in body).toBe(false)
  })

  test('已收录的模型照常发送，并按规格上限截取', async () => {
    const body = await sendWithCap('deepseek-flash', 999_999_999)
    expect(body.max_tokens).toBe(
      lookupModel('deepseek-flash', 'openai_chat_completions').maxOutputTokens,
    )
  })

  /** 探针场景：规格未经测定，但调用方明确指定了数值，此时照常发送，否则每次探测都会生成完整回答。 */
  test('规格未经测定而调用方指定了数值：照常发送该数值', async () => {
    const spec = unknownModel('中转站上的某个模型', 'openai_chat_completions')
    const body = await sendWithCap('中转站上的某个模型', 16, spec)
    expect(body.max_tokens).toBe(16)
  })
})

/*
 * ── 工具结果图片的 wire 形状 ──
 *
 * tool 消息只发送文本，媒体块移到紧随整批回执的一条用户观察消息中（依据见
 * `openai-compat.ts` 的 `buildMessages` 注释）。此处锁定请求体：媒体不在 tool 消息中、
 * 观察消息排在整批回执之后、每个媒体块前标出 call_id 与序号、没有媒体时形状不变。
 */
describe('工具结果带图片', () => {
  const png = (data: string) =>
    ({ type: 'image', mimeType: 'image/png', source: { kind: 'base64', data } }) as const
  const label = (id: string, what: string) => ({ type: 'text', text: `call_id ${id} · ${what}` })
  const imageUrl = (data: string) => ({
    type: 'image_url',
    image_url: { url: `data:image/png;base64,${data}` },
  })
  const note = { type: 'text', text: TOOL_MEDIA_NOTE }

  test('图像不进入 tool 消息，放入紧随回执的用户观察消息', async () => {
    const body = await send(
      'deepseek-flash',
      undefined,
      [],
      [
        { role: 'user', content: '看图' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c_img', name: 'read_file', arguments: { path: 'a.png' } }],
        },
        {
          role: 'tool',
          toolCallId: 'c_img',
          content: [{ type: 'text', text: '{"call_id":"c_img","status":"success"}' }, png('QUJD')],
        },
      ],
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user'])
    expect(messages[2]).toEqual({
      role: 'tool',
      tool_call_id: 'c_img',
      content: '{"call_id":"c_img","status":"success"}\n[图像 1：见本批工具结果之后的观察消息]',
    })
    expect(messages[3]!.content).toEqual([note, label('c_img', '图像 1'), imageUrl('QUJD')])
  })

  test('并行工具：回执连续，观察消息排在整批之后，按调用与序号标注', async () => {
    const body = await send(
      'deepseek-flash',
      undefined,
      [],
      [
        { role: 'user', content: '看两张' },
        {
          role: 'assistant',
          content: '',
          reasoningContent: '先读两张图',
          toolCalls: [
            { id: 'c1', name: 'read_file', arguments: { path: 'a.png' } },
            { id: 'c2', name: 'read_file', arguments: { path: 'b.png' } },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'c1',
          content: [{ type: 'text', text: 'A' }, png('A1'), png('A2')],
        },
        { role: 'tool', toolCallId: 'c2', content: [png('B1')] },
        { role: 'assistant', content: '看完了' },
      ],
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'tool',
      'user',
      'assistant',
    ])
    expect(messages[1]!.reasoning_content).toBe('先读两张图')
    expect(messages[2]!.content).toBe(
      'A\n[图像 1：见本批工具结果之后的观察消息]\n[图像 2：见本批工具结果之后的观察消息]',
    )
    // 只有图像的结果也有非空回执。
    expect(messages[3]!.content).toBe('[图像 1：见本批工具结果之后的观察消息]')
    expect(messages[4]!.content).toEqual([
      note,
      label('c1', '图像 1'),
      imageUrl('A1'),
      label('c1', '图像 2'),
      imageUrl('A2'),
      label('c2', '图像 1'),
      imageUrl('B1'),
    ])
    expect(JSON.stringify([messages[2], messages[3]])).not.toContain('image_url')
  })

  test('真实用户消息紧随其后时原样保留，观察消息排在其前面', async () => {
    const body = await send(
      'deepseek-flash',
      undefined,
      [],
      [
        { role: 'user', content: '看图' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'x', arguments: {} }] },
        { role: 'tool', toolCallId: 'c1', content: [png('QUJD')] },
        { role: 'user', content: '换一张' },
      ],
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user', 'user'])
    expect(messages[3]!.content).toEqual([note, label('c1', '图像 1'), imageUrl('QUJD')])
    expect(messages[4]).toEqual({ role: 'user', content: '换一张' })
  })

  test('视频块同样移到观察消息，保持 video_url 形状', async () => {
    const body = await send(
      'qwen3.7-plus',
      undefined,
      [],
      [
        { role: 'user', content: '看视频' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c_v', name: 'read_file', arguments: {} }],
        },
        {
          role: 'tool',
          toolCallId: 'c_v',
          content: [
            { type: 'text', text: '{"call_id":"c_v"}' },
            { type: 'video', mimeType: 'video/mp4', source: { kind: 'base64', data: 'QUJD' } },
          ],
        },
      ],
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[2]!.content).toBe('{"call_id":"c_v"}\n[视频 1：见本批工具结果之后的观察消息]')
    expect(messages[3]!.content).toEqual([
      note,
      label('c_v', '视频 1'),
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,QUJD' } },
    ])
  })

  test('只有文本块的工具结果保持原形状，不追加观察消息', async () => {
    const body = await send(
      'deepseek-flash',
      undefined,
      [],
      [
        { role: 'user', content: '看' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c_t', name: 'x', arguments: {} }] },
        {
          role: 'tool',
          toolCallId: 'c_t',
          content: [
            { type: 'text', text: '甲' },
            { type: 'text', text: '乙' },
          ],
        },
      ],
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool'])
    expect(messages[2]!.content).toEqual([
      { type: 'text', text: '甲' },
      { type: 'text', text: '乙' },
    ])
  })

  test('纯文本工具结果仍是字符串，不改为发送数组', async () => {
    const omitted = '{"call_id":"c_t","status":"success","images_omitted":true}'
    const body = await send(
      'deepseek-flash',
      undefined,
      [],
      [
        { role: 'user', content: '看' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c_t', name: 'x', arguments: {} }] },
        { role: 'tool', toolCallId: 'c_t', content: omitted },
      ],
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages.find((m) => m.role === 'tool')!.content).toBe(omitted)
  })
})

describe('用户消息带视频', () => {
  test('视频块按原生 video_url Data URL 发送', async () => {
    const body = await send(
      'qwen3.7-plus',
      undefined,
      [],
      [
        {
          role: 'user',
          content: [
            { type: 'video', mimeType: 'video/mp4', source: { kind: 'base64', data: 'QUJD' } },
            { type: 'text', text: '描述视频内容' },
          ],
        },
      ],
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[0]?.content).toEqual([
      { type: 'video_url', video_url: { url: 'data:video/mp4;base64,QUJD' } },
      { type: 'text', text: '描述视频内容' },
    ])
  })

  test('百炼临时 URL 按 video_url 发送', async () => {
    const body = await send(
      'qwen3.8-flash',
      undefined,
      [],
      [
        {
          role: 'user',
          content: [
            {
              type: 'video',
              mimeType: 'video/mp4',
              source: { kind: 'url', url: 'oss://dashscope-instant/example/clip.mp4' },
            },
            { type: 'text', text: '描述视频内容' },
          ],
        },
      ],
    )
    const messages = body.messages as Record<string, unknown>[]
    expect(messages[0]?.content).toEqual([
      {
        type: 'video_url',
        video_url: { url: 'oss://dashscope-instant/example/clip.mp4' },
      },
      { type: 'text', text: '描述视频内容' },
    ])
    // 该模拟服务不是百炼官方域名，不得向任意兼容端点泄露供应商专用请求头。
    expect(requestHeaders[0]?.get('x-dashscope-ossresourceresolve')).toBeNull()
  })
})

describe('OpenCode 会话请求头', () => {
  /**
   * 端点按主机名判定，因此将发往 opencode.ai 的请求转发到本机 server；
   * 断言的仍是真实 HTTP 请求头。SDK 在构造时读取 `globalThis.fetch`，替换必须先于创建适配器。
   */
  async function sendToOpenCode(cacheKeys: (string | undefined)[]): Promise<(string | null)[]> {
    requestHeaders.length = 0
    const realFetch = globalThis.fetch
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      return realFetch(`${base}${url.pathname.replace('/zen/go/v1', '')}`, init)
    }) as typeof fetch
    try {
      const adapter = new OpenAICompatAdapter(
        {
          kind: 'openai_chat_completions',
          apiKey: 'sk-x',
          model: 'deepseek-flash',
          baseUrl: 'https://opencode.ai/zen/go',
        },
        lookupModel('deepseek-flash', 'openai_chat_completions'),
      )
      for (const cacheKey of cacheKeys) {
        for await (const _ of adapter.stream({
          model: 'deepseek-flash',
          system: [],
          messages: [{ role: 'user', content: '嗨' }],
          tools: [],
          maxOutputTokens: 64,
          idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
          ...(cacheKey ? { cacheKey } : {}),
          signal: new AbortController().signal,
        })) {
          // 只检查请求头
        }
      }
    } finally {
      globalThis.fetch = realFetch
    }
    return requestHeaders.map((h) => h.get('x-opencode-session'))
  }

  test('有 cacheKey 时发送会话 id', async () => {
    expect(await sendToOpenCode(['cv_a', 'cv_a'])).toEqual(['cv_a', 'cv_a'])
  })

  /** 检测与压缩摘要不带 cacheKey；端点缺少该请求头时返回 400，因此仍须发送，且同一适配器内保持不变。 */
  test('没有 cacheKey 时发送按适配器生成的同一个值', async () => {
    const [first, second] = await sendToOpenCode([undefined, undefined])
    expect(first).toBeTruthy()
    expect(second).toBe(first!)
  })

  test('其他端点不发送', async () => {
    await send('deepseek-flash')
    expect(requestHeaders[0]?.get('x-opencode-session')).toBeNull()
  })
})

describe('百炼媒体上传', () => {
  test('只在百炼官方端点保留本地路径', () => {
    expect(
      isDashScopeEndpoint('https://llm-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'),
    ).toBe(true)
    expect(isDashScopeEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(true)
    expect(isDashScopeEndpoint('https://dashscope-us.aliyuncs.com/compatible-mode/v1')).toBe(true)
    expect(isDashScopeEndpoint('https://relay.example.com/v1')).toBe(false)
    const official = new OpenAICompatAdapter(
      {
        kind: 'openai_chat_completions',
        apiKey: 'sk-test',
        model: 'qwen3.8-flash',
        baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      },
      lookupModel('qwen3.8-flash', 'openai_chat_completions'),
    )
    expect(official.transmits.mediaPaths).toBe(true)
  })

  test('仅在百炼端点且请求含 oss URI 时添加解析头', () => {
    const request: ChatRequest = {
      model: 'qwen3.8-flash',
      system: [],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'video',
              mimeType: 'video/mp4',
              source: { kind: 'url', url: 'oss://dashscope-instant/test/clip.mp4' },
            },
          ],
        },
      ],
      tools: [],
      maxOutputTokens: 16,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
    }
    expect(dashScopeMediaHeaders(false, request)).toEqual({})
    expect(dashScopeMediaHeaders(true, request)).toEqual({
      'X-DashScope-OssResourceResolve': 'enable',
    })
  })

  /** 3 MB 在端点 7 MB 的内联上限以内，仍须上传：内联的视频按字节计入常驻媒体，下一步即被换出。 */
  test('小文件内联，超过 2 MB 的文件经临时 URL 上传', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-dashscope-media-'))
    const small = join(dir, 'small.mp4')
    const large = join(dir, 'large.mp4')
    await writeFile(small, 'abc')
    await writeFile(large, Buffer.alloc(3 * 1024 * 1024))
    const uploaded: { path: string; size: number }[] = []
    const prepared = await prepareDashScopeMedia(
      {
        model: 'qwen3.8-flash',
        system: [],
        messages: [
          {
            role: 'user',
            content: [
              { type: 'video', mimeType: 'video/mp4', source: { kind: 'path', path: small } },
              { type: 'video', mimeType: 'video/mp4', source: { kind: 'path', path: large } },
            ],
          },
        ],
        tools: [],
        maxOutputTokens: 16,
        idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      },
      async (media) => {
        uploaded.push(media)
        return 'oss://dashscope-instant/test/large.mp4'
      },
    )
    const blocks = prepared.messages[0]?.content
    if (!Array.isArray(blocks)) throw new Error('媒体没有保留内容块')
    expect(blocks[0]).toEqual({
      type: 'video',
      mimeType: 'video/mp4',
      source: { kind: 'base64', data: Buffer.from('abc').toString('base64') },
    })
    expect(blocks[1]).toEqual({
      type: 'video',
      mimeType: 'video/mp4',
      source: { kind: 'url', url: 'oss://dashscope-instant/test/large.mp4' },
    })
    expect(uploaded).toHaveLength(1)
    expect(uploaded[0]).toMatchObject({ path: large, size: 3 * 1024 * 1024 })
  })

  test('按官方凭证表单上传并返回 oss URI', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-dashscope-upload-'))
    const path = join(dir, 'clip.mp4')
    await writeFile(path, 'video-bytes')
    const calls: { url: string; init?: RequestInit }[] = []
    const fetcher = (async (target: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(target), ...(init ? { init } : {}) })
      if (calls.length === 1) {
        return Response.json({
          data: {
            policy: 'policy',
            signature: 'signature',
            upload_dir: 'dashscope-instant/account/session',
            upload_host: 'https://bucket.oss-cn-beijing.aliyuncs.com',
            max_file_size_mb: '100',
            oss_access_key_id: 'temporary-key',
            x_oss_object_acl: 'private',
            x_oss_forbid_overwrite: 'true',
          },
        })
      }
      return new Response('', { status: 200 })
    }) as typeof fetch

    const uri = await uploadDashScopeMedia({
      apiKey: 'sk-test',
      baseUrl: 'https://llm-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
      model: 'qwen3.8-flash',
      path,
      size: 11,
      fetcher,
    })
    expect(calls).toHaveLength(2)
    expect(calls[0]?.url).toBe(
      'https://llm-example.cn-beijing.maas.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3.8-flash',
    )
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: 'Bearer sk-test' })
    expect(calls[1]?.url).toBe('https://bucket.oss-cn-beijing.aliyuncs.com/')
    const form = calls[1]?.init?.body
    if (!(form instanceof FormData)) throw new Error('上传请求不是 multipart form')
    expect(form.get('OSSAccessKeyId')).toBe('temporary-key')
    expect(form.get('success_action_status')).toBe('200')
    const file = form.get('file')
    if (!(file instanceof File)) throw new Error('上传表单缺少文件')
    expect(file.size).toBe(11)
    expect(uri).toMatch(/^oss:\/\/dashscope-instant\/account\/session\/[a-f0-9]{8}-clip\.mp4$/)
  })

  test('凭证中的字符串大小上限在上传前生效', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-dashscope-limit-'))
    const path = join(dir, 'clip.mp4')
    await writeFile(path, 'video-bytes')
    let calls = 0
    const fetcher = (async () => {
      calls++
      return Response.json({
        data: {
          policy: 'policy',
          signature: 'signature',
          upload_dir: 'dashscope-instant/account/session',
          upload_host: 'https://bucket.oss-cn-beijing.aliyuncs.com',
          max_file_size_mb: '0.000001',
          oss_access_key_id: 'temporary-key',
          x_oss_object_acl: 'private',
          x_oss_forbid_overwrite: 'true',
        },
      })
    }) as unknown as typeof fetch

    await expect(
      uploadDashScopeMedia({
        apiKey: 'sk-test',
        baseUrl: 'https://llm-example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.8-flash',
        path,
        size: 11,
        fetcher,
      }),
    ).rejects.toThrow(/0\.000001 MB/)
    expect(calls).toBe(1)
  })

  test('临时文件协议的 1 GB 硬上限在获取凭证前生效', async () => {
    let called = false
    await expect(
      uploadDashScopeMedia({
        apiKey: 'sk-test',
        baseUrl: 'https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1',
        model: 'qwen3.8-flash',
        path: '不用读取的占位路径.mp4',
        size: 1024 * 1024 * 1024 + 1,
        fetcher: (async () => {
          called = true
          throw new Error('不应取凭证')
        }) as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/1 GB/)
    expect(called).toBe(false)
  })
})

describe('DeepSeek 须同时发送两个字段', () => {
  /**
   * 复现原始失败形状：只发送 `reasoning_effort` 时实测「每一档 reasoning_tokens
   * 都相同」，据此会将 DeepSeek 记为「不支持 effort」。现象属实，但归因错误：
   * `thinking` 开关未开启，思考未启动。
   */
  test('thinking 开关与档位同时出现在请求体中', async () => {
    const body = await send('deepseek-flash', 'max')
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('max')
  })

  test('未指定档位时不发送任何字段', async () => {
    const body = await send('deepseek-flash')
    expect('thinking' in body).toBe(false)
    expect('reasoning_effort' in body).toBe(false)
  })
})

describe('OpenAI 参数格式只发送 reasoning_effort', () => {
  test('不带 DeepSeek 的 thinking 开关', async () => {
    const body = await send('gpt-5.6-sol', 'high')
    expect(body.reasoning_effort).toBe('high')
    expect('thinking' in body).toBe(false)
  })

  test('Gemini 同样使用该参数格式', async () => {
    expect((await send('gemini-3.8-flash', 'high')).reasoning_effort).toBe('high')
    expect((await send('gemini-3.1-pro-preview', 'low')).reasoning_effort).toBe('low')
  })
})

describe('逐模型的历史思考协议', () => {
  test('MiMo 回传所有历史思考和标准 JSON 工具调用，忽略旧强度选择', async () => {
    const body = await send(
      'mimo-v2.6-pro',
      'high',
      [
        {
          name: 'read_file',
          description: '读取文件',
          strict: true,
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, limit: { type: 'integer' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      ],
      [
        { role: 'user', content: '开始' },
        { role: 'assistant', content: '计划', reasoningContent: '第一轮思考' },
        { role: 'user', content: '继续' },
        {
          role: 'assistant',
          content: '',
          reasoningContent: '工具轮思考',
          toolCalls: [
            { id: 'c1', name: 'read_file', arguments: { path: 'pelican-bike/index.html' } },
          ],
        },
        { role: 'tool', toolCallId: 'c1', content: '内容' },
      ],
    )
    expect(body.messages).toMatchObject([
      { role: 'user' },
      { role: 'assistant', reasoning_content: '第一轮思考' },
      { role: 'user' },
      {
        role: 'assistant',
        reasoning_content: '工具轮思考',
        tool_calls: [
          {
            id: 'c1',
            function: { name: 'read_file', arguments: '{"path":"pelican-bike/index.html"}' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'c1' },
    ])
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read_file',
          description: '读取文件',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, limit: { type: 'integer' } },
            required: ['path'],
            additionalProperties: false,
          },
        },
      },
    ])
    for (const field of ['thinking', 'reasoning_effort', 'preserve_thinking', 'prompt_cache_key'])
      expect(body).not.toHaveProperty(field)
  })

  const history: WireMessage[] = [
    { role: 'user', content: '第一问' },
    { role: 'assistant', content: '第一答', reasoningContent: '完整思考' },
    { role: 'user', content: '继续' },
  ]

  test('DeepSeek 三档同时发送开关和强度，并保留纯文本轮思考', async () => {
    for (const effort of ['low', 'high', 'max'] as const) {
      const body = await send('deepseek-flash', effort, [], history)
      expect(body.thinking).toEqual({ type: 'enabled' })
      expect(body.reasoning_effort).toBe(effort)
      expect(body.preserve_thinking).toBeUndefined()
      expect((body.messages as Record<string, unknown>[])[1]?.reasoning_content).toBe('完整思考')
    }
  })

  test('Qwen3.8 始终声明保留思考，并发送官方档位', async () => {
    const bare = await send('qwen3.8-flash')
    expect(bare.preserve_thinking).toBe(true)
    expect('reasoning_effort' in bare).toBe(false)

    const xhigh = await send('qwen3.8-flash', 'xhigh')
    expect(xhigh.preserve_thinking).toBe(true)
    expect(xhigh.reasoning_effort).toBe('xhigh')
  })

  test('Qwen3.8 的纯文本历史原样回放 reasoning_content', async () => {
    const body = await send('qwen3.8-flash', 'low', [], history)
    expect((body.messages as Record<string, unknown>[])[1]?.reasoning_content).toBe('完整思考')
  })

  test('Qwen3.8 Omni Flash 的工具结果续轮保留思考与官方档位', async () => {
    const body = await send(
      'qwen3.8-omni-flash',
      'medium',
      [{ name: 'lookup', description: '查询', parameters: { type: 'object' } }],
      [
        { role: 'user', content: '查询' },
        {
          role: 'assistant',
          content: '',
          reasoningContent: '先查询',
          toolCalls: [{ id: 'call_1', name: 'lookup', arguments: {} }],
        },
        { role: 'tool', content: '结果', toolCallId: 'call_1' },
      ],
    )
    expect(body.preserve_thinking).toBe(true)
    expect(body.reasoning_effort).toBe('medium')
    expect(body).not.toHaveProperty('prompt_cache_key')
    expect(body.tools).toMatchObject([{ type: 'function', function: { name: 'lookup' } }])
    expect(body.messages).toMatchObject([
      { role: 'user' },
      { role: 'assistant', reasoning_content: '先查询', tool_calls: [{ id: 'call_1' }] },
      { role: 'tool', tool_call_id: 'call_1', content: '结果' },
    ])
  })

  test('GLM-5.3 Flash 始终保留思考，并可单独选档', async () => {
    const bare = await send('glm-5.3-flash')
    expect(bare.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect('reasoning_effort' in bare).toBe(false)

    const low = await send('glm-5.3-flash', 'low', [], history)
    expect(low.thinking).toEqual({ type: 'enabled', clear_thinking: false })
    expect(low.reasoning_effort).toBe('low')
    expect((low.messages as Record<string, unknown>[])[1]?.reasoning_content).toBe('完整思考')
  })

  test('未单独适配的模型的请求形状不变', async () => {
    const body = await send('gpt-5.6-sol', 'high', [], history)
    expect('preserve_thinking' in body).toBe(false)
    expect(body.thinking).toBeUndefined()
    expect((body.messages as Record<string, unknown>[])[1]?.reasoning_content).toBeUndefined()
  })
})

/**
 * 档位不在该模型的可用档位中时，不发送任何字节。
 *
 * 另两种协议的写法：`openai-responses` 为
 * `effortLevels.includes(req.effort) ? … : undefined`，`anthropic` 同样省略越界档位。
 * 本协议不要只判断「是否指定」就将 `effort` 原样发送。
 *
 * 只使用单一模型时可用档位固定，无需此项检查；本仓库并非如此：档位选定值记录在
 * 「接口 × 模型」对应的配置中，同一模型更换协议后可用档位即变化，Agent Team 的各角色
 * 也各自使用不同的模型。此处不拦截越界值时，provider 返回 400。
 */
describe('越界的档位不发送', () => {
  /** DeepSeek 声明 low/high/max；`xhigh` 是 high 的映射值，不作为独立档位发送。 */
  test('DeepSeek 不会收到 xhigh', async () => {
    const body = await send('deepseek-flash', 'xhigh')
    expect('thinking' in body).toBe(false)
    expect('reasoning_effort' in body).toBe(false)
  })

  /** Gemini 只有 low/medium/high，`max` 同样越界。 */
  test('Gemini 不会收到 max', async () => {
    expect('reasoning_effort' in (await send('gemini-3.1-pro', 'max'))).toBe(false)
  })

  /** 可用档位照常发送：此项检查只拦截越界档位，不关闭整个 effort。 */
  test('可用档位照常发送', async () => {
    const body = await send('deepseek-flash', 'high')
    expect(body.thinking).toEqual({ type: 'enabled' })
    expect(body.reasoning_effort).toBe('high')
  })
})

describe('不应发送时不发送任何多余字节', () => {
  /**
   * 自建端点与中转站的模型不在目录中，`unknownModel()` 的 `thinking` 为 `'none'`。
   * 本用例锁定：兼容协议按模型发送思考字段时，
   * 这些端点不收到未知的键，否则原本正常的请求会返回 400。
   */
  test('未收录的模型不发送思考字段', async () => {
    const body = await send('某个中转站上的模型', 'max')
    expect('reasoning_effort' in body).toBe(false)
    expect('thinking' in body).toBe(false)
  })

  /** 默认思考但没有命名 effort 档位的模型，不得原样发送其他厂商的档位。 */
  test('没有命名档位的模型不发送 reasoning_effort', async () => {
    const body = await send('qwen3.7-max', 'high')
    expect('reasoning_effort' in body).toBe(false)
  })

  /**
   * 经中转站以兼容协议调用 Claude：`lookupModel` 的回退会保留 Claude 的能力约束，
   * 只改写 provider，因此 `effortLevels` 仍为五档。但 Anthropic 的
   * `output_config.effort` 无法经由本协议发送，因此不应发送任何思考字段。
   */
  test('经中转站调用的 Claude 不发送 Anthropic 的思考字段', async () => {
    const body = await send('claude-opus-5', 'high')
    expect('reasoning_effort' in body).toBe(false)
    expect('thinking' in body).toBe(false)
    expect('output_config' in body).toBe(false)
  })
})

/**
 * Base URL 归一。
 *
 * 已复现的故障：用户填写 `https://中转站/`（缺少 `/v1`），SDK 因此请求
 * `https://中转站/chat/completions`，中转站对该错误路径返回 200 与 HTML 首页。
 * 解析器无法读取任何 chunk 且不报错，该轮记为 0 token、0 步骤、`completed`，
 * 消息已发送而没有任何输出。
 */
describe('Base URL 归一', () => {
  test('缺少 /v1 时补充', () => {
    expect(normalizeBaseUrl('https://direct.example.xyz/')).toBe('https://direct.example.xyz/v1')
    expect(normalizeBaseUrl('https://direct.example.xyz')).toBe('https://direct.example.xyz/v1')
  })

  test('已带版本段时保持原样，不重复追加 /v1', () => {
    expect(normalizeBaseUrl('https://api.deepseek.com/v1')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1')
    expect(normalizeBaseUrl('https://open.bigmodel.cn/api/paas/v4')).toBe(
      'https://open.bigmodel.cn/api/paas/v4',
    )
    expect(normalizeBaseUrl('https://relay.example/v27/')).toBe('https://relay.example/v27')
  })

  test('空值使用官方根地址', () => {
    expect(normalizeBaseUrl(undefined)).toBe('https://api.openai.com/v1')
    expect(normalizeBaseUrl('   ')).toBe('https://api.openai.com/v1')
  })
})

describe('无名工具调用', () => {
  /**
   * 复现原始失败形状：中转站丢失了工具名所在的分片，若以 `continue` 跳过整条调用，
   * provider 报告 `tool_calls` 而解析结果为零，run 记为正常完成，账本中没有记录。
   *
   * 此处断言显式失败：不允许出现「静默缺少一条调用」的中间状态。
   */
  test('工具名分片不完整时报错，不静默丢弃', async () => {
    const drop = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          // 只有 id 与参数，始终没有 function.name。
          [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1",' +
              '"function":{"arguments":"{}"}}]},"finish_reason":null}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
            'data: [DONE]',
            '',
          ].join('\n\n'),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    })
    try {
      const adapter = new OpenAICompatAdapter(
        {
          kind: 'openai_chat_completions',
          apiKey: 'sk-x',
          model: 'deepseek-flash',
          baseUrl: `http://127.0.0.1:${drop.port}/v1`,
        },
        lookupModel('deepseek-flash', 'openai_chat_completions'),
      )
      const run = async () => {
        for await (const _ of adapter.stream({
          model: 'deepseek-flash',
          system: [],
          messages: [{ role: 'user', content: 'hi' }],
          tools: [],
          maxOutputTokens: 64,
          idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        })) {
          // 只检查是否抛出，不检查事件本身。
        }
      }
      expect(run()).rejects.toThrow(/工具调用缺少名称/)
    } finally {
      drop.stop(true)
    }
  })
})

describe('缓存路由字段', () => {
  /**
   * 复现一次实测记录：同一中转站的 grok，前缀逐字节稳定（已由字节级测试证明），
   * 命中量却在 192 与 16576 之间波动，随后整段会话不再返回 `cached_tokens` 字段。
   *
   * 成因是中转站在多个上游节点之间轮询，而隐式前缀缓存按分片存储；
   * 不带 `prompt_cache_key` 时每次随机分配到一个分片。`openai-responses` 同样发送该字段；
   * 各中转站均使用本路径，因此本路径不得遗漏。
   *
   * 断言的是实际发送的字节：装配层填入取值不足以证明，须确认其出现在请求体中。
   */
  test('cacheKey 写入请求体中的 prompt_cache_key', async () => {
    bodies.length = 0
    requestHeaders.length = 0
    const adapter = new OpenAICompatAdapter(
      {
        kind: 'openai_chat_completions',
        apiKey: 'sk-x',
        model: 'gpt-5.6-sol',
        baseUrl: base,
      },
      lookupModel('gpt-5.6-sol', 'openai_chat_completions'),
    )
    for await (const _ of adapter.stream({
      model: 'gpt-5.6-sol',
      system: [],
      messages: [{ role: 'user', content: '嗨' }],
      tools: [],
      maxOutputTokens: 64,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      cacheKey: 'cv_0mt0x92q10000mx0dff',
      signal: new AbortController().signal,
    })) {
      // 只检查请求体
    }
    expect(bodies[0]!.prompt_cache_key).toBe('cv_0mt0x92q10000mx0dff')
    expect(requestHeaders[0]?.get('x-grok-conv-id')).toBeNull()
  })

  /** xAI 将同一缓存路由字段放在 Chat Completions 的请求头中；body 字段仅属于 Responses。 */
  test('Grok cacheKey 只写入 x-grok-conv-id 请求头', async () => {
    bodies.length = 0
    requestHeaders.length = 0
    const adapter = new OpenAICompatAdapter(
      {
        kind: 'openai_chat_completions',
        apiKey: 'sk-x',
        model: 'grok-4.6',
        baseUrl: base,
      },
      lookupModel('grok-4.6', 'openai_chat_completions'),
    )
    for await (const _ of adapter.stream({
      model: 'grok-4.6',
      system: [],
      messages: [{ role: 'user', content: '嗨' }],
      tools: [],
      maxOutputTokens: 64,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      cacheKey: 'cv_grok_1',
      signal: new AbortController().signal,
    })) {
      // 只检查真实 HTTP 请求
    }
    expect(requestHeaders[0]?.get('x-grok-conv-id')).toBe('cv_grok_1')
    expect('prompt_cache_key' in bodies[0]!).toBe(false)
  })

  /** 没有 cacheKey 时不发送任何字节：自建端点不得收到未知字段。 */
  test('没有 cacheKey 时不出现该字段', async () => {
    const body = await send('deepseek-flash')
    expect('prompt_cache_key' in body).toBe(false)
  })

  test('Grok 没有 cacheKey 时不虚构请求头', async () => {
    const body = await send('grok-4.6')
    expect('prompt_cache_key' in body).toBe(false)
    expect(requestHeaders[0]?.get('x-grok-conv-id')).toBeNull()
  })

  /**
   * 是否发送由目录中该模型的条目决定，而不是由协议决定。
   *
   * 未收录的模型（自建端点、中转站上未补录的模型名）取 `cacheRouting: 'none'`，
   * 含义是「未经测定」而非「不支持」。向这些端点发送未知字段，会使此前正常的请求
   * 全部返回 400。需要开启时在模型库的对应字段明确填写。
   */
  test('未收录的模型不发送缓存路由字段', async () => {
    bodies.length = 0
    const model = '某个中转站上的模型'
    const spec = lookupModel(model, 'openai_chat_completions')
    expect(spec.cacheRouting).toBe('none')
    const adapter = new OpenAICompatAdapter(
      { kind: 'openai_chat_completions', apiKey: 'sk-x', model, baseUrl: base },
      spec,
    )
    for await (const _ of adapter.stream({
      model,
      system: [],
      messages: [{ role: 'user', content: '嗨' }],
      tools: [],
      maxOutputTokens: 64,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      cacheKey: 'cv_x',
      signal: new AbortController().signal,
    })) {
      // 只检查请求体
    }
    expect('prompt_cache_key' in bodies[0]!).toBe(false)
  })

  test('Qwen3.8 与 GLM-5.3 使用各自的隐式缓存协议，不混入 OpenAI 路由键', async () => {
    for (const model of ['qwen3.8-flash', 'glm-5.3-flash']) {
      bodies.length = 0
      const spec = lookupModel(model, 'openai_chat_completions')
      expect(spec.cacheRouting).toBe('none')
      const adapter = new OpenAICompatAdapter(
        { kind: 'openai_chat_completions', apiKey: 'sk-x', model, baseUrl: base },
        spec,
      )
      for await (const _ of adapter.stream({
        model,
        system: [],
        messages: [{ role: 'user', content: '嗨' }],
        tools: [],
        maxOutputTokens: 64,
        idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        cacheKey: 'cv_should_not_cross_protocols',
        signal: new AbortController().signal,
      })) {
        // 只检查请求体。
      }
      expect('prompt_cache_key' in bodies[0]!).toBe(false)
    }
  })
})

describe('正文中的思考标签', () => {
  /** SSE 的事件分隔符是两个换行。写为常量而不是字面量：源码中的两个空行难以辨认。 */
  const SEP = String.fromCharCode(10, 10)

  /** 输入一组分片，汇总为两个通道各自的全文。 */
  function feed(chunks: string[]): { thinking: string; text: string } {
    const sp = createThinkingSplitter()
    let thinking = ''
    let text = ''
    for (const c of chunks) {
      const r = sp.push(c)
      thinking += r.thinking
      text += r.text
    }
    text += sp.flush()
    return { thinking, text }
  }

  /**
   * 复现原始形状：会话 `cv_0mt10yhy20000vace5y` 的 step 32、43、57。
   * 中转站将一部分推理摘要放入 `content` 并自行添加了标签。
   */
  test('开头的成对标签整块判定为思考，其后的正文仍为正文', () => {
    expect(feed(['<thinking>**Updating inspection checklist**</thinking>'])).toEqual({
      thinking: '**Updating inspection checklist**',
      text: '',
    })
    expect(feed(['<thinking>**Finalizing summary**</thinking>项目检查已经完成'])).toEqual({
      thinking: '**Finalizing summary**',
      text: '项目检查已经完成',
    })
  })

  /** 标签在任意位置被切分都须识别：SSE 分片边界与内容无关。 */
  test('标签跨分片切分时仍能识别', () => {
    expect(feed(['<thin', 'king>', '想', '一', '</think', 'ing>说'])).toEqual({
      thinking: '想一',
      text: '说',
    })
  })

  /**
   * 这是本函数最重要的边界：放宽识别范围会将模型正当输出的字面量从正文中移除。
   * 只识别从第 0 个字符开始的一处，之后无论出现多少次都属于正文。
   */
  test('不在开头的相同字符串保留在正文中', () => {
    expect(feed(['这段代码会输出 <thinking>x</thinking> 标签'])).toEqual({
      thinking: '',
      text: '这段代码会输出 <thinking>x</thinking> 标签',
    })
    // 识别一次之后不再识别，第二个块属于正文。
    expect(feed(['<thinking>一</thinking>正文 <thinking>二</thinking>'])).toEqual({
      thinking: '一',
      text: '正文 <thinking>二</thinking>',
    })
  })

  /** 误判的最坏结果只能是「显示在错误的区域」，不能是内容丢失。 */
  test('流在闭合之前结束时，已累积的内容连同起始标签原样退回正文', () => {
    expect(feed(['<thinking>没等到闭合就断了'])).toEqual({
      thinking: '',
      text: '<thinking>没等到闭合就断了',
    })
    expect(feed(['<thin'])).toEqual({ thinking: '', text: '<thin' })
  })

  /** 接入同样须测试：纯函数正确但未接入适配器时，结果与未修复相同。 */
  test('适配器实际按两个通道分发', async () => {
    const sse = (payload: string) => `data: ${payload}${SEP}`
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          sse('{"choices":[{"delta":{"content":"<thinking>想"},"finish_reason":null}]}') +
            sse('{"choices":[{"delta":{"content":"法</thinking>答案"},"finish_reason":null}]}') +
            sse('{"choices":[{"delta":{},"finish_reason":"stop"}]}') +
            sse('[DONE]'),
          { headers: { 'content-type': 'text/event-stream' } },
        ),
    })
    try {
      const model = 'gpt-5.6-terra'
      const adapter = new OpenAICompatAdapter(
        {
          kind: 'openai_chat_completions',
          apiKey: 'sk-x',
          model,
          baseUrl: `http://127.0.0.1:${server.port}/v1`,
        },
        lookupModel(model, 'openai_chat_completions'),
      )
      let thinking = ''
      let text = ''
      for await (const ev of adapter.stream({
        model,
        system: [],
        messages: [{ role: 'user', content: '嗨' }],
        tools: [],
        maxOutputTokens: 64,
        idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        signal: new AbortController().signal,
      })) {
        if (ev.type === 'thinking_delta') thinking += ev.delta
        if (ev.type === 'text_delta') text += ev.delta
      }
      expect(thinking).toBe('想法')
      expect(text).toBe('答案')
    } finally {
      server.stop(true)
    }
  })
})

describe('strict 工具定义', () => {
  const readFile: ToolSchema = {
    name: 'read_file',
    description: '读文件',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '工作区相对路径' },
        offset: { type: 'integer', description: '起始行号（1 起），默认 1' },
        limit: { type: 'integer', description: '最多读取行数' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    strict: true,
  }

  /**
   * 复现原始失败形状：非 strict 模式下模型将 `offset` 返回为字符串
   * （实测 grok-4.6 三次采样均为 `"1.0"`，其中一次还将工具模板混入取值），
   * `read_file` 因此读取 0 行却报告 success。
   *
   * strict 的两条硬性要求缺少任一条即等于未开启：只添加标志位而保留可选属性时，端点静默降级。
   * 因此此处两条均断言：可选属性列入 `required`，类型中补充 `null`。
   */
  test('可选属性列入 required，类型中补充 null', () => {
    const out = strictify(readFile.parameters)
    expect(out.required).toEqual(['path', 'offset', 'limit'])
    expect(out.additionalProperties).toBe(false)
    const props = out.properties as Record<string, Record<string, unknown>>
    expect(props.path?.type).toBe('string')
    expect(props.offset?.type).toEqual(['integer', 'null'])
    expect(props.limit?.type).toEqual(['integer', 'null'])
    // 描述原样保留：模型依据描述了解参数的用途。
    expect(props.offset?.description).toBe('起始行号（1 起），默认 1')
  })

  test('可选枚举允许 null，必填枚举仍只接受原值且不改写原始 schema', () => {
    const schema = {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['wheel', 'click'] },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        step: { type: 'string', enum: ['line', 'page', null] },
      },
      required: ['action'],
    }
    const original = structuredClone(schema)
    const converted = strictify(schema)
    const props = converted.properties as Record<string, Record<string, unknown>>
    expect(props.button?.enum).toEqual(['left', 'right', 'middle', null])
    expect(props.step?.enum).toEqual(['line', 'page', null])
    expect(props.action?.enum).toEqual(['wheel', 'click'])
    expect(schema).toEqual(original)
    expect(strictify(converted)).toEqual(converted)
  })

  test('数组的 items 同样转换，嵌套对象同样补齐 required', () => {
    const out = strictify({
      type: 'object',
      properties: {
        todos: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              content: { type: 'string' },
              note: { type: 'string' },
              state: { type: 'string', enum: ['off', 'on'] },
            },
            required: ['content'],
          },
        },
      },
      required: ['todos'],
    })
    const items = (out.properties as Record<string, Record<string, unknown>>).todos
      ?.items as Record<string, unknown>
    expect(items.required).toEqual(['content', 'note', 'state'])
    expect(items.additionalProperties).toBe(false)
    const inner = items.properties as Record<string, Record<string, unknown>>
    expect(inner.note?.type).toEqual(['string', 'null'])
    expect(inner.state?.enum).toEqual(['off', 'on', null])
  })

  test('相同输入产生相同输出，这是前缀缓存的前提', () => {
    expect(JSON.stringify(strictify(readFile.parameters))).toBe(
      JSON.stringify(strictify(readFile.parameters)),
    )
  })

  test('请求体中带 strict，且发送重排后的 schema', async () => {
    const body = await send('deepseek-flash', undefined, [readFile])
    const tool = (body.tools as { function: Record<string, unknown> }[])[0]!.function
    expect(tool.strict).toBe(true)
    expect((tool.parameters as Record<string, unknown>).required).toEqual([
      'path',
      'offset',
      'limit',
    ])
  })

  /**
   * GLM-5.3 Flash 与 Grok 4.6 的真实失败形状相同：适配器将可选的 `probe_url` 改为
   * required + nullable 后，模型被迫为其虚构取值。两家厂商的官方文档均采用标准 JSON Schema 的
   * required/optional 形状，因此只对映射声明为 native 的模型保留注册表原样。
   */
  test('GLM 与 Grok 不使用 OpenAI strict，可选属性仍可省略', async () => {
    for (const model of ['glm-5.3', 'glm-5.3-flash', 'grok-4.5', 'grok-4.6']) {
      const body = await send(model, undefined, [readFile])
      const tool = (body.tools as { function: Record<string, unknown> }[])[0]!.function
      expect(tool.strict).toBeUndefined()
      expect((tool.parameters as Record<string, unknown>).required).toEqual(['path'])
      const props = (tool.parameters as { properties: Record<string, Record<string, unknown>> })
        .properties
      expect(props.offset?.type).toBe('integer')
      expect(props.limit?.type).toBe('integer')
    }
  })

  /**
   * 第三方 schema 原样发送，不修改任何字节。
   *
   * 修改第三方 schema 后，模型按修改后的形状传参，server 按原形状校验，
   * 两者不一致；schema 是否恰好合格不构成修改理由，判据是由谁编写。
   */
  test('strict 为假的工具原样发送，不带标志位也不重排', async () => {
    const third: ToolSchema = {
      name: 'mcp_thing',
      description: '第三方',
      parameters: { type: 'object', properties: { a: { type: 'string' } }, required: [] },
      strict: false,
    }
    const body = await send('grok-4.6', undefined, [third])
    const tool = (body.tools as { function: Record<string, unknown> }[])[0]!.function
    expect('strict' in tool).toBe(false)
    expect(tool.parameters).toEqual(third.parameters)
  })
})

describe('运行上下文的发送形状', () => {
  test('上下文并入所属的真实用户消息，不增加 system 或 user 轮次', async () => {
    bodies.length = 0
    const model = 'deepseek-flash'
    const adapter = new OpenAICompatAdapter(
      { kind: 'openai_chat_completions', apiKey: 'sk-x', model, baseUrl: base },
      lookupModel(model, 'openai_chat_completions'),
    )
    for await (const _ of adapter.stream({
      model,
      system: [{ text: '冻结前缀', cacheBreakpoint: true }],
      messages: [
        { role: 'context', content: '## 当前待办清单\n1. [进行中] 建模' },
        { role: 'user', content: '嗨' },
      ],
      tools: [],
      maxOutputTokens: 64,
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      signal: new AbortController().signal,
    })) {
      // 只检查请求体
    }
    const messages = bodies[0]!.messages as { role: string; content: string }[]
    expect(messages.filter((m) => m.role === 'system')).toHaveLength(1)
    expect(messages[0]).toEqual({ role: 'system', content: '冻结前缀' })
    expect(messages.at(-1)).toEqual({
      role: 'user',
      content: '## 当前待办清单\n1. [进行中] 建模\n\n嗨',
    })
    expect(messages).toHaveLength(2)
  })
})

describe('连接', () => {
  test('每次请求都声明不复用连接', async () => {
    await send('deepseek-flash')
    // 中转站会关闭空闲的 keep-alive 连接，复用旧连接的下一次请求会立即断开或持续无响应。
    expect(requestHeaders[0]?.get('connection')).toBe('close')
  })
})
