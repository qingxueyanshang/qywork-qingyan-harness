/**
 * run 的启动、重试、压缩，以及**目标的自动继续**。
 *
 * 五条入口共用同一个 `Session` 装配：手动发送消息、定时任务触发、重试、目标自动继续、
 * 跟进消息发起。为任何一条单独建立一套装配，都会得到五套可能相互偏离的行为。
 *
 * **自动继续在 `startRun` 的 `finally` 中判定。** 该处已执行 `runs.unregister` / `release` /
 * `session.dispose()`，是「本轮已完成」的**唯一汇合处**：正常结束、抛错、被中断三条路径都经过
 * 该处。
 *
 * **不在 `recoverStaleRuns` 中判定**：它只在 `createServer` 启动时执行一次（开始监听之前），
 * 把目标判定放入进程启动流程即形成「崩溃后自动恢复执行」，这正是 `GoalArm` 注释
 * 首要防止的情形。两处相差一个完整的生命周期。
 */

import { createSummaryTrace } from '@qywork/agent'
import { buildAdapter, ProviderError, type ProviderProfile } from '@qywork/ai'
import type {
  AgentEvent,
  Attachment,
  ConversationId,
  FollowUp,
  Goal,
  RunId,
  StopReason,
  Workspace,
} from '@qywork/core'
import { log } from '@qywork/core'
import {
  collectSecrets,
  configPath,
  contextPanel,
  makeSummarizer,
  NO_MODEL_MESSAGE,
  RuntimeCompaction,
  requestPersistence,
  resolveModel,
  Session,
} from '@qywork/runtime'
import {
  appendStep,
  createGoal,
  createRun,
  currentGoal,
  finishRun,
  getConversation,
  listRuns,
  markRunRunning,
  recordUsage,
  touchRun,
  updateGoal,
  workspaceOf,
} from '@qywork/store'
import { redactSecrets } from '@qywork/tools'
import { canvasPort } from './canvas.ts'
import { makeDelegate } from './delegate.ts'
import { type CommandDeps, officePortOf } from './deps.ts'
import { publishGitState } from './http-util.ts'
import { makePluginPort } from './plugin-port.ts'
import type { GoalArm } from './runs.ts'

/**
 * 本轮的发起方。
 *
 * 唯一用途是把用户发起与另外两种发起区分开：用户操作到达时立即清除自动继续标记
 * （用户消息优先）；目标自动继续与子 agent 回执都不是用户操作，它们若也清除标记，循环最多执行一轮。
 * 缺省 = 用户（发送消息、重试、定时触发）。
 */
export type RoundSource =
  | { kind: 'goal'; arm: GoalArm }
  | { kind: 'receipt'; origin: 'subagent' | 'workflow' }

/**
 * 向会话投递一条消息：有 run 在运行时排入队列，空闲时立即启动一轮。
 *
 * **用户消息、子 agent 回执与定时触发经由同一个函数。** 三处分别实现时，
 * 「忙碌判定与启动一轮在同一个同步块中」这一约束需要维护三次，遗漏的一处不会报错。
 *
 * **判定条件是 `hasRun` 而不是 `isBusy`**：只有子 agent 在运行时，该会话没有可注入消息的一轮，
 * 排入队列后无人消费。
 *
 * **会话空闲时，回执还需检查父轮的终态**（见 `continuableAfterLastRun`）；
 * 用户消息不做该检查：用户是新预算的发起方。
 */
export async function submitMessage(
  conversationId: ConversationId,
  item: FollowUp,
  deps: Omit<CommandDeps, 'ws'>,
  model?: string,
): Promise<void> {
  if (
    deps.runs.hasRun(conversationId) ||
    (item.origin && !continuableAfterLastRun(conversationId, deps))
  ) {
    deps.runs.enqueue(conversationId, item)
    return
  }
  await startRun(
    conversationId,
    item.content,
    model,
    deps,
    item.attachments,
    item.origin ? { kind: 'receipt', origin: item.origin } : undefined,
  )
}

/**
 * 发起一轮。
 *
 * deps 中**不含 `ws`**：该路径除 `handleCommand` 外还供定时任务使用，
 * 而定时触发没有发起方的连接。该路径也不使用 `ws`：事件全部经由 bus 广播，
 * 因为同一个会话可能同时在桌面端与手机上打开。
 *
 * **返回的 promise 不会 reject**：占位失败时发布一条 `run.error` 后正常返回，
 * 占位之后的全部步骤（含启动前的准备阶段）都在后台异步执行的 try/finally 中结束。
 * 调用方因此无需 `.catch()`。
 */
