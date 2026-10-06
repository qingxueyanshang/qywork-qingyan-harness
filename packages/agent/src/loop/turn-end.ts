/**
 * 一轮响应接收完毕之后的处理：请求账写入终态、本轮输出追加到 transcript、锚点前移，以及没有工具
 * 可执行时的停机判定。
 */

import type { AgentEvent } from '@qywork/core'
import { envelopeHeadTokens, log } from '@qywork/core'
import { cycleFingerprint } from '../progress.ts'
import { envelopeHashOf } from './request.ts'
import type { RunState, TurnState } from './run-state.ts'

const TRUNCATED_NOTICE =
  '上一次响应的输出达到单次上限，在中途被截断，本轮未结束。从中断处继续，不重述已完成的部分，剩余工作拆成较小的步骤。'

/**
 * 请求账写入终态，本轮输出写回 transcript，锚点按本轮真值前移。
 *
 * 返回 false 表示用户已中止，`run.stopReason` 已置为 `user_interrupt`。
 */
export function settleResponse(run: RunState, turn: TurnState): boolean {
  const { adapter, input, persist, transcript } = run
  run.turnIndex++

  // 流结束后为该行写入终态。中途被用户中断时记为 `uncertain`：
  // 无法判断 provider 是否完整接收，这正是 `uncertain` 的语义。
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
   * `max_tokens` 终止时，本批工具调用一律无效。
   *
   * 输出被截断意味着最后一条调用的参数可能只有半个 JSON，而截断处恰好是
   * 合法 JSON 时不会产生 `argumentsError`。按其执行即使用不完整的参数操作，
   * 且模型没有机会补全。整批在此丢弃，正文与思考照常记录，
   * 随后由 `concludeWithoutTools` 续写。
   */
  if (turn.providerStop === 'max_tokens') turn.calls.length = 0

  // 将本轮 assistant 输出写回 transcript：模型下一轮必须看到自己刚输出的内容与
  // 调用过的工具，否则会重复调用。
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
      // 只有带工具调用的消息作为图片批次的锚；投影侧（`runtime/transcript.ts`）取相同的值。
      ...(calls.length ? { _batch: turn.requestId } : {}),
    })
    run.stampUnit(turn.unitStart)
  }

  /*
   * 锚点前移。只有实际取得 usage 时才移动：0 或缺失不是可用的用量回执，
   * 此时锚点保持不变、增量继续累加，显示值不会因一次漏报而骤降。
   *
   * `transcriptIndex` 取追加 assistant 消息之后的长度：本轮的输出
   * 已计入 `outputTokens`，再估算一次即重复计数。此后追加的
   * 工具结果才是锚点未覆盖的增量。
   */
  const turnUsage = turn.turnUsage
  if (turnUsage) {
    const total =
      turnUsage.inputTokens +
      (turnUsage.cachedTokens ?? 0) +
      (turnUsage.cacheWriteTokens ?? 0) +
      turnUsage.outputTokens
    /*
     * 不要排除带视频的请求：本地估算对视频记 0，视频的占用只体现在真值中。保留在请求中的视频
     * 此后每次都随请求发出，排除后读数与压缩触发始终无法计入它。
     */
    if (total > 0)
      run.anchor = {
        tokens: total,
        uncovered: 0,
        uncoveredVideos: 0,
        transcriptIndex: transcript.length,
        model: turn.req.model,
        headTokens: envelopeHeadTokens(turn.breakdown),
        envelope: envelopeHashOf(turn.req),
      }
    /*
     * 静默溢出。
     *
     * 部分 provider 超出窗口时不报错，而是静默丢弃超出部分并照常返回
     * （实测 deepseek-v4-flash：发出约 200 万 token，回报收到 1,000,086，
     * 而窗口正好为 1,000,000，全程没有任何错误）。这类 provider 无法通过错误分类
     * 触发恢复，而会话已在无提示地丢失历史，比超出窗口时报错更严重：
     * 后者至少有终态。
     *
     * 判据由两个真值推出：provider 回报的输入量达到模型的窗口上限。
     * 无需可调阈值，达到窗口即可确定。
     *
     * 处理方式是重新允许压缩，而不是作废本轮：回答已经取得，作废没有意义；
     * 将进展判据清零后，下一次发送前的检查会重新折叠一次。
     */
    if (total >= adapter.spec.contextWindow) {
      log.warn('agent', 'provider 静默截断：回报的输入量达到窗口上限', {
        input: total,
        contextWindow: adapter.spec.contextWindow,
      })
      run.compactedAt = -1
    } else {
      // 请求已能容纳。此后再次超出窗口属于新情况，溢出恢复重新可用。
      run.overflowRecovered = false
    }
  }
  return true
}

