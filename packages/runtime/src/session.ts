/**
 * 将 store / adapter / registry / loop 组装为一个可执行的 run。
 *
 * 这是唯一的装配点：TUI、`qy exec`、`qy serve` 都从此处启动 run，
 * 不各自重复组装：三套装配会产生三套逐渐偏离的行为。
 */

import { readFile, stat } from 'node:fs/promises'
import { basename, isAbsolute, resolve } from 'node:path'
import {
  AgentLoop,
  type BrowserPort,
  type CanvasPort,
  type CompactionPort,
  type DelegatePort,
  type DesktopPort,
  decideCommand,
  envelopeResult,
  type HistoryPort,
  type HistoryStep,
  imagesOf,
  type LoopPersistence,
  type OfficePort,
  type PermissionVerdict,
  type PluginPort,
  type Summarizer,
  type ToolContextBase,
  ToolRegistry,
  videosOf,
} from '@qywork/agent'
import {
  buildAdapter,
  type ChatRequest,
  type ContentBlock,
  failureDiagnostics,
  type LlmAdapter,
  ProviderError,
  type ProviderProfile,
  type ProviderUsage,
  providerContentKind,
  providerErrorMessage,
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
  latestAnchoredProviderRequest,
  latestTodos,
  listLoadedTools,
  listMessages,
  listRuns,
  listSchedules,
  listSteps,
  listWorkflowRecords,
  markRunRunning,
  markStepExecuting,
  recordFileRead,
  recordLoadedTools,
  recordUsage,
  type Store,
  setConversationTitle,
  settleRunningSteps,
  settleToolStep,
  touchRun,
  updateGoal,
  updateRunMedia,
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
  shrinkImage,
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
import { requestPersistence } from './request-persistence.ts'
import { RuntimeSink } from './sink.ts'
import { buildHistory } from './transcript.ts'

export interface SessionOptions {
  store: Store
  config: QyConfig
  workspaceRoot: string
  /**
   * 正文库。未传入时本次执行不将中间资源写入磁盘，超出预算的输出只截断、不保存。
   * `qy exec` 等一次性执行可以省略；`qy serve` 必须提供。
   */
  content?: ContentStore
  signal: AbortSignal
  /**
   * 追加到冻结前缀末尾的角色约束。Agent Team 的成员会话用它承载角色提示词。
   *
   * 放在冻结前缀而不是运行上下文：角色约束在整个子会话中逐字不变，放入前缀可命中缓存；
   * 每个角色一份、各角色使用独立会话，不存在相互导致缓存失效的问题。
   */
  extraSystem?: string
  /**
   * 只注册所列工具。空数组与未传入语义不同：空数组表示纯分析角色，不提供任何工具；
   * 未传入表示全部内置工具。将两者合并会使「只读、不写」等配置静默失效。
   */
  allowedTools?: string[]
  /**
   * 派发通道。见 `DelegatePort`。
   *
   * 只传给顶层会话：成员会话不传，因此成员会话不注册 `subagent` 工具，
   * 递归派发任务在结构上不可能发生。
   */
  delegate?: DelegatePort
  /**
   * 插件安装通道。见 `PluginPort`。
   *
   * 只传给顶层会话：成员会话不传，因此成员会话不注册 `install_plugin`。
   */
  plugins?: PluginPort
  /**
   * 内置浏览器通道。见 `BrowserPort`。
   *
   * 由装配方依据当前是否存在可用的原生宿主实时判定后传入；未传入时本轮没有浏览器能力。
   * 会话结束时 `dispose` 会释放其占用的控制权与未消费的下载授权。
   */
  browser?: BrowserPort
  /**
   * 画布通道。见 `CanvasPort`。由服务端注入其画布服务；未传入时（CLI 会话）没有 `canvas` 工具。
   */
  canvas?: CanvasPort
  /**
   * 电脑控制通道。见 `DesktopPort`。
   *
   * 由装配方依据用户的启用开关与当前宿主状态实时判定后传入；未传入时本轮没有
   * 桌面能力。会话结束时 `dispose` 会撤销其名下尚未派发的请求。
   */
  desktop?: DesktopPort
  /**
   * Office 执行程序。见 `OfficePort`。
   *
   * 由装配方从进程级的 Office 宿主取得（`createOfficeHost`）；开关关闭或本机缺少 Python 与文档库时
   * 不传入，本轮没有 Office 工具。
   */
  office?: OfficePort
  /**
   * 取出当前标记为「调整方向」的跟进消息。每个 step 边界调用一次。
   *
   * 队列的真源在服务端的 `RunManager`（进程内，不写入磁盘）；此处将其接入 loop
   * 的对应端口，并将附件解析为内容块：loop 不访问磁盘。
   *
   * 只传给顶层会话：成员会话与 CLI 没有队列，不传入即不注入。
   */
  followUps?: (conversationId: ConversationId) => FollowUp[]
}

export interface AskOptions {
  /** 本轮强制使用该模型；未传入时使用会话当前模型。 */
  model?: string
  /** 幂等键。同一 (conversationId, clientRequestId) 不会启动两个 run。 */
  clientRequestId?: string
  /**
   * 本条消息携带的附件。
   *
   * 只保存定位信息（工作区相对路径），不将字节写入消息：这是 `Attachment`
   * 的既有约定（`core/domain/model.ts`）。正文在装配请求时才从磁盘读取，
   * 因此历史中保留的是路径，数十轮之后读取历史也不会附带数 MB 的 base64。
   */
  attachments?: Attachment[]
  /**
   * 该消息的来源：子 agent 的回执、workflow 的回执，缺省为用户本人。
   * 写入 `messages.origin`，界面据此区分回执行与用户气泡。
   */
  origin?: 'subagent' | 'workflow'
  /**
   * 本轮由哪次任务派发产生：父会话中派发卡的 step 与卡上对应的节点。
   * 写入 `runs.dispatch_step_id / dispatch_node_id`，变更投影据此将本轮的写入归入父轮次。
   */
  dispatch?: { stepId: StepId; nodeId: string }
  /**
   * 本轮新建会话时设置的来源标记（继续执行已有会话时无效）。
   *
   * 未填写时为 `null`，表示用户会话，出现在会话列表中。编排产生的成员子会话与
   * 子 agent 的会话必须填写其种类：`listConversations` 的判据是 `source IS NULL`，
   * 未填写时每执行一次 team，列表中会多出 N 条以成员 prompt 开头的条目，
   * 而这些会话无需由用户单独打开：它们由父会话的协作视图展示。
   */
  source?: Conversation['source']
  sourceRef?: string
  /**
   * 本轮新建会话时所属的父会话（继续执行已有会话时无效）。
   *
   * 派发任务创建的子会话必须填写：账本汇总、级联删除、运行页三项功能都由该字段推导，
   * 而归属只有在创建会话时才能正确写入，事后无法从任何来源推导。
   */
  parentConversationId?: ConversationId
}

export class Session {
  private readonly registry = new ToolRegistry()
  private readonly workspaceId: string
  private seqCounter = new Map<string, number>()

  /** 已加载的扩展。null = 尚未加载（首次 ask 时加载）。 */
  private extensions: Extensions | null = null

  /**
   * 外部工具的待加载池。null 表示本会话外部工具的 schema 总量在预算内，全部常驻。
   *
   * 待加载池中的工具不在注册表中，因此不进入请求；模型通过 `load_tool` 加载。
   */
  private pendingTools: PendingToolPool | null = null
  private externalToolNames = new Set<string>()

  /**
   * 规范化后的额外根目录。只计算一次：三个使用方（路径层、静态规则、沙箱）
   * 必须取得逐字节相同的结果；各自实时计算会产生分歧，导致
   * 一层放行、另一层拒绝，且报错信息互不相关。
   *
   * 校验不通过的条目在此处丢弃，原因写入 `configNotices`。
   */
  private readonly extraDirs: string[]

  /** 本轮技能索引中各技能的目录，在冻结上下文时取得一次，作为工具的只读根。 */
  private skillDirs: string[] = []

  /**
   * 各轮次的生成花费。生成通道成功时追加并写入 `runs.media_usage`（`recordMediaSpend`），
   * 本轮 usage 事件经过 `ask` 时附加，轮次结束时逐条记账后清除。
   */
  private readonly mediaSpends = new Map<RunId, MediaSpend[]>()
  /** 各轮次最近一次的模型用量。生成花费到达时补发 usage 事件，以该用量为基础。 */
  private readonly modelUsage = new Map<RunId, RunUsage>()

  constructor(private readonly opts: SessionOptions) {
    this.extraDirs = normalizeAdditionalDirectories(opts.config.additionalDirectories).dirs

    /*
     * 用户按下停止时立即撤销浏览器控制，不等待本轮收尾。
     *
     * 只在 `dispose()` 中释放时，中断信号须先经过 agent 循环、工具执行器和
     * 事件流才能到达此处，期间排队的动作仍会发送到网站。`release()` 是幂等的，
     * 收尾时再次调用为空操作，不构成第二条路径。
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
        // 桌面动作同理，且更为紧迫：排队中的 invoke 一旦派发即作用于用户正在查看的应用。
        void this.opts.desktop?.release().catch((err) => {
          log.warn(
            'desktop',
            `停止时撤销电脑控制失败：${err instanceof Error ? err.message : String(err)}`,
          )
        })
      },
      { once: true },
    )

    // 派发任务与安装插件都随各自的通道提供：成员会话两种通道都无法取得，因此其工具集中既没有
    // `subagent`（子 agent 不得再派发任务，递归没有终止条件），也没有 `install_plugin`
    // （子 agent 不应为整台机器安装插件）。
    // 画布与生成共用一个开关（`mediaEnabled`），缺省时按启用处理，与设置页显示值使用同一判据。
    const mediaOn = opts.config.mediaEnabled !== false
    const withDelegate = {
      delegate: opts.delegate !== undefined,
      plugins: opts.plugins !== undefined,
      mcpConfig: true,
      browser: opts.browser !== undefined,
      desktop: opts.desktop !== undefined,
      canvas: mediaOn && opts.canvas !== undefined,
      office: opts.office !== undefined,
      // 生成工具按已配置模型的类别注册；与其他内置工具规则相同，角色的 allowedTools 指定工具时按指定的工具过滤。
      media: mediaOn ? [...new Set(listMediaModels(opts.config).map((m) => m.output))] : [],
    }
    if (opts.allowedTools === undefined) {
      registerBuiltinTools(this.registry, withDelegate)
    } else {
      // 先注册到临时表再筛选：内置工具集合由 registerBuiltinTools 私有维护，
      // 在此处另行复制一份工具名列表必然与之不一致。
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
   * 解析本轮使用的接口与凭证。
   *
   * 入参是 `ModelRef` 时接口已确定（会话自身记录了归属），是裸模型名时
   * 按模型 id 反查接口：后者用于 `qy ask --model x` 这类用户只指定模型、不指定接口
   * 的入口。规则只有 `resolveModel` 一处：界面上列出的协议与本轮实际
   * 发出的协议必须一致。
   *
   * 每次使用时实时解析：在构造函数中解析一次并固定时，会话级模型切换无法生效。
   */
  private resolveProfile(target?: string | ModelRef): ProviderProfile {
    const { providers, active } = this.opts.config
    const stored = resolveModel(this.opts.config, target)
    if (!stored) {
      const who = typeof target === 'object' ? target.provider : (active?.provider ?? '（未配置）')
      throw new Error(
        `配置中没有名为 "${who}" 的接口。可用：${Object.keys(providers).join(', ') || '（空）'}`,
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
   * 每轮新建 loop：adapter 绑定具体模型，而模型可能刚被切换。
   *
   * 这与「ToolContext 每轮只创建一个」不冲突：该约束指一个 run 内部
   * 不能每个波次重建（会丢失读取文件的状态），run 之间重建是必需的。
   */
  private makeLoop(
    target: string | ModelRef,
    adapter: LlmAdapter,
    conversationId: ConversationId,
    compaction?: CompactionPort,
  ): AgentLoop {
    // 能力段按已注册的工具名过滤：shell、任务派发、编排、外部工具都按通道注册。
    const { outputLimitNote, maxOutputTokens } = adapter.spec
    const base = buildSystemPrompt(
      new Set(this.registry.list().map((s) => s.name)),
      outputLimitNote && maxOutputTokens ? maxOutputTokens : undefined,
    )
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
      beforeRequest: async () => {
        await this.loadExtensionTools(adapter.spec.density, conversationId)
      },
      makeToolContext: (runId, emit) =>
        this.makeToolContext(runId, emit, target, conversationId as ConversationId),
      persist: this.makePersistence(),
      ...(compaction ? { compaction } : {}),
    })
  }

  /** 新建或继续执行一个会话。返回事件流，由调用方决定如何渲染。 */
  async *ask(
    prompt: string,
    existing?: ConversationId,
    options?: AskOptions,
  ): AsyncGenerator<AgentEvent, void, unknown> {
    const { store, config } = this.opts

    // 模型优先级：本轮显式指定 > 会话当前模型 > 配置默认。
    // 会话是权威：config 只在会话尚无模型时作为回退，否则用户在界面上切换模型后，
    // 下一轮又会被配置文件中的默认值静默改回。使用 `||` 而不是 `??`：未配置模型的会话
    // provider/model 存储为空串，空串须视为未设置并继续回退。
    const prior = existing ? getConversation(store, existing) : undefined
    const model = options?.model || prior?.model || config.active?.model
    // 三处均无法取得模型表示用户尚未配置模型：在启动 run 之前于此处拒绝，不创建会话、不发送请求。
    // 服务端已在 `run-control` 中预先拦截并返回结构化的 `no_model`；此处是 CLI 与直接调用的后备处理。
    if (!model) throw new Error(NO_MODEL_MESSAGE)

    const conversationId =
      existing ??
      createConversation(store, {
        workspaceId: this.workspaceId as never,
        // 新会话记录默认的接口与模型；没有默认接口时按哪个接口配置了该模型反查。
        provider: config.active?.provider || resolveModel(config, model)?.provider || '',
        model,
        ...(options?.source ? { source: options.source } : {}),
        ...(options?.sourceRef ? { sourceRef: options.sourceRef } : {}),
        ...(options?.parentConversationId
          ? { parentConversationId: options.parentConversationId }
          : {}),
      }).id

    const conversation = getConversation(store, conversationId)
    // 旧会话记录了模型却无法证明接口归属（迁移前的扁平档案）时要求重新选择一次，不按 id 反查。
    // 但只针对「有模型、无接口」的旧会话：未配置默认模型时新建的会话两个字段均为空，
    // 上面的 `model` 已回退到当前默认值，按默认的接口与模型发送，不应报告为旧会话。
    if (conversation && !options?.model && conversation.model && !conversation.provider) {
      throw new Error('该会话未记录所属接口，请重新选择模型后继续')
    }
    /*
     * 会话记录了接口名时按记录的接口与模型发送，不再按模型 id 反查：两个接口配置同一
     * 模型 id 时反查结果取决于枚举顺序，出错时端点、key 与价目表都会改变，且不会报错。
     * 单轮显式 `--model` 仍是用户主动要求的裸模型选择，不属于旧会话回退。
     */
    const target: string | ModelRef =
      !options?.model && conversation?.provider ? { provider: conversation.provider, model } : model
    // 思考强度按本轮实际使用的模型解析，真源是配置中
    // 「接口 × 模型」对应的条目。不保存会话级的第二份，也不共用一个全局值：
    // 档位集合因模型而异（见 `StoredModel.effort`），套用全局值必然不匹配。
    const resolvedTarget = resolveModel(config, target)
    const effort = resolvedTarget?.effort

    /*
     * 冻结本 run 的非对话上下文。
     *
     * 这一步必须在写入 run 之前完成：扩展工具、技能、记忆与待办只读取一次，随后与 run
     * 同行写入数据库。loop 内任何一次 provider 请求都不再临时重新计算，重启也从同一份快照
     * 重建，因此上下文字节不会随执行波次变化。
     */
    const adapter = buildAdapter(this.resolveProfile(target))
    if (!this.extensions) {
      await this.loadExtensionTools(adapter.spec.density, conversationId)
    }
    const roots = scopeRoots(this.opts.workspaceRoot)
    const skills = await scanSkills(roots).catch(() => [])
    this.skillDirs = skills.map((s) => s.dir)
    const memories = await listScopedEntries(roots).catch(() => [])
    const canAssignModels = ['define_role', 'subagent', 'workflow'].some((name) =>
      this.registry.has(name),
    )
    // 只列出本会话实际拥有工具的类别：角色只指定了视频工具时，不提供图像模型的参数表。
    const mediaModels = listMediaModels(config).filter((m) =>
      this.registry.has(MEDIA_TOOLS[m.output].name),
    )
    // 角色、外部 CLI、本会话已有的子 agent：模型据此按 id 引用，不推测名称。
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
      // 派发工具存在时才提供；成员会话没有 delegate，既看不到清单也无法递归派发任务。
      ...(canAssignModels
        ? {
            models: Object.entries(config.providers).flatMap(([provider, stored]) =>
              Object.keys(stored.models).map((model) => ({ provider, model })),
            ),
          }
        : {}),
      ...delegateFacts,
      // 参数表随生成工具提供：工具未注册（未配置模型、角色未指定）时不提供。
      ...(mediaModels.length ? { mediaModels } : {}),
      externalTools: this.pendingTools?.index() ?? [],
      todos: latestTodos(store, conversationId),
      // 未执行完毕的任务图随快照一并冻结。没有派发通道时不存在任务图，无需查询。
      ...(canAssignModels ? { workflows: unfinishedWorkflows(store, conversationId) } : {}),
    })

    /*
     * 追加用户消息、生成标题、创建轮次、标记 running 在同一个写事务中完成。`createRun` 发现该会话被
     * 另一个进程占用时抛出 `ConversationBusyError`，整个事务回滚：被拒绝的消息不写入数据库，
     * 不留下没有回答的用户消息。
     */
    const run = store.tx(() => {
      const userMessageId = appendMessage(store, {
        conversationId,
        role: 'user',
        content: prompt,
        ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
        ...(options?.origin ? { origin: options.origin } : {}),
      }).id

      /*
       * 标题在第一条用户消息写入数据库之后产生，全项目只有这一处产生点。
       * 创建会话时不生成标题：界面端先创建会话、后发送第一条消息，此时正文尚不存在。
       *
       * 只在标题为空时写入：用户修改过的名称不得被下一条消息覆盖。上面读取 `conversation` 之后
       * 间隔若干 await，用户可能刚修改过名称，因此「标题为空」由写入语句自行判断（`onlyIfEmpty`）。
       */
      if (!conversation?.title) {
        const derived = deriveConversationTitle(prompt)
        if (derived) setConversationTitle(store, conversationId, derived, { onlyIfEmpty: true })
      }

      const created = createRun(store, {
        conversationId,
        workspaceId: this.workspaceId as never,
        model,
        clientRequestId: options?.clientRequestId ?? crypto.randomUUID(),
        userMessageId,
        // 高水位：本轮固定在刚写入的消息。排队期间新到达的消息不进入本轮。
        messageIdUpperBound: userMessageId,
        contextSnapshot,
        ...(options?.dispatch ? { dispatch: options.dispatch } : {}),
      })
      markRunRunning(store, created.id)
      return created
    })
    const userMessageId = run.userMessageId

    /*
     * 历史 = 消息 + 由 steps 投影出的 assistant/tool 回合。
     *
     * 只映射 `listMessages` 不够：该表只有 user 行（全项目唯一的
     * `appendMessage` 位于上方几行，写入的是 `role:'user'`），因此从第二轮起模型取得的
     * 输入中只有用户消息、没有任何助手回复，跨轮次的上下文在结构上丢失。
     */
    const preserveAssistantReasoning = adapter.spec.chatReasoningProtocol !== 'standard'
    const history = await buildHistory(
      store,
      conversationId,
      run.messageIdUpperBound,
      (content, list) => withAttachments(this.opts.workspaceRoot, content, list as Attachment[]),
      { preserveAssistantReasoning },
    )

    /*
     * 将账本中最后一次真值回执传给 loop 作为锚点。
     *
     * 覆盖边界取该回执所属 run 的消息高水位：其后的历史消息未计入锚点。
     * 没有回执（新会话，或始终未取得 usage）时不传入，loop 回退到本地估算并如实
     * 标记 `estimated`。
     */
    const latestAnchor = latestAnchoredProviderRequest(store, conversationId)
    /*
     * 真值锚点属于「接口 × 协议 × 模型」这一路线，不只属于模型名。
     * 同一 model id 配置在两个中转站上时，usage 统计口径与实际 tokenizer 都可能不同；
     * 只有完整路线匹配的数据才可复用。迁移前缺少接口或协议的旧行仍保留用于诊断，
     * 但不能参与当前上下文的裁决。
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
          // 指纹不匹配时由 loop 替换头部（切换模型时才失效）：只有装配完成后才能确定本轮的信封。
          envelopeFingerprint: anchored.cacheRouteFingerprint,
        }
      : null

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
        updatedAt: announced.updatedAt,
      }
    }

    // run.started 必须由此处发送：没有发送方时客户端无法取得真实 runId，中断和重试
    // 只能将步骤 id 当作 run id 使用，服务端查询不到时静默不执行任何操作。
    // 协议中有类型不等于有实现。
    yield {
      type: 'run.started',
      runId: run.id,
      conversationId,
      model,
      userMessageId: userMessageId ?? null,
      // 正文一并发送：服务端自行发起的轮次（目标自动继续、定时触发、跟进消息发起）
      // 没有客户端的乐观插入，界面上显示的用户消息只能来自此处。
      userMessage: {
        content: prompt,
        ...(options?.attachments?.length ? { attachments: options.attachments } : {}),
        // 与上面写入 `messages.origin` 的字段取值相同：两侧口径不一致时，
        // 回执发起的轮次实时渲染为用户气泡，刷新之后才变为回执行。
        ...(options?.origin ? { origin: options.origin } : {}),
      },
    }

    // 压缩端口绑定到本会话与本 run 的高水位：压缩范围不得超过 run 创建时固定的水位，
    // 否则会将排队期间新到达的消息一并压缩，而本轮尚未读取这些消息。
    const compaction = new RuntimeCompaction({
      store,
      conversationId,
      messageIdUpperBound: run.messageIdUpperBound,
      summarize: makeSummarizer({
        profile: () => this.resolveProfile(target),
        effort: () => resolveModel(this.opts.config, target)?.effort,
        signal: this.opts.signal,
      }),
      preserveAssistantReasoning,
    })

    /*
     * 心跳：告知其他进程本轮仍在运行。
     *
     * 账本是共享的，一台机器上同时存在多个写入者（两个工作区的 sidecar、
     * 开发态热重载、终端中的 `qy exec`）。后启动的进程在启动时回收残留 run，
     * 判据即该心跳与 `owner_pid`（见 `store/repos.ts` 的 `isOrphan`）：
     * 不推送心跳时，其他进程启动后即会将正在运行的 run 判定为中断。
     *
     * `unref()`：该定时器不应阻止进程退出。
     */
    const heartbeat = setInterval(() => touchRun(store, run.id), HEARTBEAT_MS)
    heartbeat.unref?.()

    let finished = false
    /*
     * 报错正文必须写入数据库。`runs.error_message` / `error_code` 两列是 `RunRecord`
     * 中报错正文的唯一来源；不写入时，`stop_reason` 为
     * `provider_error` 的 run 在账本中的报错正文是 `null`，界面刷新之后
     * 只显示「模型服务出错」，无法区分连接失败与 key 错误。
     *
     * `run.error` 恒在 `run.finished` 之前（`agent/loop/index.ts` 连续 yield 两条），
     * 因此在此处处理即可，无需另开一条持久化路径。
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
        // 传入上一轮的真值，使本轮开头使用同一计量基准。不传入时每个 run 的
        // 第一次请求只能报告估算值（系统性偏低），第二次起恢复为真值，
        // 读数在每轮开头出现一次下跌。
        ...(anchor ? { anchor } : {}),
      })) {
        if (ev.type === 'run.error') failure = { message: ev.message, code: ev.code }
        if (ev.type === 'usage') this.modelUsage.set(run.id, ev.usage)
        // 本轮的生成花费附加到 usage：读数条与「运行」面板按 `runCosts` 将其与模型花费合并显示。
        // 下面记账使用的 `ev.usage` 仍只含模型调用部分。
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
          // 账本在收尾时记录一次。中途的 usage 是累计值，每次都记录会将同一笔费用
          // 重复记账；而 run 上的 usage 会随会话删除一并消失，无法用于
          // 统计月度花费。
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
      // 先停止心跳。停止较晚不影响正确性（只更新 running 的行），但最先停止才能保证
      // 无论下面哪一步抛出异常，都不会留下仍在推送心跳的定时器。
      clearInterval(heartbeat)
      // 生成花费逐条记账。放在此处而不是 `run.finished` 分支：被中断或连接关闭的轮次同样已经扣费。
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
      // 生成器被提前关闭（用户 Ctrl-C、客户端断开连接）时也须为 run 写入终态，
      // 否则账本中会永久保留一条 running 的孤儿记录。
      // 边界：此处只覆盖 `run.started` 之后。在此之前关闭生成器或抛出异常时，run 行停留在
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
      // step 也须写为终态，不只是 run。
      //
      // 只对 run 收尾不够：在 `tool.started` 的 yield 处被 `.return()` 中止时，
      // step 已是 running 却无人 settle；run 随即被标为终态，因此该 step
      // 永远不会被启动时的 `recoverStaleRuns` 处理（它只扫描 running/queued 的 run）。
      //
      // 后果不限于界面上一张持续显示加载状态的卡片：历史投影必须跳过含未终结调用的整个 batch，
      // 一条孤儿 step 会使同批次中已经成功的写文件结果一并从历史中消失。
      settleRunningSteps(store, run.id)
    }
  }

  /**
   * 获取扩展并将其提供的工具注册到本会话的工具表。
   *
   * 按总量分两种处理：外部工具的 schema 总量在预算内时全部注册（省去一次往返），
   * 超出时全部进入待加载池、只注册一个 `load_tool`，清单进入下一份 run 快照。
   * 阈值与实测数据见 `tools/tool-pool.ts`。
   *
   * 注册失败（重名）只跳过该工具：因一个重名的插件工具导致整个会话无法启动，
   * 代价不成比例。
   */
  private async loadExtensionTools(
    density: TokenDensity,
    conversationId?: ConversationId,
  ): Promise<boolean> {
    const ext = await acquireExtensions(this.opts.workspaceRoot, (line) =>
      log.info('extensions', line),
    )
    const previous = this.extensions
    if (previous?.mcp === ext.mcp) {
      await ext.stop()
      return false
    }
    try {
      const allow = this.opts.allowedTools ? new Set(this.opts.allowedTools) : null
      const eligible = ext.toolSpecs.filter((spec) => !allow || allow.has(spec.name))
      const owned = new Set([
        ...this.externalToolNames,
        ...(this.pendingTools ? ['load_tool'] : []),
      ])
      const loaded = new Set([
        ...this.registry
          .list()
          .filter((spec) => this.externalToolNames.has(spec.name))
          .map((spec) => spec.name),
        ...(conversationId ? listLoadedTools(this.opts.store, conversationId) : []),
      ])
      const onDemand =
        !allow && externalSchemaTokens(eligible, density) > EXTERNAL_SCHEMA_BUDGET_TOKENS
      let pool: PendingToolPool | null = null
      let resident = eligible
      if (onDemand) {
        pool = new PendingToolPool({
          registry: this.registry,
          onLoaded: (names) => {
            if (conversationId) recordLoadedTools(this.opts.store, conversationId, names)
          },
        })
        resident = eligible.filter((spec) => loaded.has(spec.name))
        for (const spec of eligible) if (!loaded.has(spec.name)) pool.add(spec)
        resident = [...resident, makeLoadToolTool(pool)]
      }
      this.registry.replaceOwned(owned, resident)
      this.pendingTools = pool
      this.externalToolNames = new Set(eligible.map((spec) => spec.name))
      this.extensions = ext
    } catch (error) {
      await ext.stop()
      throw error
    }
    if (previous) await previous.stop()
    for (const failure of ext.plugins.failures)
      log.warn('extensions', `插件加载失败 ${failure.dir}：${failure.reason}`)
    for (const failure of ext.mcp.failures)
      log.warn('extensions', `MCP ${failure.server}：${failure.reason}`)
    if (this.opts.allowedTools) {
      const invalid = this.opts.allowedTools.filter((name) => !this.registry.has(name))
      if (invalid.length)
        log.warn('session', `角色 allowedTools 含无效工具引用，已忽略：${invalid.join('、')}`)
    }
    return true
  }

  /**
   * 释放本会话对扩展的引用。会话结束时必须调用。
   *
   * 不直接 stop：扩展按工作区共享，其他会话可能仍在使用。
   * 引用计数归零时才关闭子进程。
   *
   * 该方法必须有实际调用点。没有调用点时，server 为每条消息新建的 Session 各自
   * 启动一套插件子进程，且都不会关闭：公开方法有定义不等于有调用方。
   */
  async dispose(): Promise<void> {
    /*
     * 浏览器控制与会话绑定：本轮收尾时撤销控制归属与未消费的下载授权，页面保留
     * 供用户继续操作。不释放时下一轮启动会得到 busy，且没有任何入口能解除。
     *
     * 失败只记录一行日志：宿主可能已经断开，而断开路径本身也会撤销这两项。
     */
    this.opts.browser?.release().catch((err) => {
      log.warn('browser', `释放浏览器控制失败：${err instanceof Error ? err.message : String(err)}`)
    })
    // 电脑控制与会话绑定：本轮收尾时撤销本执行者名下尚未派发的请求。
    // 已经交给操作系统的动作不回滚：那是执行事实，不是可撤销的占用。
    this.opts.desktop?.release().catch((err) => {
      log.warn('desktop', `撤销电脑控制失败：${err instanceof Error ? err.message : String(err)}`)
    })
    if (!this.extensions) return
    const ext = this.extensions
    this.extensions = null
    await releaseExtensions(ext)
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
      // 创建即为终态：注入的消息没有中间状态，`status` 使用默认的 `done`。
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
            ...(input.notice ? { notice: true as const } : {}),
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
          // action 必须写入数据库：它由 ToolSpec 按参数解析，前端无法反向推导。
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
      recordCompaction: (runId, seq, payload) => {
        appendStep(store, {
          runId,
          seq,
          kind: 'compaction',
          // 列值由 phase 导出，不由调用方再报告一次：两处各报告一次即形成两本账，
          // 且会出现不一致。终态的细分（skipped 与 failed）位于 payload 中。
          status: payload.phase === 'done' ? 'success' : 'failure',
          payload: {
            kind: 'compaction',
            ...payload,
            ...(payload.message
              ? { message: redactSecrets(payload.message, collectSecrets(this.opts.config)) }
              : {}),
          },
        })
      },
      ...requestPersistence(store, this.opts.config),
    }
  }

  /**
   * 授权裁决。只有两种模式，不弹出确认框。
   *
   * `full` 模式下仍保留的只有凭证剥离。`scrubEnv` 在两种模式下行为相同：它不是裁决，而是「明文
   * key 不进入子进程」这一与模式无关的事实。路径约束不在此列：`full` 的语义是「全部权限」，路径
   * 边界随之一并放开（`makeToolContext` 的 `unrestrictedPaths`）。
   *
   * 只放开权限检查而保留路径层不会更安全，只会形成两套账：同一模式下
   * `run_command` 全部放行，shell 中一个 `cd` 即可离开工作区，而 `read_file` 仍被拦截；
   * 账本中有实际记录，模型随即改用 shell 读取了同一个文件
   * （会话 `cv_0msw3jst9`）。
   *
   * `auto` 模式下各类工具的处理方式。判据是该操作由谁决定，而不是代码来源：
   *
   * - 文件与网络类（read/write/delete/network）：路径已由
   *   `resolveInWorkspace` 限定，外发请求已经过 SSRF 防护，均为确定性判断，
   *   越界的调用不会到达此处。因此放行，不再额外裁决。
   * - MCP 与插件工具：由用户显式配置或安装，属于知情同意，放行；
   *   不为用户自选的扩展另设第三套检查。
   * - 内置浏览器工具（`browser` 效果）：端口由装配方按本轮执行注入，
   *   参数中自报的会话、Run、工作区根一律不读取；页面归属由宿主裁决，用户手动打开的页面
   *   须由用户指定后经 `bind` 才归属本会话；上传与下载的路径与文件工具使用同一份裁决。
   *   边界均位于参数解析之前，放行。
   * - 内置桌面工具（`desktop` 效果）：端口由装配方按用户的启用开关与宿主状态注入，
   *   参数中只有端口发放的不透明目标 id，OS 句柄不会交给模型；能否操作由
   *   系统授权与宿主裁决。边界同样位于参数解析之前，放行。
   * - `run_command`：唯一能同时绕过路径约束与 SSRF 防护的工具
   *   （命令字符串中的路径不经过参数解析），只有它需要实际裁决。
   */
  private async decide(call: {
    toolName: string
    args: Record<string, unknown>
  }): Promise<PermissionVerdict> {
    if ((this.opts.config.mode ?? 'auto') === 'full') return { allowed: true }

    if (call.toolName !== 'run_command') return { allowed: true }

    const command = String(call.args.command ?? '')
    // 根目录清单必须与路径层、沙箱层使用同一份。三处分别计算时，
    // 配置只在其中一层生效，且三层的报错互不相关。
    const d = decideCommand(command, {
      workspaceRoot: this.opts.workspaceRoot,
      ...(this.extraDirs.length ? { additionalDirectories: this.extraDirs } : {}),
    })
    if (d.kind === 'allow') return { allowed: true }
    /*
     * 该文本是模型在 `auto` 模式下能取得的唯一信号，因此必须给出正当的处理方式。
     *
     * 不要写成「换一条不执行该操作的命令」：这等于引导模型绕过规则，`rm -rf ~/x` 被拦截后
     * 会被改写为 `python -c "import shutil; shutil.rmtree(...)"`，后者不在
     * `HARD_DENY` 表中即被放行。规则拦截的是操作本身，而不是某种写法。
     *
     * 不附带 scope：`execute:<目标>` 对模型没有信息量，模型不了解 scope 的含义，
     * 而命令正是它刚刚发出的。
     */
    return {
      allowed: false,
      reason:
        `此命令被权限规则拦截：${d.reason}。当前为「自动审批」模式，该模式只放行确定安全的命令。` +
        `可选处理：① 告知用户该步骤需要更高权限，由用户改为「完全访问」模式；② 跳过该步骤，执行其他任务。` +
        `不要改写命令后重试：拦截依据是操作本身，而不是命令写法。`,
    }
  }

  /**
   * 记录一次生成花费：写入本轮的 `runs.media_usage`，并补发一次 usage 事件，使读数条与面板在轮次运行期间即可显示。
   * 事件中的模型用量取本轮最近一次的值，生成花费由 `ask` 统一附加。
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
    // 三项逐模型的能力取自同一份 spec：分别解析时，切换模型后三项可能来自
    // 两次不同的解析结果。
    const adapter = buildAdapter(this.resolveProfile(target))
    const spec = adapter.spec
    return {
      workspaceRoot: this.opts.workspaceRoot,
      conversationId,
      runId,
      model,
      // 投递预算按上下文窗口计算，且在执行时应用：切换模型只影响之后的读取，
      // 已写入数据库的 step 不做任何修改（投影因此仍是纯函数）。
      contextWindow: spec.contextWindow,
      // 预算扣减使用的 token 密度与窗口取自同一份 spec，理由见 `ToolContext.density`。
      density: spec.density,
      vision: spec.vision,
      // 与发送时 `materialize` 的视频判据相同：模型支持视频且适配器能够传输。
      video: spec.video && adapter.transmits.video === true,
      ...(adapter.transmits.mediaUploadAbove !== undefined
        ? { videoUploadAbove: adapter.transmits.mediaUploadAbove }
        : {}),
      resources: new Map(),
      state: new Map(),
      // sink 绑定到本 run：登记行须能追溯到产生该正文的轮次，
      // run 被删除时引用随之消失，GC 才能回收正文。
      sink: this.opts.content ? new RuntimeSink(this.opts.store, this.opts.content, runId) : null,
      /*
       * 读取记录绑定到会话，而不是 run。
       *
       * 服务端为每条消息新建一个 Session（`run-control.ts`），进程内没有
       * 会话级的生命周期可供依附，因此真源放在账本中，随会话一并删除。
       * 绑定到 run 时，每轮第一次修改文件必然先因「未读取」失败一次，
       * 而该守卫判定的是「待写入的版本是否就是读取过的版本」，与 run 边界无关。
       */
      reads: {
        seen: (path) => fileReadHash(store, conversationId, path),
        mark: (path, hash) => recordFileRead(store, conversationId, path, hash),
      },
      /*
       * 待办同样绑定到会话，且只读：父会话的整表提交与子任务的待验收回执
       * 本身就是需要写入的 tool step；只有 `write_todos` 改变当前快照。
       * 此处读取的结果供动作词、委派归属与 loop 收尾共用；run 级的 `ctx.state`
       * 无法跨轮查询这些会话级事实。
       */
      todos: { read: (runId) => latestTodos(store, conversationId, runId) },
      /*
       * 目标同样绑定到会话：其生命周期与会话相同，只有跨轮保留才有意义。
       *
       * 事件在此处发出，不在工具中发出（对比 `emitTodos`）：目标的真源是账本，
       * 写入与广播是同一操作的两部分，交给工具时可能只完成其中一部分。
       * 事件不带 runId：目标是会话级的，服务端在 run 之外也会修改它。
       *
       * 没有 create：设立目标是用户的操作，经由 `goal.set` 指令，不经过工具。
       */
      goals: {
        read: () => currentGoal(store, conversationId),
        update: (input) => announce(updateGoal(store, { conversationId, ...input }), emit),
      },
      /*
       * 定时任务绑定到当前工作区：整台机器只有一张任务表，端口在此处固定归属，
       * 工具一侧没有跨项目的入口。写入与调度 tick 使用同一份仓储，不另设落盘路径。
       *
       * 创建的任务同时绑定到顶层会话：触发时消息发往该会话，而子会话不接受直接发送的消息
       * （`server/commands.ts` 的 `message.send` 直接拒绝），绑定到子会话的任务无法触发。
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
      // 派发通道原样传递：是否可以派发、派发给谁由装配方（server）决定，
      // 此处不在缺失时构造空通道，否则 `subagent` 已注册却无法派发。
      ...(this.opts.delegate ? { delegate: this.opts.delegate } : {}),
      ...(this.opts.plugins ? { plugins: this.opts.plugins } : {}),
      ...(this.opts.browser ? { browser: this.opts.browser } : {}),
      ...(this.opts.desktop ? { desktop: this.opts.desktop } : {}),
      ...(this.opts.canvas ? { canvas: this.opts.canvas } : {}),
      mcpConfig: makeMcpConfigPort(this.opts.workspaceRoot),
      skillSourcePaths: () =>
        listMessages(store, conversationId, null).flatMap((m) => m.attachments.map((a) => a.path)),
      ...(listMediaModels(this.opts.config).length
        ? {
            media: makeMediaPort(this.opts.config, (spend) =>
              this.recordMediaSpend(runId, spend, emit),
            ),
          }
        : {}),
      /*
       * 已折叠历史的读取通道。压缩是投影而不是删除，原文始终保留在账本中，
       * 该通道负责将原文提供给模型；缺少该通道时，摘要中的 `[message:…]` 标记指向
       * 模型无法访问的位置，压缩即等同于丢失信息。
       *
       * 使用 list + find 而不是为 store 增加按 id 读取的函数：这是模型主动发起的
       * 低频调用，且会话消息与单个 run 的 step 都是小集合。
       */
      history: historyPortFor(store, conversationId as ConversationId),
      signal: this.opts.signal,
      emitTodos: (todos) => {
        emit({ type: 'todos', runId, todos })
      },
      secrets,
      ...(this.opts.config.envAllowList ? { envAllowList: this.opts.config.envAllowList } : {}),
      ...(this.extraDirs.length ? { additionalDirectories: this.extraDirs } : {}),
      // 本轮技能索引中各技能的目录：其中的参考文档、模板与代码可读、不可写。
      ...(this.skillDirs.length ? { readOnlyRoots: this.skillDirs } : {}),
      ...(this.opts.office ? { office: this.opts.office } : {}),
      // 「完全访问」即全部权限，路径边界也由它决定。这与下方 `decide` 中
      // 「`full` 不裁决」是同一规则的两个方面：只放开权限检查而保留路径层，
      // 会形成「read_file 被拒、run_command 可读」的两套账。
      ...((this.opts.config.mode ?? 'auto') === 'full' ? { unrestrictedPaths: true } : {}),
      requestPermission: (call) => this.decide(call),
    }
  }
}

