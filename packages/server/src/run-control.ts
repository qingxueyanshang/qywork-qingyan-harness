/**
 * run 的起、重试、压缩，以及**目标的自动续起**。
 *
 * 五条入口共用同一个 `Session` 装配：手动发消息、定时任务触发、重试、目标续起、
 * 跟进消息火发。给任何一条单开一套装配就是五套会漂移的行为。
 *
 * **续起为什么判在 `startRun` 的 `finally`。** 那里已经在做 `runs.unregister` / `release` /
 * `session.dispose()`，是「这一轮干完了」的**唯一汇合处**——正常结束、抛错、被中断三条路都要经过
 * 它。
 *
 * **不是 `recoverStaleRuns`**：那个只在 `createServer` 启动时跑一次（开服之前），
 * 把目标判定放进进程启动，正是「崩溃之后自动复活」——`GoalArm` 上那段注释
 * 要防的第一件事。两处差着一整个生命周期。
 */

import { buildAdapter, ProviderError, type ProviderProfile } from '@qywork/ai'
import type { AgentEvent, Attachment, ConversationId, Goal, RunId, StopReason } from '@qywork/core'
import {
  configPath,
  contextPanel,
  makeSummarizer,
  RuntimeCompaction,
  resolveModel,
  Session,
} from '@qywork/runtime'
import { createGoal, currentGoal, getConversation, updateGoal, workspaceOf } from '@qywork/store'
import { makeDelegate } from './delegate.ts'
import type { CommandDeps } from './deps.ts'
import { publishGitState } from './http-util.ts'
import { makePluginPort } from './plugin-port.ts'
import type { GoalArm } from './runs.ts'

/**
 * 发起一轮。
 *
 * deps 里**不含 `ws`**：这条路径除了 `handleCommand`，还要给定时任务用，
 * 而定时触发没有发起方的连接。它本来也没用过 `ws`——事件全部走 bus 广播，
 * 因为同一个会话可能同时开在桌面端和手机上。
 */
