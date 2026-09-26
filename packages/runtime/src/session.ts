/**
 * 把 store / adapter / registry / loop 接成一个可执行的 run。
 *
 * 这是唯一的装配点：TUI、`qy exec`、`qy serve` 都从这里起 run，
 * 不各自再拼一遍——三套装配就是三套会漂移的行为。
 */

import { stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import {
  AgentLoop,
  type BrowserPort,
  type CompactionPort,
  type DelegatePort,
  type DesktopPort,
  decideCommand,
  envelopeResult,
  type HistoryPort,
  type HistoryStep,
  imagesOf,
  type LoopPersistence,
  type PermissionVerdict,
  type PluginPort,
  type Summarizer,
  type ToolContextBase,
  ToolRegistry,
} from '@qywork/agent'
import {
  buildAdapter,
  type ChatRequest,
  type ContentBlock,
  computeCost,
  type LlmAdapter,
  ProviderError,
  type ProviderProfile,
  type ProviderUsage,
  STREAM_IDLE_TIMEOUT_MS,
  type TokenDensity,
  type WireToolCall,
} from '@qywork/ai'
import type {
  AgentEvent,
  Attachment,
  Conversation,
  ConversationId,
  EffortLevel,
  FollowUp,
  GoalWriteResult,
  MediaSpend,
  RunId,
  RunInterruption,
  RunUsage,
  Step,
  StepId,
  WorkflowProjection,
} from '@qywork/core'
import {
  deriveConversationTitle,
  envelopeHeadTokens,
  foldWorkflow,
  isInlineImage,
  isInlineVideo,
  log,
  mimeOf,
  toPosixPath,
} from '@qywork/core'
import {
  appendMessage,
  appendStep,
  appendTextToStep,
  type ContentStore,
  createConversation,
  createRun,
  createSchedule,
  currentGoal,
  deleteSchedule,
  failThinkingSteps,
  fileReadHash,
  finishRun,
  getConversation,
  getRun,
  hasReceivedRequestWithImages,
  latestAnchoredProviderRequest,
  latestTodos,
  listLoadedTools,
  listMessages,
  listRuns,
  listSchedules,
  listSteps,
  listWorkflowRecords,
  markProviderRequestContent,
  markProviderRequestFirstEvent,
  markProviderRequestHeaders,
  markProviderRequestInputImages,
  markProviderRequestSent,
  markRunRunning,
  markStepExecuting,
  openProviderRequest,
  recordFileRead,
  recordLoadedTools,
  recordProviderRequestDiagnostic,
  recordUsage,
  type Store,
  setConversationTitle,
  settleProviderRequest,
  settleRunningSteps,
  settleToolStep,
  touchRun,
  updateGoal,
  updateRunMedia,
  updateRunUsage,
  upsertWorkspace,
  workflowIdsOf,
} from '@qywork/store'
import {
  EXTERNAL_SCHEMA_BUDGET_TOKENS,
  externalSchemaTokens,
  listScopedEntries,
  MEDIA_TOOLS,
  makeLoadToolTool,
  normalizeAdditionalDirectories,
  PendingToolPool,
  redactSecrets,
  registerBuiltinTools,
  scanSkills,
  scopeRoots,
} from '@qywork/tools'
import { RuntimeCompaction } from './compaction.ts'
import {
  collectSecrets,
  listMediaModels,
  type ModelRef,
  NO_MODEL_MESSAGE,
  type QyConfig,
  resolveModel,
} from './config.ts'
import { acquireExtensions, type Extensions, releaseExtensions } from './extensions.ts'
import { makeMcpConfigPort } from './mcp-config-store.ts'
import { makeMediaPort } from './media.ts'
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
   * 放在冻结前缀而不是运行上下文：角色约束在整个子会话里逐字不变，进前缀能吃到缓存；
   * 而它每个角色一份、角色各自独立会话，不存在互相冲缓存的问题。
   */
  extraSystem?: string
  /**
   * 只注册这些工具。**空数组与不传语义不同**：空数组 = 纯分析角色，一个工具都不给；
   * 不传 = 全部内置工具。合并这两者会让「只让它读、不让它写」这类配置静默失效。
   */
  allowedTools?: string[]
  /**
   * 派活通道。见 `DelegatePort`。
   *
   * **只给顶层会话传**：成员会话不传，因此它那边连 `subagent` 工具都不注册，
   * 递归派活在结构上不可能发生。
   */
  delegate?: DelegatePort
  /**
   * 装插件通道。见 `PluginPort`。
   *
   * **只给顶层会话传**：成员会话不传，因此它那边连 `install_plugin` 都不注册。
   */
  plugins?: PluginPort
  /**
   * 内置浏览器通道。见 `BrowserPort`。
   *
   * 由装配方依据当前是否存在可用的原生宿主实时判定后传入；没传即这一轮没有浏览器能力。
   * 会话结束时 `dispose` 会释放它占着的控制权与未消费的下载授权。
   */
  browser?: BrowserPort
  /**
   * 电脑控制通道。见 `DesktopPort`。
   *
   * 由装配方依据用户的启用开关与当前宿主状态实时判定后传入；没传即这一轮没有
   * 桌面能力。会话结束时 `dispose` 会撤销它名下尚未派发的请求。
   */
  desktop?: DesktopPort
  /**
   * 取走此刻标了「调整方向」的跟进消息。**每个 step 边界调一次。**
   *
   * 队列的真源在服务端的 `RunManager`（进程内，不落盘）；这里把它接到 loop
   * 那条端口上，并把附件解析成内容块——loop 不碰磁盘。
   *
   * **只给顶层会话传**：成员会话与 CLI 没有队列，不传即不注入。
   */
  followUps?: (conversationId: ConversationId) => FollowUp[]
}

export interface AskOptions {
  /** 本轮强制用这个模型；不传则用会话当前模型。 */
  model?: string
  /** 幂等键。同一 (conversationId, clientRequestId) 不会起两个 run。 */
  clientRequestId?: string
  /**
   * 本条消息带的附件。
   *
   * **只存定位事实（工作区相对路径），不把字节塞进消息**——这是 `Attachment`
   * 本来的约定（`core/domain/model.ts`）。正文在装配请求时才从磁盘读，
   * 所以历史里留有的是路径，几十轮之后读历史也不会拖着几 MB base64。
   */
  attachments?: Attachment[]
  /**
   * 这一句是谁投进来的：子 agent 的回执、workflow 的回执，缺席 = 用户本人。
   * 落 `messages.origin`，界面按它把回执行与用户气泡分开。
   */
  origin?: 'subagent' | 'workflow'
  /**
   * 这一轮是哪次派活派出来的：父会话里那张派活卡的 step 与卡上那一格。
   * 落 `runs.dispatch_step_id / dispatch_node_id`，变更投影按它把这一轮的写入归到父轮。
   */
  dispatch?: { stepId: StepId; nodeId: string }
  /**
   * 这一轮**新建**会话时给它打的来源标记（续跑已有会话时无效）。
   *
   * 不填 = `null` = 用户会话，会出现在会话列表里。编排产生的成员子会话
   * 子 agent 的会话必须填它的种类：`listConversations` 的判据是 `source IS NULL`，
   * 不填的话每跑一次 team、列表里就多出 N 条以成员 prompt 开头的条目，
   * 而那些会话用户点进去也没有意义——它们由父会话的协作视图展示。
   */
  source?: Conversation['source']
  sourceRef?: string
  /**
   * 这一轮**新建**会话时它属于哪条父会话（续跑已有会话时无效）。
   *
   * 派活建出来的子会话必须填：账本汇总、级联删除、运行页三件事都从这一个字段推出来，
   * 而归属只在建会话的这一刻写得对，事后从任何地方都推不回来。
   */
  parentConversationId?: ConversationId
}

export class Session {
  private readonly registry = new ToolRegistry()
  private readonly workspaceId: string
  private seqCounter = new Map<string, number>()

  /** 已加载的扩展。null = 还没加载过（首次 ask 时加载）。 */
  private extensions: Extensions | null = null

  /**
   * 外部工具的待加载池。null = 本会话的外置 schema 总量在预算内，全部常驻。
   *
   * 池子里的工具不在注册表里，所以不进请求；模型用 `load_tool` 取出来。
   */
  private pendingTools: PendingToolPool | null = null

