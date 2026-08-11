/**
 * Git 面板数据源。
 *
 * 直接 shell 出 `git`，不用 isomorphic-git：git 自己才是它的权威实现，
 * 任何 JS 复刻在 worktree、submodule、稀疏检出、LFS、hooks 上都会有出入，
 * 而这些恰恰是真实项目里天天遇到的东西。
 *
 * 全部命令都加 `--no-optional-locks`：面板会周期性刷新，不能因为读状态而去抢
 * index.lock，否则用户在终端里 `git commit` 会随机失败。
 */

import type { GitStateEvent } from '@qywork/core'

export interface GitBranch {
  name: string
  current: boolean
  upstream: string | null
  ahead: number
  behind: number
  lastCommitAt: number
  lastCommitSubject: string
}

export interface GitCommit {
  hash: string
  shortHash: string
  subject: string
  author: string
  at: number
  /** 该提交所属的分支引用（仅在 --decorate 有输出时非空）。 */
  refs: string[]
}

export interface GitFileEntry {
  path: string
  /** 工作区状态码，来自 porcelain v2。 */
  indexStatus: string
  worktreeStatus: string
  renamedFrom?: string
}

export interface GitStatus extends Omit<GitStateEvent, 'type'> {
  files: GitFileEntry[]
  detached: boolean
}

async function git(
  cwd: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<{ ok: boolean; out: string; err: string }> {
  const proc = Bun.spawn(['git', '--no-optional-locks', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
    env: { ...process.env, GIT_PAGER: 'cat', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  })
  const timer = setTimeout(() => proc.kill(), timeoutMs)
  try {
    const [out, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const code = await proc.exited
    return { ok: code === 0, out, err }
  } finally {
    clearTimeout(timer)
  }
}

export async function isRepo(cwd: string): Promise<boolean> {
  const r = await git(cwd, ['rev-parse', '--is-inside-work-tree'])
  return r.ok && r.out.trim() === 'true'
}

/**
 * 工作区状态。用 porcelain v2 而不是 v1：v2 直接给出 ahead/behind 和重命名信息，
 * 不用再额外跑 rev-list，也不用解析 v1 那套有歧义的短状态码。
 */
export async function status(cwd: string): Promise<GitStatus | null> {
  const r = await git(cwd, ['status', '--porcelain=v2', '--branch', '--untracked-files=all'])
  if (!r.ok) return null

  let branch = ''
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  let detached = false
  let staged = 0
  let unstaged = 0
  let untracked = 0
  let conflicted = 0
  const files: GitFileEntry[] = []

  for (const line of r.out.split('\n')) {
    if (!line) continue
    if (line.startsWith('# branch.head ')) {
      branch = line.slice('# branch.head '.length).trim()
      if (branch === '(detached)') detached = true
      continue
    }
    if (line.startsWith('# branch.upstream ')) {
      upstream = line.slice('# branch.upstream '.length).trim()
      continue
    }
    if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+)\s+-(\d+)/.exec(line)
      if (m) {
        ahead = Number(m[1])
        behind = Number(m[2])
      }
      continue
    }
    if (line.startsWith('#')) continue

    const kind = line[0]
    if (kind === '?') {
      untracked++
      files.push({ path: line.slice(2), indexStatus: '?', worktreeStatus: '?' })
      continue
    }
    if (kind === 'u') {
      // 冲突条目。>0 时 UI 必须挡住继续执行——让 agent 在冲突未解决的树上继续改
      // 是制造更大麻烦。
      conflicted++
      const path = line.split(' ').slice(10).join(' ')
      files.push({ path, indexStatus: 'U', worktreeStatus: 'U' })
      continue
    }
    if (kind === '1' || kind === '2') {
      const parts = line.split(' ')
      const xy = parts[1] ?? '..'
      const idx = xy[0] ?? '.'
      const wt = xy[1] ?? '.'
      if (idx !== '.') staged++
      if (wt !== '.') unstaged++
      if (kind === '1') {
        files.push({ path: parts.slice(8).join(' '), indexStatus: idx, worktreeStatus: wt })
      } else {
        // 重命名条目：路径部分是 `新路径\t旧路径`。
        const rest = parts.slice(9).join(' ')
        const [to, from] = rest.split('\t')
        files.push({
          path: to ?? rest,
          indexStatus: idx,
          worktreeStatus: wt,
          ...(from ? { renamedFrom: from } : {}),
        })
      }
    }
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    staged,
    unstaged,
    untracked,
    conflicted,
    detached,
    files,
  }
}

export async function branches(cwd: string): Promise<GitBranch[]> {
  const fmt = [
    '%(refname:short)',
    '%(HEAD)',
    '%(upstream:short)',
    '%(upstream:track)',
    '%(committerdate:unix)',
    '%(contents:subject)',
  ].join('%09')
  const r = await git(cwd, [
    'for-each-ref',
    '--sort=-committerdate',
    `--format=${fmt}`,
    'refs/heads',
  ])
  if (!r.ok) return []

  return r.out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, head, up, track, date, subject] = line.split('\t')
      const aheadM = /ahead (\d+)/.exec(track ?? '')
      const behindM = /behind (\d+)/.exec(track ?? '')
      return {
        name: name ?? '',
        current: head === '*',
        upstream: up || null,
        ahead: aheadM ? Number(aheadM[1]) : 0,
        behind: behindM ? Number(behindM[1]) : 0,
        lastCommitAt: Number(date ?? 0) * 1000,
        lastCommitSubject: subject ?? '',
      }
    })
}

