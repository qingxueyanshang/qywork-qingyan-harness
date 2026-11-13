/**
 * 文件工具按虚拟路径只读访问云端技能包。
 *
 * 覆盖范围：`cloud-skills/source.ts`；`files.ts` 的 `read_file` / `list_dir` / `write_file` / `edit_file` 与
 * `search.ts` 的 `glob` / `grep` 中识别云端技能路径的分支。
 *
 * 端口由测试内的内存实现提供，标记用 `@qywork/ai` 的 `issueSkillMarker` 签发，行的划分与云端读取接口相同。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  batchCapped,
  batchRemaining,
  type CloudSkillErrorCode,
  type CloudSkillPort,
  deliveryCap,
  openBatchBudget,
  outcomeTokens,
  type ToolContext,
} from '@qywork/agent'
import { DEFAULT_DENSITY, issueSkillMarker, parseSkillMarker } from '@qywork/ai'
import { editFileTool, listDirTool, readFileTool, writeFileTool } from '../files.ts'
import { globTool, grepTool } from '../search.ts'

const PKG = 'demo-pkg'
const KEY = new Uint8Array(32).fill(7)

function linesOf(text: string): string[] {
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
}

/** 内存中的云端技能包。`reads` 记录每次读取的行段，`fail` 使所有调用返回该错误。 */
function fakePort(
  files: Record<string, string>,
  opts: { fail?: CloudSkillErrorCode } = {},
): CloudSkillPort & { reads: [string, number, number][] } {
  const reads: [string, number, number][] = []
  const refuse = () => ({ ok: false as const, code: opts.fail!, message: `云端拒绝：${opts.fail}` })
  return {
    reads,
    packages: [PKG],
    async files() {
      if (opts.fail) return refuse()
      const value = Object.keys(files)
        .sort()
        .map((path) => ({ path, size: Buffer.byteLength(files[path]!) }))
      return { ok: true, value }
    },
    async read(_pkg, path, start, end) {
      if (opts.fail) return refuse()
      const text = files[path]
      if (text === undefined)
        return { ok: false, code: 'skill_file_not_found', message: `文件不存在：${path}` }
      const all = linesOf(text)
      const last = end ?? all.length
      if (start > last || last > all.length) {
        return {
          ok: false,
          code: 'skill_range_invalid',
          message: `行段超出文件范围：共 ${all.length} 行`,
        }
      }
      reads.push([path, start, last])
      const hash = Bun.SHA256.hash(text, 'hex') as string
      const issued = issueSkillMarker(
        { pkg: PKG, path, hash, start, end: last },
        all.slice(start - 1, last).join('\n'),
        'account',
        KEY,
      )
      return {
        ok: true,
        value: {
          path,
          lines: all.length,
          start,
          end: last,
          marker: issued.text,
          features: issued.features,
        },
      }
    },
    async search(_pkg, query, prefix) {
      if (opts.fail) return refuse()
      const matches = Object.keys(files)
        .sort()
        .filter((p) => p.startsWith(prefix))
        .map((path) => ({
          path,
          lines: linesOf(files[path]!).flatMap((l, i) => (l.includes(query) ? [i + 1] : [])),
        }))
        .filter((m) => m.lines.length)
      return { ok: true, value: { matches, truncated: false } }
    },
  }
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'qywork-cloud-skill-'))
}

function ctx(
  root: string,
  cloudSkills: CloudSkillPort | undefined,
  room = Number.POSITIVE_INFINITY,
  contextWindow = 200_000,
): ToolContext {
  return {
    workspaceRoot: root,
    conversationId: 'cv',
    runId: 'rn',
    model: 'test',
    contextWindow,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: openBatchBudget(new Map(), room, Math.floor(contextWindow / 8)),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
    ...(cloudSkills ? { cloudSkills } : {}),
  }
}

const SKILL_MD =
  '---\nname: 演示流程\ndescription: 按步骤执行演示\n---\n\n1. 读取 references/guide.md\n'
