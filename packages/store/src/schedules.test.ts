/**
 * 定时任务仓储。**覆盖范围**：`schedules.ts` 的读写、Run 终态投影与认领事务，
 * 以及迁移 54 建的 `schedules` 表在会话被删除时的外键行为。
 *
 * 跨进程竞争由 `packages/server/src/schedule-race.test.ts` 覆盖，
 * 整条触发链路由 `packages/server/src/scheduler.test.ts` 覆盖。
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { ConversationId, RunId, WorkspaceId } from '@qywork/core'
import { Store } from './db.ts'
import {
  createConversation,
  createRun,
  deleteConversation,
  finishRun,
  removeWorkspace,
  upsertWorkspace,
} from './repos.ts'
import {
  claimDueSchedules,
  claimScheduleNow,
  createSchedule,
  deleteSchedule,
  insertSchedules,
  listSchedules,
  updateSchedule,
} from './schedules.ts'

let store: Store
// 已归一的形式（`normalizeWorkspaceRoot`）：仓储层落盘与回读都是这一份。
const ROOT_A = 'C:\\ws\\a'
const ROOT_B = 'C:\\ws\\b'
let wsA: WorkspaceId
let wsB: WorkspaceId
/** 建任务的那条会话，绑定与复用都以它为准。 */
let homeA: ConversationId
let homeB: ConversationId

const CLAIM = { provider: 'p', model: 'm' }

function newConversation(workspaceId: WorkspaceId, title: string): ConversationId {
  return createConversation(store, { workspaceId, provider: 'p', model: 'm', title }).id
}

beforeEach(() => {
  // 内存库：这一组全是单连接读写，落盘只会在 Windows 上留下删不掉的句柄。
  store = new Store({ path: ':memory:' })
  wsA = upsertWorkspace(store, ROOT_A, 'A').id
  wsB = upsertWorkspace(store, ROOT_B, 'B').id
  homeA = newConversation(wsA, 'A 的会话')
  homeB = newConversation(wsB, 'B 的会话')
})

afterEach(() => {
  store.close()
})

/** 建任务时绑定的那条会话按工作区取，与 `SchedulePort` 的注入同形。 */
function homeOf(root: string): ConversationId {
  return root === ROOT_B || root === 'C:/ws/b' ? homeB : homeA
}

/** 一条已经到期的间隔任务：创建时刻推到过去，`isDue` 立即为真。 */
function dueSchedule(root: string, title = '日报', draft: { newConversation?: boolean } = {}) {
  const s = createSchedule(
    store,
    root,
    { title, prompt: `跑 ${title}`, kind: 'interval', everyMinutes: 1, ...draft },
    homeOf(root),
  )
  store.db.query('UPDATE schedules SET created_at = ? WHERE id = ?').run(Date.now() - 120_000, s.id)
  return s
}

function conversationCount(): number {
  return store.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM conversations').get()?.n ?? 0
}

function runFor(conversationId: ConversationId, workspaceId: WorkspaceId): RunId {
  return createRun(store, {
    conversationId,
    workspaceId,
    model: 'm',
    clientRequestId: `req_${conversationId}`,
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  }).id
}

