/**
 * 把一段任务交给一个子 agent。
 *
 * **三类目标，一个工具**：
 * - **临时子 agent**（不指定 `agent`）：当前模型、全套工具，任务结束即销毁。
 *   并行铺开去查、去读、去验证时用它——为了几件小事先定义几个角色，没人会这么用。
 * - **角色**：项目里配置好的那个，有自己的提示词与工具面。
 * - **外部 CLI**：本机安装的别家 agent 程序。
 *
 * 三者的配置面毫不相干，但对调用方是同一件事：交出去、拿回产出。拆成三个工具，
 * 模型就要先判断「这个名字属于哪一类」——而那正是这里该替它做的。
 *
 * **失败是返回值。** 派不出去（目标不存在、外部 CLI 没装、执行失败）都如实回 failure 并带原因，
 * 不抛异常：注册表会把异常压成一句「工具执行出错」，模型据此换不了做法。
 */

import type { ToolContext, ToolSpec } from '@qywork/agent'
import { idArg } from './args.ts'

export const subagentTool: ToolSpec = {
  name: 'subagent',
  description:
    '把一段任务交给一个子 agent，等待其完成并返回产出。' +
    '**不指定 agent 则临时起一个**：用当前模型与全套工具，任务结束即销毁；' +
    '要并行铺开去查、去读、去验证时用这一种，不必先定义角色。' +
    '指定 agent 时派给项目里配置好的角色（各有提示词与工具面），' +
    '或 cli:<id> 派给本机安装的外部 agent CLI。' +
    '适合可以独立完成、产出是一段文字的整块工作；' +
    '依赖当前会话上下文的任务不要委派——子 agent 不接收本会话内容。',
  parameters: {
    type: 'object',
    properties: {
      agent: {
        type: 'string',
        description:
          '派给谁。留空 = 临时起一个子 agent（当前模型、全套工具）；' +
          '填角色 id = 派给配置好的角色；填 cli:<id> = 派给本机的外部 CLI。',
      },
      task: {
        type: 'string',
        description: '要它做什么。子 agent 看不到这条会话，所以背景要在这里写全。',
      },
      model: {
        type: 'string',
        description:
          '**只在用户点名了模型时才填**：写模型 id，同一个 id 挂在多个接口下时写 接口/模型。' +
          '不填 = 跟当前会话同一个模型。外部 CLI 用它自己的模型，填了会被拒。',
      },
      resume: {
        type: 'string',
        description:
          '续接指定的外部 CLI 会话：填上一次调用返回的 session。' +
          '该会话保留上一轮上下文，可直接就其产出追问；' +
          '不填则新建会话，任务会被重新执行一遍。仅外部 CLI 支持。',
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
  /*
   * **派几件就是几件一起跑。**
   *
   * 不开的话同一批调用被 `planWaves` 拆成一波一件串着跑，而工具描述与提示词
   * （`prompt.ts`）承诺的都是「互不依赖的可以一次派几个」——承诺了并行却串行执行，
   * 用户看到的是第一格跑完第二格才开始。
   *
   * 边界：并发的子 agent 各自会动这个工作区的文件，这里不做冲突检测。
   * 一张图里的节点本来就是这么跑的（编排器按 `maxConcurrent` 并发），
   * 派一件与派一张图必须是同一种行为，否则同一件事换个工具名就换一种语义。
   */
  parallelSafe: true,

  async fn(args: Record<string, unknown>, ctx: ToolContext) {
    const delegate = ctx.delegate
    if (!delegate) {
      // 正常不会走到：没有这条通道时这个工具不注册。
      return { status: 'failure' as const, message: '本次执行没有派活通道' }
    }

    const target = idArg(args.agent)
    const task = typeof args.task === 'string' ? args.task.trim() : ''
    const model = idArg(args.model)
    const resume = idArg(args.resume)
    if (!task) return { status: 'failure' as const, message: '要它做什么得写清楚' }

    // 只有指名道姓派给某个角色 / CLI 时才校验它在不在。**临时子 agent 不需要先定义**，
    // 那正是它存在的理由：为了铺开去做几件小事而先建几个角色，没人会这么用。
    if (target) {
      const targets = await delegate.targets()
      if (!targets.some((t) => t.id === target)) {
        return {
          status: 'failure' as const,
          message:
            targets.length === 0
              ? `没有 ${target}：这个项目没有配置角色，本机也没识别到外部 CLI。不指定 agent 可以临时起一个。`
              : `没有 ${target}。现在能派的是：${targets.map((t) => t.id).join('、')}`,
          errorKind: 'not_found',
        }
      }
    }

    const who = target || '临时子 agent'
    const res = await delegate.run({
      target,
      task,
      ...(model ? { model } : {}),
      ...(resume ? { resume } : {}),
      // 进度挂在这次调用那张卡上。拿不到卡片 id 时照跑，只是没有运行期状态——
      // 与 `workflow` 不同，这里的形状与终态都不依赖事件（见 `DelegatePort.run`）。
      runId: ctx.runId,
      ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
      signal: ctx.signal,
    })
    /*
     * 两个 id 无论成败都交出去。
     *
     * `session` 是接着问外部 CLI 的唯一入口，`conversationId` 是点开那条子会话的唯一入口
     * （进度事件不落库，刷新之后就靠它）。失败时更需要：没做成的那条会话正是要翻开看的
     * 那一条，而回执说不清楚时追问比重派一遍便宜。
     */
    const ids = {
      ...(res.session ? { session: res.session } : {}),
      ...(res.conversationId ? { conversationId: res.conversationId } : {}),
    }
    if (!res.ok) {
      return {
        status: 'failure' as const,
        message: `${who} 没做成：${res.error ?? '没有说明原因'}`,
        ...(res.output || res.session || res.conversationId
          ? { data: { output: res.output, ...ids } }
          : {}),
      }
    }
    return {
      status: 'success' as const,
      message: `${who} 做完了`,
      data: { output: res.output, ...ids },
    }
  },
}