const BIG = Array.from(
  { length: 2000 },
  (_, i) => `第 ${i + 1} 步：检查素材并记录结果。Check item ${i + 1} before export.`,
).join('\n')

describe('read_file 按行段读取云端技能文件', () => {
  test('SKILL.md 以标记交付：标记在 data.texts 中，message 与其余字段不含正文', async () => {
    const root = await workspace()
    const port = fakePort({ 'SKILL.md': SKILL_MD })
    const out = await readFileTool.fn({ path: 'cloud-skill://demo-pkg/SKILL.md' }, ctx(root, port))
    expect(out.status).toBe('success')
    const { texts: t, ...rest } = out.data ?? {}
    const marker = parseSkillMarker((t as { text: string }[])[0]!.text)
    expect([marker?.pkg, marker?.path, marker?.start, marker?.end]).toEqual([PKG, 'SKILL.md', 1, 6])
    expect(JSON.stringify({ message: out.message, rest })).not.toContain('references/guide.md')
    expect(rest).toEqual({ startLine: 1, endLine: 6, totalLines: 6, truncated: false })
  })

  test('可选参数以 null 填写时与缺省相同；region 有值时拒绝', async () => {
    const root = await workspace()
    const port = fakePort({ 'SKILL.md': SKILL_MD })
    const path = 'cloud-skill://demo-pkg/SKILL.md'
    const out = await readFileTool.fn(
      { path, offset: null, limit: null, start: null, end: null, region: null },
      ctx(root, port),
    )
    expect(out.status).toBe('success')
    expect(out.data).toMatchObject({ startLine: 1, endLine: 6, totalLines: 6 })
    const bad = await readFileTool.fn({ path, region: '0,0,10,10' }, ctx(root, port))
    expect([bad.status, bad.errorKind]).toEqual(['failure', 'invalid_args'])
  })

  test('超出单次投递上限时按行段部分投递，记为触及上限并给出续读位置', async () => {
    const root = await workspace()
    const port = fakePort({ 'SKILL.md': BIG })
    const c = ctx(root, port, 10_000, 32_000)
    const cap = deliveryCap(c)
    const out = await readFileTool.fn({ path: 'cloud-skill://demo-pkg/SKILL.md' }, c)
    expect(out.status).toBe('success')
    const end = (out.data as { nextOffset: number }).nextOffset - 1
    expect(end).toBeGreaterThan(0)
    expect(end).toBeLessThan(2000)
    expect(out.message).toContain(`offset=${end + 1}`)
    expect(outcomeTokens(out, c.density)).toBeLessThanOrEqual(cap)
    expect(outcomeTokens(out, c.density)).toBeGreaterThan(cap * 0.9)
    expect(batchCapped(c.state)).toBe(true)
    expect(batchRemaining(c)).toBe(10_000 - outcomeTokens(out, c.density))
  })

  test('offset / limit 对应标记的行段；回执的形状与本地文本文件相同', async () => {
    const root = await workspace()
    const port = fakePort({ 'references/guide.md': BIG })
    const out = await readFileTool.fn(
      { path: 'cloud-skill://demo-pkg/references/guide.md', offset: 10, limit: 5 },
      ctx(root, port),
    )
    expect(out.status).toBe('success')
    const { texts: t, ...rest } = out.data ?? {}
    expect(rest).toEqual({ startLine: 10, endLine: 14, totalLines: 2000, truncated: true })
    const marker = parseSkillMarker((t as { text: string }[])[0]!.text)
    expect([marker?.start, marker?.end]).toEqual([10, 14])
    expect(out.message).toBe('读取 cloud-skill://demo-pkg/references/guide.md（5 行，已截断）')
  })

  test('逐段续读到文件末尾，每段都不超过单次投递上限', async () => {
    const root = await workspace()
    const port = fakePort({ 'references/guide.md': BIG })
    let offset = 1
    const segments: [number, number][] = []
    for (let round = 0; round < 50 && offset <= 2000; round++) {
      const c = ctx(root, port, 10_000, 32_000)
      const cap = deliveryCap(c)
      const out = await readFileTool.fn(
        { path: 'cloud-skill://demo-pkg/references/guide.md', offset },
        c,
      )
      expect(out.status).toBe('success')
      expect(outcomeTokens(out, c.density)).toBeLessThanOrEqual(cap)
      const data = out.data as { startLine: number; endLine: number; nextOffset?: number }
      segments.push([data.startLine, data.endLine])
      offset = data.nextOffset ?? 2001
    }
    expect(segments[0]![0]).toBe(1)
    expect(segments.at(-1)![1]).toBe(2000)
    for (let i = 1; i < segments.length; i++) {
      expect(segments[i]![0]).toBe(segments[i - 1]![1] + 1)
    }
  })

  test('余量为 0 时仍投递一短行；无法拆分的长行返回失败并写明估算与上限', async () => {
    const root = await workspace()
    const port = fakePort({ 'a.md': BIG, 'wide.json': `${'x'.repeat(60_000)}\nend` })
    const exhausted = ctx(root, port, 0, 32_000)
    const short = await readFileTool.fn({ path: 'cloud-skill://demo-pkg/a.md' }, exhausted)
    expect(short.status).toBe('success')
    expect(short.data).toMatchObject({ startLine: 1, endLine: 1, nextOffset: 2 })
    expect(batchCapped(exhausted.state)).toBe(true)

    const wide = await readFileTool.fn(
      { path: 'cloud-skill://demo-pkg/wide.json' },
      ctx(root, port, 10_000, 32_000),
    )
    expect(wide.status).toBe('failure')
    expect(wide.errorKind).toBe('over_budget')
    expect(wide.message).toMatch(/^cloud-skill:\/\/demo-pkg\/wide\.json 第 1 行约 \d+ token，超出/)
  })

  test('未提供端口时云端技能路径按本地路径处理', async () => {
    const root = await workspace()
    await expect(
      readFileTool.fn({ path: 'cloud-skill://demo-pkg/SKILL.md' }, ctx(root, undefined)),
    ).rejects.toThrow()
  })

  test('技能包不属于本会话、路径含 .. 时拒绝', async () => {
    const root = await workspace()
    const c = ctx(root, fakePort({ 'SKILL.md': SKILL_MD }))
    const other = await readFileTool.fn({ path: 'cloud-skill://other/SKILL.md' }, c)
    expect([other.status, other.message]).toEqual(['failure', '本会话没有云端技能包：other'])
    const up = await readFileTool.fn({ path: 'cloud-skill://demo-pkg/../x' }, c)
    expect(up.errorKind).toBe('invalid_args')
  })
})

