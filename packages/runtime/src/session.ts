/**
 * 把 store / adapter / registry / loop 接成一个可执行的 run。
 *
 * 这是唯一的装配点：TUI、`qy exec`、`qy serve` 都从这里起 run，
 * 不各自再拼一遍——三套装配就是三套会漂移的行为。
 */

import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import {
  AgentLoop,
  type CompactionPort,
  decideCommand,
  type LoopPersistence,
  type PermissionVerdict,
  type Summarizer,
  type ToolContext,
  ToolRegistry,
} from '@qywork/agent'
import {
  buildAdapter,
  type ContentBlock,
  computeCost,
  type ProviderProfile,
  type ProviderUsage,
  type WireToolCall,
} from '@qywork/ai'
import type {
  AgentEvent,
  Attachment,
  Conversation,
  ConversationId,
  MessageId,
  RunId,
} from '@qywork/core'
import {
  appendMessage,
  appendStep,
  appendTextToStep,
  type ContentStore,
  createConversation,
  createRun,
  fileReadHash,
  finishRun,
  getConversation,
  getRun,
  latestAnchoredProviderRequest,
  listDisabledExtras,
  markProviderRequestSent,
  markRunRunning,
  markRunSuperseded,
  markStepExecuting,
  openProviderRequest,
  recordFileRead,
  recordUsage,
  type Store,
  settleProviderRequest,
  settleRunningSteps,
  settleToolStep,
  touchRun,
  updateRunUsage,
  upsertWorkspace,
} from '@qywork/store'
import {
  loadScopedMemories,
  normalizeAdditionalDirectories,
  registerBuiltinTools,
  resolveInWorkspace,
  scanSkills,
  scopeRoots,
  selectMemories,
} from '@qywork/tools'
import { RuntimeCompaction } from './compaction.ts'
import { collectSecrets, type QyConfig, resolveApiKey, resolveModel } from './config.ts'
import { acquireExtensions, type Extensions, releaseExtensions } from './extensions.ts'
import { buildSystemPrompt, buildTailNotes } from './prompt.ts'
import { RuntimeSink } from './sink.ts'
import { buildHistory } from './transcript.ts'

export interface SessionOptions {
  store: Store
  config: QyConfig
  workspaceRoot: string
  /**
   * 正文库。不传 = 本次执行不落盘中间资源，超预算的输出只截断不保存。
   * `qy exec` 这类一次性执行可以省掉它；`qy serve` 必须给。
   */
  content?: ContentStore
  signal: AbortSignal
  /**
   * 追加到冻结前缀末尾的角色约束。Agent Team 的成员会话用它承载角色提示词。
   *
   * 放在前缀里而不是尾区：角色约束在整个子会话里逐字不变，进前缀能吃到缓存；
   * 而它每个角色一份、角色各自独立会话，不存在互相冲缓存的问题。
   */
  extraSystem?: string
  /**
   * 只注册这些工具。**空数组与不传语义不同**：空数组 = 纯分析角色，一个工具都不给；
   * 不传 = 全部内置工具。合并这两者会让「只让它读、不让它写」这类配置静默失效。
   */
  allowedTools?: string[]
  /**
   * 本会话单轮的步数上限。不传 = 用 loop 的默认值。
   *
   * 存在的理由是 Agent Team 的 `Role.maxSteps`：一个角色跑飞会把整轮拖垮，
   * 而那个字段此前**解析了但没有任何人消费**——配了不生效。
   */
  maxSteps?: number
}

/** 重试：复用原 run 的用户消息与高水位，不新增消息。 */
export interface RetrySource {
  runId: RunId
  userMessageId: MessageId | null
  messageIdUpperBound: MessageId | null
}

export interface AskOptions {
  /** 本轮强制用这个模型；不传则用会话当前模型。 */
  model?: string
  retryOf?: RetrySource
  /** 幂等键。同一 (conversationId, clientRequestId) 不会起两个 run。 */
  clientRequestId?: string
  /**
   * 本条消息带的附件。
   *
   * **只存定位事实（工作区相对路径），不把字节塞进消息**——这是 `Attachment`
   * 本来的约定（`core/domain/model.ts`）。正文在装配请求时才从磁盘读，
   * 所以历史里躺着的是路径，几十轮之后读历史也不会拖着几 MB base64。
   */
  attachments?: Attachment[]
  /**
   * 这一轮**新建**会话时给它打的来源标记（续跑已有会话时无效）。
   *
   * 不填 = `null` = 用户会话，会出现在会话列表里。编排产生的成员子会话
   * 必须填 `'workflow'`：`listConversations` 的判据是 `source IS NULL`，
   * 不填的话每跑一次 team、列表里就多出 N 条以成员 prompt 开头的条目，
   * 而那些会话用户点进去也没有意义——它们由父会话的协作视图展示。
   */
  source?: Conversation['source']
  sourceRef?: string
}

