/**
 * 图像块的两种形态。
 *
 * 覆盖范围：`loop.ts` 的 `toolResultContent` / `materialize` / `breakdownOf` 的
 * tool 分支，以及 `compaction.ts` 的 `condenseMessage` 对块数组的处置。
 *
 * 这一组盯着三个**完全静默**的方向：图片跨轮变成两种形状、收纳收不掉图、
 * 以及附件的 base64 被回写进 transcript。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContentBlock, WireMessage } from '@qywork/ai'
import { condenseMessage } from './compaction.ts'
import { envelopeResult, materialize, toolResultContent } from './loop.ts'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

async function fixture(): Promise<{ path: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-img-'))
  const path = join(dir, 'shot.png').replaceAll('\\', '/')
  await writeFile(path, PNG)
  return { path }
}

const envelope = JSON.stringify({
  call_id: 'c1',
  tool: 'read_file',
  status: 'success',
  executed: true,
  summary: '读取 shot.png（图片）',
  result: { lines: 1 },
})

const req = (messages: WireMessage[]) => ({ model: 'm', system: [], messages, tools: [] }) as never
const media = (image: boolean | null, video = false) => ({ image, video })

describe('工具结果里的图像块', () => {
  test('没有 images 时仍然是纯字符串', () => {
    expect(toolResultContent(envelope, { lines: 3 })).toBe(envelope)
  })

  /**
   * 有图时是**两块**：信封那一块逐字不变。
   *
   * 信封被改动的话，量账（`breakdownOf`）与收纳（`condenseMessage`）都靠解析它
   * 认路，两者会同时失效——而它们失效不会有任何报错。
   */
  test('有图时信封逐字不变，图片并列成第二块', () => {
    const out = toolResultContent(envelope, { images: [{ data: 'QUJD', mime: 'image/png' }] })
    expect(Array.isArray(out)).toBe(true)
    const blocks = out as ContentBlock[]
    expect(blocks[0]).toEqual({ type: 'text', text: envelope })
    expect(blocks[1]).toEqual({
      type: 'image',
      mimeType: 'image/png',
      source: { kind: 'base64', data: 'QUJD' },
    })
  })

  /**
   * **几张就是几块。**
   *
   * MCP 一次调用带回一组截图是常规用法。取第一张就是把其余的静默丢掉——
   * 而那正是这一整轮改动在收拾的那类毛病。
   */
  test('多张图各成一块，一张都不丢', () => {
    const out = toolResultContent(envelope, {
      images: [
        { data: 'QQ==', mime: 'image/png' },
        { data: 'Qg==', mime: 'image/jpeg' },
        { data: 'Qw==', mime: 'image/webp' },
      ],
    }) as ContentBlock[]
    expect(out.length).toBe(4)
    expect(out.slice(1).map((b) => (b.type === 'image' ? b.mimeType : ''))).toEqual([
      'image/png',
      'image/jpeg',
      'image/webp',
    ])
  })

  /**
   * **图像字节不许进信封。**
   *
   * 信封是一段 JSON 文本。字节留在里面的话同一份 base64 会在请求体里出现两次——
   * 一次在图像块、一次在信封文本，而后者对模型毫无用处，只是照价计费。
   */
  test('信封里摘掉图像字节，其余字段留着', () => {
    expect(envelopeResult({ images: [{ data: 'QUJD', mime: 'image/png' }], lines: 1 })).toEqual({
      lines: 1,
    })
    // 摘完什么都不剩就整个不出现，而不是留一个空对象。
    expect(envelopeResult({ images: [{ data: 'QUJD', mime: 'image/png' }] })).toBeUndefined()
    // 没有图的结果原样返回。
    expect(envelopeResult({ lines: 3 })).toEqual({ lines: 3 })
  })
})

