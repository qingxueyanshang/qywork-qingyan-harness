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

import type { DelegatePort, SubagentSummary, ToolContext, ToolSpec } from '@qywork/agent'
import { EFFORT_ORDER, isEffortLevel, parseSubagentTarget, SUBAGENT_KIND_LABEL } from '@qywork/core'
import { idArg } from './args.ts'

const STATUS_LABEL: Record<SubagentSummary['status'], string> = {
  running: '执行中',
  idle: '空闲',
  failed: '上次未成功',
}

/**
 * 把模型填写的子 agent 引用解析为本会话子 agent 的 id：先按 id 精确匹配，再按名称精确匹配且唯一。
 * `subagent`、`stop_subagent`、`read_history` 共用此解析。
 *
 * 未找到或名称重复时，错误列出本会话全部子 agent 的名称、id 与状态。不要改为只报告「没有」：
 * id 较长，抄错一位即无法匹配，模型没有清单时只能继续推测 id。不做近似匹配，不替模型选择。
 */
export async function resolveSubagentRef(
  delegate: DelegatePort,
  ref: string,
): Promise<{ id: string } | { error: string }> {
  const all = await delegate.subagents()
  if (all.some((s) => s.id === ref)) return { id: ref }
  const named = all.filter((s) => s.name === ref)
  if (named.length === 1) return { id: named[0]!.id }
  const listing = all.length
    ? `本会话的子 agent：${all.map((s) => `${s.name}（${s.id}，${STATUS_LABEL[s.status]}）`).join('；')}`
    : '本会话还没有子 agent'
  return {
    error: named.length
      ? `本会话有 ${named.length} 个名为「${ref}」的子 agent，请改用 id。${listing}`
      : `本会话中没有子 agent ${ref}。${listing}`,
  }
}

export const subagentTool: ToolSpec = {
  name: 'subagent',
  description:
    '把一项任务委派给一个子 agent。派发后立即返回，子 agent 完成后回执会作为一条消息送到本会话，不要为了等回执反复调用。' +
    '首次派发按 kind 新建：role 按角色 id 新建、temp 为临时子 agent（name 必填）、cli 为外部 CLI；返回其 subagentId。' +
    '之后向同一个子 agent 派发任务时将 subagent 填为该 id 或名称，子 agent 在自己的会话中继续，三种种类均可续接。' +
    '向正在执行的角色或临时子 agent 派发时，任务作为补充指令送入它正在执行的一轮，在它的下一步生效；' +
    '它结束前未读取的补充指令在回执中列出。外部 CLI 执行中再次派发返回「正在执行」，收到其回执后再派发。' +
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
          '子 agent 的名称。kind 为 temp 时必填；role / cli 可选，不填时使用角色名或 CLI 名；' +
          '续接已有子 agent 时可选，填写后改为该名称。',
      },
      cli: {
        type: 'string',
        description: '外部 CLI 的 id，运行上下文清单里的一项。kind 为 cli 时填。',
      },
      subagent: {
        type: 'string',
        description:
          '本会话已有子 agent 的 id 或名称（上一次派发返回的 subagentId，或运行上下文「本会话的子 agent」清单里的 id 与名称）。' +
          '填写后在该子 agent 的上下文中继续，不再填 kind、role、cli；本次任务与其现有名称不符时同时填写 name。',
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
      effort: {
        type: ['string', 'null'],
        enum: [...EFFORT_ORDER, null],
        description:
          '用户指定思考强度时填写，写在 task 正文里不生效。只作用于本次派发，新建与续接均可填写。' +
          '不填 = 子 agent 使用角色的模型时取角色设定的档位，否则取模型配置中该模型的档位。' +
          '所用模型不支持该档位时派发被拒绝并列出可选档位；外部 CLI 按其命令行参数传入，没有该参数的 CLI 拒绝。',
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
    const effort = args.effort ?? undefined
    if (effort !== undefined && !isEffortLevel(effort)) {
      return {
        status: 'failure' as const,
        message: `effort 必须是 ${EFFORT_ORDER.join('、')} 之一`,
      }
    }
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
    // 校验失败时列出当前未完成的待办：模型据此逐字复制，不必另行读取清单。
    const listing = `当前未完成：${unfinished.map((todo) => `「${todo.content}」`).join('、')}`
    if (unfinished.length > 0 && !parentTodo) {
      return {
        status: 'failure' as const,
        message: `当前有未完成待办；请用 parentTodo 逐字绑定本次子任务成功后即可完成的待办。${listing}`,
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
              ? `parentTodo 不在当前未完成清单中：${parentTodo}。${unfinished.length ? listing : '当前没有未完成待办'}`
              : `当前清单里有多条同名待办，无法确定归属：${parentTodo}`,
          errorKind: 'invalid_plan',
        }
      }
    }

    let dispatchTarget = target.target
    if ('subagent' in dispatchTarget) {
      const found = await resolveSubagentRef(delegate, dispatchTarget.subagent)
      if ('error' in found) return { status: 'failure' as const, message: found.error }
      dispatchTarget = { ...dispatchTarget, subagent: found.id }
    }
    const res = await delegate.dispatch({
      target: dispatchTarget,
      task,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
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
    const head = res.injected
      ? `${who}（subagentId ${res.subagentId}）正在执行，本次任务已作为补充指令送入它正在执行的一轮，在它的下一步生效；回执在它结束后送达`
      : `已派出${who}（subagentId ${res.subagentId}），回执会作为一条消息送到本会话`
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