export async function startRun(
  conversationId: ConversationId,
  content: string,
  model: string | undefined,
  deps: Omit<CommandDeps, 'ws'>,
  attachments?: Attachment[],
  source?: RoundSource,
): Promise<void> {
  /*
   * 占位与检查必须在同一个同步步骤中完成：只检查不占位时，此处到 `runs.register()`
   * 之间有多个 await，两条几乎同时到达的消息会同时通过检查。
   *
   * **只有一处竞态会触发该拒绝**：目标自动继续的 `setTimeout` 到期时会话已再次忙碌
   * （`fireGoalRound`）。用户消息与定时触发不会执行到此处：两者都经由 `submitMessage`，
   * 忙碌时排入队列。
   */
  if (!deps.runs.reserve(conversationId)) {
    deps.bus.publish(
      {
        type: 'run.error',
        runId: '' as RunId,
        code: 'internal_error',
        message: deps.runs.updating ? '应用正在更新，请稍后重试' : '该会话已有任务在执行，请先中断',
      },
      conversationId,
    )
    return
  }

  /*
   * 在后台运行，不阻塞 WebSocket 消息循环：否则一轮 agent 运行十分钟时，
   * 这十分钟内无法接收任何指令，包括中断。
   *
   * **占位之后的全部步骤都在该 try 中**，包括启动前的准备阶段（查询项目目录、确定模型、
   * 装配 Session 及其端口）。准备阶段位于 try 之外时，其中任何一处抛出（写库失败、
   * 工具注册冲突）都不会释放占位，此后该会话的每条消息都以
   * 「已有任务在执行」被拒绝，直到进程重启。
   *
   * 准备阶段全部同步执行，因此 `startRun` 返回之前它已执行完毕，启动一轮的判定条件
   * 仍然是「检查与占位在同一个同步块中」。
   */
  void (async () => {
    /*
     * 准备阶段创建的两个对象，结束阶段需要使用。
     * **声明在 try 之外**：在赋值之前抛出时它们仍为 null，结束阶段照常执行。
     */
    let ws: Workspace | null = null
    let session: Session | null = null
    const controller = new AbortController()
    let currentRunId: RunId | null = null
    /*
     * 本轮的结束方式，只用于自动继续判定。
     *
     * **两项都需要记录，因为报错有两条路径**：loop 内部的 provider 错误**不会抛出**，
     * 而是就地转换为 `run.error` + `run.finished{stopReason:'provider_error'}`
     * （`agent/loop/index.ts`）；只有 loop 之外的错误（装配 adapter、解析档案）进入 catch。
     * 只检查 catch 时，一次 provider 报错会被判定为「本轮正常执行完毕」并自动继续，
     * 违反「不自动重试异常」规则。
     */
    let stopReason: StopReason | null = null
    let failure: string | null = null

    try {
      /*
       * **用户消息优先。** 用户发送消息（以及重试、定时触发）时，已排队的自动继续
       * 立即作废：用户插入的消息才是该会话当前应执行的任务。
       *
       * 目标自动继续与子 agent 回执不清除标记：它们不是用户操作。
       * 位于 reserve 成功之后：被拒绝的消息视为未发生，不应修改任何状态。
       */
      if (!source) deps.runs.disarm(conversationId)

      /*
       * 本轮的运行目录**按会话查询，不取自进程**。
       *
       * 服务进程不得持有 `workspaceRoot` 常量（启动时的 `--cwd`）：否则一个进程
       * 只能服务一个项目，且该常量本身就是 `workspaces` 表的一份缓存。
       *
       * 未查到时停止：回退到默认根目录等于在 B 项目的目录中执行 A 项目会话的命令，
       * 而工具的路径约束与 shell 的沙箱边界都以该根目录为界。
       */
      ws = workspaceOf(deps.store, conversationId)
      if (!ws) {
        deps.bus.publish(
          {
            type: 'run.error',
            runId: '' as RunId,
            code: 'internal_error',
            message: '本会话未找到对应的项目目录，无法执行',
          },
          conversationId,
        )
        return
      }

      /*
       * 没有可用模型时不启动本轮。真源是「本轮显式指定 > 会话当前 > 配置默认」这条优先链
       * （与 `session.ask` 相同），三者皆空表示用户尚未配置模型。**在此处拦截并返回结构化的
       * `no_model`**，而不是向不存在的接口发出请求后等待 401。界面另有就地拦截，此处为后备处理。
       */
      const runModel =
        model || getConversation(deps.store, conversationId)?.model || deps.config.active?.model
      if (!runModel) {
        deps.bus.publish(
          { type: 'run.error', runId: '' as RunId, code: 'no_model', message: NO_MODEL_MESSAGE },
          conversationId,
        )
        return
      }

      session = new Session({
        store: deps.store,
        config: deps.config,
        content: deps.content,
        workspaceRoot: ws.rootPath,
        signal: controller.signal,
        // 任务派发通道只提供给顶层会话。成员会话（`team-run.ts`）不传入，因此成员会话中
        // 不注册 `subagent` 工具：子 agent 再派发任务没有终止条件。
        delegate: makeDelegate({
          deps,
          workspaceRoot: ws.rootPath,
          conversationId,
          // 回执可能在本轮结束很久之后才到达，那时该 Session 已经 dispose：
          // 投递经由会话级路径，与用户发送消息使用同一个函数。
          deliver: (followUp) => {
            void submitMessage(conversationId, followUp, deps).catch((err) => {
              deps.bus.publish(
                {
                  type: 'run.error',
                  runId: '' as RunId,
                  code: 'internal_error',
                  message: err instanceof Error ? err.message : String(err),
                },
                conversationId,
              )
            })
          },
        }),
        // 插件安装端口同样只提供给顶层会话：成员会话不应为整台机器安装插件。
        plugins: makePluginPort({ workspaceRoot: ws.rootPath }),
        /*
         * 浏览器控制**按当前宿主状态实时判定**，不缓存。
         *
         * 宿主未连接或运行时版本不满足要求时不注入端口，本轮不注册浏览器工具；
         * 若先提供端口、调用时再报错，模型会得到一个必然失败的能力。
         */
        ...(deps.browser?.available()
          ? { browser: deps.browser.portFor(conversationId, ws.id) }
          : {}),
        /*
         * 电脑控制同样**实时判定**：用户的启用开关、宿主连接、worker 就绪与系统授权四项
         * 由协调器一次判定，缺少任一项时不注入端口，本轮不注册桌面工具。
         *
         * 端口按执行者分配，顶层会话与其派发的成员各持有一个：停止只撤销本会话的
         * 排队请求，不会撤销其他会话正在执行的动作。
         */
        ...(deps.desktop?.available() ? { desktop: deps.desktop.portFor(conversationId) } : {}),
        // Office 同样实时判定：开关关闭或本机缺少 Python 与文档库时不提供端口，本轮没有 `office`。
        ...officePortOf(deps),
        ...(deps.canvas
          ? { canvas: canvasPort(deps.canvas, { id: ws.id, root: ws.rootPath }) }
          : {}),
        // 跟进消息队列同样只提供给顶层会话：成员会话不显示在界面上，用户无法向其插入消息。
        followUps: (id) => deps.runs.takeSteered(id),
      })

      for await (const ev of session.ask(content, conversationId, {
        ...(model ? { model } : {}),
        ...(attachments?.length ? { attachments } : {}),
        // 由回执启动的一轮，消息行必须标明投递方：界面据此渲染为回执行，而不是用户气泡。
        ...(source?.kind === 'receipt' ? { origin: source.origin } : {}),
      })) {
        // 并非所有事件都带 runId（git.state / file.changed 是工作区级的），
        // 读取前先收窄类型，不能假设字段存在。
        if ('runId' in ev && ev.runId && currentRunId === null) {
          currentRunId = ev.runId as RunId
          deps.runs.register({
            runId: currentRunId,
            conversationId,
            controller,
            startedAt: Date.now(),
          })
        }
        if (ev.type === 'run.finished') stopReason = ev.stopReason
        if (ev.type === 'run.error') failure = ev.message
        /*
         * **自动继续标记只由目标事件驱动**，不根据「谁调用过目标工具」推断。
         *
         * 目标的真源在账本，该事件如实广播账本的最新状态
         * （`runtime/session.ts` 的 `announce`）。模型在同一轮中设立目标后又
         * 自行 complete 时，后一条事件解除标记，循环不会多启动一轮。
         */
        if (ev.type === 'goal') {
          if (ev.goal.status === 'active') {
            deps.runs.arm(conversationId, { goalId: ev.goal.id, revision: ev.goal.revision })
          } else {
            deps.runs.disarm(conversationId)
          }
        }
        deps.bus.publish(ev, conversationId)
      }
    } catch (err) {
      // 在 loop 之外抛出的错误（装配 adapter、解析档案）进入此处。
      //
      // 不要硬编码 `internal_error`：否则「未配置 key」在 CLI 中报 no_api_key，
      // 在桌面端却报 internal_error，前端的「去配置」引导永远不会触发。
      // 错误码供前端决定引导操作，统一为 internal_error 等于没有分类。
      const pe = err instanceof ProviderError ? err : null
      const base = pe?.message ?? (err instanceof Error ? err.message : String(err))
      // 桌面端用户不一定有终端，无法执行「运行 qy init」。
      // 因此附上配置文件路径，用户可以直接打开该文件。
      const message =
        pe?.code === 'no_api_key' || pe?.code === 'auth_failed'
          ? `${base}\n配置文件：${configPath()}`
          : base
      failure = message
      deps.bus.publish(
        {
          type: 'run.error',
          runId: (currentRunId ?? '') as RunId,
          code: pe?.code ?? 'internal_error',
          message,
        },
        conversationId,
      )
    } finally {
      // 已 register 的执行 unregister，未启动的由 release 回收；两者都不执行时
      // 该会话被永久占用，之后的每条消息都以「已有任务在执行」被拒绝。
      if (currentRunId) deps.runs.unregister(currentRunId)
      else deps.runs.release(conversationId)
      // 每条消息对应一个 Session，每个 Session 都持有扩展的一份引用。
      // 不释放时引用只增不减，插件与 MCP 子进程直到进程退出都无法关闭。
      // null 表示准备阶段在装配前已停止（未查到项目、没有模型、装配抛错）。
      await session?.dispose().catch((error) => {
        log.error('extensions', `会话扩展关闭失败：${String(error)}`, { conversationId })
      })
      const interrupted = controller.signal.aborted || stopReason === 'user_interrupt'
      /*
       * 「调整方向」只对发出它的那一轮有效。本轮结束后，未赶上 step 边界的
       * 用户条目已无处注入；保留标记时，下一轮开始时会把它们注入到用户
       * 并未针对的执行中。带 `origin` 的回执不在此列，原因见 `resetSteer`。
       */
      deps.runs.resetSteer(conversationId)
      /*
       * **跟进消息优先于目标自动继续**：用户插入的消息才是该会话当前应执行的任务，
       * 与 `startRun` 开头「用户消息优先」的 `disarm` 遵循同一原则。
       *
       * 但只跳过自动继续分支。`settleGoalAfterRun` 的 pause / blocked 两个分支是收尾而不是
       * 自动继续，跳过它们的失败形状是：中断且队列非空时目标无法转为 `paused`，
       * 自动继续标记残留，界面上该目标始终显示运行中。
       */
      const fired =
        !interrupted &&
        !!stopReason &&
        CONTINUABLE.includes(stopReason) &&
        fireFollowUpRound(conversationId, deps)
      // 判定位于 dispose **之后**：占位与扩展均已释放，本轮才真正完成，
      // 下一轮启动时不会与上一轮的子进程重叠。
      settleGoalAfterRun({
        conversationId,
        deps,
        interrupted,
        stopReason,
        failure,
        skipResume: fired,
      })
      // 未查到项目目录时没有可广播的工作区，本轮也未访问任何文件。
      if (ws) void publishGitState(ws.rootPath, ws.id, deps.bus)
    }
  })()
}

