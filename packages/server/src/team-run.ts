/**
 * 编排里的一个成员怎么跑：起一条独立子会话，跑完把最终文本交回去。
 *
 * 成员会话的事件**按它自己的会话 id 广播**，不挂在父会话的归属上——那些 runId
 * 在父会话里不存在，挂过去前端会按陌生 runId 建出一条并不存在的 run。
 * 父会话那张图卡上的进度只由 `team.member` 事件表达。
 *
 * 调用方是派活端口（`delegate.ts`）：`subagent` 派一件、`workflow` 派一张图，
 * 两条都落到这里。**没有第三条**——`team.run` 那条指令连同它的前端入口一起删了。
 */

import type { AgentEvent, ConversationId, RunId, StopReason } from '@qywork/core'
import { type ModelRef, type QyConfig, Session } from '@qywork/runtime'
import type { Role } from '@qywork/team'
import type { CommandDeps } from './deps.ts'

/**
 * 成员会话用哪一对「接口 × 模型」。优先级：角色点名 > 父会话当前那一对 > 配置默认。
 *
 * **父会话那一对必须传下来**：模型是会话级属性（`repos.ts` 的 `setConversationModel`），
 * 用户在界面上切到便宜模型之后派活，不继承就仍然按 `config.active` 发请求——
 * 而工具描述向模型承诺的是「当前模型」。
 *
 * 角色只点了模型没点接口时先按配置反查并钉住接口；找不到或撞名就本地拒绝。
 * 不能把未知名称挂到当前接口上试：那会让四个写错的模型都请求同一家 provider，
 * 子会话账本里的接口也跟真正命中的接口对不上。
 */
export function memberModel(
  role: Pick<Role, 'id' | 'provider' | 'model'>,
  config: QyConfig,
  pick?: { explicit?: ModelRef; inherit?: ModelRef },
): ModelRef | { error: string } {
  // 用户这一次点名的模型盖过一切，包括角色自己钉的那一对：他要的就是这一次换个模型跑。
  if (pick?.explicit) return pick.explicit
  if (role.provider) {
    // provider 指定的是「用哪家的 key」。指了一个不存在的接口要**当场失败**——
    // 静默回落到当前接口会让「用便宜模型跑审查」这类配置失效，而账单记在另一边。
    const pinned = config.providers[role.provider]
    if (!pinned) return { error: `角色 ${role.id} 指定的接口不存在：${role.provider}` }
    if (role.model && !pinned.models[role.model]) {
      return {
        error: `角色 ${role.id} 在接口 ${role.provider} 下指定了不存在的模型 ${role.model}。现在能用的是：${modelList(config)}`,
      }
    }
    const model = role.model ?? Object.keys(pinned.models)[0]
    if (!model) return { error: `角色 ${role.id} 指定的接口 ${role.provider} 没有配置模型` }
    return { provider: role.provider, model }
  }
  if (role.model) return resolveModel(role.model, config)
  return pick?.inherit ?? config.active
}

/**
 * 用户点名的模型解析成一对「接口 × 模型」。接口与模型始终分列传递。
 *
 * **同一个模型 id 挂在两个接口下时报错，不按枚举顺序挑一个**：挑错了是端点、key、
 * 价目表三样一起换掉，而且不报错。
 */
export function resolveModel(
  name: string,
  config: QyConfig,
  provider?: string,
): ModelRef | { error: string } {
  if (provider) {
    const pinned = config.providers[provider]
    if (!pinned) return { error: `配置里没有接口 ${provider}。现在能用的是：${modelList(config)}` }
    if (!pinned.models[name]) {
      return {
        error: `接口 ${provider} 下没有模型 ${name}。现在能用的是：${modelList(config)}`,
      }
    }
    return { provider, model: name }
  }
  const hits = Object.entries(config.providers).filter(([, p]) => p.models[name])
  if (hits.length === 1) return { provider: hits[0]![0], model: name }
  if (hits.length > 1) {
    return {
      error: `${name} 挂在多个接口下（${hits.map(([n]) => n).join('、')}），请同时指定 provider 与 model`,
    }
  }
  return { error: `配置里没有模型 ${name}。现在能用的是：${modelList(config)}` }
}

function modelList(config: QyConfig): string {
  return Object.entries(config.providers)
    .flatMap(([provider, stored]) =>
      Object.keys(stored.models).map(
        (model) => `(provider=${JSON.stringify(provider)}, model=${JSON.stringify(model)})`,
      ),
    )
    .join('、')
}

/**
 * 内置后端：用本进程的 agent 跑一个编排成员。
 *
 * 在这之前它是一句「尚未接线」的显式失败——没装 codex / claude 的用户点「开始编排」
 * 什么都得不到。而 `qy` 自己就是一个完整的 agent，把它当成一个后端用不需要新增实现，
 * 只需要一个独立会话。
 *
 * **每个成员一个独立会话，不共用。** 成员之间的上下文必须隔离：一个「审查者」角色看见「实现者」的完
 * 整思考过程，它就不再是独立视角了，而独立视角正是多角色的全部意义。节点之间要传递的内容由编排器
 * 显式拼进 prompt（`needs` 的产出），不靠共享上下文。
 *
 * **内层事件按子会话自己的 id 发，不挂在父会话的归属上。** 成员会话有自己的 runId，
 * 挂着父会话的 id 广播出去的话，前端会按那个陌生 runId 建出一条并不存在的 run。
 * 归属写在帧上之后两件事各自成立：右侧那一页订阅子会话 id 就能实时看它在做什么，
 * 而父会话的订阅者按会话隔离收不到（`bus.ts` 的 `visibleTo`）。
 * 父会话那张图卡上的进度仍由 `team.member` 表达，那是为这件事设计的通道。
 */