export interface SummarizerOptions {
  /** 每次调用时实时解析：发起摘要时会话模型可能已被切换。 */
  profile: () => ProviderProfile
  /** 用户为当前「接口 × 模型」选择的思考档位；undefined 表示省略该字段，沿用模型默认值。 */
  effort?: () => EffortLevel | undefined
  /** 调用方的中断信号。未传入时只受流空闲判定约束。 */
  signal?: AbortSignal
}

/**
 * 摘要生成器：使用会话当前的 provider 档案，独立于主循环发送一次请求。
 *
 * 自动触发与手动 `/compact` 共用此实现。两份装配会逐渐偏离，且偏离难以
 * 发现：两条路径都能产出摘要，无法看出口径已经不同。
 *
 * 有意不带工具与冻结前缀：摘要任务只需输入文本、输出文本，附带工具 schema
 * 会使本次调用同样逼近容量上限，而该调用正是在容量已超出时发出的。
 *
 * 思考档位遵循用户选择：用户已选择时原样继承，未选择时省略该字段、沿用模型默认值。
 * 摘要任务不得为提速而在后台降低用户选择的档位，也不得发送关闭思考的参数。
 *
 * 空闲上限交给传输层按字节判定（`idleTimeoutMs`，与主请求使用同一基准），此处不另设计时。
 * 不要改为总时长上限：持续输出的慢速摘要并非无响应，中止它等于作废一次已经计费的
 * 正常调用。
 *
 * 预算单位是 token，直接作为 `max_tokens` 申报。以 `max_tokens` 结束的调用返回
 * null：不完整的摘要比没有摘要更有害，因为它看起来是完整的。
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
    /** 摘要被输出上限截断。截断的摘要一律不采用：不完整的摘要看起来是完整的。 */
    let truncated = false
    let finish: string | undefined
    // 自动与手动摘要的请求和花费都由 trace 写回所属轮次。
    let usage: ProviderUsage | null = null
    const req: ChatRequest = {
      model: adapter.spec.id,
      system: [{ text: '你是会话摘要器。只输出摘要正文。' }],
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      /*
       * 会思考的模型不能以正文预算作为 `max_tokens`。
       *
       * 思考与正文共用同一上限，而思考不进入投影；限制为正文预算时，
       * 模型在思考阶段即耗尽额度，正文未写完即被截断，整份作废
       * （实测 deepseek-v4-flash：一句话摘要消耗 259 个思考 token，
       * 正文只有 10 个字）。结果是摘要段始终失败，压缩退化为只有收纳段。
       *
       * 正文长度由提示词中的字数要求约束，此处只保证模型有足够的输出空间。
       * 不思考的模型的正文即全部输出，直接申报预算即可。
       */
      maxOutputTokens: willThink
        ? adapter.spec.maxOutputTokens
        : Math.min(adapter.spec.maxOutputTokens ?? budgetTokens, budgetTokens),
      idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
      ...(effort ? { effort } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    }
    if (!trace) throw new Error('摘要请求缺少会话记账上下文')
    const requestId = trace.open(req, adapter)
    let sawEvent = false
    let providerEvents = 0
    let lastEventAt = Date.now()
    try {
      trace.sent(requestId)
      for await (const ev of adapter.stream(req)) {
        if (ev.type !== 'request_prepared' && ev.type !== 'response_started') {
          providerEvents++
          lastEventAt = Date.now()
        }
        if (!sawEvent && ev.type !== 'request_prepared' && ev.type !== 'response_started') {
          sawEvent = true
          trace.firstEvent(requestId)
        }
        if (ev.type === 'response_started') {
          trace.headers(requestId, ev.headersAt)
        }
        const kind = providerContentKind(ev)
        if (kind !== null && 'at' in ev) trace.content(requestId, ev.at, kind)
        if (ev.type === 'text_delta') text += ev.delta
        else if (ev.type === 'done') {
          truncated = ev.stopReason === 'max_tokens'
          finish = ev.rawStopReason
        } else if (ev.type === 'usage') {
          usage = ev.usage
        }
      }
    } catch (err) {
      const pe = err instanceof ProviderError ? err : null
      // 非 2xx 响应的响应头不经过 `response_started`，其时刻只记录在传输读数中。规则与主请求相同。
      if (pe?.transport?.headersAt != null) trace.headers(requestId, pe.transport.headersAt)
      // 与主请求使用同一套终态：被拒绝为 rejected，其余情况（流被截断、中断、连接断开）均为 uncertain。
      trace.settle(
        requestId,
        pe?.status !== undefined ? 'rejected' : 'uncertain',
        pe?.usage ?? usage,
        opts.signal?.aborted ? null : (pe?.code ?? 'internal_error'),
        finish,
        providerErrorMessage(err),
      )
      trace.diagnostic(requestId, {
        ...failureDiagnostics(err),
        providerEvents,
        silentMs: Math.max(0, Date.now() - lastEventAt),
        assistantChars: text.length,
        toolCallCount: 0,
        retry: {
          decision: opts.signal?.aborted ? 'interrupted' : 'not_retryable',
          attempt: null,
          max: 0,
          backoffMs: null,
          at: null,
        },
      })
      throw err
    }

    trace.settle(requestId, 'received', usage, null, finish)
    // 截断作废与空摘要使用同一终态：调用方据此判定摘要段未生成，收纳段照常写入数据库。
    return truncated ? null : text.trim() || null
  }
}