  /**
   * 规范化后的额外根目录。**只算一次**：三个消费者（路径层、静态规则、沙箱）
   * 必须拿到逐字节相同的一份，各自现算迟早会分叉——而分叉的表现是
   * 「某一层放行了，另一层拒绝了」，报错信息互不相干。
   *
   * 校验不通过的条目在这里就被丢掉，用户会在 `configNotices` 里看到原因。
   */
  private readonly extraDirs: string[]

  /**
   * 各轮次的生成花费。生成通道成功时追加并写进 `runs.media_usage`（`recordMediaSpend`），
   * 本轮 usage 事件经过 `ask` 时附上，轮次结束时逐条入账后清掉。
   */
  private readonly mediaSpends = new Map<RunId, MediaSpend[]>()
  /** 各轮次最近一次的模型用量。生成花费到达时补推 usage 事件，以它为底。 */
  private readonly modelUsage = new Map<RunId, RunUsage>()

  constructor(private readonly opts: SessionOptions) {
    this.extraDirs = normalizeAdditionalDirectories(opts.config.additionalDirectories).dirs

    /*
     * 用户按下停止的**那一刻**就撤销浏览器控制，不等这一轮收尾。
     *
     * 只在 `dispose()` 里释放的话，中断信号要先穿过 agent 循环、工具执行器和
     * 事件流才轮到它——那段时间里排队的动作还会发到网站上。`release()` 是幂等的，
     * 收尾时再调一次是空操作，不是第二条路径。
     */
    opts.signal.addEventListener(
      'abort',
      () => {
        void this.opts.browser?.release().catch((err) => {
          log.warn(
            'browser',
            `停止时释放浏览器控制失败：${err instanceof Error ? err.message : String(err)}`,
          )
        })
        // 桌面动作同理，而且更急：排队中的 invoke 一旦派发就作用在用户正在看的应用上。
        void this.opts.desktop?.release().catch((err) => {
          log.warn(
            'desktop',
            `停止时撤销电脑控制失败：${err instanceof Error ? err.message : String(err)}`,
          )
        })
      },
      { once: true },
    )

    // 派活与装插件都跟着各自的通道走：成员会话两条都拿不到，因此它那边既没有
    // `subagent`（子 agent 不得再派活，递归没有终止条件），也没有 `install_plugin`
    // （子 agent 不该给整台机器装插件）。
    const withDelegate = {
      delegate: opts.delegate !== undefined,
      plugins: opts.plugins !== undefined,
      mcpConfig: true,
      browser: opts.browser !== undefined,
      desktop: opts.desktop !== undefined,
      // 生成工具按配了模型的类别注册；与其他内置工具同一规则，角色的 allowedTools 点名时按点名过滤。
      media: [...new Set(listMediaModels(opts.config).map((m) => m.output))],
    }
    if (opts.allowedTools === undefined) {
      registerBuiltinTools(this.registry, withDelegate)
    } else {
      // 先注册到一个临时表再挑：内置集合是 registerBuiltinTools 的私有知识，
      // 在这里另抄一份工具名列表必然与它漂移。
      const all = new ToolRegistry()
      registerBuiltinTools(all, withDelegate)
      const allow = new Set(opts.allowedTools)
      for (const spec of all.list()) {
        if (allow.has(spec.name)) this.registry.register(spec)
      }
    }
    const ws = upsertWorkspace(opts.store, opts.workspaceRoot, basename(opts.workspaceRoot))
    this.workspaceId = ws.id
  }

  /**
   * 解析出这一轮该走哪个接口、带什么凭证。
   *
   * 入参是 `ModelRef` 时**接口是指定死的**（会话自己记着归谁），是裸模型名时
   * 按模型 id 反查接口——后者留给 `qy ask --model x` 那种用户点名模型不点名接口
   * 的入口。规则只有 `resolveModel` 那一份：界面上列出来的协议和这一轮真的
   * 发出去的必须是同一个结论。
   *
   * **每次用时现解析**：在构造函数里做一次就固定的话，会话级模型切换无从生效。
   */
  private resolveProfile(target?: string | ModelRef): ProviderProfile {
    const { providers, active } = this.opts.config
    const stored = resolveModel(this.opts.config, target)
    if (!stored) {
      const who = typeof target === 'object' ? target.provider : (active?.provider ?? '（未配置）')
      throw new Error(
        `配置里没有名为 "${who}" 的接口。可用：${Object.keys(providers).join(', ') || '（空）'}`,
      )
    }
    return {
      kind: stored.kind,
      apiKey: stored.apiKey ?? '',
      model: stored.model,
      ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
      ...(stored.headers ? { headers: stored.headers } : {}),
      ...(stored.spec ? { spec: stored.spec } : {}),
      ...(stored.transport ? { transport: stored.transport } : {}),
    }
  }

  /**
   * 每轮新建 loop：adapter 绑定具体模型，模型可能刚被切过。
   *
   * 注意这与「ToolContext 每轮只建一个」不冲突——那条说的是**一个 run 内部**
   * 不能每波次重建（会丢读文件状态），run 之间重建是必须的。
   */
  private makeLoop(
    target: string | ModelRef,
    adapter: LlmAdapter,
    conversationId: ConversationId,
    compaction?: CompactionPort,
  ): AgentLoop {
    // 能力段按已注册的工具名过滤：shell、派活、编排、外部工具都按通道注册。
    const base = buildSystemPrompt(new Set(this.registry.list().map((s) => s.name)))
    const providerName = resolveModel(this.opts.config, target)?.provider
    return new AgentLoop({
      adapter,
      ...(providerName ? { providerName } : {}),
      registry: this.registry,
      systemPrompt: this.opts.extraSystem ? `${base}\n\n## 角色\n\n${this.opts.extraSystem}` : base,
      ...(this.opts.followUps
        ? {
            followUps: async () => {
              const taken = this.opts.followUps?.(conversationId) ?? []
              return Promise.all(
                taken.map(async (f) => ({
                  id: f.id,
                  text: f.content,
                  content: f.attachments?.length
                    ? await withAttachments(this.opts.workspaceRoot, f.content, f.attachments)
                    : f.content,
                  ...(f.attachments?.length ? { attachments: f.attachments } : {}),
                  ...(f.origin ? { origin: f.origin } : {}),
                })),
              )
            },
          }
        : {}),
      makeToolContext: (runId, emit) =>
        this.makeToolContext(runId, emit, target, conversationId as ConversationId),
      persist: this.makePersistence(conversationId),
      ...(compaction ? { compaction } : {}),
    })
  }

