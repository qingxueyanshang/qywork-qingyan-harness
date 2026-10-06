/**
 * 派发一个子 agent。
 *
 * 子 agent 是本会话中的实体：首次派发按种类创建（角色 / 临时 / 外部 CLI），
 * 返回其 id；之后填写该 id 再次派发，即在其上下文中继续。三种种类均可续接。
 * 两个及以上子 agent 使用 `workflow`，本工具一次只派发一个，不并行。
 *
 * 派发后立即返回。本次调用只答复是否已派发，产出由派发通道在子 agent 完成后
 * 作为一条消息送入本会话。
 *
 * 失败通过返回值表达。无法派发（目标不存在、外部 CLI 未安装）时如实返回 failure 并附原因，
 * 不抛异常：注册表会把异常归并为一句「工具执行出错」，模型无法据此调整做法。
 */

import type { ToolContext, ToolSpec } from '@qywork/agent'
import { parseSubagentTarget, SUBAGENT_KIND_LABEL } from '@qywork/core'
import { idArg } from './args.ts'

export const subagentTool: ToolSpec = {
  name: 'subagent',
  description:
    '把一项任务委派给一个子 agent。派发后立即返回，子 agent 完成后回执会作为一条消息送到本会话，不要为了等回执反复调用。' +
    '首次派发按 kind 新建：role 按角色 id 新建、temp 为临时子 agent（name 必填）、cli 为外部 CLI；返回其 subagentId。' +
    '之后向同一个子 agent 派发任务时将 subagent 填为该 id，子 agent 在自己的会话中继续，三种种类均可续接。' +
    '一次只派发一个，两个及以上用 workflow。' +
    '子 agent 无法看到本会话的内容，背景需写入 task。',
  parameters: {
    type: 'object',
    properties: {
      kind: {
        type: ['string', 'null'],
        enum: ['role', 'temp', 'cli', null],
        description:
          '新建子 agent 的种类。role：按角色库里的角色新建，同时填 role；temp：临时子 agent，同时填 name；' +
          'cli：外部 CLI，同时填 cli。续接已有子 agent 时不填 kind，改填 subagent。',
      },
      role: {
        type: 'string',
        description: '角色 id，运行上下文「角色」清单里的一项。kind 为 role 时填。',
      },
      name: {
        type: 'string',
        description:
          '子 agent 的名称。kind 为 temp 时必填；role / cli 可选，不填时使用角色名或 CLI 名。',
      },
      cli: {
        type: 'string',
        description: '外部 CLI 的 id，运行上下文清单里的一项。kind 为 cli 时填。',
      },
      subagent: {
        type: 'string',
        description:
          '本会话已有子 agent 的 id（上一次派发返回的 subagentId，或运行上下文「本会话的子 agent」清单里的 id）。' +
          '填写后在该子 agent 的上下文中继续，不再填 kind、role、name、cli。',
      },
      task: {
        type: 'string',
        description: '交给子 agent 的任务。子 agent 无法看到本会话，因此背景需在此写完整。',
      },
      parentTodo: {
        type: 'string',
        description:
          '本次子任务产出归属的父待办，逐字复制当前清单里的 content。' +
          '当前有未完成待办时必填；返回后该条仍保持未完成，等待当前会话验收。',
      },
      provider: {
        type: 'string',
        description:
          '仅在填写 model 时填写：逐字使用运行上下文「已配置模型」清单中同一行的 provider 参数。',
      },
      model: {
        type: 'string',
        description:
          '用户指定模型时填写：逐字使用运行上下文「已配置模型」清单中的 model 参数，并同时填写对应 provider。' +
          '写在 task 正文里不生效，子 agent 不会自行切换模型。' +
          '不填 = 使用当前会话的模型（角色指定了模型时使用角色的模型）。只在新建时生效；外部 CLI 使用其自身的模型，填写会被拒绝。',
      },
    },
    additionalProperties: false,
  },
  actionKind: 'run',
  objectLabel: '子 agent',
  category: 'session',
  facet: '协作',
  summary: '派发子 agent 执行任务',
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
  // 子 agent 使用自己的工具集，权限在其会话中逐次裁决；
  // 外部 CLI 是本机上的另一个进程。两者都属于启动一项会改动本机的操作。
  permissionEffect: 'execute',
  // 一次只派发一个：同一轮内的多次调用串行执行。并行只能使用 workflow。
  parallelSafe: false,

  async fn(args: Record<string, unknown>, ctx: ToolContext) {
    const delegate = ctx.delegate
    if (!delegate) {
      // 正常情况下不会执行到此处：没有派发通道时本工具不注册。
      return { status: 'failure' as const, message: '本次执行没有派发通道' }
    }

    const target = parseSubagentTarget(args)
    if (!target.ok) return { status: 'failure' as const, message: target.error }
    const task = typeof args.task === 'string' ? args.task.trim() : ''
    const parentTodo = typeof args.parentTodo === 'string' ? args.parentTodo.trim() : ''
    const provider = idArg(args.provider)
    const model = idArg(args.model)
    if (!task) return { status: 'failure' as const, message: '需写明交给子 agent 的任务' }
    if (provider && !model) {
      return { status: 'failure' as const, message: '指定 provider 时必须同时指定 model' }
    }

    /*
     * 子任务与父清单的归属在派发之前确定。返回之后再依靠自然语言推测归属
     * 会使验收对象发生偏移；但归属不等于验收，子 agent 返回 success 不能代替父会话标记完成。
     *
     * 只在存在未完成清单时要求归属：没有清单的短任务照常可以派发。内容必须唯一且逐字匹配，
     * 不接受模糊匹配，也不静默替模型选择一条。
     */
    const unfinished = ctx.todos?.read()?.filter((todo) => todo.status !== 'completed') ?? []
    if (unfinished.length > 0 && !parentTodo) {
      return {
        status: 'failure' as const,
        message: '当前有未完成待办；请用 parentTodo 逐字绑定本次子任务成功后即可完成的待办',
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
      // 进度显示在本次调用的卡片上。无法取得卡片 id 时照常执行，只是没有运行期状态。
      runId: ctx.runId,
      ...(ctx.stepId ? { stepId: ctx.stepId } : {}),
    })
    // 种类取自派发结果：续接时参数中只有 id，无法判定派发的种类。
    const kindLabel = res.kind ? SUBAGENT_KIND_LABEL[res.kind] : '子 agent'
    const who = res.name ? `${kindLabel} ${res.name}` : kindLabel
    // 派发时的事实附在消息之后：续接未成功、角色已不存在。它是给模型的输入，不是产出。
    const note = res.note ? `；${res.note}` : ''
    if (!res.ok || !res.subagentId) {
      return {
        status: 'failure' as const,
        message: `${who} 无法派发：${res.error ?? '未说明原因'}${note}`,
      }
    }
    const head = `已派出${who}（subagentId ${res.subagentId}），回执会作为一条消息送到本会话`
    return {
      status: 'success' as const,
      message: `${parentTodo ? `${head}；父待办 ${parentTodo} 仍未完成` : head}${note}`,
      data: {
        subagentId: res.subagentId,
        ...(res.kind ? { kind: res.kind } : {}),
        ...(res.name ? { name: res.name } : {}),
      },
    }
  },
}
