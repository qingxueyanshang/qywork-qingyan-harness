/**
 * 一轮响应里的工具调用：挡掉未注册与参数不是对象的调用，按波次执行其余调用，结果回给模型，
 * 并按批记一条进展证据。
 */

import type { WireToolCall } from '@qywork/ai'
import type { AgentEvent, RunId } from '@qywork/core'
import type { EventQueue } from '../event-queue.ts'
import { drainUntil } from '../event-queue.ts'
import { cycleFingerprint } from '../progress.ts'
import {
  isParallelSafe,
  type PermissionEffect,
  resetBatchBudget,
  resolveAction,
  resolvePermissionEffect,
  type ToolContext,
  type ToolContextBase,
  type ToolOutcome,
  type ToolRegistry,
} from '../registry.ts'
import { toolOutcomeContent } from './request.ts'
import { type RunState, type TurnState, untilAborted } from './run-state.ts'

/**
 * 执行本轮的工具调用。返回 `stop` 时 `run.stopReason` 与 `stopDetail` 已定为无进展。
 */
export async function* executeCalls(
  run: RunState,
  turn: TurnState,
): AsyncGenerator<AgentEvent, 'stop' | 'continue', unknown> {
  const { input, persist, registry, transcript, fileChanges, ctx, emitQueue } = run
  const { calls, requestId } = turn

  /*
   * **名字不在注册表里的、参数不是 JSON 对象的，一律不进执行链。**
   *
   * 注册表是工具的唯一权威——名字不在表里就是未注册调用，不是一种工具。
   * 放它进去会开出一条没有动作、也没有执行事实的 tool step，迫使界面替它
   * 编造标题。
   *
   * 参数不是 JSON 对象（解析失败、`null`、数组或标量）时适配器把 `arguments` 交成
   * `{}` 并把原文挂在 `argumentsError` 上。必填项校验（`ToolRegistry.execute`）只挡得住
   * 声明了 `required` 的工具，`required: []` 的工具会把这个空对象当成「没有参数」照常执行。
   * 所以判据取 `argumentsError` 本身，不取校验结果。
   *
   * 在这里挡掉之后，**下游每一条 step 都必然有 spec、必然解析得出动作**，
   * 渲染那侧不再需要任何兜底分支。
   *
   * 但结果**必须回给模型**：provider 的契约是每个 tool_call 都要有一条
   * 对应 id 的 tool 结果，少一条下一轮直接 400。所以照常推一条失败结果，
   * 它自己会改用真实存在的工具或重发完整参数。
   */
  // 本批（一次 provider 决策）的逐调用证据，波次全部结束后聚合成一条。
  const batchEvidence: {
    callIndex: number
    cycle: string
    noProgress: boolean
  }[] = []

  for (const [callIndex, c] of calls.entries()) {
    const rejection = !registry.has(c.name)
      ? `未注册调用：${c.name}。只能调用工具表中已注册的工具。`
      : c.argumentsError !== undefined
        ? `参数不是 JSON 对象，未执行：${c.argumentsError}。请重新发送完整的 JSON 对象参数。`
        : null
    if (rejection === null) continue
    const outcome: ToolOutcome = {
      status: 'failure',
      executed: false,
      message: rejection,
    }
    transcript.push({
      role: 'tool',
      toolCallId: c.id,
      content: toolOutcomeContent(c, outcome),
      _group: 'executionRecords',
      _batch: requestId,
    })
    batchEvidence.push({
      callIndex,
      cycle: cycleFingerprint(c.name, c.arguments, outcome),
      noProgress: true,
    })
  }

  /*
   * 两套下标不可混用：`planWaves` 的 callIndex 是过滤后下标，进账本与
   * 事件，语义保持不变；批证据要按 provider 原调用顺序聚合，用原始下标
   * ——被挡下的调用的证据（上面）就是按原始下标记的，混用会让含被挡调用的
   * 批次聚合顺序偏离原顺序。
   */
  const known: WireToolCall[] = []
  const originalIndexes: number[] = []
  calls.forEach((c, i) => {
    if (!registry.has(c.name) || c.argumentsError !== undefined) return
    known.push(c)
    originalIndexes.push(i)
  })
  const waves = planWaves(known, registry)

  for (let waveIndex = 0; waveIndex < waves.length; waveIndex++) {
    const wave = waves[waveIndex]!
    // 批级投递预算按波次清零。限单次没有上界——一波五个 read_file
    // 各自都在 1/8 以内，加起来就是 5/8，而「压缩只留一个入口」的前提
    // 正是两次检查之间的跳变有上界。
    resetBatchBudget(ctx.state)
    const results = await Promise.all(
      wave.map(async ({ call, callIndex }) => {
        // 非空断言成立：上面已经把不在注册表里的调用整段挡掉了，
        // 走到这里的每一条都有 spec。
        const action = resolveAction(registry.get(call.name)!, call.arguments, ctx)
        const stepId = persist.openToolStep(
          input.runId,
          run.nextSeq(),
          call,
          requestId,
          callIndex,
          waveIndex,
          action,
        )
        return { call, callIndex, stepId, action }
      }),
    )

    // 先把「开始了」全部广播出去，UI 才能同时点亮同一波的多个工具卡。
    for (const r of results) {
      yield {
        type: 'tool.started',
        runId: input.runId,
        stepId: r.stepId as never,
        toolCallId: r.call.id,
        toolName: r.call.name,
        batchId: requestId,
        callIndex: r.callIndex,
        waveIndex,
        args: r.call.arguments,
        action: r.action,
      }
    }

    /*
     * 与停止赛跑，并且**边等边把中途输出交出去**。
     *
     * 裸 `Promise.all` 有两处问题：一个不返回的工具把整轮钉死在这里，
     * 而停止按钮只是置了个信号没人看；以及这一波跑多久，shell 的 stdout
     * 就在内存里压多久（实测 `npm test` 50.7 秒，界面全程不动）。
     * `drainUntil` 两件都管——它的返回值就是这一波的执行结果。
     */
    const settled = yield* drainUntil(
      emitQueue,
      untilAborted(
        input.signal,
        Promise.all(
          results.map(async (r) => {
            const started = Date.now()
            // 提交「即将执行」的时间戳必须在调用执行器之前——这是崩溃恢复的歧义边界。
            persist.markExecuting(r.stepId)
            const outcome = await registry.execute(
              r.call.name,
              r.call.arguments,
              withStep(ctx, input.runId, r.stepId, emitQueue),
            )
            return { ...r, outcome, durationMs: Date.now() - started }
          }),
        ),
      ),
    )

    for (const s of settled) {
      const status = s.outcome.status === 'success' ? 'success' : 'failure'
      persist.settleTool(s.stepId, status, s.outcome, s.call.arguments, s.action, s.durationMs)

      const exactFileChanges = s.outcome.fileChanges ?? []
      if (exactFileChanges.length) {
        fileChanges.push(...exactFileChanges)
      }

      /*
       * 文件页要失效的判据来自工具声明的副作用，不猜命令正文。
       *
       * write/delete/execute 都可能落盘；文件工具会给精确明细，shell、格式化器、
       * 构建器和子流程通常只能确认“执行过”。后者发空 changes：刷新磁盘快照，但
       * 不把未知路径伪装成变更记录。权限拒绝 (`executed:false`) 没真正执行，不发。
       */
      const effect = resolvePermissionEffect(registry.get(s.call.name)!, s.call.arguments)
      if (
        exactFileChanges.length > 0 ||
        (s.outcome.executed !== false &&
          (effect === 'write' || effect === 'delete' || effect === 'execute'))
      ) {
        yield { type: 'file.changed', runId: input.runId, changes: exactFileChanges }
      }

      yield {
        type: 'tool.finished',
        runId: input.runId,
        stepId: s.stepId as never,
        toolCallId: s.call.id,
        status,
        outcome: s.outcome,
        durationMs: s.durationMs,
      }

      // 工具结果必须原样回传给模型——这是不可改写的事实，
      // 装配层不得摘要、截断或改写措辞。
      transcript.push({
        role: 'tool',
        toolCallId: s.call.id,
        content: toolOutcomeContent(s.call, s.outcome),
        _group: 'executionRecords',
        _batch: requestId,
      })

      batchEvidence.push({
        callIndex: originalIndexes[s.callIndex]!,
        cycle: cycleFingerprint(s.call.name, s.call.arguments, s.outcome),
        noProgress: provablyNoEffect(
          resolvePermissionEffect(registry.get(s.call.name)!, s.call.arguments),
          s.outcome,
        ),
      })
    }
  }

  /*
   * 一次 provider 决策只记**一条**进展证据：监督器数的是「看过结果仍作
   * 相同决策」的周期数，不是工具调用数。逐调用记账时，单次响应内的重复
   * 调用会在模型看到任何结果之前满足三次阈值并误停。
   * 按 callIndex 排序，保证聚合顺序与 provider 原调用顺序一致。
   */
  if (batchEvidence.length) {
    const ordered = [...batchEvidence].sort((a, b) => a.callIndex - b.callIndex)
    run.progress.push({
      cycle: cycleFingerprint(
        'provider_batch',
        {},
        {
          status: 'results',
          data: ordered.map((e) => e.cycle),
        },
      ),
      noProgress: ordered.every((e) => e.noProgress),
    })
  }

  // 波次跑完才知道这个单元的末 step seq，整段重盖一次。
  run.stampUnit(turn.unitStart)

  // 原地打转：同样的调用、同样的结果、没有副作用，连着三个周期。
  // **判在批次跑完之后**，不在下发之前——提前中断会在 transcript 里留下
  // 一条有 tool_calls 却没有 tool 结果的 assistant 消息，下一轮请求会被
  // provider 直接 400。代价是晚一轮才停，仍然远好过继续空转。
  if (run.stalled()) {
    run.stopReason = 'no_progress'
    run.stopDetail = `连续三轮相同的调用与结果：${[...new Set(calls.map((c) => c.name))].join('、')}`
    return 'stop'
  }
  return 'continue'
}

