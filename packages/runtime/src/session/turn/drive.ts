/** 驱动阶段：广播会话更新与本轮开始，装配本轮的 AgentLoop 并转发其事件。 */

import { AgentLoop, type CompactionPort } from '@qywork/agent'
import type { LlmAdapter } from '@qywork/ai'
import type { AgentEvent, ConversationId } from '@qywork/core'
import { getConversation } from '@qywork/store'
import { redactSecrets } from '@qywork/tools'
import { RuntimeCompaction } from '../../compaction.ts'
import { collectSecrets, type ModelRef, resolveModel } from '../../config.ts'
import { buildSystemPrompt } from '../../prompt.ts'
import { makeSummarizer } from '../../summarizer.ts'
import { withAttachments } from '../attachments.ts'
import { loadExtensionTools } from '../extension-tools.ts'
import { makePersistence } from '../persistence.ts'
import { makeToolContext } from '../tool-context.ts'
import type { SessionState } from '../types.ts'
import { changedContext, type KnownContext } from './known-context.ts'
import { recordFinished } from './settle.ts'
import type { AskState, RunHistory } from './state.ts'

export async function* driveLoop(
  session: SessionState,
  ask: AskState,
  input: RunHistory,
): AsyncGenerator<AgentEvent, void, unknown> {
  const { store } = session.opts
  const {
    adapter,
    compactPercent,
    conversationId,
    effort,
    known,
    model,
    options,
    profile,
    prompt,
    run,
    target,
    userMessageId,
  } = ask
  const { anchor, compacted, history, imagesRejected, preserveAssistantReasoning, videosRejected } =
    input
  /*
   * 标题与 `updated_at` 刚被写入，需要广播：不广播时侧栏须等到下次重新获取才更新。
   *
   * 从账本读取后再发送，不发送局部变量：`model` 是本轮使用的模型，可被单轮
   * 覆盖，而该事件描述的是会话属性，用它发送会显示一个会话并未切换到的模型。
   */
  const announced = getConversation(store, conversationId)
  if (announced) {
    yield {
      type: 'conversation.updated',
      conversationId,
      provider: announced.provider,
      model: announced.model,
      title: announced.title,
      mode: announced.mode,
      updatedAt: announced.updatedAt,
    }
  }

  // run.started 必须由此处发送：没有发送方时客户端无法取得真实 runId，中断和重试
  // 只能将步骤 id 当作 run id 使用，服务端未查到时静默不执行任何操作。
  // 协议中有类型不等于有实现。
  yield {
    type: 'run.started',
    runId: run.id,
    conversationId,
    model,
    userMessageId: userMessageId ?? null,
    startedAt: run.createdAt,
    // 正文一并发送：服务端自行发起的轮次（目标自动继续、定时触发、跟进消息发起）
    // 没有客户端的乐观插入，界面上显示的用户消息只能来自此处。
    userMessage: {
      content: prompt,
      ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
      // 与建行阶段写入 `messages.origin` 的字段取值相同：两侧口径不一致时，
      // 回执发起的轮次实时渲染为用户气泡，刷新之后才变为回执行。
      ...(options?.origin ? { origin: options.origin } : {}),
    },
  }

  // 压缩端口绑定到本会话与本 run 的高水位：压缩范围不得超过 run 创建时固定的水位，
  // 否则会将排队期间新到达的消息一并压缩，而本轮尚未读取这些消息。
  const compaction = new RuntimeCompaction({
    store,
    conversationId,
    workspaceRoot: session.opts.workspaceRoot,
    messageIdUpperBound: run.messageIdUpperBound,
    summarize: makeSummarizer({
      // 与本轮请求使用同一份规格与同一档位。
      profile: () => profile,
      effort: () => effort,
      signal: session.opts.signal,
    }),
    preserveAssistantReasoning,
  })

  // 准备阶段收到的停止由对话循环在第一次请求之前判定，与轮次中途的停止同样以 user_interrupt 结束。
  // 不要在写入 run 行之前提前返回或抛出：用户消息不落库，界面上已显示的消息刷新后消失。
  for await (const ev of makeLoop(session, target, adapter, conversationId, known, compaction).run({
    runId: run.id,
    history,
    compactPercent,
    ...(effort ? { effort } : {}),
    cacheKey: conversationId,
    ...(userMessageId ? { userMessageId } : {}),
    signal: session.opts.signal,
    ...(options?.transientResend ? { transientResend: true as const } : {}),
    // 传入上一轮的真值，使本轮开头使用同一计量基准。不传入时每个 run 的
    // 第一次请求只能报告估算值（系统性偏低），第二次起恢复为真值，
    // 读数在每轮开头出现一次下跌。
    ...(anchor ? { anchor } : {}),
    ...(compacted ? { contextEstimate: compacted } : {}),
    ...(imagesRejected ? { imagesRejected: true as const } : {}),
    ...(videosRejected ? { videosRejected: true as const } : {}),
  })) {
    if (ev.type === 'run.error') ask.failure = { message: ev.message, code: ev.code }
    if (ev.type === 'usage') session.modelUsage.set(run.id, ev.usage)
    // 本轮的生成花费附加到 usage：读数条与「运行」面板按 `runCosts` 将其与模型花费合并显示。
    // 下面记账使用的 `ev.usage` 仍只含模型调用部分。
    const spends = session.mediaSpends.get(run.id)
    const out =
      ev.type === 'run.retrying' && ev.reason
        ? { ...ev, reason: redactSecrets(ev.reason, collectSecrets(session.opts.config)) }
        : spends?.length && (ev.type === 'usage' || ev.type === 'run.finished')
          ? { ...ev, usage: { ...ev.usage, media: spends } }
          : ev
    if (ev.type === 'run.finished') await recordFinished(session, ask, ev)
    yield out
  }
}

