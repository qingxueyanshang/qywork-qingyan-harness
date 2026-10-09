/** 图片请求、恢复记录、费用与画布经同一条真实 HTTP 路径验证，端点在本机。 */
import { afterAll, beforeAll, beforeEach, expect, spyOn, test } from 'bun:test'
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CanvasGenerateNode,
  emptyCanvas,
  type MediaSpend,
  serializeCanvas,
} from '@qywork/core'
import { makeMediaPort, type QyConfig } from '@qywork/runtime'
import { generateMedia, resumeMedia } from '@qywork/tools'
import { CanvasService } from './canvas.ts'

const MODEL = 'gpt-image-2.5-sunburst'
const PATH = 'recovery.canvas.json'
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1])
let server: ReturnType<typeof Bun.serve>
let methods: string[] = []
let downloadStatus = 503
let beforeDownload: () => Promise<void> = async () => {}
let reply: () => Response | Promise<Response>
beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      methods.push(req.method)
      if (req.method === 'POST') return reply()
      await beforeDownload()
      return new Response(PNG, { status: downloadStatus, headers: { 'content-type': 'image/png' } })
    },
  })
})
afterAll(() => server.stop(true))
beforeEach(() => {
  methods = []
  downloadStatus = 503
  beforeDownload = async () => {}
  reply = () =>
    Response.json({
      data: [1, 2].map((i) => ({ url: `http://127.0.0.1:${server.port}/${i}.png` })),
      usage: { output_tokens: 1000 },
    })
})
const config = (): QyConfig => ({
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
const signal = () => new AbortController().signal
const call = () => ({ type: 'image' as const, prompt: '海报', inputs: [], params: { n: 2 } })

test('下载失败前保存全部图片引用并记账，阻止自动重新生成，重启恢复只下载且不重复计费', async () => {
  const root = await mkdtemp(join(tmpdir(), 'qy-image-recovery-'))
  const spend: MediaSpend[] = []
  const media = makeMediaPort(config(), (s) => spend.push(s))
  let savedBeforeDownload = false
  beforeDownload = async () => {
    const records = (await readdir(join(root, 'generated'))).filter((f) => f.endsWith('.task.json'))
    const record = JSON.parse(await readFile(join(root, 'generated', records[0]!), 'utf8'))
    savedBeforeDownload = record.imageResult.sources.length === 2
    expect(JSON.stringify(record)).not.toContain('test-key')
  }
  const failed = await generateMedia({
    roots: root,
    media,
    signal: signal(),
    ...call(),
    params: { n: 4 },
  })
  expect(savedBeforeDownload).toBe(true)
  expect(failed).toMatchObject({
    ok: false,
    diagnostic: { stage: 'download', outcome: 'available' },
  })
  if (failed.ok || !failed.record) throw new Error('应保留图片恢复记录')
  expect(methods).toEqual(['POST', 'GET', 'GET', 'GET'])
  expect(spend).toHaveLength(1)
  expect(spend[0]?.quantity).toBe(2)
  expect(await media.generate({ ...call(), prompt: '换提示词重试' }, signal())).toMatchObject({
    ok: false,
    executed: false,
  })
  expect(methods.filter((m) => m === 'POST')).toHaveLength(1)
  // 配置暂时不可用不能删除恢复记录。
  expect(
    await resumeMedia({
      roots: root,
      media: makeMediaPort({ providers: {} }),
      signal: signal(),
      record: failed.record,
    }),
  ).toMatchObject({ ok: false, record: failed.record, executed: false })
  downloadStatus = 200
  const restored = await resumeMedia({
    roots: root,
    media: makeMediaPort(config(), (s) => spend.push(s)),
    signal: signal(),
    record: failed.record,
  })
  expect(restored.ok).toBe(true)
  if (!restored.ok) throw new Error(restored.message)
  expect(restored.files).toHaveLength(2)
  expect(restored.warning).toContain('请求 4 张，实际返回 2 张')
  for (const f of restored.files)
    expect(new Uint8Array(await readFile(join(root, f.path)))).toEqual(PNG)
  expect((await readdir(join(root, 'generated'))).some((f) => f.endsWith('.task.json'))).toBe(false)
  expect(spend).toHaveLength(1)
  expect(methods).toEqual(['POST', 'GET', 'GET', 'GET', 'GET', 'GET'])
})

async function canvas() {
  const root = await mkdtemp(join(tmpdir(), 'qy-canvas-recovery-'))
  await writeFile(join(root, PATH), serializeCanvas(emptyCanvas()))
  const service = new CanvasService({ publish: () => {} })
  const { refs } = await service.apply(root, PATH, [
    { op: 'add_generate', ref: '$g', output: 'image', prompt: '海报', params: { n: 2 } },
  ])
  return { root, service, id: refs.$g!, ws: { id: 'ws', root } }
}

test('画布重启后取回图片：替换待取回版本，多张图片留在原卡片，保留费用与诊断', async () => {
  const { root, service, id, ws } = await canvas()
  const failed = await (await service.run(ws, PATH, id, { media: makeMediaPort(config()) })).done
  expect(failed).toMatchObject({ ok: false, pending: true })
  const reopened = new CanvasService({ publish: () => {} })
  const pending = await reopened.read(root, PATH)
  expect(pending.states[id]?.state).toBe('pending')
  expect(pending.doc.runs?.[0]).toMatchObject({
    result: 'pending',
    diagnostic: { stage: 'download', outcome: 'available' },
  })
  expect(pending.doc.runs?.[0]?.cost).toBeGreaterThan(0)
  downloadStatus = 200
  const recovered = await (
    await reopened.retrieve(ws, PATH, id, undefined, { media: makeMediaPort(config()) })
  ).done
  expect(recovered.ok).toBe(true)
  const view = await reopened.read(root, PATH)
  expect(view.states[id]).toEqual({ state: 'normal' })
  expect(view.doc.nodes).toHaveLength(1)
  const node = view.doc.nodes[0] as CanvasGenerateNode
  expect(node.versions).toHaveLength(2)
  expect(node.current).toBe(node.versions[0]?.id)
  expect(node.versions.every((v) => v.path.endsWith('.png'))).toBe(true)
  expect(view.doc.runs?.[1]?.cost).toBeUndefined()
  expect(methods.filter((m) => m === 'POST')).toHaveLength(1)
})

test('没有结果引用的本地超时：重启仍显示结果未知，不提供取回，不自动再提交', async () => {
  const { root, service, id, ws } = await canvas()
  const original = AbortSignal.timeout.bind(AbortSignal)
  const timer = spyOn(AbortSignal, 'timeout').mockImplementation(() => original(80))
  reply = async () => {
    await new Promise((r) => setTimeout(r, 250))
    return Response.json({})
  }
  const media = makeMediaPort(config())
  try {
    const failed = await (await service.run(ws, PATH, id, { media })).done
    expect(failed).toMatchObject({
      ok: false,
      pending: false,
      diagnostic: { kind: 'timeout', outcome: 'unknown', timeoutMs: 600_000 },
    })
    const view = await new CanvasService({ publish: () => {} }).read(root, PATH)
    expect(view.doc.runs?.[0]?.result).toBe('unknown')
    expect(view.doc.runs?.[0]?.diagnostic).toMatchObject({
      stage: 'generate',
      kind: 'timeout',
      outcome: 'unknown',
    })
    expect(view.states[id]?.state).toBe('unknown')
    expect((view.doc.nodes[0] as CanvasGenerateNode).versions).toHaveLength(0)
    expect(await media.generate(call(), signal())).toMatchObject({ ok: false, executed: false })
    expect(methods).toEqual(['POST'])
  } finally {
    timer.mockRestore()
  }
})
