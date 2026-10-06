/**
 * 编排中一个成员的运行方式：创建一条独立子会话，执行完毕后交回最终文本。
 *
 * 成员会话的事件按其自身的会话 id 广播，不归属于父会话：这些 runId 在父会话中不存在，
 * 归属于父会话时，前端会按未知的 runId 创建一条不存在的 run。
 * 父会话图卡上的进度只由 `team.member` 事件表达。
 *
 * 调用方是任务派发端口（`delegate.ts`）：`subagent` 派发一项任务、`workflow` 派发一张图，
 * 两条路径都汇入此处，不存在第三条路径。
 */

import type { AgentEvent, ConversationId, RunId, StepId, StopReason } from '@qywork/core'
import { type ModelRef, NO_MODEL_MESSAGE, type QyConfig, Session } from '@qywork/runtime'
import { getConversation } from '@qywork/store'
import type { Role } from '@qywork/team'
import { canvasPort } from './canvas.ts'
import { type CommandDeps, officePortOf } from './deps.ts'

/**
 * 成员会话使用的「接口 × 模型」。优先级：角色指定 > 父会话当前的接口与模型 > 配置默认值。
 *
 * 父会话的接口与模型必须传入：模型是会话级属性（`repos.ts` 的 `setConversationModel`），
 * 用户在界面上切换到低价模型后派发任务，不继承时仍按 `config.active` 发送请求，
 * 而工具描述向模型承诺的是「当前模型」。
 *
 * 角色只指定模型而未指定接口时，先按配置反查并固定接口；未找到或重名时本地拒绝。
 * 不能把未知名称放到当前接口上尝试：那会使多个写错的模型都请求同一家 provider，
 * 子会话账本中记录的接口也与实际请求的接口不一致。
 */
export function memberModel(
  role: Pick<Role, 'id' | 'provider' | 'model'>,
  config: QyConfig,
  pick?: { explicit?: ModelRef; inherit?: ModelRef },
): ModelRef | { error: string } {
  // 用户本次指定的模型优先于其他一切来源，包括角色固定的接口与模型：用户的意图正是本次换用其他模型运行。
  if (pick?.explicit) return pick.explicit
  if (role.provider) {
    // provider 指定的是使用哪一家的 key。指定不存在的接口时必须立即失败：
    // 静默回退到当前接口会使「用低价模型执行审查」这类配置失效，且费用记在另一个接口上。
    const pinned = config.providers[role.provider]
    if (!pinned) return { error: `角色 ${role.id} 指定的接口不存在：${role.provider}` }
    if (role.model && !pinned.models[role.model]) {
      return {
        error: `角色 ${role.id} 在接口 ${role.provider} 下指定了不存在的模型 ${role.model}。当前可用的是：${modelList(config)}`,
      }
    }
    const model = role.model ?? Object.keys(pinned.models)[0]
    if (!model) return { error: `角色 ${role.id} 指定的接口 ${role.provider} 没有配置模型` }
    return { provider: role.provider, model }
  }
  if (role.model) return resolveModel(role.model, config)
  // 角色未指定模型、父会话也未传入时才回退到默认值；默认值也不存在即全局未配置模型。
  return pick?.inherit ?? config.active ?? { error: NO_MODEL_MESSAGE }
}

/**
 * 将用户指定的模型解析为「接口 × 模型」。接口与模型始终分别传递。
 *
 * 同一个模型 id 配置在两个接口下时报错，不按枚举顺序选择：选错会同时更换端点、key
 * 与价目表，且不报错。
 */
export function resolveModel(
  name: string,
  config: QyConfig,
  provider?: string,
): ModelRef | { error: string } {
  if (provider) {
    const pinned = config.providers[provider]
    if (!pinned) return { error: `配置中没有接口 ${provider}。当前可用的是：${modelList(config)}` }
    if (!pinned.models[name]) {
      return {
        error: `接口 ${provider} 下没有模型 ${name}。当前可用的是：${modelList(config)}`,
      }
    }
    return { provider, model: name }
  }
  const hits = Object.entries(config.providers).filter(([, p]) => p.models[name])
  if (hits.length === 1) return { provider: hits[0]![0], model: name }
  if (hits.length > 1) {
    return {
      error: `${name} 同时配置在多个接口下（${hits.map(([n]) => n).join('、')}），请同时指定 provider 与 model`,
    }
  }
  return { error: `配置中没有模型 ${name}。当前可用的是：${modelList(config)}` }
}

function modelList(config: QyConfig): string {
  return Object.entries(config.providers)
    .flatMap(([provider, stored]) =>
      Object.keys(stored.models).map(
        (model) => `(provider=${JSON.stringify(provider)}, model=${JSON.stringify(model)})`,
      ),
    )
    .join('、')
}