/**
 * 子 agent 没跑到自然结束时的原因，原样交回父会话——它据此决定是换做法还是拆小再派。
 * 压成一句「没做成」的话，模型除了原样重派没有别的选择，而重派必然又撞同一堵墙。
 */
const CUT_SHORT: Partial<Record<StopReason, string>> = {
  no_progress: '连续三轮没有任何进展，自己停了',
  user_interrupt: '被中断',
  process_exit: '进程退出',
  output_truncated: '产出被模型的单次长度上限截断',
  provider_error: '模型服务出错',
  internal_guard: '上一轮在工具执行期间中断，这一轮的结果不可信',
}

export async function runBuiltinMember(
  input: {
    /** 运行约束：角色的提示词与工具面；临时子 agent 两者都空。 */
    role: Role
    prompt: string
    signal: AbortSignal
    /** 子 agent 的会话。派活端口在派之前就建好了它，接口与模型都记在那一行上。 */
    conversationId: ConversationId
  },
  ctx: {
    // 只要装配三件套：派活端口（`delegate.ts`）在没有 WebSocket 的地方也要调它。
    deps: Omit<CommandDeps, 'ws'>
    /** 父会话所在的项目目录。成员会话跑在同一个根下——一轮编排不跨项目。 */
    workspaceRoot: string
    /** team.json 里追加给所有内置子 agent 的公共约束。 */
    shared?: string
    /** 子会话的每一条事件，带着它自己的会话 id。见本文件头那段。 */
    onEvent?: (event: AgentEvent, conversationId: ConversationId) => void
  },
): Promise<{ ok: boolean; output: string; error?: string; stop: StopReason | null }> {
  const { role } = input
  const { deps } = ctx
  const extraSystem = [role.systemPrompt, ctx.shared].filter(Boolean).join('\n\n')

  /*
   * 子会话也必须进入和主会话相同的 RunManager 生命周期。
   *
   * 旧链路只把 `run.started` / 正文 / `run.finished` 转发到事件总线，却从未 register
   * 子 run。后果不是少一条装饰性事件：握手与 `conversation.busy` 都不知道子会话
   * 在运行。用户在它开跑后才点开时，前端虽然能从账本拉到正文，却没有权威忙态，
   * 因而不挂实时状态条；这正是主会话与子会话表现分叉的根因。
   *
   * 调用方只给 AbortSignal，所以这里建一个可登记的 controller，并把父信号单向
   * 传进来。这样父会话停止仍会中断成员；RunManager 的统一停止/关服路径也能直接
   * 中断这条子 run，不需要另造一份“子会话忙闲”。
   */
  const controller = new AbortController()
  const abortFromParent = () => controller.abort(input.signal.reason)
  if (input.signal.aborted) abortFromParent()
  else input.signal.addEventListener('abort', abortFromParent, { once: true })

  const session = new Session({
    store: deps.store,
    config: deps.config,
    content: deps.content,
    workspaceRoot: ctx.workspaceRoot,
    signal: controller.signal,
    ...(extraSystem ? { extraSystem } : {}),
    ...(role.allowedTools ? { allowedTools: role.allowedTools } : {}),
  })

  let text = ''
  let error: string | null = null
  const conversationId = input.conversationId
  let runId: RunId | null = null
  let stop: StopReason | null = null
  let detail: string | null = null

  try {
    // 会话已经存在，接口与模型记在它那一行上；这里不再递模型名。
    for await (const ev of session.ask(input.prompt, conversationId)) {
      if (ev.type === 'run.started') {
        runId = ev.runId
        // 先登记忙态，再暴露子会话入口。用户拿到入口立刻点开时，加载侧已经能从
        // 同一张权威表确认“正在运行”，不会依赖自己是否碰巧赶上 run.started。
        deps.runs.register({
          runId,
          conversationId,
          controller,
          startedAt: Date.now(),
        })
      } else if (ev.type === 'text.delta') text += ev.delta
      else if (ev.type === 'run.error') error = `[${ev.code}] ${ev.message}`
      else if (ev.type === 'run.finished') {
        stop = ev.stopReason
        detail = ev.stopDetail ?? null
      }
      ctx.onEvent?.(ev, conversationId)
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    if (runId) deps.runs.unregister(runId)
    input.signal.removeEventListener('abort', abortFromParent)
    session.dispose()
  }

  const output = text.trim()
  return { ...memberOutcome({ error, stop, detail, output }), output, stop }
}

/**
 * 一个成员算不算做成了。
 *
 * **权威是这一轮的终态，不是「有没有文字」。** 只看文字的话，原地打转或被中断的
 * 子 agent——它前面说过的话还在——会被报成「做完了」，父会话据此往下走。
 * 反过来，没报错但一个字也没产出同样算失败：ok + 空串会被下游当成
 * 「认真看过，确实没什么可说的」，那是另一件事。
 */
export function memberOutcome(input: {
  error: string | null
  stop: StopReason | null
  /** 停机的具体依据（`RunFinishedEvent.stopDetail`），接在文案后交给父会话。 */
  detail?: string | null
  output: string
}): { ok: boolean; error?: string } {
  const { error, stop, output } = input
  if (error) return { ok: false, error }
  if (stop !== 'completed') {
    const text = (stop && CUT_SHORT[stop]) ?? `提前停止（${stop ?? '没有终态'}）`
    return { ok: false, error: input.detail ? `${text}：${input.detail}` : text }
  }
  if (!output) return { ok: false, error: '该角色没有产出任何内容' }
  return { ok: true }
}