describe('读取失败的分类', () => {
  test('每个错误码各有一句说明，错误码作为 errorKind', async () => {
    const root = await workspace()
    const expected: Record<CloudSkillErrorCode, string> = {
      skill_not_granted: '未获得云端技能包 demo-pkg 的使用权益，无法读取。',
      skill_version_not_found: '云端技能包 demo-pkg 没有可读取的版本。',
      skill_file_not_found: '云端技能包中没有该文件：cloud-skill://demo-pkg/a.md',
      skill_file_binary: 'cloud-skill://demo-pkg/a.md 不是文本文件，无法读取。',
      skill_range_invalid: '读取 cloud-skill://demo-pkg/a.md 失败：云端拒绝：skill_range_invalid',
      invalid_request: '读取 cloud-skill://demo-pkg/a.md 失败：云端拒绝：invalid_request',
      unavailable: '无法读取云端技能：云端拒绝：unavailable',
    }
    for (const [code, message] of Object.entries(expected)) {
      const port = fakePort({}, { fail: code as CloudSkillErrorCode })
      const out = await readFileTool.fn({ path: 'cloud-skill://demo-pkg/a.md' }, ctx(root, port))
      expect([out.status, out.errorKind, out.message]).toEqual(['failure', code, message])
    }
  })
})

