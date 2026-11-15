/**
 * 变更面板：按页读取会话中写入过文件的轮次，并把实时到达的写入合并进已读取的表。
 */

import type { ConversationChangesPageResponse } from '@qywork/core'
import { produce } from 'solid-js/store'
import { client } from '../client.ts'
import { type ChangeStep, type ChangesView, type ChangeTurn, setState, state } from '../state.ts'
import { HISTORY_TIMEOUT_MS } from './history.ts'

const CHANGES_PAGE_SIZE = 10

async function fetchChangesPage(
  id: string,
  before: string | null,
  limit = CHANGES_PAGE_SIZE,
): Promise<Pick<ChangesView, 'turns' | 'totals' | 'nextCursor'>> {
  const query = new URLSearchParams({ limit: String(limit) })
  if (before) query.set('before', before)
  const page = await client.api<ConversationChangesPageResponse>(
    `/api/conversations/${id}/changes?${query}`,
    { signal: AbortSignal.timeout(HISTORY_TIMEOUT_MS) },
  )
  return { turns: page.turns, totals: page.totals, nextCursor: page.nextCursor }
}

/**
 * 重新读取最新一轮及整条会话的合计。两处调用：
 *
 * - 派发任务的节点进入终态：子 agent 的写入位于其自身的子会话中，父会话收不到对应回执；
 *   外部 CLI 的写入记录在该节点上。两者都由服务端投影归入父轮次。
 * - 本轮执行完毕：实时回执逐条追加，记录的是每次报告的内容；而面板上的一行
 *   是整轮的净效果（`foldFileChanges`），一轮中先创建后删除的路径会立即从行上消失，
 *   合计却仍计入它。服务端的数据两处都已折叠，重新读取一次即可统一为折叠后的口径。
 *
 * `limit=1` 取得最新一个有写入的轮次：本轮有写入时即为本轮；否则取得更早的轮次，替换后不产生变化。
 * 未打开过变更面板的会话没有该表，立即返回，不发送请求。
 */
export async function refreshLatestChangeTurn(id: string): Promise<void> {
  const changes = state.views[id]?.changes
  if (!changes || changes.loading !== null) return
  try {
    const page = await fetchChangesPage(id, null, 1)
    setState(
      produce((s) => {
        const c = s.views[id]?.changes
        if (!c) return
        c.totals = page.totals
        for (const turn of page.turns) {
          const at = c.turns.findIndex((t) => t.userMessageId === turn.userMessageId)
          if (at >= 0) c.turns[at] = turn
          else c.turns.unshift(turn)
        }
      }),
    )
  } catch (error) {
    setState(
      produce((s) => {
        const c = s.views[id]?.changes
        if (c) c.error = changesErrorMessage(error)
      }),
    )
  }
}

function changesErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'TimeoutError') return '加载历史记录超时，请重试'
  return error instanceof Error ? error.message : String(error)
}

/**
 * 把一条写入合并进变更面板。相同 id 不重复加入：首页请求进行中到达的事件会与响应重叠。
 * 本轮尚无分节时新建一节放在最前：实时到达的写入必定属于最新的轮次。
 */
export function appendChange(
  changes: ChangesView,
  seed: Pick<ChangeTurn, 'userMessageId' | 'text' | 'origin'>,
  step: ChangeStep,
): void {
  if (changes.turns.some((t) => t.steps.some((s) => s.id === step.id))) return
  let turn = changes.turns.find((t) => t.userMessageId === seed.userMessageId)
  if (!turn) {
    turn = { ...seed, createdAt: Date.now(), steps: [] }
    changes.turns.unshift(turn)
  }
  turn.steps.push(step)
  for (const c of step.fileChanges) {
    if (!changes.totals.paths.includes(c.path)) changes.totals.paths.push(c.path)
    changes.totals.additions += c.additions ?? 0
    changes.totals.deletions += c.deletions ?? 0
  }
}

/**
 * 变更面板首页。面板打开时调用；已读取或正在读取时不再读取，之后由实时追加保持更新。
 * 失败后再次调用即重试：从首页重新开始，已加载的更早分页由哨兵重新读取。
 *
 * 写入时以账本页为准：请求期间实时追加的写入按 step id 去重后合并回去，
 * 合计取账本值再加上未合并的条目，与 `loadOlderConversation` 的去重口径相同。
 */
export async function loadConversationChanges(id: string): Promise<void> {
  const current = state.views[id]
  if (!current) return
  if (current.changes && (current.changes.loading !== null || current.changes.error === null))
    return
  await readFirstChangesPage(id)
}

/**
 * 已读取过的变更面板从首页重新读取；没有读取过或读取在途时不读取。
 *
 * 后台命令结束时，转入后台之后的改动追加到发起它的 step（`file.changed` 的 runId 不是运行中的一轮），
 * 该 step 所在的轮次不一定是最新一轮，只重新读取最新一轮（`refreshLatestChangeTurn`）会遗漏它。
 * 已加载的更早分页随之丢弃，由哨兵按新游标重新读取。
 */
export async function reloadConversationChanges(id: string): Promise<void> {
  if (state.views[id]?.changes?.loading !== null) return
  await readFirstChangesPage(id)
}

async function readFirstChangesPage(id: string): Promise<void> {
  const current = state.views[id]
  if (!current) return
  // 请求发出前已在表中的写入不并回：首页没有的是更早的分页，按新游标重新读取。
  const earlier = new Set(current.changes?.turns.flatMap((t) => t.steps.map((s) => s.id)) ?? [])
  if (current.changes) {
    setState('views', id, 'changes', { loading: 'initial', error: null })
  } else {
    setState('views', id, 'changes', {
      turns: [],
      totals: { paths: [], additions: 0, deletions: 0 },
      nextCursor: null,
      loading: 'initial',
      error: null,
    })
  }
  try {
    const page = await fetchChangesPage(id, null)
    setState(
      produce((s) => {
        const changes = s.views[id]?.changes
        if (!changes) return
        const known = new Set(page.turns.flatMap((t) => t.steps.map((step) => step.id)))
        const pending = changes.turns.map((turn) => ({
          turn,
          steps: turn.steps.filter((step) => !known.has(step.id) && !earlier.has(step.id)),
        }))
        changes.turns = page.turns
        changes.totals = page.totals
        changes.nextCursor = page.nextCursor
        changes.loading = null
        for (const { turn, steps } of pending) {
          for (const step of steps) appendChange(changes, turn, step)
        }
      }),
    )
  } catch (error) {
    setState(
      produce((s) => {
        const changes = s.views[id]?.changes
        if (!changes) return
        changes.loading = null
        changes.error = changesErrorMessage(error)
      }),
    )
  }
}

/** 再向前读取一页写入过文件的轮次。没有更早的轮次或正在读取时直接返回 false。 */
export async function loadOlderConversationChanges(id: string): Promise<boolean> {
  const changes = state.views[id]?.changes
  if (!changes || changes.loading !== null || !changes.nextCursor) return false
  const before = changes.nextCursor
  setState('views', id, 'changes', { loading: 'older', error: null })
  try {
    const page = await fetchChangesPage(id, before)
    setState(
      produce((s) => {
        const c = s.views[id]?.changes
        if (!c) return
        c.turns.push(...page.turns)
        c.nextCursor = page.nextCursor
        c.loading = null
      }),
    )
    return true
  } catch (error) {
    setState(
      produce((s) => {
        const c = s.views[id]?.changes
        if (!c) return
        c.loading = null
        c.error = changesErrorMessage(error)
      }),
    )
    return false
  }
}
