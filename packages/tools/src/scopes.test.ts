/**
 * 三层作用域的解析规则。
 *
 * 覆盖范围：`scopes.ts` 全部，以及 `memory.ts` / `skills.ts` 的跨层入口
 * （`listScopedEntries` / `scanSkills`）——它们只是把 `scanScoped` 套上各自的
 * 扫描器，单独再测一遍扫描逻辑没有意义，但**「同名谁赢」必须逐个钉住**：
 * 这条错了的表现是「界面上列的是一条、模型跑的是另一条」，而且只在同名时才犯。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listScopedEntries, readScoped } from './memory.ts'
import { type ScopeRoots, scanScoped, scopePaths, scopeRoots } from './scopes.ts'
import { scanSkills } from './skills.ts'

const dirs: string[] = []

async function tmp(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'qywork-scope-'))
  dirs.push(d)
  return d
}

afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

async function roots(): Promise<ScopeRoots & { builtinDir: string }> {
  const builtinDir = await tmp()
  return { builtin: builtinDir, user: await tmp(), global: await tmp(), builtinDir }
}

async function writeMemory(root: string, key: string, body: string): Promise<void> {
  await mkdir(join(root, 'memory'), { recursive: true })
  await writeFile(join(root, 'memory', `${key}.md`), body, 'utf8')
}

async function writeSkill(root: string, dir: string, name: string, desc: string): Promise<void> {
  await mkdir(join(root, 'skills', dir), { recursive: true })
  await writeFile(
    join(root, 'skills', dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${desc}\n---\n正文`,
    'utf8',
  )
}

describe('三层的根', () => {
  test('用户层是工作区的 .agents/，全局层跟着 QYWORK_HOME 走', () => {
    const before = process.env.QYWORK_HOME
    process.env.QYWORK_HOME = 'C:/fake-home'
    try {
      const r = scopeRoots('C:/ws')
      expect(r.user.replace(/\\/g, '/')).toBe('C:/ws/.agents')
      expect(r.global).toBe('C:/fake-home')
    } finally {
      if (before === undefined) delete process.env.QYWORK_HOME
      else process.env.QYWORK_HOME = before
    }
  })

  /** 内置层还没有内容。**它不出现在任何界面上**，所以这不是空壳，是一个未接的槽。 */
  test('内置层现在没有根，遍历时直接跳过', () => {
    const paths = scopePaths({ builtin: null, user: 'C:/a', global: 'C:/b' }, 'skills')
    expect(paths.map((p) => p.scope)).toEqual(['user', 'global'])
  })

  test('三层都在时顺序是 内置 → 用户 → 全局', () => {
    const paths = scopePaths({ builtin: 'C:/i', user: 'C:/a', global: 'C:/b' }, 'skills')
    expect(paths.map((p) => p.scope)).toEqual(['builtin', 'user', 'global'])
  })
})

describe('同名先认领的赢', () => {
  test('scanScoped 按优先级去重，被盖掉的那份不出现', async () => {
    const r = await roots()
    const out = await scanScoped(
      r,
      'x',
      async (_dir, scope) => [{ id: 'same', scope }],
      (i) => i.id,
    )
    expect(out).toEqual([{ id: 'same', scope: 'builtin' }])
  })

  /*
   * 优先级是「谁不可写谁最高」，不是「谁具体谁最高」——内置压不住用户层的话，
   * 用户层就能悄悄替换掉系统自己的行为。
   */
  test('记忆：用户层盖住全局层，内置层盖住用户层', async () => {
    const r = await roots()
    await writeMemory(r.global, 'style', '全局的')
    await writeMemory(r.user, 'style', '用户的')
    expect((await readScoped(r, 'style'))?.content).toBe('用户的')

    await writeMemory(r.builtinDir, 'style', '内置的')
    expect((await readScoped(r, 'style'))?.content).toBe('内置的')
  })

  test('记忆索引里同一个 key 只出现一次，并带上它来自哪层', async () => {
    const r = await roots()
    await writeMemory(r.global, 'style', '全局的')
    await writeMemory(r.global, 'only-global', '只有全局有')
    await writeMemory(r.user, 'style', '用户的')

    const list = await listScopedEntries(r)
    expect(list.map((e) => e.key).sort()).toEqual(['only-global', 'style'])
    expect(list.find((e) => e.key === 'style')?.scope).toBe('user')
    expect(list.find((e) => e.key === 'only-global')?.scope).toBe('global')
  })

  /*
   * 技能同名**和分层是两件事**：同一层里两个目录也能在 frontmatter 里声明同一个
   * `name`。所以去重按 name 做，不是按「来自哪一层」。
   */
  test('技能按 name 去重，目录名不同也算同名', async () => {
    const r = await roots()
    await writeSkill(r.global, 'release-global', 'release', '全局的发版流程')
    await writeSkill(r.user, 'release-here', 'release', '这个项目的发版流程')

    const skills = await scanSkills(r)
    expect(skills).toHaveLength(1)
    expect(skills[0]?.description).toBe('这个项目的发版流程')
    expect(skills[0]?.scope).toBe('user')
  })

  /** 技能目录必须是绝对路径：全局层那些根本不在工作区里，相对路径表达不了。 */
  test('技能回的是绝对目录，read_skill 才拼得出 SKILL.md', async () => {
    const r = await roots()
    await writeSkill(r.global, 'deploy', 'deploy', '部署')
    const [skill] = await scanSkills(r)
    expect(skill?.dir).toBe(join(r.global, 'skills', 'deploy'))
  })

  test('一层都没有内容时是空数组，不是错误', async () => {
    expect(await scanSkills(await roots())).toEqual([])
    expect(await listScopedEntries(await roots())).toEqual([])
  })
})
