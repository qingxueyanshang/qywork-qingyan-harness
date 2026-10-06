import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openBatchBudget, type ToolContext } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import {
  deleteMemoryTool,
  listEntries,
  MEMORY_DIR,
  moveMemoryTool,
  readMemoryTool,
  writeMemoryTool,
} from './memory.ts'
import {
  moveSkillTool,
  parseFrontmatter,
  readSkillTool,
  SKILLS_DIR,
  scanSkills,
  writeSkillTool,
} from './skills.ts'

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'qywork-ms-'))
}

function ctx(root: string, approve = true): ToolContext {
  return {
    workspaceRoot: root,
    conversationId: 'cv',
    runId: 'rn',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () =>
      approve ? { allowed: true } : { allowed: false, reason: '夹具拒绝' },
  }
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const before = process.env.QYWORK_HOME
  const home = await workspace()
  process.env.QYWORK_HOME = home
  try {
    return await fn(home)
  } finally {
    if (before === undefined) delete process.env.QYWORK_HOME
    else process.env.QYWORK_HOME = before
  }
}

describe('记忆', () => {
  test('写入后可以读取，并保存为工作区中的普通文件', async () => {
    const root = await workspace()
    const c = ctx(root)
    const w = await writeMemoryTool.fn({ key: '包管理器', content: '本项目用 pnpm' }, c)
    expect(w.status).toBe('success')

    const r = await readMemoryTool.fn({ key: '包管理器' }, c)
    expect(r.message).toContain('本项目用 pnpm')

    // 用户可以直接查看、修改和删除：这是不存入 SQLite 的全部理由。
    const raw = await Bun.file(join(root, MEMORY_DIR, '包管理器.md')).text()
    expect(raw).toContain('本项目用 pnpm')
  })

  test('明确指定 global 时只写入全局目录，并可按层读取', async () => {
    await withTempHome(async (home) => {
      const root = await workspace()
      const c = ctx(root)
      const w = await writeMemoryTool.fn(
        { key: '全局偏好', content: '所有项目都使用这条', scope: 'global' },
        c,
      )
      expect(w.status).toBe('success')
      expect(await Bun.file(join(home, 'memory', '全局偏好.md')).exists()).toBe(true)
      expect(await Bun.file(join(root, MEMORY_DIR, '全局偏好.md')).exists()).toBe(false)

      const r = await readMemoryTool.fn({ key: '全局偏好', scope: 'global' }, c)
      expect(r.data).toMatchObject({ key: '全局偏好', scope: 'global' })
    })
  })

  test('迁移记忆成功后只保留目标副本', async () => {
    await withTempHome(async (home) => {
      const root = await workspace()
      const c = ctx(root)
      await writeMemoryTool.fn({ key: 'style', content: '不要 emoji' }, c)
      const moved = await moveMemoryTool.fn(
        { key: 'style', from_scope: 'project', to_scope: 'global' },
        c,
      )
      expect(moved.status).toBe('success')
      expect(await Bun.file(join(root, MEMORY_DIR, 'style.md')).exists()).toBe(false)
      expect(await Bun.file(join(home, 'memory', 'style.md')).exists()).toBe(true)
    })
  })

  test('索引只给首行摘要，不给全文', async () => {
    const root = await workspace()
    await writeMemoryTool.fn({ key: 'k', content: '第一行摘要\n第二行不该出现在索引里' }, ctx(root))
    const entries = await listEntries(join(root, MEMORY_DIR))
    expect(entries[0]!.preview).toBe('第一行摘要')
    // 索引每轮都进入上下文末尾，放入全文即每轮都为全文付费。
    expect(entries[0]!.preview).not.toContain('第二行不该出现')
  })

  test('删除后无法读取', async () => {
    const root = await workspace()
    const c = ctx(root)
    await writeMemoryTool.fn({ key: 'tmp', content: 'x' }, c)
    expect((await deleteMemoryTool.fn({ key: 'tmp' }, c)).status).toBe('success')
    expect((await readMemoryTool.fn({ key: 'tmp' }, c)).errorKind).toBe('not_found')
  })

  test('key 中的路径穿越被移除', async () => {
    const root = await workspace()
    const r = await writeMemoryTool.fn({ key: '../../../etc/passwd', content: 'x' }, ctx(root))
    // 规范化后只剩普通文件名，不会写入工作区之外。
    expect(r.status).toBe('success')
    const entries = await listEntries(join(root, MEMORY_DIR))
    expect(entries.every((e) => !e.key.includes('..'))).toBe(true)
  })

  test('全部由非法字符组成的 key 被拒绝', async () => {
    const root = await workspace()
    expect((await writeMemoryTool.fn({ key: '///', content: 'x' }, ctx(root))).status).toBe(
      'failure',
    )
  })

  test('超长内容被拒绝：应写成文档而不是记忆', async () => {
    const root = await workspace()
    const r = await writeMemoryTool.fn({ key: 'big', content: 'x'.repeat(5000) }, ctx(root))
    expect(r.status).toBe('failure')
    expect(r.message).toContain('文档')
  })

  /**
   * 拆分为多个工具名的原因：必填参数由 schema 拦截。合并为一个 `action` 门面时，
   * `required` 只剩分派字段，写记忆而未提供 key 时须执行完一整轮往返才报错。
   */
  test('必填参数写在 schema 里，而不是执行到工具体内才报错', () => {
    const required = (s: { parameters: Record<string, unknown> }) => s.parameters.required
    expect(required(readMemoryTool)).toEqual(['key'])
    expect(required(writeMemoryTool)).toEqual(['key', 'content'])
    expect(required(deleteMemoryTool)).toEqual(['key'])
    expect(required(moveMemoryTool)).toEqual(['key', 'from_scope', 'to_scope'])
  })

  test('读取记忆不经过权限检查，写入与删除各自经过对应的权限检查', () => {
    expect(readMemoryTool.permissionEffect).toBe('internal_control')
    expect(writeMemoryTool.permissionEffect).toBe('write')
    expect(deleteMemoryTool.permissionEffect).toBe('delete')
    expect(moveMemoryTool.permissionEffect).toBe('delete')
  })

  test('动作是常量：一个工具名对应一个动作，无需从参数推算', () => {
    expect(readMemoryTool.actionKind).toBe('read')
    expect(writeMemoryTool.actionKind).toBe('write')
    expect(deleteMemoryTool.actionKind).toBe('delete')
    expect(moveMemoryTool.actionKind).toBe('edit')
  })

  test('空目录返回空列表而不是抛出异常', async () => {
    expect(await listEntries(join(await workspace(), MEMORY_DIR))).toEqual([])
  })
})

