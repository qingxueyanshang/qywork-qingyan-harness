/**
 * 覆盖范围：`api/square.ts` 的各路由、`square/files.ts`（按哈希保存、哈希核对、快照目录）与 `square/install.ts`
 * 的安装表，以及 `canvas/docs.ts` 的 `importDoc`。云端由本文件中的模拟服务提供，条目的 `meta` 与 MIME 取自
 * `@qywork/core` 的 `checkSquareSnapshot`，与云端保存时相同。全局数据目录由测试预载按进程分开。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSquareSnapshot, parseCanvas, type SquareDetail, type SquareKind } from '@qywork/core'
import { globalPluginsDir, listPets, type QyConfig, readPersonalization } from '@qywork/runtime'
import { handleSquareApi } from '../api/square.ts'
import type { ApiRequestDeps } from '../api/types.ts'
import { CanvasService } from '../canvas/service.ts'
import { CLOUD_PROVIDER, CloudAccount } from '../cloud/account.ts'
import { squareDir } from './files.ts'

const enc = (s: string) => new TextEncoder().encode(s)
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])

const blobs = new Map<string, Uint8Array>()
const items = new Map<string, SquareDetail>()
/** 云端答复文件时的改写：用于构造内容与哈希不一致。 */
const tampered = new Set<string>()
let fileReads = 0

/** 按 core 的校验得出 `meta`、封面与 MIME，登记为云端的一个条目。 */
function publish(
  id: string,
  kind: SquareKind,
  meta: unknown,
  files: Record<string, Uint8Array | string>,
) {
  const list = Object.entries(files).map(([path, b]) => ({
    path,
    bytes: typeof b === 'string' ? enc(b) : b,
  }))
  const checked = checkSquareSnapshot(kind, meta, list)
  if (!checked.ok) throw new Error(checked.error)
  for (const f of list) blobs.set(sha(f.bytes), f.bytes)
  const detail: SquareDetail = {
    id,
    kind,
    title: `条目 ${id}`,
    summary: '',
    author: '用户 a1b2c3',
    cover: checked.cover ? sha(list.find((f) => f.path === checked.cover)!.bytes) : null,
    version: 1,
    updatedAt: '2026-11-27T00:00:00.000Z',
    source: 'upload',
    repo: null,
    license: null,
    meta: checked.meta,
    files: list.map((f) => ({
      path: f.path,
      hash: sha(f.bytes),
      size: f.bytes.length,
      mime: checked.mime[f.path]!,
    })),
    mine: false,
  }
  items.set(id, detail)
  return detail
}

const listQueries: string[] = []
const cloud = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(req) {
    const url = new URL(req.url)
    const file = /^\/v1\/square\/files\/([0-9a-f]{64})$/.exec(url.pathname)
    if (file) {
      fileReads++
      const bytes = blobs.get(file[1]!)
      if (!bytes) return Response.json({ error: { code: 'not_found' } }, { status: 404 })
      return new Response(tampered.has(file[1]!) ? enc('改写后的内容') : bytes)
    }
    const item = /^\/v1\/square\/items\/([^/]+)$/.exec(url.pathname)
    if (item) {
      const detail = items.get(decodeURIComponent(item[1]!))
      return detail
        ? Response.json(detail)
        : Response.json({ error: { code: 'not_found', message: '条目不存在' } }, { status: 404 })
    }
    if (url.pathname === '/v1/square/items') {
      listQueries.push(url.search)
      return Response.json({ items: [], next: null })
    }
    return Response.json({ error: { code: 'not_found' } }, { status: 404 })
  },
})
const origin = `http://127.0.0.1:${cloud.port}`

let workspaceRoot = ''
let deps: ApiRequestDeps

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(process.env.QYWORK_TEST_TEMP ?? tmpdir(), 'square-ws-'))
  const config = {
    providers: {
      [CLOUD_PROVIDER]: {
        kind: 'anthropic_messages',
        baseUrl: origin,
        apiKey: 'qyd_test',
        models: {},
      },
    },
  } as unknown as QyConfig
  deps = {
    cloud: new CloudAccount(config, origin),
    canvas: new CanvasService({ publish: () => {} }),
    workspaceRoot,
  } as unknown as ApiRequestDeps
})

afterAll(() => cloud.stop(true))

async function call(path: string, init?: RequestInit): Promise<Response> {
  const url = new URL(`http://local${path}`)
  const res = await handleSquareApi(url, new Request(url.href, init), deps)
  if (!res) throw new Error(`未处理：${path}`)
  return res
}
const install = (id: string) =>
  call('/api/square/install', { method: 'POST', body: JSON.stringify({ id }) })

describe('浏览', () => {
  test('列表只转交类型、搜索词与分页起点', async () => {
    const res = await call('/api/square/items?kind=skill&q=发版&before=2026-11-01&x=1')
    expect(await res.json()).toEqual({ items: [], next: null })
    expect(new URLSearchParams(listQueries.at(-1)).toString()).toBe(
      new URLSearchParams({ kind: 'skill', q: '发版', before: '2026-11-01' }).toString(),
    )
  })

  test('文件按哈希保存在本机：第二次读取不再访问云端；类型按文件头判定', async () => {
    const d = publish('sq_img', 'work', { format: 'image' }, { 'image.png': PNG })
    const hash = d.files[0]!.hash
    const before = fileReads
    const first = await call(`/api/square/files/${hash}`)
    expect(first.headers.get('content-type')).toBe('image/png')
    expect(new Uint8Array(await first.arrayBuffer())).toEqual(PNG)
    await call(`/api/square/files/${hash}`)
    expect(fileReads).toBe(before + 1)
  })

  test('取得的内容与哈希不一致时 502，不保存', async () => {
    const d = publish(
      'sq_bad',
      'work',
      { format: 'image' },
      { 'image.png': new Uint8Array([...PNG, 9]) },
    )
    const hash = d.files[0]!.hash
    tampered.add(hash)
    const res = await call(`/api/square/files/${hash}`)
    expect(res.status).toBe(502)
    expect(await stat(join(squareDir(), 'files', hash)).catch(() => null)).toBeNull()
  })
})

