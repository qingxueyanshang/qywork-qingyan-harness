/**
 * 将 steps 投影为发给模型的历史消息。
 *
 * 本文件解决的问题：`session.ts` 装配历史时若只读取 `messages` 表，该表只有
 * user 行：全项目唯一的 `appendMessage` 调用点写入的是 `role:'user'`，assistant 回合从不写入
 * 该表。实测运行库 `SELECT role, COUNT(*) FROM messages GROUP BY role` 只返回一行 `user`，同一会话的
 * `steps` 表却有 20 条 text 与 42 条 tool_action。
 *
 * 结果是跨轮次的上下文在结构上丢失：从第二轮起，模型取得的输入中只有用户消息，
 * 没有任何助手回复，导致工具重复执行、文件重复读取、同一结论反复推导。
 *
 * 采用投影而不是补写 assistant 消息行：`steps` 已是执行事实的唯一权威，再向 `messages`
 * 写入 assistant 行即形成第二本账，且该表无法容纳：`messages.role` 的 CHECK 只有 `user`/`assistant
 * `，工具调用与结果没有位置；中断与崩溃恢复路径还须一并伪造这些行。
 *
 * 前端采用相同做法（`connection.ts` 的 `reloadActiveConversation` 折叠 steps）：工具调用
 * 只存在于 steps 中，只读取 messages 时刷新一次页面
 * 就会丢失全部工具卡。该结论同样适用于模型侧。
 */

import { envelopeResult, stepStamp, toolResultContent } from '@qywork/agent'
import type { ContentBlock, WireMessage, WireToolCall } from '@qywork/ai'
import type {
  Attachment,
  ContextGroup,
  ConversationId,
  MessageId,
  ResponseReasoning,
  RunContextSegment,
  Step,
} from '@qywork/core'
import { isNoticeStep } from '@qywork/core'
import {
  listMessages,
  listRunContextSnapshots,
  listRuns,
  listSteps,
  type Store,
} from '@qywork/store'

/** 段相同的判据：分组与正文逐字相等。回放去重与压缩补回共用此判据，两处判据不一致会导致漏段或重复。 */
export function sameContextSegment(a: RunContextSegment, b: RunContextSegment): boolean {
  return a.group === b.group && a.content === b.content
}

/**
 * 每条用户消息前要回放的运行上下文段。
 *
 * 同一条用户消息多次 run 时取最后一次的快照。与上一条用户消息的快照相同的段不回放：
 * 历史中已有一份，跨 run 仍只追加，前缀缓存不受影响。每个 run 的完整快照仍保存在
 * `runs.context_snapshot`，导出与压缩补回都读取完整快照，不使用此处的结果。
 * 装配侧与压缩侧都必须调用此函数，两侧分别计算会导致边界划分错误。
 */
export function replayedContextByUser(
  store: Store,
  conversationId: ConversationId,
): Map<MessageId, RunContextSegment[]> {
  const fullByUser = new Map<MessageId, RunContextSegment[]>()
  for (const snapshot of listRunContextSnapshots(store, conversationId)) {
    if (!snapshot.userMessageId) continue
    // 重复 set 保持首次插入的位置，值取最后一次 run 的快照。
    fullByUser.set(snapshot.userMessageId, snapshot.segments)
  }
  const out = new Map<MessageId, RunContextSegment[]>()
  let previous: RunContextSegment[] = []
  for (const [userMessageId, segments] of fullByUser) {
    out.set(
      userMessageId,
      segments.filter((segment) => !previous.some((p) => sameContextSegment(p, segment))),
    )
    previous = segments
  }
  return out
}

/** 最新 run 的完整快照。压缩从此处补回被折叠的段，不重新扫描。 */
export function latestContextSnapshot(
  store: Store,
  conversationId: ConversationId,
): { userMessageId: MessageId; segments: RunContextSegment[] } | null {
  const latest = [...listRunContextSnapshots(store, conversationId)]
    .reverse()
    .find((snapshot) => snapshot.userMessageId !== null)
  return latest?.userMessageId
    ? { userMessageId: latest.userMessageId, segments: latest.segments }
    : null
}