/**
 * 目标写入成功时广播一次。
 *
 * 失败结果原样返回、不发出事件：失败结果是给模型的拒绝理由（例如 revision 过期），
 * 账本没有任何变化，广播会使界面上的目标无故闪烁。
 */
function announce(result: GoalWriteResult, emit: (e: AgentEvent) => void): GoalWriteResult {
  if (result.ok) emit({ type: 'goal', goal: result.goal })
  return result
}

/** 心跳间隔。回收方按 60 秒判定过期（`store/repos.ts`），留有六倍余量。 */
const HEARTBEAT_MS = 10_000

type InterruptionSource = RunInterruption['source']

/** AbortSignal.reason 是进程内的中止来源；调用方未携带 reason 时沿用 fallback。 */
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
 * 附件图片缩放并编码后的结果，按「路径 + 修改时间 + 大小」缓存在进程内。
 *
 * 附件按路径引用：文件修改后键随之改变，下一轮读取的是新内容。每一轮装配都要将历史中的附件
 * 全部编码一次，不缓存时含数十张照片的会话每轮开始都要重新解码与缩放。
 * 条目数有上限，超出时丢弃最早写入的条目。
 */
const ATTACHMENT_CACHE_LIMIT = 64
const attachmentCache = new Map<string, { data: string; mime: string }>()