/**
 * 模型拒答，或本轮没有可执行的工具调用时：决定停机还是开始新的一轮。
 *
 * 返回 `stop` 时 `run.stopReason`（及 `stopDetail`）已经设置。
 */
export async function* concludeWithoutTools(
  run: RunState,
  turn: TurnState,
): AsyncGenerator<AgentEvent, 'stop' | 'continue', unknown> {
  const { input, ctx } = run

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

  // `pause_turn` 不表示回答完毕，而表示服务端中断了本轮，需要原样重发以继续。
  // 视为结束时，用户得到不完整的回答，而 run 显示成功完成，
  // 既不报错也不续写。本轮 assistant 输出已在收尾时写入 transcript，
  // 直接进入下一轮即满足官方要求的原样重发。执行循环没有总轮数上限，
  // 因此反复返回同一段暂停内容必须经由现有的无进展判据停止，不能依赖固定步数。
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
      run.stopDetail = 'provider 连续三次在同一段内容处暂停'
      return 'stop'
    }
    return 'continue'
  }

  /*
   * provider 声明要调用工具，但未解析出任何调用：这是故障，不是完成。
   *
   * 两种情况外观相同但性质相反：`end_turn` 表示模型回答完毕，
   * `tool_use` 表示模型要调用工具而调用在解析过程中丢失（流中缺少名称分片、
   * 中转站将非流式响应强制转为 SSE）。记为 `completed` 会给出错误的确定结论：
   * 界面显示已完成、零步骤，账本中无法查明原因，这是「声称已执行却未执行」
   * 中最难排查的情形。
   *
   * 判据使用 provider 的归一化终止原因，不使用原文：各厂商原文用词不同，
   * 按原文判断会使每增加一个端点就增加一条分支。
   */
  if (turn.providerStop === 'tool_use') {
    run.stopReason = 'provider_error'
    yield {
      type: 'run.error',
      runId: input.runId,
      code: 'provider_unavailable',
      message: '模型声明要调用工具，但返回中没有可解析的调用',
    }
    return 'stop'
  }

  /*
   * `max_tokens` 表示本次响应达到单次输出上限，不表示任务结束，因此续写，且优先于待办判据。
   * 截断的正文与签名思考已在收尾时写入 transcript，下一次请求原样带上，模型从中断处继续。
   * 连续三次截断由无进展判据停止。指纹不要包含响应内容：每次截断的内容都不同，包含后无法判定重复。
   */
  if (turn.providerStop === 'max_tokens') {
    run.progress.push({
      cycle: cycleFingerprint('output_truncated', {}, { status: 'truncated' }),
      noProgress: true,
    })
    if (run.stalled()) {
      run.stopReason = 'output_truncated'
      run.stopDetail = '输出连续三次达到单次上限'
      return 'stop'
    }
    run.notify(TRUNCATED_NOTICE)
    return 'continue'
  }

  // 按本轮接续关系读清单：用户新指令需重新提交，父任务回执沿用已有清单。
  const unfinished =
    ctx.todos?.read(input.runId)?.filter((todo) => todo.status !== 'completed') ?? []
  // 已派发的子 agent 仍在运行时，清单未完成是因为它们在执行：本轮结束是正确的，
  // 回执到达后会开始新的一轮。强制模型继续只会得到一段无实际内容的回答。
  const delegated = (ctx.delegate?.inflight().length ?? 0) > 0
  if (unfinished.length && !delegated) {
    if (!unfinished.some((todo) => todo.status === 'in_progress')) {
      run.stopReason = 'no_progress'
      run.stopDetail = '待办尚未完成，当前没有进行中的项；具体原因见本轮回复'
      return 'stop'
    }
    const snapshot = unfinished.map((todo) => [todo.id, todo.content, todo.status])
    run.progress.push({
      cycle: cycleFingerprint('assistant_end_turn', {}, { status: 'unfinished', data: snapshot }),
      noProgress: true,
    })
    if (run.stalled()) {
      run.stopReason = 'no_progress'
      run.stopDetail = '待办未完成时连续三次仅回复而未执行操作'
      return 'stop'
    }
    run.notify(
      `本轮待办仍在进行中：${unfinished.map((todo) => todo.content).join('；')}。继续执行；确实受阻时将进行中的项改回 pending，保留未完成项并在回复中说明原因，不重复观察同一阻塞。`,
    )
    return 'continue'
  }

  run.stopReason = 'completed'
  return 'stop'
}