  /** 新建或续跑一个会话。返回事件流，调用方自己决定怎么渲染。 */
  async *ask(
    prompt: string,
    existing?: ConversationId,
    options?: AskOptions,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const { store, config } = this.opts

    // 模型优先级：本轮显式指定 > 会话当前模型 > 配置默认。
    // **会话是权威**——config 只在会话还没有模型时兜底，否则用户在界面上切了模型，
    // 下一轮又被配置文件里的默认值静默改回。用 `||` 不用 `??`：没配模型的会话
    // provider/model 落的是空串，空串要当作「未设」继续回退。
    const prior = existing ? getConversation(store, existing) : undefined
    const model = options?.model || prior?.model || config.active?.model
    // 三处都取不到 = 用户还没配模型，起 run 前就在这里拒绝，不建会话、不发请求。
    // 服务端在 `run-control` 里已先拦一道并回结构化 `no_model`；这条是 CLI 与直调的兜底。
    if (!model) throw new Error(NO_MODEL_MESSAGE)

    const conversationId =
      existing ??
      createConversation(store, {
        workspaceId: this.workspaceId as never,
        // 新会话记默认那一对；没有默认接口时按谁挂了这个模型反查。
        provider: config.active?.provider || resolveModel(config, model)?.provider || '',
        model,
        ...(options?.source ? { source: options.source } : {}),
        ...(options?.sourceRef ? { sourceRef: options.sourceRef } : {}),
        ...(options?.parentConversationId
          ? { parentConversationId: options.parentConversationId }
          : {}),
      }).id

    const conversation = getConversation(store, conversationId)
    // 旧会话记着模型却证明不出接口归属（迁移前的扁平档案）时要求重选一次，不按 id 反查。
    // 但**只针对「有模型、无接口」的旧会话**：没配默认模型时新建的会话两格都空，
    // 上面 `model` 已回落到当前默认，按默认那一对发就行，不该报「旧会话」。
    if (conversation && !options?.model && conversation.model && !conversation.provider) {
      throw new Error('这条旧会话没有可证明的接口归属，请重新选择一次模型后再继续')
    }
    /*
     * 会话记着接口名就按那一对发，**不再按模型 id 反查**——两个接口挂同一个
     * 模型 id 时反查的结果取决于枚举顺序，而错了是换端点换 key 换价目表，不报错。
     * 单轮显式 `--model` 仍是用户主动要求的裸模型选择，不属于旧会话回退。
     */
    const target: string | ModelRef =
      !options?.model && conversation?.provider ? { provider: conversation.provider, model } : model
    // 思考强度**按这一轮真正要用的那个模型解析**，真源是配置里
    // 「接口 × 模型」那一格。不存会话级的第二份，也不共用一个全局值——
    // 档位集合逐模型不同（见 `StoredModel.effort`），全局值套过去必然错配。
    const resolvedTarget = resolveModel(config, target)
    const effort = resolvedTarget?.effort

    /*
     * 冻结本 run 的非对话上下文。
     *
     * 这一步必须在写 run 之前完成：扩展工具、技能、记忆与待办只读一次，随后跟 run
     * 同行落库。loop 内任何一次 provider 请求都不再临时重算，重启也从同一份快照
     * 重建，因此上下文字节不会随执行波次漂移。
     */
    const adapter = buildAdapter(this.resolveProfile(target))
    if (!this.extensions) {
      await this.loadExtensionTools(adapter.spec.density, conversationId)
    }
    const roots = scopeRoots(this.opts.workspaceRoot)
    const skills = await scanSkills(roots).catch(() => [])
    const memories = await listScopedEntries(roots).catch(() => [])
    const canAssignModels = ['define_role', 'subagent', 'workflow'].some((name) =>
      this.registry.has(name),
    )
    // 只列本会话真有工具的那几类：角色只点名了视频工具时，图像模型的参数表不给。
    const mediaModels = listMediaModels(config).filter((m) =>
      this.registry.has(MEDIA_TOOLS[m.output].name),
    )
    // 角色、外部 CLI、本会话已有的子 agent：模型据此按 id 引用，不猜名字。
    const delegateFacts =
      canAssignModels && this.opts.delegate
        ? {
            team: await this.opts.delegate.targets(),
            subagents: await this.opts.delegate.subagents(),
          }
        : {}
    const contextSnapshot = buildTailNotes({
      workspaceRoot: this.opts.workspaceRoot,
      platform: process.platform,
      mode: this.opts.config.mode ?? 'auto',
      skills,
      memories,
      // 派活工具存在才给；成员会话没有 delegate，既看不到清单也无法递归派活。
      ...(canAssignModels
        ? {
            models: Object.entries(config.providers).flatMap(([provider, stored]) =>
              Object.keys(stored.models).map((model) => ({ provider, model })),
            ),
          }
        : {}),
      ...delegateFacts,
      // 参数表跟着生成工具走：工具没注册（没配模型、角色没点名）就不给。
      ...(mediaModels.length ? { mediaModels } : {}),
      externalTools: this.pendingTools?.index() ?? [],
      todos: latestTodos(store, conversationId),
      // 未走完的图跟着快照一起冻结。没有派活通道就没有图，也不必查。
      ...(canAssignModels ? { workflows: unfinishedWorkflows(store, conversationId) } : {}),
    })

    const userMessageId = appendMessage(store, {
      conversationId,
      role: 'user',
      content: prompt,
      ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
      ...(options?.origin ? { origin: options.origin } : {}),
    }).id

    /*
     * 标题在第一条用户消息落库之后产生，**全项目只有这一处产生点**。
     * 建会话时不取：界面端先建会话、后发第一句话，那时正文还不存在。
     *
     * 只在标题空着时写——用户改过的名字不许被下一句话盖掉。
     */
    if (!conversation?.title) {
      const derived = deriveConversationTitle(prompt)
      if (derived) setConversationTitle(store, conversationId, derived)
    }

    const run = createRun(store, {
      conversationId,
      workspaceId: this.workspaceId as never,
      model,
      clientRequestId: options?.clientRequestId ?? crypto.randomUUID(),
      userMessageId,
      // 高水位：本轮定格在刚写入的消息。排队期间新到的消息不进本轮视野。
      messageIdUpperBound: userMessageId,
      contextSnapshot,
      ...(options?.dispatch ? { dispatch: options.dispatch } : {}),
    })
    markRunRunning(store, run.id)

    /*
     * 历史 = 消息 + **由 steps 投影出来的 assistant/tool 回合**。
     *
     * **只映射 `listMessages` 是不够的**：那张表只有 user 行（全项目唯一的
     * `appendMessage` 就在上面几行，写的是 `role:'user'`），因此第二轮起模型拿到的
     * 输入字面上是「用户说了三次话，助手一次都没回」，跨轮结构性失忆。
     */
    const preserveAssistantReasoning = adapter.spec.chatReasoningProtocol !== 'standard'
    const history = await buildHistory(
      store,
      conversationId,
      run.messageIdUpperBound,
      (content, list, includeMedia) =>
        withAttachments(this.opts.workspaceRoot, content, list as Attachment[], includeMedia),
      { preserveAssistantReasoning },
    )

    /*
     * 把账本里最后一次真值回执带给 loop 当锚点。
     *
     * 覆盖边界取那次回执所属 run 的消息高水位——它之后的历史消息是锚点没算过的。
     * 没有回执（新会话、或一直没拿到 usage）就不传，loop 退回本地估算并如实
     * 标 `estimated`。
     */
    const latestAnchor = latestAnchoredProviderRequest(store, conversationId)
    /*
     * 真值锚点属于「接口 × 协议 × 模型」这条路线，不只属于模型名。
     * 同一个 model id 挂在两个中转站上时，usage 口径与实际 tokenizer 都可能不同；
     * 只有完整路线证据才可复用。迁移前缺接口或协议的旧行仍保留作诊断账，
     * 但不能参与当前上下文裁决。
     */
    const anchored =
      latestAnchor &&
      latestAnchor.model === adapter.spec.id &&
      latestAnchor.providerName === resolvedTarget?.provider &&
      latestAnchor.providerKind === adapter.kind
        ? latestAnchor
        : null
    const anchorRun = anchored ? getRun(store, anchored.runId) : null
    const anchor = anchored
      ? {
          tokens:
            (anchored.providerInputTokens ?? 0) +
            (anchored.providerCachedTokens ?? 0) +
            (anchored.providerCacheWriteTokens ?? 0) +
            (anchored.providerOutputTokens ?? 0),
          throughMessageId: anchorRun?.messageIdUpperBound ?? null,
          model: anchored.model,
          headTokens: envelopeHeadTokens(anchored.sentCategories),
          // 指纹不匹配时由 loop 换掉头部（换了模型才作废）——只有装配完才知道本轮的信封。
          envelopeFingerprint: anchored.cacheRouteFingerprint,
        }
      : null

    /*
     * 标题与 `updated_at` 刚被写过，广播出去——不发的话侧栏要等下次重拉才更新。
     *
     * **读回账本再发，不发局部变量**：`model` 是「这一轮用哪个模型」，可被单轮
     * 覆盖，而这条事件说的是会话属性，拿它发会显示一个会话没切过去的模型。
     */
    const announced = getConversation(store, conversationId)
    if (announced) {
      yield {
        type: 'conversation.updated',
        conversationId,
        provider: announced.provider,
        model: announced.model,
        title: announced.title,
        updatedAt: announced.updatedAt,
      }
    }

    // run.started 必须由这里发：没有发送方的话客户端拿不到真实 runId，中断和重试
    // 只能拿步骤 id 当 run id 用，服务端查不到就静默什么也不做。
    // **协议里有类型不等于有实现**。
    yield {
      type: 'run.started',
      runId: run.id,
      conversationId,
      model,
      userMessageId: userMessageId ?? null,
      // 正文一并带上：服务端自己发起的轮次（目标续起、定时触发、跟进消息火发）
      // 没有客户端的乐观插入，界面上那句话只能来自这里。
      userMessage: {
        content: prompt,
        ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
        // 与上面写进 `messages.origin` 的那一格同值：两侧不同口径的话，
        // 回执起的这一轮实时画成用户气泡、刷新之后才变回执行。
        ...(options?.origin ? { origin: options.origin } : {}),
      },
    }

    // 压缩端口绑定到本会话与本 run 的高水位：压缩范围不得越过 run 创建时定格的水位，
    // 否则会把排队期间新到的消息一起压掉——那些消息本轮根本还没看到。
    const compaction = new RuntimeCompaction({
      store,
      conversationId,
      messageIdUpperBound: run.messageIdUpperBound,
      summarize: makeSummarizer({
        store,
        conversationId,
        workspaceId: this.workspaceId,
        profile: () => this.resolveProfile(target),
        effort: () => resolveModel(this.opts.config, target)?.effort,
        signal: this.opts.signal,
      }),
      preserveAssistantReasoning,
    })

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
    /*
     * 报错正文。**必须落库**——`runs.error_message` / `error_code` 两列从建表起
     * 就在，`RunRecord` 也一直转出去，但没有人写过：一条 `stop_reason` 为
     * `provider_error` 的 run，账本里的报错正文是 `null`，界面刷新之后
     * 「为什么停」只剩「模型服务出错」五个字，连不上还是 key 错了看不出来。
     *
     * `run.error` 恒在 `run.finished` 之前（`agent/loop/index.ts` 连着 yield 两条），
     * 所以在这里接一手就够，不需要另开一条持久化路径。
     */
    let failure: { message: string; code: string } | null = null
    try {
      for await (const ev of this.makeLoop(target, adapter, conversationId, compaction).run({
        runId: run.id,
        history,
        ...(effort ? { effort } : {}),
        cacheKey: conversationId,
        ...(userMessageId ? { userMessageId } : {}),
        signal: this.opts.signal,
        // 上一轮的真值带进来，这一轮开头就用同一把尺。不带的话每个 run 的
        // 第一次请求只能报估算（系统性偏低），第二次起弹回真值——
        // 用户看到的就是每轮开头掉一次。
        ...(anchor ? { anchor } : {}),
      })) {
        if (ev.type === 'run.error') failure = { message: ev.message, code: ev.code }
        if (ev.type === 'usage') this.modelUsage.set(run.id, ev.usage)
        // 本轮的生成花费附进 usage：读数条与「运行」面板按 `runCosts` 把它与模型花费合在一起显示。
        // 下面记账用的 `ev.usage` 仍只是模型调用那一份。
        const spends = this.mediaSpends.get(run.id)
        const out =
          spends?.length && (ev.type === 'usage' || ev.type === 'run.finished')
            ? { ...ev, usage: { ...ev.usage, media: spends } }
            : ev
        if (ev.type === 'run.finished') {
          finished = true
          const interruption =
            ev.stopReason === 'user_interrupt'
              ? interruptionFrom(this.opts.signal, 'user', false)
              : null
          finishRun(store, run.id, {
            status: ev.status,
            stopReason: ev.stopReason,
            errorMessage:
              failure?.message ?? interruptionMessage(interruption) ?? ev.stopDetail ?? null,
            errorCode: failure?.code ?? null,
            interruption,
          })
          // 账本在**收尾时记一次**。中途的 usage 是累计值，每次都记会把同一笔钱
          // 记很多遍；而 run 上那份 usage 会随会话删除一起消失，答不了
          // 「这个月花了多少」。
          recordUsage(store, {
            kind: 'run',
            runId: run.id,
            conversationId,
            workspaceId: this.workspaceId,
            model,
            provider: this.resolveProfile(target).kind,
            inputTokens: ev.usage.inputTokens,
            outputTokens: ev.usage.outputTokens,
            cachedTokens: ev.usage.cachedTokens,
            cacheWriteTokens: ev.usage.cacheWriteTokens,
            reasoningTokens: ev.usage.reasoningTokens,
            cost: ev.usage.cost,
            currency: ev.usage.currency,
          })
        }
        yield out
      }
    } finally {
      // 心跳先停。停晚了不要紧（只推 running 的行），但停在最前面才保证
      // 无论下面哪一步抛异常都不会留下一个还在推心跳的定时器。
      clearInterval(heartbeat)
      // 生成花费逐条入账。放在这里而不是 `run.finished` 分支：被中断、连接关闭的轮次也已经扣过费。
      for (const spend of this.mediaSpends.get(run.id) ?? []) {
        recordUsage(store, {
          kind: 'media',
          runId: run.id,
          conversationId,
          workspaceId: this.workspaceId,
          model: spend.model,
          provider: spend.kind,
          inputTokens: 0,
          outputTokens: 0,
          cost: spend.cost,
          currency: spend.currency,
          occurredAt: spend.at,
        })
      }
      this.mediaSpends.delete(run.id)
      this.modelUsage.delete(run.id)
      // 生成器被提前关闭（用户 Ctrl-C、客户端断连）时也要给 run 一个终态，
      // 否则账本里会永远留有一条 running 的孤儿记录。
      // 边界：这层只覆盖 `run.started` 之后。在它之前关闭生成器或抛出异常时，run 行停在
      // running，由下次启动的 `recoverStaleRuns` 按 `owner_pid` 回收。
      if (!finished) {
        const ambiguous = listSteps(store, run.id).some(
          (step) => step.status === 'running' && step.executionStartedAt !== null,
        )
        const interruption = interruptionFrom(
          this.opts.signal,
          this.opts.signal.aborted ? 'user' : 'consumer_closed',
          ambiguous,
        )
        finishRun(store, run.id, {
          status: 'interrupted',
          stopReason: ambiguous ? 'internal_guard' : 'user_interrupt',
          errorMessage: interruptionMessage(interruption),
          interruption,
        })
      }
      // **step 也要落终态，不只是 run。**
      //
      // 只收 run 是不够的：`tool.started` 的 yield 处被 `.return()` 掐断时，
      // step 已经是 running 却没人 settle——run 随即被标成终态，因此那条 step
      // 永远碰不到启动时的 `recoverStaleRuns`（它只扫 running/queued 的 run）。
      //
      // 代价不是 UI 上一张转圈的卡：历史投影必须跳过含未终结调用的整个 batch，
      // 一条孤儿会让同批次里**已经成功的写文件结果一起从历史里消失**。
      settleRunningSteps(store, run.id)
    }
  }