export class Session {
  private readonly registry = new ToolRegistry()
  private readonly workspaceId: string
  private seqCounter = new Map<string, number>()

  /**
   * 技能与记忆索引的缓存。
   *
   * tailNotes 是**同步**回调（loop 每次构造请求都调），而扫描是异步的，
   * 所以在这里缓存，由 ask() 在每轮开始前刷新。
   */
  private skillIndex: { name: string; description: string }[] = []
  /**
   * 本轮选中的记忆**正文**，以及超预算转按需的那些 key。
   *
   * 每 run 选一次（`ask()` 里按当轮 user 文本召回），run 内多次模型调用共用
   * 同一份——否则尾区字节每次请求都变，缓存白丢。青研魔盒
   * `run_stream.py:257-262` 同口径。
   */
  private memoryBodies: { key: string; body: string }[] = []
  private deferredMemories: string[] = []

  /** 已加载的扩展。null = 还没加载过（首次 ask 时加载）。 */
  private extensions: Extensions | null = null

  /**
   * 规范化后的额外根目录。**只算一次**：三个消费者（路径层、静态规则、沙箱）
   * 必须拿到逐字节相同的一份，各自现算迟早会分叉——而分叉的表现是
   * 「某一层放行了，另一层拒绝了」，报错信息互不相干。
   *
   * 校验不通过的条目在这里就被丢掉，用户会在 `configNotices` 里看到原因。
   */
  private readonly extraDirs: string[]

  constructor(private readonly opts: SessionOptions) {
    this.extraDirs = normalizeAdditionalDirectories(opts.config.additionalDirectories).dirs

    if (opts.allowedTools === undefined) {
      registerBuiltinTools(this.registry)
    } else {
      // 先注册到一个临时表再挑：内置集合是 registerBuiltinTools 的私有知识，
      // 在这里另抄一份工具名列表必然与它漂移。
      const all = new ToolRegistry()
      registerBuiltinTools(all)
      const allow = new Set(opts.allowedTools)
      for (const spec of all.list()) {
        if (allow.has(spec.name)) this.registry.register(spec)
      }
    }
    const ws = upsertWorkspace(opts.store, opts.workspaceRoot, basename(opts.workspaceRoot))
    this.workspaceId = ws.id
  }

  /**
   * 按模型解析出该走哪个接口。
   *
   * 模型是会话级的，而 API Key / baseUrl 挂在接口上，所以「切模型」实质是
   * 「切接口 + 切模型」。规则见 `resolveModel`——解析只有那一份，
   * 界面上列出来的协议和这一轮真的发出去的必须是同一个结论。
   *
   * 曾经这个解析在构造函数里做一次就固定了，导致会话级模型切换无从生效。
   */
  private resolveProfile(model?: string): ProviderProfile {
    const { providers, active } = this.opts.config
    const stored = resolveModel(this.opts.config, model)
    if (!stored) {
      throw new Error(
        `配置里没有名为 "${active.provider}" 的接口。可用：${Object.keys(providers).join(', ') || '（空）'}`,
      )
    }
    return {
      kind: stored.kind,
      apiKey: resolveApiKey(stored),
      model: stored.model,
      ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
      ...(stored.maxOutputTokens ? { maxOutputTokens: stored.maxOutputTokens } : {}),
      ...(stored.headers ? { headers: stored.headers } : {}),
      ...(stored.capabilities ? { capabilities: stored.capabilities } : {}),
    }
  }

