/**
 * 三个定时任务工具。**覆盖范围**：`schedules.ts` 的参数解析、校验、边界文案与端口路由。
 *
 * 落盘那一侧由 `packages/store/src/schedules.test.ts` 覆盖，整条链路由
 * `packages/server/src/scheduler.test.ts` 覆盖。这里用一份内存端口：工具自己不碰账本，
 * 把仓储搬进来测的是仓储，不是工具。
 */

import { describe, expect, test } from 'bun:test'
import type { SchedulePort, ToolContext } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import type { Schedule, ScheduleDraft, ScheduleView } from '@qywork/core'
import { isDue, nextRunAt } from '@qywork/core'
import { createScheduleTool, deleteScheduleTool, listSchedulesTool } from './schedules.ts'

/** 内存端口，语义与仓储一致：按工作区收窄，id 与 createdAt 由端口生成。 */
function fakePort(workspaceRoot: string, shared: Schedule[]) {
  let seq = 0
  const port: SchedulePort = {
    list(): ScheduleView[] {
      const now = Date.now()
      return shared
        .filter((s) => s.workspaceRoot === workspaceRoot)
        .map((s) => ({ ...s, nextRunAt: nextRunAt(s, now), due: isDue(s, now), lastRun: null }))
    },
    create(draft: ScheduleDraft): Schedule {
      seq += 1
      const s: Schedule = {
        ...draft,
        id: `sch_${seq}`,
        workspaceRoot,
        enabled: true,
        createdAt: Date.now(),
        newConversation: draft.newConversation === true,
      }
      shared.push(s)
      return s
    },
    remove(id: string): Schedule | null {
      const idx = shared.findIndex((s) => s.id === id && s.workspaceRoot === workspaceRoot)
      if (idx < 0) return null
      return shared.splice(idx, 1)[0] ?? null
    },
  }
  return port
}

function ctxWith(workspaceRoot: string, schedules?: SchedulePort): ToolContext {
  return {
    workspaceRoot,
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: null,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
    ...(schedules ? { schedules } : {}),
  }
}

