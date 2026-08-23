/**
 * 编排里的一个成员怎么跑：起一条独立子会话，跑完把最终文本交回去。
 *
 * 成员会话的事件**不往父会话广播**——那些 runId 在父会话里不存在，前端会按
 * 陌生 runId 建出一条并不存在的 run。进度只由 `team.member` 事件表达。
 *
 * 调用方是派活端口（`delegate.ts`）：`subagent` 派一件、`workflow` 派一张图，
 * 两条都落到这里。**没有第三条**——`team.run` 那条指令连同它的前端入口一起删了，
 * 理由见 `docs/plans/2026-08-23-workflow-图化编排.md`。
 */

import type { ConversationId, RunUsage } from '@qywork/core'
import { Session } from '@qywork/runtime'
import type { Role } from '@qywork/team'
import type { CommandDeps } from './deps.ts'

/**
 * 内置后端：用本进程的 agent 跑一个编排成员。
 *
 * 在这之前它是一句「尚未接线」的显式失败——没装 codex / claude 的用户点「开始编排」
 * 什么都得不到。而 `qy` 自己就是一个完整的 agent，把它当成一个后端用不需要新东西，
 * 只需要一个独立会话。
 *
 * ## 每个成员一个独立会话，不共用
 *
 * 成员之间的上下文必须隔离：一个「审查者」角色看见「实现者」的完整思考过程，
 * 它就不再是独立视角了，而独立视角正是多角色的全部意义。节点之间要传递的东西
 * 由编排器显式拼进 prompt（`needs` 的产出），不靠共享上下文。
 *
 * ## 内层事件不往外发
 *
 * 成员会话有自己的 runId，把它的 tool.started / text.delta 广播到父会话上，
 * 前端会按那个陌生 runId 建出一条并不存在的 run。进度由编排器的 `team.member`
 * 事件表达，那是**为这件事设计的**通道。
 */
export async function runBuiltinMember(
  input: { role: Role; prompt: string; signal: AbortSignal },
  ctx: {
    // 只要装配三件套：派活端口（`delegate.ts`）在没有 WebSocket 的地方也要调它。
    deps: Omit<CommandDeps, 'ws'>
    /** 父会话所在的项目目录。成员会话跑在同一个根下——一轮编排不跨项目。 */
    workspaceRoot: string
    onUsage?: (u: RunUsage) => void
  },
): Promise<{ ok: boolean; output: string; error?: string; conversationId?: ConversationId }> {
  const { role } = input
  const { deps } = ctx

  // provider 指定的是「用哪家的 key」。指了一个不存在的接口要**当场失败**——
  // 悄悄回落到当前接口会让「用便宜模型跑审查」这类配置静默失效，而账单在另一边。
  const pinned = role.provider ? deps.config.providers[role.provider] : undefined
  if (role.provider && !pinned) {
    return {
      ok: false,
      output: '',
      error: `角色 ${role.id} 指定的接口不存在：${role.provider}`,
    }
  }
  const config =
    role.provider && pinned
      ? {
          ...deps.config,
          active: {
            provider: role.provider,
            // 角色没点名模型时用这个接口下的第一个。**不能沿用当前 active.model**：
            // 那个模型属于另一个接口，拿它去发请求就是「换了 key 没换模型名」。
            model: role.model ?? Object.keys(pinned.models)[0] ?? deps.config.active.model,
          },
        }
      : deps.config

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

  try {
    for await (const ev of session.ask(input.prompt, undefined, {
      ...(role.model ? { model: role.model } : {}),
      // 成员子会话不进会话列表——`listConversations` 的判据是 `source IS NULL`。
      // 不打这个标记的话，每跑一次 team，用户列表里就多出 N 条以成员 prompt
      // 开头的条目，而点进去只有半截独白。
      source: 'workflow',
      sourceRef: role.id,
    })) {
      if (ev.type === 'run.started') conversationId = ev.conversationId
      else if (ev.type === 'text.delta') text += ev.delta
      else if (ev.type === 'run.error') error = `[${ev.code}] ${ev.message}`
      else if (ev.type === 'run.finished') ctx.onUsage?.(ev.usage)
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    session.dispose()
  }

  const output = text.trim()
  return {
    // 没报错但一个字也没产出，算失败。返回 ok + 空串会被下游当成
    // 「这个角色认真看过，确实没什么可说的」——那是两件完全不同的事。
    ok: error === null && output.length > 0,
    output,
    ...(error ? { error } : output ? {} : { error: '该角色没有产出任何内容' }),
    ...(conversationId ? { conversationId } : {}),
  }
}