/**
 * run 结束时把队首的跟进消息作为下一轮发起。返回 true 表示已取出并已排队。
 *
 * **同步取出、异步发起。** 取出与「是否跳过目标自动继续」是同一个决定，拆开后会出现
 * 「自动继续已被跳过，而该消息在 setTimeout 到期前被用户删除」的情形，两者都不会执行。
 *
 * 到期时若会话再次忙碌（另一端刚发送了消息），把它放回队首，不丢弃。
 * 异步发起的原因与 `queueGoalRound` 相同：不嵌套在本轮的 `finally` 中执行。
 */
function fireFollowUpRound(conversationId: ConversationId, deps: Omit<CommandDeps, 'ws'>): boolean {
  const item = deps.runs.takeNext(conversationId)
  if (!item) return false
  // 队首移交给定时回调期间仍属于待执行任务，复用会话占位阻止更新退出。
  if (!deps.runs.reserve(conversationId)) {
    deps.runs.enqueueFront(conversationId, item)
    return true
  }
  setTimeout(() => {
    // release 与 startRun 的 reserve 之间没有 await，退出占位不能插入其中。
    deps.runs.release(conversationId)
    if (deps.runs.hasRun(conversationId)) {
      deps.runs.enqueueFront(conversationId, item)
      return
    }
    void startRun(
      conversationId,
      item.content,
      undefined,
      deps,
      item.attachments,
      item.origin ? { kind: 'receipt', origin: item.origin } : undefined,
    )
  }, 0)
  return true
}