/**
 * 子 agent 未执行到自然结束时的原因，原样交回父会话，父会话据此决定更换做法还是拆分后再派发。
 * 压缩为一句「未完成」时，模型只能原样重新派发，而重新派发必然再次遇到同一个问题。
 */
const CUT_SHORT: Partial<Record<StopReason, string>> = {
  no_progress: '连续三轮没有任何进展，已自动停止',
  user_interrupt: '被中断',
  process_exit: '进程退出',
  output_truncated: '产出被模型的单次长度上限截断',
  provider_error: '模型服务出错',
  internal_guard: '上一轮在工具执行期间中断，本轮结果不可信',
}

/**
 * 成员的浏览器控制所属的工作区：读取派发该成员的顶层会话行。
 *
 * 未查到时返回 `null`，调用方据此不创建端口，本轮不注册浏览器工具。
 * 不要改为读取成员会话自身的行：其工作区与顶层会话不一定相同，按它创建页面会落在另一个
 * 工作区。也不要传空字符串：宿主会以「缺少工作区」拒绝，失败出现在每一次工具调用上。
 */
export function ownerWorkspace(
  store: CommandDeps['store'],
  ownerConversation: ConversationId,
): string | null {
  return getConversation(store, ownerConversation)?.workspaceId ?? null
}

/**
 * 内置后端：用本进程的 agent 运行一个编排成员。
 *
 * `qy` 本身是完整的 agent，作为后端使用时无需新增实现，只需一个独立会话；
 * 未安装 codex / claude 的用户因此同样能够执行编排。
 *
 * 每个成员使用独立会话，不共用。成员之间的上下文必须隔离：「审查者」角色看到「实现者」的
 * 完整思考过程后便不再是独立视角，而独立视角是多角色的意义所在。节点之间需传递的内容由编排器
 * 显式拼入 prompt（`needs` 的产出），不依赖共享上下文。
 *
 * 内层事件按子会话自身的 id 发送，不归属于父会话。成员会话有自己的 runId，
 * 以父会话的 id 广播时，前端会按该未知 runId 创建一条不存在的 run。
 * 归属写在帧上之后，两件事各自成立：右侧页面订阅子会话 id 即可实时查看其执行过程，
 * 父会话的订阅者则因按会话隔离而收不到这些事件（`bus.ts` 的 `visibleTo`）。
 * 父会话图卡上的进度仍由 `team.member` 表达，该通道专为此设计。
 */