describe('读写', () => {
  test('建出来的任务默认启用、绑定建它的那条会话，归属由调用方给，不由请求方填', () => {
    const s = createSchedule(
      store,
      ROOT_A,
      { title: 't', prompt: 'p', kind: 'interval', everyMinutes: 30 },
      homeA,
    )
    expect(s.id.startsWith('sch_')).toBe(true)
    expect(s.workspaceRoot).toBe(ROOT_A)
    expect(s.enabled).toBe(true)
    expect(s.createdAt > 0).toBe(true)
    expect(s.conversationId).toBe(homeA)
    expect(s.newConversation).toBe(false)
    // 每天那两个字段不该存在，不是存成 undefined。
    expect('atHour' in s).toBe(false)
  })

  test('声明每次新建会话的任务不绑定建它的那条会话', () => {
    const s = createSchedule(
      store,
      ROOT_A,
      { title: '日报', prompt: 'p', kind: 'daily', atHour: 9, atMinute: 0, newConversation: true },
      homeA,
    )
    expect(s.newConversation).toBe(true)
    expect(s.conversationId).toBe(undefined)
    expect(listSchedules(store, ROOT_A, Date.now())[0]!.newConversation).toBe(true)
  })

  test('列表按工作区隔离', () => {
    createSchedule(
      store,
      ROOT_A,
      { title: '我的', prompt: 'p', kind: 'daily', atHour: 9, atMinute: 0 },
      homeA,
    )
    createSchedule(
      store,
      ROOT_B,
      { title: '别人的', prompt: 'p', kind: 'daily', atHour: 9, atMinute: 0 },
      homeB,
    )
    expect(listSchedules(store, ROOT_A, Date.now()).map((s) => s.title)).toEqual(['我的'])
    expect(listSchedules(store, ROOT_B, Date.now()).map((s) => s.title)).toEqual(['别人的'])
  })

  /*
   * `workspace_root` 与 `workspaces.root_path` 走同一份归一。不归一的话，
   * 用正斜杠建的任务在反斜杠的那次列表里查不到，而工作区是同一个。
   */
  test('两种分隔符写法指同一个工作区', () => {
    const s = createSchedule(
      store,
      'C:/ws/a',
      { title: '正斜杠建的', prompt: 'p', kind: 'interval', everyMinutes: 30 },
      homeA,
    )
    expect(s.workspaceRoot).toBe(ROOT_A)
    expect(listSchedules(store, ROOT_A, Date.now()).map((t) => t.title)).toEqual(['正斜杠建的'])
    expect(listSchedules(store, 'C:/ws/a', Date.now()).map((t) => t.title)).toEqual(['正斜杠建的'])
    expect(deleteSchedule(store, s.id, 'C:/ws/a')?.id).toBe(s.id)
  })

  test('改不到别的工作区的任务，删也删不掉', () => {
    const s = createSchedule(
      store,
      ROOT_B,
      { title: 't', prompt: 'p', kind: 'interval', everyMinutes: 5 },
      homeB,
    )
    expect(
      updateSchedule(store, s.id, ROOT_A, {
        title: 'x',
        prompt: 'p',
        kind: 'interval',
        enabled: true,
        everyMinutes: 5,
      }),
    ).toBe(null)
    expect(deleteSchedule(store, s.id, ROOT_A)).toBe(null)
    expect(listSchedules(store, ROOT_B, Date.now()).length).toBe(1)
  })

  test('改任务不动触发游标与绑定会话', () => {
    const s = dueSchedule(ROOT_A)
    claimDueSchedules(store, { now: Date.now(), ...CLAIM })
    const before = listSchedules(store, ROOT_A, Date.now())[0]!
    expect(before.lastRunAt).toBeGreaterThan(0)

    updateSchedule(store, s.id, ROOT_A, {
      title: '改过的',
      prompt: 'p',
      kind: 'interval',
      enabled: false,
      everyMinutes: 7,
    })
    const after = listSchedules(store, ROOT_A, Date.now())[0]!
    expect(after.title).toBe('改过的')
    expect(after.enabled).toBe(false)
    expect(after.everyMinutes).toBe(7)
    expect(after.lastRunAt).toBe(before.lastRunAt)
    expect(after.conversationId).toBe(before.conversationId)
    expect(after.newConversation).toBe(before.newConversation)
  })

  test('整表导入保留原 id、时间与关联会话', () => {
    store.tx(() => {
      insertSchedules(store, [
        {
          id: 'sch_old',
          workspaceRoot: ROOT_A,
          title: '旧的',
          prompt: 'p',
          kind: 'daily',
          atHour: 9,
          atMinute: 30,
          enabled: false,
          createdAt: 111,
          lastRunAt: 222,
          newConversation: false,
        },
      ])
    })
    const s = listSchedules(store, ROOT_A, Date.now())[0]!
    expect(s.id).toBe('sch_old')
    expect(s.createdAt).toBe(111)
    expect(s.lastRunAt).toBe(222)
    expect(s.enabled).toBe(false)
    expect(s.atMinute).toBe(30)
    // 没有可核验的 Run 就如实回 null，不伪造一条历史执行。
    expect(s.lastRun).toBe(null)
  })

  test('重复 id 撞主键，整个事务回滚，不留半张表', () => {
    expect(() =>
      store.tx(() => {
        insertSchedules(store, [
          {
            id: 'dup',
            workspaceRoot: ROOT_A,
            title: 'a',
            prompt: 'p',
            kind: 'interval',
            everyMinutes: 5,
            enabled: true,
            createdAt: 1,
            newConversation: false,
          },
          {
            id: 'dup',
            workspaceRoot: ROOT_A,
            title: 'b',
            prompt: 'p',
            kind: 'interval',
            everyMinutes: 5,
            enabled: true,
            createdAt: 2,
            newConversation: false,
          },
        ])
      }),
    ).toThrow()
    expect(listSchedules(store, ROOT_A, Date.now())).toEqual([])
  })
})

