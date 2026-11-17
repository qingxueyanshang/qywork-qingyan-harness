/**
 * 遍历目录的工具在任意大的目录上有界返回。
 *
 * 覆盖范围：`files/scan.ts` 的 `walkFiles` / `startScan` / `truncationNote` / `fitBudget`；`files.ts` 的 `list_dir`
 * 与 `search.ts` 的 `glob` / `grep` 接入的条数上限、时限、停止信号与无法读取目录的处理，以及 `glob` 的遍历方案
 * （`globPlan`）与 `Bun.Glob.scan` 结果一致。
 *
 * 原始失败形状（2026-11-15 实测）：`glob` 遇到一个无法读取的目录即整体失败（EPERM），在家目录上遍历 15 至 38 秒且不响应停止；
 * `grep` 的 rg 遇到无法读取的文件以退出码 2 结束，结果被丢弃并转入逐个读取文件的内置遍历，在家目录上超过 120 秒未结束；
 * `list_dir` 列出 `C:\Windows\WinSxS` 的 15354 项、144 万字符，全部交给模型。
 * 无穷的目录树由注入的目录读取构造，时限由注入的时钟触发，不按真实时间等待。
 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { chmodSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { openBatchBudget, type ToolContext, ToolRegistry } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import { registerBuiltinTools } from '../index.ts'
import { IGNORED_DIRS } from '../paths.ts'
import { type ReadDir, SCAN_LIMITS, startScan, walkFiles } from './scan.ts'

function ctx(root: string, signal = new AbortController().signal): ToolContext {
  return {
    workspaceRoot: root,
    conversationId: 'cv_scan',
    runId: 'rn_scan',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY, 0),
    sink: null,
    port: () => null,
    signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
  }
}

function registry(): ToolRegistry {
  const r = new ToolRegistry()
  registerBuiltinTools(r)
  return r
}

async function tree(files: Record<string, string>): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-scan-')))
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(dirname(join(root, rel)), { recursive: true })
    await writeFile(join(root, rel), body)
  }
  return root
}

/** 目录读取得到的条目。 */
function entry(name: string, kind: 'dir' | 'file') {
  return {
    name,
    isDirectory: () => kind === 'dir',
    isFile: () => kind === 'file',
    isSymbolicLink: () => false,
  }
}

/** 无穷的目录树：每个目录下有两个子目录与一个文件。`reads` 记录读取过的目录。 */
function endlessTree(): { readDir: ReadDir; reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    readDir: async (dir) => {
      reads.push(dir)
      return [entry('a', 'dir'), entry('b', 'dir'), entry('f.txt', 'file')]
    },
  }
}

/** 每读取一次时钟前进 `step` 毫秒的时钟。 */
function steppingClock(step: number): () => number {
  let t = 0
  return () => {
    t += step
    return t
  }
}

const descendAll = () => true

describe('walkFiles', () => {
  test('目录树无穷大时，超过时限即停止并记为 time', async () => {
    const { readDir, reads } = endlessTree()
    const scan = startScan(new AbortController().signal, steppingClock(100))
    let files = 0
    for await (const _ of walkFiles('/root', scan, descendAll, readDir)) files++
    expect(scan.stopped).toBe('time')
    // 每处理一个条目读取一次时钟，时钟每次前进 100 毫秒：条目总数不超过时限内的读取次数。
    expect(reads.length + files).toBeLessThanOrEqual(SCAN_LIMITS.timeMs / 100)
  })

  test('无法读取的目录跳过，其余目录照常遍历', async () => {
    const readDir: ReadDir = async (dir) => {
      if (dir.endsWith('locked')) throw Object.assign(new Error('EPERM'), { code: 'EPERM' })
      if (dir.endsWith('open')) return [entry('x.ts', 'file')]
      return [entry('locked', 'dir'), entry('open', 'dir'), entry('top.ts', 'file')]
    }
    const scan = startScan(new AbortController().signal)
    const rels: string[] = []
    for await (const f of walkFiles('/root', scan, descendAll, readDir)) rels.push(f.rel)
    expect(rels).toEqual(['open/x.ts', 'top.ts'])
    expect(scan.stopped).toBeNull()
  })

  test('停止信号触发后立即结束，不再读取目录', async () => {
    const stop = new AbortController()
    const { readDir: endless, reads } = endlessTree()
    const readDir: ReadDir = async (dir) => {
      if (reads.length === 2) stop.abort()
      return endless(dir)
    }
    const scan = startScan(stop.signal)
    const walking = (async () => {
      for await (const _ of walkFiles('/root', scan, descendAll, readDir)) {
        // 只遍历，不处理条目
      }
    })()
    await expect(walking).rejects.toThrow()
    expect(reads.length).toBe(3)
  })
})

