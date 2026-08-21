/**
 * 记忆与技能接口。
 *
 * 覆盖范围：`api/memory.ts` 全部路由——`/api/memory`、`/api/memory/<key>`、
 * `/api/skills`（GET）、`/api/skills/import`、`/api/skills/<目录名>`（DELETE）。
 * 扫描逻辑本身由 `tools/src/scopes.test.ts` 钉住，这里不重复。
 *
 * 钉的是**按层分列引入的那条新风险**：列表现在把被盖住的条目也列出来，用户
 * 因此点得开一条不生效的全局记忆。读单条如果还按优先级找，编辑框里装的就是
 * 项目层那份正文，而保存写回的是全局那份——一次不改任何字的保存就把两层
 * 洗成同一份，静默且不可恢复。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { scanSkills, scopeRoots } from '@qywork/tools'
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

describe('删一个技能', () => {
  test('删的是目录名，删完就扫不到了；删一个不存在的回 404', async () => {
    const { root } = await workspace()
    const dir = join(root, '.agents', 'skills', 'release')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: release\ndescription: 发版\n---\n', 'utf8')
    expect(await scanSkills(scopeRoots(root))).toHaveLength(1)
    expect(
      (await call(root, '/api/skills/release?scope=project', { method: 'DELETE' }))!.status,
    ).toBe(200)
    expect(await scanSkills(scopeRoots(root))).toEqual([])
    expect(
      (await call(root, '/api/skills/release?scope=project', { method: 'DELETE' }))!.status,
    ).toBe(404)
  })

  /*
   * 单独一段 `..` 到不了这里：`new URL()` 在解析阶段就把它连同上一段一起折掉
   * （`/api/skills/..` → `/api/`），那条路由压根不匹配。编码成 `%2E%2E` 也一样，
   * WHATWG 先解码再折。**留下来能到达处理器的是这几种**，所以挡的就是它们。
   */
  test('目录名里带分隔符或 .. 的删除请求被拒——那是一条任意目录删除', async () => {
    const { root } = await workspace()
    for (const name of ['a%2Fb', 'a%5Cb', '%2e%2e%2f', '%2e%2e%5cx']) {
      const res = await call(root, `/api/skills/${name}?scope=project`, { method: 'DELETE' })
      expect(res!.status).toBe(400)
    }
  })
})

describe('导入一个技能目录', () => {
  test('目录里没有 SKILL.md 就拒绝——不然导进来的东西一条都扫不到', async () => {
    const { root } = await workspace()
    const src = await mkdtemp(join(tmpdir(), 'qywork-skillsrc-'))
    dirs.push(src)
    const res = await call(root, '/api/skills/import', {
      method: 'POST',
      body: JSON.stringify({ scope: 'project', path: src }),
    })
    expect(res!.status).toBe(422)
  })

  test('整个目录拷进来，附带的文件一起过去', async () => {
    const { root } = await workspace()
    const src = await mkdtemp(join(tmpdir(), 'qywork-skillsrc-'))
    dirs.push(src)
    await writeFile(
      join(src, 'SKILL.md'),
      '---\nname: deploy\ndescription: 部署流程\n---\n正文',
      'utf8',
    )
    await writeFile(join(src, 'run.sh'), 'echo hi', 'utf8')

    const res = await call(root, '/api/skills/import', {
      method: 'POST',
      body: JSON.stringify({ scope: 'project', path: src }),
    })
    expect(res!.status).toBe(200)

    const found = await scanSkills(scopeRoots(root))
    expect(found.map((s) => s.name)).toEqual(['deploy'])
    // 附带脚本必须一起过去：技能不是单个 markdown，那正是它不能在网页上编辑的原因。
    expect(await readFile(join(found[0]!.dir, 'run.sh'), 'utf8')).toBe('echo hi')
  })
})