/**
 * 每轮新建 loop：adapter 绑定具体模型，而模型可能刚被切换。
 *
 * 这与「ToolContext 每轮只创建一个」不冲突：该约束指一个 run 内部
 * 不能每个波次重建（会丢失读取文件的状态），run 之间重建是必需的。
 */
export function makeLoop(
  session: SessionState,
  target: string | ModelRef,
  adapter: LlmAdapter,
  conversationId: ConversationId,
  known: KnownContext,
  compaction?: CompactionPort,
): AgentLoop {
  // 能力段按已注册的工具名过滤：shell、任务派发、编排、外部工具都按通道注册。
  const { outputLimitNote, maxOutputTokens } = adapter.spec
  const base = buildSystemPrompt(
    new Set(session.registry.list().map((s) => s.name)),
    outputLimitNote && maxOutputTokens ? maxOutputTokens : undefined,
  )
  const providerName = resolveModel(session.opts.config, target)?.provider
  return new AgentLoop({
    adapter,
    ...(providerName ? { providerName } : {}),
    registry: session.registry,
    systemPrompt: session.opts.extraSystem
      ? `${base}\n\n## 角色\n\n${session.opts.extraSystem}`
      : base,
    ...(session.opts.followUps
      ? {
          followUps: async () => {
            const taken = session.opts.followUps?.(conversationId) ?? []
            // 按注入顺序逐条比较：同一变化只随第一条消息告知，之后的消息以更新后的值为基准。
            const facts = taken.map((f) => changedContext(session, known, f.viewing))
            return Promise.all(
              taken.map(async (f, i) => ({
                id: f.id,
                text: f.content,
                content: f.attachments?.length
                  ? await withAttachments(session.opts.workspaceRoot, f.content, f.attachments)
                  : f.content,
                ...(f.attachments?.length ? { attachments: f.attachments } : {}),
                ...(f.origin ? { origin: f.origin } : {}),
                ...(facts[i] ? { facts: facts[i] } : {}),
              })),
            )
          },
        }
      : {}),
    beforeRequest: async () => {
      await loadExtensionTools(session, adapter.spec.density, conversationId)
    },
    makeToolContext: (runId, emit) =>
      makeToolContext(session, runId, emit, target, adapter, conversationId as ConversationId),
    persist: makePersistence(session),
    ...(compaction ? { compaction } : {}),
  })
}