async function encodedAttachment(
  path: string,
  mtimeMs: number,
  size: number,
  mime: string,
): Promise<{ data: string; mime: string } | null> {
  const key = `${path}|${mtimeMs}|${size}`
  const hit = attachmentCache.get(key)
  if (hit) return hit
  const bytes = await readFile(path).catch(() => null)
  if (!bytes) return null
  const fit = await shrinkImage(new Uint8Array(bytes), mime)
  const out = { data: Buffer.from(fit.bytes).toString('base64'), mime: fit.mime }
  if (attachmentCache.size >= ATTACHMENT_CACHE_LIMIT) {
    const oldest = attachmentCache.keys().next().value
    if (oldest !== undefined) attachmentCache.delete(oldest)
  }
  attachmentCache.set(key, out)
  return out
}

/**
 * 执行记录的取回形式：图像字节从 outcome 中拆出、作为图像块返回，outcome 文本中不保留 base64。
 * 取回的图片与 `read_file` 写入执行记录时的字节相同。
 */
function stepRecord(st: Step): HistoryStep {
  const payload = (st.payload ?? {}) as { args?: unknown; outcome?: Record<string, unknown> }
  const outcome = payload.outcome ?? {}
  const data =
    outcome.data && typeof outcome.data === 'object'
      ? (outcome.data as Record<string, unknown>)
      : undefined
  const images = imagesOf(data)
  const videos = videosOf(data)
  const rest = envelopeResult(data)
  const { data: _dropped, ...withoutData } = outcome
  return {
    tool: st.toolName ?? 'unknown',
    status: st.status,
    args: JSON.stringify(payload.args ?? {}),
    outcome: JSON.stringify(data ? { ...withoutData, ...(rest ? { data: rest } : {}) } : outcome),
    ...(images.length ? { images } : {}),
    ...(videos.length ? { videos } : {}),
  }
}