describe('技能前置元信息', () => {
  test('解析 name 与 description', () => {
    expect(parseFrontmatter('---\nname: 发版\ndescription: 怎么发一个版本\n---\n正文')).toEqual({
      name: '发版',
      description: '怎么发一个版本',
    })
  })

  test('去掉可选引号', () => {
    expect(parseFrontmatter('---\nname: "带引号"\n---').name).toBe('带引号')
    expect(parseFrontmatter("---\nname: '单引号'\n---").name).toBe('单引号')
  })

  test('无前置元信息时返回空，不抛出异常', () => {
    expect(parseFrontmatter('直接是正文')).toEqual({ name: '', description: '' })
  })

  test('未知键被忽略：新增字段时已有技能不会报错', () => {
    const m = parseFrontmatter('---\nname: a\nversion: 3\nauthor: b\n---')
    expect(m.name).toBe('a')
  })
})

describe('技能扫描', () => {
  async function withSkills(): Promise<string> {
    const root = await workspace()
    const mk = async (dir: string, content: string) => {
      await mkdir(join(root, SKILLS_DIR, dir), { recursive: true })
      await writeFile(join(root, SKILLS_DIR, dir, 'SKILL.md'), content, 'utf8')
    }
    await mk('release', '---\nname: 发版\ndescription: 怎么发一个版本\n---\n1. 打 tag\n2. 跑 CI')
    await mk('broken', '没有前置元信息，也就没有 description')
    await mkdir(join(root, SKILLS_DIR, 'empty-dir'), { recursive: true })
    return root
  }

  test('扫描出合法技能并跳过格式错误的技能：单个错误的技能包不应使整个技能体系不可用', async () => {
    const skills = await scanSkills(await withSkills())
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('发版')
  })

  test('索引只含 name 与 description，不含正文', async () => {
    const skills = await scanSkills(await withSkills())
    // 索引每轮都进入上下文末尾。正文（「打 tag」）只在 read_skill 之后出现。
    expect(JSON.stringify(skills)).not.toContain('打 tag')
    expect(skills[0]!.description).toBe('怎么发一个版本')
  })

  test('只有 read_skill 返回全文', async () => {
    const r = await readSkillTool.fn({ name: '发版' }, ctx(await withSkills()))
    expect(r.status).toBe('success')
    expect(r.message).toContain('打 tag')
  })

  test('模型可以明确写入全局技能，附带文件与 SKILL.md 位于同一目录', async () => {
    await withTempHome(async (home) => {
      const root = await workspace()
      const written = await writeSkillTool.fn(
        {
          name: '发版',
          description: '发布版本时使用',
          content: '1. 跑测试\n2. 打标签',
          scope: 'global',
          files: [{ path: 'scripts/check.ts', content: 'export {}\n' }],
        },
        ctx(root),
      )
      expect(written.status).toBe('success')
      expect(await Bun.file(join(home, 'skills', '发版', 'SKILL.md')).text()).toContain('打标签')
      expect(await Bun.file(join(home, 'skills', '发版', 'scripts', 'check.ts')).exists()).toBe(
        true,
      )
      expect(await Bun.file(join(root, SKILLS_DIR, '发版', 'SKILL.md')).exists()).toBe(false)
    })
  })

  test('迁移技能成功后整个目录只存在于目标层', async () => {
    await withTempHome(async (home) => {
      const root = await workspace()
      await writeSkillTool.fn(
        { name: 'review', description: '审查时使用', content: '读取差异' },
        ctx(root),
      )
      const moved = await moveSkillTool.fn(
        { name: 'review', from_scope: 'project', to_scope: 'global' },
        ctx(root),
      )
      expect(moved.status).toBe('success')
      expect(await Bun.file(join(root, SKILLS_DIR, 'review', 'SKILL.md')).exists()).toBe(false)
      expect(await Bun.file(join(home, 'skills', 'review', 'SKILL.md')).exists()).toBe(true)
    })
  })

  test('名称有误时列出候选，而不是只报告未找到', async () => {
    const r = await readSkillTool.fn({ name: '发布' }, ctx(await withSkills()))
    expect(r.status).toBe('failure')
    // 给出候选时模型在下一轮即可自行修正；只返回「未找到」时模型会反复推测。
    expect(r.message).toContain('发版')
  })

  test('没有技能目录时返回空而不是抛出异常', async () => {
    expect(await scanSkills(await workspace())).toEqual([])
  })
})