describe('materialize', () => {
  /**
   * **产副本，绝不回写。**
   *
   * 重试循环复用同一个 `messages` 数组，而 `payloadHash` 在每次尝试发出之前就落账。
   * 原地改的话第二次尝试会对同一份内容算出不同的哈希，而那个字段的职责是
   * 「认出同一份内容发了两遍」。
   */
  test('不改原对象，原消息仍是 path 形态', async () => {
    const { path } = await fixture()
    const original: WireMessage[] = [
      {
        role: 'tool',
        toolCallId: 'c1',
        content: [
          { type: 'text', text: envelope },
          { type: 'image', mimeType: 'image/png', source: { kind: 'path', path } },
        ],
      },
    ]
    const out = await materialize(req(original), media(true))
    const before = original[0]!.content as ContentBlock[]
    expect(before[1]).toMatchObject({ source: { kind: 'path' } })
    const after = out.messages[0]!.content as ContentBlock[]
    expect(after[1]).toMatchObject({ source: { kind: 'base64', data: PNG.toString('base64') } })
  })

  /** 全是字符串时原样返回，不白拷一遍。 */
  test('没有内容块时原对象直接返回', async () => {
    const r = req([{ role: 'user', content: '你好' }])
    expect(await materialize(r, media(true))).toBe(r)
  })

  /** 文件没了同样是终态，不抛——一张图发不出去不该让整轮起不来。 */
  test('文件不存在时换成一句话', async () => {
    const out = await materialize(
      req([
        {
          role: 'tool',
          toolCallId: 'c1',
          content: [
            { type: 'image', mimeType: 'image/png', source: { kind: 'path', path: '/nope/x.png' } },
          ],
        },
      ]),
      media(true),
    )
    const blocks = out.messages[0]!.content as ContentBlock[]
    expect((blocks[0] as { text: string }).text).toContain('已不存在')
  })

  /**
   * 原始失败形状：模型不收图片，请求体里却带着图像块，端点回 400。
   *
   * 三种来源在同一处收口——用户附件（path 形态）、工具与 MCP 返回的图（base64
   * 形态）、以及换模型之前留在历史里的旧图。锁的是**请求体里一个图像块都没有**，
   * 且换上的那句话模型看得见。
   */
  test('模型不收图片：图像块换成文本注记，两种来源都覆盖', async () => {
    const { path } = await fixture()
    const out = await materialize(
      req([
        {
          role: 'user',
          content: [
            { type: 'text', text: '看这张' },
            { type: 'image', mimeType: 'image/png', source: { kind: 'path', path } },
          ],
        },
        {
          role: 'tool',
          toolCallId: 'c1',
          content: [
            { type: 'text', text: envelope },
            {
              type: 'image',
              mimeType: 'image/png',
              source: { kind: 'base64', data: PNG.toString('base64') },
            },
          ],
        },
      ]),
      media(false),
    )
    const all = out.messages.flatMap((m) => m.content as ContentBlock[])
    expect(all.some((b) => b.type === 'image')).toBe(false)
    const texts = all.filter((b) => b.type === 'text').map((b) => b.text)
    expect(texts.some((t) => t.includes('当前模型不接受图片输入'))).toBe(true)
  })

  /** `null` 是「厂商规格页没写」，不是「不支持」——照常发。 */
  test('没有出处时照常发图片', async () => {
    const { path } = await fixture()
    const out = await materialize(
      req([
        {
          role: 'user',
          content: [{ type: 'image', mimeType: 'image/png', source: { kind: 'path', path } }],
        },
      ]),
      media(null),
    )
    const blocks = out.messages[0]!.content as ContentBlock[]
    expect(blocks[0]).toMatchObject({ source: { kind: 'base64' } })
  })

  test('支持视频时只在请求副本中读取路径', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-video-'))
    const path = join(dir, 'clip.mp4').replaceAll('\\', '/')
    const bytes = Buffer.from('native-video')
    await writeFile(path, bytes)
    const original: WireMessage[] = [
      {
        role: 'user',
        content: [{ type: 'video', mimeType: 'video/mp4', source: { kind: 'path', path } }],
      },
    ]

    const out = await materialize(req(original), media(true, true))
    expect((original[0]!.content as ContentBlock[])[0]).toMatchObject({
      source: { kind: 'path', path },
    })
    expect((out.messages[0]!.content as ContentBlock[])[0]).toMatchObject({
      type: 'video',
      source: { kind: 'base64', data: bytes.toString('base64') },
    })
  })

  test('模型或适配器不支持视频时不发送视频块', async () => {
    const out = await materialize(
      req([
        {
          role: 'user',
          content: [
            {
              type: 'video',
              mimeType: 'video/mp4',
              source: { kind: 'base64', data: 'QUJD' },
            },
          ],
        },
      ]),
      media(true, false),
    )
    const blocks = out.messages[0]!.content as ContentBlock[]
    expect(blocks.some((b) => b.type === 'video')).toBe(false)
    expect(blocks[0]).toMatchObject({ type: 'text' })
  })
})

describe('收纳', () => {
  /**
   * 带图的工具结果**必须收得掉**。
   *
   * 走「非字符串原样放行」的话，一张几 MB 的截图会在此后每一轮
   * 满额重放，直到撞窗——而收纳的整个用途就是把大段正文换成一句话。
   */
  test('丢掉图像块，只留收好的信封', () => {
    const m: WireMessage = {
      role: 'tool',
      toolCallId: 'c1',
      content: [
        { type: 'text', text: envelope },
        { type: 'image', mimeType: 'image/png', source: { kind: 'path', path: '/tmp/a.png' } },
      ],
    }
    const out = condenseMessage(m)
    expect(typeof out.content).toBe('string')
    const env = JSON.parse(out.content as string) as Record<string, unknown>
    expect(env.call_id).toBe('c1')
    // 正文被换成标记，模型仍能靠信封里的定位符重新取。
    expect(env.result_omitted).toBe(true)
    expect(env.result).toBeUndefined()
    // 图像被丢必须留痕：收纳后的信封与新鲜成功信封同形，缺这一位模型会把图当成仍然可见。
    expect(env.images_omitted).toBe(true)
  })

  test('图像省略标记在再收纳时逐字保留', () => {
    const m: WireMessage = {
      role: 'tool',
      toolCallId: 'c1',
      content: [
        { type: 'text', text: envelope },
        { type: 'image', mimeType: 'image/png', source: { kind: 'path', path: '/tmp/a.png' } },
      ],
    }
    const once = condenseMessage(m)
    const twice = condenseMessage(once)
    expect(twice.content).toBe(once.content)
    expect((JSON.parse(twice.content as string) as Record<string, unknown>).images_omitted).toBe(
      true,
    )
  })
})