/** 投影产物统一携带的分组标记。工具结果按执行记录与正文的划分在计量层完成，不在此处拆分。 */
const GROUP: ContextGroup = 'executionRecords'

/** run 内注入的用户消息的分组。其内容为用户输入，与历史消息计入同一本账。 */
const USER_GROUP: ContextGroup = 'historyMessages'

export interface ProjectOptions {
  /**
   * 这批 steps 所属的用户消息 id。
   *
   * 压缩投影按 `_messageId` 划分边界（`compaction.ts`）。缺少该字段时，被压缩的那段
   * 历史中的执行记录会被无条件保留：压缩虽已生效，占用上下文最多的
   * 执行记录却一条未减少。
   */
  messageId?: MessageId | null
  /** 厂商要求纯文本 assistant 轮也完整回放思考时开启；默认保持原有投影。 */
  preserveAssistantReasoning?: boolean
}

/**
 * 已写入数据库的 payload 有三种形状，投影必须都能处理。
 *
 * 1. **正常终态**：`{kind:'tool_result', args, outcome, action}`（`session.ts` 写）。
 * 2. **恢复/中断收尾**：`{kind:'tool_result', outcome}`；`settleRunningSteps`
 *    整体替换 payload，`args` 与 `action` 被清除。
 * 3. **存量行**：缺 `action`。
 *
 * 形状 2 无法重建真实参数，只能给出 `{}`。这不构成编造：该行的 status 必然是
 * failure，模型看到的是「调用失败、参数无法还原」，而不是一条
 * 「参数为空却报告成功」的调用记录。
 */
interface ToolPayload {
  args?: Record<string, unknown>
  outcome?: {
    status?: string
    executed?: boolean
    message?: string
    data?: unknown
    resources?: { resourceId?: string }[]
  }
}

function toolPayloadOf(step: Step): ToolPayload {
  const p = step.payload as ToolPayload | null
  return p && typeof p === 'object' ? p : {}
}

/** 从磁盘读取的 `data` 类型只能是 unknown；不是对象时视为不存在。 */
function dataOf(outcome: { data?: unknown }): Record<string, unknown> | undefined {
  const d = outcome.data
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : undefined
}

/**
 * 一次工具结果的模型可见正文。
 *
 * 必须与实时 transcript 逐字一致（`agent/loop/tool-wave.ts` 中 push 的内容）。
 * 两处不一致时，同一次调用在本轮与下一轮的内容不同，模型会将其视为两次调用，
 * 且这种不一致不会产生任何报错。
 */
function toolContent(step: Step): string | ContentBlock[] {
  const payload = toolPayloadOf(step)
  const outcome = payload.outcome ?? {}
  const resources = (outcome.resources ?? []).map((r) => r.resourceId).filter(Boolean)
  const envelope = JSON.stringify({
    call_id: step.toolCallId ?? '',
    tool: step.toolName ?? 'unknown',
    status: outcome.status ?? (step.status === 'success' ? 'success' : 'failure'),
    executed: outcome.executed ?? false,
    summary: outcome.message ?? '',
    ...(resources.length ? { resources } : {}),
    // 图像字节不进入信封，只进入图像块：与实时 transcript 使用同一判据。
    ...(envelopeResult(dataOf(outcome)) ? { result: envelopeResult(dataOf(outcome)) } : {}),
  })
  // 与实时 transcript 共用同一个构造函数：两处各自实现必然产生偏差，且偏差不会产生任何报错。
  // `data` 是从磁盘读取的 JSON，类型只能是 unknown；不是对象时视为不存在，
  // `toolResultContent` 会自行回退为纯字符串。
  return toolResultContent(envelope, dataOf(outcome))
}

/**
 * 可折叠单元：同一执行波次的 assistant 消息及其全部 tool 结果。
 *
 * 压缩按单元划分边界，共用一个戳的消息一同保留或一同压缩，因此 tool_call 与其 tool_result
 * 不会被分开。这是结构上的保证，而不是事后修补。
 */
