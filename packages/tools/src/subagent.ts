/**
 * 派发一个子 agent。
 *
 * 子 agent 是这条会话里的实体：第一次派发按种类建（角色 / 临时 / 外部 CLI），
 * 返回它的 id；之后填 id 再派就是接着它的上下文继续。三种种类都能续。
 * 两个及以上子 agent 用 `workflow`，这个工具一次只派一个，不并行。
 *
 * **失败是返回值。** 派不出去（目标不存在、外部 CLI 没装、执行失败）都如实回 failure 并带原因，
 * 不抛异常：注册表会把异常压成一句「工具执行出错」，模型据此换不了做法。
 */

import type { ToolContext, ToolSpec } from '@qywork/agent'
import { parseSubagentTarget } from '@qywork/core'
import { idArg } from './args.ts'

export const subagentTool: ToolSpec = {
  name: 'subagent',
  description:
    '派发一个子 agent，等它完成并返回产出。' +
    '第一次派发按 kind 建：role 按角色库里的角色建，temp 临时子 agent（定义写在这次调用里），cli 外部 CLI；' +
    '返回它的 subagentId。之后给同一个子 agent 派任务填 subagent 为那个 id，它接着自己的上下文继续，三种都能续。' +
    '一次只派一个，两个及以上子 agent 用 workflow。' +
    '当前有未完成待办时，必须用 parentTodo 精确绑定本次产出归属的那一条；子 agent 成功只表示产出返回，' +
    '父待办仍需当前会话验收并用 write_todos 完成。' +
    '子 agent 看不到这条会话的内容，背景要写进 task。',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: ['string', 'null'],
        enum: ['role', 'temp', 'cli', null],
        description:
          '新建子 agent 的种类。role：按角色库里的角色建，同时填 role；temp：临时子 agent，同时填 name；' +
          'cli：外部 CLI，同时填 cli。续接已有子 agent 时不填 kind，改填 subagent。',
      },
      role: {
        type: 'string',
        description: '角色 id，运行上下文「角色」清单里的一项。kind 为 role 时填。',
      },
      name: {
        type: 'string',
        description:
          '子 agent 的名字。kind 为 temp 时必填；role / cli 可选，不填用角色名或 CLI 名。',
      },
      cli: {
        type: 'string',
        description: '外部 CLI 的 id，运行上下文清单里的一项。kind 为 cli 时填。',
      },
      subagent: {
        type: 'string',
        description:
          '本会话已有子 agent 的 id（上一次派发返回的 subagentId，或运行上下文「本会话的子 agent」清单里的 id）。' +
          '填了它就是接着它的上下文继续，不再填 kind、role、name、cli。',
      },
      task: {
        type: 'string',
        description: '要它做什么。子 agent 看不到这条会话，所以背景要在这里写全。',
      },
      parentTodo: {
        type: 'string',
        description:
          '这次子任务产出归属的父待办，逐字复制当前清单里的 content。' +
          '当前有未完成待办时必填；返回后该条仍保持未完成，等待当前会话验收。',
      },
      provider: {
        type: 'string',
        description:
          '只在填写 model 时才填：逐字使用运行上下文「已配置模型」清单中同一行的 provider 参数。',
      },
      model: {
        type: 'string',
        description:
          '只在用户点名了模型时才填：逐字使用运行上下文「已配置模型」清单中的 model 参数，并同时填写对应 provider。' +
          '不填 = 用当前会话的模型（角色钉了模型用角色的）。只在新建时生效；外部 CLI 用它自己的模型，填了会被拒。',
      },
    },
    additionalProperties: false,
  },
  actionKind: 'run',
  objectLabel: '子 agent',
  category: 'session',
  facet: '协作',
  summary: '派发一个子 agent',
  targetExtractor: (a) =>
    typeof a.subagent === 'string' && a.subagent
      ? a.subagent
      : typeof a.name === 'string' && a.name
        ? a.name
        : typeof a.role === 'string' && a.role
          ? a.role
          : typeof a.cli === 'string'
            ? a.cli
            : null,
  // 子 agent 用它自己那套工具，权限在那一侧按它的会话逐次裁决；
  // 外部 CLI 是本机上的另一个进程。两者都算「起一件会动这台机器的事」。
  permissionEffect: 'execute',
  // 一次只派一个：同一轮里多次调用串行跑。要并行只有 workflow。
  parallelSafe: false,

  async fn(args: Record<string, unknown>, ctx: ToolContext) {
    const delegate = ctx.delegate
    if (!delegate) {
      // 正常不会走到：没有这条通道时这个工具不注册。
      return { status: 'failure' as const, message: '本次执行没有派活通道' }
    }

    const target = parseSubagentTarget(args)
    if (!target.ok) return { status: 'failure' as const, message: target.error }
    const task = typeof args.task === 'string' ? args.task.trim() : ''
    const parentTodo = typeof args.parentTodo === 'string' ? args.parentTodo.trim() : ''
    const provider = idArg(args.provider)
    const model = idArg(args.model)
    if (!task) return { status: 'failure' as const, message: '要它做什么得写清楚' }
    if (provider && !model) {
      return { status: 'failure' as const, message: '指定 provider 时必须同时指定 model' }
    }

    /*
     * 子任务与父清单的归属在派出之前钉死。回来之后靠自然语言猜「它属于哪条」
     * 会让验收对象漂移；但归属不是验收，子 agent 返回 success 不能替父会话打勾。
     *
     * 只要求未完成清单：没有清单的短任务照常可以派。内容必须唯一且逐字匹配，
     * 不接受模糊命中，也不静默替模型挑一条。
     */
    const unfinished = ctx.todos?.read()?.filter((todo) => todo.status !== 'completed') ?? []
    if (unfinished.length > 0 && !parentTodo) {
      return {
        status: 'failure' as const,
        message: '当前有未完成待办；请用 parentTodo 逐字绑定这次子任务成功即可完成的那一条',
        errorKind: 'invalid_plan',
      }
    }
    if (parentTodo) {
      const matches = unfinished.filter((todo) => todo.content === parentTodo)
      if (matches.length !== 1) {
        return {
          status: 'failure' as const,
          message:
            matches.length === 0
              ? `parentTodo 不在当前未完成清单中：${parentTodo}`
              : `当前清单里有多条同名待办，无法确定归属：${parentTodo}`,
          errorKind: 'invalid_plan',
        }
      }
    }

    const res = await delegate.dispatch({
      target: target.target,
      task,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      // 进度挂在这次调用那张卡上。拿不到卡片 id 时照跑，只是没有运行期状态。
      runId: ctx.runId,
      ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
      signal: ctx.signal,
    })
    // id 无论成败都交出去：没做成的那个子 agent 正是要翻开看、要接着派的那一个。
    const ids = {
      ...(res.subagentId ? { subagentId: res.subagentId } : {}),
      ...(res.name ? { name: res.name } : {}),
    }
    const who = res.name ? `子 agent ${res.name}` : '子 agent'
    if (!res.ok) {
      return {
        status: 'failure' as const,
        message: `${who} 没做成：${res.error ?? '没有说明原因'}`,
        ...(res.output || res.subagentId ? { data: { output: res.output, ...ids } } : {}),
      }
    }
    const head = res.created
      ? `已创建${who}（subagentId ${res.subagentId}）并返回产出`
      : `${who} 已返回`
    return {
      status: 'success' as const,
      message: parentTodo
        ? `${head}；父待办仍待验收：${parentTodo}。满意后用 write_todos 完成，不满意则继续派给它。`
        : head,
      data: { output: res.output, ...ids },
    }
  },
}
