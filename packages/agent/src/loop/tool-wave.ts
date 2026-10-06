/**
 * 处理一轮响应中的工具调用：拒绝未注册与参数不是对象的调用，按波次执行其余调用，结果返回给模型，
 * 并为每批记录一条进展证据。
 */

import type { WireToolCall } from '@qywork/ai'
import type { AgentEvent, RunId } from '@qywork/core'
import { openBatchBudget } from '../delivery.ts'
import type { EventQueue } from '../event-queue.ts'
import { drainUntil } from '../event-queue.ts'
import { cycleFingerprint } from '../progress.ts'
import {
  isParallelSafe,
  type PermissionEffect,
  resolveAction,
  resolvePermissionEffect,
  type ToolContext,
  type ToolContextBase,
  type ToolOutcome,
  type ToolRegistry,
} from '../registry.ts'
import { compactBeforeTools } from './compact.ts'
import { softLimit, toolOutcomeContent } from './request.ts'
import { type LoopHost, type RunState, type TurnState, untilAborted } from './run-state.ts'

/**
 * 执行本轮的工具调用。返回 `stop` 时 `run.stopReason` 与 `stopDetail` 已定为无进展或用户中断。
 */
export async function* executeCalls(
  host: LoopHost,
  run: RunState,
  turn: TurnState,
): AsyncGenerator<AgentEvent, 'stop' | 'continue', unknown> {
  const { input, persist, registry, transcript, fileChanges, ctx, emitQueue } = run
  const { calls, requestId } = turn

  // 压缩检查点必须位于开启第一条工具记录之前，理由见 `compactBeforeTools`。
  const reading = yield* compactBeforeTools(host, run, turn)
  if (reading === 'interrupted') return 'stop'
  /*
   * 投递额度按决策计算一次，全部波次共用：余量 = 软阈值 − 当前占用，按检查点给出的折算比
   * 折算为本地估算值（占用是 provider 真值，工具结果按本地估算计量）。折算比只缩小不放大，理由见 `compactBeforeTools`。
   */
  openBatchBudget(ctx.state, (softLimit(run.adapter.spec) - reading.occupancy) * reading.scale)

  /*
   * 名称不在注册表中的调用与参数不是 JSON 对象的调用，一律不进入执行链。
   *
   * 注册表是工具的唯一权威：名称不在表中即为未注册调用，不是一种工具。
   * 进入执行链会创建一条没有动作、也没有执行事实的 tool step，界面只能为它
   * 虚构标题。
   *
   * 参数不是 JSON 对象（解析失败、`null`、数组或标量）时，适配器将 `arguments` 设为
   * `{}`，并将原文记录在 `argumentsError` 上。必填项校验（`ToolRegistry.execute`）只能拦截
   * 声明了 `required` 的工具，`required: []` 的工具会把该空对象视为没有参数并照常执行。
   * 因此判据取 `argumentsError` 本身，不取校验结果。
   *
   * 在此拦截后，下游每一条 step 都必然有 spec、必然能解析出动作，
   * 渲染侧无需任何后备分支。
   *
   * 结果仍必须返回给模型：provider 要求每个 tool_call 都有一条
   * 对应 id 的 tool 结果，缺少时下一轮请求返回 400。因此照常追加一条失败结果，
   * 模型据此改用实际存在的工具或重新发送完整参数。
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
   * 两套下标不可混用：`planWaves` 的 callIndex 是过滤后下标，写入账本与
   * 事件，语义保持不变；批次证据按 provider 原调用顺序聚合，使用原始下标：
   * 上方被拦截调用的证据按原始下标记录，混用会使含被拦截调用的
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
    const results = await Promise.all(
      wave.map(async ({ call, callIndex }) => {
        // 非空断言成立：上方已拦截所有不在注册表中的调用，
        // 执行到此处的每一条调用都有 spec。
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

    // 先广播全部 tool.started 事件，界面才能同时将同一波次的多个工具卡片显示为运行中。
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
     * 与停止信号竞争，并在等待期间发出中途输出。
     *
     * 直接使用 `Promise.all` 有两个问题：一个不返回的工具会使整轮阻塞于此，
     * 而停止按钮只设置了一个无人检查的信号；此外本波次运行期间，shell 的 stdout
     * 一直积压在内存中（实测 `npm test` 50.7 秒，界面全程无变化）。
     * `drainUntil` 同时处理这两个问题，其返回值即本波次的执行结果。
     */
    const settled = yield* drainUntil(
      emitQueue,
      untilAborted(
        input.signal,
        Promise.all(
          results.map(async (r) => {
            const started = Date.now()
            // 必须在调用执行器之前写入「即将执行」时间戳：崩溃恢复以此区分未执行与执行状态不明的调用。
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
       * 文件页失效的判据来自工具声明的副作用，不根据命令正文推测。
       *
       * write/delete/execute 都可能写入磁盘；文件工具会给出精确明细，shell、格式化器、
       * 构建器和子流程通常只能确认已执行。后者发送空 changes：刷新磁盘快照，但
       * 不把未知路径记为变更记录。权限拒绝（`executed:false`）未实际执行，不发送。
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

      // 工具结果必须原样返回给模型：这是不可改写的事实，
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
   * 一次 provider 决策只记录一条进展证据：判定统计的是看过结果后仍作出
   * 相同决策的周期数，不是工具调用数。逐调用记录时，单次响应内的重复
   * 调用会在模型看到任何结果之前满足三次阈值并导致错误停止。
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

  // 波次全部执行完毕后才能确定本单元末尾的 step seq，因此对整段重新标记一次。
  run.stampUnit(turn.unitStart)

  // 重复无进展：调用或参数校验失败的结果重复且没有副作用，连续三个周期。
  // 判定在批次执行完毕之后进行，不在下发之前：提前中断会在 transcript 中留下
  // 一条有 tool_calls 却没有 tool 结果的 assistant 消息，下一轮请求会被
  // provider 以 400 拒绝。代价是晚一轮停止，仍优于继续无进展地执行。
  if (run.stalled()) {
    run.stopReason = 'no_progress'
    run.stopDetail = `连续三轮工具调用没有进展：${[...new Set(calls.map((c) => c.name))].join('、')}`
    return 'stop'
  }
  return 'continue'
}

/**
 * 为本次调用构造带 stepId 的 `emit`。
 *
 * 中途输出事件必须能识别所属的卡片：前端按 stepId 在 transcript 中查找对应条目，
 * 未找到则整条丢弃。stepId 在开启 step 时才产生，装配方无法构造，
 * 因此该通道只能在此处绑定（见 `ToolContext.emit`）。
 *
 * 其余字段原样传递：`state` / `resources` 是同一个 Map 引用。
 * 「每个 run 只创建一个 ToolContext」这条不变量保证这些状态跨调用可见，
 * 外层包装不改变它们。
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
 * 默认全部串行。只有连续若干个调用都声明了并行安全、且涉及的资源键
 * 互不相交时，才合并为一个波次。
 *
 * 必须限定为连续调用：模型给出的调用顺序本身包含意图（先读后写），
 * 跨越一个不安全调用合并其后的安全调用会打乱该顺序。
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
    // 资源冲突：同一个文件不能在同一波次中被两个调用访问。
    if (keys.some((k) => currentKeys.has(k))) flush()
    for (const k of keys) currentKeys.add(k)
    current.push({ call, callIndex })
  })
  flush()

  return waves
}

/**
 * 本次调用是否确定没有产生副作用。约定见 `ProgressEvidence.noProgress`：
 * 只有明确事实参与无进展判定，不确定的情况一律视为可能有副作用。
 *
 * `fileChanges` 非空直接判定为有副作用；`executed: false` 表示没有进入执行器；
 * 其余只认注册期声明为纯 `read` 的工具。不要放宽到 `execute` / `network` /
 * `internal_control`：它们即使返回失败也可能已修改外部状态（写入一半后抛出同样是失败），
 * 字段缺失不能视为明确没有变更。
 */
export function provablyNoEffect(effect: PermissionEffect, outcome: ToolOutcome): boolean {
  if (outcome.fileChanges?.length) return false
  if (outcome.executed === false) return true
  return effect === 'read'
}