  /**
   * 取扩展并把它们贡献的工具接进本会话的表。
   *
   * **按量分两档**：外置 schema 总量在预算内就全部注册（省掉一次往返），
   * 超了就全部进待加载池、只注册一个 `load_tool`，清单进入下一份 run 快照。
   * 阈值与实测的量见 `tools/tool-pool.ts`。
   *
   * 注册失败（重名）只跳过那一个工具：让整个会话因为一个撞名的插件工具起不来，
   * 代价完全不成比例。
   */
  private async loadExtensionTools(
    density: TokenDensity,
    conversationId?: ConversationId,
  ): Promise<void> {
    const ext = await acquireExtensions(this.opts.workspaceRoot, (line) =>
      log.info('extensions', line),
    )
    this.extensions = ext

    // 角色的 allowedTools 同样约束插件与 MCP 工具。
    // 只过滤内置工具的话，一个「只读」角色照样能调插件里的写工具。
    const allow = this.opts.allowedTools ? new Set(this.opts.allowedTools) : null
    const eligible = ext.toolSpecs.filter(
      (spec) => !(allow && !allow.has(spec.name)) && !this.registry.has(spec.name),
    )

    /*
     * **角色点名的那一套不进池子。**
     *
     * `allowedTools` 是人挑过的一小把工具，把它们塞进池子有两个后果：模型要多花
     * 一轮把角色本来就该有的工具装回来；而且下面的引用校验会把池子里的名字
     * 全报成无效引用。
     */
    const onDemand =
      !allow && externalSchemaTokens(eligible, density) > EXTERNAL_SCHEMA_BUDGET_TOKENS

    if (onDemand) {
      const pool = new PendingToolPool({
        registry: this.registry,
        onLoaded: (names) => {
          // 没有会话就没有会话级存储。只有 `capabilities()` 那条路是这样——
          // 它只为报一份能力清单，不跑模型，也就没有「下一轮」要记给谁。
          if (conversationId) recordLoadedTools(this.opts.store, conversationId, names)
        },
      })
      for (const spec of eligible) pool.add(spec)
      this.registry.register(makeLoadToolTool(pool))
      // 上几轮已经装过的直接放回工具表：模型在 transcript 里看得见自己装过，
      // 工具表里却没有的话它会反复去试。池子里没有的（server 拆了、开关关了）
      // 自然落空，不必另外清理账本——那张表记的是「装过」，不是「还在」。
      if (conversationId) pool.load([...listLoadedTools(this.opts.store, conversationId)])
      this.pendingTools = pool
    } else {
      for (const spec of eligible) {
        try {
          this.registry.register(spec)
        } catch (err) {
          log.warn('session', `工具注册失败 ${spec.name}：${String(err)}`)
        }
      }
    }

    // 名字写错了要说出来。静默忽略的话，配了 "read_files"（多了个 s）
    // 的角色会安安静静地一个工具都没有，表现为「它什么也不干」。
    //
    // 判定必须**等扩展加载完**再做：插件和 MCP 工具是异步来的，
    // 在构造函数里只比内置集合的话，一个合法的 `mcp__github__x` 会被误报成
    // 无效工具引用，比不提示更糟。
    if (allow) {
      const invalid = [...allow].filter((n) => !this.registry.has(n))
      if (invalid.length) {
        log.warn('session', `角色 allowedTools 含无效工具引用，已忽略：${invalid.join('、')}`)
      }
    }

    for (const f of ext.plugins.failures) {
      log.warn('extensions', `插件加载失败 ${f.dir}：${f.reason}`)
    }
    for (const f of ext.mcp.failures) {
      log.warn('extensions', `MCP ${f.server}：${f.reason}`)
    }
  }