export interface StepUnit {
  /** `stepStamp(runId, 单元中最后一个 step 的 seq)`。 */
  stamp: string
  messages: WireMessage[]
  /** 该单元中的 tool_action step。纯文本单元为空。 */
  steps: Step[]
  /**
   * 该单元是 run 内注入的用户消息时，指向对应的 step。
   *
   * 两个消费方需要该字段，且两处都不应依赖按消息角色推测：`buildHistory` 用它取得附件，
   * 压缩用它的 id 组成取回地址（`<runId>:<stepId>`）。
   */
  userStep?: Step
  /**
   * 该单元中助手正文的第一条 text step。压缩用它组成助手正文的取回地址（`<runId>:<stepId>`），
   * `HistoryPort.message` 据此读取同一次生成的正文。没有助手正文时不设置。
   *
   * 不要用所属用户消息的 id 代替：该地址读取的是用户消息原文，而不是助手的回复。
   */
  textStep?: Step
}

/**
 * 展平一个 run 的 steps，按可折叠单元分组。
 *
 * 顺序即 `seq` 顺序（`listSteps` 已按其排序）。同一 `providerBatchId` 的
 * tool_action 属于同一个 assistant 轮，合并为一条带 `toolCalls` 的消息，
 * 随后每个调用对应一条 `role:'tool'`；它们与被合并的前置文本共用一个戳。
 *
 * `providerBatchId` 是产出该 step 的请求的 id，因此相邻两条归属不同即为
 * 生成边界，此前累积的正文在该处合并为一条独立的 assistant 消息。断流后携带上下文
 * 续发的部分（实时 transcript 中为 `[A]`、`[B+工具]` 两条）依据此规则还原为原有结构。
 *
 * 戳必须与 `agent/loop/run-state.ts` 中实时 transcript 的戳逐字相同：同一单元在
 * 本 run 运行期间与跨 run 投影回历史后的定位不一致时，压缩会按两条不同的
 * 边界切分同一段内容。
 */