/**
 * 使 `path` 对当前进程不可读，返回恢复函数。拒绝没有生效时恢复原状并返回 null：以 root 运行的进程不受文件权限
 * 限制，Windows 上启用了备份特权的进程打开目录时不检查读取权限。
 */
function denyRead(path: string, dir: boolean): (() => void) | null {
  let restore: () => void
  if (process.platform === 'win32') {
    const everyone = '*S-1-1-0'
    const icacls = (args: string[]) => {
      const r = Bun.spawnSync(['icacls', path, ...args], { stdout: 'ignore', stderr: 'ignore' })
      if (r.exitCode !== 0) throw new Error(`icacls ${args.join(' ')} 退出码 ${r.exitCode}`)
    }
    icacls(['/deny', `${everyone}:(${dir ? 'RD' : 'R'})`])
    restore = () => icacls(['/remove:d', everyone])
  } else {
    chmodSync(path, 0)
    restore = () => chmodSync(path, dir ? 0o755 : 0o644)
  }
  try {
    if (dir) readdirSync(path)
    else readFileSync(path)
  } catch {
    return restore
  }
  restore()
  return null
}

describe('无法读取的目录与文件', () => {
  test('glob 跳过无法读取的目录，返回其余目录中的结果', async () => {
    const root = await tree({ 'locked/a.ts': 'x', 'open/b.ts': 'x', 'c.ts': 'x' })
    const restore = denyRead(join(root, 'locked'), true)
    if (restore === null) return
    try {
      const out = await registry().execute('glob', { pattern: '**/*.ts' }, ctx(root))
      expect(out.status).toBe('success')
      expect([...(out.data?.files as string[])].sort()).toEqual(['c.ts', 'open/b.ts'])
    } finally {
      restore()
    }
  })

  /** rg 遇到无法读取的文件时以退出码 2 结束，其余文件的结果照常使用，不转入内置遍历。 */
  test('grep 遇到无法读取的文件时使用 rg 的结果', async () => {
    const root = await tree({ 'secret.txt': 'needle c\n', 'open/a.txt': 'needle a\n' })
    const restore = denyRead(join(root, 'secret.txt'), false)
    if (restore === null) return
    try {
      const out = await registry().execute('grep', { pattern: 'needle' }, ctx(root))
      expect(out.status).toBe('success')
      expect(out.data?.matches).toEqual(['open/a.txt:1:needle a'])
      if (Bun.which('rg')) expect(out.data?.engine).toBe('ripgrep')
    } finally {
      restore()
    }
  })
})

describe('停止信号与时限', () => {
  let clock: ReturnType<typeof spyOn> | null = null
  afterEach(() => {
    clock?.mockRestore()
    clock = null
  })

  test('三个工具在已停止的执行中都以失败结束', async () => {
    const root = await tree({ 'src/a.ts': 'needle\n' })
    const stop = new AbortController()
    stop.abort()
    for (const [name, args] of [
      ['glob', { pattern: '**/*.ts' }],
      ['list_dir', { path: '.' }],
      ['grep', { pattern: '(?=needle)needle' }],
    ] as const) {
      const out = await registry().execute(name, args, ctx(root, stop.signal))
      expect([name, out.status]).toEqual([name, 'failure'])
    }
  })

  /** 时钟每读取一次前进一个完整时限，遍历在处理第一个条目之前即到期。前瞻断言使 grep 使用内置遍历。 */
  test('超过时限时 glob 与 grep 返回已得结果，标记截断并说明原因', async () => {
    const root = await tree({ 'src/a.ts': 'needle\n', 'src/b.ts': 'needle\n' })
    const real = performance.now.bind(performance)
    let shift = 0
    clock = spyOn(performance, 'now').mockImplementation(() => {
      shift += SCAN_LIMITS.timeMs
      return real() + shift
    })
    for (const [name, args] of [
      ['glob', { pattern: '**/*.ts' }],
      ['grep', { pattern: '(?=needle)needle' }],
    ] as const) {
      const out = await registry().execute(name, args, ctx(root))
      expect([name, out.status, out.data?.truncated]).toEqual([name, 'success', true])
      expect(out.message).toContain(`${SCAN_LIMITS.timeMs / 1000} 秒时限`)
    }
  })
})