  /**
   * 每轮新建 loop：adapter 绑定具体模型，模型可能刚被切过。
   *
   * 注意这与「ToolContext 每轮只建一个」不冲突——那条说的是**一个 run 内部**
   * 不能每波次重建（会丢读文件状态），run 之间重建是必须的。
   */
  private makeLoop(
    model: string,
    conversationId: ConversationId,
    compaction?: CompactionPort,
  ): AgentLoop {
    return new AgentLoop({
      adapter: buildAdapter(this.resolveProfile(model)),
      registry: this.registry,
      systemPrompt: this.opts.extraSystem
        ? `${buildSystemPrompt()}\n\n## 角色\n\n${this.opts.extraSystem}`
        : buildSystemPrompt(),
      // 索引每轮重扫：用户可能在会话进行中装了技能或改了记忆。
      // 扫的是目录项不是文件内容，代价可忽略。
      tailNotes: () =>
        buildTailNotes({
          workspaceRoot: this.opts.workspaceRoot,
          platform: process.platform,
          skills: this.skillIndex,
          memories: this.memoryBodies,
          deferredMemories: this.deferredMemories,
        }),
      makeToolContext: (runId, emit) =>
        this.makeToolContext(runId, emit, model, conversationId as ConversationId),
      persist: this.makePersistence(),
      ...(compaction ? { compaction } : {}),
    })
  }

  /**
   * 摘要生成器：用**同一个 provider 档案**，但独立于主循环发一次请求。
   *
   * 刻意不带工具、不带冻结前缀——摘要任务只需要文本进文本出，
   * 带上工具 schema 只会让这次调用也逼近容量上限，而它恰恰是在容量已经超了的时候发的。
   */
  private makeSummarizer(model: string): Summarizer {
    return async (prompt, budgetChars) => {
      const profile = this.resolveProfile(model)
      const adapter = buildAdapter(profile)
      let text = ''
      // 摘要也花钱。它不属于任何一个 run 的 usage，所以在账本出现之前
      // **这笔钱是完全看不见的**——压缩越频繁，账单和界面上的数字差得越多。
      let spent: { cost: number; u: ProviderUsage } | null = null
      for await (const ev of adapter.stream({
        model: adapter.spec.id,
        system: [{ text: '你是会话摘要器。只输出摘要正文。' }],
        messages: [{ role: 'user', content: prompt }],
        tools: [],
        // 摘要的输出上限按字符预算折算，留一倍余量。
        maxOutputTokens: Math.min(adapter.spec.maxOutputTokens, Math.ceil(budgetChars / 2)),
        signal: this.opts.signal,
      })) {
        if (ev.type === 'text_delta') text += ev.delta
        else if (ev.type === 'usage') {
          spent = { cost: computeCost(adapter.spec, ev.usage), u: ev.usage }
        }
      }
      if (spent) {
        recordUsage(this.opts.store, {
          kind: 'summary',
          workspaceId: this.workspaceId,
          model: adapter.spec.id,
          provider: profile.kind,
          inputTokens: spent.u.inputTokens,
          outputTokens: spent.u.outputTokens,
          cachedTokens: spent.u.cachedTokens,
          cacheWriteTokens: spent.u.cacheWriteTokens,
          reasoningTokens: spent.u.reasoningTokens,
          cost: spent.cost,
          currency: adapter.spec.pricing.currency ?? 'USD',
        })
      }
      return text.trim() || null
    }
  }

