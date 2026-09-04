/**
 * `CompactionPort` 的实际装配。
 *
 * loop 只知道「投影历史」和「跑一次压缩」两个动作；manifest 存在哪张表、
 * 可折单元怎么从账本里取、摘要预算的观测从哪查，全在这一层。
 *
 * 单元序**必须与 loop 装配出来的那一份逐字对齐**：两边都靠 `stepsToUnits` /
 * `stepStamp` 造戳，戳不同形就会按两条不同的线去切同一段内容。
 */

import type {
  CompactionAction,
  CompactionInput,
  CompactionOutcome,
  CompactionPort,
  CompactionRunInput,
  Summarizer,
} from '@qywork/agent'
import {
  compact,
  condenseCutOf,
  condenseMessage,
  cutKey,
  deliveryBudget,
  projectManifest,
  softLimit,
  summaryCutOf,
  unitKey,
} from '@qywork/agent'
import type { TokenDensity, WireMessage } from '@qywork/ai'
import { estimateMessages, MEDIA_TOKENS } from '@qywork/ai'
import type {
  ActionKind,
  CompactionCut,
  CompactionManifest,
  ConversationId,
  MessageId,
  Step,
} from '@qywork/core'
import {
  getConversation,
  latestSentProviderRequest,
  listMessages,
  listRunContextSnapshots,
  listRuns,
  listSteps,
  type Store,
  setCompactionManifest,
  summaryOutputPercentile,
} from '@qywork/store'
import { attachmentsOf, stepsToUnits } from './transcript.ts'

/**
 * 摘要输出的观测分位。
 *
 * 取 p95 而不是极大值：硬上界由 headroom 给，这个数只需要覆盖常态；
 * 写超了的那一次被「截断作废」闸捕获，并作为更大的样本进入下一次的分布。
 */
const SUMMARY_PERCENTILE = 0.95

export interface CompactionDeps {
  store: Store
  conversationId: ConversationId
  /** run 创建时定格的消息高水位，压缩范围不得越过它。 */
  messageIdUpperBound: MessageId | null
  /** 摘要生成器。 */
  summarize: Summarizer
  /** 与当前主模型的历史投影同源；压缩不能换一套 wire 形状。 */
  preserveAssistantReasoning?: boolean
}

/** 一个可折单元在账本侧的形态。切界只落在单元之间。 */
interface Unit {
  key: string
  cut: CompactionCut
  tokens: number
  messages: WireMessage[]
  /** 会话消息行；执行记录单元为 null。 */
  row: CompactionInput['messages'][number] | null
  actions: CompactionAction[]
}

export class RuntimeCompaction implements CompactionPort {
  /**
   * 内存里的当前 manifest。
   *
   * 读一次缓存住而不是每次投影都查库：投影在**每次构造请求**时都会调用，
   * 一轮几十次，每次一个 SQL 查询纯属浪费。压缩由本对象自己执行，所以它总是知道最新值。
   */
  private manifest: CompactionManifest | null
  /** 最新 run 的上下文归属；空快照也要覆盖旧 run，不能误把旧上下文钉回来。 */
  private latestContextUserMessageId: MessageId | null

  constructor(private readonly deps: CompactionDeps) {
    this.manifest = getConversation(deps.store, deps.conversationId)?.compactionManifest ?? null
    this.latestContextUserMessageId =
      [...listRunContextSnapshots(deps.store, deps.conversationId)]
        .reverse()
        .find((snapshot) => snapshot.userMessageId !== null)?.userMessageId ?? null
  }