// ───────────────────────── 目标的自动继续 ─────────────────────────

/**
 * **只有列出的停止原因视为「本轮正常执行完毕」。** 其余原因一律停止并等待用户处理。
 *
 * 使用白名单而不是黑名单：遗漏某种停止原因时，白名单的结果是停止并询问，
 * 黑名单的结果是在未经设计的状态下继续自动执行。
 */
const CONTINUABLE: StopReason[] = ['completed']

/**
 * 该会话最近一轮是否正常结束。会话空闲时，回执据此决定启动一轮还是排入队列。
 *
 * **与结束处的发起判定使用同一个 `CONTINUABLE`**：回执在本轮结束前到达时经由结束处的路径，
 * 结束后到达时经由此处。两条路径各写一套白名单时，同一条回执按到达时机得到两种结果，
 * 晚到的回执会绕过已耗尽的重试预算，获得全新的五次额度。
 *
 * 未查到任何一轮时视为可继续：回执的父轮必然存在过，未查到说明账本中没有可判定的终态，
 * 此时排入队列会导致没有任何一方启动下一轮。
 */
function continuableAfterLastRun(
  conversationId: ConversationId,
  deps: Omit<CommandDeps, 'ws'>,
): boolean {
  const last = listRuns(deps.store, conversationId).at(-1)
  if (!last) return true
  return !!last.stopReason && CONTINUABLE.includes(last.stopReason)
}

/**
 * 停止原因的说明。**每一种都必须有说明**：没有原因的 blocked 最难处理：
 * 循环已停止，而界面上只显示「受阻」。
 */
const STOP_NOTE: Record<string, string> = {
  provider_error: '上一轮因出错而中断',
  no_progress: '上一轮因连续无进展而终止',
  awaiting_user: '上一轮等待用户回复',
  output_truncated: '上一轮输出被截断',
}