export function stepsToUnits(steps: Step[], opts: ProjectOptions = {}): StepUnit[] {
  const units: StepUnit[] = []
  const mark = <T extends WireMessage>(m: T, stamp: string): T =>
    ({ ...m, ...(opts.messageId ? { _messageId: opts.messageId } : {}), _step: stamp }) as T

  let pendingText = ''
  let pendingStamp = ''
  let pendingTextStep: Step | undefined
  /**
   * 本轮的思考正文，由本轮的工具批次取用。
   *
   * 默认纯文本轮不携带思考正文；只有模型 spec 明确要求完整历史时，实时 transcript 与投影
   * 同时开启 `preserveAssistantReasoning`。两侧结构必须一致，否则下一轮缓存前缀失效。
   */
  let pendingReasoning = ''
  let pendingResponseReasoning: ResponseReasoning | undefined
  const flushText = () => {
    const reasoning = opts.preserveAssistantReasoning ? pendingReasoning : ''
    const responseReasoning = pendingResponseReasoning
    const textStep = pendingTextStep
    pendingReasoning = ''
    pendingResponseReasoning = undefined
    pendingTextStep = undefined
    if (!pendingText.trim() && !reasoning && !responseReasoning) {
      pendingText = ''
      return
    }
    units.push({
      ...(textStep ? { textStep } : {}),
      stamp: pendingStamp,
      messages: [
        mark(
          {
            role: 'assistant',
            content: pendingText,
            ...(reasoning ? { reasoningContent: reasoning } : {}),
            ...(responseReasoning ? { responseReasoning } : {}),
            _group: GROUP,
          },
          pendingStamp,
        ),
      ],
      steps: [],
    })
    pendingText = ''
  }

  /**
   * 上一条生成 step（text / thinking / tool_action）的 `providerBatchId`。
   *
   * 判据只接受相邻两条均非空且不同：null 表示归属未记录，与任何值相邻都不切分。
   * 放宽为与上一个非空值比较时，旧行的 text（null）会与其后的那批旧工具调用
   * 分开，而两者在实时 transcript 中属于同一条 assistant 消息。
   *
   * user 与 compaction step 不带归属，也不参与相邻判定：它们位于两次生成之间时，
   * 生成边界仍然有效。
   */
  let previousBatchId: string | null = null

  let i = 0
  while (i < steps.length) {
    const step = steps[i]!
    if (step.kind === 'text' || step.kind === 'thinking' || step.kind === 'tool_action') {
      const batch = step.providerBatchId
      if (previousBatchId && batch && batch !== previousBatchId) flushText()
      previousBatchId = batch
    }
    // 密文快照在响应收尾落盘；其后的文本或思考属于下一次生成，不能覆盖上一轮。
    if (pendingResponseReasoning && (step.kind === 'text' || step.kind === 'thinking')) flushText()
    if (step.kind === 'thinking') {
      /*
       * 失败的思考不进入模型视图。
       *
       * 轮内自动重发时，失败请求与重发请求的思考 step 位于同一个 run 中且相邻
       * （`buildHistory` 逐 run 投影，跨 run 不会混入，同一 run 内会）。不排除时两段
       * 无关的生成会被拼接为一条 `reasoningContent` 回传，与实时 transcript 结构不同，违反
       * 「与实时 transcript 逐字一致」的约束，缓存前缀也从该处失效。
       */
      if (step.status !== 'failure') {
        pendingReasoning += step.content ?? ''
        if (step.payload?.kind === 'response_reasoning')
          pendingResponseReasoning = step.payload.reasoning
      }
      pendingStamp = stepStamp(step.runId, step.seq)
      i += 1
      continue
    }
    if (step.kind === 'text') {
      pendingText += step.content ?? ''
      pendingTextStep ??= step
      pendingStamp = stepStamp(step.runId, step.seq)
      i += 1
      continue
    }
    if (step.kind === 'user') {
      /*
       * run 内注入的用户消息在原位置产出一条 `role:'user'`。
       *
       * 先调用 `flushText()`：该消息位于此 step 之前的文本之后，顺序由 seq 决定，
       * 与实时 transcript 逐条对应。
       *
       * `_group` 是 `historyMessages` 而不是 `GROUP`：其内容为用户输入，不是执行记录。
       * 实时 transcript（`agent/loop/index.ts` 的注入点）必须使用相同的值：两侧口径不一致比两侧同样记错更有害。
       *
       * `pendingReasoning` 在此处必然为空：注入发生在 step 循环顶部，
       * 而思考与其工具批次位于同一步之内，中间不会插入其他 step。
       */
      flushText()
      const stamp = stepStamp(step.runId, step.seq)
      // 执行事实与实时 transcript 中 `RunState.notify` 的分组相同：其内容不是用户输入。
      const group = isNoticeStep(step) ? 'workspaceState' : USER_GROUP
      units.push({
        stamp,
        messages: [mark({ role: 'user', content: step.content ?? '', _group: group }, stamp)],
        steps: [],
        userStep: step,
      })
      i += 1
      continue
    }
    // 压缩 step 是给用户看的时间线标记，不属于模型可见的对话。
    if (step.kind !== 'tool_action') {
      i += 1
      continue
    }

    // 收集连续的同批次调用。迁移 37 已为旧行写入唯一的 batch id；此处不做推测。
    const batchId = step.providerBatchId
    if (!batchId) throw new Error(`工具步骤 ${step.id} 缺少 providerBatchId`)
    const batch: Step[] = []
    while (i < steps.length) {
      const s = steps[i]!
      if (s.kind !== 'tool_action' || s.providerBatchId !== batchId) break
      batch.push(s)
      i += 1
    }

    // 整批中只要仍有未进入终态的条目即整批跳过：provider 协议要求每个 tool call
    // 必须有配对结果，缺一条即返回 400。
    //
    // 这是针对崩溃窗口的窄守卫，不是常规路径：`settleRunningSteps` 在 run 收尾
    // 与进程启动时都会将 running 行写为终态。它失效时，此处的跳过会一并
    // 丢弃同批次已经成功的结果，这是需要防止的退化。
    if (batch.some((s) => s.status === 'running')) continue

    const ordered = [...batch].sort((a, b) => (a.callIndex ?? 0) - (b.callIndex ?? 0))
    const calls: WireToolCall[] = ordered.map((s) => ({
      id: s.toolCallId ?? '',
      name: s.toolName ?? 'unknown',
      arguments: toolPayloadOf(s).args ?? {},
    }))

    // 思考正文只来自独立的 thinking step；迁移 37 已将旧工具行中的思考正文迁移到该类 step。
    const reasoning = pendingReasoning
    const responseReasoning = pendingResponseReasoning
    const textStep = pendingText.trim() ? pendingTextStep : undefined
    pendingReasoning = ''
    pendingResponseReasoning = undefined
    pendingTextStep = undefined
    // 戳取批次中最大的 seq：实时 transcript 一侧取一个波次执行完毕时的高水位，两者是同一个数。
    const stamp = stepStamp(batch[0]!.runId, Math.max(...batch.map((s) => s.seq)))

    const messages: WireMessage[] = [
      mark(
        {
          role: 'assistant',
          content: pendingText,
          toolCalls: calls,
          ...(reasoning ? { reasoningContent: reasoning } : {}),
          ...(responseReasoning ? { responseReasoning } : {}),
          _group: GROUP,
          // 图片裁剪据此识别最近待继续的批次，实时 transcript（`agent/loop/turn-end.ts`）写入相同的值。
          _batch: batchId,
        },
        stamp,
      ),
    ]
    pendingText = ''

    for (const s of ordered) {
      messages.push(
        mark(
          {
            role: 'tool',
            toolCallId: s.toolCallId ?? '',
            content: toolContent(s),
            _group: GROUP,
            _batch: batchId,
          },
          stamp,
        ),
      )
    }
    units.push({ stamp, messages, steps: ordered, ...(textStep ? { textStep } : {}) })
  }

  flushText()
  return units
}

