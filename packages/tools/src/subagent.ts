/**
 * 把一段任务交给一个子 agent（角色）或本机装着的外部 agent CLI。
 *
 * ## 为什么要有它
 *
 * 没有它的时候，「多角色协作」只有一条入口：用户手动发起一轮编排（`team.run`），
 * 按 `.qy/team.json` 里画好的图跑。模型自己**派不了活**——它知道有哪些角色，
 * 却没有任何办法把一件事交出去。
 *
 * ## 一个工具收两类目标，不做两个
 *
 * 角色与外部 CLI 的配置面毫不相干，但对调用方来说是同一件事：交出去、拿回产出。
 * 拆成两个工具，模型就要先判断「这个名字属于哪一类」——而那正是这里该替它做的。
 *
 * ## 失败是返回值
 *
 * 派不出去（目标不存在、外部 CLI 没装、跑挂了）都如实回 failure 并带原因，
 * 不抛异常：注册表会把异常压成一句「工具执行出错」，模型据此换不了做法。
 */

import type { ToolContext, ToolSpec } from '@qywork/agent'

export const subagentTool: ToolSpec = {
  name: 'subagent',
  description:
    '把一段任务交给一个子 agent 或本机的外部 agent CLI，等它做完并拿回产出。' +
    '不带 agent 参数调用则列出现在能派给谁。' +
    '适合可以独立完成、产出是一段文字的整块工作（查一片代码、写一份评审、跑一轮调研）；' +
    '要它接着上下文继续做的事不要派出去——子 agent 看不到这条会话。',
  parameters: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description: '派给谁：角色 id，或 cli:<id> 指一个本机识别到的外部 CLI。留空则只列清单。',
      },
      task: {
        type: 'string',
        description: '要它做什么。子 agent 看不到这条会话，所以背景要在这里写全。',
      },
    },
    additionalProperties: false,
  },
  actionKind: 'run',
  objectLabel: '子 agent',
  category: 'session',
  facet: '协作',
  summary: '把一段任务交给子 agent 或外部 CLI',
  targetExtractor: (a) => (typeof a.agent === 'string' ? a.agent : null),
  // 子 agent 用它自己那套工具，权限在那一侧按它的会话逐次裁决；
  // 外部 CLI 是本机上的另一个进程。两者都算「起一件会动这台机器的事」。
  permissionEffect: 'execute',
  parallelSafe: false,

  async fn(args: Record<string, unknown>, ctx: ToolContext) {
    const delegate = ctx.delegate
    if (!delegate) {
      // 正常不会走到：没有这条通道时这个工具压根不注册。
      return { status: 'failure' as const, message: '本次执行没有派活通道' }
    }

    const targets = await delegate.targets()
    const target = typeof args.agent === 'string' ? args.agent.trim() : ''
    if (!target) {
      return {
        status: 'success' as const,
        message: targets.length ? `能派给 ${targets.length} 个` : '现在一个都派不出去',
        data: { targets },
      }
    }

    const known = targets.find((t) => t.id === target)
    if (!known) {
      return {
        status: 'failure' as const,
        message:
          targets.length === 0
            ? '这个项目没有角色，本机也没识别到外部 CLI'
            : `没有 ${target}。现在能派的是：${targets.map((t) => t.id).join('、')}`,
        errorKind: 'not_found',
      }
    }

    const task = typeof args.task === 'string' ? args.task.trim() : ''
    if (!task) return { status: 'failure' as const, message: '要它做什么得写清楚' }

    const res = await delegate.run({ target, task, signal: ctx.signal })
    if (!res.ok) {
      return {
        status: 'failure' as const,
        message: `${target} 没做成：${res.error ?? '没有说明原因'}`,
        ...(res.output ? { data: { output: res.output } } : {}),
      }
    }
    return {
      status: 'success' as const,
      message: `${target} 做完了`,
      data: { output: res.output },
    }
  },
}