/**
 * 一轮执行完毕后，决定是否启动下一轮。
 *
 * 三条出口，**没有第四条**：
 * - 被中断 → 目标置 `paused`，解除标记。取消之后不自动重启，这是硬规则；
 * - 非正常结束（provider 报错、连续无进展等）→ 目标置 `blocked`，
 *   解除标记。**不重试**：隐式重试会把一次故障放大为一连串相同的失败，
 *   而用户只能看到会话持续自行运行；
 * - 正常结束 → 排队启动下一轮。
 *
 * 没有自动继续标记时直接返回：说明该会话不在自动循环中
 * （或进程已重启：标记不落盘，见 `GoalArm`）。
 */
function settleGoalAfterRun(input: {
  conversationId: ConversationId
  deps: Omit<CommandDeps, 'ws'>
  interrupted: boolean
  stopReason: StopReason | null
  failure: string | null
  /**
   * 队首的跟进消息已排为下一轮，**只跳过自动继续分支**。
   *
   * 下方 pause / blocked 两个分支照常执行：它们是收尾而不是自动继续，跳过时目标会停留在
   * active 且自动继续标记不解除。
   */
  skipResume: boolean
}): void {
  const { conversationId, deps } = input
  const armed = deps.runs.armedOf(conversationId)
  if (!armed) return

  try {
    if (input.interrupted) {
      stopGoal(deps, conversationId, armed, { action: 'pause' })
      return
    }
    if (!input.stopReason || !CONTINUABLE.includes(input.stopReason)) {
      const note = (input.stopReason && STOP_NOTE[input.stopReason]) ?? '上一轮未正常结束'
      stopGoal(deps, conversationId, armed, {
        action: 'blocked',
        code: input.stopReason ?? 'internal_error',
        reason: input.failure ? `${note}：${input.failure}` : `${note}。`,
      })
      return
    }
    if (input.skipResume) return
    queueGoalRound(conversationId, deps, armed)
  } catch (err) {
    abortGoalLoop(conversationId, deps, err)
  }
}

/**
 * 把目标置于指定的停止状态并解除标记。
 *
 * 使用**刚读取的** revision 而不是自动继续标记中的值：模型可能在本轮中修改过目标，
 * 这些修改有效，不应被一次中断按旧版本覆盖。
 */
function stopGoal(
  deps: Omit<CommandDeps, 'ws'>,
  conversationId: ConversationId,
  armed: GoalArm,
  how: { action: 'pause' } | { action: 'blocked'; code: string; reason: string },
): void {
  deps.runs.disarm(conversationId)
  const goal = currentGoal(deps.store, conversationId)
  // 目标已被替换或已进入终态时，无需停止。
  if (!goal || goal.id !== armed.goalId || goal.status === 'completed') return

  const result = updateGoal(deps.store, {
    conversationId,
    goalId: goal.id,
    revision: goal.revision,
    ...(how.action === 'pause'
      ? { action: 'pause' as const }
      : { action: 'blocked' as const, blockedCode: how.code, blockedReason: how.reason }),
  })
  if (result.ok) publishGoal(deps, result.goal)
}

/**
 * 排队启动下一轮。**异步排队，而不是同步递归调用 `startRun`**：同步调用会把下一轮的执行栈
 * 嵌套在本轮的 `finally` 中，栈深度持续增加，且下一轮开始时上一轮尚未完成收尾。
 *
 * 用户点击「继续」同样经由此处（`resumeGoal`），不另设启动路径。
 */
function queueGoalRound(
  conversationId: ConversationId,
  deps: Omit<CommandDeps, 'ws'>,
  reserved: GoalArm,
): void {
  setTimeout(() => {
    void fireGoalRound(conversationId, deps, reserved).catch((err) => {
      abortGoalLoop(conversationId, deps, err)
    })
  }, 0)
}

/**
 * 实际启动下一轮。
 *
 * **发起之前重新读取目标**：排队期间用户可能插入了消息（标记已被清除），
 * 模型可能已修改或完成目标。预留（goalId + revision）不一致时**丢弃本次排队**：
 * 按几秒前的版本继续执行，执行的就不再是用户当前的要求。
 */
async function fireGoalRound(
  conversationId: ConversationId,
  deps: Omit<CommandDeps, 'ws'>,
  reserved: GoalArm,
): Promise<void> {
  const armed = deps.runs.armedOf(conversationId)
  if (!armed || armed.goalId !== reserved.goalId || armed.revision !== reserved.revision) return

  const goal = currentGoal(deps.store, conversationId)
  if (
    !goal ||
    goal.id !== reserved.goalId ||
    goal.revision !== reserved.revision ||
    goal.status !== 'active'
  ) {
    deps.runs.disarm(conversationId)
    return
  }

  /*
   * **没有轮数上限，因此此处没有配额判定。** 循环的出口只有三个：模型自检后
   * `complete`、模型 `blocked`、用户中断转为 `paused`；此外，本轮未正常结束时
   * （`CONTINUABLE` 之外的停止原因）由 `settleGoalAfterRun` 转为 `blocked`。
   *
   * 也没有「轮次 +1」步骤：没有计数器，`revision` 保持不变，
   * 预留（goalId + revision）因此保持一致；模型执行 complete / blocked 后
   * revision 改变，下一次排队判定为陈旧并退出。
   */
  await startRun(conversationId, goalRoundPrompt(goal), undefined, deps, undefined, {
    kind: 'goal',
    arm: { goalId: goal.id, revision: goal.revision },
  })
}

