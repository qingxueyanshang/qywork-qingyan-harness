/**
 * 图像块的两种形态。
 *
 * 覆盖范围：`loop/request.ts` 的 `toolResultContent` / `materialize` / `breakdownOf` 的
 * tool 分支、`mediaBytes` / `evictedMedia` / `omitImages` 的按字节预算换出，以及
 * `compaction.ts` 的 `condenseMessage` 对块数组的处置。
 *
 * 这一组盯着三个**完全静默**的方向：图片跨轮变成两种形状、收纳收不掉图、
 * 以及附件的 base64 被回写进 transcript。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ContentBlock, WireMessage } from '@qywork/ai'
import { condenseMessage, IMAGES_OMITTED } from '../compaction.ts'
import {
  ATTACHMENT_MEDIA_OMITTED,
  envelopeResult,
  evictedMedia,
  MEDIA_RETAIN_HIGH_BYTES,
  MEDIA_RETAIN_LOW_BYTES,
  materialize,
  mediaBytes,
  omitImages,
  toolResultContent,
  videoDelivery,
} from './request.ts'

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
const media = (image: boolean | null, video = false, mediaPaths = false) => ({
  image,
  video,
  mediaPaths,
})

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

  /** 常驻上限以内的视频整份内联进请求副本，首尾字节不变。 */
  test('常驻上限以内的本地视频整份进入请求副本', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-video-large-'))
    const path = join(dir, 'clip.mp4').replaceAll('\\', '/')
    const bytes = Buffer.alloc(MEDIA_RETAIN_HIGH_BYTES)
    bytes[0] = 7
    bytes[bytes.length - 1] = 9
    await writeFile(path, bytes)

    const out = await materialize(
      req([
        {
          role: 'user',
          content: [{ type: 'video', mimeType: 'video/mp4', source: { kind: 'path', path } }],
        },
      ]),
      media(true, true),
    )
    const block = (out.messages[0]!.content as ContentBlock[])[0]
    expect(block).toMatchObject({ type: 'video', source: { kind: 'base64' } })
    if (block?.type !== 'video' || block.source.kind !== 'base64') throw new Error('视频未物化')
    const decoded = Buffer.from(block.source.data, 'base64')
    expect(decoded.byteLength).toBe(bytes.length)
    expect(decoded[0]).toBe(7)
    expect(decoded[decoded.length - 1]).toBe(9)
  })

  test('支持路径媒体的适配器接收原路径', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-video-path-'))
    const path = join(dir, 'clip.mp4').replaceAll('\\', '/')
    await writeFile(path, 'video')
    const out = await materialize(
      req([
        {
          role: 'user',
          content: [{ type: 'video', mimeType: 'video/mp4', source: { kind: 'path', path } }],
        },
      ]),
      media(true, true, true),
    )
    expect((out.messages[0]?.content as ContentBlock[])[0]).toEqual({
      type: 'video',
      mimeType: 'video/mp4',
      source: { kind: 'path', path },
    })
  })

  /** 用户附件的视频是路径块：不收原生视频、收图片的模型由说明指向 read_file 抽帧，不另做一套。 */
  /** 收原生视频但不能上传：超过常驻上限的视频内联进去下一步就被换出，换成指向 read_file 抽帧的说明。 */
  test('收原生视频、超过常驻上限又不能上传：换成说明；能上传时交出路径', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-video-big-'))
    const path = join(dir, 'big.mp4').replaceAll('\\', '/')
    await writeFile(path, new Uint8Array(6 * 1024 * 1024))
    const send = (caps: Parameters<typeof materialize>[1]) =>
      materialize(
        req([
          {
            role: 'user',
            content: [{ type: 'video', mimeType: 'video/mp4', source: { kind: 'path', path } }],
          },
        ]),
        caps,
      ).then((out) => (out.messages[0]?.content as ContentBlock[])[0])
    const inline = (await send({ image: true, video: true })) as { type: string; text: string }
    expect(inline.type).toBe('text')
    expect(inline.text).toContain('6.0 MB')
    expect(inline.text).toContain('read_file')
    expect(
      await send({ image: true, video: true, mediaPaths: true, mediaUploadAbove: 2 * 1024 * 1024 }),
    ).toEqual({ type: 'video', mimeType: 'video/mp4', source: { kind: 'path', path } })
  })

  test('不收原生视频、收图片：路径视频换成指向 read_file 的说明', async () => {
    const path = '/ws/clip.mp4'
    const block = (image: boolean | null) =>
      materialize(
        req([
          {
            role: 'user',
            content: [{ type: 'video', mimeType: 'video/mp4', source: { kind: 'path', path } }],
          },
        ]),
        media(image, false),
      ).then((out) => (out.messages[0]?.content as ContentBlock[])[0])
    expect(await block(true)).toEqual({
      type: 'text',
      text: `［视频 ${path}：当前模型或接口不接受原生视频输入，这一段没有发出去；需要画面时用 read_file 读这个路径，会按时间抽取若干帧］`,
    })
    const noImages = (await block(false)) as { text: string }
    expect(noImages.text).not.toContain('read_file')
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
    expect(env.images_omitted).toBe(IMAGES_OMITTED)
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
      IMAGES_OMITTED,
    )
  })
})

