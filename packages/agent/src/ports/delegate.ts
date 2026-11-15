import type {
  EffortLevel,
  SubagentKind,
  SubagentTarget,
  WorkflowCall,
  WorkflowTransition,
} from '@qywork/core'
import { definePort } from './key.ts'

export interface SubagentSummary {
  id: string
  kind: SubagentKind
  name: string
  provider: string
  model: string
  /** 按其在卡片上最后一次出现时的状态判定：working = running，failed / interrupted = failed，其余为 idle。 */
  status: 'running' | 'idle' | 'failed'
  /**
   * 再次派发时是否延续上一轮。角色与临时子 agent 恒为 true；外部 CLI 须已返回会话号
   * 且该 CLI 支持续接，否则再次派发等同于新建会话，不保留上一轮的上下文。
   */
  resumable: boolean
}

/**
 * 派发端口：将一项任务交给一个子 agent（角色）或本机已安装的外部 agent CLI。
 *
 * **为什么是端口。** 运行子会话需要 `Session` 与账本，二者在依赖图上均**高于** tools，
 * 工具直接引用即构成反向边。接口定义在 agent 包：Agent Loop 在 end_turn 时读取 `inflight`。
 * 实现由装配方注入。
 *
 * **不注入时没有此工具。** 无法派发的派发工具没有任何降级形态，因此派发工具在 `requires`
 * 中声明本端口，装配方不注入时**不注册这些工具**（B5：没有数据源就不做入口），
 * 而不是注册一个必然返回失败的工具。
 *
 * **子 agent 不得再派发任务。** 装配方只为顶层会话注入该端口。成员会话无法取得它，因此不会递归：
 * 递归派发没有终止条件，一次失控即会耗尽整台机器的进程资源。
 *
 * **派出即返回，完成以事件通知。** 端口上没有等待、没有汇合，也没有「本轮结束即停止子 agent」：
 * 子 agent 的生命周期跟随会话，回执由实现方作为一条消息投递回该会话。
 */
export interface DelegatePort {
  /** 当前项目可派发的目标：角色库中的角色，以及本机识别到的外部 CLI。 */
  targets(): Promise<{
    roles: {
      id: string
      name: string
      description: string
      provider?: string
      model?: string
      effort?: EffortLevel
    }[]
    clis: { id: string; vendor: string; connected: boolean }[]
  }>
  /** 本会话已有的子 agent。 */
  subagents(): Promise<SubagentSummary[]>
  /**
   * 把模型名解析为配置中真实存在的「接口 × 模型」。
   *
   * 创建角色与实际派发任务必须使用同一套校验：前者若只接收一段自由文本，错误名称会先被
   * 写入 team.json，再在每次派发任务时重复请求 provider 并失败。失败时返回可用列表，使调用方
   * 在产生子会话与外部请求之前纠正。
   */
  resolveModel(
    name: string,
    provider?: string,
  ): { provider: string; model: string; effortLevels: EffortLevel[] } | { error: string }
  /**
   * 本会话当前正在运行的子 agent。仅报告事实，不等待它们：循环在 end_turn 时读取该列表，
   * 清单未完成而任务由这些子 agent 执行时，本轮正常结束。
   */
  inflight(): { name: string }[]
  /**
   * 在本轮内等待下一条子 agent 或工作流回执进入本会话的投递队列，最长 `timeoutMs`；`signal` 中止时以中止原因拒绝。
   * 只报告等待结果，不返回回执内容：回执仍经由队列在下一个 step 边界送达，同一条回执只有这一条投递路径。
   * 用户的消息同样结束等待：`message` 为插入本轮的消息（下一个 step 边界送达），`queued` 为排到本轮之后的消息
   * （本轮结束后才送达，等待只会推迟它）。`idle` 表示没有正在执行的子 agent，也没有待送达的回执。
   */
  awaitReceipt(
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<'received' | 'message' | 'queued' | 'timeout' | 'idle'>
  /**
   * 停止本会话中一个正在执行的子 agent，只停止本次执行：子 agent 的会话保留，之后按 id 再次派发即在原会话中继续。
   * 停止后不发送回执；图中的节点写入中断，其余节点照常执行，检查点在上游全部落终态后到达。
   * `dropped` 为子 agent 尚未读取、随停止作废的补充指令。
   */
  stop(
    subagentId: string,
  ): { ok: true; name: string; dropped: string[] } | { ok: false; error: string }
  /**
   * 派出一个子 agent，**立即返回**。目标是新建（按种类）还是已有（按 id）由 `target` 决定；
   * 无法派发时通过返回值报告，不抛出异常：模型须按原因改用其他做法。
   *
   * **产出不经由此方法返回。** 子 agent 完成之后，实现方将回执作为一条消息投入该会话
   * （忙碌时在下一个 step 边界注入，空闲时立即开始新一轮）；需要在本轮内等待时调用 `awaitReceipt`。
   * 目标是正在执行的内置子 agent 时，任务作为补充指令送入它正在执行的一轮，不另起一轮。
   *
   * `stepId` 是本次调用所属卡片的 id，实现方据此广播进度；`nodeId` 是图中的节点，
   * 只派发一项任务时省略，实现方使用单节点的固定 id。
   */
  dispatch(input: {
    target: SubagentTarget
    task: string
    /** 仅在新建时生效：仅当用户指定了模型时提供。 */
    provider?: string
    model?: string
    /** 本次派发的思考档位，新建与续接均生效；实现方按子 agent 实际使用的模型校验。 */
    effort?: EffortLevel
    runId: string
    stepId?: string
    nodeId?: string
  }): Promise<{
    ok: boolean
    /** 无法派发的原因：目标不存在、外部 CLI 未安装、模型指定不合法。 */
    error?: string
    /** 派发对象。记录未能建立时省略。 */
    subagentId?: string
    name?: string
    /** 派发对象的子 agent 种类。文案据此选择称呼；记录未能建立时省略。 */
    kind?: SubagentKind
    /** 本次派发是否新建了该子 agent。 */
    created?: boolean
    /** 目标正在执行：任务已作为补充指令送入它正在执行的一轮，没有开始新的执行。 */
    injected?: boolean
    /** 本次派发中模型应知道的事实，例如续接时未能接续会话、角色已不存在。原样交回模型。 */
    note?: string
  }>
  /**
   * 推进整张图：一次说明拆分为哪些任务、由谁执行、任务之间的依赖关系。
   *
   * **调度由实现方完成**：依赖就绪后启动、并发上限均由实现方的推进器按图计算。
   * 规则与 `dispatch` 相同：派发当前就绪的节点后即返回，节点执行完毕的回执、
   * 到达检查点的回执均作为消息送到该会话。
   *
   * `stepId` 是本次工具调用的卡片 id，实现方据此广播进度，前端据此认领对应的图卡。
   */
  runGraph(input: { call: WorkflowCall; runId: string; stepId: string }): Promise<{
    ok: boolean
    error?: string
    transition?: WorkflowTransition
    /** 本次推进之后整张图是否已全部处于终态且全部批准。 */
    completed?: boolean
  }>
}

export const DelegatePort = definePort<DelegatePort>('delegate')