export async function log(
  cwd: string,
  opts: { limit?: number; ref?: string } = {},
): Promise<GitCommit[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 50))
  // %x1f = 单元分隔符，%x1e = 记录分隔符。用不可打印字符做分隔，
  // 避免提交标题里含制表符或换行时把解析打乱。
  const fmt = ['%H', '%h', '%s', '%an', '%at', '%D'].join('%x1f')
  const args = ['log', `--max-count=${limit}`, `--format=${fmt}%x1e`]
  if (opts.ref) args.push(opts.ref)
  const r = await git(cwd, args)
  if (!r.ok) return []

  return r.out
    .split('\x1e')
    .map((rec) => rec.replace(/^\n/, ''))
    .filter(Boolean)
    .map((rec) => {
      const [hash, shortHash, subject, author, at, refs] = rec.split('\x1f')
      return {
        hash: hash ?? '',
        shortHash: shortHash ?? '',
        subject: subject ?? '',
        author: author ?? '',
        at: Number(at ?? 0) * 1000,
        refs: (refs ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      }
    })
}

/**
 * 取 diff。
 *
 * `ref` 为空时给工作区相对 HEAD 的改动（未提交内容），这是用户最常想看的；
 * 传具体 commit 时给那次提交自身的改动。
 */
export async function diff(
  cwd: string,
  opts: { path?: string; ref?: string; staged?: boolean } = {},
): Promise<string> {
  const args = ['diff', '--no-color', '--no-ext-diff']
  if (opts.ref) {
    // 单个提交的改动：与它的父提交比。根提交没有父，git 会自己处理。
    args.push(`${opts.ref}^!`)
  } else if (opts.staged) {
    args.push('--cached')
  }
  if (opts.path) args.push('--', opts.path)
  const r = await git(cwd, args)
  return r.ok ? r.out : ''
}

/** 读取某个 ref 下的文件内容，用于「改动前长什么样」的对照预览。 */
export async function showFile(cwd: string, ref: string, path: string): Promise<string | null> {
  const r = await git(cwd, ['show', `${ref}:${path}`])
  return r.ok ? r.out : null
}

export function toStateEvent(s: GitStatus): GitStateEvent {
  return {
    type: 'git.state',
    branch: s.branch,
    upstream: s.upstream,
    ahead: s.ahead,
    behind: s.behind,
    staged: s.staged,
    unstaged: s.unstaged,
    untracked: s.untracked,
    conflicted: s.conflicted,
  }
}
