/** 图片张数贯穿真实 HTTP 适配器、生成端口、文件落盘与画布版本；不调用付费接口。 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findMediaModel } from '@qywork/ai'
import { type CanvasGenerateNode, emptyCanvas, serializeCanvas } from '@qywork/core'
import { makeMediaPort } from '@qywork/runtime'
import { CanvasService } from './canvas.ts'

const PATH = 'images.canvas.json'
const MODEL = 'gpt-image-2.5-sunburst'
const images = [1, 2, 3, 4].map((n) => Buffer.from([0x89, 0x50, 0x4e, 0x47, n]))
let server: ReturnType<typeof Bun.serve>
let requests: Record<string, unknown>[] = []
let reply = () => Response.json({ data: images.map((b) => ({ b64_json: b.toString('base64') })) })

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      requests.push((await req.json()) as Record<string, unknown>)
      return reply()
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  requests = []
  reply = () => Response.json({ data: images.map((b) => ({ b64_json: b.toString('base64') })) })
})

async function setup(n = 4) {
  const root = await mkdtemp(join(tmpdir(), 'qywork-image-results-'))
  await writeFile(join(root, PATH), serializeCanvas(emptyCanvas()))
  const svc = new CanvasService({
    publish: () => {},
    paramSpecsOf: () => findMediaModel(MODEL)!.params,
  })
  const { refs } = await svc.apply(root, PATH, [
    { op: 'add_generate', ref: '$g', output: 'image', prompt: '一张海报', params: { n } },
  ])
  const id = refs.$g!
  const media = makeMediaPort({
    providers: {
      test: {
        kind: 'openai_chat_completions',
        apiKey: 'test-key',
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        models: {},
        media: { [MODEL]: { kind: 'openai_images' } },
      },
    },
    mediaDefaults: { image: { provider: 'test', model: MODEL } },
  })
  const run = async () => (await svc.run({ id: 'ws', root }, PATH, id, { media })).done
  const card = async (service = svc) => {
    const view = await service.read(root, PATH)
    return view.doc.nodes.find((x) => x.id === id) as CanvasGenerateNode
  }
  return { root, svc, id, run, card }
}

describe('图片生成的完整结果与部分结果', () => {
  test('16:9、4K、最高质量、四张原样写入 HTTP 请求；返回低分辨率时保存原图并说明差异', async () => {
    const png = Buffer.alloc(33)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png)
    png.writeUInt32BE(13, 8)
    png.write('IHDR', 12, 'latin1')
    png.writeUInt32BE(1024, 16)
    png.writeUInt32BE(1536, 20)
    reply = () => Response.json({ data: [{ b64_json: png.toString('base64') }] })
    const { root, svc, id, run, card } = await setup()
    const size = findMediaModel(MODEL)!
      .params.find((p) => p.name === 'size')!
      .shapes!.find((s) => s.ratio === '16:9' && s.tier === '4K')!.value!
    expect(size).toBe('3840x2160')
    const params = { n: 4, size, quality: 'max' }
    await svc.apply(root, PATH, [{ op: 'update', id, params }])
    const result = await run()
    expect(requests).toEqual([{ model: MODEL, prompt: '一张海报', ...params }])
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(result.message)
    expect(result.warning).toContain('请求 4 张，实际返回 1 张')
    expect(result.warning).toContain('请求尺寸 3840×2160，实际返回 1024×1536')
    // 回执中的宽高取自产物文件头，发送的参数与请求一致，调用方据此核对与要求的差异。
    expect(result.outputs).toEqual([{ path: result.outputs[0]!.path, size: { w: 1024, h: 1536 } }])
    expect(result.params).toEqual(params)
    expect(await readFile(join(root, result.outputs[0]!.path))).toEqual(png)
    const version = (await card()).versions[0]!
    expect(version.made.params).toEqual(params)
    expect(version.size).toEqual({ w: 1024, h: 1536 })
    expect(version.warning).toBe(result.warning)
  })

  test('请求并返回四张：全部落盘为四版，可切换，重复生成追加版本', async () => {
    const { root, svc, id, run, card } = await setup()
    expect((await run()).ok).toBe(true)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.n).toBe(4)
    const first = await card()
    expect(first.versions).toHaveLength(4)
    expect(new Set(first.versions.map((v) => v.path)).size).toBe(4)
    expect(first.current).toBe(first.versions[0]!.id)
    for (const [i, version] of first.versions.entries()) {
      expect(await readFile(join(root, version.path))).toEqual(images[i]!)
      expect(version.made.params.n).toBe(4)
      expect(version.warning).toBeUndefined()
    }
    await svc.apply(root, PATH, [{ op: 'update', id, current: first.versions[3]!.id }])
    expect((await card()).current).toBe(first.versions[3]!.id)
    await run()
    expect((await card()).versions).toHaveLength(8)
    expect(requests).toHaveLength(2)
  })

  test.each([false, true])(
    '只返回一张，部分失败原文=%s：保留产物、持久化提示、不自动补发',
    async (withError) => {
      reply = () =>
        Response.json({
          data: [
            { b64_json: images[0]!.toString('base64') },
            ...(withError ? [{ error: { message: '内容审核未通过' } }] : []),
          ],
        })
      const { root, run, card } = await setup()
      const result = await run()
      expect(result.ok).toBe(true)
      if (!result.ok) throw new Error(result.message)
      expect(result.outputs).toHaveLength(1)
      expect(result.warning).toContain('请求 4 张，实际返回 1 张')
      if (withError) expect(result.warning).toContain('内容审核未通过')
      expect(await readFile(join(root, result.outputs[0]!.path))).toEqual(images[0]!)
      const reopened = await card(new CanvasService({ publish: () => {} }))
      expect(reopened.versions).toHaveLength(1)
      expect(reopened.versions[0]!.warning).toBe(result.warning)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.n).toBe(4)
    },
  )

  test('第一次生成图片、第二次 HTTP 400：保留原图，不增加虚假版本；再次成功时清除失败', async () => {
    const { root, svc, id, run, card } = await setup(1)
    reply = () => Response.json({ data: [{ b64_json: images[0]!.toString('base64') }] })
    await run()
    const original = await card()
    reply = () =>
      Response.json({ error: { message: 'rejected by the safety system' } }, { status: 400 })
    expect((await run()).ok).toBe(false)
    expect((await card()).versions).toEqual(original.versions)
    expect((await card()).current).toBe(original.current)
    expect((await svc.read(root, PATH)).states[id]).toMatchObject({ state: 'failed' })
    reply = () => Response.json({ data: [{ b64_json: images[1]!.toString('base64') }] })
    await run()
    expect((await card()).versions).toHaveLength(2)
    expect((await svc.read(root, PATH)).states[id]).toEqual({ state: 'normal' })
    expect(requests).toHaveLength(3)
  })
})
