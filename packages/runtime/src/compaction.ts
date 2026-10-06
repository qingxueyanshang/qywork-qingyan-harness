/**
 * `CompactionPort` 的实际装配。
 *
 * loop 只依赖「投影历史」与「执行一次压缩」两个动作；manifest 存储在哪张表、
 * 可折单元如何从账本中取得、摘要预算的观测从何处查询，均由本层负责。
 *
 * 单元顺序必须与 loop 装配的结果逐字一致：两侧都依据 `stepsToUnits` /
 * `stepStamp` 生成标记，标记形式不同时会按两条不同的边界切分同一段内容。
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
  projectManifest,
  softLimit,
  summaryCutOf,
  tailRetain,
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
import { isInlineVideo, isNoticeStep } from '@qywork/core'
import {
  getConversation,
  latestSentProviderRequest,
  listMessages,
  listRuns,
  listSteps,
  type Store,
  setCompactionManifest,
  summaryOutputPercentile,
} from '@qywork/store'
import {
  attachmentsOf,
  latestContextSnapshot,
  replayedContextByUser,
  stepsToUnits,
} from './transcript.ts'

/**
 * 摘要输出的观测分位。
 *
 * 取 p95 而不是最大值：硬上界由 headroom 提供，该值只需覆盖常态；
 * 超出预算的那一次由「截断作废」检查捕获，并作为更大的样本进入下一次的分布。
 */
const SUMMARY_PERCENTILE = 0.95

export interface CompactionDeps {
  store: Store
  conversationId: ConversationId
  /** run 创建时固定的消息高水位，压缩范围不得越过它。 */
  messageIdUpperBound: MessageId | null
  /** 摘要生成器。 */
  summarize: Summarizer
  /** 与当前主模型的历史投影同源；压缩不能使用另一套 wire 形状。 */
  preserveAssistantReasoning?: boolean
}

/** 可折单元在账本侧的形态。切分边界只位于单元之间。 */
interface Unit {
  key: string
  cut: CompactionCut
  tokens: number
  messages: WireMessage[]
  /** 会话消息行；执行记录单元为 null。 */
  row: CompactionInput['messages'][number] | null
  /** 单元中助手正文的取回地址 `<runId>:<stepId>`；会话消息单元与没有助手正文的单元为 null。 */
  assistantId: string | null
  actions: CompactionAction[]
}

export class RuntimeCompaction implements CompactionPort {
  /**
   * 内存中的当前 manifest。
   *
   * 读取一次后缓存，而不是每次投影都查询数据库：投影在每次构造请求时都会调用，
   * 一轮数十次，每次执行一条 SQL 查询没有必要。压缩由本对象执行，因此本对象始终持有最新值。
   */
  private manifest: CompactionManifest | null
  /**
   * 最新 run 的完整快照。回放去重后，某一段可能只出现在早期轮次，被摘要线折叠时从此处
   * 补回，模型看到的仍是完整的当前快照。空快照同样覆盖旧 run，不得把旧上下文误补回。
   */
  private readonly latestContext: ReturnType<typeof latestContextSnapshot>

  constructor(private readonly deps: CompactionDeps) {
    this.manifest = getConversation(deps.store, deps.conversationId)?.compactionManifest ?? null
    this.latestContext = latestContextSnapshot(deps.store, deps.conversationId)
  }

  /** 最新快照中在 `visible` 里未找到的段，按快照顺序生成待补回的上下文消息。 */
  private missingContext(visible: readonly WireMessage[]): WireMessage[] {
    if (!this.latestContext) return []
    const { userMessageId, segments } = this.latestContext
    return segments
      .filter(
        (segment) =>
          !visible.some(
            (message) =>
              message.role === 'context' &&
              message._group === segment.group &&
              message.content === segment.content,
          ),
      )
      .map((segment) => ({
        role: 'context' as const,
        content: segment.content,
        _group: segment.group,
        _messageId: userMessageId,
      }))
  }

