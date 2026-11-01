/**
 * 宠物：由运行状态派生的心情、未查看的结果、气泡与本机偏好。
 *
 * 不另记运行状态。「工作中」取 `busyConversations`，「操作电脑」取 `desktopTargets`；
 * 完成与出错在会话变闲时读取账本中该会话最新一轮的状态得出。不要改为监听 `run.finished`：
 * 客户端只订阅当前会话的 run 事件，其他会话的终态不会到达。
 *
 * 「未查看结果」只记录用户是否看过，与运行状态不重叠：用户正在查看该会话时不记录，
 * 打开该会话或在宠物列表中点击它时移除。
 *
 * 宠物只显示在桌面外壳的宠物窗口中。推导只在主窗口进行，宠物窗口只显示主窗口推送的结果，
 * 不建立第二条事件连接，否则两处各有一份未查看结果，在一处打开会话后另一处无从得知。
 */

import {
  type Conversation,
  type ConversationRunsResponse,
  type PetEntry as PetPackEntry,
  type PetState,
  todoProgress,
} from '@qywork/core'
import { createEffect, createRoot, createSignal, on, onCleanup } from 'solid-js'
import { ApiError } from '../../client.ts'
import { activateWorkspace, selectConversation } from '../actions.ts'
import { client, petApply, petsChange } from '../connection.ts'
import { state } from '../state.ts'
import { workspace } from '../ui.ts'

/** 显示位置：桌面（外壳的透明窗口）或隐藏。缺省为桌面。 */
export type PetPlace = 'desktop' | 'hidden'

export interface PetResult {
  conversationId: string
  title: string
  outcome: 'done' | 'failed'
  at: number
}

/** 宠物列表中的一行：运行中的会话或未查看的结果。 */
export interface PetEntry {
  conversationId: string
  title: string
  status: 'running' | 'done' | 'failed'
}

interface ConversationMeta {
  title: string
  parent: boolean
  workspace: { id: string; rootPath: string } | null
}

const PREFS_KEY = 'qywork.pet'

/** 气泡显示多久后收起。 */
export const PET_BUBBLE_MS = 6000

/**
 * 判定「自变忙以来的新轮次」时容许的时钟偏差。变忙时刻取自本机时钟，轮次的创建时刻取自服务端时钟，
 * 桌面端两者是同一台机器；该值覆盖事件到达的延迟。
 */
const CLOCK_SLACK_MS = 10_000

interface PetPrefs {
  place: PetPlace
  /** 宠物包 id。null 表示内置的默认宠物。 */
  pack: string | null
}

function readPrefs(): PetPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<PetPrefs> | null
    const place = v?.place === 'hidden' ? 'hidden' : 'desktop'
    return { place, pack: typeof v?.pack === 'string' ? v.pack : null }
  } catch {
    return { place: 'desktop', pack: null }
  }
}

const [prefs, setPrefsSignal] = createSignal<PetPrefs>(readPrefs())
const [results, setResults] = createSignal<readonly PetResult[]>([])
const [bubble, setBubble] = createSignal<PetResult | null>(null)
const [metas, setMetas] = createSignal<ReadonlyMap<string, ConversationMeta>>(new Map())

export const petPrefs = prefs
export const petResults = results
export const petBubble = bubble

/** 选用的宠物包。null 表示内置宠物，或选用的宠物包尚未读取。 */
const [pack, setPack] = createSignal<PetPackEntry | null>(null)
export const petPack = pack

/** 设置页显示的宠物列表。未读取时为 null。 */
const [library, setLibrary] = createSignal<PetPackEntry[] | null>(null)
export const petLibrary = library

/** 用户宠物包某一帧的直链。`v` 取修改时间，理由同 `skinImageUrl`。 */
export function petFrameUrl(entry: PetPackEntry, name: string): string {
  const path = `/api/pets/${encodeURIComponent(entry.id)}/files/${encodeURIComponent(name)}`
  return client.assetUrl(`${path}?v=${Math.round(entry.updatedAt)}`)
}

export async function refreshPetLibrary(): Promise<void> {
  setLibrary((await client.api<{ pets: PetPackEntry[] }>('/api/pets')).pets)
}

