/**
 * 监听分支名的变化。
 *
 * 应用内切换分支的两条路径各自立即广播（`api/git.ts` 切换完成时、`run-control.ts` 收尾时），
 * 这里监听的是**用户在终端中切换**：该操作在应用中没有任何入口，只有文件系统能观察到。
 *
 * **监听目录而不是文件。** git 切换分支的方式是「写入 `HEAD.lock` 再重命名为 `HEAD`」，
 * 监听 `HEAD` 文件时，第一次切换后监听就指向一个已不被引用的 inode，此后不再回调。
 * 实测一次 checkout 在该目录上报告的是 `rename:HEAD`。
 *
 * **只监听最近打开的项目。** 用户同一时刻只能看到一个项目；「最近打开」由
 * `last_opened_at` 定义，切换项目时前端会执行一次 upsert 更新该值，该路径上调用 `retarget`。
 *
 * 边界：这里只回答「当前分支的名称」。提交、暂存、修改文件都不改变分支名，
 * 因此这些操作不在这里报告。
 */

import { type FSWatcher, watch } from 'node:fs'
import { mostRecentWorkspace, type Store } from '@qywork/store'
import type { EventBus } from './bus.ts'
import { gitDir } from './git.ts'
import { publishGitState } from './http-util.ts'

/**
 * 累积一段时间后再查询 git。
 *
 * 一次 checkout 会在 `.git` 上连续触发多次回调（`HEAD.lock` 重命名、`index` 重写各一次），
 * 逐次查询会逐次启动一个 `git` 子进程。
 */
const SETTLE_MS = 120

export interface GitWatch {
  /** 重新指向最近打开的项目。对同一个项目重复调用为空操作。 */
  retarget(): void
  /** 广播一次当前分支名。新连接的客户端依靠它取得初始值。 */
  announce(): void
  stop(): void
}

export function createGitWatch(store: Store, bus: EventBus): GitWatch {
  let root = ''
  let workspaceId = ''
  /** 该工作树的 git 目录（见 `gitDir`）：分支名的变化在此处触发。不是 git 仓库时为 null。 */
  let inner: FSWatcher | null = null
  /** `<root>`：仅用于等待 `.git` 出现，`git init` 之后才有可监听的目录。 */
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
   * 监听一个目录。**无法监听时返回 null**：目录不存在（不是 git 仓库）、权限不足、
   * 平台不支持，三种情形都不应导致服务无法启动，代价只是分支名为空。
   */
  const hold = (path: string, onName: (name: string) => void): FSWatcher | null => {
    try {
      const w = watch(path, (_kind, name) => {
        if (name) onName(String(name))
      })
      // 监听期间目录被删除会触发 error 事件。EventEmitter 的 error 无人处理时
      // 整个进程会崩溃，因此这里必须处理。
      w.on('error', () => w.close())
      return w
    } catch {
      return null
    }
  }

  /**
   * 查询 git 目录需要等待一个子进程。返回时若 `root` 已被 `retarget` 替换或被 `stop` 清空，
   * 则放弃本次挂载：否则挂载的是旧项目的监听，或一个无人关闭、阻止进程退出的监听。
   */
  const attachInner = async () => {
    if (inner) return
    const target = root
    const dir = await gitDir(target)
    if (!dir || inner || root !== target) return
    // 不处理 `HEAD.lock`：它是写入过程中的中间状态，此时查询 git 取得的仍是旧名称。
    inner = hold(dir, (name) => {
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
      if (name === '.git') void attachInner()
    })
    void attachInner()
    // 切换项目后立即广播一次，不等待 `.git` 的变化：分支名必须立即更新为新项目的值。
    announce()
  }

  return {
    retarget,
    announce,
    stop() {
      if (settle) clearTimeout(settle)
      settle = null
      root = ''
      inner?.close()
      inner = null
      outer?.close()
      outer = null
    },
  }
}