  /**
   * 投影，分三区。
   *
   * 摘要线以内 → 替换为「摘要 + 事实清单」两条；摘要线到收纳线之间 → 消息保持原样、
   * 工具正文替换为信封；收纳线之后 → 逐字保留。模型因此看到逐级变化的保真度。
   *
   * 判断边界使用单元键而不是数组下标：用户消息之前还有其所属的运行上下文，
   * assistant/tool 也按执行批次成组。按下标切分会破坏这些结构。
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
        condenseKey !== null && key <= condenseKey
          ? condenseExcept(msg, pinsAt(key, todoTable))
          : msg,
      )
    }

    // 一条都未折叠说明摘要线与当前历史不一致（切换了会话、消息被删除）。
    // 此时插入两条摘要只会增加两条无用的消息。
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
      ...this.missingContext(out),
      ...(manifest[0] ? [manifest[0]] : []),
      ...pinnedTodos,
      ...manifest.slice(1),
      ...out,
    ]
  }

  /**
   * 执行一次压缩并落库。
   *
   * 顺序固定：选界 → 可行性 → 收纳 → 足够时落库 → 不足时调用模型 → 落库前检查信号。
   * `signal` 逐层传递到落库点之前。可以缺省：手动压缩不属于任何 run。
   */
  async run(input: CompactionRunInput): Promise<CompactionOutcome> {
    const { store, conversationId } = this.deps
    const previous = this.manifest
    const summary = summaryCutOf(previous)
    const condense = condenseCutOf(previous)
    const summaryKey = summary ? cutKey(summary) : ''
    const condenseKey = condense ? cutKey(condense) : ''

    // 选界：从尾部逐单元累加到保留量为止，至少保留最后一个单元。
    const units = this.collectUnits(input.density)
    const automaticRetain = tailRetain(input.contextWindow)
    /*
     * 自动压缩按 `tailRetain` 保留尾部；手动压缩发生在用户明确要求收纳时，
     * 若仍以模型总窗口的 1/4 作为尾部预算，低占用会话的整段历史可能不足该数值，
     * `/compact` 只能返回 `nothing_to_fold`。手动入口仍使用同一个选界函数，只把
     * 保留量收敛到当前可折历史的 1/4，至少保留最后一个完整单元。
     */
    const retain =
      input.trigger === 'manual'
        ? Math.min(
            automaticRetain,
            Math.max(1, Math.floor(units.reduce((total, unit) => total + unit.tokens, 0) / 4)),
          )
        : automaticRetain
    const foldIndex = foldIndexOf(units, retain, input.latestUnitSeen)
    if (foldIndex < 0) return { status: 'skipped', reasonCode: 'nothing_to_fold' }
    const fold = units[foldIndex]!
    const todoFacts = currentTodoFacts(units)
    const todoTable = todoFacts[0]

    // 收纳段：折叠线以内的工具正文替换为信封。不调用模型，回收量可当场估算。
    const messages: CompactionInput['messages'] = []
    const actions: CompactionAction[] = []
    let foldedMessageCount = 0
    let originalNew = 0
    let condensedNew = 0
    let condensedRegion = 0
    for (let i = 0; i <= foldIndex; i++) {
      const u = units[i]!
      // 摘要线以内的内容已不在投影中，无需再收纳或摘要。
      if (u.key <= summaryKey) continue
      if (u.row) {
        messages.push(u.row)
        foldedMessageCount++
      }
      for (const m of u.messages) {
        if (
          u.assistantId &&
          m.role === 'assistant' &&
          typeof m.content === 'string' &&
          m.content.trim()
        ) {
          // 地址使用助手正文自身的 step：若使用所属用户消息的 id，模型按摘要中的标记读取到的是用户的原话。
          messages.push({
            id: u.assistantId,
            role: 'assistant',
            content: m.content,
          })
        }
      }
      actions.push(...u.actions)

      const pinned = pinsAt(u.key, todoTable)
      const condensed = estimateMessages(
        u.messages.map((message) => condenseExcept(message, pinned)),
        input.density,
      )
      condensedRegion += condensed
      if (u.key <= condenseKey) continue
      originalNew += u.tokens
      condensedNew += condensed
    }

    const limit = softLimit({ contextWindow: input.contextWindow })
    /*
     * 回收量先折算再相减。
     *
     * `occupancy` 锚定之后是 provider 真值，而 `originalNew` / `condensedNew` 只能
     * 本地估算。直接相减等于用一种口径的差额修改另一种口径的读数：未收录模型的估算实测偏高 1.47 倍，
     * 因此回收量虚高同样的倍数，`condenseOnly` 判定「仅收纳即可」而实际不足：
     * 摘要线不前移，此后每一轮都判定 `nothing_to_fold`，占用只增不减，直到触及上下文窗口上限。
     * 实测越过阈值的量上界为 0.32 × (占用 − 软阈值)。
     *
     * 比值取这一份内容在两种口径下的实测比，不是常数：同一份请求的两个数值均已知。
     * 没有锚点时两者相等，比值为 1，算式退化为直接相减。
     *
     * 折算后必须取整。该值向下传递为 `projectionBudget`，即提供给摘要器的
     * token 预算；不取整时小数会逐层传入提示词（真机上实测出现过
     * `2702.675848654075`）。
     */
    const scale = input.estimatedOccupancy > 0 ? input.occupancy / input.estimatedOccupancy : 1
    const afterCondense = input.occupancy - Math.round((originalNew - condensedNew) * scale)
    // 手动触发是明确的摘要请求；即使收纳已足够，也必须继续尝试摘要段。
    const condenseOnly = input.trigger === 'automatic' && afterCondense <= limit

    /*
     * 占用未越过软阈值时只执行回收量足够大的收纳，不摘要。
     *
     * 收纳改写的是从第一个被收纳单元起的投影，整段保留尾部需重新计费；只回收数十个 token 的收纳
     * 无法腾出空间，却在每次决策时使缓存失效一次。下限取半份保留量：一段续读投递最多一份保留量，
     * 收纳一段扣去信封后仍须达到下限；取整份时 32K 续读在收纳后仍无法容纳下一段。
     * 越过软阈值时判据不变：收纳足够时只收纳，不足时摘要。
     */
    if (
      input.trigger === 'automatic' &&
      input.occupancy <= limit &&
      originalNew - condensedNew < automaticRetain / 2
    ) {
      return { status: 'skipped', reasonCode: 'nothing_to_fold' }
    }

    // 可行性：本次必须实际推进一条边界线。收纳足够时摘要线不动，此时要求收纳线能够前移。
    if (fold.key <= summaryKey || (condenseOnly && fold.key <= condenseKey)) {
      return { status: 'skipped', reasonCode: 'nothing_to_fold' }
    }

    /*
     * 投影总预算：摘要线推进到折叠线之后，还能容纳的 token 数。
     *
     * 被摘要替换的是「收纳后的折叠区」与「上一份摘要投影」，两者占用的空间都被释放；
     * 事实清单逐字优先占用，摘要使用剩余部分（在 `compact()` 中分配）。全程以 token 计。
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
       * 落库前最后一次检查信号。
       *
       * 检查点必须紧邻这条 UPDATE：中间每插入一个 await 就多出一个时间窗口，
       * 而这条 UPDATE 不可逆：它改写模型此后看到的全部历史。用户点击停止
       * 之后写入的 manifest 既不是用户等待的结果，也无法撤销。
       *
       * 落库与更新内存的顺序不能颠倒：颠倒后中途崩溃会留下「内存已压缩、数据库中没有」的状态，
       * 下次启动时该投影丢失，模型重新看到全部历史。
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
   * 用主模型的同一计量口径测量 manifest 前后的历史投影。
   *
   * 面板只用两者差额修正完整请求，因此系统提示词、工具表等头部不在此处重复
   * 计量。附件在 `collectUnits` 里按 `MEDIA_TOKENS` 计入 `unit.tokens`；收纳工具
   * 正文时仍补回附件差额，口径与实际请求一致。
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
    const todoTable = todoFacts[0]

    let folded = 0
    let total = 0
    const visible: WireMessage[] = []
    for (const unit of units) {
      if (summaryKey !== null && unit.key <= summaryKey) {
        folded++
        continue
      }
      visible.push(...unit.messages)
      if (condenseKey !== null && unit.key <= condenseKey) {
        const messageTokens = estimateMessages(unit.messages, density)
        const attachmentTokens = Math.max(0, unit.tokens - messageTokens)
        const pinned = pinsAt(unit.key, todoTable)
        total +=
          estimateMessages(
            unit.messages.map((message) => condenseExcept(message, pinned)),
            density,
          ) + attachmentTokens
      } else {
        total += unit.tokens
      }
    }

    // manifest 的切分线与当前历史不相交时，投影函数不会插入摘要。
    if (folded === 0) return total
    total += estimateMessages(this.missingContext(visible), density)
    if (summaryKey !== null) {
      total += todoFacts
        .filter((fact) => fact.key <= summaryKey)
        .reduce((tokens, fact) => tokens + estimateMessages(todoFactMessages(fact), density), 0)
    }
    return total + estimateMessages(projectManifest(manifest), density)
  }

  /**
   * 把整条会话展开为可折单元序列。
   *
   * 口径与 `buildHistory` 一致：被接替的 run 不收录（失败尝试中的输出不应进入摘要），
   * 仍在 running 的批次不收录（结果未知，不能视为已完成，`stepsToUnits` 整批跳过）。
   * 本 run 已终结的 step 包含在内：run 内增长的正是这些 step，不压缩它们就没有实际压缩效果。
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
    const contextByUser = replayedContextByUser(store, conversationId)

    const units: Unit[] = []
    for (const m of listMessages(store, conversationId, messageIdUpperBound)) {
      const cut: CompactionCut = { messageId: m.id }
      const wire: WireMessage = {
        role: m.role,
        content: m.content,
        _group: 'historyMessages',
        _messageId: m.id,
      }
      const context: WireMessage[] = (contextByUser.get(m.id) ?? []).map((segment) => ({
        role: 'context' as const,
        content: segment.content,
        _group: segment.group,
        _messageId: m.id,
      }))
      units.push({
        key: cutKey(cut),
        cut,
        // 附件按固定值计入、视频不计入，与装配侧（`estimateContent`）口径一致；按 base64 长度估算会高出两个数量级。
        tokens:
          estimateMessages([...context, wire], density) +
          m.attachments.filter((a) => !isInlineVideo(a.path)).length * MEDIA_TOKENS,
        messages: [...context, wire],
        row: {
          id: m.id,
          role: m.role,
          content: m.content,
          ...(m.attachments.length ? { hasAttachments: true } : {}),
        },
        assistantId: null,
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
            tokens:
              estimateMessages(u.messages, density) +
              files.filter((a) => !isInlineVideo(a.path)).length * MEDIA_TOKENS,
            messages: u.messages,
            /*
             * run 内注入的用户消息同样需要 `row`，否则该消息折叠进摘要线之后
             * 不会有任何内容进入摘要：下方组装摘要段时只收录 `row` 与 assistant 正文，
             * 不包含 user 角色的单元消息，而该单元的 `actions` 为空。
             * 其后果是用户调整方向的消息在一次压缩后完全丢失，模型继续按调整之前的判断执行。
             *
             * id 使用 `<runId>:<stepId>`：该消息不在 `messages` 表中，
             * 由 `HistoryPort.message` 的复合形式解析。
             */
            // 执行事实不是用户消息，不以用户的名义进入摘要。
            row:
              u.userStep && !isNoticeStep(u.userStep)
                ? {
                    id: `${r.id}:${u.userStep.id}`,
                    role: 'user' as const,
                    content: u.userStep.content ?? '',
                    ...(files.length ? { hasAttachments: true } : {}),
                  }
                : null,
            assistantId: u.textStep ? `${r.id}:${u.textStep.id}` : null,
            actions: u.steps.map((s) => actionOf(r.id, s)),
          })
        }
      }
    }
    return units
  }
}

