/**
 * 量一次外部 CLI 到底改了什么。
 *
 * ## 自带一个临时仓库，不借用工作区那个
 *
 * 跑前跑后各 `git add -A` + `write-tree` 一次，两棵树相 diff。索引和对象都落在
 * 一个临时 git 目录里，**跟工作区自己是不是仓库、是谁的仓库毫无关系**：
 *
 * - 工作区**不是** git 仓库照样量得到——它不需要是。
 * - 工作区是**别的仓库的子目录**时也对。借用外层仓库的代价实测付过：
 *   工作区被外层的 `.gitignore` 挡着，两次快照完全相同，于是 CLI 明明写了文件，
 *   回执上却是「没有改动」——一个具体而错误的结论。
 * - 被调度的 CLI 自己 `git commit` 了不影响：这边的树跟它的 HEAD 无关。
 * - 跑前那次把用户本来就有的脏改动吃进基线，不会记到 CLI 头上。
 * - untracked 一并进树，新建的文件有真实增删行数；工作区自己的 `.gitignore` 仍然生效。
 *
 * 工作区里那个 `.git` 必须排除，否则整个对象库会被当成普通文件加进树。
 *
 * **不开改名识别**：一次改名报成一删一增。开了之后 numstat 会把路径压成
 * `src/{a => b}.ts` 那种紧凑形式，解析它比多两行清单更容易出错。
 *
 * 代价：`add -A` 要把工作区每个文件哈希一遍，大工作区上一次快照是秒级。
 * 一次派活两次快照，与被调度的 CLI 自己跑的那几十秒相比可以忽略。
 */

import { randomBytes } from 'node:crypto'
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FileChange } from '@qywork/core'

/** 回执里最多列几个文件。列不下的由 `total` 说出来，不能只给一截还让人以为是全部。 */
const RECEIPT_CAP = 20

/** 工作区自己的 `.git`：它是另一个仓库的内脏，不是这次要量的内容。 */
const NOT_DOT_GIT = ':!.git'

async function git(args: string[], cwd: string): Promise<{ ok: boolean; stdout: string }> {
  try {
    const proc = Bun.spawn(['git', ...args], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const stdout = await new Response(proc.stdout).text()
    const code = await proc.exited
    return { ok: code === 0, stdout }
  } catch {
    // git 没装、或者路径根本不存在。两种都当「量不了」。
    return { ok: false, stdout: '' }
  }
}

/** 把此刻的工作区照一棵树，落在这次量测自己的仓库里。 */
async function snapshot(gitDir: string, root: string): Promise<string | null> {
  const added = await git(
    ['--git-dir', gitDir, '--work-tree', '.', 'add', '-A', '--', '.', NOT_DOT_GIT],
    root,
  )
  if (!added.ok) return null
  const tree = await git(['--git-dir', gitDir, 'write-tree'], root)
  const id = tree.stdout.trim()
  return tree.ok && id ? id : null
}

/** 一次量测：从 `begin` 到 `end` 之间工作区变了什么。 */
export interface ChangeProbe {
  gitDir: string
  base: string
}

/**
 * 起进程**之前**照下基线。
 *
 * 晚一步照就把它已经改过的那部分吃进基线了。量不了时回 null，
 * 调用方据此让整个「改了什么」缺席——**不要回落成空清单**，
 * 空清单的意思是「确定没改」。
 */
export async function beginProbe(root: string): Promise<ChangeProbe | null> {
  const gitDir = join(tmpdir(), `qywork-probe-${randomBytes(8).toString('hex')}.git`)
  const init = await git(['--git-dir', gitDir, 'init', '-q', '--bare'], root)
  if (!init.ok) return null
  const base = await snapshot(gitDir, root)
  if (!base) {
    rmSync(gitDir, { recursive: true, force: true })
    return null
  }
  return { gitDir, base }
}

/**
 * 跑完再照一次，两棵树相 diff。
 *
 * `files` 最多 `RECEIPT_CAP` 条（按改动量排），`total` 是真实条数——**两者必须同行**：
 * 只给一截还让人以为是全部，比不给更坏。`total: 0` 是「确定没改」，与量不了（null）
 * 不是一回事。无论成败，这次量测的临时仓库都在这里删掉。
 */
export async function endProbe(
  probe: ChangeProbe,
  root: string,
): Promise<{ files: FileChange[]; total: number } | null> {
  try {
    const now = await snapshot(probe.gitDir, root)
    if (!now) return null
    if (now === probe.base) return { files: [], total: 0 }

    // 两趟：numstat 给增删行数，name-status 给动作。git 不会在一次输出里同时给全这两样。
    // `core.quotePath=false`：不然中文路径会被转义成 \344\270\255 那种八进制串。
    const flags = [
      '--git-dir',
      probe.gitDir,
      '-c',
      'core.quotePath=false',
      'diff-tree',
      '-r',
      '--no-renames',
    ]
    const nums = await git([...flags, '--numstat', probe.base, now], root)
    const stats = await git([...flags, '--name-status', probe.base, now], root)
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
    return { files: all.slice(0, RECEIPT_CAP), total: all.length }
  } finally {
    rmSync(probe.gitDir, { recursive: true, force: true })
  }
}

/**
 * 量不了的时候，那句话。
 *
 * 走到这里只剩一种原因：这台机器上 git 跑不起来。工作区是不是仓库已经不影响量测了
 * （量测自带仓库），所以不必再去探。
 */
export const UNMEASURABLE = '这台机器上跑不了 git，改动量不出来'