describe('定时任务工具', () => {
  const setup = () => {
    const shared: Schedule[] = []
    const w1 = ctxWith('/w1', fakePort('/w1', shared))
    const w2 = ctxWith('/w2', fakePort('/w2', shared))
    return { shared, w1, w2 }
  }

  const create = (ctx: ToolContext, args: Record<string, unknown>) =>
    createScheduleTool.fn(args, ctx)

  test('建一条间隔任务，归属与默认值由端口给', async () => {
    const { shared, w1 } = setup()
    const r = await create(w1, {
      title: '日报',
      prompt: '写今天的日报',
      kind: 'interval',
      every_minutes: 30,
    })
    expect(r.status).toBe('success')

    expect(shared.length).toBe(1)
    const s = shared[0]!
    expect(s.workspaceRoot).toBe('/w1')
    expect(s.enabled).toBe(true)
    expect(s.createdAt > 0).toBe(true)
    expect(s.everyMinutes).toBe(30)
    // 每天那两个字段不该存在，不是存成 undefined。
    expect('atHour' in s).toBe(false)
    // 缺省发回当前会话，回执把这一条说出来。
    expect(s.newConversation).toBe(false)
    expect(r.message).toContain('发回原会话')
    expect(r.data?.newConversation).toBe(false)
  })

  test('new_conversation=true 建出的任务每次新建会话，回执与列表都说得出来', async () => {
    const { shared, w1 } = setup()
    const r = await create(w1, {
      title: '日报',
      prompt: '写今天的日报',
      kind: 'daily',
      at_hour: 9,
      at_minute: 0,
      new_conversation: true,
    })
    expect(r.status).toBe('success')
    expect(shared[0]!.newConversation).toBe(true)
    expect(r.message).toContain('每次新建会话')
    expect(r.data?.newConversation).toBe(true)

    const listed = await listSchedulesTool.fn({}, w1)
    expect(listed.message).toContain('每次新建会话')
    expect((listed.data?.schedules as { newConversation: boolean }[])[0]?.newConversation).toBe(
      true,
    )
  })

  /** 判定口径归用户，不归模型：没带这个参数就一律绑定当前会话。 */
  test('不传 new_conversation 时一律绑定当前会话', async () => {
    const { shared, w1 } = setup()
    const r = await create(w1, {
      title: '每天出一份日报',
      prompt: '写今天的日报',
      kind: 'daily',
      at_hour: 9,
      at_minute: 0,
    })
    expect(shared[0]!.newConversation).toBe(false)
    expect(r.message).toContain('发回原会话')
  })

  test('回执里带着两条边界：关掉应用不会触发', async () => {
    const { w1 } = setup()
    const r = await create(w1, {
      title: 't',
      prompt: 'p',
      kind: 'daily',
      at_hour: 9,
      at_minute: 0,
    })
    expect(r.message).toContain('仅在应用运行时触发')
    expect(r.message).toContain('不逐次补跑')
    expect(r.message).toContain('1 分钟')
  })

  test('kind=daily 少给时刻不落盘，报的是缺哪个而不是一句失败', async () => {
    const { shared, w1 } = setup()
    const r = await create(w1, { title: 't', prompt: 'p', kind: 'daily' })
    expect(r.status).toBe('failure')
    expect(r.message).toContain('小时必须在 0–23')
    expect(shared).toEqual([])
  })

  test('认不出的 kind 当场拒，不兜底成间隔任务', async () => {
    const { shared, w1 } = setup()
    const r = await create(w1, { title: 't', prompt: 'p', kind: 'weekly', every_minutes: 30 })
    expect(r.status).toBe('failure')
    expect(shared).toEqual([])
  })

  test('间隔小于 1 分钟被挡在落盘之前', async () => {
    const { shared, w1 } = setup()
    const r = await create(w1, { title: 't', prompt: 'p', kind: 'interval', every_minutes: 0 })
    expect(r.status).toBe('failure')
    expect(shared).toEqual([])
  })

  test('列表只给当前工作区的，别的项目的任务看不见', async () => {
    const { w1, w2 } = setup()
    await create(w1, { title: '我的', prompt: 'p', kind: 'interval', every_minutes: 30 })
    await create(w2, { title: '别人的', prompt: 'p', kind: 'interval', every_minutes: 30 })

    const r = await listSchedulesTool.fn({}, w1)
    expect(r.message).toContain('我的')
    expect(r.message).not.toContain('别人的')
    expect((r.data?.schedules as unknown[]).length).toBe(1)
  })

  test('删不掉别的工作区的任务，而且那条还在', async () => {
    const { shared, w1, w2 } = setup()
    await create(w2, { title: '别人的', prompt: 'p', kind: 'interval', every_minutes: 30 })
    const id = shared[0]!.id

    const r = await deleteScheduleTool.fn({ id }, w1)
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('not_found')
    expect(shared.length).toBe(1)
  })

  test('删自己的任务删得掉，删第二次报没有', async () => {
    const { shared, w1 } = setup()
    await create(w1, { title: '我的', prompt: 'p', kind: 'interval', every_minutes: 30 })
    const id = shared[0]!.id

    expect((await deleteScheduleTool.fn({ id }, w1)).status).toBe('success')
    expect(shared).toEqual([])
    expect((await deleteScheduleTool.fn({ id }, w1)).errorKind).toBe('not_found')
  })

  test('空表如实说没有，不算失败', async () => {
    const { w1 } = setup()
    const r = await listSchedulesTool.fn({}, w1)
    expect(r.status).toBe('success')
    expect(r.data?.schedules).toEqual([])
  })

  test('装配方没接端口时如实报，不假装记下了', async () => {
    const bare = ctxWith('/w1')
    for (const spec of [createScheduleTool, listSchedulesTool, deleteScheduleTool]) {
      const r = await spec.fn(
        { title: 't', prompt: 'p', kind: 'interval', every_minutes: 30, id: 'sch_1' },
        bare,
      )
      expect(r.status).toBe('failure')
      expect(r.message).toContain('没有定时任务表')
    }
  })

  test('上次触发没有执行记录时如实说，不显示成跑过了', async () => {
    const shared: Schedule[] = []
    const port = fakePort('/w1', shared)
    const ctx = ctxWith('/w1', {
      ...port,
      list: () =>
        port.list().map((s) => ({
          ...s,
          lastRunAt: 1_700_000_000_000,
          lastRun: {
            conversationId: 'cv_gone',
            runId: null,
            status: null,
            errorMessage: null,
          },
        })),
    })
    await create(ctx, { title: '我的', prompt: 'p', kind: 'interval', every_minutes: 30 })
    const r = await listSchedulesTool.fn({}, ctx)
    expect(r.message).toContain('没有执行记录')
  })
})
