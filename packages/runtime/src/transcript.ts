/**
 * 把 steps 投影成发给模型的历史消息。
 *
 * **这个文件补的是什么洞。** 在它之前，`session.ts` 装配历史只读 `messages` 表——而那张表**只有
 * user 行**：全项目唯一的 `appendMessage` 调用点写的就是 `role:'user'`，assistant 回合从来没有进
 * 过。实测运行库 `SELECT role, COUNT(*) FROM messages GROUP BY role` 只回一行 `user`，同一会话的
 * `steps` 表却有 20 条 text + 42 条 tool_action。
 *
 * 后果是**结构性失忆**：第二轮起模型拿到的输入字面上就是「用户说了三次话，
 * 助手一次都没回」。工具重复执行、文件重读、同一个结论反复推导。
 *
 * **为什么是投影，不是补写 assistant 消息行。** `steps` 已经是执行事实的唯一权威。再往 `messages`
 * 写一份 assistant 行就是第二本账，而且装不下——`messages.role` 的 CHECK 只有 `user`/`assistant
 * `，工具调用与结果没有位置；中断与崩溃恢复路径还得跟着伪造那些行。
 *
 * 前端早就是这么干的（`connection.ts` 的 `reloadActiveConversation` 折 steps），
 * 注释原话：「工具调用只存在于 steps 里，单拉 messages 意味着刷新一次页面
 * 就丢掉全部工具卡」。同一句话对模型侧一字不差地成立。
 */

import { envelopeResult, stepStamp, toolResultContent } from '@qywork/agent'
import type { ContentBlock, WireMessage, WireToolCall } from '@qywork/ai'
import type { Attachment, ContextGroup, ConversationId, MessageId, Step } from '@qywork/core'
import {
  listMessages,
  listRunContextSnapshots,
  listRuns,
  listSteps,
  type Store,
} from '@qywork/store'

/** 投影产物统一带的分组标记。工具结果的执行记录/正文二分在计量层做，不在这里拆。 */
const GROUP: ContextGroup = 'executionRecords'

/** run 内注入的用户消息的分组。它是用户打的字，与历史消息同一本账。 */
const USER_GROUP: ContextGroup = 'historyMessages'

export interface ProjectOptions {
  /**
   * 这批 steps 归属的用户消息 id。
   *
   * 压缩投影按 `_messageId` 划边界（`compaction.ts`）。不带的话，被压掉那一段
   * 历史里的执行记录会被无条件保留下来——压缩生效了，真正吃上下文的
   * 那部分却一条没少。
   */
  messageId?: MessageId | null
  /** 厂商要求纯文本 assistant 轮也完整回放思考时开启；默认保持原有投影。 */
  preserveAssistantReasoning?: boolean
}

/**
 * 落库 payload 的三种形状，投影必须都能吃。
 *
 * 1. **正常终态**：`{kind:'tool_result', args, outcome, action}`（`session.ts` 写）。
 * 2. **恢复/中断收尾**：`{kind:'tool_result', outcome}`——`settleRunningSteps`
 *    整体替换 payload，`args` 与 `action` 被抹掉。
 * 3. **存量行**：缺 `action`。
 *
 * 形状 2 下重建不出真实参数，只能给 `{}`。这不是猜——那一行的 status 必然是
 * failure，模型看到的是「这次调用失败了、参数已不可考」，而不是一次
 * 「参数为空却自称成功」的调用记录。
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

/**
 * 一次工具结果的模型可见正文。
 *
 * **必须与活的 transcript 逐字同形**（`agent/loop.ts` 里 push 的那一份）。
 * 两处不同形的话，同一次调用在本轮和下一轮长得不一样，模型会当成两件事——
 * 而这种不一致不会有任何报错。
 */
/** 落盘回来的 `data` 只能是 unknown；不是对象就当没有。 */
function dataOf(outcome: { data?: unknown }): Record<string, unknown> | undefined {
  const d = outcome.data
  return d && typeof d === 'object' ? (d as Record<string, unknown>) : undefined
}

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
    // 图像字节不进信封，只进图像块——与活的那侧同一个判据。
    ...(envelopeResult(dataOf(outcome)) ? { result: envelopeResult(dataOf(outcome)) } : {}),
  })
  // 与活的那侧共用同一个构造函数——两处各写一遍必然漂移，而漂移了不会有任何报错。
  // `data` 是落盘回来的 JSON，类型上只能是 unknown；不是对象就当没有，
  // `toolResultContent` 自己会退回纯字符串。
  return toolResultContent(envelope, dataOf(outcome))
}

/**
 * 一个可折单元：同一个执行波次的 assistant 消息与它的全部 tool 结果。
 *
 * 压缩按单元切界，**共戳即同进同出**——tool_call 与它的 tool_result 因此永远
 * 不会被切开。这是结构保证，不是事后修补。
 */