/** 展平一个 run 的 steps。单元边界见 `stepsToUnits`。 */
export function stepsToWireMessages(steps: Step[], opts: ProjectOptions = {}): WireMessage[] {
  return stepsToUnits(steps, opts).flatMap((u) => u.messages)
}

/** 注入消息携带的附件。不是注入单元或未携带附件时为空数组。 */
export function attachmentsOf(step: Step | undefined): Attachment[] {
  if (step?.kind !== 'user') return []
  return (step.payload as { attachments?: Attachment[] } | null)?.attachments ?? []
}

/**
 * 装配一次请求的完整历史：消息与由 steps 投影出的执行回合。
 *
 * 独立为函数是为了能够单独测试：内联在 `Session.ask()` 中时，该路径须有
 * 真实 provider 才能执行成功，因此第二轮的输入内容无法被任何测试覆盖。
 *
 * `attachments` 由调用方注入：读取附件正文需要访问磁盘，而本函数不应依赖工作区位置。
 */
export async function buildHistory(
  store: Store,
  conversationId: ConversationId,
  upperBound: MessageId | null,
  attachments: (content: string, list: unknown[]) => Promise<string | ContentBlock[]>,
  opts: Pick<ProjectOptions, 'preserveAssistantReasoning'> = {},
): Promise<WireMessage[]> {
  const byUser = new Map<string, ReturnType<typeof listRuns>>()
  for (const r of listRuns(store, conversationId)) {
    if (!r.userMessageId) continue
    const list = byUser.get(r.userMessageId) ?? []
    list.push(r)
    byUser.set(r.userMessageId, list)
  }

  const contextByUser = replayedContextByUser(store, conversationId)

  const out: WireMessage[] = []
  for (const m of listMessages(store, conversationId, upperBound)) {
    for (const segment of contextByUser.get(m.id) ?? []) {
      out.push({
        role: 'context',
        content: segment.content,
        _group: segment.group,
        _messageId: m.id,
      })
    }
    out.push({
      role: m.role,
      content: m.attachments.length ? await attachments(m.content, m.attachments) : m.content,
      _group: 'historyMessages',
      _messageId: m.id,
    })
    for (const r of byUser.get(m.id) ?? []) {
      /*
       * 逐单元处理而不是直接展平：注入消息的附件须在此处解析（读取磁盘），
       * 而 `stepsToUnits` 是同步函数，压缩一侧也共用它。
       */
      for (const u of stepsToUnits(listSteps(store, r.id), { messageId: m.id, ...opts })) {
        const files = attachmentsOf(u.userStep)
        for (const msg of u.messages) {
          out.push(
            files.length
              ? {
                  ...msg,
                  content: await attachments(
                    typeof msg.content === 'string' ? msg.content : '',
                    files,
                  ),
                }
              : msg,
          )
        }
      }
    }
  }
  return out
}
