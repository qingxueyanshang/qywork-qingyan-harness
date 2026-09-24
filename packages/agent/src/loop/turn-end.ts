/**
 * 一轮响应收完之后：请求账落终态、本轮输出推进 transcript、锚点前移，以及没有工具可执行时的
 * 停机判定。
 */

import type { AgentEvent } from '@qywork/core'
import { envelopeHeadTokens, log } from '@qywork/core'
import { cycleFingerprint } from '../progress.ts'
import { envelopeHashOf } from './request.ts'
import type { RunState, TurnState } from './run-state.ts'

/**
 * 请求账落终态，本轮输出写回 transcript，锚点按本轮真值前移。
 *
 * 返回 false 表示用户已中止，`run.stopReason` 已置为 `user_interrupt`。
 */
export function settleResponse(run: RunState, turn: TurnState): boolean {
  const { adapter, input, persist, transcript } = run
  run.turnIndex++

  // 流跑完了就给这一行落终态。中途被用户打断算 `uncertain`——
  // provider 是否收全无从判断，这正是 `uncertain` 的语义。
  persist.settleRequest(
    turn.requestId,
    input.signal.aborted ? 'uncertain' : 'received',
    turn.turnUsage,
    null,
    turn.rawStop,
  )

  if (input.signal.aborted) {
    run.stopReason = 'user_interrupt'
    return false
  }

  /*
   * **`max_tokens` 之下这一批工具调用不作数。**
   *
   * 输出被截断意味着最后一条调用的参数可能停在半个 JSON 上，而截断处恰好是
   * 合法 JSON 时连 `argumentsError` 都没有。按它执行就是拿残缺参数动手，
   * 且模型没有机会补完。整批在这里丢掉，正文与思考照常落账，
   * `concludeWithoutTools` 随即把终态定成 `output_truncated`。
   */
  if (turn.providerStop === 'max_tokens') turn.calls.length = 0

  // 把本轮 assistant 输出写回 transcript：模型下一轮必须看到自己刚说过什么、
  // 调了哪些工具，否则会重复调用。
  turn.unitStart = transcript.length
  const preserveAssistantReasoning = adapter.spec.chatReasoningProtocol !== 'standard'
  const { calls } = turn
  if (
    turn.assistantText ||
    calls.length ||
    turn.responseReasoning ||
    (turn.thinkingText && preserveAssistantReasoning)
  ) {
    transcript.push({
      role: 'assistant',
      content: turn.assistantText,
      ...(calls.length ? { toolCalls: calls } : {}),
      ...(turn.responseReasoning ? { responseReasoning: turn.responseReasoning } : {}),
      // 标准路径只回放工具轮；Qwen3.8 / GLM-5.3 的官方协议要求所有轮次完整回放。
      ...(turn.thinkingText && (calls.length || preserveAssistantReasoning)
        ? { reasoningContent: turn.thinkingText }
        : {}),
      _group: 'executionRecords',
      // 带工具调用的那一条才是图片批次的锚；投影侧（`runtime/transcript.ts`）同值。
      ...(calls.length ? { _batch: turn.requestId } : {}),
    })
    run.stampUnit(turn.unitStart)
  }

  /*
   * 锚点前移。**只有真的拿到 usage 才动**——0 或缺失不是可用回执，
   * 那种时候锚点原地不动、增量继续长，显示值不会因为一次漏报而跳水。
   *
   * `transcriptIndex` 取**推完 assistant 消息之后**的长度：这一轮的输出
   * 已经算在 `outputTokens` 里，再估一遍就是重复计数。其后推进来的
   * 工具结果才是锚点没覆盖到的增量。
   */
  const turnUsage = turn.turnUsage
  if (turnUsage) {
    const total =
      turnUsage.inputTokens +
      (turnUsage.cachedTokens ?? 0) +
      (turnUsage.cacheWriteTokens ?? 0) +
      turnUsage.outputTokens
    if (total > 0)
      run.anchor = {
        tokens: total,
        uncovered: 0,
        transcriptIndex: transcript.length,
        model: turn.req.model,
        headTokens: envelopeHeadTokens(turn.breakdown),
        envelope: envelopeHashOf(turn.req),
      }
    /*
     * ── 静默溢出 ──
     *
     * 有的 provider 撞窗**不报错**，静默丢弃超出部分并照常返回
     * （实测 deepseek-v4-flash：发出约 200 万 token，自报收到 1,000,086，
     * 而窗口正好 1,000,000，全程没有任何错误）。这种 provider 上靠错误分类
     * 拿不到恢复凭证，而会话已经在无声地丢历史——比撞窗报错更坏，
     * 那至少还有个终态。
     *
     * 判据从**两个真值**反推：provider 自报的输入量顶到了模型自带的窗口。
     * 没有阈值可调，也不需要——顶到窗口就是顶到了。
     *
     * 处理是**放开压缩闸**而不是作废这一轮：回答已经拿到了，作废没有意义；
     * 把进展判据清零，下一次发送前检查就会重新折一次。
     */
    if (total >= adapter.spec.contextWindow) {
      log.warn('agent', 'provider 静默截断：自报输入顶到窗口', {
        input: total,
        contextWindow: adapter.spec.contextWindow,
      })
      run.compactedAt = -1
    } else {
      // 装得下了。此后再撞窗是新情况，恢复通道重新可用。
      run.overflowRecovered = false
    }
  }
  return true
}