/**
 * 将附件转换为 provider 可接受的内容。
 *
 * 每一轮的图片都进入内容块，按与工具图片相同的规则缩放编码（`tools` 的 `shrinkImage`）；视频进入路径块，
 * 发送前由 `materialize` 读取字节。去留不在此处决定：保留的媒体超过上限时，由装配
 * （`agent` 的 `evictedMedia`）将最早的整批替换为说明。每个附件都在正文中保留一行名称与路径，
 * 媒体被换出之后模型依据这一行找到原文件。
 *
 * 路径不按工作区裁决。`resolveInWorkspace` 的边界约束的是模型：它拦截模型自行构造
 * 的路径。附件路径来自用户在界面上的拖放、选择或粘贴，是一次显式授权，与系统文件选择器性质相同；判据
 * 是「字节是否会被发出」，而执行拖放的用户正是对此作出决定的人。
 *
 * 前提：模型不得构造附件。附件只能来自客户端操作，不能由任何工具调用产出
 * （`Attachment` 目前只来自 composer）。该前提一旦不成立，上述理由随之失效，
 * 此处必须改为按工作区裁决。
 *
 * 三种无法读取的情况都保留一行说明，不抛出错误。文件被删除、被改名、事后超过上限都可能发生。跳过该附件并
 * 在正文中保留一行说明，而不是使整轮无法启动：模型看到「此处原有一张图片，现在无法读取」仍能继续执行，
 * 收到 500 则只能重新开始。
 *
 * 大小上限不在此处判定，而在 `materialize` 时判定：路径型附件指向用户自己的文件，
 * 该文件在被引用之后仍可能继续增大，而此处只记录位置。
 */
