/**
 * 记忆接口的分层语义。
 *
 * 覆盖范围：`api/memory.ts` 的 `/api/memory` 与 `/api/memory/<key>`。
 * 技能那条只读，扫描逻辑由 `tools/src/scopes.test.ts` 钉住，这里不再重复。
 *
 * 钉的是**按层分列引入的那条新风险**：列表现在把被盖住的条目也列出来，用户
 * 因此点得开一条不生效的全局记忆。读单条如果还按优先级找，编辑框里装的就是
 * 项目层那份正文，而保存写回的是全局那份——一次不改任何字的保存就把两层
 * 洗成同一份，静默且不可恢复。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleMemoryApi } from './memory.ts'
import type { ApiRequestDeps } from './types.ts'

const dirs: string[] = []
const homeBefore = process.env.QYWORK_HOME

afterEach(async () => {
  if (homeBefore === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = homeBefore
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

/** 一个工作区 + 一个临时的全局根。两层各自能写记忆。 */
async function workspace(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(join(tmpdir(), 'qywork-memapi-ws-'))
  const home = await mkdtemp(join(tmpdir(), 'qywork-memapi-home-'))
  dirs.push(root, home)
  process.env.QYWORK_HOME = home
  return { root, home }
}

async function write(root: string, key: string, body: string): Promise<void> {
  await mkdir(join(root, 'memory'), { recursive: true })
  await writeFile(join(root, 'memory', `${key}.md`), body, 'utf8')
}

/** 只用得到 `workspaceRoot` 一个字段，其余不造——造了就成了集成测试。 */
function call(root: string, path: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(`http://x${path}`)
  return handleMemoryApi(url, new Request(url.href, init), {
    workspaceRoot: root,
  } as unknown as ApiRequestDeps)
}

describe('记忆列表按层分列', () => {
  test('两层的条目都回，被盖住的那条标出是谁盖的', async () => {
    const { root, home } = await workspace()
    await write(join(root, '.agents'), 'style', '项目的')
    await write(home, 'style', '全局的')
    await write(home, 'only-global', '只有全局有')

    const body = (await (await call(root, '/api/memory'))!.json()) as {
      entries: { key: string; scope: string; shadowedBy: string | null }[]
    }
    expect(body.entries).toHaveLength(3)
    expect(body.entries.find((e) => e.key === 'style' && e.scope === 'global')?.shadowedBy).toBe(
      'project',
    )
    expect(
      body.entries.find((e) => e.key === 'style' && e.scope === 'project')?.shadowedBy,
    ).toBeNull()
    expect(body.entries.find((e) => e.key === 'only-global')?.shadowedBy).toBeNull()
  })
})

describe('读单条认作用域', () => {
  test('被盖住的全局条目，读回来的是全局那份正文', async () => {
    const { root, home } = await workspace()
    await write(join(root, '.agents'), 'style', '项目的')
    await write(home, 'style', '全局的')

    const g = (await (await call(root, '/api/memory/style?scope=global'))!.json()) as {
      content: string
      scope: string
    }
    expect(g.content.trim()).toBe('全局的')
    expect(g.scope).toBe('global')

    const p = (await (await call(root, '/api/memory/style?scope=project'))!.json()) as {
      content: string
    }
    expect(p.content.trim()).toBe('项目的')
  })

  test('这一层没有这条时回 404，而不是回另一层那份', async () => {
    const { root } = await workspace()
    await write(join(root, '.agents'), 'style', '项目的')
    expect((await call(root, '/api/memory/style?scope=global'))!.status).toBe(404)
  })
})

describe('写单条认作用域', () => {
  test('存到全局不会碰项目层那份', async () => {
    const { root, home } = await workspace()
    await write(join(root, '.agents'), 'style', '项目的')
    await write(home, 'style', '全局的')

    const res = await call(root, '/api/memory/style?scope=global', {
      method: 'PUT',
      body: JSON.stringify({ content: '改过的全局' }),
    })
    expect(res!.status).toBe(200)

    const g = (await (await call(root, '/api/memory/style?scope=global'))!.json()) as {
      content: string
    }
    const p = (await (await call(root, '/api/memory/style?scope=project'))!.json()) as {
      content: string
    }
    expect(g.content.trim()).toBe('改过的全局')
    expect(p.content.trim()).toBe('项目的')
  })

  test('不认的层名回 400，不落盘', async () => {
    const { root } = await workspace()
    const res = await call(root, '/api/memory/style?scope=builtin', {
      method: 'PUT',
      body: JSON.stringify({ content: 'x' }),
    })
    expect(res!.status).toBe(400)
  })
})
