/**
 * 覆盖范围：`eol.ts` 全部四个函数，以及 `files.ts` 三个工具在 CRLF 文件上的行为
 * （read 返回的正文、edit 的定位与落盘、write 的落盘行尾）。
 *
 * 按账本中记录的原始失败形状复现：CRLF 文件 + 跨行 `old_string`。
 */

import { describe, expect, test } from 'bun:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@qywork/agent'
import { openBatchBudget, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { dominantEol, eolInsensitivePattern, fromLf, toLf } from './eol.ts'
import { registerBuiltinTools } from './index.ts'

function ctx(root: string): ToolContext {
  return {
    workspaceRoot: root,
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
  }
}

function registry(): ToolRegistry {
  const r = new ToolRegistry()
  registerBuiltinTools(r)
  return r
}

const CRLF_SRC = ['const a = 1', 'const b = 2', 'const c = 3', ''].join('\r\n')

async function crlfWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'qywork-eol-'))
  await writeFile(join(dir, 'crlf.ts'), CRLF_SRC, 'utf8')
  return dir
}

describe('eol 纯函数', () => {
  test('toLf 只去除 CRLF 中的 CR，不修改独立的 CR', () => {
    expect(toLf('a\r\nb\n c\rd')).toBe('a\nb\n c\rd')
  })

  test('dominantEol 按占多数的行尾判定，空文件按 LF', () => {
    expect(dominantEol('')).toBe('\n')
    expect(dominantEol('a\r\nb\r\nc\n')).toBe('\r\n')
    expect(dominantEol('a\r\nb\nc\n')).toBe('\n')
  })

  test('fromLf 不把已有的 CRLF 编码为 \\r\\r\\n', () => {
    expect(fromLf('a\r\nb', '\r\n')).toBe('a\r\nb')
    expect(fromLf('a\r\nb', '\n')).toBe('a\nb')
  })

  test('eolInsensitivePattern 转义行内元字符，换行处同时匹配两种行尾', () => {
    const re = new RegExp(eolInsensitivePattern('a.b\nc(d)'))
    expect(re.test('a.b\r\nc(d)')).toBe(true)
    expect(re.test('a.b\nc(d)')).toBe(true)
    // 元字符按字面量匹配，不作为通配符。
    expect(re.test('axb\nc(d)')).toBe(false)
  })
})

describe('CRLF 文件上的文件工具', () => {
  test('read_file 返回的正文不含 CR', async () => {
    const root = await crlfWorkspace()
    const out = await registry().execute('read_file', { path: 'crlf.ts' }, ctx(root))
    expect(out.status).toBe('success')
    expect(String((out.data as { content: string }).content)).not.toContain('\r')
  })

  test('跨行 old_string 在 CRLF 文件上命中，未修改的行仍为 CRLF', async () => {
    const root = await crlfWorkspace()
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'crlf.ts' }, c)
    // 模型持有的文本为 LF，即原始失败形状。
    const out = await r.execute(
      'edit_file',
      {
        path: 'crlf.ts',
        edits: [{ old_string: 'const a = 1\nconst b = 2', new_string: 'const ab = 3' }],
      },
      c,
    )
    expect(out.status).toBe('success')
    expect(await readFile(join(root, 'crlf.ts'), 'utf8')).toBe('const ab = 3\r\nconst c = 3\r\n')
  })

  test('替换片段本身也按 CRLF 落盘', async () => {
    const root = await crlfWorkspace()
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'crlf.ts' }, c)
    const out = await r.execute(
      'edit_file',
      {
        path: 'crlf.ts',
        edits: [{ old_string: 'const b = 2', new_string: 'const b = 2\nconst b2 = 22' }],
      },
      c,
    )
    expect(out.status).toBe('success')
    const after = await readFile(join(root, 'crlf.ts'), 'utf8')
    expect(after).toBe('const a = 1\r\nconst b = 2\r\nconst b2 = 22\r\nconst c = 3\r\n')
    expect(after).not.toMatch(/[^\r]\n/)
  })

  test('new_string 中的 $& 是字面量，不是反向引用', async () => {
    const root = await crlfWorkspace()
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'crlf.ts' }, c)
    const out = await r.execute(
      'edit_file',
      { path: 'crlf.ts', edits: [{ old_string: 'const c = 3', new_string: 'const c = "$&"' }] },
      c,
    )
    expect(out.status).toBe('success')
    expect(await readFile(join(root, 'crlf.ts'), 'utf8')).toContain('const c = "$&"')
  })

  test('write_file 整份写出时保持 CRLF，不静默改成 LF', async () => {
    const root = await crlfWorkspace()
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'crlf.ts' }, c)
    // 模型提供的整份内容一律为 LF。
    const out = await r.execute(
      'write_file',
      { path: 'crlf.ts', mode: 'overwrite', content: 'const a = 1\nconst z = 9\n' },
      c,
    )
    expect(out.status).toBe('success')
    expect(await readFile(join(root, 'crlf.ts'), 'utf8')).toBe('const a = 1\r\nconst z = 9\r\n')
  })

  test('write_file 之后紧接着 edit_file 不会被判定为读取后已被修改', async () => {
    const root = await crlfWorkspace()
    const r = registry()
    const c = ctx(root)
    await r.execute('read_file', { path: 'crlf.ts' }, c)
    await r.execute(
      'write_file',
      { path: 'crlf.ts', mode: 'overwrite', content: 'const a = 1\nconst z = 9\n' },
      c,
    )
    const out = await r.execute(
      'edit_file',
      { path: 'crlf.ts', edits: [{ old_string: 'const z = 9', new_string: 'const z = 10' }] },
      c,
    )
    expect(out.status).toBe('success')
  })

  test('新文件按 LF 落盘', async () => {
    const root = await crlfWorkspace()
    const out = await registry().execute(
      'write_file',
      { path: 'fresh.ts', mode: 'create', content: 'a\nb\n' },
      ctx(root),
    )
    expect(out.status).toBe('success')
    expect(await readFile(join(root, 'fresh.ts'), 'utf8')).toBe('a\nb\n')
  })
})
