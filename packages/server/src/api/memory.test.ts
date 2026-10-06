/**
 * 记忆与技能接口。
 *
 * 覆盖范围：`api/memory.ts` 全部路由——`/api/memory`、`/api/memory/<key>`、
 * `/api/skills`（GET）、`/api/skills/import`、`/api/skills/<目录名>`（DELETE）。
 * 扫描逻辑本身由 `tools/src/scopes.test.ts` 锁定，此处不重复。
 *
 * 锁定按层分列的列表：被同名条目覆盖的条目同样列出，并标明由哪一层覆盖；
 * 删除路径只接受单个目录名。
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

/** 一个工作区与一个临时的全局根。两层均可写入记忆。 */
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

/** 只需要 `workspaceRoot` 一个字段，其余字段不构造：构造后即成为集成测试。 */
function call(root: string, path: string, init?: RequestInit): Promise<Response | null> {
  const url = new URL(`http://x${path}`)
  return handleMemoryApi(url, new Request(url.href, init), {
    workspaceRoot: root,
  } as unknown as ApiRequestDeps)
}

describe('记忆列表按层分列', () => {
  test('返回两层的全部条目，被覆盖的条目标明覆盖它的层', async () => {
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

describe('删除技能', () => {
  test('按目录名删除，删除后扫描不到；删除不存在的技能返回 404', async () => {
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
   * 单独一段 `..` 无法到达处理器：`new URL()` 在解析阶段将它与上一段一并消去
   * （`/api/skills/..` → `/api/`），路由不匹配。编码为 `%2E%2E` 同样如此，
   * WHATWG 先解码再消去。能够到达处理器的只有下列几种形式，因此拦截的正是它们。
   */
  test('目录名含分隔符或 .. 的删除请求被拒绝，否则构成任意目录删除', async () => {
    const { root } = await workspace()
    for (const name of ['a%2Fb', 'a%5Cb', '%2e%2e%2f', '%2e%2e%5cx']) {
      const res = await call(root, `/api/skills/${name}?scope=project`, { method: 'DELETE' })
      expect(res!.status).toBe(400)
    }
  })
})

describe('导入技能目录', () => {
  test('目录中没有 SKILL.md 时拒绝，否则导入的技能无法被扫描到', async () => {
    const { root } = await workspace()
    const src = await mkdtemp(join(tmpdir(), 'qywork-skillsrc-'))
    dirs.push(src)
    const res = await call(root, '/api/skills/import', {
      method: 'POST',
      body: JSON.stringify({ scope: 'project', path: src }),
    })
    expect(res!.status).toBe(422)
  })

  test('复制整个目录，附带的文件一并复制', async () => {
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
    // 附带脚本必须一并复制：技能不是单个 markdown 文件，这也是它不在网页上编辑的原因。
    expect(await readFile(join(found[0]!.dir, 'run.sh'), 'utf8')).toBe('echo hi')
  })
})