describe('条数上限', () => {
  test('list_dir 超过条目上限时只返回上限内的条目并说明', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'qy-scan-many-')))
    const total = SCAN_LIMITS.entries + 5
    await Promise.all(
      Array.from({ length: total }, (_, i) => writeFile(join(root, `f${i}.txt`), '')),
    )
    const out = await registry().execute('list_dir', { path: '.' }, ctx(root))
    expect(out.status).toBe('success')
    expect((out.data?.entries as string[]).length).toBe(SCAN_LIMITS.entries)
    expect(out.data?.truncated).toBe(true)
    expect(out.message).toContain(`${total} 项`)
    expect(out.message).toContain('上限')
  })

  /** 清空 PATH 时 rg 不可用，使用内置遍历。两种引擎在超过条数上限时给出同一个上界与说明。 */
  test('grep 超过条数上限时两种引擎都返回上限条数并说明', async () => {
    const body = Array.from({ length: 60 }, (_, i) => `needle ${i}`).join('\n')
    const root = await tree(
      Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.txt`, body])),
    )
    const viaRg = await registry().execute('grep', { pattern: 'needle' }, ctx(root))
    const prevPath = process.env.PATH
    process.env.PATH = ''
    let viaBuiltin: Awaited<ReturnType<ToolRegistry['execute']>>
    try {
      viaBuiltin = await registry().execute('grep', { pattern: 'needle' }, ctx(root))
    } finally {
      process.env.PATH = prevPath
    }
    for (const out of [viaRg, viaBuiltin]) {
      expect((out.data?.matches as string[]).length).toBe(SCAN_LIMITS.results)
      expect(out.data?.truncated).toBe(true)
      expect(out.message).toContain(`${SCAN_LIMITS.results} 条上限`)
    }
  })
})

/**
 * 在不含无法读取目录的目录树上，glob 的结果等于 `Bun.Glob.scan({ onlyFiles: true, dot: false })` 的结果去除路径中含噪音目录的项。
 * 遍历方案逐层判定目录，不含 `**` 的模式不进入更深的目录，点目录只由以 . 开头的段进入。
 */
describe('glob 的结果与 Bun.Glob.scan 相同', () => {
  const FILES = [
    'README.md',
    'a.md',
    'b.ts',
    'package.json',
    '.gitignore',
    '.github/workflows/ci.yml',
    '.github/actions/setup/action.yml',
    '.hidden/x.ts',
    'src/a.ts',
    'src/.dot.ts',
    'src/deep/b.ts',
    'src/deep/deeper/c.ts',
    'lib/c.ts',
    'lib/readme.md',
    'packages/one/package.json',
    'packages/two/package.json',
    'packages/two/src/index.ts',
    'node_modules/pkg/index.ts',
    'dist/out.js',
  ]
  const PATTERNS = [
    '**/*.ts',
    'src/**/*.ts',
    '*.md',
    '**/*.md',
    '.github/**/*.yml',
    '.github/*/*.yml',
    '**/.gitignore',
    '.*',
    '.*/*.ts',
    'src/*.ts',
    './src/*.ts',
    'packages/*/package.json',
    '**/package.json',
    '*/*.ts',
    '**/*',
    '*',
    'src/**',
    '{src,lib}/**/*.ts',
    '**/*.{ts,md}',
    '?.md',
    '[ab].ts',
    'src/deep/**/c.ts',
    '**/deep/*.ts',
    'missing/**/*.ts',
    'src/a.ts',
    'node_modules/**/*.ts',
    ...(process.platform === 'win32' ? ['src\\*.ts', 'src\\**\\*.ts'] : []),
  ]
  const CASES: [string, string][] = [
    ...PATTERNS.map((p): [string, string] => ['.', p]),
    ['packages', '../*.md'],
    ['packages', '../src/**/*.ts'],
    ['packages', '*/src/*.ts'],
    ['packages', '**/package.json'],
  ]

  test('搜索起点是文件时返回失败，不报告为没有匹配', async () => {
    const root = await tree({ 'src/a.ts': 'x' })
    const out = await registry().execute('glob', { pattern: '*', path: 'src/a.ts' }, ctx(root))
    expect([out.status, out.errorKind]).toEqual(['failure', 'invalid_args'])
  })

  test('各类模式的结果逐项一致', async () => {
    const root = await tree(Object.fromEntries(FILES.map((f) => [f, 'x'])))
    for (const [path, pattern] of CASES) {
      const cwd = join(root, path)
      const expected: string[] = []
      for await (const rel of new Bun.Glob(pattern).scan({ cwd, onlyFiles: true, dot: false })) {
        if (rel.split(/[\\/]/).some((seg) => IGNORED_DIRS.has(seg))) continue
        expected.push(relative(root, join(cwd, rel)).replaceAll('\\', '/'))
      }
      const out = await registry().execute('glob', { pattern, path }, ctx(root))
      expect([path, pattern, [...(out.data?.files as string[])].sort()]).toEqual([
        path,
        pattern,
        expected.sort(),
      ])
    }
  })
})