/**
 * 用户通过 `/goal` 设立目标，或改写当前目标。**设立目标的唯一入口。**
 *
 * 模型没有 `create_goal` 工具（见 `tools/goals.ts` 顶部）。该函数新建目标，
 * 或改写当前目标的正文；之后统一交给 `resumeGoal` 转为 active、设置标记、
 * 启动第一轮。**不在此处重复实现这三步**：同一件事的第二份实现终将给出不同结果。
 *
 */
export function setGoal(
  conversationId: ConversationId,
  objective: string,
  deps: Omit<CommandDeps, 'ws'>,
): { ok: true } | { ok: false; message: string } {
  // 启动一轮只检查 run：子 agent 运行中不阻止设立目标，新一轮与子 agent 并行，规则与发送消息相同。
  if (deps.runs.hasRun(conversationId)) {
    return { ok: false, message: '该会话已有任务在执行，请先停止再设立目标' }
  }
  try {
    const existing = currentGoal(deps.store, conversationId)
    // 已完成的目标是终态，没有任何出边，此时只能新建目标。
    const written =
      !existing || existing.status === 'completed'
        ? createGoal(deps.store, { conversationId, objective })
        : updateGoal(deps.store, {
            conversationId,
            goalId: existing.id,
            revision: existing.revision,
            action: 'edit',
            objective,
          })
    // 校验（如空正文）位于账本中，拒绝原因原样返回给用户；
    // 服务端再复制一份判定会形成两处可能不一致的规则。
    if (!written.ok) return { ok: false, message: written.message }
    publishGoal(deps, written.goal)
    return resumeGoal(conversationId, deps)
  } catch (err) {
    abortGoalLoop(conversationId, deps, err)
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 用户在界面上点击「继续」。
 *
 * **由该函数自行发起一轮**，不等待下一次其他 run 结束：届时用户已等待了不确定的时长，
 * 而界面上没有任何变化。与自动继续使用同一个 `queueGoalRound`。
 */
export function resumeGoal(
  conversationId: ConversationId,
  deps: Omit<CommandDeps, 'ws'>,
): { ok: true } | { ok: false; message: string } {
  if (deps.runs.hasRun(conversationId)) {
    return { ok: false, message: '该会话已有任务在执行' }
  }
  try {
    const goal = currentGoal(deps.store, conversationId)
    if (!goal) return { ok: false, message: '该会话没有目标' }

    let live = goal
    if (goal.status !== 'active') {
      const result = updateGoal(deps.store, {
        conversationId,
        goalId: goal.id,
        revision: goal.revision,
        action: 'resume',
      })
      if (!result.ok) return { ok: false, message: result.message }
      live = result.goal
      publishGoal(deps, live)
    }

    const arm: GoalArm = { goalId: live.id, revision: live.revision }
    deps.runs.arm(conversationId, arm)
    queueGoalRound(conversationId, deps, arm)
    return { ok: true }
  } catch (err) {
    abortGoalLoop(conversationId, deps, err)
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 目标账本读取失败（revision 不连续、非法转移）时的处理：**停止循环并记录错误**。
 *
 * 回放是 fail-closed 的（`store/goals.ts` 直接抛出）。这里既不重试也不丢弃错误：
 * 重试只会把一次损坏变成一连串相同的报错，丢弃则得到一个自行停止、
 * 无法判定成因的循环。
 */
function abortGoalLoop(
  conversationId: ConversationId,
  deps: Omit<CommandDeps, 'ws'>,
  err: unknown,
): void {
  deps.runs.disarm(conversationId)
  log.error('goal', `目标自动继续已中止：${err instanceof Error ? err.message : String(err)}`, {
    conversationId,
  })
}

function publishGoal(deps: Omit<CommandDeps, 'ws'>, goal: Goal): void {
  deps.bus.publish({ type: 'goal', goal }, goal.conversationId)
}

/**
 * 自动继续的一轮发给模型的消息。
 *
 * 措辞是该功能中最容易出错的部分：语气过轻时模型草率宣布完成，未完成的目标
 * 被 `complete`；语气过重时模型停滞也不调用 `blocked`，循环持续执行。
 * 因此该消息必须做到三点：**引用完整目标**、
 * **指明判断依据**（工作区中的文件、本轮工具的执行结果、已写入账本的会话状态，
 * 而不是前几轮模型自己的表述）、**要求完成前先取得证据**。
 */
function goalRoundPrompt(goal: Goal): string {
  return [
    '[自动继续] 本消息由系统发出，不是用户发言。',
    '',
    `目标（goal_id=${goal.id}，revision=${goal.revision}）：`,
    goal.objective,
    '',
    '判断依据只有三项：工作区中文件的当前内容、本轮工具的执行结果、会话中已记录的状态。',
    '前几轮中「已经修改完成」等表述不作为依据，需要时重新核对。',
    '',
    '继续执行。声明完成之前先取得证据（执行一次命令或读取一次文件），不要仅凭印象：',
    '- 确认已达成：调用 update_goal(action="complete")，并在回答中写明证据。',
    '- 需要用户决定，或缺少条件无法继续：调用 update_goal(action="blocked")，写明阻塞点以及继续所需的条件。',
    '- 尚未完成：无需调用，目标保持 active，本轮结束后会自动开始下一轮。',
    '该循环没有轮数上限：不声明结束就会持续执行，因此达成时要声明，无法继续时也要声明。',
    'goal_id 与 revision 以 read_goal 读取的结果为准。',
  ].join('\n')
}

/**
 * 手动压缩会话。
 *
 * 与自动路径共用同一个 `RuntimeCompaction` 与同一份摘要装配（`makeSummarizer`），
 * 两条入口只有发起原因不同：两套实现终将出现差异，且差异难以发现。
 *
 * 事件经由总线广播，而不是只返回给发起方：压缩改变了会话此后的行为，
 * 在另一端打开同一会话的用户必须能看到。
 */
export async function compactConversation(
  conversationId: ConversationId,
  deps: CommandDeps,
): Promise<void> {
  const emit = (ev: AgentEvent) => deps.bus.publish(ev, conversationId)
  const conversation = getConversation(deps.store, conversationId)
  if (!conversation) throw new Error('会话不存在')
  // 用户发起的维护操作也有真实的 run，摘要与压缩结果因此写入同一份会话账本。
  const run = createRun(deps.store, {
    conversationId,
    workspaceId: conversation.workspaceId,
    model: conversation.model,
    clientRequestId: `compact:${crypto.randomUUID()}`,
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  const runId = run.id
  markRunRunning(deps.store, runId)
  const heartbeat = setInterval(() => touchRun(deps.store, runId), 10_000)
  const clean = (text: string) => redactSecrets(text, collectSecrets(deps.config))
  let seq = 0
  let usageProvider: string | null = null

  try {
    emit({ type: 'compaction', runId, phase: 'started' })
    const compaction = new RuntimeCompaction({
      store: deps.store,
      conversationId,
      messageIdUpperBound: null,
      summarize: makeSummarizer({
        profile: () => summaryProfile(deps, conversationId),
        effort: () =>
          resolveModel(deps.config, { provider: conversation.provider, model: conversation.model })
            ?.effort,
      }),
    })
    // 占用与窗口从会话实时计算：维护操作没有主请求回执，没有实时计量。
    // 面板与触发判定使用同一计量口径（`contextPanel` 的锚点口径），不另建一份账。
    // 窗口与密度取自同一份 spec：两个数需要相互比较，取自两份 spec 会形成两份账。
    const adapter = buildAdapter(summaryProfile(deps, conversationId))
    const spec = adapter.spec
    usageProvider = adapter.kind
    run.usage.currency = spec.pricing.currency ?? 'USD'
    const providerName = getConversation(deps.store, conversationId)?.provider
    if (!providerName) throw new Error('该会话未记录所属接口，请重新选择模型后继续')
    const panel = contextPanel(deps.store, conversationId, {
      ...spec,
      providerName,
      providerKind: adapter.kind,
    })
    const outcome = await compaction.run({
      trace: createSummaryTrace(
        requestPersistence(deps.store, deps.config),
        runId,
        0,
        adapter,
        run.usage,
        providerName,
      ),
      trigger: 'manual',
      model: spec.id,
      // 手动压缩发生在两轮之间，模型已对最后一批结果作出响应。
      latestUnitSeen: true,
      occupancy: panel.total,
      // 同一面板的两种计量，压缩按二者的比值折算回收量。
      estimatedOccupancy: panel.measured,
      contextWindow: spec.contextWindow,
      density: spec.density,
    })
    const phase =
      outcome.status === 'compacted' ? 'done' : outcome.status === 'skipped' ? 'skipped' : 'failed'
    appendStep(deps.store, {
      runId,
      seq: ++seq,
      kind: 'compaction',
      status: phase === 'done' ? 'success' : 'failure',
      payload: {
        kind: 'compaction',
        phase,
        manifestRevision: outcome.status === 'compacted' ? outcome.manifest.revision : 0,
        compactedMessages:
          outcome.status === 'compacted' ? outcome.manifest.compactedMessageCount : 0,
        ...(outcome.status === 'compacted' ? { summarized: outcome.summarized } : {}),
        ...('reasonCode' in outcome ? { reasonCode: outcome.reasonCode } : {}),
        ...('message' in outcome && outcome.message ? { message: clean(outcome.message) } : {}),
        trigger: 'manual',
        occupancy: panel.total,
        estimatedOccupancy: panel.measured,
        contextWindow: spec.contextWindow,
      },
    })
    finishRun(deps.store, runId, {
      status: outcome.status === 'failed' || outcome.status === 'aborted' ? 'failed' : 'done',
      stopReason:
        outcome.status === 'failed' || outcome.status === 'aborted'
          ? 'provider_error'
          : 'completed',
      ...('reasonCode' in outcome ? { errorCode: outcome.reasonCode } : {}),
      ...('message' in outcome && outcome.message ? { errorMessage: clean(outcome.message) } : {}),
    })
    if (outcome.status === 'compacted') {
      emit({
        type: 'compaction',
        runId,
        phase: 'done',
        manifest: outcome.manifest,
        summarized: outcome.summarized,
        ...(outcome.reasonCode ? { reasonCode: outcome.reasonCode } : {}),
      })
      // 手动压缩后没有下一次 request_prepared 事件，必须从刚落库的同一份 manifest
      // 重算并广播；否则模型下一轮已看到压缩投影，面板仍显示压缩前的数值。
      const updated = contextPanel(deps.store, conversationId, {
        ...spec,
        providerName,
        providerKind: adapter.kind,
      })
      emit({
        type: 'context',
        runId,
        tokens: updated.total,
        limit: updated.limit,
        percent: updated.percent,
        source: updated.source,
        compactAt: updated.compactAt,
        breakdown: updated.breakdown,
        omitted: updated.omitted,
      })
    } else if (outcome.status === 'aborted') {
      // 手动压缩不向 `run()` 传入信号，这条终态不可达。保留它是因为静默丢弃一个终态
      // 对用户而言等同于「点击按钮没有反应」。
      emit({ type: 'compaction', runId, phase: 'failed', reasonCode: 'aborted' })
    } else if (outcome.status === 'skipped') {
      // 「没有可压缩的内容」不是失败：用户点击了按钮，必须有反馈，但不能报错。
      emit({ type: 'compaction', runId, phase: 'skipped', reasonCode: outcome.reasonCode })
    } else {
      emit({ type: 'compaction', runId, phase: 'failed', reasonCode: outcome.reasonCode })
    }
  } catch (err) {
    // `reasonCode` 是**错误码**，不是消息。写入 `err.message.slice(0, 80)` 时，
    // 前端会把该字段直接显示在括号中，异常原文（英文、被截断、带内部标识）
    // 会成为显示给用户的界面文案。分类与 run.error 口径一致：
    // 可识别的使用 ProviderError 的错误码，其余一律为 internal_error。
    const reasonCode = err instanceof ProviderError ? err.code : 'internal_error'
    const message = clean(err instanceof Error ? err.message : String(err))
    appendStep(deps.store, {
      runId,
      seq: ++seq,
      kind: 'compaction',
      status: 'failure',
      payload: {
        kind: 'compaction',
        phase: 'failed',
        manifestRevision: 0,
        compactedMessages: 0,
        trigger: 'manual',
        reasonCode,
        message,
      },
    })
    finishRun(deps.store, runId, {
      status: 'failed',
      stopReason: 'provider_error',
      errorCode: reasonCode,
      errorMessage: message,
    })
    emit({
      type: 'compaction',
      runId,
      phase: 'failed',
      reasonCode,
    })
  } finally {
    clearInterval(heartbeat)
    // 与普通轮次一样只在结束时记录一次用量；请求明细与长期费用账各自保持原有职责。
    if (usageProvider !== null && run.usage.turns.length > 0) {
      recordUsage(deps.store, {
        kind: 'run',
        runId,
        conversationId,
        workspaceId: conversation.workspaceId,
        model: conversation.model,
        provider: usageProvider,
        inputTokens: run.usage.inputTokens,
        outputTokens: run.usage.outputTokens,
        cachedTokens: run.usage.cachedTokens,
        cacheWriteTokens: run.usage.cacheWriteTokens,
        reasoningTokens: run.usage.reasoningTokens,
        cost: run.usage.cost,
        currency: run.usage.currency,
      })
    }
  }
}

/**
 * 手动压缩使用会话绑定的接口与模型，同名模型不能借用全局默认接口。
 *
 * 字段集必须与 `Session.resolveProfile` 逐项相同：缺少任一项时，
 * 手动摘要按另一套参数发出，两条入口的产出不可比较。
 */
function summaryProfile(deps: CommandDeps, conversationId: ConversationId): ProviderProfile {
  const conversation = getConversation(deps.store, conversationId)
  const model = conversation?.model
  const stored = conversation?.provider
    ? resolveModel(deps.config, { provider: conversation.provider, model: conversation.model })
    : undefined
  if (!stored) throw new Error(model ? `配置中没有模型 "${model}"` : NO_MODEL_MESSAGE)
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

// ───────────────────────── HTTP API ─────────────────────────

// ───────────────────────── 辅助 ─────────────────────────