  /**
   * 投影，分三区。
   *
   * 摘要线以内 → 换成「摘要 + 事实清单」两条；摘要线到收纳线之间 → 消息原样、
   * 工具正文换信封；收纳线之后 → 逐字原样。模型因此看到一个保真度梯度。
   *
   * 判断边界用单元键而不是数组下标：一条用户消息前还有它所属的运行上下文，
   * assistant/tool 也按执行波次成组。按下标切会拆坏这些结构。
   */
  project(history: WireMessage[]): WireMessage[] {
    const m = this.manifest
    if (!m) return history

    const summary = summaryCutOf(m)
    const condense = condenseCutOf(m)
    const summaryKey = summary ? cutKey(summary) : null
    const condenseKey = condense ? cutKey(condense) : null
    const todoFacts = currentTodoFacts(messageUnits(history))
    const todoTable = todoFacts[0]
    const latestContext = this.latestContextUserMessageId
      ? history.filter(
          (message) =>
            message.role === 'context' && message._messageId === this.latestContextUserMessageId,
        )
      : []
    const latestContextKey = latestContext[0] ? unitKey(latestContext[0]) : null
    const pinContext =
      summaryKey !== null && latestContextKey !== null && latestContextKey <= summaryKey

    let folded = 0
    const out: WireMessage[] = []
    for (const msg of history) {
      const key = unitKey(msg)
      if (key === null) {
        out.push(msg)
        continue
      }
      if (summaryKey !== null && key <= summaryKey) {
        folded++
        continue
      }
      out.push(
        condenseKey !== null &&
          key <= condenseKey &&
          // 最近整表保留真实参数；其后的待验收子任务回执照常收纳成小信封。
          key !== todoTable?.key
          ? condenseMessage(msg)
          : msg,
      )
    }

    // 一条都没折掉说明摘要线与当前历史对不上（换了会话、消息被删）。
    // 这时插两条摘要只会平白多两条消息。
    if (folded === 0) return out

    const manifest = projectManifest(m).map((p) => ({
      role: p.role,
      content: p.content,
      _group: 'summary' as const,
    }))
    const pinnedTodos =
      summaryKey === null
        ? []
        : todoFacts
            .filter((fact) => fact.key <= summaryKey)
            .flatMap((fact) => todoFactMessages(fact))

    return [
      ...(pinContext ? latestContext : []),
      ...(manifest[0] ? [manifest[0]] : []),
      ...pinnedTodos,
      ...manifest.slice(1),
      ...out,
    ]
  }

  /**
   * 跑一次压缩并落库。
   *
   * 顺序是固定的：选界 → 可行性 → 收纳 → 够了就落库 → 不够才调模型 → 落库前查信号。
   * `signal` 逐层带到落库点前。**可缺**：手动压缩不属于任何 run。
   */
  async run(input: CompactionRunInput): Promise<CompactionOutcome> {
    const { store, conversationId } = this.deps
    const previous = this.manifest
    const summary = summaryCutOf(previous)
    const condense = condenseCutOf(previous)
    const summaryKey = summary ? cutKey(summary) : ''
    const condenseKey = condense ? cutKey(condense) : ''

    // 选界：从尾部逐单元累加到保留预算为止。**保留预算 = 批级投递预算**，
    // 给出的不变量是「上一次检查以来刚进来的那一波必然完整保留」。
    const units = this.collectUnits(input.density)
    const automaticRetain = deliveryBudget(input.contextWindow).batchCap
    /*
     * 自动压缩必须完整保留一个批级窗口；手动压缩发生在用户明确要求收纳时，
     * 若仍拿模型总窗口的 1/4 当尾部预算，低占用会话的整段历史可能还不够这个数，
     * `/compact` 就只能回 `nothing_to_fold`。手动入口仍用同一个选界函数，只把
     * 保留量收敛到当前可折历史的 1/4，至少保留最后一个完整单元。
     */
    const retain =
      input.trigger === 'manual'
        ? Math.min(
            automaticRetain,
            Math.max(1, Math.floor(units.reduce((total, unit) => total + unit.tokens, 0) / 4)),
          )
        : automaticRetain
    const foldIndex = foldIndexOf(units, retain)
    if (foldIndex < 0) return { status: 'skipped', reasonCode: 'nothing_to_fold' }
    const fold = units[foldIndex]!
    const todoFacts = currentTodoFacts(units)
    const latestTodo = todoFacts[0]?.source

    // 收纳段：折叠线以内的工具正文换信封。**零模型调用**，回收量当场估得出。
    const messages: CompactionInput['messages'] = []
    const actions: CompactionAction[] = []
    let foldedMessageCount = 0
    let originalNew = 0
    let condensedNew = 0
    let condensedRegion = 0
    for (let i = 0; i <= foldIndex; i++) {
      const u = units[i]!
      // 摘要线以内的已经不在投影里了，既不用再收纳也不用再摘要。
      if (u.key <= summaryKey) continue
      if (u.row) {
        messages.push(u.row)
        foldedMessageCount++
      }
      for (const m of u.messages) {
        if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) {
          messages.push({ id: u.cut.messageId, role: 'assistant', content: m.content })
        }
      }
      actions.push(...u.actions)

      const condensed = estimateMessages(
        u === latestTodo ? u.messages : u.messages.map(condenseMessage),
        input.density,
      )
      condensedRegion += condensed
      if (u.key <= condenseKey) continue
      originalNew += u.tokens
      condensedNew += condensed
    }

