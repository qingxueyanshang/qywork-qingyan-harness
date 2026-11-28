/**
 * 覆盖范围：`api/square.ts` 的各路由、`square/files.ts`（查看时按流转发并透传 Range、安装时续传与哈希核对、快照目录）与 `square/install.ts`
 * 的安装表，以及 `canvas/docs.ts` 的 `importDoc`。云端由本文件中的模拟服务提供，条目的 `meta` 与 MIME 取自
 * `@qywork/core` 的 `checkSquareSnapshotBytes`，与云端保存时相同。全局数据目录由测试预载按进程分开。
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  checkSquareSnapshotBytes,
  parseCanvas,
  type SquareDetail,
  type SquareKind,
} from '@qywork/core'
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
/** 答复到一半即断开连接一次的文件：用于构造下载中断后续传。 */
const cutOnce = new Set<string>()
/** 云端收到的文件请求的 Range 头（没有时为空串）。 */
const fileRanges: string[] = []

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
  const checked = checkSquareSnapshotBytes(kind, meta, list)
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
/** 云端收到的发布：清单与按路径的文件内容。 */
let uploaded: {
  path: string
  manifest: Record<string, unknown>
  files: Map<string, Uint8Array>
} | null = null
const cloud = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(req) {
    const url = new URL(req.url)
    if (req.method === 'POST' && url.pathname.startsWith('/v1/square/items')) {
      const form = await req.formData()
      const manifest = JSON.parse(String(form.get('manifest'))) as {
        files: { path: string }[]
      } & Record<string, unknown>
      const files = new Map<string, Uint8Array>()
      for (const [i, f] of manifest.files.entries()) {
        files.set(f.path, new Uint8Array(await (form.get(`file:${i}`) as Blob).arrayBuffer()))
      }
      uploaded = { path: url.pathname, manifest, files }
      return Response.json({ id: 'sq_new', version: 1, status: 'pending' })
    }
    const file = /^\/v1\/square\/files\/([0-9a-f]{64})$/.exec(url.pathname)
    if (file) {
      const hash = file[1]!
      const range = req.headers.get('range') ?? ''
      fileRanges.push(range)
      const stored = blobs.get(hash)
      if (!stored) return Response.json({ error: { code: 'not_found' } }, { status: 404 })
      const bytes = tampered.has(hash) ? enc('改写后的内容') : stored
      if (cutOnce.delete(hash)) {
        const half = bytes.subarray(0, Math.ceil(bytes.length / 2))
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(half)
              setTimeout(() => c.error(new Error('断开')), 20)
            },
          }),
          { headers: { 'content-length': String(bytes.length) } },
        )
      }
      const from = /^bytes=(\d+)-$/.exec(range)
      const type = { 'content-type': 'image/png' }
      if (!from) return new Response(bytes, { headers: type })
      const start = Number(from[1])
      return new Response(bytes.subarray(start), {
        status: 206,
        headers: { ...type, 'content-range': `bytes ${start}-${bytes.length - 1}/${bytes.length}` },
      })
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

/** 测试进程原有的全局数据目录：本文件的安装写入独立的目录，结束时恢复，不影响同一进程中之后运行的文件。 */
const sharedHome = process.env.QYWORK_HOME

beforeAll(async () => {
  const temp = process.env.QYWORK_TEST_TEMP ?? tmpdir()
  process.env.QYWORK_HOME = await mkdtemp(join(temp, 'square-home-'))
  workspaceRoot = await mkdtemp(join(temp, 'square-ws-'))
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

afterAll(() => {
  cloud.stop(true)
  if (sharedHome === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = sharedHome
})

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

  test('查看文件按流转发云端的响应：透传 Range，类型只取图片与视频，不在本机保存', async () => {
    const d = publish('sq_img', 'work', { format: 'image' }, { 'image.png': PNG })
    const hash = d.files[0]!.hash
    const whole = await call(`/api/square/files/${hash}`)
    expect(whole.headers.get('content-type')).toBe('image/png')
    expect(whole.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await whole.arrayBuffer())).toEqual(PNG)
    const part = await call(`/api/square/files/${hash}`, { headers: { range: 'bytes=4-' } })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe(`bytes 4-${PNG.length - 1}/${PNG.length}`)
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(PNG.subarray(4))
    expect(fileRanges.slice(-2)).toEqual(['', 'bytes=4-'])
    expect(await stat(join(squareDir(), 'files')).catch(() => null)).toBeNull()
  })
})