describe('安装', () => {
  test('提示词与作品没有安装', async () => {
    publish('sq_prompt', 'prompt', { text: '写一首诗' }, {})
    const res = await install('sq_prompt')
    expect(res.status).toBe(422)
  })

  test('技能安装到全局层，快照目录用完即删除', async () => {
    publish(
      'sq_skill',
      'skill',
      {},
      {
        'SKILL.md': '---\nname: 发版流程\ndescription: 发布一个版本\n---\n\n先运行门禁。\n',
        'scripts/check.py': 'print(1)\n',
      },
    )
    const res = await install('sq_skill')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { message: string }).message).toContain('发版流程')
    const dirs = await readdir(join(process.env.QYWORK_HOME!, 'skills'))
    const installed = dirs.find((d) => d.includes('发版'))
    expect(installed).toBeDefined()
    expect(
      await readFile(
        join(process.env.QYWORK_HOME!, 'skills', installed!, 'scripts', 'check.py'),
        'utf8',
      ),
    ).toBe('print(1)\n')
    expect(await readdir(join(squareDir(), 'stage'))).toEqual([])
  })

  test('MCP 写入全局层的 mcp.json；同名时 409', async () => {
    publish(
      'sq_mcp',
      'mcp',
      { name: 'square-demo', server: { command: 'qywork-missing-command', env: { TOKEN: '' } } },
      {},
    )
    expect((await install('sq_mcp')).status).toBe(200)
    const saved = JSON.parse(await readFile(join(process.env.QYWORK_HOME!, 'mcp.json'), 'utf8'))
    expect(JSON.stringify(saved)).toContain('qywork-missing-command')
    expect((await install('sq_mcp')).status).toBe(409)
  })

  test('插件复制到全局插件目录；已安装同一 id 时 409', async () => {
    publish(
      'sq_plugin',
      'plugin',
      {},
      {
        'qywork.plugin.json': JSON.stringify({
          id: 'square.demo',
          name: '示例',
          version: '1.0.0',
          description: '示例插件',
          manifestVersion: 1,
          permissions: [],
          contributes: {},
        }),
      },
    )
    expect((await install('sq_plugin')).status).toBe(200)
    expect(await stat(join(globalPluginsDir(), 'square.demo', 'qywork.plugin.json'))).toBeTruthy()
    expect((await install('sq_plugin')).status).toBe(409)
  })

  test('宠物添加到宠物库；皮肤替换当前的个性化', async () => {
    const anim = { frames: ['a.png'], fps: 4 }
    publish(
      'sq_pet',
      'pet',
      {},
      {
        'pet.json': JSON.stringify({
          name: '广场猫',
          size: 96,
          states: { desktop: anim, failed: anim, working: anim, done: anim, idle: anim },
        }),
        'a.png': PNG,
      },
    )
    expect((await install('sq_pet')).status).toBe(200)
    expect((await listPets()).pets.some((p) => p.pack.name === '广场猫')).toBe(true)

    publish(
      'sq_skin',
      'skin',
      {},
      {
        'skin.json': JSON.stringify({
          background: { kind: 'image', file: 'bg.png', fit: 'cover', dim: 0, blur: 0 },
          fog: null,
          opacity: 0.85,
          accent: '#336699',
          flow: null,
        }),
        'bg.png': PNG,
      },
    )
    expect((await install('sq_skin')).status).toBe(200)
    const read = await readPersonalization()
    expect(read.ok && read.entry.personalization.accent).toBe('#336699')
  })

  test('画布导入当前项目的新目录：文件按原相对路径放入，文档中的路径加上目录前缀', async () => {
    const doc = {
      version: 1,
      nodes: [{ id: 'n1', type: 'file', path: 'art/a.png', x: 0, y: 0, w: 100, h: 100 }],
      edges: [],
    }
    publish(
      'sq_canvas',
      'canvas',
      {},
      { 'canvas.json': JSON.stringify(doc), 'files/art/a.png': PNG },
    )
    const first = (await (await install('sq_canvas')).json()) as { canvas: string }
    expect(first.canvas).toBe('条目 sq_canvas/条目 sq_canvas.canvas.json')
    const parsed = parseCanvas(await readFile(join(workspaceRoot, first.canvas), 'utf8'))
    expect(parsed.ok && parsed.doc.nodes[0]).toMatchObject({ path: '条目 sq_canvas/art/a.png' })
    expect(
      new Uint8Array(await readFile(join(workspaceRoot, '条目 sq_canvas', 'art', 'a.png'))),
    ).toEqual(PNG)
    // 同名目录已存在时加序号，不覆盖。
    const second = (await (await install('sq_canvas')).json()) as { canvas: string }
    expect(second.canvas).toBe('条目 sq_canvas-2/条目 sq_canvas.canvas.json')
  })
})
