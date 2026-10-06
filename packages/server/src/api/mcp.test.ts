/**
 * 导入现有的 MCP 配置。
 *
 * 覆盖范围：`api/mcp.ts` 的 `/api/mcp/import`。`/api/mcp` GET 需要实际连接一批 server，
 * 不在此处测试。
 *
 * 锁定三种静默失败：它们都不报错，只会让用户面对一个没有任何变化的界面长时间排查。
 *
 * - 指定了错误的文件（其中解析不出任何 server）必须返回 422，不能报告导入成功而列表不变。
 * - 同名 server 必须返回 409，不能覆盖：覆盖会抹掉用户自己配置的条目。
 * - 写回时必须使用本层已在使用的键：解析器同时识别 `servers` 与 `mcpServers`，
 *   但只取其中一个且 `servers` 优先，写错键时合并进来的条目会被整体忽略。
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

/** 一个工作区及其项目层的 `mcp.json` 路径。 */
async function workspace(): Promise<{ root: string; file: string }> {
  const root = await mkdtemp(join(tmpdir(), 'qywork-mcpws-'))
  dirs.push(root)
  await mkdir(join(root, '.agents'), { recursive: true })
  return { root, file: join(root, '.agents', 'mcp.json') }
}

/** 放在本机其他位置的现有配置，模拟从其他客户端复制来的配置文件。 */
async function incoming(body: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-mcpsrc-'))
  dirs.push(dir)
  const file = join(dir, 'mcp.json')
  await writeFile(file, JSON.stringify(body), 'utf8')
  return file
}

const ONE = { mcpServers: { fs: { command: 'fixture-disabled', enabled: false } } }
/** 读取写入磁盘的配置。第二层是 server 名到配置的映射，测试只比对这一层。 */
const read = (f: string): Promise<Record<string, Record<string, unknown>>> =>
  readFile(f, 'utf8').then((t) => JSON.parse(t) as Record<string, Record<string, unknown>>)

describe('导入现有的 MCP 配置', () => {
  test('未提供路径时返回 400', async () => {
    const { root } = await workspace()
    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    expect(res!.status).toBe(400)
  })

  test('无法读取指定文件时返回 422', async () => {
    const { root } = await workspace()
    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({ path: join(root, 'nope.json') }),
    })
    expect(res!.status).toBe(422)
  })

  test('解析不出任何 server 时拒绝，不报告导入成功而列表不变', async () => {
    const { root, file } = await workspace()
    // 既没有 command 也没有 url，解析器会忽略整个条目。
    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({ path: await incoming({ mcpServers: { bad: {} } }) }),
    })
    expect(res!.status).toBe(422)
    expect(await readFile(file, 'utf8').catch(() => null)).toBe(null)
  })

  test('本层尚无配置时直接创建', async () => {
    const { root, file } = await workspace()
    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({ path: await incoming(ONE) }),
    })
    expect(res!.status).toBe(200)
    expect(await res!.json()).toMatchObject({ ok: true, names: ['fs'] })
    expect((await read(file)).mcpServers).toEqual(ONE.mcpServers)
  })

  test('合并到已有配置，原有条目保持不变', async () => {
    const { root, file } = await workspace()
    await writeFile(
      file,
      JSON.stringify({ mcpServers: { old: { command: 'echo', enabled: false } } }),
      'utf8',
    )
    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({ path: await incoming(ONE) }),
    })
    expect(res!.status).toBe(200)
    expect(Object.keys((await read(file)).mcpServers ?? {})).toEqual(['old', 'fs'])
  })

  test('同名时返回 409，本层配置保持不变', async () => {
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
   * 解析器同时识别 `servers` 与 `mcpServers`，但只取其中一个且 `servers` 优先
   * （`packages/mcp/src/load.ts` 的 `obj.servers ?? obj.mcpServers`）。因此本层原文使用
   * `servers` 时，写入 `mcpServers` 等于写入一个永远不会被读取的键：
   * 界面不报任何错误，列表也不变。
   */
  test('本层使用 servers 键时写入 servers，不另建 mcpServers', async () => {
    const { root, file } = await workspace()
    await writeFile(
      file,
      JSON.stringify({ servers: { old: { command: 'echo', enabled: false } } }),
      'utf8',
    )
    const res = await call(root, '/api/mcp/import?scope=project', {
      method: 'POST',
      body: JSON.stringify({ path: await incoming(ONE) }),
    })
    expect(res!.status).toBe(200)
    const saved = await read(file)
    expect(Object.keys(saved.servers ?? {})).toEqual(['old', 'fs'])
    expect(saved.mcpServers).toBeUndefined()
  })

  test('本层原文无法解析时只报错，不覆盖', async () => {
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
