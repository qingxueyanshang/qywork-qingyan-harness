/**
 * 定时任务。
 *
 * 只暴露当前请求指定的工作区：任务表全机共用一份，但一个工作区的界面不应看到，
 * 更不应修改另一个工作区的任务。
 *
 * 上一次执行的结果由仓储按关联 Run 投影（`scheduleView`），此处不另行拼接终态：
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
      // 该说明必须由服务端下发，不要让各客户端各自撰写措辞：
      // 关闭应用即不触发是该功能的前提，不是补充说明。
      runtimeOnly: '仅在应用运行时触发；关闭期间错过的不逐次补执行，重新打开后每条任务最多执行一次',
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
      // id / workspaceRoot / createdAt / 触发游标 / 绑定会话 / newConversation
      // 一律不接受客户端修改：允许客户端写入 lastRunAt 等于把下次触发时间交给客户端决定，
      // 而修改 newConversation 会使同一任务的历史一半在绑定会话中、一半分散在其他会话中。
      //
      // 部分更新以当前值为基础：时间字段按最终的 kind 从 `current` 回退取值，只发送 `{enabled}`
      // 的启停请求不应因未携带时刻而被判定为不合法。与最终 kind 无关的字段不携带，
      // 切换触发方式时旧字段随之写为 NULL，不在磁盘上保留一个不再生效的时刻。
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

  // 立即运行。
  //
  // 这是该功能唯一能当场验证的入口：定时触发需要等到触发时刻，
  // 而配置完成后能否执行是用户最先关心的问题。
  //
  // 使用与自动触发相同的认领事务与投递函数，但不推进自动触发游标：推进游标时，
  // 「每天 9 点」会因下午手动试运行一次而当天不再自动触发。上一轮尚未进入终态时返回 409，
  // 不叠加第二轮。
  const schedRunMatch = /^\/api\/schedules\/([^/]+)\/run$/.exec(p)
  if (schedRunMatch && req.method === 'POST') {
    if (d.runs.updating) return json({ error: '应用正在更新，请稍后重试' }, 409)
    // 未配置默认模型时无法确定会话的接口与模型；当场返回 422，而不是创建一条无法发出请求的会话。
    if (!d.config.active) return json({ error: NO_MODEL_MESSAGE }, 422)
    const claimed = claimScheduleNow(d.store, schedRunMatch[1]!, d.workspaceRoot, {
      now: Date.now(),
      provider: d.config.active.provider,
      model: d.config.active.model,
    })
    if (!claimed.ok) {
      if (claimed.reason === 'busy') return json({ error: '上一次触发尚未执行完毕' }, 409)
      if (claimed.reason === 'workspace_missing') return json({ error: '项目已移除' }, 409)
      return json({ error: 'not found' }, 404)
    }
    d.submitSchedule(claimed.claim)
    return json({ ok: true, conversationId: claimed.claim.conversationId })
  }

  return null
}
