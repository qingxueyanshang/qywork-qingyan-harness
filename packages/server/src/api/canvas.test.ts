/**
 * 覆盖 `api/canvas.ts`：入参核对、界面发起的生成不挂在请求上、花费记成无轮次的账、用量页列得出、
 * 发送前的花费、模型行只下发有界面名的参数（`api/conversations.ts` 的 `MediaModelRow.params`）。
 *
 * 生成走真的端口与百炼适配器，端点是本机假服务：它先扣住响应，测试据此确认请求在生成结束之前就返回了。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type AgentEvent,
  applyCanvasOps,
  type CanvasView,
  emptyCanvas,
  serializeCanvas,
  type UsageResponse,
} from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { Store, upsertWorkspace } from '@qywork/store'
import { CanvasService } from '../canvas.ts'
import type { CanvasQuoteResponse } from './canvas.ts'
import type { ModelsResponse } from './conversations.ts'
import { type ApiDeps, handleApi } from './index.ts'

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 9])
const PATH = 'board.canvas.json'

let server: ReturnType<typeof Bun.serve>
let release: () => void = () => {}
let held = Promise.resolve()
const origin = () => `http://127.0.0.1:${server.port}`

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === '/files/out.jpg') {
        return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } })
      }
      await held
      return Response.json({
        output: { choices: [{ message: { content: [{ image: `${origin()}/files/out.jpg` }] } }] },
        usage: { output_image_count: 1, output_image_type: 'qima_output_1k' },
      })
    },
  })
})
afterAll(() => server.stop(true))

function config(): QyConfig {
  return {
    active: { provider: 'ds', model: 'qwen-plus' },
    providers: {
      ds: {
        kind: 'openai_chat_completions',
        baseUrl: `${origin()}/compatible-mode/v1`,
        apiKey: 'sk-ds',
        models: { 'qwen-plus': {} },
        media: {
          'qwen-image-3.0': { kind: 'dashscope_images' },
          'wan3.0-video': { kind: 'dashscope_videos' },
        },
      },
    },
    mediaDefaults: {
      image: { provider: 'ds', model: 'qwen-image-3.0' },
      video: { provider: 'ds', model: 'wan3.0-video' },
    },
    mode: 'auto',
  } as QyConfig
}

async function setup(): Promise<{
  d: ApiDeps & { workspaceId: string }
  root: string
  nodeId: string
  events: AgentEvent[]
  done: () => Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'qywork-canvas-api-'))
  const r = applyCanvasOps(emptyCanvas(), [
    { op: 'add_generate', ref: '$g', output: 'image', prompt: '一只猫' },
  ])
  if (!r.ok) throw new Error(r.error)
  await writeFile(join(root, PATH), serializeCanvas(r.doc))
  const store = new Store({ path: ':memory:' })
  const ws = upsertWorkspace(store, root, 'demo')
  const events: AgentEvent[] = []
  let settled: () => void = () => {}
  const finished = new Promise<void>((resolve) => {
    settled = resolve
  })
  const canvas = new CanvasService({
    publish: (e) => {
      events.push(e)
      if (e.type === 'canvas.run' && e.state !== 'running') settled()
    },
  })
  const d = { store, config: config(), canvas, workspaceId: ws.id } as unknown as ApiDeps & {
    workspaceId: string
  }
  return { d, root, nodeId: r.refs.$g!, events, done: () => finished }
}

function call(d: ApiDeps & { workspaceId: string }, path: string, body?: unknown) {
  const url = `http://127.0.0.1${path}${path.includes('?') ? '&' : '?'}ws=${d.workspaceId}`
  const init: RequestInit = body
    ? {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }
    : {}
  return handleApi(new URL(url), new Request(url, init), d) as Promise<Response>
}

describe('画布接口', () => {
  test('操作不合法回 422，文件字节不变', async () => {
    const { d, root } = await setup()
    const before = await readFile(join(root, PATH), 'utf8')
    const bad = await call(d, '/api/canvas/ops', {
      path: PATH,
      ops: [{ op: 'update', id: 'x', versions: [] }],
    })
    expect(bad.status).toBe(422)
    const gone = await call(d, '/api/canvas/ops', {
      path: PATH,
      ops: [{ op: 'remove', id: 'nope' }],
    })
    expect(gone.status).toBe(422)
    expect(await readFile(join(root, PATH), 'utf8')).toBe(before)
  })

  test('上传：原始字节落进 uploads/ 并以给定点为中心加节点；缺位置回 422 且不落盘', async () => {
    const { d, root } = await setup()
    const upload = (query: string) => {
      const url = `http://127.0.0.1/api/canvas/upload?${query}&ws=${d.workspaceId}`
      return handleApi(
        new URL(url),
        new Request(url, { method: 'POST', body: JPEG }),
        d,
      ) as Promise<Response>
    }
    expect((await upload(`path=${PATH}&name=a.jpg`)).status).toBe(422)
    const ok = await upload(`path=${PATH}&name=${encodeURIComponent('小满.jpg')}&x=1112.5&y=1084.5`)
    expect(ok.status).toBe(200)
    const r = (await ok.json()) as { nodeId: string; path: string }
    expect(r.path).toBe('uploads/小满.jpg')
    expect(new Uint8Array(await readFile(join(root, r.path)))).toEqual(JPEG)
    const doc = JSON.parse(await readFile(join(root, PATH), 'utf8')) as {
      nodes: { id: string; path?: string; x: number; y: number }[]
    }
    expect(doc.nodes.find((n) => n.id === r.nodeId)).toMatchObject({
      path: r.path,
      x: 1000,
      y: 1000,
    })
    expect(doc.nodes.filter((n) => n.path === 'uploads/a.jpg')).toHaveLength(0)
  })

  test('运行立刻返回；生成完成后账本多一行无轮次无会话、带项目的 media 账，用量页列得出', async () => {
    const { d, root, nodeId, done } = await setup()
    held = new Promise((resolve) => {
      release = resolve
    })
    const res = await call(d, '/api/canvas/run', { path: PATH, nodeId })
    expect(res.status).toBe(200)
    const view = (await res.json()) as CanvasView
    // 端点还扣着响应，接口已经返回：生成不挂在这次请求上。
    expect(view.states[nodeId]).toMatchObject({ state: 'running' })
    release()
    await done()

    const rows = d.store.db
      .query('SELECT kind, run_id, conversation_id, workspace_id, cost, currency FROM usage_ledger')
      .all()
    expect(rows).toEqual([
      {
        kind: 'media',
        run_id: null,
        conversation_id: null,
        workspace_id: d.workspaceId,
        cost: 0.18,
        currency: 'CNY',
      },
    ])
    const usage = (await (await call(d, '/api/usage?days=1')).json()) as UsageResponse
    expect(usage.workspaceTotals.cost.CNY).toBeCloseTo(0.18, 10)

    const after = (await (await call(d, `/api/canvas?path=${PATH}`)).json()) as CanvasView
    expect(after.states[nodeId]).toEqual({ state: 'normal' })
    expect(
      await readFile(
        join(root, (after.doc.nodes[0] as { versions: { path: string }[] }).versions[0]!.path),
      ),
    ).toEqual(Buffer.from(JPEG))
  })

  test('发送前的花费：万相 3.0 720P 5 秒 ¥3.00；按接口档位计价的回 null', async () => {
    const { d } = await setup()
    const video = (await (
      await call(d, '/api/canvas/quote', {
        output: 'video',
        params: { resolution: '720P', duration: 5 },
        inputs: { images: 1, videos: 0 },
      })
    ).json()) as CanvasQuoteResponse
    expect(video.quote?.cost).toBeCloseTo(3, 10)
    const image = (await (
      await call(d, '/api/canvas/quote', { output: 'image', params: {} })
    ).json()) as CanvasQuoteResponse
    expect(image.quote).toBeNull()
  })

  test('模型行只下发标了界面名的参数，不带给大模型看的说明', async () => {
    const { d } = await setup()
    const models = (await (await call(d, '/api/models')).json()) as ModelsResponse
    const wan = models.media.find((m) => m.id === 'wan3.0-video')!
    expect(wan.params.map((p) => [p.name, p.label])).toEqual([
      ['ratio', '宽高比'],
      ['resolution', '分辨率'],
      ['duration', '时长'],
    ])
    expect(JSON.stringify(wan.params)).not.toContain('description')
  })
})