interface TodoFact {
  key: string
  messages: WireMessage[]
  /**
   * 该事实中逐字保留的调用 id。整表为 `write_todos` 调用，回执为空集。
   *
   * 粒度必须是调用而不是单元：同一执行批次中还有其他工具，实测一份 261,929
   * 字符的子 agent 回执与 `write_todos` 同批，按单元保留会把该回执一并固定在窗口中，
   * 收纳线前移而占用不下降。
   */
  pinned: ReadonlySet<string>
}

const NO_PINS: ReadonlySet<string> = new Set()

/** 把 wire history 按执行单元分组；同一批 assistant 调用与全部结果必须一同保留或一同移除。 */
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
 * 回执不是 completed；固定保留回执，使长会话压缩后父会话仍能验收或决定返工。
 * 新整表表示父会话已经作出更新，因此替换此前的待验收链。
 */
function currentTodoFacts(units: readonly { key: string; messages: WireMessage[] }[]): TodoFact[] {
  let facts: TodoFact[] = []
  for (const unit of units) {
    const table = successfulCallIds(unit.messages, 'write_todos')
    if (table.length > 0) {
      facts = [{ key: unit.key, messages: unit.messages, pinned: new Set(table) }]
      continue
    }
    if (
      facts.length > 0 &&
      successfulCallIds(
        unit.messages,
        'subagent',
        (args) => typeof args.parentTodo === 'string' && args.parentTodo.trim().length > 0,
      ).length > 0
    ) {
      facts.push({ key: unit.key, messages: unit.messages, pinned: NO_PINS })
    }
  }
  return facts
}

