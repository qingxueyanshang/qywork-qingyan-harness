/**
 * 编排里的一个成员怎么跑：起一条独立子会话，跑完把最终文本交回去。
 *
 * 成员会话的事件**不往父会话广播**——那些 runId 在父会话里不存在，前端会按
 * 陌生 runId 建出一条并不存在的 run。进度只由 `team.member` 事件表达。
 *
 * 调用方是派活端口（`delegate.ts`）：`subagent` 派一件、`workflow` 派一张图，
 * 两条都落到这里。**没有第三条**——`team.run` 那条指令连同它的前端入口一起删了。
 */

import type { ConversationId, StopReason } from '@qywork/core'
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
 * 角色只点了模型没点接口时**保持那一对不动**：那条路径按裸模型名发请求，接口靠反查，
 * 换一对进去只会让落库的接口名与实际发出去的那家对不上。
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
    return {
      provider: role.provider,
      // 角色没点名模型时用这个接口下的第一个。**不能沿用当前 active.model**：
      // 那个模型属于另一个接口，拿它去发请求就是「换了 key 没换模型名」。
      model: role.model ?? Object.keys(pinned.models)[0] ?? config.active.model,
    }
  }
  if (role.model) return config.active
  return pick?.inherit ?? config.active
}

/**
 * 用户点名的模型解析成一对「接口 × 模型」。接受 `模型 id`，也接受 `接口/模型`。
 *
 * **同一个模型 id 挂在两个接口下时报错，不按枚举顺序挑一个**：挑错了是端点、key、
 * 价目表三样一起换掉，而且不报错。
 */
export function resolveModel(name: string, config: QyConfig): ModelRef | { error: string } {
  const hits = Object.entries(config.providers).filter(([, p]) => p.models[name])
  if (hits.length === 1) return { provider: hits[0]![0], model: name }
  if (hits.length > 1) {
    return { error: `${name} 挂在多个接口下（${hits.map(([n]) => n).join('、')}），写成 接口/模型` }
  }
  const cut = name.indexOf('/')
  if (cut > 0) {
    const provider = name.slice(0, cut)
    const model = name.slice(cut + 1)
    const p = config.providers[provider]
    if (p?.models[model]) return { provider, model }
  }
  return { error: `配置里没有模型 ${name}。现在能用的是：${modelList(config)}` }
}

function modelList(config: QyConfig): string {
  return Object.entries(config.providers)
    .flatMap(([name, p]) => Object.keys(p.models).map((m) => `${name}/${m}`))
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
 * **内层事件不往外发。** 成员会话有自己的 runId，把它的 tool.started / text.delta 广播到父会话上，
 * 前端会按那个陌生 runId 建出一条并不存在的 run。进度由编排器的 `team.member`
 * 事件表达，那是**为这件事设计的**通道。
 */
/**
 * 子 agent 没跑到自然结束时的原因，原样交回父会话——它据此决定是换做法还是拆小再派。
 * 压成一句「没做成」的话，模型除了原样重派没有别的选择，而重派必然又撞同一堵墙。
 */
const CUT_SHORT: Partial<Record<StopReason, string>> = {
  max_steps: '步数用尽，任务没做完',
  no_progress: '连着两轮没有任何进展，自己停了',
  user_interrupt: '被中断',
  process_exit: '进程退出',
  output_truncated: '产出被模型的单次长度上限截断',
  provider_error: '模型服务出错',
  internal_guard: '上一轮在工具执行期间中断，这一轮的结果不可信',
}

export async function runBuiltinMember(
  input: { role: Role; prompt: string; signal: AbortSignal },
  ctx: {
    // 只要装配三件套：派活端口（`delegate.ts`）在没有 WebSocket 的地方也要调它。
    deps: Omit<CommandDeps, 'ws'>
    /** 父会话所在的项目目录。成员会话跑在同一个根下——一轮编排不跨项目。 */
    workspaceRoot: string
    /** 父会话当前的「接口 × 模型」，谁都没点名时成员跟着它跑。 */
    inherit?: ModelRef
    /** 用户这一次点名的那一对，盖过角色与父会话。 */
    explicit?: ModelRef
  },
): Promise<{ ok: boolean; output: string; error?: string; conversationId?: ConversationId }> {
  const { role } = input
  const { deps } = ctx

  const active = memberModel(role, deps.config, {
    ...(ctx.explicit ? { explicit: ctx.explicit } : {}),
    ...(ctx.inherit ? { inherit: ctx.inherit } : {}),
  })
  if ('error' in active) return { ok: false, output: '', error: active.error }
  const config = { ...deps.config, active }

  const session = new Session({
    store: deps.store,
    config,
    content: deps.content,
    workspaceRoot: ctx.workspaceRoot,
    signal: input.signal,
    ...(role.systemPrompt ? { extraSystem: role.systemPrompt } : {}),
    ...(role.allowedTools ? { allowedTools: role.allowedTools } : {}),
    ...(role.maxSteps ? { maxSteps: role.maxSteps } : {}),
  })

  let text = ''
  let error: string | null = null
  let conversationId: ConversationId | undefined
  let stop: StopReason | null = null

  try {
    for await (const ev of session.ask(input.prompt, undefined, {
      // 点名过模型时不再带角色那一个：裸模型名会盖过上面刚定下的那一对。
      ...(role.model && !ctx.explicit ? { model: role.model } : {}),
      // 成员子会话不进会话列表——`listConversations` 的判据是 `source IS NULL`。
      // 不打这个标记的话，每跑一次 team，用户列表里就多出 N 条以成员 prompt
      // 开头的条目，而点进去只有半截独白。
      source: 'workflow',
      sourceRef: role.id,
    })) {
      if (ev.type === 'run.started') conversationId = ev.conversationId
      else if (ev.type === 'text.delta') text += ev.delta
      else if (ev.type === 'run.error') error = `[${ev.code}] ${ev.message}`
      else if (ev.type === 'run.finished') stop = ev.stopReason
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    session.dispose()
  }

  const output = text.trim()
  return {
    ...memberOutcome({ error, stop, output }),
    output,
    ...(conversationId ? { conversationId } : {}),
  }
}

/**
 * 一个成员算不算做成了。
 *
 * **权威是这一轮的终态，不是「有没有文字」。** 只看文字的话，步数用尽或原地打转
 * 被掐断的子 agent——它前面说过的话还在——会被报成「做完了」，父会话据此往下走。
 * 反过来，没报错但一个字也没产出同样算失败：ok + 空串会被下游当成
 * 「认真看过，确实没什么可说的」，那是另一件事。
 */
export function memberOutcome(input: {
  error: string | null
  stop: StopReason | null
  output: string
}): { ok: boolean; error?: string } {
  const { error, stop, output } = input
  if (error) return { ok: false, error }
  if (stop !== 'completed') {
    return { ok: false, error: (stop && CUT_SHORT[stop]) ?? `提前停止（${stop ?? '没有终态'}）` }
  }
  if (!output) return { ok: false, error: '该角色没有产出任何内容' }
  return { ok: true }
}
