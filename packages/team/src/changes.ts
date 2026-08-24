/**
 * 量一次外部 CLI 到底改了什么。
 *
 * ## 用临时索引的快照树，不用 `git status`，也不用 `git diff HEAD`
 *
 * 跑前跑后各做一次 `git add -A` + `git write-tree`，两棵树相 diff：
 *
 * - **与 HEAD 无关**，所以被调度的 CLI 自己 `git commit` 了照样量得到；
 *   按工作区脏文件算的话，它一提交这边就一无所获。
 * - **跑前那次把用户本来就有的脏改动吃进基线**，不会记到 CLI 头上。
 * - **untracked 一并进树**，新建的文件有真实增删行数。
 * - `.gitignore` 由 `add -A` 天然遵守；换行符两端走同一套 normalize，
 *   所以 autocrlf 不会制造出一堆无关改动。
 *
 * 临时索引会往对象库写几个游离对象，git 自己的 gc 会收。
 *
 * **不开改名识别**：一次改名报成一删一增。开了之后 numstat 会把路径压成
 * `src/{a => b}.ts` 那种紧凑形式，解析它比多两行清单更容易出错。
 */

import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileChange } from '@qywork/core'

/** 回执里最多列几个文件。列不下的由 `total` 说出来，不能只给一截还让人以为是全部。 */
const RECEIPT_CAP = 20

async function git(
  args: string[],
  cwd: string,
  env?: Record<string, string>,
): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      ...(env ? { env: { ...process.env, ...env } } : {}),
    })
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    return { ok: code === 0, stdout }
  } catch {
    // git 没装、或者路径根本不存在。两种都当「量不了」，与不是仓库同一档。
    return { ok: false, stdout: '' }
  }
}

/**
 * 把此刻的工作区照一棵树。
 *
 * **不是 git 仓库（或者没有 git）时返回 null**，调用方据此让整个「改了什么」缺席——
 * 不要回落成空清单，空清单的意思是「确定没改」。
 */
export async function snapshotTree(root: string): Promise<string | null> {
  const index = join(tmpdir(), `qywork-cli-index-${randomBytes(8).toString('hex')}`)
  try {
    const added = await git(['add', '-A'], root, { GIT_INDEX_FILE: index })
    if (!added.ok) return null
    const tree = await git(['write-tree'], root, { GIT_INDEX_FILE: index })
    const id = tree.stdout.trim()
    return tree.ok && id ? id : null
  } finally {
    // 临时索引不留在磁盘上：它是这一次量测的中间物，与工作区无关。
    rmSync(index, { force: true })
  }
}

/**
 * 从 `base` 那棵树到此刻，改了哪些文件。
 *
 * 返回的 `changes` 最多 `RECEIPT_CAP` 条（按改动量排），`total` 是真实条数。
 * 量不了时返回 null，语义同 `snapshotTree`。
 */
export async function changesSince(
  root: string,
  base: string,
): Promise<{ changes: FileChange[]; total: number } | null> {
  const now = await snapshotTree(root)
  if (!now) return null
  if (now === base) return { changes: [], total: 0 }

  // 两趟：numstat 给增删行数，name-status 给动作。git 不会在一次输出里同时给全这两样。
  // `core.quotePath=false`：不然中文路径会被转义成 \344\270\255 那种八进制串。
  const flags = ['-c', 'core.quotePath=false', 'diff-tree', '-r', '--no-renames']
  const nums = await git([...flags, '--numstat', base, now], root)
  const stats = await git([...flags, '--name-status', base, now], root)
  if (!nums.ok || !stats.ok) return null

  const kindOf = new Map<string, FileChange['changeType']>()
  for (const line of stats.stdout.split('\n')) {
    const [letter, path] = line.split('\t')
    if (!letter || !path) continue
    kindOf.set(path, letter[0] === 'A' ? 'created' : letter[0] === 'D' ? 'deleted' : 'modified')
  }

  const all: FileChange[] = []
  for (const line of nums.stdout.split('\n')) {
    const [adds, dels, path] = line.split('\t')
    if (!path) continue
    // 二进制文件这两格是 `-`：报 0 行，不报 NaN。它改没改由动作那一栏说。
    all.push({
      path,
      changeType: kindOf.get(path) ?? 'modified',
      additions: Number.parseInt(adds ?? '', 10) || 0,
      deletions: Number.parseInt(dels ?? '', 10) || 0,
    })
  }

  all.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions))
  return { changes: all.slice(0, RECEIPT_CAP), total: all.length }
}