    const limit = softLimit({ contextWindow: input.contextWindow })
    /*
     * 回收量先折算再减。
     *
     * `occupancy` 锚定之后是 provider 真值，而 `originalNew` / `condensedNew` 只能
     * 本地估算。直接相减是拿一把尺的差额去改另一把尺的读数：未收录档实测高 1.47 倍，
     * 因此回收量虚高同样的倍数，`condenseOnly` 判成「收纳就够了」而实际不够——
     * 摘要线不前移，此后每一轮都判 `nothing_to_fold`，占用只增不减直到撞窗。
     * 实测越线量上界是 0.32 × (占用 − 软阈值)。
     *
     * 比值取这一份内容上两把尺的实测比，不是常数：同一份请求两个数都在手里。
     * 没有锚点时两者相等，比值为 1，算式退化成相减本身。
     *
     * **折算完要取整。** 这个数往下传成 `projectionBudget`，而那是给摘要器的
     * token 预算——不取整的话小数会逐层传进提示词（真机上量到过
     * `2702.675848654075`）。
     */
    const scale = input.estimatedOccupancy > 0 ? input.occupancy / input.estimatedOccupancy : 1
    const afterCondense = input.occupancy - Math.round((originalNew - condensedNew) * scale)
    // 手动触发是明确的摘要请求；即使收纳已经够用，也必须继续尝试摘要段。
    const condenseOnly = input.trigger === 'automatic' && afterCondense <= limit

    // 可行性：这一次必须真的推进一条线。收纳够用时摘要线不动，那就要求收纳线能前移。
    if (fold.key <= summaryKey || (condenseOnly && fold.key <= condenseKey)) {
      return { status: 'skipped', reasonCode: 'nothing_to_fold' }
    }

    /*
     * 投影总预算：摘要线推到折叠线之后，还能往里放多少。
     *
     * 被摘要替换掉的是「收纳后的被折区」加「上一份摘要投影」，两者都腾出来；
     * 事实清单逐字优先占，摘要拿剩下的（`compact()` 里分）。全程 token 计。
     */
    const oldProjection = summary ? estimateMessages(projectManifest(previous!), input.density) : 0
    const latestContextUnit = [...units]
      .reverse()
      .find((unit) => unit.messages.some((message) => message.role === 'context'))
    const pinnedContextTokens =
      latestContextUnit && latestContextUnit.key > summaryKey && latestContextUnit.key <= fold.key
        ? estimateMessages(
            latestContextUnit.messages.filter((message) => message.role === 'context'),
            input.density,
          )
        : 0
    const pinnedTodoTokens = todoFacts
      .filter((fact) => fact.key > summaryKey && fact.key <= fold.key)
      .reduce((tokens, fact) => tokens + estimateMessages(todoFactMessages(fact), input.density), 0)
    const projectionBudget =
      limit -
      afterCondense +
      condensedRegion +
      oldProjection -
      pinnedContextTokens -
      pinnedTodoTokens
    const workspaceId = getConversation(store, conversationId)?.workspaceId ?? ''