/**
 * 给这一次调用配一个带 stepId 的 `emit`。
 *
 * 中途输出的事件必须认得出属于哪张卡片——前端拿 stepId 在 transcript 里找那一条，
 * 找不到就整条丢弃。而 stepId 是开 step 时才产生的，装配方造不出来，
 * 所以这条通道只能在这里绑（见 `ToolContext.emit`）。
 *
 * **其余字段原样带过去**：`state` / `resources` 传的是同一个 Map 引用，
 * 「ToolContext 整个 run 只建一个」那条不变量护的是这几本账跨调用可见，
 * 外面套一层壳不动它们。
 */
function withStep(
  base: ToolContextBase,
  runId: RunId,
  stepId: string,
  queue: EventQueue,
): ToolContext {
  return {
    ...base,
    stepId,
    emit: (channel, delta) => {
      queue.push({ type: 'tool.delta', runId, stepId: stepId as never, channel, delta })
    },
  }
}

/**
 * 执行波次规划。
 *
 * 默认全部串行。只有当**连续**若干个调用都声明了并行安全、且它们触碰的资源键
 * 互不相交时，才合并成一个波次。
 *
 * 「连续」这条限制很重要：模型给出的调用顺序本身携带意图（先读后写），
 * 跨越一个不安全调用去合并后面的安全调用会打乱这个顺序。
 */
