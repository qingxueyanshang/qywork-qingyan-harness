/**
 * 导入一份现成的 MCP 配置。
 *
 * 覆盖范围：`api/mcp.ts` 的 `/api/mcp/import`。`/api/mcp` GET 要真的连一批 server，
 * 不在这里测。
 *
 * 钉的是三条**静默失败**——它们都不会报错，只会让用户对着一个没有任何变化的界面查半天：
 *
 * - 指错文件（里面一条 server 都解析不出来）必须 422，不能「导入成功」然后列表不变。
 * - 同名 server 必须 409，**不能覆盖**：覆盖会把用户自己配好的那份抹掉。
 * - 写回时必须用本层**已经在用的那个键**：解析器同时认 `servers` 与 `mcpServers`
 *   但只取一份且 `servers` 优先，写错键的话并进来的这几条会被整份忽略。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleMcpApi } from './mcp.ts'
import type { ApiRequestDeps } from './types.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {})
})

function call(root: string, path: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(`http://x${path}`)
  return handleMcpApi(url, new Request(url.href, init), {
    workspaceRoot: root,
  } as unknown as ApiRequestDeps)
}

/** 一个工作区，外加它项目层的 `mcp.json` 路径。 */
async function workspace(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'qywork-mcpws-'))
  dirs.push(root)
  await mkdir(join(root, '.agents'), { recursive: true })
  return { root, file: join(root, '.agents', 'mcp.json') }
}

/** 一份放在本机别处的现成配置，模拟从别的客户端拷过来的那一份。 */
async function incoming(body: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-mcpsrc-'))
  dirs.push(dir)
  const file = join(dir, 'mcp.json')
  await writeFile(file, JSON.stringify(body), 'utf8')
  return file
}

const ONE = { mcpServers: { fs: { command: 'npx', args: ['-y', 'server-filesystem'] } } }
/** 读回落盘的那份。值再往下就是 server 名到配置的映射，测试只比对它。 */
const read = (f: string): Promise<Record<string, Record<string, unknown>>> =>
  readFile(f, 'utf8').then((t) => JSON.parse(t) as Record<string, Record<string, unknown>>)

describe('导入一份现成的 MCP 配置', () => {
  test('不给路径回 400', async () => {
    const { root } = await workspace()
    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res!.status).toBe(400)
  })

  test('读不到那个文件回 422', async () => {
    const { root } = await workspace()
    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({ path: join(root, 'nope.json') }),
    })
    expect(res!.status).toBe(422)
  })

  test('一条 server 都解析不出来就拒绝——不然是「导入成功」而列表一条不变', async () => {
    const { root, file } = await workspace()
    // 既没有 command 也没有 url，解析器会把它整条忽略。
    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({ path: await incoming({ mcpServers: { bad: {} } }) }),
    })
    expect(res!.status).toBe(422)
    expect(await readFile(file, 'utf8').catch(() => null)).toBe(null)
  })

  test('本层还没有配置时直接建出来', async () => {
    const { root, file } = await workspace()
    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({ path: await incoming(ONE) }),
    })
    expect(res!.status).toBe(200)
    expect(await res!.json()).toMatchObject({ ok: true, names: ['fs'] })
    expect((await read(file)).mcpServers).toEqual(ONE.mcpServers)
  })

  test('并进已有配置，原来那几条一个不动', async () => {
    const { root, file } = await workspace()
    await writeFile(file, JSON.stringify({ mcpServers: { old: { command: 'echo' } } }), 'utf8')
    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({ path: await incoming(ONE) }),
    })
    expect(res!.status).toBe(200)
    expect(Object.keys((await read(file)).mcpServers ?? {})).toEqual(['old', 'fs'])
  })

  test('同名回 409，**本层那一份原样不动**', async () => {
    const { root, file } = await workspace()
    const mine = { mcpServers: { fs: { command: '我自己配的' } } }
    await writeFile(file, JSON.stringify(mine), 'utf8')

    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({ path: await incoming(ONE) }),
    })
    expect(res!.status).toBe(409)
    expect((await read(file)).mcpServers).toEqual(mine.mcpServers)
  })

  /*
   * 解析器同时认 `servers` 与 `mcpServers`，但**只取一份**且 `servers` 优先
   * （`packages/mcp/src/load.ts` 的 `obj.servers ?? obj.mcpServers`）。所以本层原文用
   * `servers` 的时候，往 `mcpServers` 里写等于写进一个永远不会被读的键——
   * 界面上不报任何错，列表也一条不变。
   */
  test('本层用的是 servers 键时就写进 servers，不另起一个 mcpServers', async () => {
    const { root, file } = await workspace()
    await writeFile(file, JSON.stringify({ servers: { old: { command: 'echo' } } }), 'utf8')
    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({ path: await incoming(ONE) }),
    })
    expect(res!.status).toBe(200)
    const saved = await read(file)
    expect(Object.keys(saved.servers ?? {})).toEqual(['old', 'fs'])
    expect(saved.mcpServers).toBeUndefined()
  })

  test('本层原文解析不了时只报错、不覆盖', async () => {
    const { root, file } = await workspace()
    await writeFile(file, '{ 这不是 JSON', 'utf8')
    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({ path: await incoming(ONE) }),
    })
    expect(res!.status).toBe(422)
    expect(await readFile(file, 'utf8')).toBe('{ 这不是 JSON')
  })
})
