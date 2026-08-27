/**
 * 分支名变了怎么知道。
 *
 * 应用里切分支的那两条路各自当场广播（`api/git.ts` 切完那一下、`run-control.ts` 收尾），
 * 这里盯的是**用户在终端里切**——那件事在应用里没有任何入口，只有文件系统看得见。
 *
 * **盯目录不盯文件。** git 换分支是「写 `HEAD.lock` 再改名成 `HEAD`」，盯着 `HEAD`
 * 这个文件的话，第一次切完监听就落在一个没人再指向的 inode 上，之后一次都不回调。
 * 实测一次 checkout 在这个目录上报的是 `rename:HEAD`。
 *
 * **只盯最近打开的那个项目。** 用户同一时刻只看得见一个；「最近打开」由
 * `last_opened_at` 定义，切项目时前端会 upsert 一次把它顶上来，那条路上调 `retarget`。
 *
 * 边界：这里只回答「当前分支叫什么」。提交、暂存、改文件都不动分支名，
 * 因此那几件事不在这里报，也不该在这里报。
 */

import { type FSWatcher, watch } from 'node:fs'
import { join } from 'node:path'
import { mostRecentWorkspace, type Store } from '@qywork/store'
import type { EventBus } from './bus.ts'
import { publishGitState } from './http-util.ts'

/**
 * 攒一下再问 git。
 *
 * 一次 checkout 在 `.git` 上会连着回调好几次（`HEAD.lock` 改名、`index` 重写各算一次），
 * 逐次问就是逐次起一个 `git` 子进程。
 */
const SETTLE_MS = 120

export interface GitWatch {
  /** 重新指向最近打开的那个项目。同一个项目重复调是空操作。 */
  retarget(): void
  /** 现在的分支名广播一次。新连上的客户端靠它拿到第一份。 */
  announce(): void
  stop(): void
}

export function createGitWatch(store: Store, bus: EventBus): GitWatch {
  let root = ''
  let workspaceId = ''
  /** `<root>/.git`：分支名的变化在这里报。不是 git 仓库时是 null。 */
  let inner: FSWatcher | null = null
  /** `<root>`：只为了等 `.git` 出现——`git init` 之后才有得盯。 */
  let outer: FSWatcher | null = null
  let settle: ReturnType<typeof setTimeout> | null = null

  const announce = () => {
    if (settle) clearTimeout(settle)
    settle = setTimeout(() => {
      settle = null
      if (root) void publishGitState(root, workspaceId, bus)
    }, SETTLE_MS)
  }

  /**
   * 盯一个目录。**盯不上就回 null**：目录不存在（不是 git 仓库）、权限不足、
   * 平台不支持，三种都不该让服务起不来——代价只是分支那一格空着。
   */
  const hold = (path: string, onName: (name: string) => void): FSWatcher | null => {
    try {
      const w = watch(path, (_kind, name) => {
        if (name) onName(String(name))
      })
      // 目录在盯着的时候被删掉会抛到 error 上。EventEmitter 的 error 没人接就是
      // 整个进程崩，所以这里必须接住。
      w.on('error', () => w.close())
      return w
    } catch {
      return null
    }
  }

  const attachInner = () => {
    if (inner) return
    // `HEAD.lock` 不算：那是写到一半的中间态，此刻问 git 拿到的还是旧名字。
    inner = hold(join(root, '.git'), (name) => {
      if (name === 'HEAD') announce()
    })
    if (inner) announce()
  }

  const retarget = () => {
    const recent = mostRecentWorkspace(store)
    if (!recent || recent.rootPath === root) return
    root = recent.rootPath
    workspaceId = recent.id
    inner?.close()
    inner = null
    outer?.close()
    outer = hold(root, (name) => {
      if (name === '.git') attachInner()
    })
    attachInner()
    // 换了项目就先报一份，不等 `.git` 有动静：分支那一格要立刻换成新项目的。
    announce()
  }

  return {
    retarget,
    announce,
    stop() {
      if (settle) clearTimeout(settle)
      settle = null
      inner?.close()
      inner = null
      outer?.close()
      outer = null
    },
  }
}