describe('换出的媒体换成说明', () => {
  const withImage = (): WireMessage => ({
    role: 'tool',
    toolCallId: 'c1',
    content: [
      { type: 'text', text: envelope },
      { type: 'image', mimeType: 'image/png', source: { kind: 'base64', data: 'QUJD' } },
    ],
  })

  /** 信封保留 `result`，只摘图像块并标记；模型据标记知道图不在场。 */
  test('带图的工具结果换成 images_omitted 信封，result 保留', () => {
    const out = omitImages(withImage())
    expect(typeof out.content).toBe('string')
    const env = JSON.parse(out.content as string) as Record<string, unknown>
    expect(env.images_omitted).toBe(IMAGES_OMITTED)
    expect(env.result).toEqual({ lines: 1 })
    expect(out.content as string).not.toContain('QUJD')
  })

  /**
   * 标记只写 `true` 或只写「已提供」时，模型读到信封会判断自己从未收到过这张图，
   * 向用户否认之前的检查并反复读回。写成「你已看过」则超出传输记录能证明的事实：
   * 端点收到请求不等于模型读到了图。标记写明此前已发送、现已移出、怎么取回。
   */
  test('省略标记只陈述传输事实并给出取回方式', () => {
    const env = JSON.parse(omitImages(withImage()).content as string) as Record<string, unknown>
    expect(env.images_omitted).toContain('此前已随请求发送给你')
    expect(env.images_omitted).toContain('现已从请求中移出')
    expect(env.images_omitted).toContain('read_history')
    expect(env.images_omitted).toContain('call_id')
    expect(env.images_omitted).not.toContain('看过')
  })

  /** 用户消息的附件媒体换成一行说明，正文不动；路径在附件说明里，说明指过去。 */
  test('用户消息的附件媒体换成说明，正文保留', () => {
    const user: WireMessage = {
      role: 'user',
      content: [
        { type: 'image', mimeType: 'image/jpeg', source: { kind: 'base64', data: 'QUJD' } },
        { type: 'text', text: '看看这张图\n（附件 a.jpg：D:/x/a.jpg）' },
      ],
    }
    const out = omitImages(user)
    expect(out.content).toEqual([
      { type: 'text', text: ATTACHMENT_MEDIA_OMITTED },
      { type: 'text', text: '看看这张图\n（附件 a.jpg：D:/x/a.jpg）' },
    ])
  })

  /** 投影每次请求都跑：无媒体必须回原引用，有媒体必须逐字稳定，否则前缀缓存全失配。 */
  test('无媒体原引用返回，有媒体两次产物逐字相同', () => {
    const plain: WireMessage = { role: 'tool', toolCallId: 'c2', content: envelope }
    expect(omitImages(plain)).toBe(plain)
    const user: WireMessage = { role: 'user', content: 'x' }
    expect(omitImages(user)).toBe(user)
    expect(omitImages(withImage()).content).toBe(omitImages(withImage()).content)
  })

  /** 换出来的信封再收纳一次仍带标记，两条路径产物同形。 */
  test('省略后的信封经收纳仍标 images_omitted', () => {
    const env = JSON.parse(condenseMessage(omitImages(withImage())).content as string) as Record<
      string,
      unknown
    >
    expect(env.images_omitted).toBe(IMAGES_OMITTED)
  })
})

