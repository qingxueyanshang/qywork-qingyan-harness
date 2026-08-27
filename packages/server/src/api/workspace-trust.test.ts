/**
 * 项目信任。
 *
 * 覆盖范围：`api/workspace.ts` 的 `/api/workspace` GET 里的 `pendingTrust`
 * 与 `/api/workspace/trust`。
 *
 * 钉的是这条闸两头都通：**有待决定的事时说得出来**（否则那个弹窗永远不出现，
 * 整条链路等于没接），**两个方向都落盘**（只接授权那一半的界面没有出路）。
 * 「未信任时项目层不加载」那一半在 `runtime/extensions.test.ts` 里验。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isWorkspaceTrusted, loadConfig } from '@qywork/runtime'
import type { ApiRequestDeps } from './types.ts'
import { handleWorkspaceApi } from './workspace.ts'

const dirs: string[] = []
const prevHome = process.env.QYWORK_HOME

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'qywork-wshome-'))
  dirs.push(home)
  process.env.QYWORK_HOME = home
})

afterEach(async () => {
  if (prevHome === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = prevHome
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }).catch(() => {})
})

function call(root: string, path: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(`http://x${path}`)
  return handleWorkspaceApi(url, new Request(url.href, init), {
    workspaceRoot: root,
    workspaceId: 'ws_test',
  } as unknown as ApiRequestDeps)
}

/** 一个工作区。`mcp` 为空时不写 `.agents/mcp.json`。 */
async function workspace(mcp?: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'qywork-wstrust-'))
  dirs.push(root)
  if (mcp !== undefined) {
    await mkdir(join(root, '.agents'), { recursive: true })
    await writeFile(join(root, '.agents', 'mcp.json'), JSON.stringify(mcp), 'utf8')
  }
  return root
}

const ONE = { mcpServers: { repo: { command: 'node', args: ['-e', ''] } } }

const pendingOf = async (root: string): Promise<string[]> => {
  const res = await call(root, '/api/workspace')
  return ((await res?.json()) as { pendingTrust: string[] }).pendingTrust
}

describe('项目信任', () => {
  test('没有项目层配置时没有待决定的事', async () => {
    expect(await pendingOf(await workspace())).toEqual([])
  })

  test('项目层声明了 server 而未信任时，名字报得出来', async () => {
    expect(await pendingOf(await workspace(ONE))).toEqual(['repo'])
  })

  test('信任之后不再报，撤销之后又报', async () => {
    const root = await workspace(ONE)

    const on = await call(root, '/api/workspace/trust', {
      method: 'POST',
      body: JSON.stringify({ trusted: true }),
    })
    expect(on?.status).toBe(200)
    expect(isWorkspaceTrusted(await loadConfig(), root)).toBe(true)
    expect(await pendingOf(root)).toEqual([])

    const off = await call(root, '/api/workspace/trust', {
      method: 'POST',
      body: JSON.stringify({ trusted: false }),
    })
    expect(off?.status).toBe(200)
    expect(await pendingOf(root)).toEqual(['repo'])
  })

  test('不带 trusted 回 400', async () => {
    const res = await call(await workspace(ONE), '/api/workspace/trust', {
      method: 'POST',
      body: '{}',
    })
    expect(res?.status).toBe(400)
  })
})
