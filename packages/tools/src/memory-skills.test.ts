import { describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@qywork/agent'
import { listEntries, MEMORY_DIR, memoryTool } from './memory.ts'
import {
  listSkillsTool,
  parseFrontmatter,
  readSkillTool,
  SKILLS_DIR,
  scanSkills,
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
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => approve,
  }
}

describe('记忆', () => {
  test('写入后能读回，并落成工作区里的普通文件', async () => {
    const root = await workspace()
    const c = ctx(root)
    const w = await memoryTool.fn({ action: 'write', key: '包管理器', content: '本项目用 pnpm' }, c)
    expect(w.status).toBe('success')

    const r = await memoryTool.fn({ action: 'read', key: '包管理器' }, c)
    expect(r.message).toContain('本项目用 pnpm')

    // 用户能直接看、直接改、直接删——这是不放 SQLite 的全部理由。
    const raw = await Bun.file(join(root, MEMORY_DIR, '包管理器.md')).text()
    expect(raw).toContain('本项目用 pnpm')
  })

  test('list 只给首行摘要，不给全文', async () => {
    const root = await workspace()
    const c = ctx(root)
    await memoryTool.fn(
      { action: 'write', key: 'k', content: '第一行摘要\n第二行不该出现在索引里' },
      c,
    )
    const l = await memoryTool.fn({ action: 'list' }, c)
    expect(l.message).toContain('第一行摘要')
    // 索引每轮都进尾区，塞全文就是每轮都付一次全文的钱。
    expect(l.message).not.toContain('第二行不该出现')
  })

  test('删除后读不到', async () => {
    const root = await workspace()
    const c = ctx(root)
    await memoryTool.fn({ action: 'write', key: 'tmp', content: 'x' }, c)
    expect((await memoryTool.fn({ action: 'delete', key: 'tmp' }, c)).status).toBe('success')
    expect((await memoryTool.fn({ action: 'read', key: 'tmp' }, c)).errorKind).toBe('not_found')
  })

  test('key 里的路径穿越被消掉', async () => {
    const root = await workspace()
    const c = ctx(root)
    const r = await memoryTool.fn({ action: 'write', key: '../../../etc/passwd', content: 'x' }, c)
    // 安全化后剩下的是普通文件名，不会写到工作区外。
    expect(r.status).toBe('success')
    const entries = await listEntries(join(root, MEMORY_DIR))
    expect(entries.every((e) => !e.key.includes('..'))).toBe(true)
  })

  test('全是非法字符的 key 被拒', async () => {
    const root = await workspace()
    expect(
      (await memoryTool.fn({ action: 'write', key: '///', content: 'x' }, ctx(root))).status,
    ).toBe('failure')
  })

  test('超长内容被拒 —— 该写成文档而不是记忆', async () => {
    const root = await workspace()
    const r = await memoryTool.fn(
      { action: 'write', key: 'big', content: 'x'.repeat(5000) },
      ctx(root),
    )
    expect(r.status).toBe('failure')
    expect(r.message).toContain('文档')
  })

  test('读记忆不走权限闸，写和删走', () => {
    const effect = memoryTool.permissionEffect as (a: Record<string, unknown>) => string
    expect(effect({ action: 'read' })).toBe('internal_control')
    expect(effect({ action: 'list' })).toBe('internal_control')
    expect(effect({ action: 'write' })).toBe('write')
    expect(effect({ action: 'delete' })).toBe('delete')
  })

  test('动作语义从显式参数解析，不按工具名猜', () => {
    const kind = memoryTool.actionKind as (a: Record<string, unknown>) => string
    expect(kind({ action: 'write' })).toBe('write')
    expect(kind({ action: 'delete' })).toBe('delete')
    expect(kind({ action: 'list' })).toBe('read')
  })

  test('空目录返回空列表而不是抛', async () => {
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

  test('无前置元信息返回空，不抛', () => {
    expect(parseFrontmatter('直接是正文')).toEqual({ name: '', description: '' })
  })

  test('未知键被安静忽略 —— 将来加字段时旧技能不会报错', () => {
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

  test('扫出合法技能，跳过坏的 —— 一个手滑的包不该让整个体系不可用', async () => {
    const skills = await scanSkills(await withSkills())
    expect(skills).toHaveLength(1)
    expect(skills[0]!.name).toBe('发版')
  })

  test('list_skills 只列索引不列正文', async () => {
    const r = await listSkillsTool.fn({}, ctx(await withSkills()))
    expect(r.message).toContain('发版')
    expect(r.message).toContain('怎么发一个版本')
    // 正文（"打 tag"）必须要等 read_skill 才出现。
    expect(r.message).not.toContain('打 tag')
  })

  test('read_skill 才给全文', async () => {
    const r = await readSkillTool.fn({ name: '发版' }, ctx(await withSkills()))
    expect(r.status).toBe('success')
    expect(r.message).toContain('打 tag')
  })

  test('名字记错时列出候选，而不是只说找不到', async () => {
    const r = await readSkillTool.fn({ name: '发布' }, ctx(await withSkills()))
    expect(r.status).toBe('failure')
    // 给候选它下一轮就能自己修正；只说「找不到」它会反复猜。
    expect(r.message).toContain('发版')
  })

  test('没有技能目录时返回空而不是抛', async () => {
    expect(await scanSkills(await workspace())).toEqual([])
  })
})