    const outcome = await compact(
      {
        messages,
        actions,
        previous,
        fold: fold.cut,
        condenseOnly,
        density: input.density,
        projectionBudget,
        typicalSummaryTokens: summaryOutputPercentile(store, workspaceId, SUMMARY_PERCENTILE),
        condensedRegionTokens: condensedRegion,
        foldedMessageCount,
        ...(input.trace ? { trace: input.trace } : {}),
      },
      this.deps.summarize,
      input.signal,
    )

    if (outcome.status === 'compacted') {
      /*
       * 落库前最后一次查信号。
       *
       * **检查点必须紧贴这条 UPDATE**：中间再插一个 await 就又留出一个窗口，
       * 而这条 UPDATE 是不可逆的——它改写模型此后看到的全部历史。用户按下停止
       * 之后落库的那份 manifest，是他没有等到、也无从撤销的。
       *
       * 落库与内存的顺序不能反：反过来中途崩溃会留下「内存说压过了、库里没有」，
       * 下次启动投影就丢了，而模型会突然又看到全部历史。
       */
      if (input.signal?.aborted) return { status: 'aborted' }
      const before = this.estimateProjection(units, previous, input.density)
      const after = this.estimateProjection(units, outcome.manifest, input.density)
      const recovered = before - after
      const latestSent = latestSentProviderRequest(store, conversationId)
      const manifest: CompactionManifest = {
        ...outcome.manifest,
        contextAfter: {
          basedOnProviderRequestId: latestSent?.id ?? null,
          model: input.model,
          total: Math.max(0, input.occupancy - Math.round(recovered * scale)),
          measured: Math.max(0, input.estimatedOccupancy - recovered),
        },
      }
      setCompactionManifest(store, conversationId, manifest)
      this.manifest = manifest
      return { ...outcome, manifest }
    }
    return outcome
  }

  /**
   * 用主模型的同一把尺量 manifest 前后的历史投影。
   *
   * 面板只拿两者差额去修正完整请求，因此系统提示词、工具表等头部不在这里重复
   * 造账。附件在 `collectUnits` 里按 `MEDIA_TOKENS` 计入 `unit.tokens`；收纳工具
   * 正文时仍把附件差额补回，口径与活请求一致。
   */
  private estimateProjection(
    units: readonly Unit[],
    manifest: CompactionManifest | null,
    density: TokenDensity,
  ): number {
    if (!manifest) return units.reduce((total, unit) => total + unit.tokens, 0)

    const summary = summaryCutOf(manifest)
    const condense = condenseCutOf(manifest)
    const summaryKey = summary ? cutKey(summary) : null
    const condenseKey = condense ? cutKey(condense) : null
    const todoFacts = currentTodoFacts(units)
    const latestTodo = todoFacts[0]?.source
    const latestContext = this.latestContextUserMessageId
      ? units.find(
          (unit) =>
            unit.cut.messageId === this.latestContextUserMessageId &&
            unit.messages.some((message) => message.role === 'context'),
        )
      : undefined
    const pinContext =
      summaryKey !== null && latestContext !== undefined && latestContext.key <= summaryKey

    let folded = 0
    let total = 0
    for (const unit of units) {
      if (summaryKey !== null && unit.key <= summaryKey) {
        folded++
        continue
      }
      if (condenseKey !== null && unit.key <= condenseKey && unit !== latestTodo) {
        const messageTokens = estimateMessages(unit.messages, density)
        const attachmentTokens = Math.max(0, unit.tokens - messageTokens)
        total += estimateMessages(unit.messages.map(condenseMessage), density) + attachmentTokens
      } else {
        total += unit.tokens
      }
    }

    // manifest 的切线与当前历史不相交时，投影函数也不会平白插入摘要。
    if (folded === 0) return total
    if (pinContext && latestContext) {
      total += estimateMessages(
        latestContext.messages.filter((message) => message.role === 'context'),
        density,
      )
    }
    if (summaryKey !== null) {
      total += todoFacts
        .filter((fact) => fact.key <= summaryKey)
        .reduce((tokens, fact) => tokens + estimateMessages(todoFactMessages(fact), density), 0)
    }
    return total + estimateMessages(projectManifest(manifest), density)
  }

  /**
   * 把整条会话拉平成可折单元序列。
   *
   * 口径与 `buildHistory` 一致：被接替的 run 不收（失败尝试说过的话不该进摘要），
   * 还在 running 的批次不收（结果未知不能当已完成，`stepsToUnits` 整批跳过）。
   * **本 run 已终结的 step 在内**——run 内涨起来的正是它们，压不到就等于压了个寂寞。
   */
  private collectUnits(density: TokenDensity): Unit[] {
    const { store, conversationId, messageIdUpperBound } = this.deps
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

    const units: Unit[] = []
    for (const m of listMessages(store, conversationId, messageIdUpperBound)) {
      const cut: CompactionCut = { messageId: m.id }
      const wire: WireMessage = {
        role: m.role,
        content: m.content,
        _group: 'historyMessages',
        _messageId: m.id,
      }
      const context: WireMessage[] =
        m.role === 'user'
          ? (contextByUser.get(m.id) ?? []).map((segment) => ({
              role: 'context' as const,
              content: segment.content,
              _group: segment.group,
              _messageId: m.id,
            }))
          : []
      units.push({
        key: cutKey(cut),
        cut,
        // 附件按固定值计，与装配那侧同一口径；按 base64 长度估会高出两个数量级。
        tokens: estimateMessages([...context, wire], density) + m.attachments.length * MEDIA_TOKENS,
        messages: [...context, wire],
        row: {
          id: m.id,
          role: m.role,
          content: m.content,
          ...(m.attachments.length ? { hasAttachments: true } : {}),
        },
        actions: [],
      })
      for (const r of byUser.get(m.id) ?? []) {
        for (const u of stepsToUnits(listSteps(store, r.id), {
          messageId: m.id,
          ...(this.deps.preserveAssistantReasoning !== undefined
            ? { preserveAssistantReasoning: this.deps.preserveAssistantReasoning }
            : {}),
        })) {
          const stepCut: CompactionCut = { messageId: m.id, step: u.stamp }
          const files = attachmentsOf(u.userStep)
          units.push({
            key: cutKey(stepCut),
            cut: stepCut,
            tokens: estimateMessages(u.messages, density) + files.length * MEDIA_TOKENS,
            messages: u.messages,
            /*
             * run 内注入的那句用户消息也要有 `row`，否则它折进摘要线之后
             * **一个字都不会进摘要**：下面拼摘要段时只收 `row` 与 assistant 正文，
             * user 角色的单元消息不在其中，而它的 `actions` 是空的。
             * 表现是用户改方向的那句话在一次压缩后彻底消失，模型接着按改之前的判断跑。
             *
             * id 用 `<runId>:<stepId>`——它不在 `messages` 表里，
             * 由 `HistoryPort.message` 的复合形式解析回来。
             */
            row: u.userStep
              ? {
                  id: `${r.id}:${u.userStep.id}`,
                  role: 'user' as const,
                  content: u.userStep.content ?? '',
                  ...(files.length ? { hasAttachments: true } : {}),
                }
              : null,
            actions: u.steps.map((s) => actionOf(r.id, s)),
          })
        }
      }
    }
    return units
  }
}