  /**
   * 释放本会话对扩展的引用。会话结束时**必须调**。
   *
   * 不直接 stop：扩展是按工作区共享的，别的会话可能还在用。
   * 引用归零时才真的关子进程。
   *
   * **它必须真的被调用。** 没有调用点的话，server 每条消息新建的 Session 各自
   * 起一套插件子进程，一个都不会关——公开方法有定义不等于有人调。
   */
  dispose(): void {
    /*
     * 浏览器控制跟着会话走：这一轮收尾即撤销控制归属与未消费的下载授权，页面保留
     * 给用户接手。不释放的话下一轮起来会拿到 busy，而没有任何入口能解开它。
     *
     * 失败只记一行：宿主可能已经断开，而断开路径本身也撤销了这两样。
     */
    this.opts.browser?.release().catch((err) => {
      log.warn('browser', `释放浏览器控制失败：${err instanceof Error ? err.message : String(err)}`)
    })
    // 电脑控制跟着会话走：这一轮收尾即撤销本执行者名下尚未派发的请求。
    // 已经交给 OS 的动作不回滚——那是执行事实，不是可撤销的占用。
    this.opts.desktop?.release().catch((err) => {
      log.warn('desktop', `撤销电脑控制失败：${err instanceof Error ? err.message : String(err)}`)
    })
    if (!this.extensions) return
    this.extensions = null
    releaseExtensions(this.opts.workspaceRoot)
  }

  private nextSeq(runId: string): number {
    const next = (this.seqCounter.get(runId) ?? 0) + 1
    this.seqCounter.set(runId, next)
    return next
  }