/**
 * 整表调用与其结果逐字保留；同一批次的其余消息与待验收回执只保留调用摘录
 * 与成功摘要，不能把大段产出固定在窗口中。
 */
function todoFactMessages(fact: TodoFact): WireMessage[] {
  return fact.messages.map((message) => condenseExcept(message, fact.pinned))
}

/** 单元在收纳区中逐字保留的调用 id。只有最近整表所在的单元有此项。 */
function pinsAt(key: string, table: TodoFact | undefined): ReadonlySet<string> {
  return table?.key === key ? table.pinned : NO_PINS
}

/**
 * 收纳一条消息，但 `pinned` 中的调用逐字保留：其参数与结果不替换为信封，
 * 同一条消息中的其余调用、同一单元中的其余消息正常收纳。
 *
 * 投影、收纳量估算、事实清单三处共用本函数：三处各写一份判断必然产生偏差，
 * 口径不一致时压缩会报告一个实际无法达到的回收量。
 */
function condenseExcept(message: WireMessage, pinned: ReadonlySet<string>): WireMessage {
  // 绝大多数消息不在事实中，直接返回原对象而不重建：投影在每次构造请求时都会执行。
  if (pinned.size === 0) return condenseMessage(message)
  if (message.role === 'tool') {
    return message.toolCallId && pinned.has(message.toolCallId) ? message : condenseMessage(message)
  }
  const condensed = condenseMessage(message)
  if (!condensed.toolCalls) return condensed
  return {
    ...condensed,
    toolCalls: condensed.toolCalls.map(
      (call) =>
        (pinned.has(call.id)
          ? message.toolCalls?.find((original) => original.id === call.id)
          : null) ?? call,
    ),
  }
}