export interface StepUnit {
  /** `stepStamp(runId, 单元里最后一个 step 的 seq)`。 */
  stamp: string
  messages: WireMessage[]
  /** 这个单元里的 tool_action step。纯文本单元为空。 */
  steps: Step[]
  /**
   * 这个单元是 run 内注入的用户消息时，指向那条 step。
   *
   * 两个消费者要它，而两处都不该靠「看消息角色猜」：`buildHistory` 拿它取附件，
   * 压缩拿它的 id 组出取回地址（`<runId>:<stepId>`）。
   */
  userStep?: Step
}

/**
 * 折平一个 run 的 steps，按可折单元分组。
 *
 * 顺序即 `seq` 顺序（`listSteps` 已按它排）。同一 `providerBatchId` 的
 * tool_action 属于同一个 assistant 轮，合成一条带 `toolCalls` 的消息，
 * 随后每个调用一条 `role:'tool'`；它们与被并进来的前置文本共用一个戳。
 *
 * **戳必须与 `agent/loop.ts` 里活的 transcript 逐字相同**：同一个单元在
 * 「本 run 活跃时」与「跨 run 投影回历史后」定位不一致的话，压缩会按两条不同的
 * 线去切同一段内容。
 */
export function stepsToUnits(steps: Step[], opts: ProjectOptions = {}): StepUnit[] {
  const units: StepUnit[] = []
  const mark = <T extends WireMessage>(m: T, stamp: string): T =>
    ({ ...m, ...(opts.messageId ? { _messageId: opts.messageId } : {}), _step: stamp }) as T

  let pendingText = ''
  let pendingStamp = ''
  /**
   * 本轮的思考正文，等这一轮的工具批次来取。
   *
   * 默认纯文本轮不带它；只有模型 spec 明确要求完整历史时，活 transcript 与投影
   * 同时开启 `preserveAssistantReasoning`。两边必须同形，否则下一轮缓存前缀会断。
   */
  let pendingReasoning = ''
  const flushText = () => {
    const reasoning = opts.preserveAssistantReasoning ? pendingReasoning : ''
    pendingReasoning = ''
    if (!pendingText.trim() && !reasoning) {
      pendingText = ''
      return
    }
    units.push({
      stamp: pendingStamp,
      messages: [
        mark(
          {
            role: 'assistant',
            content: pendingText,
            ...(reasoning ? { reasoningContent: reasoning } : {}),
            _group: GROUP,
          },
          pendingStamp,
        ),
      ],
      steps: [],
    })
    pendingText = ''
  }

  let i = 0
  while (i < steps.length) {
    const step = steps[i]!
    if (step.kind === 'thinking') {
      /*
       * 失败的思考不进模型视图。
       *
       * 轮内自动重发时，失败那次的思考 step 与重发那次落在**同一个 run** 里且相邻
       * （`buildHistory` 逐 run 投影，跨 run 漏不过来，同 run 内会）。不排除就是两段
       * 无关生成拼成一条 `reasoningContent` 回传，与活侧不同形——违反本文件开头
       * 那条「必须与活的逐字同形」，缓存前缀也从那里断。
       */
      if (step.status !== 'failure') pendingReasoning += step.content ?? ''
      pendingStamp = stepStamp(step.runId, step.seq)
      i += 1
      continue
    }
    if (step.kind === 'text') {
      pendingText += step.content ?? ''
      pendingStamp = stepStamp(step.runId, step.seq)
      i += 1
      continue
    }
    if (step.kind === 'user') {
      /*
       * run 内注入的那句用户消息，原位产出一条 `role:'user'`。
       *
       * 先 `flushText()`：它落在这条 step 之前的文本之后，顺序由 seq 定，
       * 与活的 transcript 逐条同位。
       *
       * `_group` 是 `historyMessages` 而不是 `GROUP`——这是用户打的字，不是执行记录。
       * 活侧（`agent/loop.ts` 的注入点）必须同值，两侧不同口径比都记错更坏。
       *
       * `pendingReasoning` 在这里必然是空的：注入发生在 step 循环顶部，
       * 而思考与它的工具批次在同一步之内，中间夹不进别的 step。
       */
      flushText()
      const stamp = stepStamp(step.runId, step.seq)
      units.push({
        stamp,
        messages: [mark({ role: 'user', content: step.content ?? '', _group: USER_GROUP }, stamp)],
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

    // 收齐**连续的**同批次调用。批次 id 缺失的存量行按位置各成一批，
    // 免得两次无关的调用因为同为 null 被并成一个 assistant 轮。
    const batchId = step.providerBatchId ?? `legacy:${i}`
    const batch: Step[] = []
    while (i < steps.length) {
      const s = steps[i]!
      if (s.kind !== 'tool_action' || (s.providerBatchId ?? `legacy:${i}`) !== batchId) break
      batch.push(s)
      i += 1
    }

    // 整批里只要还有没落终态的，**整批跳过**：provider 协议要求每个 tool call
    // 必须有配对结果，少一条就是 400。
    //
    // 这是崩溃窗口的窄守卫，不是常规路径——`settleRunningSteps` 在 run 收尾
    // 与进程启动时都会把 running 行落成终态。它要是不工作，这里的跳过会**连带
    // 吞掉同批次已经成功的结果**，那才是真正要防的退化。
    if (batch.some((s) => s.status === 'running')) continue

    const ordered = [...batch].sort((a, b) => (a.callIndex ?? 0) - (b.callIndex ?? 0))
    const calls: WireToolCall[] = ordered.map((s) => ({
      id: s.toolCallId ?? '',
      name: s.toolName ?? 'unknown',
      arguments: toolPayloadOf(s).args ?? {},
    }))

    /*
     * 思考正文来自本轮的 `thinking` step。
     *
     * `batch[0].content` 是**只读旧行的回落**：迁移 26 之前思考寄生在批次首条
     * 工具行的 `content` 上，那些行的 seq 是密排的、没有空位插新行，重排 seq
     * 又会打断 `compaction_manifest` 里已经持久化的单元戳，所以不搬。
     * 缺这一段的后果不是显示问题——DeepSeek 类兼容端点对带 tool_calls 却没有
     * `reasoning_content` 的历史消息在第二轮就 400。
     * 存量会话清空后这条回落可以删掉。
     */
    const reasoning = pendingReasoning || (batch[0]?.content ?? '')
    pendingReasoning = ''
    // 戳取批次里最大的 seq：活的 transcript 那侧是「一波跑完时的高水位」，同一个数。
    const stamp = stepStamp(batch[0]!.runId, Math.max(...batch.map((s) => s.seq)))

    const messages: WireMessage[] = [
      mark(
        {
          role: 'assistant',
          content: pendingText,
          toolCalls: calls,
          ...(reasoning ? { reasoningContent: reasoning } : {}),
          _group: GROUP,
        },
        stamp,
      ),
    ]
    pendingText = ''

    for (const s of ordered) {
      messages.push(
        mark(
          { role: 'tool', toolCallId: s.toolCallId ?? '', content: toolContent(s), _group: GROUP },
          stamp,
        ),
      )
    }
    units.push({ stamp, messages, steps: ordered })
  }

  flushText()
  return units
}

/** 折平一个 run 的 steps。单元边界见 `stepsToUnits`。 */
export function stepsToWireMessages(steps: Step[], opts: ProjectOptions = {}): WireMessage[] {
  return stepsToUnits(steps, opts).flatMap((u) => u.messages)
}

/** 注入消息带的附件。不是注入单元、或者没带附件时是空数组。 */
export function attachmentsOf(step: Step | undefined): Attachment[] {
  if (step?.kind !== 'user') return []
  return (step.payload as { attachments?: Attachment[] } | null)?.attachments ?? []
}

/**
 * 装配一次请求的完整历史：消息 + 由 steps 投影出的执行回合。
 *
 * 独立成函数是为了**能单独测**：内联在 `Session.ask()` 里的话，那条路要跑通得有
 * 真实 provider，因此「第二轮看得见什么」这件事没有任何测试能碰到。
 *
 * `attachments` 由调用方注入：附件正文要读磁盘，而这个函数不该知道工作区在哪。
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

  const contextByUser = new Map<
    string,
    ReturnType<typeof listRunContextSnapshots>[number]['segments']
  >()
  for (const snapshot of listRunContextSnapshots(store, conversationId)) {
    if (!snapshot.userMessageId) continue
    contextByUser.set(snapshot.userMessageId, snapshot.segments)
  }

  const out: WireMessage[] = []
  for (const m of listMessages(store, conversationId, upperBound)) {
    if (m.role === 'user') {
      for (const segment of contextByUser.get(m.id) ?? []) {
        out.push({
          role: 'context',
          content: segment.content,
          _group: segment.group,
          _messageId: m.id,
        })
      }
    }
    out.push({
      role: m.role,
      content: m.attachments.length ? await attachments(m.content, m.attachments) : m.content,
      _group: 'historyMessages',
      _messageId: m.id,
    })
    for (const r of byUser.get(m.id) ?? []) {
      /*
       * 逐单元走而不是直接摊平：注入消息的附件要在这里解析（读磁盘），
       * 而 `stepsToUnits` 是同步的——压缩那侧共用它。
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