  /** 新建或续跑一个会话。返回事件流，调用方自己决定怎么渲染。 */
  async *ask(
    prompt: string,
    existing?: ConversationId,
    options?: AskOptions,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const { store, config } = this.opts
    const retryOf = options?.retryOf

    const conversationId =
      existing ??
      createConversation(store, {
        workspaceId: this.workspaceId as never,
        model: options?.model ?? config.active.model,
        title: prompt.slice(0, 60),
        ...(options?.source ? { source: options.source } : {}),
        ...(options?.sourceRef ? { sourceRef: options.sourceRef } : {}),
      }).id

    // 模型优先级：本轮显式指定 > 会话当前模型 > 配置默认。
    // **会话是权威**——config 只在会话还没有模型时兜底，否则用户在界面上切了模型，
    // 下一轮又被配置文件里的默认值悄悄改回去。
    const conversation = getConversation(store, conversationId)
    const model = options?.model ?? conversation?.model ?? config.active.model
    // 思考强度**按这一轮真正要用的那个模型解析**，真源是配置里
    // 「接口 × 模型」那一格。不存会话级的第二份，也不共用一个全局值——
    // 档位集合逐模型不同（见 `StoredModel.effort`），全局值套过去必然错配。
    const effort = resolveModel(config, model)?.effort

    // 重试不新增消息：要重现的是「当时那个上下文」。新写一条会让同一句话
    // 在历史里出现两遍，模型看到的输入和第一次就不一样了。
    const userMessageId = retryOf
      ? retryOf.userMessageId
      : appendMessage(store, {
          conversationId,
          role: 'user',
          content: prompt,
          ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
        }).id

    const run = createRun(store, {
      conversationId,
      workspaceId: this.workspaceId as never,
      model,
      clientRequestId: options?.clientRequestId ?? crypto.randomUUID(),
      userMessageId,
      // 高水位：新轮定格在刚写入的消息；重试继承原 run 的，
      // 否则重试期间用户新发的消息会被卷进来——那就不是重试了。
      messageIdUpperBound: retryOf ? retryOf.messageIdUpperBound : userMessageId,
      ...(retryOf ? { retryOfRunId: retryOf.runId } : {}),
    })
    markRunRunning(store, run.id)
    // 接替关系在新 run 落库之后才写：先写会短暂存在「指向一个还不存在的 run」的状态，
    // 那个瞬间崩溃就留下一条悬空引用。
    if (retryOf) markRunSuperseded(store, retryOf.runId, run.id)

    /*
     * 历史 = 消息 + **由 steps 投影出来的 assistant/tool 回合**。
     *
     * 这里曾经只映射 `listMessages`。而那张表只有 user 行——全项目唯一的
     * `appendMessage` 就在上面几行，写的是 `role:'user'`。于是第二轮起模型拿到的
     * 输入字面上是「用户说了三次话，我一次都没回过」，跨轮结构性失忆。
     *
     * **被接替的 run 不折**。前端对 superseded 是「打标仍渲染」给人看
     * （`connection.ts`），模型侧没有等价标记位，只有折或不折；照抄会让模型看到
     * 「失败尝试 + 重试」两遍同一件事，结论还可能互相矛盾。重试的语义本来就是
     * 「重现当时那个上下文」，不带失败尝试。两处口径**刻意不同**，各自带测试。
     */
    const history = await buildHistory(
      store,
      conversationId,
      run.messageIdUpperBound,
      (content, list) => withAttachments(this.opts.workspaceRoot, content, list as Attachment[]),
    )

    /*
     * 把账本里最后一次真值回执带给 loop 当锚点。
     *
     * 覆盖边界取那次回执所属 run 的消息高水位——它之后的历史消息是锚点没算过的。
     * 没有回执（新会话、或一直没拿到 usage）就不传，loop 退回本地估算并如实
     * 标 `estimated`。
     */
    const anchored = latestAnchoredProviderRequest(store, conversationId)
    const anchorRun = anchored ? getRun(store, anchored.runId) : null
    const anchor = anchored
      ? {
          tokens:
            (anchored.providerInputTokens ?? 0) +
            (anchored.providerCachedTokens ?? 0) +
            (anchored.providerCacheWriteTokens ?? 0) +
            (anchored.providerOutputTokens ?? 0),
          throughMessageId: anchorRun?.messageIdUpperBound ?? null,
        }
      : null

    // run.started 必须由这里发：协议早就定义了它，但一直没有发送方——
    // 于是客户端拿不到真实 runId，中断和重试都在拿步骤 id 当 run id 用，
    // 服务端查不到就静默什么也不做。**协议里有类型不等于有实现**。
    yield {
      type: 'run.started',
      runId: run.id,
      conversationId,
      model,
      userMessageId: userMessageId ?? null,
      retryOfRunId: retryOf?.runId ?? null,
    }

    // 压缩端口绑定到本会话与本 run 的高水位：压缩范围不得越过 run 创建时定格的水位，
    // 否则会把排队期间新到的消息一起压掉——那些消息本轮根本还没看到。
    const compaction = new RuntimeCompaction({
      store,
      conversationId,
      messageIdUpperBound: run.messageIdUpperBound,
      summarize: this.makeSummarizer(model),
    })

    // 这条会话关掉了哪些技能 / MCP / 插件 / 记忆。**没有行 = 全开**，
    // 所以新装的东西默认就在，不需要给历史会话补什么。
    const disabled = listDisabledExtras(store, conversationId)

    // 扩展按工作区共享、引用计数持有：插件与 MCP 都是子进程，每条消息
    // 重起一遍既慢又会丢掉它们的进程内状态。会话只负责把工具规格注册进自己的表。
    if (!this.extensions) {
      await this.loadExtensionTools(disabled)
    }

    // 刷新索引。失败不影响主流程——没有技能索引只是模型少一条线索，
    // 而让整轮 run 因为扫目录失败而挂掉是不成比例的。
    //
    // 关掉的那些**从索引里拿掉**：索引是模型判断「有没有这个技能」的唯一依据，
    // 留在索引里而调用时才拒绝，等于让它去撞一堵看不见的墙。
    const roots = scopeRoots(this.opts.workspaceRoot)
    this.skillIndex = (await scanSkills(roots).catch(() => [])).filter(
      (s) => !disabled.has(`skill:${s.name}`),
    )
    /*
     * 记忆按**当轮 user 文本**召回正文，每 run 选一次。
     *
     * 改成正文的理由见 `prompt.ts`：目录制下模型得自己判断哪条相关，
     * 判断错了那条记忆这一轮就等于不存在，而且不报错、看不出来。
     *
     * 选一次而不是每次请求选：召回结果随查询变，run 内每次重选会让尾区字节
     * 每次请求都变一遍，缓存白丢。
     */
    const memories = (await loadScopedMemories(roots).catch(() => [])).filter(
      (m) => !disabled.has(`memory:${m.key}`),
    )
    const picked = selectMemories(memories, prompt)
    this.memoryBodies = picked.selected.map((m) => ({ key: m.key, body: m.body }))
    this.deferredMemories = picked.deferred

    /*
     * 心跳：**告诉别的进程「这一轮还有人在跑」。**
     *
     * 账本是共享的，一台机器上同时有好几个写入者（两个工作区的 sidecar、
     * 开发态热重载、终端里的 `qy exec`）。后起的那个进程在启动时回收残留 run，
     * 判据就是这个心跳加 `owner_pid`（见 `store/repos.ts` 的 `isOrphan`）——
     * 不推心跳的话，别人一启动就把这条正在跑的判成中断。
     *
     * `unref()`：它不该成为「进程关不掉」的理由。
     */
    const heartbeat = setInterval(() => touchRun(store, run.id), HEARTBEAT_MS)
    heartbeat.unref?.()

    let finished = false
    try {
      for await (const ev of this.makeLoop(model, conversationId, compaction).run({
        runId: run.id,
        history,
        ...(effort ? { effort } : {}),
        ...(this.opts.maxSteps ? { maxSteps: this.opts.maxSteps } : {}),
        cacheKey: conversationId,
        signal: this.opts.signal,
        // 上一轮的真值带进来，这一轮开头就用同一把尺。不带的话每个 run 的
        // 第一次请求只能报估算（系统性偏低），第二次起弹回真值——
        // 用户看到的就是每轮开头掉一次。
        ...(anchor ? { anchor } : {}),
      })) {
        if (ev.type === 'run.finished') {
          finished = true
          finishRun(store, run.id, { status: ev.status, stopReason: ev.stopReason })
          // 账本在**收尾时记一次**。中途的 usage 是累计值，每次都记会把同一笔钱
          // 记很多遍；而 run 上那份 usage 会随会话删除一起消失，答不了
          // 「这个月花了多少」。
          recordUsage(store, {
            kind: 'run',
            runId: run.id,
            conversationId,
            workspaceId: this.workspaceId,
            model,
            provider: this.resolveProfile(model).kind,
            inputTokens: ev.usage.inputTokens,
            outputTokens: ev.usage.outputTokens,
            cachedTokens: ev.usage.cachedTokens,
            cacheWriteTokens: ev.usage.cacheWriteTokens,
            reasoningTokens: ev.usage.reasoningTokens,
            cost: ev.usage.cost,
            currency: ev.usage.currency,
          })
        }
        yield ev
      }
    } finally {
      // 心跳先停。停晚了不要紧（只推 running 的行），但停在最前面才保证
      // 无论下面哪一步抛异常都不会留下一个还在推心跳的定时器。
      clearInterval(heartbeat)
      // 生成器被提前关闭（用户 Ctrl-C、客户端断连）时也要给 run 一个终态，
      // 否则账本里会永远躺着一条 running 的孤儿记录。
      if (!finished) {
        finishRun(store, run.id, { status: 'interrupted', stopReason: 'user_interrupt' })
      }
      // **step 也要落终态，不只是 run。**
      //
      // 这里曾经只收 run。而 `tool.started` 的 yield 处被 `.return()` 掐断时，
      // step 已经是 running 却没人settle——run 随即被标成终态，于是那条 step
      // 永远碰不到启动时的 `recoverStaleRuns`（它只扫 running/queued 的 run）。
      //
      // 代价不是 UI 上一张转圈的卡：历史投影必须跳过含未终结调用的整个 batch，
      // 一条孤儿会让同批次里**已经成功的写文件结果一起从历史里消失**。
      settleRunningSteps(store, run.id)
    }
  }