describe('Run 终态投影', () => {
  test('失败的 Run 原样投影到任务上，任务表里没有第二份错误', () => {
    dueSchedule(ROOT_A)
    const claims = claimDueSchedules(store, { now: Date.now(), ...CLAIM })
    const runId = runFor(claims[0]!.conversationId, wsA)
    finishRun(store, runId, {
      status: 'failed',
      stopReason: 'provider_error',
      errorMessage: '401 auth_failed',
      errorCode: 'auth_failed',
    })

    const view = listSchedules(store, ROOT_A, Date.now())[0]!
    expect(view.lastRun).toEqual({
      conversationId: claims[0]!.conversationId,
      runId,
      status: 'failed',
      errorMessage: '401 auth_failed',
    })
    const columns = store.db
      .query<{ name: string }, []>('PRAGMA table_info(schedules)')
      .all()
      .map((c) => c.name)
    expect(columns).not.toContain('last_error')
  })

  test('认领了还没起轮时如实说没有 Run', () => {
    dueSchedule(ROOT_A)
    const claims = claimDueSchedules(store, { now: Date.now(), ...CLAIM })
    const view = listSchedules(store, ROOT_A, Date.now())[0]!
    expect(view.lastRun).toEqual({
      conversationId: claims[0]!.conversationId,
      runId: null,
      status: null,
      errorMessage: null,
    })
  })

  test('绑定会话被删除后触发游标保留，执行记录变成没有', () => {
    dueSchedule(ROOT_A)
    const claims = claimDueSchedules(store, { now: Date.now(), ...CLAIM })
    const before = listSchedules(store, ROOT_A, Date.now())[0]!
    deleteConversation(store, claims[0]!.conversationId)

    const after = listSchedules(store, ROOT_A, Date.now())[0]!
    expect(after.lastRunAt).toBe(before.lastRunAt)
    expect(after.lastRun).toBe(null)
  })
})

