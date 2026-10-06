/**
 * 三层作用域的解析规则。
 *
 * 覆盖范围：`scopes.ts` 全部，以及 `memory.ts` / `skills.ts` 的跨层入口
 * （`listScopedEntries` / `scanSkills`）。它们只是为 `scanScoped` 传入各自的
 * 扫描器，无需再单独测试扫描逻辑，但同名条目的优先级必须逐个锁定：
 * 该规则出错时，界面列出的条目与模型执行的条目不同，且只在同名时出现。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listAllScopedEntries, listScopedEntries, readScoped } from './memory.ts'
import { type ScopeRoots, scanScoped, scopePaths, scopeRoots } from './scopes.ts'
import { scanAllSkills, scanSkills } from './skills.ts'

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
  return { builtin: builtinDir, project: await tmp(), global: await tmp(), builtinDir }
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
  test('项目层是工作区的 .agents/，全局层由 QYWORK_HOME 决定', () => {
    const before = process.env.QYWORK_HOME
    process.env.QYWORK_HOME = 'C:/fake-home'
    try {
      const r = scopeRoots('C:/ws')
      expect(r.project.replace(/\\/g, '/')).toBe('C:/ws/.agents')
      expect(r.global).toBe('C:/fake-home')
    } finally {
      if (before === undefined) delete process.env.QYWORK_HOME
      else process.env.QYWORK_HOME = before
    }
  })

  /** 内置层尚无内容。它不出现在任何界面上，因此不是空壳，而是尚未接入的预留位置。 */
  test('内置层目前没有根目录，遍历时跳过', () => {
    const paths = scopePaths({ builtin: null, project: 'C:/a', global: 'C:/b' }, 'skills')
    expect(paths.map((p) => p.scope)).toEqual(['project', 'global'])
  })

  test('三层都存在时顺序为 内置 → 项目 → 全局', () => {
    const paths = scopePaths({ builtin: 'C:/i', project: 'C:/a', global: 'C:/b' }, 'skills')
    expect(paths.map((p) => p.scope)).toEqual(['builtin', 'project', 'global'])
  })
})

describe('同名时先认领的条目生效', () => {
  test('scanScoped 按优先级去重，被覆盖的条目不出现', async () => {
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
   * 优先级规则是不可写的层最高，而不是范围最具体的层最高：内置层不能覆盖项目层时，
   * 项目层就能静默替换系统自身的行为。
   */
  test('记忆：项目层覆盖全局层，内置层覆盖项目层', async () => {
    const r = await roots()
    await writeMemory(r.global, 'style', '全局的')
    await writeMemory(r.project, 'style', '项目的')
    expect((await readScoped(r, 'style'))?.content).toBe('项目的')

    await writeMemory(r.builtinDir, 'style', '内置的')
    expect((await readScoped(r, 'style'))?.content).toBe('内置的')
  })

  test('记忆索引中同一个 key 只出现一次，并标明来源层', async () => {
    const r = await roots()
    await writeMemory(r.global, 'style', '全局的')
    await writeMemory(r.global, 'only-global', '只有全局有')
    await writeMemory(r.project, 'style', '项目的')

    const list = await listScopedEntries(r)
    expect(list.map((e) => e.key).sort()).toEqual(['only-global', 'style'])
    expect(list.find((e) => e.key === 'style')?.scope).toBe('project')
    expect(list.find((e) => e.key === 'only-global')?.scope).toBe('global')
  })

  /*
   * 技能同名与分层相互独立：同一层中的两个目录也能在 frontmatter 中声明同一个
   * `name`。因此按 name 去重，而不是按来源层去重。
   */
  test('技能按 name 去重，目录名不同也视为同名', async () => {
    const r = await roots()
    await writeSkill(r.global, 'release-global', 'release', '全局的发版流程')
    await writeSkill(r.project, 'release-here', 'release', '这个项目的发版流程')

    const skills = await scanSkills(r)
    expect(skills).toHaveLength(1)
    expect(skills[0]?.description).toBe('这个项目的发版流程')
    expect(skills[0]?.scope).toBe('project')
  })

  /** 技能目录必须是绝对路径：全局层的技能不在工作区中，无法用相对路径表示。 */
  test('技能返回绝对目录，read_skill 据此拼接 SKILL.md 路径', async () => {
    const r = await roots()
    await writeSkill(r.global, 'deploy', 'deploy', '部署')
    const [skill] = await scanSkills(r)
    expect(skill?.dir).toBe(join(r.global, 'skills', 'deploy'))
  })

  test('各层均无内容时返回空数组，不报错', async () => {
    expect(await scanSkills(await roots())).toEqual([])
    expect(await listScopedEntries(await roots())).toEqual([])
  })
})

/*
 * 设置页按层分列需要全部条目，而不是去重后的结果。
 *
 * 去重视图由全量视图派生（`scanScoped` 调用 `scanAllScopes`），因此这两组断言
 * 锁定同一次遍历的两个输出：全量输出必须包含被覆盖的条目，且逐条标明
 * 被哪一层覆盖；「在全局层修改后未生效」只能由该字段解释。
 */
describe('按层分列时包含被覆盖的条目，并标出覆盖它的层', () => {
  test('记忆：被覆盖的条目保留在其所在层，shadowedBy 指向覆盖它的层', async () => {
    const r = await roots()
    await writeMemory(r.global, 'style', '全局的')
    await writeMemory(r.global, 'only-global', '只有全局有')
    await writeMemory(r.project, 'style', '项目的')

    const all = await listAllScopedEntries(r)
    expect(all).toHaveLength(3)

    const shadowed = all.find((x) => x.item.key === 'style' && x.item.scope === 'global')
    expect(shadowed?.shadowedBy).toBe('project')

    const winner = all.find((x) => x.item.key === 'style' && x.item.scope === 'project')
    expect(winner?.shadowedBy).toBeNull()

    // 未被覆盖的条目不受影响，两个输出中都包含它。
    expect(all.find((x) => x.item.key === 'only-global')?.shadowedBy).toBeNull()
  })

  test('技能同理：同名技能保留在全局层一栏，并标为被项目层覆盖', async () => {
    const r = await roots()
    await writeSkill(r.global, 'release-global', 'release', '全局的发版流程')
    await writeSkill(r.project, 'release-here', 'release', '这个项目的发版流程')

    const all = await scanAllSkills(r)
    expect(all).toHaveLength(2)
    expect(all.find((x) => x.item.scope === 'global')?.shadowedBy).toBe('project')
    expect(all.find((x) => x.item.scope === 'project')?.shadowedBy).toBeNull()
  })

  /** 去重视图必须等于全量视图中未被覆盖的条目：两个输出来自同一次遍历。 */
  test('去重视图等于全量视图中 shadowedBy 为 null 的条目', async () => {
    const r = await roots()
    await writeMemory(r.global, 'style', '全局的')
    await writeMemory(r.global, 'only-global', '只有全局有')
    await writeMemory(r.project, 'style', '项目的')

    const all = await listAllScopedEntries(r)
    expect(all.filter((x) => x.shadowedBy === null).map((x) => x.item)).toEqual(
      await listScopedEntries(r),
    )
  })

  /** 内置层能覆盖项目层，因此它也可以作为覆盖方出现。 */
  test('内置层覆盖项目层时，标记为内置层', async () => {
    const r = await roots()
    await writeMemory(r.project, 'style', '项目的')
    await writeMemory(r.builtinDir, 'style', '内置的')

    const all = await listAllScopedEntries(r)
    expect(all.find((x) => x.item.scope === 'project')?.shadowedBy).toBe('builtin')
  })
})