  /**
   * 取扩展并把它们贡献的工具注册进本会话的表。
   *
   * 注册失败（重名）只跳过那一个工具：让整个会话因为一个撞名的插件工具起不来，
   * 代价完全不成比例。
   */
  private async loadExtensionTools(disabled: ReadonlySet<string> = new Set()): Promise<void> {
    const ext = await acquireExtensions(this.opts.workspaceRoot, (line) =>
      process.stderr.write(`${line}
`),
    )
    this.extensions = ext

    // 角色的 allowedTools 同样约束插件与 MCP 工具。
    // 只过滤内置工具的话，一个「只读」角色照样能调插件里的写工具。
    const allow = this.opts.allowedTools ? new Set(this.opts.allowedTools) : null
    // 会话级开关关掉的那些**根本不注册**，而不是注册完再拦。
    // 注册完再拦的话模型仍然在 schema 里看得见它，会反复去调一个必然失败的工具。
    const off = (spec: { name: string }) => {
      const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(spec.name)
      if (mcp) return disabled.has(`mcp:${mcp[1]}`)
      const plugin = /^(.+?)__/.exec(spec.name)
      return plugin ? disabled.has(`plugin:${plugin[1]}`) : false
    }
    for (const spec of ext.toolSpecs) {
      if (allow && !allow.has(spec.name)) continue
      if (off(spec)) continue
      if (this.registry.has(spec.name)) continue
      try {
        this.registry.register(spec)
      } catch (err) {
        process.stderr.write(`[qy] 工具注册失败 ${spec.name}：${String(err)}
`)
      }
    }

    // 名字写错了要说出来。静默忽略的话，配了 "read_files"（多了个 s）
    // 的角色会安安静静地一个工具都没有，表现为「它什么也不干」。
    //
    // 判定必须**等扩展加载完**再做：插件和 MCP 工具是异步来的，
    // 在构造函数里只比内置集合的话，一个合法的 `mcp__github__x` 会被报成
    // 「未知工具名」——让人去查一个根本不存在的问题，比不提示更糟。
    if (allow) {
      const unknown = [...allow].filter((n) => !this.registry.has(n))
      if (unknown.length) {
        process.stderr.write(
          `[qy] 角色 allowedTools 里有未知工具名，已忽略：${unknown.join('、')}\n`,
        )
      }
    }

    for (const f of ext.plugins.failures) {
      process.stderr.write(`[qy] 插件加载失败 ${f.dir}：${f.reason}\n`)
    }
    for (const f of ext.mcp.failures) {
      process.stderr.write(`[qy] MCP ${f.server}：${f.reason}\n`)
    }
  }