function successfulCallIds(
  messages: readonly WireMessage[],
  name: string,
  accepts: (args: Record<string, unknown>) => boolean = () => true,
): string[] {
  return messages
    .filter((message) => message.role === 'assistant')
    .flatMap((message) => message.toolCalls ?? [])
    .filter(
      (call) =>
        call.name === name &&
        accepts(call.arguments) &&
        messages.some(
          (message) =>
            message.role === 'tool' &&
            message.toolCallId === call.id &&
            toolEnvelopeStatus(message.content) === 'success',
        ),
    )
    .map((call) => call.id)
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
 * 折叠线：最后一个不保留的单元的下标。`-1` 表示尾部尚未累积足够的保留预算，没有可折叠的单元。
 *
 * 先累加后判定，使总量超过预算的那个单元本身也被保留；例外是模型已查看该单元、且它本身即超过保留量：
 * 那是一段数十万 token 的续读投递，整段保留时压缩后占用仍接近软阈值，下一段只剩一份保留量的空间。
 * 模型尚未查看的最后一个单元始终保留。
 */
function foldIndexOf(units: Unit[], retain: number, latestUnitSeen: boolean): number {
  let spent = 0
  for (let i = units.length - 1; i >= 0; i--) {
    spent += units[i]!.tokens
    if (spent < retain) continue
    const seen = i < units.length - 1 || latestUnitSeen
    return seen && units[i]!.tokens > retain ? i : i - 1
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
      data?: unknown
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
    lines: linesOf(payload?.outcome?.data),
  }
}

/** 按行读取的结果带起止行号与总行数（`read_file`）；其余结果没有这三项。 */
function linesOf(data: unknown): { from: number; to: number; total: number } | null {
  const d = data as
    | { startLine?: unknown; endLine?: unknown; totalLines?: unknown }
    | null
    | undefined
  return typeof d?.startLine === 'number' &&
    typeof d.endLine === 'number' &&
    typeof d.totalLines === 'number'
    ? { from: d.startLine, to: d.endLine, total: d.totalLines }
    : null
}