  private makePersistence(conversationId: ConversationId): LoopPersistence {
    const { store } = this.opts
    return {
      nextSeq: (runId) => this.nextSeq(runId),
      openTextStep: (runId, seq, batchId) =>
        appendStep(store, {
          runId,
          seq,
          kind: 'text',
          content: '',
          providerBatchId: batchId,
        }).id,
      openThinkingStep: (runId, seq, batchId, reasoning) =>
        appendStep(store, {
          runId,
          seq,
          kind: 'thinking',
          content: '',
          providerBatchId: batchId,
          ...(reasoning ? { payload: { kind: 'response_reasoning', reasoning } as const } : {}),
        }).id,
      // 开即终态：注入的那句话没有中间态可等，`status` 用默认的 `done`。
      landUserStep: (runId, seq, input) =>
        appendStep(store, {
          runId,
          seq,
          kind: 'user',
          content: input.text,
          payload: {
            kind: 'user',
            ...(input.attachments?.length ? { attachments: input.attachments } : {}),
            ...(input.origin ? { origin: input.origin } : {}),
          },
        }).id,
      failThinkingSteps: (stepIds) => failThinkingSteps(store, stepIds as never),
      appendText: (stepId, delta) => appendTextToStep(store, stepId as never, delta),
      openToolStep: (runId, seq, call: WireToolCall, batchId, callIndex, waveIndex, action) =>
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
          // action 必须落库：它由 ToolSpec 按参数解析，前端回猜不出来。
          payload: { kind: 'tool_call', args: call.arguments, action },
        }).id,
      markExecuting: (stepId) => markStepExecuting(store, stepId as never),
      settleTool: (stepId, status, outcome, args, action, durationMs) =>
        settleToolStep(
          store,
          stepId as never,
          status,
          { kind: 'tool_result', args, outcome, action },
          durationMs,
        ),
      saveUsage: (runId, usage) => updateRunUsage(store, runId, usage),
      recordCompaction: (runId, seq, payload) => {
        appendStep(store, {
          runId,
          seq,
          kind: 'compaction',
          // 列值由 phase 导出，不让调用方再报一次——两处各报一次就是两本账，
          // 而它们会漂移。终态的细分（skipped 与 failed）在 payload 里。
          status: payload.phase === 'done' ? 'success' : 'failure',
          payload: { kind: 'compaction', ...payload },
        })
      },
      openRequest: (input) => openProviderRequest(store, input).id,
      markRequestSent: (requestId) => markProviderRequestSent(store, requestId as never),
      markRequestHeaders: (requestId, at) =>
        markProviderRequestHeaders(store, requestId as never, at),
      markRequestFirstEvent: (requestId) =>
        markProviderRequestFirstEvent(store, requestId as never),
      markRequestContent: (requestId, at, kind, visible) =>
        markProviderRequestContent(store, requestId as never, at, kind, visible),
      markRequestInputImages: (requestId, batchId) =>
        markProviderRequestInputImages(store, requestId as never, batchId),
      inputImagesConsumed: (batchId) =>
        hasReceivedRequestWithImages(store, conversationId, batchId),
      settleRequest: (requestId, status, usage, errorCode, finishReason, errorMessage) =>
        settleProviderRequest(
          store,
          requestId as never,
          status,
          usage,
          errorCode,
          finishReason,
          errorMessage,
        ),
      recordRequestDiagnostic: (requestId, diagnostic) => {
        const secrets = collectSecrets(this.opts.config)
        recordProviderRequestDiagnostic(store, requestId as never, {
          ...diagnostic,
          causes: diagnostic.causes.map((cause) => ({
            ...cause,
            message: redactSecrets(cause.message, secrets),
          })),
        })
      },
    }
  }

  /**
   * 授权裁决。**只有两种模式，不弹窗。**
   *
   * **`full` 也不豁免的那一条：只剩凭证剥离。** `scrubEnv` 两种模式一视同仁——它不是裁决，是「明文
   * key 不进子进程」这条与模式无关的事实。**路径约束不在此列**：`full` 的语义是「全部权限」，路径
   * 边界跟着一起放开（`makeToolContext` 的 `unrestrictedPaths`）。
   *
   * 只放开权限闸、留着路径层，得到的不是更安全，是**两套账**：同一个模式下
   * `run_command` 全放行、shell 里一个 `cd` 就出得去，而 `read_file` 还在拦
   * ——模型因此转头用 shell 读到了同一个文件，账本里有一次实证
   * （会话 `cv_0msw3jst9`）。
   *
   * **`auto` 下谁走哪条路。** 判据是**这件事是谁决定的**，不是「代码从哪来」：
   *
   * - **文件与网络类**（read/write/delete/network）：路径已经被
   *   `resolveInWorkspace` 锁死、外发已经过 SSRF 闸，都是**确定性**判断，
   *   越界的根本走不到这里。所以放行，不必再花一次往返去问模型。
   * - **MCP 与插件工具**：是用户显式配置/安装的，属于知情同意，放行——
   *   不为用户自己选的扩展造第三套闸。
   * - **内置浏览器工具**（`browser` 效果）：端口由装配方按这一轮执行注入，
   *   参数里自报的会话、Run、工作区根一概不读；页归属由宿主裁决，用户手动开的页
   *   要用户点名后经 `bind` 才归本会话；上传下载的路径与文件工具走同一份裁决。
   *   边界都在参数解析之前，放行。
   * - **内置桌面工具**（`desktop` 效果）：端口由装配方按用户的启用开关与宿主状态注入，
   *   参数里只有端口发放的不透明目标 id，OS 句柄到不了模型手里；能不能操作由
   *   系统授权与宿主裁决。边界同样在参数解析之前，放行。
   * - **`run_command`**：唯一一条能同时绕开路径约束和 SSRF 闸的路径
   *   （命令字符串里的路径不经过参数解析）。只有它需要真正的裁决。
   */
  private async decide(call: {
    toolName: string
    args: Record<string, unknown>
  }): Promise<PermissionVerdict> {
    if ((this.opts.config.mode ?? 'auto') === 'full') return { allowed: true }

    if (call.toolName !== 'run_command') return { allowed: true }

    const command = String(call.args.command ?? '')
    // 根目录清单必须与路径层、沙箱层是**同一份**。三处各算各的，
    // 现象是「配了但只有一层生效」，而三层的报错互不相干。
    const d = decideCommand(command, {
      workspaceRoot: this.opts.workspaceRoot,
      ...(this.extraDirs.length ? { additionalDirectories: this.extraDirs } : {}),
    })
    if (d.kind === 'allow') return { allowed: true }
    /*
     * 这句话是模型在 `auto` 模式下唯一能拿到的信号，所以它必须给出**正当的**出路。
     *
     * 旧文案是「换一条不做这件事的命令」——那等于教它绕过：`rm -rf ~/x` 被拦
     * 就改写成 `python -c "import shutil; shutil.rmtree(...)"`，而后者不在
     * `HARD_DENY` 表里就过了。规则挡的是这件事本身，不是这个写法。
     *
     * 不带 scope：`execute:<目标>` 这个串对模型没有信息量，它既不知道 scope 是
     * 什么，命令也是它自己刚发出来的。
     */
    return {
      allowed: false,
      reason:
        `这条命令被权限规则拦下：${d.reason}。当前是「自动审批」模式，它只放行确定安全的命令。` +
        `可选处理：① 告知用户该步骤需要更高权限，由用户切到「完全访问」；② 跳过该步骤，执行其他任务。` +
        `不要改写命令重试——拦截依据是操作本身，不是命令写法。`,
    }
  }

  /**
   * 记下一次生成花费：写进本轮 `runs.media_usage`，并补推一次 usage 事件，轮次还在跑时读数条与面板就能看到。
   * 事件里的模型用量取本轮最近一次，生成花费由 `ask` 统一附上。
   */
  private recordMediaSpend(runId: RunId, spend: MediaSpend, emit: (e: AgentEvent) => void): void {
    const spends = [...(this.mediaSpends.get(runId) ?? []), spend]
    this.mediaSpends.set(runId, spends)
    updateRunMedia(this.opts.store, runId, spends)
    const usage = this.modelUsage.get(runId)
    if (usage) emit({ type: 'usage', runId, usage })
  }

  private makeToolContext(
    runId: RunId,
    emit: (e: AgentEvent) => void,
    target: string | ModelRef,
    conversationId: ConversationId,
  ): ToolContextBase {
    const model = typeof target === 'string' ? target : target.model
    const secrets = collectSecrets(this.opts.config)
    const store = this.opts.store
    // 三项逐模型的能力取自同一份 spec：分开各取一次的话，换模型时它们会来自
    // 两次不同的解析结果。
    const spec = buildAdapter(this.resolveProfile(target)).spec
    return {
      workspaceRoot: this.opts.workspaceRoot,
      conversationId,
      runId,
      model,
      // 投递预算按窗口算，且**在执行时**应用——换模型只影响之后的读取，
      // 已落库的 step 一个字节不改（投影因此仍是纯函数）。
      contextWindow: spec.contextWindow,
      // 扣账那把尺与窗口同源，理由见 `ToolContext.density`。
      density: spec.density,
      vision: spec.vision,
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
       * 而这条守卫要回答的是「要写的这份，是不是读到的那份」，与 run 边界无关。
       */
      reads: {
        seen: (path) => fileReadHash(store, conversationId, path),
        mark: (path, hash) => recordFileRead(store, conversationId, path, hash),
      },
      /*
       * 待办同样绑到**会话**，而且**只读**：父会话整表提交与子任务待验收回执
       * 都是原本就要落的 tool step；只有 `write_todos` 改变当前快照。
       * 这里读回来给动作词、委派归属与 loop 收尾共用；run 级的 `ctx.state`
       * 跨轮查不到这些会话事实。
       */
      todos: { read: () => latestTodos(store, conversationId) },
      /*
       * 目标同样绑到**会话**：它的寿命就是这条会话，跨轮才有意义。
       *
       * 事件在这里发，不在工具里发（对比 `emitTodos`）：目标的真源是账本，
       * 「写下去」和「说出去」是同一件事的两半，交给工具就会有人只做一半。
       * 事件不带 runId——目标是会话级的，服务端在 run 之外也会改它。
       *
       * **没有 create**：立目标是用户的动作，走 `goal.set` 指令，不经过工具。
       */
      goals: {
        read: () => currentGoal(store, conversationId),
        update: (input) => announce(updateGoal(store, { conversationId, ...input }), emit),
      },
      /*
       * 定时任务绑到**当前工作区**：任务表是全机一份，端口在这里把归属钉死，
       * 工具那侧没有跨项目的入口。写入与调度 tick 走同一份仓储，不另开一条落盘路径。
       *
       * 建出来的任务同时绑到**顶层会话**：触发时消息发进它，而子会话不接受直接发消息
       * （`server/commands.ts` 的 `message.send` 当场回绝），绑过去的任务一次也触发不了。
       */
      schedules: {
        list: () => listSchedules(store, this.opts.workspaceRoot, Date.now()),
        create: (draft) =>
          createSchedule(
            store,
            this.opts.workspaceRoot,
            draft,
            getConversation(store, conversationId)?.parentConversationId ?? conversationId,
          ),
        remove: (id) => deleteSchedule(store, id, this.opts.workspaceRoot),
      },
      /*
       * 被折叠历史的回读。**压缩是投影不是删除**，所以原文一直在账本里，
       * 这条通道只是把它接给模型——没有它，摘要里的 `[message:…]` 标记指向
       * 一个模型够不到的地方，压缩就真成了「丢信息」。
       *
       * 用 list + find 而不是给 store 加按 id 取的函数：这是模型主动发起的
       * 低频调用，而会话消息与单 run 的 step 都是小集合。
       */
      // 派活通道原样透传：能不能派、派给谁由装配方（server）决定，
      // 这里不做「没有就造一个空的」——那会让 `subagent` 注册进来却派不出去。
      ...(this.opts.delegate ? { delegate: this.opts.delegate } : {}),
      ...(this.opts.plugins ? { plugins: this.opts.plugins } : {}),
      ...(this.opts.browser ? { browser: this.opts.browser } : {}),
      ...(this.opts.desktop ? { desktop: this.opts.desktop } : {}),
      mcpConfig: makeMcpConfigPort(this.opts.workspaceRoot),
      ...(listMediaModels(this.opts.config).length
        ? {
            media: makeMediaPort(this.opts.config, (spend) =>
              this.recordMediaSpend(runId, spend, emit),
            ),
          }
        : {}),
      history: historyPortFor(store, conversationId as ConversationId),
      signal: this.opts.signal,
      emitTodos: (todos) => {
        emit({ type: 'todos', runId, todos })
      },
      secrets,
      ...(this.opts.config.envAllowList ? { envAllowList: this.opts.config.envAllowList } : {}),
      ...(this.extraDirs.length ? { additionalDirectories: this.extraDirs } : {}),
      // 「完全访问」= 全部权限，路径边界也归它管。与下面 `decide` 里那句
      // `full` 的定义就是「不裁决」是同一件事的两面——只放开权限闸而留着路径层，
      // 就是「read_file 被拒、run_command 读到」那种两套账。
      ...((this.opts.config.mode ?? 'auto') === 'full' ? { unrestrictedPaths: true } : {}),
      requestPermission: (call) => this.decide(call),
    }
  }
}