export async function withAttachments(
  workspaceRoot: string,
  text: string,
  attachments: Attachment[],
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
    // 提供路径：模型无法读取时 `read_file` 会明确报告越界或不存在，而不是静默失败。
    notes.push(`（附件 ${a.name}：${toPosixPath(abs)}）`)
    // 按扩展名分类，与界面附件入口使用同一判据。
    // 按 `a.type` 判定会读取历史行中按 mime 计算的旧值，两处结果不一致。
    if (isInlineVideo(a.path)) {
      blocks.push({
        type: 'video',
        mimeType: mimeOf(a.path),
        source: { kind: 'path', path: toPosixPath(abs) },
      })
      continue
    }
    if (!isInlineImage(a.path)) continue
    const fit = await encodedAttachment(abs, info.mtimeMs, info.size, mimeOf(a.path))
    if (!fit) {
      notes.push(`（附件 ${a.name} 读取失败，跳过）`)
      continue
    }
    blocks.push({ type: 'image', mimeType: fit.mime, source: { kind: 'base64', data: fit.data } })
  }

  // 文本块放在最后：附件是该消息的上下文，先看附件再读要求更符合阅读顺序。
  const body = notes.length ? [text, ...notes].join(NEWLINE) : text
  if (blocks.length === 0) return body
  blocks.push({ type: 'text', text: body })
  return blocks
}