/**
 * 拒答，或这一轮没有可执行的工具调用：决定停机还是再起一轮。
 *
 * 返回 `stop` 时 `run.stopReason`（及 `stopDetail`）已经定好。
 */
export async function* concludeWithoutTools(
  run: RunState,
  turn: TurnState,
): AsyncGenerator<AgentEvent, 'stop' | 'continue', unknown> {
  const { input, transcript, ctx } = run

  if (turn.refusalNote) {
    run.stopReason = 'provider_error'
    yield {
      type: 'run.error',
      runId: input.runId,
      code: 'provider_unavailable',
      message: turn.refusalNote,
    }
    return 'stop'
  }

  // `pause_turn` 不是「说完了」，是「服务端把这一轮切开了，原样再发一次继续」。
  // 当成结束的表现是：用户拿到一个**半截**回答，而 run 显示成功完成、
  // 既不报错也不续写。本轮 assistant 输出已经在收尾时进了 transcript，
  // 直接进下一轮就是官方要的那个「原样重发」。执行循环没有总回合上限，
  // 因此反复返回同一段暂停内容必须走现有的空转判据，不能再靠固定步数兜底。
  if (turn.providerStop === 'pause_turn') {
    run.progress.push({
      cycle: cycleFingerprint(
        'provider_pause_turn',
        {},
        {
          status: 'paused',
          data: { text: turn.assistantText, reasoning: turn.thinkingText },
        },
      ),
      noProgress: true,
    })
    if (run.stalled()) {
      run.stopReason = 'no_progress'
      run.stopDetail = 'provider 连续三次暂停在同一段内容'
      return 'stop'
    }
    return 'continue'
  }

  /*
   * **provider 声明要调工具，而一条都没解析出来 = 故障，不是完成。**
   *
   * 这两种情况长得一样但性质相反：`end_turn` 是模型说完了，
   * `tool_use` 是它要调工具而调用在解析链上丢了（流里少了名字分片、
   * 中转站把非流式响应硬转成 SSE）。记成 `completed` 是编出来的确定性——
   * 界面上是「跑完了、零步骤」，账本里查不出原因，而这正是
   * 「说做了却没做」最难查的那种形状。
   *
   * 判据用 provider 的归一化终态，不用它的原话：原话每家一套词，
   * 拿它做判断等于每多一个端点就多一条分支。
   */
  if (turn.providerStop === 'tool_use') {
    run.stopReason = 'provider_error'
    yield {
      type: 'run.error',
      runId: input.runId,
      code: 'provider_unavailable',
      message: '模型声明要调用工具，但返回里没有可解析的调用',
    }
    return 'stop'
  }

  // provider 报 max_tokens 是**输出**被截断，模型话没说完。它优先于待办判据：
  // 继续同一任务也接不回被截断的半句话，必须先把真实终态交给用户。
  if (turn.providerStop === 'max_tokens') {
    run.stopReason = 'output_truncated'
    return 'stop'
  }

  /*
   * `end_turn` 只证明**这一条响应**结束，不证明整个任务完成。
   * `write_todos` 已经是任务清单的唯一账本；这里读同一份只读端口，
   * 不另造完成状态。清单没有未完成项时保留原语义。
   *
   * 续起时把「清单还有几项没完成、这一轮没有结束」当事实交给下一次请求：
   * 不说的话模型只看到自己刚说过的话。同一份未完成清单下连续三次只说不做，
   * 则复用已有的无进展监督器停下来，免得把一次误完成改成无限空转。
   */
  const unfinished = ctx.todos?.read()?.filter((todo) => todo.status !== 'completed') ?? []
  // 派出去的子 agent 还在跑时，清单没完成是它们在做：这一轮结束是对的，
  // 回执到了会再起一轮。逼模型继续只会得到一段没事找事的话。
  const delegated = (ctx.delegate?.inflight().length ?? 0) > 0
  if (unfinished.length && !delegated) {
    const snapshot = unfinished.map((todo) => [todo.id, todo.content, todo.status])
    run.progress.push({
      cycle: cycleFingerprint('assistant_end_turn', {}, { status: 'unfinished', data: snapshot }),
      noProgress: true,
    })
    if (run.stalled()) {
      run.stopReason = 'no_progress'
      run.stopDetail = '待办未完成时连续三次只回话不动手'
      return 'stop'
    }
    run.notices.push(
      `待办清单尚有 ${unfinished.length} 项未完成：${unfinished.map((todo) => todo.content).join('；')}。本轮未结束。`,
    )
    /*
     * 续起之后，这一条与模型接下来那条 assistant 之间没有 user 消息（提示只进请求、
     * 不落 transcript）。DeepSeek 思考模式要求同一轮里每一条 assistant 都带回
     * reasoning_content，只挂工具轮的话，下一次请求就是 400。
     */
    const last = transcript[transcript.length - 1]
    if (last?.role === 'assistant' && turn.thinkingText && !last.reasoningContent) {
      last.reasoningContent = turn.thinkingText
    }
    return 'continue'
  }

  run.stopReason = 'completed'
  return 'stop'
}