export interface SummarizerOptions {
  store: Store
  workspaceId: string
  /**
   * 这次压缩是为哪条会话做的。**必填**：它是这笔钱与会话之间唯一的连接，
   * 不带的话账本里这一笔只认得工作区，「这条会话花了多少」就永远少算一块——
   * 而压缩越频繁少得越多。
   */
  conversationId: ConversationId
  /** 每次调用现解析：摘要发起时会话模型可能已经被切过。 */
  profile: () => ProviderProfile
  /** 用户为当前「接口 × 模型」选的档；undefined = 省略字段，沿用模型默认。 */
  effort?: () => EffortLevel | undefined
  /** 调用方的中断信号。不传 = 只受流空闲判定约束。 */
  signal?: AbortSignal
}

/**
 * 摘要生成器：用会话当前的 provider 档案，独立于主循环发一次请求。
 *
 * **自动触发与手动 `/compact` 共用这一份。** 两份装配会各自漂移，而漂移了很难
 * 发现——两条路都产出摘要，看不出口径已经不同。
 *
 * 刻意不带工具、不带冻结前缀：摘要任务只需要文本进文本出，带上工具 schema
 * 只会让这次调用也逼近容量上限，而它是在容量已经超了的时候发的。
 *
 * 思考档位遵守用户选择：选了就原样继承，没选就省略字段、沿用模型默认。
 * 摘要任务不能为了提速在后台替用户降档，更不能发送关闭思考的命令。
 *
 * 空闲上限交给传输层按字节判（`idleTimeoutMs`，与主请求同一个基准），这里不另起计时。
 * 不要换成总时长上限：正在逐字产出的慢摘要不是卡死，掐掉它等于把一次已经付过费的
 * 正常调用作废。
 *
 * 预算是 **token**，直接当 `max_tokens` 申报。以 `max_tokens` 收尾的那次返回
 * null：半份摘要比没有更坏——它看起来完整。
 */