/**
 * 本会话中尚未完成的任务图。
 *
 * 折叠失败的任务图（首次派发的参数已不合法）整条跳过：该任务图无法继续执行，
 * 将错误信息写入运行上下文只会使模型尝试修复一份它无法读取的记录。
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
 * 一个会话的历史端口。子 agent 的历史使用同一实现、按其会话 id 构造，
 * `forSubagent` 只接受本会话派发的子 agent。
 */
function historyPortFor(store: Store, cid: ConversationId): HistoryPort {
  const port: Omit<HistoryPort, 'forSubagent'> = (() => {
    /**
     * 将摘要中的 `<runId>:<stepId>` 解析为对应的 step。
     *
     * 单独的 step id 跨 run 不唯一，而摘要引用的是较早的记录，因此地址必须包含 runId。
     */
    const compositeStep = (id: string): Step | null => {
      const cut = id.indexOf(':')
      if (cut <= 0) return null
      const runId = id.slice(0, cut) as RunId
      const stepId = id.slice(cut + 1)
      // 只接受本会话的 run：其他会话的 step id 返回不存在。
      if (!listRuns(store, cid).some((run) => run.id === runId)) return null
      return listSteps(store, runId).find((x) => String(x.id) === stepId) ?? null
    }
    const userStepOf = (id: string): Step | null => {
      const st = compositeStep(id)
      return st?.kind === 'user' ? st : null
    }
    /**
     * 助手正文的取回地址指向该次生成的第一条 text step（`transcript.ts` 的 `StepUnit.textStep`）。
     * 一次生成的正文可能被思考分隔为多条 text step，按同一个 `providerBatchId` 拼接为完整正文，
     * 与压缩时交给摘要器的内容逐字相同。
     */
    const assistantTextOf = (id: string): string | null => {
      const st = compositeStep(id)
      if (st?.kind !== 'text') return null
      if (!st.providerBatchId) return st.content ?? ''
      return listSteps(store, st.runId)
        .filter((x) => x.kind === 'text' && x.providerBatchId === st.providerBatchId)
        .map((x) => x.content ?? '')
        .join('')
    }
    return {
      message: (id) => {
        const m = listMessages(store, cid, null).find((x) => x.id === id)
        if (m) return { role: m.role, content: m.content }
        /*
         * run 内注入的用户消息不在 `messages` 表中，摘要给出的地址是
         * `<runId>:<stepId>`。缺少此回退时，用户中途调整方向的消息
         * 一旦被折叠进摘要就无法取回：摘要中有地址，取回却报告不存在。
         */
        const st = userStepOf(id)
        if (st) return { role: 'user' as const, content: st.content ?? '' }
        const text = assistantTextOf(id)
        return text === null ? null : { role: 'assistant' as const, content: text }
      },
      step: (id) => {
        const st = compositeStep(id)
        // 注入的用户消息与助手正文由 `message` 取回：此处的返回结构是
        // `{tool,status,args,outcome}`，用于非工具记录时只会返回 `tool:'unknown'`
        // 与两个空 JSON，看似已处理，实际未返回任何内容。
        if (st?.kind !== 'tool_action') return null
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
             * run 内注入的用户消息按**消息**报告，不按执行记录报告：正文在 `content`
             * 列而不在 payload 中，取回也由 `message` 负责。报告为 step 时，
             * 摘录显示的是空 payload，而模型用该 id 调用 `step` 只会得到 null。
             */
            // 助手正文同理：正文位于 text step 的 `content` 中，按消息报告、由 `message` 取回。
            if (st.kind === 'user' || st.kind === 'text') {
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