describe('认领事务', () => {
  test('到期的认领一次并推进游标，同一时刻再认领不再命中', () => {
    dueSchedule(ROOT_A)
    const before = conversationCount()
    const now = Date.now()
    const first = claimDueSchedules(store, { now, ...CLAIM })
    expect(first.length).toBe(1)
    expect(first[0]!.workspaceRoot).toBe(ROOT_A)

    const second = claimDueSchedules(store, { now, ...CLAIM })
    expect(second).toEqual([])
    expect(conversationCount()).toBe(before)
  })

  /*
   * 原始失败形状：用户在会话里说「每 30 分钟查一次」，之后每次触发都是一条没有上下文的
   * 新会话。认领必须落回建这条任务的那条会话。
   */
  test('连续两次到期发进同一条会话，会话数不增加', () => {
    dueSchedule(ROOT_A)
    const before = conversationCount()

    const first = claimDueSchedules(store, { now: Date.now(), ...CLAIM })
    expect(first[0]!.conversationId).toBe(homeA)
    expect(first[0]!.created).toBe(null)
    finishRun(store, runFor(first[0]!.conversationId, wsA), {
      status: 'done',
      stopReason: 'completed',
    })

    const second = claimDueSchedules(store, { now: Date.now() + 5 * 60_000, ...CLAIM })
    expect(second[0]!.conversationId).toBe(homeA)
    expect(second[0]!.created).toBe(null)
    expect(conversationCount()).toBe(before)
  })

  test('绑定会话被删之后新建一条并写回绑定，之后接着复用它', () => {
    dueSchedule(ROOT_A)
    deleteConversation(store, homeA)
    const before = conversationCount()

    const first = claimDueSchedules(store, { now: Date.now(), ...CLAIM })
    const made = first[0]!.created
    expect(made?.id).toBe(first[0]!.conversationId)
    expect(made?.workspaceId).toBe(wsA)
    expect(conversationCount()).toBe(before + 1)
    expect(listSchedules(store, ROOT_A, Date.now())[0]!.conversationId).toBe(
      first[0]!.conversationId,
    )
    finishRun(store, runFor(first[0]!.conversationId, wsA), {
      status: 'done',
      stopReason: 'completed',
    })

    const second = claimDueSchedules(store, { now: Date.now() + 5 * 60_000, ...CLAIM })
    expect(second[0]!.conversationId).toBe(first[0]!.conversationId)
    expect(second[0]!.created).toBe(null)
    expect(conversationCount()).toBe(before + 1)
  })

  test('声明每次新建会话的任务每次都另建一条，且都报为新建', () => {
    dueSchedule(ROOT_A, '日报', { newConversation: true })
    const before = conversationCount()

    const first = claimDueSchedules(store, { now: Date.now(), ...CLAIM })
    expect(first[0]!.created?.id).toBe(first[0]!.conversationId)
    expect(first[0]!.conversationId).not.toBe(homeA)
    finishRun(store, runFor(first[0]!.conversationId, wsA), {
      status: 'done',
      stopReason: 'completed',
    })

    const second = claimDueSchedules(store, { now: Date.now() + 5 * 60_000, ...CLAIM })
    expect(second[0]!.created?.id).toBe(second[0]!.conversationId)
    expect(second[0]!.conversationId).not.toBe(first[0]!.conversationId)
    expect(conversationCount()).toBe(before + 2)
    // 忙态与终态投影读的是同一格：最近一次触发进的那条。
    expect(listSchedules(store, ROOT_A, Date.now())[0]!.conversationId).toBe(
      second[0]!.conversationId,
    )
  })

  test('别的项目的到期任务照样认领，不按启动目录筛选', () => {
    dueSchedule(ROOT_B, 'B 的日报')
    const claims = claimDueSchedules(store, { now: Date.now(), ...CLAIM })
    expect(claims.map((c) => c.workspaceRoot)).toEqual([ROOT_B])
  })

  test('上一轮还没落终态就不叠加', () => {
    dueSchedule(ROOT_A)
    const before = conversationCount()
    const first = claimDueSchedules(store, { now: Date.now(), ...CLAIM })
    runFor(first[0]!.conversationId, wsA)

    const later = Date.now() + 5 * 60_000
    expect(claimDueSchedules(store, { now: later, ...CLAIM })).toEqual([])
    expect(conversationCount()).toBe(before)
  })

  test('上一轮落终态之后才继续触发', () => {
    dueSchedule(ROOT_A)
    const first = claimDueSchedules(store, { now: Date.now(), ...CLAIM })
    const runId = runFor(first[0]!.conversationId, wsA)
    finishRun(store, runId, { status: 'done', stopReason: 'completed' })

    const later = Date.now() + 5 * 60_000
    expect(claimDueSchedules(store, { now: later, ...CLAIM }).length).toBe(1)
  })

  test('工作区已移除就不触发，游标也不动', () => {
    dueSchedule(ROOT_B)
    removeWorkspace(store, upsertWorkspace(store, ROOT_B, 'B').id)
    expect(claimDueSchedules(store, { now: Date.now(), ...CLAIM })).toEqual([])
    expect(listSchedules(store, ROOT_B, Date.now())[0]!.lastRunAt).toBe(undefined)
  })

  test('停用的任务不触发', () => {
    const s = dueSchedule(ROOT_A)
    updateSchedule(store, s.id, ROOT_A, {
      title: s.title,
      prompt: s.prompt,
      kind: 'interval',
      enabled: false,
      everyMinutes: 1,
    })
    expect(claimDueSchedules(store, { now: Date.now(), ...CLAIM })).toEqual([])
  })

  test('注入时钟：daily 任务当天只触发一次，跨到第二天再触发', () => {
    const localAt = (d: number, h: number, mi = 0) => new Date(2026, 7, d, h, mi, 0, 0).getTime()
    const s = createSchedule(
      store,
      ROOT_A,
      { title: '每天九点', prompt: 'p', kind: 'daily', atHour: 9, atMinute: 0 },
      homeA,
    )
    store.db.query('UPDATE schedules SET created_at = ? WHERE id = ?').run(localAt(9, 0), s.id)

    expect(claimDueSchedules(store, { now: localAt(10, 8, 59), ...CLAIM })).toEqual([])

    const hit = claimDueSchedules(store, { now: localAt(10, 9, 0), ...CLAIM })
    expect(hit.length).toBe(1)
    const runId = runFor(hit[0]!.conversationId, wsA)
    finishRun(store, runId, { status: 'done', stopReason: 'completed' })

    // 同一天再 tick 不重复；跨到第二天到点再触发一次。
    expect(claimDueSchedules(store, { now: localAt(10, 23, 59), ...CLAIM })).toEqual([])
    expect(claimDueSchedules(store, { now: localAt(11, 9, 0), ...CLAIM }).length).toBe(1)
  })

  test('立刻跑一次发进绑定会话但不推进自动触发游标', () => {
    const s = createSchedule(
      store,
      ROOT_A,
      { title: '每天九点', prompt: 'p', kind: 'daily', atHour: 9, atMinute: 0 },
      homeA,
    )
    const before = conversationCount()
    const result = claimScheduleNow(store, s.id, ROOT_A, { now: Date.now(), ...CLAIM })
    expect(result.ok && result.claim.conversationId).toBe(homeA)
    expect(result.ok && result.claim.created).toBe(null)
    expect(conversationCount()).toBe(before)

    const view = listSchedules(store, ROOT_A, Date.now())[0]!
    expect(view.lastRunAt).toBe(undefined)
    expect(view.conversationId).toBe(homeA)
  })

  test('立刻跑一次也认忙态与归属', () => {
    const s = dueSchedule(ROOT_A)
    expect(claimScheduleNow(store, s.id, ROOT_B, { now: Date.now(), ...CLAIM })).toEqual({
      ok: false,
      reason: 'not_found',
    })

    const first = claimDueSchedules(store, { now: Date.now(), ...CLAIM })
    runFor(first[0]!.conversationId, wsA)
    expect(claimScheduleNow(store, s.id, ROOT_A, { now: Date.now(), ...CLAIM })).toEqual({
      ok: false,
      reason: 'busy',
    })
  })
})
