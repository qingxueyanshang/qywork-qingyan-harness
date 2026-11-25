/** 会话的构造参数、单轮参数与会话级状态。 */

import type { Ports, ToolRegistry } from '@qywork/agent'
import type {
  Attachment,
  Conversation,
  ConversationId,
  EffortLevel,
  FollowUp,
  MediaSpend,
  RunId,
  RunUsage,
  StepId,
} from '@qywork/core'
import type { ContentStore, Store } from '@qywork/store'
import type { QyConfig } from '../config.ts'
import type { Extensions } from '../extensions.ts'

export interface SessionOptions {
  store: Store
  config: QyConfig
  workspaceRoot: string
  /** 正文库：超出预算的工具输出与工具结果中的图像字节写入此处，账本只存引用。 */
  content: ContentStore
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
  /** Agent Team 成员与子 agent 的会话：不注册写入、删除与迁移记忆的工具，理由见 `registerBuiltinTools`。 */
  member?: true
  /**
   * 装配方提供的端口。本会话在其上加入自己提供的端口，合为同一份集合：MCP 配置在构造时加入，内置工具按
   * `ToolSpec.requires` 是否满足注册；读取记录、待办、目标、定时任务、历史、生成、技能来源与待办广播绑定会话与本轮，
   * 在每轮的工具上下文中加入。
   *
   * 派发、后台命令、插件安装、个性化与宠物只提供给顶层会话：成员会话没有派发端口，因此不注册 `subagent`，
   * 递归派发在结构上不可能发生。浏览器与电脑控制由装配方按宿主状态实时判定；`dispose` 释放二者的控制权。
   */
  ports?: Ports
  /**
   * 取出当前标记为「调整方向」的跟进消息。每个 step 边界调用一次。
   *
   * 队列的真源在服务端的 `RunManager`（进程内，不写入磁盘）；此处将其接入 loop
   * 的对应端口，并将附件解析为内容块：loop 不访问磁盘。
   *
   * 顶层会话接收用户插入的消息，内置成员会话接收父会话派发的补充指令；外部 CLI 没有队列。
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
   * 该消息的来源：子 agent 的回执、workflow 的回执、后台命令的回执，缺省为用户本人。
   * 写入 `messages.origin`，界面据此区分回执行与用户气泡。
   */
  origin?: 'subagent' | 'workflow' | 'command'
  /** 发送时该工作区在面板中打开的文件（服务端按工作区记录，见 `viewingLine`），写入本轮的上下文快照。 */
  viewing?: string
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
  /**
   * 本轮的思考档位，优先于模型配置中该「接口 × 模型」选定的档位。只有派发子 agent 时传入，
   * 调用方须已按该模型可发送的档位校验；不传入时取模型配置。
   */
  effort?: EffortLevel
  /** 为 true 时本轮的请求按暂时故障的间隔表重发（`RunInput.transientResend`）。只有派发子 agent 时传入。 */
  transientResend?: true
  /**
   * 本轮的开始时刻：服务端接受这条消息的时刻。调用 `ask` 之前另有等待步骤的调用方必须传入
   * （`run-control` 的 `startRun` 在调用前同步云端价格）；未传入时取调用 `ask` 的时刻。
   */
  startedAt?: number
}

/**
 * 会话级状态。由 `Session` 在构造时建立，每个实例一份；`session/` 下各职责文件与 `turn/` 的各阶段读写同一份，
 * 不另存副本。
 */
export interface SessionState {
  readonly opts: SessionOptions
  readonly registry: ToolRegistry
  readonly workspaceId: string
  seqCounter: Map<string, number>

  /** 已加载的扩展。null = 尚未加载（首次 ask 时加载）。 */
  extensions: Extensions | null

  /** 本会话工具表中由扩展提供的工具名。重新加载扩展时按它替换这一批工具，不触及内置工具。 */
  externalToolNames: Set<string>

  /**
   * 规范化后的额外根目录。只计算一次：三个使用方（路径层、静态规则、沙箱）
   * 必须取得逐字节相同的结果；各自实时计算会产生分歧，导致
   * 一层放行、另一层拒绝，且报错信息互不相关。
   *
   * 校验不通过的条目在构造时丢弃，原因写入 `configNotices`。
   */
  readonly extraDirs: string[]

  /** 本轮技能索引中各技能的目录，在冻结上下文时取得一次，作为工具的只读根。 */
  skillDirs: string[]

  /**
   * 运行中各轮次已发生的生成花费，只用于附加到本轮的 usage 事件（`ask`）。轮次开始时建立、结束时清除；
   * 账本与 `runs.media_usage` 在每笔花费到达时写入（`recordMediaSpend`），不依赖此表。
   */
  readonly mediaSpends: Map<RunId, MediaSpend[]>
  /** 各轮次最近一次的模型用量。生成花费到达时补发 usage 事件，以该用量为基础。 */
  readonly modelUsage: Map<RunId, RunUsage>

  /** 装配方的端口加上本会话在构造时即可提供的端口；每轮的会话级端口在 `makeToolContext` 中加入。 */
  readonly ports: Ports
}