export async function runBuiltinMember(
  input: {
    /** 运行约束：角色的提示词与工具集；临时子 agent 两者均为空。 */
    role: Role
    prompt: string
    signal: AbortSignal
    /** 子 agent 的会话。任务派发端口在派发之前已创建该会话，接口与模型都记录在该会话行上。 */
    conversationId: ConversationId
    /** 派发来源：哪张卡片的哪个节点。没有卡片（调用不带 stepId）时不存在。 */
    dispatch?: { stepId: StepId; nodeId: string }
  },
  ctx: {
    // 不含 `ws`：任务派发端口（`delegate.ts`）在没有 WebSocket 的场景下也会调用此函数。
    deps: Omit<CommandDeps, 'ws'>
    /** 父会话所在的项目目录。成员会话运行在同一根目录下：一轮编排不跨项目。 */
    workspaceRoot: string
    /** team.json 中追加给所有内置子 agent 的公共约束。 */
    shared?: string
    /** 子会话的每一条事件，附带其自身的会话 id。见本文件头部说明。 */
    onEvent?: (event: AgentEvent, conversationId: ConversationId) => void
  },
): Promise<{ ok: boolean; output: string; error?: string; stop: StopReason | null }> {
  const { role } = input
  const { deps } = ctx
  const extraSystem = [role.systemPrompt, ctx.shared].filter(Boolean).join('\n\n')

  /*
   * 子会话必须进入与主会话相同的 RunManager 生命周期。
   *
   * 只把 `run.started`、正文与 `run.finished` 转发到事件总线而不 register 子 run 时，
   * 握手与 `conversation.busy` 都不知道子会话正在运行：用户在其开始运行后才打开时，
   * 前端能从账本读取正文，却没有权威忙态，因而不显示实时状态条，主会话与子会话的表现随之不一致。
   *
   * 调用方只提供 AbortSignal，因此此处创建一个可登记的 controller，并把父信号单向
   * 传入。父会话停止时仍会中断成员；RunManager 统一的停止与关闭服务路径也能直接
   * 中断该子 run，无需另建一份子会话忙闲状态。
   */
  /*
   * 派发该成员的顶层会话。子会话的归属只在创建时写入，事后无法从其他来源推导，
   * 因此直接读取账本中的字段；没有父会话时（顶层会话自身运行）即为其自身。
   */
  const ownerConversation =
    getConversation(deps.store, input.conversationId)?.parentConversationId ?? input.conversationId
  const workspaceId = ownerWorkspace(deps.store, ownerConversation)

  const controller = new AbortController()
  const abortFromParent = () => controller.abort(input.signal.reason)
  if (input.signal.aborted) abortFromParent()
  else input.signal.addEventListener('abort', abortFromParent, { once: true })

  const session = new Session({
    store: deps.store,
    config: deps.config,
    content: deps.content,
    workspaceRoot: ctx.workspaceRoot,
    signal: controller.signal,
    ...(extraSystem ? { extraSystem } : {}),
    ...(role.allowedTools ? { allowedTools: role.allowedTools } : {}),
    /*
     * 成员会话与顶层会话使用同一判定，并各自取得一份控制身份：控制槽按执行者分配，
     * 成员之间各自占用不同页面，访问同一页面时才返回 busy。不在此处接入时，
     * 这条入口默认不含浏览器，且无法给出原因。
     *
     * 控制归属记录的是派发该成员的顶层会话：界面上的「停止」发送
     * `conversation.interrupt`，该指令只接受顶层会话（并连带停止其名下的子 agent）。
     * 记录成员会话 id 时，该按钮无法停止任何一轮。
     */
    ...(deps.browser?.available() && workspaceId
      ? { browser: deps.browser.portFor(ownerConversation, workspaceId) }
      : {}),
    /*
     * 成员会话与顶层会话使用同一判定，并各自取得一份执行者身份：撤销按执行者记录，
     * 父会话停止时成员的 Session 被 abort，撤销的只是成员名下的排队请求。
     *
     * 控制归属记录的是派发该成员的顶层会话，理由与浏览器相同：界面上的「停止」发送
     * `conversation.interrupt`，该指令只接受顶层会话。
     */
    ...(deps.desktop?.available() ? { desktop: deps.desktop.portFor(ownerConversation) } : {}),
    // 成员会话与顶层会话使用同一判定：处理文档的成员同样需要 `office`。
    ...officePortOf(deps),
    // 画布与顶层会话使用同一个服务：成员修改的节点同样即时推送给界面。
    ...(deps.canvas && workspaceId
      ? { canvas: canvasPort(deps.canvas, { id: workspaceId, root: ctx.workspaceRoot }) }
      : {}),
  })

  let text = ''
  let error: string | null = null
  const conversationId = input.conversationId
  let runId: RunId | null = null
  let stop: StopReason | null = null
  let detail: string | null = null

  try {
    // 会话已存在，接口与模型记录在该会话行上；此处不再传递模型名。
    for await (const ev of session.ask(
      input.prompt,
      conversationId,
      input.dispatch ? { dispatch: input.dispatch } : undefined,
    )) {
      if (ev.type === 'run.started') {
        runId = ev.runId
        // 先登记忙态，再暴露子会话入口。用户取得入口后立即打开时，加载侧已能从
        // 同一张权威表确认「正在运行」，不依赖是否恰好收到 run.started。
        deps.runs.register({
          runId,
          conversationId,
          controller,
          startedAt: Date.now(),
        })
      } else if (ev.type === 'text.delta') text += ev.delta
      else if (ev.type === 'run.error') error = `[${ev.code}] ${ev.message}`
      else if (ev.type === 'run.finished') {
        stop = ev.stopReason
        detail = ev.stopDetail ?? null
      }
      ctx.onEvent?.(ev, conversationId)
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  } finally {
    if (runId) deps.runs.unregister(runId)
    input.signal.removeEventListener('abort', abortFromParent)
    await session.dispose().catch((reason) => {
      error = `扩展关闭失败：${String(reason)}`
    })
  }

  const output = text.trim()
  return { ...memberOutcome({ error, stop, detail, output }), output, stop }
}

/**
 * 判断一个成员是否算作成功。
 *
 * 权威依据是本轮的终态，而非是否产生文字。只看文字时，原地循环或被中断的
 * 子 agent 因先前的输出仍在，会被报告为「已完成」，父会话据此继续执行。
 * 反之，没有报错但没有任何产出同样算失败：ok 加空字符串会被下游理解为
 * 「已检查，无内容可报告」，这是另一种结果。
 */
export function memberOutcome(input: {
  error: string | null
  stop: StopReason | null
  /** 停止的具体依据（`RunFinishedEvent.stopDetail`），附加在文案后交给父会话。 */
  detail?: string | null
  output: string
}): { ok: boolean; error?: string } {
  const { error, stop, output } = input
  if (error) return { ok: false, error }
  if (stop !== 'completed') {
    const text = (stop && CUT_SHORT[stop]) ?? `提前停止（${stop ?? '无终态'}）`
    return { ok: false, error: input.detail ? `${text}：${input.detail}` : text }
  }
  if (!output) return { ok: false, error: '子 agent 没有产出任何内容' }
  return { ok: true }
}