export async function startRun(
  conversationId: ConversationId,
  content: string,
  model: string | undefined,
  deps: Omit<CommandDeps, 'ws'>,
  attachments?: Attachment[],
  /**
   * 这一轮是**目标自动续起**的那一轮，带着发起时的预留。
   *
   * 唯一的作用是把这一轮和「人在说话」区分开：其余三条入口都代表人的动作，
   * 一进来就把待续起标记清掉（人类消息优先）；续起自己那一轮不能清，
   * 清了循环最多跑一轮。
   */
  goalRound?: GoalArm,
): Promise<void> {
  /*
   * 占位与检查必须是同一个同步动作：只检查不占位的话，从这里到 `runs.register()`
   * 之间隔着好几个 await，两条几乎同时到达的消息会双双通过。
   *
   * **走得到这条回绝的只剩一处竞态**：目标续起的 `setTimeout` 到点时会话又忙了
   * （`fireGoalRound`）。
   * 用户发消息不再走到这里——忙时它排进队列（`commands.ts`）；定时任务也不会
   * ——两条路径都是**新建会话**再起轮（`server.ts` 与 `api/schedules.ts`）。
   */
  if (!deps.runs.reserve(conversationId)) {
    deps.bus.publish(
      {
        type: 'run.error',
        runId: '' as RunId,
        code: 'internal_error',
        message: '该会话已有任务在执行，请先中断',
      },
      conversationId,
    )
    return
  }

  /*
   * **人类消息优先。** 用户发消息（以及重试、定时触发）一进来，排着的那次自动
   * 续起就作废——他插的这一句才是这条会话现在该干的事。
   *
   * 放在 reserve 成功之后：被回绝的消息没有发生，不该动任何状态。
   */
  if (!goalRound) deps.runs.disarm(conversationId)

  /*
   * 这一轮跑在哪个目录下，**按会话查，不问进程**。
   *
   * 服务进程不许拿一个 `workspaceRoot` 常量（启动时的 `--cwd`）：那样一个进程
   * 只服务得了一个项目，而那个常量本身就是 `workspaces` 表的一份缓存。
   *
   * 查不到就停：回落到某个默认根等于拿着 A 项目的会话去 B 项目的目录里跑命令，
   * 而工具的路径约束、shell 的沙箱边界全部以这个根为界。
   */
  const ws = workspaceOf(deps.store, conversationId)
  if (!ws) {
    deps.runs.release(conversationId)
    deps.bus.publish(
      {
        type: 'run.error',
        runId: '' as RunId,
        code: 'internal_error',
        message: '这个会话找不到对应的项目目录，无法执行',
      },
      conversationId,
    )
    return
  }

  const controller = new AbortController()
  let currentRunId: RunId | null = null

  const session = new Session({
    store: deps.store,
    config: deps.config,
    content: deps.content,
    workspaceRoot: ws.rootPath,
    signal: controller.signal,
    // 派活通道只给顶层会话。成员会话（`team-run.ts`）不传，因此它那边连
    // `subagent` 工具都不注册——子 agent 再派活没有终止条件。
    delegate: makeDelegate({ deps, workspaceRoot: ws.rootPath, conversationId }),
    // 装插件同样只给顶层会话：成员会话不该给整台机器装插件。
    plugins: makePluginPort({ workspaceRoot: ws.rootPath }),
    // 跟进消息队列同样只给顶层会话：成员会话不在界面上，没有人往它里面插话。
    followUps: (id) => deps.runs.takeSteered(id),
  })

  /*
   * 这一轮怎么收的场，只在续起判定里用。
   *
   * **两个都要收，因为报错有两条路**：loop 内部的 provider 错误**不会抛出来**，
   * 它被就地转成 `run.error` + `run.finished{stopReason:'provider_error'}`
   * （`agent/loop.ts`）；只有 loop 之外的错（装配 adapter、解析档案）才走 catch。
   * 只认 catch 的话，一次 provider 报错会被判成「这一轮正常跑完了」然后接着续起
   * ——那正是「不自动重试异常」要防的形状。
   */
  let stopReason: StopReason | null = null
  let failure: string | null = null

  // 后台跑，不阻塞 WebSocket 消息循环——否则一轮 agent 跑十分钟，
  // 这十分钟里连中断指令都收不到。
  void (async () => {
    try {
      for await (const ev of session.ask(content, conversationId, {
        ...(model ? { model } : {}),
        ...(attachments?.length ? { attachments } : {}),
      })) {
        // 并非所有事件都带 runId（git.state / file.changed 是工作区级的），
        // 取之前先窄化，不能假设字段存在。
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
         * **续起标记只由目标事件驱动**，不由「谁调过目标工具」推。
         *
         * 目标的真源在账本，而这条事件是账本刚刚变成什么样的如实广播
         * （`runtime/session.ts` 的 `announce`）。模型在同一轮里立了目标又
         * 自己 complete 掉时，后一条事件把标记解除，循环不会白起一轮。
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
      // 在 loop 之外抛出的错误（装配 adapter、解析档案）走这里。
      //
      // 别硬编码 `internal_error`：那样「没配 key」在 CLI 里报 no_api_key、
      // 在桌面端却报 internal_error，前端的「去配置」引导永远不触发。
      // 错误码是给前端决定引导动作用的，压平成 internal_error 就等于没有分类。
      const pe = err instanceof ProviderError ? err : null
      const base = pe?.message ?? (err instanceof Error ? err.message : String(err))
      // 桌面端用户手边不一定有终端，「运行 qy init」对他们只是一句空话。
      // 把配置文件路径带上——那是他们真正能打开的位置。
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
      // register 过就走 unregister，没跑起来的由 release 收——两者都不做的话
      // 这个会话会被永久占住，之后每一条消息都被回绝「已有任务在执行」。
      if (currentRunId) deps.runs.unregister(currentRunId)
      else deps.runs.release(conversationId)
      // 每条消息一个 Session，每个 Session 都持有扩展的一份引用。
      // 不释放的话引用只增不减，插件与 MCP 子进程到进程退出都关不掉。
      session.dispose()
      const interrupted = controller.signal.aborted || stopReason === 'user_interrupt'
      /*
       * 「调整方向」只对发出它的那一轮成立。这一轮收尾了，没赶上 step 边界的那些
       * 条目再没有可注入的地方；留着标记的话下一轮开跑会把它们注入到一轮用户
       * 没有指向过的执行里。
       */
      deps.runs.resetSteer(conversationId)
      /*
       * **跟进消息压过目标续起**：人插的那句话才是这条会话现在该干的事，
       * 与 `startRun` 开头那条「人类消息优先」的 `disarm` 同一条学说。
       *
       * 但只压过续起那一支。`settleGoalAfterRun` 的 pause / blocked 两支是收尾不是
       * 续起——跳掉它们的失败形状是：中断且队列非空时目标停不进 `paused`、
       * 续起标记悬在表里，界面上那条目标永远显示在跑。
       */
      const fired =
        !interrupted &&
        !!stopReason &&
        CONTINUABLE.includes(stopReason) &&
        fireFollowUpRound(conversationId, deps)
      // 判定放在 dispose **之后**：占位放了、扩展也放了，这一轮才算真的干完，
      // 下一轮起来时不会和上一轮的子进程叠在一起。
      settleGoalAfterRun({
        conversationId,
        deps,
        interrupted,
        stopReason,
        failure,
        skipResume: fired,
      })
      void publishGitState(ws.rootPath, ws.id, deps.bus)
    }
  })()
}

/**
 * run 收尾时把队首那条跟进消息发成下一轮。返回 true = 取到了、已排上。
 *
 * **同步取走、异步发起。** 取走与「跳不跳目标续起」是同一个决定，拆开就会出现
 * 「续起已经被跳过，而那条消息在 setTimeout 到点之前被用户删了」——两边都没跑。
 *
 * 到点时会话又忙了（另一端刚发了一条），把它塞回队首，不丢。
 * 异步发起的理由与 `queueGoalRound` 一样：不叠在这一轮的 `finally` 里。
 */
function fireFollowUpRound(conversationId: ConversationId, deps: Omit<CommandDeps, 'ws'>): boolean {
  const item = deps.runs.takeNext(conversationId)
  if (!item) return false
  setTimeout(() => {
    if (deps.runs.isBusy(conversationId)) {
      deps.runs.enqueueFront(conversationId, item)
      return
    }
    void startRun(conversationId, item.content, undefined, deps, item.attachments).catch((err) => {
      // 塞回队首而不是吞掉：卡片重新出现，用户看得见它没发出去。
      deps.runs.enqueueFront(conversationId, item)
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
  }, 0)
  return true
}

// ───────────────────────── 目标的自动续起 ─────────────────────────

/**
 * **只有这两种收尾算「这一轮正常跑完了」。** 其余一律停下等人。
 *
 * 白名单而不是黑名单：漏了一种停止原因时，白名单的表现是「停下来问一句」，
 * 黑名单的表现是「按一个没人想过的状态接着自动跑」。
 */
const CONTINUABLE: StopReason[] = ['completed']

/**
 * 停下来的说法。**每一种都要有话说**——没理由的 blocked 是最坏的一种停：
 * 循环不动了，而界面上只有「受阻」两个字。
 */
const STOP_NOTE: Record<string, string> = {
  provider_error: '上一轮出错停了',
  no_progress: '上一轮在原地打转',
  output_truncated: '上一轮输出被截断',
}

/**
 * 一轮跑完，决定要不要再起一轮。
 *
 * 三条出口，**没有第四条**：
 * - 被中断 → 目标置 `paused`，解除标记。取消之后不自动重启，这是硬规则；
 * - 非正常收尾（provider 报错、原地打转…）→ 目标置 `blocked`，
 *   解除标记。**不重试**——隐式重试会把一次故障放大成一串一模一样的失败，
 *   而用户只看到会话在那儿自己转；
 * - 正常收尾 → 排队起下一轮。
 *
 * 没有待续起标记就直接走人：那说明这条会话不在自动循环里
 * （或者进程重启过——标记不落盘，见 `GoalArm`）。
 */
function settleGoalAfterRun(input: {
  conversationId: ConversationId
  deps: Omit<CommandDeps, 'ws'>
  interrupted: boolean
  stopReason: StopReason | null
  failure: string | null
  /**
   * 队首那条跟进消息已经排上下一轮，**只跳过续起那一支**。
   *
   * 下面 pause / blocked 两支照走：它们是收尾不是续起，跳掉会把目标留在 active
   * 且续起标记不解除。
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
      const note = (input.stopReason && STOP_NOTE[input.stopReason]) ?? '上一轮没有正常收尾'
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
 * 把目标停在某个状态上并解除标记。
 *
 * 用**刚读到的** revision 而不是续起标记里那个：模型可能在这一轮里改过目标，
 * 那些改动是真的，不该被一次中断按旧版本覆盖回去。
 */
function stopGoal(
  deps: Omit<CommandDeps, 'ws'>,
  conversationId: ConversationId,
  armed: GoalArm,
  how: { action: 'pause' } | { action: 'blocked'; code: string; reason: string },
): void {
  deps.runs.disarm(conversationId)
  const goal = currentGoal(deps.store, conversationId)
  // 目标已经被换掉或者进了终态，就没有什么可停的了。
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
 * 排下一轮。**异步排队，不是同步递归调 `startRun`**——同步调会把下一轮的执行栈
 * 叠在这一轮的 `finally` 里：栈越叠越深，而且下一轮开跑时上一轮还没收完尾。
 *
 * 用户点「继续」走的也是这里（`resumeGoal`），不另开一条起轮的路。
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
 * 真的起下一轮。
 *
 * **发起之前重读目标**：排队到现在这段时间里，用户可能插了一句话（标记已被清）、
 * 模型可能已经把目标改了或做完了。预留（goalId + revision）对不上就**丢弃这次排队**
 * ——按一个几秒前的版本继续跑，跑的就不是用户现在要的那件事。
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
   * **没有轮数上限，所以这里不再有配额判定。** 循环的出口只有三个：模型自检
   * `complete`、模型 `blocked`、用户中断转 `paused`；外加这一轮没正常收尾时
   * （`CONTINUABLE` 之外的停止原因）由 `settleGoalAfterRun` 转 `blocked`。
   *
   * 也不再有「轮次 +1」这一步：没有计数器要记，`revision` 保持不变，
   * 预留（goalId + revision）因此天然还对得上——模型一旦 complete / blocked，
   * revision 就变了，下一次排队自己判成陈旧退出。
   */
  await startRun(conversationId, goalRoundPrompt(goal), undefined, deps, undefined, {
    goalId: goal.id,
    revision: goal.revision,
  })
}

/**
 * 用户用 `/goal` 立目标，或改写现在这个。**立目标的唯一入口。**
 *
 * 模型手里没有 `create_goal`（见 `tools/goals.ts` 顶部）。这条路要么建新的，
 * 要么改写在跑的那个正文——两者之后一律交给 `resumeGoal` 去转 active、上标记、
 * 起第一轮。**不自己再写一遍那三步**：同一件事的第二条实现迟早给出两种答案。
 *
 */
export function setGoal(
  conversationId: ConversationId,
  objective: string,
  deps: Omit<CommandDeps, 'ws'>,
): { ok: true } | { ok: false; message: string } {
  if (deps.runs.isBusy(conversationId)) {
    return { ok: false, message: '该会话已有任务在执行，先停下这一轮再立目标' }
  }
  try {
    const existing = currentGoal(deps.store, conversationId)
    // 已完成的目标是终态，一条出边都没有——那时候只能立新的。
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
    // 校验（空正文、轮数越界）在账本里，回绝原样带回给用户——
    // 服务端再抄一份判定就是两处会漂的规则。
    if (!written.ok) return { ok: false, message: written.message }
    publishGoal(deps, written.goal)
    return resumeGoal(conversationId, deps)
  } catch (err) {
    abortGoalLoop(conversationId, deps, err)
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * 用户在界面上点「继续」。
 *
 * **它自己发起一轮**，不等下一次别的 run 收尾——那时候用户已经等了不知道多久，
 * 而界面上什么都没发生。走的是与自动续起同一个 `queueGoalRound`。
 */
export function resumeGoal(
  conversationId: ConversationId,
  deps: Omit<CommandDeps, 'ws'>,
): { ok: true } | { ok: false; message: string } {
  if (deps.runs.isBusy(conversationId)) {
    return { ok: false, message: '该会话已有任务在执行' }
  }
  try {
    const goal = currentGoal(deps.store, conversationId)
    if (!goal) return { ok: false, message: '这条会话没有目标' }

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
 * 目标账本读坏了（revision 断号、非法转移）时的收敛动作：**停循环并说出来**。
 *
 * 回放是 fail-closed 的（`store/goals.ts` 直接抛）。这里不重试也不吞：
 * 重试只会把一次破损变成一串一模一样的报错，吞掉则是一个自己停了、
 * 谁也不知道为什么的循环。
 */
function abortGoalLoop(
  conversationId: ConversationId,
  deps: Omit<CommandDeps, 'ws'>,
  err: unknown,
): void {
  deps.runs.disarm(conversationId)
  process.stderr.write(`[qy] 目标续起中止：${err instanceof Error ? err.message : String(err)}\n`)
}

function publishGoal(deps: Omit<CommandDeps, 'ws'>, goal: Goal): void {
  deps.bus.publish({ type: 'goal', goal }, goal.conversationId)
}

/**
 * 自动续起那一轮发给模型的话。
 *
 * 措辞是这个功能里最容易做坏的一处：说轻了模型草率宣布完成，一个没做完的目标
 * 被 `complete` 掉；说重了它卡住也不肯 `blocked`，转满轮数。
 * 所以这段话必须做到四件事——**引用完整目标**、**报清第几轮**、
 * **点明谁才是权威**（工作区里的文件、这一轮工具跑出来的结果、落库的会话状态，
 * 而不是前几轮自己说过的话）、**要求完成前先拿证据**。
 */
function goalRoundPrompt(goal: Goal): string {
  return [
    '[自动续起] 这条消息由系统发出，不是用户在说话。',
    '',
    `目标（goal_id=${goal.id}，revision=${goal.revision}）：`,
    goal.objective,
    '',
    '权威只有三样：工作区里文件当前的样子、这一轮工具跑出来的结果、以及会话里已经落下的状态。',
    '前几轮说过「已经改好了」不作数——要用就自己重新核一遍。',
    '',
    '接着往下做。宣布完成之前先拿到证据（跑一次命令、读一次文件），不要只凭印象：',
    '- 确认达成了：调 update_goal(action="complete")，并把证据写在回答里。',
    '- 需要用户拍板，或者缺东西做不下去：调 update_goal(action="blocked")，写清卡在哪、要什么才能继续。',
    '- 还没做完：什么都不用调，目标保持 active，这一轮结束后会自动再来一轮。',
    '这个循环没有轮数上限：不宣布收尾它就一直跑下去，所以做到了要说，做不下去也要说。',
    'goal_id 与 revision 以 read_goal 读到的为准。',
  ].join('\n')
}

/**
 * 手动压缩一个会话。
 *
 * 与自动路径共用同一个 `RuntimeCompaction` 和同一份摘要装配（`makeSummarizer`），
 * 两条入口只差一个发起理由——两套实现迟早会漂移，且漂移了很难发现。
 *
 * 事件走总线广播而不是只回发起方：压缩改变了会话的后续行为，
 * 另一端开着同一个会话的人必须看到。
 */
export async function compactConversation(
  conversationId: ConversationId,
  deps: CommandDeps,
): Promise<void> {
  const emit = (ev: AgentEvent) => deps.bus.publish(ev, conversationId)
  // 手动压缩不属于任何 run，用空 runId——事件协议要求这个字段存在，
  // 但前端对压缩卡的渲染不依赖它。
  const runId = '' as RunId

  emit({ type: 'compaction', runId, phase: 'started' })
  try {
    const compaction = new RuntimeCompaction({
      store: deps.store,
      conversationId,
      messageIdUpperBound: null,
      summarize: makeSummarizer({
        store: deps.store,
        conversationId,
        workspaceId: workspaceOf(deps.store, conversationId)?.id ?? '',
        profile: () => summaryProfile(deps, conversationId),
      }),
    })
    // 占用与窗口从会话现算：手动压缩不属于任何 run，没有活的计量。
    // 面板与触发判定用的是同一把尺（`contextPanel` 的锚点口径），不另起一本账。
    // 窗口与密度取同一份 spec：这两个数要互相比较，出自两份 spec 就是两本账。
    const adapter = buildAdapter(summaryProfile(deps, conversationId))
    const spec = adapter.spec
    const providerName = getConversation(deps.store, conversationId)?.provider
    if (!providerName) throw new Error('这条旧会话尚未绑定接口，请重新选择模型')
    const panel = contextPanel(deps.store, conversationId, {
      ...spec,
      providerName,
      providerKind: adapter.kind,
    })
    const outcome = await compaction.run({
      trigger: 'manual',
      model: spec.id,
      occupancy: panel.total,
      // 同一份面板的两把尺，压缩按它们的比值折算回收量。
      estimatedOccupancy: panel.measured,
      contextWindow: spec.contextWindow,
      density: spec.density,
    })
    if (outcome.status === 'compacted') {
      emit({
        type: 'compaction',
        runId,
        phase: 'done',
        manifest: outcome.manifest,
        summarized: outcome.summarized,
      })
      // 手动压缩后没有下一次 request_prepared 事件，必须从刚落库的同一份 manifest
      // 重算并广播；否则模型下一轮已看到压缩投影，面板却一直停在压缩前。
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
      // 手动压缩不往 `run()` 传信号，这条终态走不到。留着是因为静默吞掉一个终态
      // 与「按钮点了没反应」在用户那边是同一件事。
      emit({ type: 'compaction', runId, phase: 'failed', reasonCode: 'aborted' })
    } else if (outcome.status === 'skipped') {
      // 「没什么可压」不是失败：用户点了按钮，必须有回音，但不能报错。
      emit({ type: 'compaction', runId, phase: 'skipped', reasonCode: outcome.reasonCode })
    } else {
      emit({ type: 'compaction', runId, phase: 'failed', reasonCode: outcome.reasonCode })
    }
  } catch (err) {
    // `reasonCode` 是**码**，不是消息。塞 `err.message.slice(0, 80)` 的话，
    // 前端把这个字段直接括号显示，异常原文（英文、半截、带内部标识）
    // 就成了给用户看的界面文案。分类和 run.error 那条一个口径：
    // 认得的走 ProviderError 的码，其余一律 internal_error。
    emit({
      type: 'compaction',
      runId,
      phase: 'failed',
      reasonCode: err instanceof ProviderError ? err.code : 'internal_error',
    })
  }
}

/**
 * 手动压缩这一轮用哪个模型：会话当前模型，没有就用配置默认。
 *
 * 字段集必须与 `Session.resolveProfile` 逐项相同——少给一项（`maxOutputTokens`
 * 就漏过一次）的表现是手动摘要按另一套上限发出去，两条入口的产出从此不可比。
 */
function summaryProfile(deps: CommandDeps, conversationId: ConversationId): ProviderProfile {
  const model = getConversation(deps.store, conversationId)?.model ?? deps.config.active.model
  const stored = resolveModel(deps.config, model)
  if (!stored) throw new Error(`配置里没有模型 "${model}"`)
  return {
    kind: stored.kind,
    apiKey: stored.apiKey ?? '',
    model: stored.model,
    ...(stored.baseUrl ? { baseUrl: stored.baseUrl } : {}),
    ...(stored.headers ? { headers: stored.headers } : {}),
    ...(stored.spec ? { spec: stored.spec } : {}),
  }
}

// ───────────────────────── HTTP API ─────────────────────────

// ───────────────────────── 辅助 ─────────────────────────