interface TodoFact<T extends { key: string; messages: WireMessage[] }> {
  key: string
  messages: WireMessage[]
  kind: 'table' | 'receipt'
  source: T
}

/** 把 wire history 按执行单元分组；同一波 assistant 调用与所有结果必须同进同出。 */
function messageUnits(history: readonly WireMessage[]): { key: string; messages: WireMessage[] }[] {
  const units = new Map<string, WireMessage[]>()
  for (const message of history) {
    if (!message._step) continue
    const key = unitKey(message)
    if (!key) continue
    const messages = units.get(key) ?? []
    messages.push(message)
    units.set(key, messages)
  }

  return [...units].map(([key, messages]) => ({ key, messages }))
}

/**
 * 当前待办的最小验收链：最近成功整表，以及它之后明确绑定父待办的成功子任务回执。
 * 回执不是 completed；钉住它是为了长会话压缩后父会话仍能验收或决定返工。
 * 新整表表示父会话已经作出更新，因此替换此前的待验收链。
 */
function currentTodoFacts<T extends { key: string; messages: WireMessage[] }>(
  units: readonly T[],
): TodoFact<T>[] {
  let facts: TodoFact<T>[] = []
  for (const unit of units) {
    if (hasSuccessfulCall(unit.messages, 'write_todos')) {
      facts = [{ key: unit.key, messages: unit.messages, kind: 'table', source: unit }]
      continue
    }
    if (
      facts.length > 0 &&
      hasSuccessfulCall(
        unit.messages,
        'subagent',
        (args) => typeof args.parentTodo === 'string' && args.parentTodo.trim().length > 0,
      )
    ) {
      facts.push({
        key: unit.key,
        messages: unit.messages,
        kind: 'receipt',
        source: unit,
      })
    }
  }
  return facts
}