describe('安装', () => {
  test('作品没有安装', async () => {
    publish('sq_work', 'work', { format: 'image' }, { 'image.png': PNG })
    const res = await install('sq_work')
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

  test('下载中途断开时按 Range 从已收到处续传，核对哈希后安装', async () => {
    const md = `---\nname: 续传技能\ndescription: 中断后续传\n---\n\n${'正文。'.repeat(200)}`
    const d = publish('sq_resume', 'skill', {}, { 'SKILL.md': md })
    const hash = d.files[0]!.hash
    cutOnce.add(hash)
    const before = fileRanges.length
    const res = await install('sq_resume')
    expect(res.status).toBe(200)
    const ranges = fileRanges.slice(before)
    expect(ranges).toHaveLength(2)
    expect(ranges[0]).toBe('')
    expect(ranges[1]).toMatch(/^bytes=\d+-$/)
    expect(await readdir(join(squareDir(), 'stage'))).toEqual([])
  })

  test('取得的内容与哈希不一致时安装失败（502），不留快照目录', async () => {
    const d = publish(
      'sq_bad',
      'skill',
      {},
      { 'SKILL.md': '---\nname: 被改写\ndescription: 哈希不一致\n---\n' },
    )
    tampered.add(d.files[0]!.hash)
    const res = await install('sq_bad')
    expect(res.status).toBe(502)
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

  test('宠物添加到宠物库；皮肤替换当前的个性化；快照中的说明与许可证不作为图片', async () => {
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
        'README.md': '# 广场猫\n',
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
        LICENSE: 'MIT License\n',
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

/** 经 `/api/square/publish` 发布；`cover` 为视频封面。 */
async function publishLocal(manifest: Record<string, unknown>, cover?: Uint8Array) {
  uploaded = null
  const form = new FormData()
  form.set('manifest', JSON.stringify(manifest))
  if (cover) form.set('cover', new Blob([cover], { type: 'image/png' }), 'cover.png')
  return call('/api/square/publish', { method: 'POST', body: form })
}

describe('发布', () => {
  test('标题为空时 422 且不上传；通过时上传清单', async () => {
    const empty = await publishLocal({ title: ' ', summary: '', source: { kind: 'skin' } })
    expect(empty.status).toBe(422)
    expect(uploaded).toBeNull()
    const res = await publishLocal({ title: '夜色', summary: '', source: { kind: 'skin' } })
    expect(await res.json()).toEqual({ id: 'sq_new', version: 1, status: 'pending' })
    expect(uploaded!.path).toBe('/v1/square/items')
    expect(uploaded!.manifest).toMatchObject({ kind: 'skin', title: '夜色', meta: {} })
  })

  test('发布者的条目发布新版本', async () => {
    await publishLocal({
      title: '夜色',
      summary: '',
      itemId: 'sq_mine',
      source: { kind: 'skin' },
    })
    expect(uploaded!.path).toBe('/v1/square/items/sq_mine/versions')
  })

  test('MCP：env 只保留键', async () => {
    await writeFile(
      join(process.env.QYWORK_HOME!, 'mcp.json'),
      JSON.stringify({
        mcpServers: { secret: { command: 'qywork-x', env: { TOKEN: 'sk-real' } } },
      }),
    )
    const res = await publishLocal({
      title: 'X',
      summary: '',
      source: { kind: 'mcp', name: 'secret' },
    })
    expect(res.status).toBe(200)
    expect(uploaded!.manifest.meta).toEqual({
      name: 'secret',
      server: { command: 'qywork-x', env: { TOKEN: '' } },
    })
    expect(JSON.stringify(uploaded!.manifest)).not.toContain('sk-real')
  })

  test('技能：只能发布本机已安装的技能，打包时跳过字节码缓存', async () => {
    const dir = join(process.env.QYWORK_HOME!, 'skills', 'publish-demo')
    await mkdir(join(dir, '__pycache__'), { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: 发布示例\ndescription: 示例\n---\n')
    await writeFile(join(dir, '__pycache__', 'x.pyc'), 'x')
    const outside = await publishLocal({
      title: 'X',
      summary: '',
      source: { kind: 'skill', dir: workspaceRoot },
    })
    expect(outside.status).toBe(422)
    expect(
      (await publishLocal({ title: 'X', summary: '', source: { kind: 'skill', dir } })).status,
    ).toBe(200)
    expect([...uploaded!.files.keys()]).toEqual(['SKILL.md'])
  })

  test('画布：去掉生成记录、待取回的版本、自行添加接口的模型与参数选择；引用的文件与 Art 页面中的图片一并打包', async () => {
    await mkdir(join(workspaceRoot, 'pub', 'img'), { recursive: true })
    await writeFile(join(workspaceRoot, 'pub', 'a.png'), PNG)
    await writeFile(join(workspaceRoot, 'pub', 'img', 'b.png'), PNG)
    await writeFile(join(workspaceRoot, 'pub', 'page.html'), '<img src="img/b.png">')
    const gen = (provider: string) => ({
      id: `g_${provider}`,
      type: 'generate',
      output: 'image',
      name: provider,
      x: 0,
      y: 0,
      w: 100,
      h: 100,
      prompt: '海边',
      provider,
      model: 'm1',
      params: {},
      paramsByModel: { '["mine","m1"]': {} },
      versions: [
        {
          id: `${provider}-v1`,
          path: 'pub/a.png',
          made: {
            prompt: '海边',
            provider,
            model: 'm1',
            params: {},
            inputs: [],
            at: '2026-11-27T00:00:00.000Z',
          },
        },
        {
          id: `${provider}-v2`,
          path: 'pub/x.task.json',
          made: {
            prompt: '海边',
            provider,
            model: 'm1',
            params: {},
            inputs: [],
            at: '2026-11-27T00:00:00.000Z',
          },
        },
      ],
      current: `${provider}-v2`,
    })
    const doc = {
      version: 1,
      nodes: [
        { id: 'f1', type: 'file', path: 'pub/page.html', x: 0, y: 0, w: 100, h: 100 },
        gen('mine'),
        gen(CLOUD_PROVIDER),
      ],
      edges: [],
    }
    await writeFile(join(workspaceRoot, 'pub', 'demo.canvas.json'), JSON.stringify(doc))
    const res = await publishLocal({
      title: '画布',
      summary: '',
      source: { kind: 'canvas', path: 'pub/demo.canvas.json' },
    })
    expect(res.status).toBe(200)
    expect([...uploaded!.files.keys()].sort()).toEqual(
      ['canvas.json', 'files/pub/a.png', 'files/pub/img/b.png', 'files/pub/page.html'].sort(),
    )
    const sent = parseCanvas(new TextDecoder().decode(uploaded!.files.get('canvas.json')))
    expect(sent.ok).toBe(true)
    const nodes = sent.ok ? sent.doc.nodes : []
    expect(nodes[1]).not.toHaveProperty('provider')
    expect(nodes[1]).not.toHaveProperty('paramsByModel')
    expect(nodes[1]).toMatchObject({ versions: [{ id: 'mine-v1' }], current: 'mine-v1' })
    expect(nodes[2]).toMatchObject({ provider: CLOUD_PROVIDER, model: 'm1' })
    // 版本的生成记录中，自行添加接口的名称与模型同样删除。
    expect(nodes[1]).toMatchObject({ versions: [{ made: { provider: '', model: '' } }] })
    expect(nodes[2]).toMatchObject({ versions: [{ made: { provider: CLOUD_PROVIDER } }] })
  })

  test('作品：图片原样打包；视频须带封面；其余格式 422', async () => {
    await writeFile(join(workspaceRoot, 'pub', 'w.png'), PNG)
    await publishLocal({
      title: '图',
      summary: '',
      source: { kind: 'work', path: 'pub/w.png', prompt: '海边' },
    })
    expect(uploaded!.manifest.meta).toEqual({ format: 'image', prompt: '海边' })
    expect([...uploaded!.files.keys()]).toEqual(['image.png'])

    const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d])
    await writeFile(join(workspaceRoot, 'pub', 'v.mp4'), MP4)
    const noCover = await publishLocal({
      title: '片',
      summary: '',
      source: { kind: 'work', path: 'pub/v.mp4' },
    })
    expect(noCover.status).toBe(422)
    await publishLocal(
      { title: '片', summary: '', source: { kind: 'work', path: 'pub/v.mp4' } },
      PNG,
    )
    expect([...uploaded!.files.keys()].sort()).toEqual(['cover.png', 'video.mp4'])

    await writeFile(join(workspaceRoot, 'pub', 'n.txt'), 'x')
    expect(
      (await publishLocal({ title: 'X', summary: '', source: { kind: 'work', path: 'pub/n.txt' } }))
        .status,
    ).toBe(422)
  })

  test('宠物与皮肤取自本机的宠物库与当前个性化', async () => {
    const pet = (await listPets()).pets.find((p) => p.pack.name === '广场猫')!
    await publishLocal({ title: '猫', summary: '', source: { kind: 'pet', id: pet.id } })
    expect([...uploaded!.files.keys()].sort()).toEqual(['a.png', 'pet.json'])
    await publishLocal({ title: '皮肤', summary: '', source: { kind: 'skin' } })
    expect([...uploaded!.files.keys()].sort()).toEqual(['bg.png', 'skin.json'])
  })
})