  /** 已装载的扩展，供 server 报真实能力清单。 */
  async capabilities(): Promise<{
    plugins: string[]
    teamBackends: string[]
    mcpServers: string[]
  }> {
    if (!this.extensions) await this.loadExtensionTools()
    return {
      plugins: this.extensions!.plugins.plugins.map((p) => p.manifest.id),
      teamBackends: Object.keys(this.extensions!.team.backends),
      mcpServers: this.extensions!.mcp.servers.map((s) => s.name),
    }
  }

  /**
   * 释放本会话对扩展的引用。会话结束时**必须调**。
   *
   * 不直接 stop：扩展是按工作区共享的，别的会话可能还在用。
   * 引用归零时才真的关子进程。
   *
   * 这个方法此前存在但**全项目没有一个调用点**——于是 server 每条消息新建的
   * Session 各自起了一套插件子进程，一个都没关。协议里有类型不等于有实现，
   * 公开方法有定义同样不等于有人调。
   */
  dispose(): void {
    if (!this.extensions) return
    this.extensions = null
    releaseExtensions(this.opts.workspaceRoot)
  }

  private nextSeq(runId: string): number {
    const next = (this.seqCounter.get(runId) ?? 0) + 1
    this.seqCounter.set(runId, next)
    return next
  }

  private makePersistence(): LoopPersistence {
    const { store } = this.opts
    return {
      nextSeq: (runId) => this.nextSeq(runId),
      openTextStep: (runId, seq) => appendStep(store, { runId, seq, kind: 'text', content: '' }).id,
      appendText: (stepId, delta) => appendTextToStep(store, stepId as never, delta),
      openToolStep: (
        runId,
        seq,
        call: WireToolCall,
        batchId,
        callIndex,
        waveIndex,
        action,
        reasoning,
      ) =>
        appendStep(store, {
          runId,
          seq,
          kind: 'tool_action',
          toolName: call.name,
          toolCallId: call.id,
          providerBatchId: batchId,
          callIndex,
          executionWaveIndex: waveIndex,
          status: 'running',
          // 思考正文借 `content` 落库——tool_action 行的这一列本来就是空的，
          // 为它单开一列等于给同一件事建第二个位置。读法见投影函数。
          ...(reasoning ? { content: reasoning } : {}),
          // action 必须落库：它由 ToolSpec 按参数解析，前端回猜不出来。
          payload: { kind: 'tool_call', args: call.arguments, action },
        }).id,
      markExecuting: (stepId) => markStepExecuting(store, stepId as never),
      settleTool: (stepId, status, outcome, args, action) =>
        settleToolStep(store, stepId as never, status, {
          kind: 'tool_result',
          args,
          outcome,
          action,
        }),
      saveUsage: (runId, usage) => updateRunUsage(store, runId, usage),
      recordCompaction: (runId, seq, status, payload) => {
        appendStep(store, {
          runId,
          seq,
          kind: 'compaction',
          status,
          payload: { kind: 'compaction', ...payload },
        })
      },
      openRequest: (input) => openProviderRequest(store, input).id,
      markRequestSent: (requestId) => markProviderRequestSent(store, requestId as never),
      settleRequest: (requestId, status, usage, errorCode) =>
        settleProviderRequest(store, requestId as never, status, usage, errorCode),
    }
  }