/** 整表逐字保留；待验收回执只留调用摘录与成功摘要，不能把大段产出钉在窗口里。 */
function todoFactMessages(fact: TodoFact<{ key: string; messages: WireMessage[] }>): WireMessage[] {
  return fact.kind === 'table' ? fact.messages : fact.messages.map(condenseMessage)
}

function hasSuccessfulCall(
  messages: readonly WireMessage[],
  name: string,
  accepts: (args: Record<string, unknown>) => boolean = () => true,
): boolean {
  const calls = messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.toolCalls ?? [])
    .filter((call) => call.name === name && accepts(call.arguments))
  return calls.some((call) =>
    messages.some(
      (message) =>
        message.role === 'tool' &&
        message.toolCallId === call.id &&
        toolEnvelopeStatus(message.content) === 'success',
    ),
  )
}

function toolEnvelopeStatus(content: WireMessage['content']): string | null {
  const text =
    typeof content === 'string' ? content : content.find((block) => block.type === 'text')?.text
  if (!text) return null
  try {
    const parsed = JSON.parse(text) as { status?: unknown }
    return typeof parsed.status === 'string' ? parsed.status : null
  } catch {
    return null
  }
}

/**
 * 折叠线：最后一个**不**保留的单元的下标。`-1` = 尾部还没攒够保留预算，无可折。
 *
 * 先加后判，所以把总量顶过预算的那个单元自己也留着——至少保留最后一个单元。
 */
function foldIndexOf(units: Unit[], retain: number): number {
  let spent = 0
  for (let i = units.length - 1; i >= 0; i--) {
    spent += units[i]!.tokens
    if (spent >= retain) return i - 1
  }
  return -1
}

function actionOf(runId: string, step: Step): CompactionAction {
  const payload = step.payload as {
    action?: { kind?: ActionKind; target?: string | null }
    outcome?: {
      message?: string
      errorKind?: string
      resources?: { resourceId?: string }[]
    }
  } | null
  return {
    stepId: `${runId}:${step.id}`,
    tool: step.toolName ?? 'unknown',
    status: step.status,
    actionKind: payload?.action?.kind ?? null,
    target: payload?.action?.target ?? null,
    summary: payload?.outcome?.message ?? '',
    errorCode: payload?.outcome?.errorKind ?? null,
    resourceId: payload?.outcome?.resources?.[0]?.resourceId ?? null,
  }
}
