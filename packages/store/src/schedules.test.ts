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

const CLAIM = { provider: 'p', model: 'm' }

beforeEach(() => {
  // 内存库：这一组全是单连接读写，落盘只会在 Windows 上留下删不掉的句柄。
  store = new Store({ path: ':memory:' })
  wsA = upsertWorkspace(store, ROOT_A, 'A').id
  upsertWorkspace(store, ROOT_B, 'B')
})

afterEach(() => {
  store.close()
})

/** 一条已经到期的间隔任务：创建时刻推到过去，`isDue` 立即为真。 */
function dueSchedule(root: string, title = '日报') {
  const s = createSchedule(store, root, {
    title,
    prompt: `跑 ${title}`,
    kind: 'interval',
    everyMinutes: 1,
  })
  store.db.query('UPDATE schedules SET created_at = ? WHERE id = ?').run(Date.now() - 120_000, s.id)
  return s
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
  test('建出来的任务默认启用，归属由调用方给，不由请求方填', () => {
    const s = createSchedule(store, ROOT_A, {
      title: 't',
      prompt: 'p',
      kind: 'interval',
      everyMinutes: 30,
    })
    expect(s.id.startsWith('sch_')).toBe(true)
    expect(s.workspaceRoot).toBe(ROOT_A)
    expect(s.enabled).toBe(true)
    expect(s.createdAt > 0).toBe(true)
    // 每天那两个字段不该存在，不是存成 undefined。
    expect('atHour' in s).toBe(false)
  })

  test('列表按工作区隔离', () => {
    createSchedule(store, ROOT_A, {
      title: '我的',
      prompt: 'p',
      kind: 'daily',
      atHour: 9,
      atMinute: 0,
    })
    createSchedule(store, ROOT_B, {
      title: '别人的',
      prompt: 'p',
      kind: 'daily',
      atHour: 9,
      atMinute: 0,
    })
    expect(listSchedules(store, ROOT_A, Date.now()).map((s) => s.title)).toEqual(['我的'])
    expect(listSchedules(store, ROOT_B, Date.now()).map((s) => s.title)).toEqual(['别人的'])
  })

  /*
   * `workspace_root` 与 `workspaces.root_path` 走同一份归一。不归一的话，
   * 用正斜杠建的任务在反斜杠的那次列表里查不到，而工作区是同一个。
   */
  test('两种分隔符写法指同一个工作区', () => {
    const s = createSchedule(store, 'C:/ws/a', {
      title: '正斜杠建的',
      prompt: 'p',
      kind: 'interval',
      everyMinutes: 30,
    })
    expect(s.workspaceRoot).toBe(ROOT_A)
    expect(listSchedules(store, ROOT_A, Date.now()).map((t) => t.title)).toEqual(['正斜杠建的'])
    expect(listSchedules(store, 'C:/ws/a', Date.now()).map((t) => t.title)).toEqual(['正斜杠建的'])
    expect(deleteSchedule(store, s.id, 'C:/ws/a')?.id).toBe(s.id)
  })

  test('改不到别的工作区的任务，删也删不掉', () => {
    const s = createSchedule(store, ROOT_B, {
      title: 't',
      prompt: 'p',
      kind: 'interval',
      everyMinutes: 5,
    })
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

  test('改任务不动触发游标', () => {
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
    expect(after.lastRunConversationId).toBe(before.lastRunConversationId)
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

  test('关联会话被删除后触发游标保留，执行记录变成没有', () => {
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
    const now = Date.now()
    const first = claimDueSchedules(store, { now, ...CLAIM })
    expect(first.length).toBe(1)
    expect(first[0]!.workspaceRoot).toBe(ROOT_A)

    const second = claimDueSchedules(store, { now, ...CLAIM })
    expect(second).toEqual([])
    expect(
      store.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM conversations').get()?.n,
    ).toBe(1)
  })

  test('别的项目的到期任务照样认领，不按启动目录筛选', () => {
    dueSchedule(ROOT_B, 'B 的日报')
    const claims = claimDueSchedules(store, { now: Date.now(), ...CLAIM })
    expect(claims.map((c) => c.workspaceRoot)).toEqual([ROOT_B])
  })

  test('上一轮还没落终态就不叠加', () => {
    dueSchedule(ROOT_A)
    const first = claimDueSchedules(store, { now: Date.now(), ...CLAIM })
    runFor(first[0]!.conversationId, wsA)

    const later = Date.now() + 5 * 60_000
    expect(claimDueSchedules(store, { now: later, ...CLAIM })).toEqual([])
    expect(
      store.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM conversations').get()?.n,
    ).toBe(1)
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
    const s = createSchedule(store, ROOT_A, {
      title: '每天九点',
      prompt: 'p',
      kind: 'daily',
      atHour: 9,
      atMinute: 0,
    })
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

  test('立刻跑一次建会话但不推进自动触发游标', () => {
    const s = createSchedule(store, ROOT_A, {
      title: '每天九点',
      prompt: 'p',
      kind: 'daily',
      atHour: 9,
      atMinute: 0,
    })
    const result = claimScheduleNow(store, s.id, ROOT_A, { now: Date.now(), ...CLAIM })
    expect(result.ok).toBe(true)

    const view = listSchedules(store, ROOT_A, Date.now())[0]!
    expect(view.lastRunAt).toBe(undefined)
    expect(view.lastRunConversationId).toBe(result.ok ? result.claim.conversationId : '')
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
