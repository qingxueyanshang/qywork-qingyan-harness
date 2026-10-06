/**
 * 三个定时任务工具。覆盖范围：`schedules.ts` 的参数解析、校验、边界文案与端口路由。
 *
 * 落盘部分由 `packages/store/src/schedules.test.ts` 覆盖，完整链路由
 * `packages/server/src/scheduler.test.ts` 覆盖。此处使用内存端口：工具本身不访问账本，
 * 引入仓储测试的是仓储，而不是工具。
 */

import { describe, expect, test } from 'bun:test'
import type { SchedulePort, ToolContext } from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import type { Schedule, ScheduleDraft, ScheduleView } from '@qywork/core'
import { isDue, nextRunAt } from '@qywork/core'
import { createScheduleTool, deleteScheduleTool, listSchedulesTool } from './schedules.ts'

/** 内存端口，语义与仓储一致：按工作区过滤，id 与 createdAt 由端口生成。 */
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

  test('创建间隔任务，归属与默认值由端口生成', async () => {
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
    // 每日任务的两个字段不应存在，而不是存为 undefined。
    expect('atHour' in s).toBe(false)
    // 默认发回当前会话，回执中写明这一点。
    expect(s.newConversation).toBe(false)
    expect(r.message).toContain('发回原会话')
    expect(r.data?.newConversation).toBe(false)
  })

  test('new_conversation=true 创建的任务每次新建会话，回执与列表均写明', async () => {
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

  /** 由用户决定，不由模型决定：未传该参数时一律绑定当前会话。 */
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

  test('回执包含两条边界：应用关闭时不触发', async () => {
    const { w1 } = setup()
    const r = await create(w1, {
      title: 't',
      prompt: 'p',
      kind: 'daily',
      at_hour: 9,
      at_minute: 0,
    })
    expect(r.message).toContain('仅在应用运行时触发')
    expect(r.message).toContain('不逐次补执行')
    expect(r.message).toContain('1 分钟')
  })

  test('kind=daily 缺少时刻时不落盘，并报告缺少的字段', async () => {
    const { shared, w1 } = setup()
    const r = await create(w1, { title: 't', prompt: 'p', kind: 'daily' })
    expect(r.status).toBe('failure')
    expect(r.message).toContain('小时必须在 0–23')
    expect(shared).toEqual([])
  })

  test('无法识别的 kind 立即拒绝，不回退为间隔任务', async () => {
    const { shared, w1 } = setup()
    const r = await create(w1, { title: 't', prompt: 'p', kind: 'weekly', every_minutes: 30 })
    expect(r.status).toBe('failure')
    expect(shared).toEqual([])
  })

  test('间隔小于 1 分钟时在落盘前拒绝', async () => {
    const { shared, w1 } = setup()
    const r = await create(w1, { title: 't', prompt: 'p', kind: 'interval', every_minutes: 0 })
    expect(r.status).toBe('failure')
    expect(shared).toEqual([])
  })

  test('列表只包含当前工作区的任务，其他项目的任务不可见', async () => {
    const { w1, w2 } = setup()
    await create(w1, { title: '我的', prompt: 'p', kind: 'interval', every_minutes: 30 })
    await create(w2, { title: '别人的', prompt: 'p', kind: 'interval', every_minutes: 30 })

    const r = await listSchedulesTool.fn({}, w1)
    expect(r.message).toContain('我的')
    expect(r.message).not.toContain('别人的')
    expect((r.data?.schedules as unknown[]).length).toBe(1)
  })

  test('无法删除其他工作区的任务，且该任务仍然存在', async () => {
    const { shared, w1, w2 } = setup()
    await create(w2, { title: '别人的', prompt: 'p', kind: 'interval', every_minutes: 30 })
    const id = shared[0]!.id

    const r = await deleteScheduleTool.fn({ id }, w1)
    expect(r.status).toBe('failure')
    expect(r.errorKind).toBe('not_found')
    expect(shared.length).toBe(1)
  })

  test('可删除本工作区的任务，再次删除时报告不存在', async () => {
    const { shared, w1 } = setup()
    await create(w1, { title: '我的', prompt: 'p', kind: 'interval', every_minutes: 30 })
    const id = shared[0]!.id

    expect((await deleteScheduleTool.fn({ id }, w1)).status).toBe('success')
    expect(shared).toEqual([])
    expect((await deleteScheduleTool.fn({ id }, w1)).errorKind).toBe('not_found')
  })

  test('没有任务时如实报告，不视为失败', async () => {
    const { w1 } = setup()
    const r = await listSchedulesTool.fn({}, w1)
    expect(r.status).toBe('success')
    expect(r.data?.schedules).toEqual([])
  })

  test('装配方未注入端口时如实报告，不声称已记录', async () => {
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

  test('上次触发没有执行记录时如实报告，不显示为已执行', async () => {
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