export function planWaves(
  calls: WireToolCall[],
  registry: ToolRegistry,
): { call: WireToolCall; callIndex: number }[][] {
  const waves: { call: WireToolCall; callIndex: number }[][] = []
  let current: { call: WireToolCall; callIndex: number }[] = []
  let currentKeys = new Set<string>()

  const flush = () => {
    if (current.length) waves.push(current)
    current = []
    currentKeys = new Set()
  }

  calls.forEach((call, callIndex) => {
    const spec = registry.get(call.name)
    const safe = spec ? isParallelSafe(spec, call.arguments) : false
    if (!safe) {
      flush()
      waves.push([{ call, callIndex }])
      return
    }
    const keys = spec?.resourceKeys?.(call.arguments) ?? []
    // 资源冲突：同一个文件不能在同一波里被两个调用碰。
    if (keys.some((k) => currentKeys.has(k))) flush()
    for (const k of keys) currentKeys.add(k)
    current.push({ call, callIndex })
  })
  flush()

  return waves
}

/**
 * 这次调用是否确凿没有产生副作用。契约见 `ProgressEvidence.noProgress`：
 * 只有明确事实参与空转判定，含糊一律视为可能有副作用。
 *
 * `fileChanges` 非空直接判为有副作用；`executed: false` 表示没有进入执行器；
 * 其余只认注册期声明为纯 `read` 的工具。不要放宽到 `execute` / `network` /
 * `internal_control`：它们即使返回失败也可能已修改外部状态（写到一半再抛也是错），
 * 字段缺席不能当成「明确没有变更」。
 */
export function provablyNoEffect(effect: PermissionEffect, outcome: ToolOutcome): boolean {
  if (outcome.fileChanges?.length) return false
  if (outcome.executed === false) return true
  return effect === 'read'
}