describe('媒体按字节预算换出', () => {
  /** 解码后正好 `bytes` 字节的 base64 图。 */
  const shot = (bytes: number): ContentBlock => ({
    type: 'image',
    mimeType: 'image/jpeg',
    source: { kind: 'base64', data: 'A'.repeat(Math.ceil((bytes * 4) / 3)) },
  })
  const MB = 1024 * 1024
  /** 收图片、收原生视频、适配器只内联：大多数原生视频接口的发法。 */
  const CAPS = { image: true, video: true }
  const call = (id: string): WireMessage => ({
    role: 'assistant',
    content: '',
    toolCalls: [{ id, name: 'read_file', arguments: {} }],
  })
  const result = (id: string, bytes: number): WireMessage => ({
    role: 'tool',
    toolCallId: id,
    content: [{ type: 'text', text: envelope }, shot(bytes)],
  })
  /** 每步一张图：assistant 调用 + 结果，共 n 步。 */
  const steps = (sizes: number[]): WireMessage[] =>
    sizes.flatMap((size, i) => [call(`c${i}`), result(`c${i}`, size)])

  test('base64 按解码后的字节计，内联的路径视频按文件大小计，读不到记 0', async () => {
    expect(mediaBytes(result('c', MB), CAPS)).toBeGreaterThanOrEqual(MB)
    const dir = await mkdtemp(join(tmpdir(), 'qywork-media-'))
    const path = join(dir, 'clip.mp4')
    await writeFile(path, new Uint8Array(3 * MB))
    const video: WireMessage = {
      role: 'user',
      content: [{ type: 'video', mimeType: 'video/mp4', source: { kind: 'path', path } }],
    }
    expect(mediaBytes(video, CAPS)).toBe(3 * MB)
    const gone: WireMessage = {
      role: 'user',
      content: [
        {
          type: 'video',
          mimeType: 'video/mp4',
          source: { kind: 'path', path: join(dir, 'x.mp4') },
        },
      ],
    }
    expect(mediaBytes(gone, CAPS)).toBe(0)
  })

  /**
   * 路径视频按这一轮的发法计：上传成地址的、超过常驻上限又不能上传的（改走抽帧）、模型不收的都不进请求体，记 0。
   * 按文件大小一律计的话，上传成地址的 18 MB 视频下一步就被换出，模型只看到一眼（Qwen3.8 Flash 实测）。
   */
  test('路径视频按发法计字节：上传、抽帧、不收都记 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qywork-media-'))
    const big = join(dir, 'big.mp4')
    await writeFile(big, new Uint8Array(6 * MB))
    const video: WireMessage = {
      role: 'user',
      content: [{ type: 'video', mimeType: 'video/mp4', source: { kind: 'path', path: big } }],
    }
    expect(mediaBytes(video, { ...CAPS, mediaPaths: true, mediaUploadAbove: 2 * MB })).toBe(0)
    expect(mediaBytes(video, CAPS)).toBe(0)
    expect(mediaBytes(video, { image: true, video: false })).toBe(0)
    expect(videoDelivery(6 * MB, { video: true, mediaUploadAbove: 2 * MB })).toBe('upload')
    expect(videoDelivery(6 * MB, { video: true })).toBe('frames')
    expect(videoDelivery(MB, { video: true })).toBe('inline')
    expect(videoDelivery(MB, { video: false })).toBe('frames')
    // 上传成地址的视频不计字节，就一直留在请求里，模型之后的每一步都看得到。
    const messages = [video, call('c0'), result('c0', MB), call('c1'), result('c1', MB)]
    const upload = { ...CAPS, mediaPaths: true, mediaUploadAbove: 2 * MB }
    expect(evictedMedia(messages, upload).has(0)).toBe(false)
  })

  test('模型不收图片时图片不计字节', () => {
    expect(mediaBytes(result('c', MB), { image: false, video: false })).toBe(0)
  })

  test('总量在上限内一张都不换', () => {
    expect(evictedMedia(steps([MB, MB, MB]), CAPS).size).toBe(0)
  })

  /** 超上限时从最早的起整条换出，直到不超过下限：换一次少变几次前缀。 */
  test('超过上限时从最早的整批换出，降到下限以内', () => {
    const messages = steps([MB, MB, MB, MB, MB, MB])
    const evicted = evictedMedia(messages, CAPS)
    // 第 6 张让总量到 6 MB（> 5 MB），换出最早的四张，剩 2 MB。
    expect([...evicted]).toEqual([1, 3, 5, 7])
    const left = messages.reduce((n, m, i) => n + (evicted.has(i) ? 0 : mediaBytes(m, CAPS)), 0)
    expect(left).toBeLessThanOrEqual(MEDIA_RETAIN_LOW_BYTES)
  })

  /** 最后一条 assistant 之后的媒体还没随任何一次得到回应的请求发出去过，单张超限也不换。 */
  test('最后一条 assistant 之后的媒体不换出', () => {
    const messages = [...steps([MB, MB]), call('big'), result('big', 6 * MB)]
    const evicted = evictedMedia(messages, CAPS)
    expect(evicted.has(messages.length - 1)).toBe(false)
    expect([...evicted]).toEqual([1, 3])
  })

  /** 用户消息带的附件同样计入，第一次请求（没有 assistant）时全部保留。 */
  test('附件计入同一预算；还没有 assistant 时一张都不换', () => {
    const user: WireMessage = { role: 'user', content: [shot(5 * MB), { type: 'text', text: 'x' }] }
    expect(evictedMedia([user], CAPS).size).toBe(0)
    expect([...evictedMedia([user, call('c0'), result('c0', MB)], CAPS)]).toEqual([0])
  })

  /** 追加消息只会多换出，已换出的不会回来：前缀只在换出那一刻变。 */
  test('同一历史结果相同，追加消息不让已换出的回来', () => {
    const sizes = [MB, 2 * MB, MB, 3 * MB, MB, MB, 2 * MB, MB]
    let previous = new Set<number>()
    for (let n = 1; n <= sizes.length; n++) {
      const messages = steps(sizes.slice(0, n))
      const evicted = evictedMedia(messages, CAPS)
      expect([...evictedMedia(messages, CAPS)]).toEqual([...evicted])
      for (const i of previous) expect(evicted.has(i)).toBe(true)
      previous = evicted
    }
  })
})