export async function removePet(id: string): Promise<void> {
  await client.api(`/api/pets/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/**
 * 读取选用的宠物包。已不存在（404）时切回内置宠物；其他错误保留当前显示，连接恢复后再次读取。
 */
async function loadPack(): Promise<void> {
  const id = prefs().pack
  if (!id) {
    setPack(null)
    return
  }
  try {
    const entry = await client.api<PetPackEntry>(`/api/pets/${encodeURIComponent(id)}`)
    if (prefs().pack === id) setPack(entry)
  } catch (e) {
    if (e instanceof ApiError && e.status === 404 && prefs().pack === id)
      setPetPrefs({ pack: null })
  }
}

export function setPetPrefs(next: Partial<PetPrefs>): void {
  const merged = { ...prefs(), ...next }
  setPrefsSignal(merged)
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(merged))
  } catch {
    // 保存失败只影响下次启动时恢复，本次修改已生效。
  }
}

/** 会话标题与归属。当前项目的会话取自列表，其他项目的会话按需读取并缓存。 */
function metaOf(id: string): ConversationMeta | null {
  const local = state.conversations.find((c) => c.id === id)
  if (local) {
    const ws = workspace()
    return {
      title: local.title,
      parent: false,
      workspace: ws ? { id: ws.id, rootPath: ws.root } : null,
    }
  }
  return metas().get(id) ?? null
}

async function loadMeta(id: string): Promise<ConversationMeta | null> {
  const known = metaOf(id)
  if (known) return known
  try {
    const r = await client.api<{
      conversation: Conversation
      workspace: { id: string; rootPath: string } | null
    }>(`/api/conversations/${encodeURIComponent(id)}`)
    const meta = {
      title: r.conversation.title,
      parent: r.conversation.parentConversationId !== null,
      workspace: r.workspace,
    }
    setMetas((m) => new Map(m).set(id, meta))
    return meta
  } catch {
    return null
  }
}

const titleOf = (id: string) => metaOf(id)?.title || '新对话'

/** 运行中的顶层会话。子会话的运行属于派发它的会话，不单独列出。 */
function runningIds(): string[] {
  return state.busyConversations.filter((id) => metaOf(id)?.parent !== true)
}

/** 当前状态，优先级与 `PET_STATES` 的顺序一致。 */
export function petMood(): PetState {
  if (state.desktopTargets.some((t) => t.foreground)) return 'desktop'
  if (results().some((r) => r.outcome === 'failed')) return 'failed'
  if (runningIds().length > 0) return 'working'
  if (results().length > 0) return 'done'
  return 'idle'
}

/**
 * 宠物旁的数字。多个会话同时运行时为会话数；只有当前会话在运行时为它的待办进度。
 * 其他会话的待办不会到达客户端（只订阅当前会话），因此不显示。
 */
export function petBadge(): string | null {
  const running = runningIds()
  if (running.length >= 2) return String(running.length)
  if (running.length === 1 && running[0] === state.activeConversation && state.todos.length) {
    const p = todoProgress(state.todos)
    return `${p.done}/${p.total}`
  }
  return null
}

/** 列表：运行中的在前，其后是出错与完成的结果（新的在前）。 */
export function petEntries(): PetEntry[] {
  const running = runningIds()
  const rows: PetEntry[] = running.map((id) => ({
    conversationId: id,
    title: titleOf(id),
    status: 'running',
  }))
  for (const r of [...results()].sort((a, b) => b.at - a.at)) {
    if (!running.includes(r.conversationId)) {
      rows.push({ conversationId: r.conversationId, title: r.title, status: r.outcome })
    }
  }
  return rows
}

function dropResult(id: string): void {
  setResults((list) => list.filter((r) => r.conversationId !== id))
  if (bubble()?.conversationId === id) setBubble(null)
}

/** 打开列表中的一条会话：其他项目的会话先切换项目。随即移除它的结果。 */
export async function openPetEntry(id: string): Promise<void> {
  dropResult(id)
  const meta = await loadMeta(id)
  const target = meta?.workspace
  if (target && target.id !== workspace()?.id) await activateWorkspace({ path: target.rootPath })
  await selectConversation(id)
}

/** 停止列表中运行中的会话，与输入框旁的停止按钮发送同一条指令。 */
export function stopPetEntry(id: string): void {
  client.send({ type: 'conversation.interrupt', conversationId: id as never })
}

/** 用户此刻是否看得到该会话：它是当前会话，且窗口可见并处于前台。 */
function watching(id: string): boolean {
  return id === state.activeConversation && !document.hidden && document.hasFocus()
}

/**
 * 会话变闲：读取它最新一轮的状态并记录结果。
 *
 * `since` 是观察到它变忙的时刻。本轮指此后创建或此后结束的最新一轮：连接时已在运行的会话，
 * 其轮次创建于观察之前，但结束于观察之后。两个条件都不满足说明本轮在启动前即被拒绝
 * （未配置 key 等），记为出错。被中断的轮次是用户自己停止的，不记录，并清除该会话之前的结果。
 */
async function settle(id: string, since: number): Promise<void> {
  const meta = await loadMeta(id)
  if (meta?.parent) return
  let runs: ConversationRunsResponse
  try {
    runs = await client.api<ConversationRunsResponse>(
      `/api/conversations/${encodeURIComponent(id)}/runs`,
    )
  } catch {
    return
  }
  if (state.busyConversations.includes(id)) return
  const from = since - CLOCK_SLACK_MS
  const latest = runs.runs
    .filter((r) => r.createdAt >= from || (r.finishedAt !== null && r.finishedAt >= from))
    .reduce<(typeof runs.runs)[number] | null>(
      (a, r) => (!a || r.createdAt > a.createdAt ? r : a),
      null,
    )
  const outcome = !latest
    ? 'failed'
    : latest.status === 'done'
      ? 'done'
      : latest.status === 'failed'
        ? 'failed'
        : null
  if (!outcome || watching(id)) {
    dropResult(id)
    return
  }
  const result: PetResult = {
    conversationId: id,
    title: meta?.title || titleOf(id),
    outcome,
    at: Date.now(),
  }
  setResults((list) => [...list.filter((r) => r.conversationId !== id), result])
  setBubble(result)
}

/**
 * 开始推导。由入口在挂载后调用，理由同 `observeSkins`：顶层 effect 会随 import 在单测中运行。
 */
export function observePet(): () => void {
  return createRoot((dispose) => {
    const since = new Map<string, number>()
    createEffect(
      on(
        () => [...state.busyConversations],
        (ids) => {
          const now = Date.now()
          for (const id of ids) {
            if (!since.has(id)) {
              since.set(id, now)
              void loadMeta(id)
            }
          }
          for (const [id, at] of [...since]) {
            if (ids.includes(id)) continue
            since.delete(id)
            void settle(id, at)
          }
        },
      ),
    )

    // 选用的宠物包：连接就绪或改选时读取；库中该宠物被修改时重新读取，被删除时切回内置宠物。
    createEffect(
      on([() => state.connection === 'ready', () => prefs().pack], ([ready]) => {
        if (ready) void loadPack()
      }),
    )
    createEffect(
      on(
        petsChange,
        (change) => {
          if (!change) return
          if (change.id === prefs().pack) {
            if (change.removed) setPetPrefs({ pack: null })
            else void loadPack()
          }
          if (library() !== null) void refreshPetLibrary().catch(() => undefined)
        },
        { defer: true },
      ),
    )
    createEffect(
      on(
        petApply,
        (req) => {
          if (req) setPetPrefs({ pack: req.id })
        },
        { defer: true },
      ),
    )

    // 用户回到窗口并正在查看某条会话时，它的结果视为已查看。
    const [attending, setAttending] = createSignal(!document.hidden && document.hasFocus())
    const sync = () => setAttending(!document.hidden && document.hasFocus())
    window.addEventListener('focus', sync)
    window.addEventListener('blur', sync)
    document.addEventListener('visibilitychange', sync)
    onCleanup(() => {
      window.removeEventListener('focus', sync)
      window.removeEventListener('blur', sync)
      document.removeEventListener('visibilitychange', sync)
    })
    createEffect(() => {
      const id = state.activeConversation
      if (id && attending()) dropResult(id)
    })

    // 气泡到时收起。新结果到达时重新计时。
    createEffect(
      on(bubble, (b) => {
        if (!b) return
        const timer = setTimeout(() => {
          if (bubble() === b) setBubble(null)
        }, PET_BUBBLE_MS)
        onCleanup(() => clearTimeout(timer))
      }),
    )
    return dispose
  })
}
