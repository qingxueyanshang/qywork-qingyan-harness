/**
 * 定时任务。
 *
 * 只暴露当前工作区的任务：文件是全机共享的，但一个工作区的界面不该看到、
 * 更不该改到另一个工作区的任务。
 */

import {
  diagnoseSchedule,
  isDue,
  loadSchedules,
  nextRunAt,
  type Schedule,
  updateSchedules,
} from '@qywork/runtime'
import { createConversation } from '@qywork/store'
import { type ApiHandler, json } from './types.ts'

export const handleSchedulesApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/schedules') {
    const all = await loadSchedules()
    const now = Date.now()

    if (req.method === 'GET') {
      return json({
        schedules: all
          .filter((s) => s.workspaceRoot === d.workspaceRoot)
          .map((s) => ({ ...s, nextRunAt: nextRunAt(s, now), due: isDue(s, now) })),
        // 这句必须由服务端给，别让每个客户端各写一遍措辞：
        // 「关掉应用就不触发」是这个功能的前提，不是补充说明。
        runtimeOnly: '仅在应用运行时触发，关闭后不触发，错过的不补',
      })
    }

    if (req.method === 'POST') {
      const body = (await req.json().catch(() => null)) as Partial<Schedule> | null
      if (!body) return json({ error: 'bad request' }, 400)
      const draft: Schedule = {
        id: `sch_${crypto.randomUUID().slice(0, 12)}`,
        workspaceRoot: d.workspaceRoot,
        title: (body.title ?? '').trim(),
        prompt: (body.prompt ?? '').trim(),
        kind: body.kind === 'daily' ? 'daily' : 'interval',
        enabled: body.enabled ?? true,
        createdAt: now,
        ...(body.kind === 'daily'
          ? { atHour: body.atHour ?? 9, atMinute: body.atMinute ?? 0 }
          : { everyMinutes: body.everyMinutes ?? 60 }),
      }
      const problems = diagnoseSchedule(draft)
      if (problems.length) return json({ error: 'invalid', problems }, 422)
      // 走 updateSchedules 而不是拿上面那份快照整表覆盖：从 loadSchedules()
      // 到这里之间调度 tick 可能已经写过 lastRunAt，覆盖会把它抹掉。
      await updateSchedules((cur) => [...cur, draft])
      return json({ schedule: draft })
    }
  }

  const schedMatch = /^\/api\/schedules\/([^/]+)$/.exec(p)
  if (schedMatch) {
    const id = schedMatch[1]!
    const all = await loadSchedules()
    const idx = all.findIndex((s) => s.id === id && s.workspaceRoot === d.workspaceRoot)
    if (idx < 0) return json({ error: 'not found' }, 404)

    if (req.method === 'DELETE') {
      await updateSchedules((cur) => cur.filter((x) => x.id !== id))
      return json({ ok: true })
    }

    if (req.method === 'PUT') {
      const body = (await req.json().catch(() => null)) as Partial<Schedule> | null
      if (!body) return json({ error: 'bad request' }, 400)
      // id / workspaceRoot / createdAt / 运行状态一律不接受客户端改写：
      // 让客户端能写 lastRunAt 等于把「下次什么时候触发」交给它决定。
      const next: Schedule = {
        ...all[idx]!,
        title: (body.title ?? all[idx]!.title).trim(),
        prompt: (body.prompt ?? all[idx]!.prompt).trim(),
        kind: body.kind ?? all[idx]!.kind,
        enabled: body.enabled ?? all[idx]!.enabled,
        ...(body.everyMinutes !== undefined ? { everyMinutes: body.everyMinutes } : {}),
        ...(body.atHour !== undefined ? { atHour: body.atHour } : {}),
        ...(body.atMinute !== undefined ? { atMinute: body.atMinute } : {}),
      }
      const problems = diagnoseSchedule(next)
      if (problems.length) return json({ error: 'invalid', problems }, 422)
      await updateSchedules((cur) => cur.map((x) => (x.id === id ? next : x)))
      return json({ schedule: next })
    }
  }

  // 立刻跑一次。
  //
  // 这是这个功能唯一能被**当场验证**的入口：定时触发要等到点，
  // 而「配好了到底会不会跑」是用户第一个想知道的事。
  const schedRunMatch = /^\/api\/schedules\/([^/]+)\/run$/.exec(p)
  if (schedRunMatch && req.method === 'POST') {
    const all = await loadSchedules()
    const s = all.find((x) => x.id === schedRunMatch[1] && x.workspaceRoot === d.workspaceRoot)
    if (!s) return json({ error: 'not found' }, 404)
    const conv = createConversation(d.store, {
      workspaceId: d.workspaceId as never,
      model: d.config.active.model,
      title: s.title,
    })
    // 手动试跑**不推进** lastRunAt：它是调度状态，被手动触发改掉的话
    // 「每天 9 点」会因为你下午点了一次试跑而当天不再自动触发。
    d.startRun(conv.id, s.prompt)
    return json({ ok: true, conversationId: conv.id })
  }

  return null
}
