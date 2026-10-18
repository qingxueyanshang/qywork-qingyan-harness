/**
 * 会话临时目录的删除。目录的位置由 `tools` 的 `conversationTempDir` 定义，本文件只负责两个删除时机：
 *
 * - 一轮结束：删除本轮的 Office 目录（`officeRunDir`）。成功的调用已即时删除，剩下的是未提交写入的
 *   候选文件与未处理完的调用，它们只在本轮内有效。
 * - 任务完成或删除会话：删除会话临时目录及其子会话的目录。
 *
 * 任务是否完成只读取账本与运行表，不由模型判断：待办未完成、等待用户、被中断时都不删除，
 * 未完成的任务的临时文件随删除会话一并删除。
 *
 * 一轮结束时的删除先把目录改名移入 `.tmp/.trash/<本次>/`，再在后台删除。不要改为就地递归删除并等待：
 * 删除大目录需要数秒，期间该轮尚未注销，紧接着发起的新一轮会被拒绝；不等待则新一轮写入的文件
 * 可能被正在进行的删除删掉。改名在同一磁盘上是一次操作，之后新一轮使用的是新建的空目录。
 * 改名失败（目录中的文件被其他程序占用）时保留原目录，下一次删除时机再处理；后台删除未完成的
 * 回收目录在下一次删除时一并删除。
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { type ConversationId, log, type RunId, type StopReason } from '@qywork/core'
import { latestTodos, listChildConversations, type Store } from '@qywork/store'
import { conversationTempDir, officeRunDir } from '@qywork/tools'

function warn(action: string, dir: string, err: unknown): void {
  log.warn('temp', `临时目录未能${action}：${err instanceof Error ? err.message : String(err)}`, {
    dir,
  })
}

async function remove(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch((err) => warn('删除', dir, err))
}

/** 把目录移入回收目录后在后台删除，返回时目录已不在原位置（或改名失败、保持原样）。 */
async function discard(workspaceRoot: string, dirs: string[]): Promise<void> {
  const trashRoot = join(workspaceRoot, '.tmp', '.trash')
  const trash = join(trashRoot, randomUUID())
  await mkdir(trash, { recursive: true })
  // 逐个改名：其中可能同时有父目录与其下的子目录，并发改名的结果取决于先后。
  // 父目录先移走时子目录随之移走，再改名子目录得到 ENOENT，属于正常结果。
  for (const [i, dir] of dirs.entries()) {
    await rename(dir, join(trash, String(i))).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') warn('移入回收目录', dir, err)
    })
  }
  // 整个回收目录一并删除：包括以前未删完的部分。并发的删除对同一路径使用 `force`，互不报错。
  void remove(trashRoot)
}

/** 删除一条会话及其全部子会话的临时目录。必须在会话记录删除之前调用：子会话随父会话级联删除后无法再列出。 */
export async function removeConversationTemp(
  store: Store,
  workspaceRoot: string,
  conversationId: ConversationId,
): Promise<void> {
  const ids = [conversationId, ...listChildConversations(store, conversationId).map((c) => c.id)]
  await Promise.all(ids.map((id) => remove(conversationTempDir(workspaceRoot, id))))
}

/**
 * 一轮结束时的删除。任务完成的判据：顶层会话、本轮正常结束、本轮所接续的待办存在且全部完成、
 * 没有运行中的子 agent。待办按 `latestTodos` 的接续规则读取：用户新发起的一轮只看本轮提交的清单，
 * 回执发起的一轮沿用会话清单。
 */
export async function releaseRunTemp(input: {
  store: Store
  workspaceRoot: string
  conversationId: ConversationId
  runId: RunId
  stopReason: StopReason | null
  topLevel: boolean
  subagentsRunning: boolean
}): Promise<void> {
  const { store, workspaceRoot, conversationId, runId } = input
  const dirs = [officeRunDir(workspaceRoot, conversationId, runId)]
  const todos = latestTodos(store, conversationId, runId)
  const taskCompleted =
    input.topLevel &&
    !input.subagentsRunning &&
    input.stopReason === 'completed' &&
    !!todos?.length &&
    todos.every((todo) => todo.status === 'completed')
  if (taskCompleted) {
    dirs.push(
      conversationTempDir(workspaceRoot, conversationId),
      ...listChildConversations(store, conversationId).map((c) =>
        conversationTempDir(workspaceRoot, c.id),
      ),
    )
  }
  await discard(workspaceRoot, dirs)
}