  /**
   * 授权裁决。**只有两种模式，不弹窗。**
   *
   * ## `full` 也不豁免的那一条
   *
   * 硬边界（凭证剥离、路径约束）不在这里——它们分别由 `scrubEnv` 和
   * `resolveInWorkspace` 在更靠下的地方强制执行，两种模式一视同仁。
   * 这里裁决的是「这次调用要不要放行」，而 `full` 的定义就是「不裁决」。
   *
   * ## `auto` 下谁走哪条路
   *
   * 判据是**这件事是谁决定的**，不是「代码从哪来」：
   *
   * - **文件与网络类**（read/write/delete/network）：路径已经被
   *   `resolveInWorkspace` 锁死、外发已经过 SSRF 闸，都是**确定性**判断，
   *   越界的根本走不到这里。所以放行，不必再花一次往返去问模型。
   * - **MCP 与插件工具**：是用户显式配置/安装的，属于知情同意，放行。
   *   这与 pi 和 Claude Code 的立场一致——不为用户自己选的东西造第三套闸。
   * - **`run_command`**：唯一一条能同时绕开路径约束和 SSRF 闸的路径
   *   （命令字符串里的路径不经过我们的参数解析）。只有它需要真正的裁决。
   */
  private async decide(
    scope: string,
    meta: { toolName: string; args: Record<string, unknown> } | undefined,
  ): Promise<PermissionVerdict> {
    if ((this.opts.config.mode ?? 'auto') === 'full') return { allowed: true }

    if (meta?.toolName !== 'run_command') return { allowed: true }

    const command = String(meta.args.command ?? '')
    // 根目录清单必须与路径层、沙箱层是**同一份**。三处各算各的，
    // 表现就是「配了但只有一层生效」，而三层的报错互不相干。
    const d = decideCommand(command, {
      workspaceRoot: this.opts.workspaceRoot,
      ...(this.extraDirs.length ? { additionalDirectories: this.extraDirs } : {}),
    })
    if (d.kind === 'allow') return { allowed: true }
    return { allowed: false, reason: `${d.reason}（scope ${scope}）。换一条不做这件事的命令。` }
  }