describe('目录列举、通配与检索', () => {
  const files = {
    'SKILL.md': SKILL_MD,
    'references/guide.md': '准备素材\n导出前运行 check_all.py\n',
    'references/cards/a.md': '卡片 A\n运行 check_all.py --show\n',
    'scripts/check_all.py': 'print("check_all.py")\n',
    '.hidden/x.md': 'check_all.py\n',
  }

  test('list_dir 列出直接子项，目录在前', async () => {
    const root = await workspace()
    const c = ctx(root, fakePort(files))
    const top = await listDirTool.fn({ path: 'cloud-skill://demo-pkg' }, c)
    expect(top.data).toEqual({ entries: ['references/', 'scripts/', 'SKILL.md'] })
    const sub = await listDirTool.fn({ path: 'cloud-skill://demo-pkg/references' }, c)
    expect(sub.data).toEqual({ entries: ['cards/', 'guide.md'] })
    const missing = await listDirTool.fn({ path: 'cloud-skill://demo-pkg/nope' }, c)
    expect(missing.errorKind).toBe('not_found')
  })

  test('glob 按技能目录下的相对路径匹配', async () => {
    const root = await workspace()
    const c = ctx(root, fakePort(files))
    const out = await globTool.fn({ pattern: '**/*.md', path: 'cloud-skill://demo-pkg' }, c)
    expect(out.data).toEqual({
      files: [
        'cloud-skill://demo-pkg/SKILL.md',
        'cloud-skill://demo-pkg/references/cards/a.md',
        'cloud-skill://demo-pkg/references/guide.md',
      ],
      truncated: false,
    })
  })

  test('grep 按字面文本检索，命中只有位置；正则语法与忽略大小写被拒绝', async () => {
    const root = await workspace()
    const c = ctx(root, fakePort(files))
    const out = await grepTool.fn(
      { pattern: 'check_all\\.py', path: 'cloud-skill://demo-pkg/references' },
      c,
    )
    expect(out.data).toEqual({
      matches: [
        'cloud-skill://demo-pkg/references/cards/a.md:2',
        'cloud-skill://demo-pkg/references/guide.md:2',
      ],
      truncated: false,
      engine: 'cloud',
    })
    const named = await grepTool.fn(
      { pattern: 'check_all.py', path: 'cloud-skill://demo-pkg', glob: '*.py' },
      c,
    )
    expect((named.data as { matches: string[] }).matches).toEqual([
      'cloud-skill://demo-pkg/scripts/check_all.py:1',
    ])
    const regex = await grepTool.fn(
      { pattern: 'check_(all|any)', path: 'cloud-skill://demo-pkg' },
      c,
    )
    expect(regex.errorKind).toBe('invalid_args')
    const ci = await grepTool.fn(
      { pattern: 'check', path: 'cloud-skill://demo-pkg', case_insensitive: true },
      c,
    )
    expect(ci.errorKind).toBe('invalid_args')
  })

  test('写入类工具拒绝云端技能路径', async () => {
    const root = await workspace()
    const c = ctx(root, fakePort(files))
    const write = await writeFileTool.fn(
      { path: 'cloud-skill://demo-pkg/SKILL.md', mode: 'create', content: 'x' },
      c,
    )
    const edit = await editFileTool.fn(
      { path: 'cloud-skill://demo-pkg/SKILL.md', edits: [{ old_string: 'a', new_string: 'b' }] },
      c,
    )
    for (const out of [write, edit]) {
      expect([out.status, out.errorKind, out.message]).toEqual([
        'failure',
        'permission_denied',
        '云端技能只读，不能写入：cloud-skill://demo-pkg/SKILL.md',
      ])
    }
  })
})