/**
 * 记忆与技能的正文没有长度上限（用户可以直接修改文件）：正文只放在一处，超出本轮剩余额度时存入正文库续读。
 */
describe('记忆与技能按投递额度交付', () => {
  const long = `${'手改的长记忆。'.repeat(15_000)}尾部标记`
  const fakeSink = () => {
    const landed: Uint8Array[] = []
    return {
      landed,
      land: (input: { body: Uint8Array }) => {
        landed.push(input.body)
        return { resourceId: `rs_${landed.length}`, contentHash: 'sha:x' }
      },
      read: () => null,
      stat: () => null,
    }
  }

  test('正文只在 message 中，data 中不重复', async () => {
    const root = await workspace()
    await mkdir(join(root, MEMORY_DIR), { recursive: true })
    await writeFile(join(root, MEMORY_DIR, '长.md'), long)
    const r = await readMemoryTool.fn({ key: '长' }, ctx(root))
    expect(r.message).toBe(long)
    expect(r.data).toEqual({ key: '长', scope: 'project' })
  })

  test('无法容纳时投递头部，完整正文保存一次，给出续读位置', async () => {
    const root = await workspace()
    await mkdir(join(root, MEMORY_DIR), { recursive: true })
    await writeFile(join(root, MEMORY_DIR, '长.md'), long)
    const sink = fakeSink()
    const c = { ...ctx(root), sink, state: openBatchBudget(new Map(), 3000) }
    const r = await readMemoryTool.fn({ key: '长' }, c)
    expect(r.status).toBe('success')
    expect(r.message.length).toBeLessThan(long.length)
    expect(r.message).toContain('read_resource')
    expect(new TextDecoder().decode(sink.landed[0]!)).toBe(long)
  })
})