export function makeSummarizer(opts: SummarizerOptions): Summarizer {
  return async (prompt, budgetTokens, trace) => {
    const profile = opts.profile()
    const adapter = buildAdapter(profile)
    const selectedEffort = opts.effort?.()
    const effort =
      selectedEffort && adapter.spec.effortLevels.includes(selectedEffort)
        ? selectedEffort
        : undefined
    const willThink = effort !== undefined || adapter.spec.thinksByDefault

    let text = ''
    /** 摘要被输出上限截断。**截断的摘要一律不采用**——半份摘要看起来完整。 */
    let truncated = false
    let finish: string | undefined
    // 摘要也花钱。一轮之内的摘要请求由 trace 记进这一轮（provider_requests + 这一轮的 usage）；
    // 手动压缩不在任何一轮里，在下面单独记一笔账本行。
    let spent: { cost: number; u: ProviderUsage } | null = null
    const req: ChatRequest = {
      model: adapter.spec.id,
      system: [{ text: '你是会话摘要器。只输出摘要正文。' }],
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      /*
       * **会思考的模型不能拿正文预算当 `max_tokens`。**
       *
       * 思考与正文共用这一个上限，而思考**不进投影**——压成正文预算的话，
       * 模型在思考阶段就把额度耗尽，正文没写完即被截断，整份作废
       * （实测 deepseek-v4-flash：一句话摘要花 259 个思考 token，
       * 正文只有 10 个字）。因此摘要段恒失败，压缩退化成只有收纳段。
       *
       * 正文长度由提示词里那句字数要求约束，这里只负责让模型有地方把话说完。
       * 不思考的模型上正文就是全部输出，直申预算即可。
       */
      maxOutputTokens: willThink
        ? adapter.spec.maxOutputTokens
        : Math.min(adapter.spec.maxOutputTokens ?? budgetTokens, budgetTokens),
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      ...(effort ? { effort } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }
    const requestId = trace?.open(req)
    let sawEvent = false
    try {
      if (trace && requestId) trace.sent(requestId)
      for await (const ev of adapter.stream(req)) {
        if (trace && requestId && !sawEvent && ev.type !== 'request_prepared') {
          sawEvent = true
          trace.firstEvent(requestId)
        }
        if (trace && requestId && ev.type === 'response_started') {
          trace.headers(requestId, ev.headersAt)
        }
        // 摘要与主请求同一条规则：每一段非空内容都推进内容时刻，用适配器带来的观察时刻。
        if (
          trace &&
          requestId &&
          (ev.type === 'text_delta' ||
            ev.type === 'thinking_delta' ||
            ev.type === 'tool_call_progress' ||
            ev.type === 'tool_calls' ||
            ev.type === 'response_reasoning')
        ) {
          trace.content(requestId, ev.at)
        }
        if (ev.type === 'text_delta') text += ev.delta
        else if (ev.type === 'done') {
          truncated = ev.stopReason === 'max_tokens'
          finish = ev.rawStopReason
        } else if (ev.type === 'usage') {
          spent = { cost: computeCost(adapter.spec, ev.usage), u: ev.usage }
        }
      }
    } catch (err) {
      const pe = err instanceof ProviderError ? err : null
      if (trace && requestId) {
        // 非 2xx 的响应头不经过 `response_started`，时刻只在传输读数里。与主请求同一条规则。
        if (pe?.transport?.headersAt != null) trace.headers(requestId, pe.transport.headersAt)
        // 与主请求同一套终态：被拒是 rejected，其余（掐流、中断、断连）都是 uncertain。
        trace.settle(
          requestId,
          pe?.status !== undefined ? 'rejected' : 'uncertain',
          pe?.usage ?? null,
          opts.signal?.aborted ? null : (pe?.code ?? 'internal_error'),
        )
      }
      throw err
    }

    if (trace && requestId) trace.settle(requestId, 'received', spent?.u ?? null, null, finish)
    else if (spent) {
      recordUsage(opts.store, {
        kind: 'summary',
        conversationId: opts.conversationId,
        workspaceId: opts.workspaceId,
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
    // 截断作废与空摘要同一个终态：调用方据此判摘要段没做成，收纳段照常落库。
    return truncated ? null : text.trim() || null
  }
}

/**
 * 目标写成功就广播一次。
 *
 * 失败的原样返回、**不发事件**：那是给模型看的拒绝理由（revision 过期之类），
 * 账本一个字节都没变，广播出去会让界面上的目标凭空闪一下。
 */
function announce(result: GoalWriteResult, emit: (e: AgentEvent) => void): GoalWriteResult {
  if (result.ok) emit({ type: 'goal', goal: result.goal })
  return result
}

/** 心跳间隔。回收那边按 60 秒判过期（`store/repos.ts`），六倍余量。 */
const HEARTBEAT_MS = 10_000

type InterruptionSource = RunInterruption['source']

/** AbortSignal.reason 是进程内中止来源；旧调用方没带 reason 时保守沿用 fallback。 */
function interruptionFrom(
  signal: AbortSignal,
  fallback: InterruptionSource,
  ambiguousToolExecution: boolean,
): RunInterruption {
  const raw = signal.reason
  const reason =
    typeof raw === 'object' && raw !== null
      ? (raw as { source?: unknown; observedAt?: unknown })
      : null
  const allowed: ReadonlySet<InterruptionSource> = new Set([
    'user',
    'server_shutdown',
    'consumer_closed',
  ])
  const source =
    typeof reason?.source === 'string' && allowed.has(reason.source as InterruptionSource)
      ? (reason.source as InterruptionSource)
      : fallback
  const observedAt =
    typeof reason?.observedAt === 'number' && Number.isFinite(reason.observedAt)
      ? reason.observedAt
      : Date.now()
  return {
    source,
    observedAt,
    recordedAt: Date.now(),
    ambiguousToolExecution,
  }
}

function interruptionMessage(interruption: RunInterruption | null): string | null {
  if (!interruption || interruption.source === 'user') return null
  if (interruption.source === 'server_shutdown') return '服务正常关闭，本轮随之中断'
  if (interruption.source === 'consumer_closed') return '执行流被调用方提前关闭，本轮中断'
  return null
}

const NEWLINE = String.fromCharCode(10)

/**
 * 把附件变成 provider 认得的内容。
 *
 * 当前轮的图片和视频进入内容块，其余附件只把路径写进正文。历史媒体只保留路径说明，
 * 不在每一轮重复读取和传输。
 *
 * **路径不按工作区裁决。** `resolveInWorkspace` 那道边界约束的是**模型**——它挡的是模型自己构造出
 * 来的路径。附件路径来自用户在界面上的拖 / 选 / 粘，是一次显式授权，与系统文件选择器同性质；判据
 * 是「字节会不会被发出去」，而按下拖放的正是决定这件事的那个人。
 *
 * **前提：模型不得构造附件。** 附件只能来自客户端手势，不能由任何工具调用产出
 * （`Attachment` 现在只从 composer 来）。这条一旦破了，上面整段理由跟着失效，
 * 这里必须改回按工作区裁决。
 *
 * **三种读不到都留一行说明，不抛。** 文件被删了、改名了、事后长过了上限——都会发生。**跳过那一个并
 * 在正文里留一行**，而不是让整轮起不来：模型看到「这里原本有张图，现在读不到了」还能继续执行，看
 * 到一个 500 就只能重来。
 *
 * 大小上限不在这里判，在 `materialize` 那一刻判——路径型附件指向用户自己的文件，
 * 它在被引用之后还会继续长，而这里只是记下位置。
 */
/**
 * 执行记录的取回形态：图像字节从 outcome 里拆出来走图像块，outcome 文本里不留 base64。
 * 读回来的图与 `read_file` 定格进执行记录的是同一份字节。
 */
function stepRecord(st: Step): HistoryStep {
  const payload = (st.payload ?? {}) as { args?: unknown; outcome?: Record<string, unknown> }
  const outcome = payload.outcome ?? {}
  const data =
    outcome.data && typeof outcome.data === 'object'
      ? (outcome.data as Record<string, unknown>)
      : undefined
  const images = imagesOf(data)
  const rest = envelopeResult(data)
  const { data: _dropped, ...withoutData } = outcome
  return {
    tool: st.toolName ?? 'unknown',
    status: st.status,
    args: JSON.stringify(payload.args ?? {}),
    outcome: JSON.stringify(data ? { ...withoutData, ...(rest ? { data: rest } : {}) } : outcome),
    ...(images.length ? { images } : {}),
  }
}

export async function withAttachments(
  workspaceRoot: string,
  text: string,
  attachments: Attachment[],
  includeMedia = true,
): Promise<string | ContentBlock[]> {
  const blocks: ContentBlock[] = []
  const notes: string[] = []

  for (const a of attachments) {
    const abs = isAbsolute(a.path) ? resolve(a.path) : resolve(workspaceRoot, a.path)
    const info = await stat(abs).catch(() => null)
    if (!info?.isFile()) {
      notes.push(`（附件 ${a.name} 已不存在，跳过）`)
      continue
    }
    const image = isInlineImage(a.path)
    const video = isInlineVideo(a.path)
    if (!includeMedia && (image || video)) {
      notes.push(`（历史附件 ${a.name}：${toPosixPath(abs)}）`)
      continue
    }
    // 分类按扩展名，与界面附件入口使用同一份判据。
    // 按 `a.type` 判会读到历史行里那个按 mime 算出来的旧值，两处给出不同答案。
    if (!image && !video) {
      // 给位置不给字节。模型读不到时 `read_file` 会明确报越界或不存在，不是静默失败。
      notes.push(`（附件 ${a.name}：${toPosixPath(abs)}）`)
      continue
    }
    // 只给位置，不读字节。读盘由 `agent/loop/request.ts` 的 `materialize` 在发出前做一次——
    // 被压缩折掉的那些轮次因此完全不必读盘，而这里读的话它们每一轮都白读一遍。
    blocks.push(
      image
        ? {
            type: 'image',
            mimeType: mimeOf(a.path),
            source: { kind: 'path', path: toPosixPath(abs) },
          }
        : {
            type: 'video',
            mimeType: mimeOf(a.path),
            source: { kind: 'path', path: toPosixPath(abs) },
          },
    )
  }

  // 文本块放最后：附件是这句话的**语境**，先看图再读要求更符合阅读顺序。
  const body = notes.length ? [text, ...notes].join(NEWLINE) : text
  if (blocks.length === 0) return body
  blocks.push({ type: 'text', text: body })
  return blocks
}

/**
 * 本会话里还没走完的那些图。
 *
 * 折叠失败的（首派参数已经不合法）整条跳过：那张图本来就续接不了，
 * 把一条错误信息塞进运行上下文只会让模型去修一份它读不到的记录。
 */
function unfinishedWorkflows(store: Store, conversationId: ConversationId): WorkflowProjection[] {
  const records = listWorkflowRecords(store, conversationId)
  const out: WorkflowProjection[] = []
  for (const workflowId of workflowIdsOf(records)) {
    const folded = foldWorkflow(records, workflowId)
    if (folded.ok && folded.projection.phase !== 'completed') out.push(folded.projection)
  }
  return out
}

/**
 * 一条会话的历史端口。子 agent 的历史用同一份实现按它的会话 id 建，
 * `forSubagent` 只认本会话派出去的那些。
 */
function historyPortFor(store: Store, cid: ConversationId): HistoryPort {
  const port: Omit<HistoryPort, 'forSubagent'> = (() => {
    /**
     * 摘要里的 `<runId>:<stepId>` 解析成那条 step。
     *
     * 单独一个 step id 跨 run 不唯一，而摘要引用的是远期记录，所以地址必须带 runId。
     */
    const compositeStep = (id: string): Step | null => {
      const cut = id.indexOf(':')
      if (cut <= 0) return null
      const runId = id.slice(0, cut) as RunId
      const stepId = id.slice(cut + 1)
      // 只认这条会话的 run：别的会话的 step id 回「没有这条」。
      if (!listRuns(store, cid).some((run) => run.id === runId)) return null
      return listSteps(store, runId).find((x) => String(x.id) === stepId) ?? null
    }
    const userStepOf = (id: string): Step | null => {
      const st = compositeStep(id)
      return st?.kind === 'user' ? st : null
    }
    return {
      message: (id) => {
        const m = listMessages(store, cid, null).find((x) => x.id === id)
        if (m) return { role: m.role, content: m.content }
        /*
         * run 内注入的那句用户消息不在 `messages` 表里，摘要给的是
         * `<runId>:<stepId>`。少了这一条回落，用户中途改方向的那句话
         * 一旦被折进摘要就再也取不回来——摘要里印着地址，取回却报「不存在」。
         */
        const st = userStepOf(id)
        return st ? { role: 'user' as const, content: st.content ?? '' } : null
      },
      step: (id) => {
        const st = compositeStep(id)
        // 注入的用户消息由 `message` 取回：这里的返回形状是
        // `{tool,status,args,outcome}`，套上去只会回一个 `tool:'unknown'`
        // 加两个空 JSON——看起来被处理了，实际什么都没答。
        if (!st || st.kind === 'user') return null
        return stepRecord(st)
      },
      byCallId: (callId) => {
        for (const run of listRuns(store, cid)) {
          const st = listSteps(store, run.id).find((x) => x.toolCallId === callId)
          if (st) return stepRecord(st)
        }
        return null
      },
      search: (query, limit) => {
        const hits: { id: string; kind: 'message' | 'step'; line: string }[] = []
        const needle = query.toLowerCase()
        for (const m of listMessages(store, cid, null)) {
          if (hits.length >= limit) return hits
          if (m.content.toLowerCase().includes(needle)) {
            hits.push({ id: m.id, kind: 'message', line: m.content })
          }
        }
        for (const run of listRuns(store, cid)) {
          for (const st of listSteps(store, run.id)) {
            if (hits.length >= limit) return hits
            /*
             * run 内注入的用户消息按**消息**报，不按执行记录报：正文在 `content`
             * 列而不是 payload 里，取回也由 `message` 负责。报成 step 的话
             * 摘录印的是空 payload，而模型拿着那个 id 去 `step` 只会得到 null。
             */
            if (st.kind === 'user') {
              const text = st.content ?? ''
              if (text.toLowerCase().includes(needle)) {
                hits.push({ id: `${run.id}:${st.id}`, kind: 'message', line: text })
              }
              continue
            }
            const body = `${st.toolName ?? ''} ${JSON.stringify(st.payload ?? {})}`
            if (body.toLowerCase().includes(needle)) {
              hits.push({ id: `${run.id}:${st.id}`, kind: 'step', line: body })
            }
          }
        }
        return hits
      },
    }
  })()
  return {
    ...port,
    forSubagent: (id) => {
      const child = getConversation(store, id as ConversationId)
      return child?.parentConversationId === cid ? historyPortFor(store, child.id) : null
    },
  }
}