  private makeToolContext(
    runId: RunId,
    emit: (e: AgentEvent) => void,
    model: string,
    conversationId: ConversationId,
  ): ToolContext {
    const secrets = collectSecrets(this.opts.config)
    const store = this.opts.store
    return {
      workspaceRoot: this.opts.workspaceRoot,
      conversationId,
      runId,
      model,
      // 投递预算按窗口算，且**在执行时**应用——换模型只影响之后的读取，
      // 已落库的 step 一个字节不改（投影因此仍是纯函数）。
      contextWindow: buildAdapter(this.resolveProfile(model)).spec.contextWindow,
      resources: new Map(),
      state: new Map(),
      // sink 绑定到本 run：登记行要能追溯到哪一轮产生的正文，
      // run 被删时引用随之消失，GC 才能把正文回收掉。
      sink: this.opts.content ? new RuntimeSink(this.opts.store, this.opts.content, runId) : null,
      /*
       * 读记录绑定到**会话**，不是 run。
       *
       * 服务端每条消息新建一个 Session（`run-control.ts`），所以进程里没有
       * 「会话级」这个生命周期可挂——真源放账本，随会话删除一起走。
       * 挂在 run 上的后果是每轮第一次改文件必然先失败一次「没读取过」，
       * 而这条守卫要回答的是「你写的还是你读到的那份吗」，与 run 边界无关。
       */
      reads: {
        seen: (path) => fileReadHash(store, conversationId, path),
        mark: (path, hash) => recordFileRead(store, conversationId, path, hash),
      },
      signal: this.opts.signal,
      emit: (channel, delta) => {
        emit({ type: 'tool.delta', runId, stepId: '' as never, channel, delta })
      },
      emitTodos: (todos) => {
        emit({ type: 'todos', runId, todos })
      },
      secrets,
      ...(this.opts.config.envAllowList ? { envAllowList: this.opts.config.envAllowList } : {}),
      ...(this.extraDirs.length ? { additionalDirectories: this.extraDirs } : {}),
      requestPermission: async (scope, _preview, meta) => this.decide(scope, meta),
    }
  }
}

/** 心跳间隔。回收那边按 60 秒判过期（`store/repos.ts`），六倍余量。 */
const HEARTBEAT_MS = 10_000

const NEWLINE = String.fromCharCode(10)

/**
 * 把附件读成 provider 认得的内容块。
 *
 * ## 为什么在这里读，而不是在存的时候
 *
 * 消息表里只放路径（`Attachment.path`）。存 base64 的话，每次读历史都要把
 * 几 MB 的图片一起拖出来，而绝大多数轮次根本用不到它。
 *
 * ## 读不出来不是致命错
 *
 * 文件被用户删了、改名了、换了工作区——这些都会发生。**跳过那一个附件并在
 * 文本里留一行说明**，而不是让整轮对话起不来：模型看到「这里原本有张图，
 * 现在读不到了」还能继续干活，看到一个 500 就只能重来。
 */
async function withAttachments(
  workspaceRoot: string,
  text: string,
  attachments: Attachment[],
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = []
  const notes: string[] = []

  for (const a of attachments) {
    // 走同一条工作区边界：附件路径是客户端给的，不能例外。
    const abs = await resolveInWorkspace(workspaceRoot, a.path, { mustExist: true }).catch(
      () => null,
    )
    if (!abs) {
      notes.push(`（附件 ${a.name} 已不存在，跳过）`)
      continue
    }
    const bytes = await readFile(abs).catch(() => null)
    if (!bytes) {
      notes.push(`（附件 ${a.name} 读取失败，跳过）`)
      continue
    }
    if (a.type === 'image') {
      blocks.push({ type: 'image', mimeType: a.mime, data: bytes.toString('base64') })
    } else {
      // 非图片按文档块投递；provider 不支持时适配层会自行降级。
      blocks.push({
        type: 'document',
        mimeType: a.mime,
        data: bytes.toString('base64'),
        title: a.name,
      })
    }
  }

  // 文本块放最后：附件是这句话的**语境**，先看图再读要求更符合阅读顺序。
  const body = notes.length ? [text, ...notes].join(NEWLINE) : text
  blocks.push({ type: 'text', text: body })
  return blocks
}
