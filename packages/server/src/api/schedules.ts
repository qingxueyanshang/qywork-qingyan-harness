/**
 * 定时任务。
 *
 * 只暴露当前请求指定的那个工作区：任务表是全机一份，但一个工作区的界面不该看到、
 * 更不该改到另一个工作区的任务。
 *
 * 上一次跑成什么样由仓储按关联 Run 投影（`scheduleView`），这里不另拼一份终态——
 * 界面、模型工具与刷新之后必须给出同一个答案。
 */

import type { Schedule } from '@qywork/core'
import { diagnoseSchedule } from '@qywork/core'
import { NO_MODEL_MESSAGE } from '@qywork/runtime'
import { claimScheduleNow, deleteSchedule, listSchedules, updateSchedule } from '@qywork/store'
import { type ApiHandler, json } from './types.ts'

export const handleSchedulesApi: ApiHandler = async (url, req, d) => {
  const p = url.pathname

  if (p === '/api/schedules' && req.method === 'GET') {
    return json({
      schedules: listSchedules(d.store, d.workspaceRoot, Date.now()),
      // 这句必须由服务端给，别让每个客户端各写一遍措辞：
      // 「关掉应用就不触发」是这个功能的前提，不是补充说明。
      runtimeOnly: '仅在应用运行时触发；关闭期间错过的不逐次补跑，重新打开后每条任务最多跑一次',
    })
  }

  const schedMatch = /^\/api\/schedules\/([^/]+)$/.exec(p)
  if (schedMatch) {
    const id = schedMatch[1]!

    if (req.method === 'DELETE') {
      return deleteSchedule(d.store, id, d.workspaceRoot) === null
        ? json({ error: 'not found' }, 404)
        : json({ ok: true })
    }

    if (req.method === 'PUT') {
      const current = listSchedules(d.store, d.workspaceRoot, Date.now()).find((s) => s.id === id)
      if (!current) return json({ error: 'not found' }, 404)
      const body = (await req.json().catch(() => null)) as Partial<Schedule> | null
      if (!body) return json({ error: 'bad request' }, 400)
      // id / workspaceRoot / createdAt / 触发游标一律不接受客户端改写：
      // 让客户端能写 lastRunAt 等于把「下次什么时候触发」交给它决定。
      //
      // 部分更新以现值为底：时间字段按**最终** kind 从 `current` 兜底，只发 `{enabled}`
      // 的启停不该因为没带时刻而被判不合法。与最终 kind 无关的那些字段不带，
      // 切换触发方式时旧字段随之写 NULL，不留一个不再生效却还在盘上的时刻。
      const kind = body.kind ?? current.kind
      const everyMinutes = body.everyMinutes ?? current.everyMinutes
      const atHour = body.atHour ?? current.atHour
      const atMinute = body.atMinute ?? current.atMinute
      const timing =
        kind === 'interval'
          ? { ...(everyMinutes === undefined ? {} : { everyMinutes }) }
          : {
              ...(atHour === undefined ? {} : { atHour }),
              ...(atMinute === undefined ? {} : { atMinute }),
            }
      const next = {
        title: (body.title ?? current.title).trim(),
        prompt: (body.prompt ?? current.prompt).trim(),
        kind,
        enabled: body.enabled ?? current.enabled,
        ...timing,
      }
      const problems = diagnoseSchedule(next)
      if (problems.length) return json({ error: 'invalid', problems }, 422)
      const saved = updateSchedule(d.store, id, d.workspaceRoot, next)
      return saved === null ? json({ error: 'not found' }, 404) : json({ schedule: saved })
    }
  }

  // 立刻跑一次。
  //
  // 这是这个功能唯一能被**当场验证**的入口：定时触发要等到点，
  // 而「配好了会不会跑」是用户第一个想知道的事。
  //
  // 走与自动触发同一个认领事务，但不推进自动触发游标：推进的话「每天 9 点」会因为
  // 下午点过一次试跑而当天不再自动触发。上一轮还没落终态时回 409，不叠加第二轮。
  const schedRunMatch = /^\/api\/schedules\/([^/]+)\/run$/.exec(p)
  if (schedRunMatch && req.method === 'POST') {
    // 没配默认模型就没法建会话起轮；当场回 422，而不是建一条发不出请求的会话。
    if (!d.config.active) return json({ error: NO_MODEL_MESSAGE }, 422)
    const claimed = claimScheduleNow(d.store, schedRunMatch[1]!, d.workspaceRoot, {
      now: Date.now(),
      provider: d.config.active.provider,
      model: d.config.active.model,
    })
    if (!claimed.ok) {
      if (claimed.reason === 'busy') return json({ error: '上一次触发还没跑完' }, 409)
      if (claimed.reason === 'workspace_missing') return json({ error: '项目已移除' }, 409)
      return json({ error: 'not found' }, 404)
    }
    d.startRun(claimed.claim.conversationId, claimed.claim.schedule.prompt)
    return json({ ok: true, conversationId: claimed.claim.conversationId })
  }

  return null
}
