/**
 * `runs` 表的读写：创建时的跨进程占用判定、心跳、用量、收尾，以及启动时回收上次进程遗留的轮次。
 */

import {
  type ConversationId,
  type MediaSpend,
  type MessageId,
  newRunId,
  type ProviderRequestDiagnostic,
  type Run,
  type RunContextSegment,
  type RunId,
  type RunInterruption,
  type RunUsage,
  type StepId,
  type StopReason,
  type WorkspaceId,
} from '@qywork/core'
import { type RunOwner, readJson, type Store, writeJson } from '../db.ts'
import type { RunRow } from '../rows.ts'
import { interruptRunningNodes, settleRunningSteps } from './steps.ts'

const EMPTY_USAGE: RunUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedTokens: null,
  cacheWriteTokens: null,
  reasoningTokens: 0,
  cost: 0,
  currency: 'USD',
  turns: [],
}

/** 同一会话的轮次被另一个仍在运行的进程占用。 */
export class ConversationBusyError extends Error {
  constructor(readonly holder: { runId: RunId; ownerPid: number; ownerKind: RunOwner | null }) {
    const where =
      holder.ownerKind === 'serve'
        ? '桌面端'
        : holder.ownerKind === 'cli'
          ? '终端的 qy 中'
          : '另一个进程中'
    super(`该会话已在${where}执行（pid ${holder.ownerPid}），请先在该处中断`)
    this.name = 'ConversationBusyError'
  }
}

/**
 * 创建一轮。会话当前能否开始新一轮的跨进程判定只在此处进行：服务端与 CLI 的每一轮、
 * 压缩轮都经过本函数。
 *
 * 在同一个 IMMEDIATE 事务中先查询该会话是否有其他进程占用的 running / queued 行，
 * 有则抛出 `ConversationBusyError`，不插入。占用即 `isOrphan` 判定为不可回收：
 * 该进程仍存在且心跳未过期，与崩溃回收使用同一判据。进程崩溃（pid 不存在）或停滞（心跳停止）
 * 都不算占用，因此不会永久锁死。本进程自身的行由 `isOrphan` 排除：本进程内的并发由
 * 服务端的 `RunManager` 在同步块中拦截，CLI 一个进程同时只运行一轮。
 *
 * 不要把查询移到事务外：两个进程会同时查询到无人占用，各自创建一轮。
 */
export function createRun(
  store: Store,
  input: {
    conversationId: ConversationId
    workspaceId: WorkspaceId
    model: string
    clientRequestId: string
    userMessageId: MessageId | null
    messageIdUpperBound: MessageId | null
    contextSnapshot: RunContextSegment[]
    /** 由派发任务产生的轮次携带来源；用户会话不携带。 */
    dispatch?: { stepId: StepId; nodeId: string }
    /** 本轮的开始时刻，写入 `created_at`。建行之前另有准备步骤的调用方传入接受消息的时刻；未传入时取建行时刻。 */
    createdAt?: number
  },
): Run {
  return store.tx(() => {
    const holder = liveHolder(store, input.conversationId)
    if (holder) throw new ConversationBusyError(holder)
    return insertRun(store, input)
  })
}

/** 该会话被其他进程占用的轮次；没有时返回 null。判据见 `createRun`。 */
function liveHolder(
  store: Store,
  conversationId: ConversationId,
): ConversationBusyError['holder'] | null {
  const rows = store.db
    .query<
      {
        id: RunId
        owner_pid: number | null
        owner_kind: string | null
        heartbeat_at: number | null
      },
      [string]
    >(
      `SELECT id, owner_pid, owner_kind, heartbeat_at FROM runs
       WHERE conversation_id = ? AND status IN ('running','queued')`,
    )
    .all(conversationId)
  const held = rows.find((r) => !isOrphan(r.owner_pid, r.heartbeat_at))
  if (!held) return null
  const kind = held.owner_kind
  return {
    runId: held.id,
    ownerPid: Number(held.owner_pid),
    ownerKind: kind === 'serve' || kind === 'cli' ? kind : null,
  }
}

function insertRun(store: Store, input: Parameters<typeof createRun>[1]): Run {
  const now = Date.now()
  const run: Run = {
    id: newRunId(),
    conversationId: input.conversationId,
    workspaceId: input.workspaceId,
    userMessageId: input.userMessageId,
    messageIdUpperBound: input.messageIdUpperBound,
    model: input.model,
    clientRequestId: input.clientRequestId,
    dispatchStepId: input.dispatch?.stepId ?? null,
    dispatchNodeId: input.dispatch?.nodeId ?? null,
    status: 'queued',
    stopReason: null,
    usage: { ...EMPTY_USAGE },
    stepCount: 0,
    errorMessage: null,
    errorCode: null,
    interruption: null,
    createdAt: input.createdAt ?? now,
    finishedAt: null,
  }
  store.db
    .query(
      `INSERT INTO runs
       (id, conversation_id, workspace_id, user_message_id, message_id_upper_bound,
        model, client_request_id, status, stop_reason, input_tokens, output_tokens, cached_tokens,
         cache_write_tokens, reasoning_tokens, cost, currency, usage_turns, step_count, error_message, error_code,
         context_snapshot, created_at, finished_at, owner_pid, owner_kind, heartbeat_at, dispatch_step_id, dispatch_node_id)
        VALUES (?,?,?,?,?,?,?,?,?,0,0,NULL,NULL,0,0,'USD','[]',0,NULL,NULL,?,?,NULL,?,?,?,?,?)`,
    )
    .run(
      run.id,
      run.conversationId,
      run.workspaceId,
      run.userMessageId,
      run.messageIdUpperBound,
      run.model,
      run.clientRequestId,
      run.status,
      null,
      writeJson(input.contextSnapshot),
      run.createdAt,
      // 归属在建行时即写入。若延后到开始执行之后补写，createRun 后立即崩溃留下的
      // 无归属行仍会被下一个进程按无归属规则回收，结果正确；
      // 但同一条路径上会多出一段判据不同的时间窗口。
      process.pid,
      store.owner,
      now,
      run.dispatchStepId,
      run.dispatchNodeId,
    )
  return run
}

/**
 * 心跳：告知其他进程该轮仍有进程在运行。
 *
 * 只更新 running 的行：已进入终态的 run 更新心跳没有意义，
 * 且会使「心跳未过期即仍在运行」这一判断在事后不成立。
 */
export function touchRun(store: Store, id: RunId): void {
  store.db
    .query("UPDATE runs SET heartbeat_at = ? WHERE id = ? AND status = 'running'")
    .run(Date.now(), id)
}

/** 幂等：同一 (conversationId, clientRequestId) 已有 run 时直接返回该 run。 */
export function findRunByClientRequest(
  store: Store,
  conversationId: ConversationId,
  clientRequestId: string,
): Run | null {
  const row = store.db
    .query<RunRow, [string, string]>(
      'SELECT * FROM runs WHERE conversation_id = ? AND client_request_id = ?',
    )
    .get(conversationId, clientRequestId)
  return row ? rowToRun(row) : null
}

export function getRun(store: Store, id: RunId): Run | null {
  const row = store.db.query<RunRow, [string]>('SELECT * FROM runs WHERE id = ?').get(id)
  return row ? rowToRun(row) : null
}

export function markRunRunning(store: Store, id: RunId): void {
  store.db.query("UPDATE runs SET status = 'running' WHERE id = ?").run(id)
}

export function updateRunUsage(store: Store, id: RunId, usage: RunUsage): void {
  store.db
    .query(
      `UPDATE runs SET input_tokens = ?, output_tokens = ?, cached_tokens = ?,
       cache_write_tokens = ?, reasoning_tokens = ?, cost = ?, currency = ?, usage_turns = ? WHERE id = ?`,
    )
    .run(
      usage.inputTokens,
      usage.outputTokens,
      usage.cachedTokens,
      usage.cacheWriteTokens,
      usage.reasoningTokens,
      usage.cost,
      usage.currency,
      JSON.stringify(usage.turns),
      id,
    )
}

/**
 * 向该轮的生成花费追加一笔。只由会话层在每次生成成功时调用，与模型用量分列，两者互不覆盖。
 * 不要改为整份写入内存中的列表：画布生成可以在轮次结束之后完成，那时会话已不再持有该轮的列表。
 */
export function appendRunMedia(store: Store, id: RunId, spend: MediaSpend): void {
  store.db
    .query(`UPDATE runs SET media_usage = json_insert(media_usage, '$[#]', json(?)) WHERE id = ?`)
    .run(JSON.stringify(spend), id)
}

/** 没有生成时不含 `media` 键，与 `RunUsage.media` 的约定一致。 */
function mediaOf(raw: string): { media?: MediaSpend[] } {
  const media = readJson<MediaSpend[]>(raw, [], 'runs.media_usage')
  return media.length ? { media } : {}
}

/**
 * Run 收尾。stopReason 必填：不允许没有原因的 done，前端必须能向用户说明
 * 停止原因，不能只显示一个完成标记。
 */
export function finishRun(
  store: Store,
  id: RunId,
  input: {
    status: 'done' | 'failed' | 'interrupted'
    stopReason: StopReason
    errorMessage?: string | null
    errorCode?: string | null
    interruption?: RunInterruption | null
  },
): void {
  store.tx(() => {
    store.db
      .query(
        `UPDATE runs SET status = ?, stop_reason = ?,
       error_message = ?, error_code = ?, interruption_detail = ?, finished_at = ? WHERE id = ?`,
      )
      .run(
        input.status,
        input.stopReason,
        input.errorMessage ?? null,
        input.errorCode ?? null,
        input.interruption ? writeJson(input.interruption) : null,
        Date.now(),
        id,
      )
    // 调用方关闭生成器时同样必须结算请求记录，不等到下次启动时误记为进程退出。
    const diagnostic: ProviderRequestDiagnostic = {
      causes: [
        {
          name: 'RunEnded',
          code: input.stopReason,
          message: '所属轮次已结束，未收到该请求的完整终态；sentAt 为空表示未交给发送阶段。',
        },
      ],
      providerEvents: null,
      silentMs: null,
      transport: null,
      assistantChars: null,
      toolCallCount: null,
      retry: { decision: 'run_ended', attempt: null, max: 0, backoffMs: null, at: null },
    }
    store.db
      .query(
        "UPDATE provider_requests SET status = 'uncertain', completed_at = COALESCE(completed_at, ?), diagnostic = COALESCE(diagnostic, ?) WHERE run_id = ? AND status IN ('pending','in_flight')",
      )
      .run(Date.now(), writeJson(diagnostic), id)
  })
}

export interface ProcessExitObservation {
  source: 'desktop_sidecar'
  observedAt: number
  exitKind: 'terminated' | 'output_channel_closed'
  exitCode: number | null
  signal: number | null
  stderrTail: string | null
}

/**
 * 启动时回收上次进程留下的 running / queued run。
 *
 * 不能依赖进程内的 finally：`finally` 只在生成器正常关闭时执行，
 * SIGKILL、断电、Tauri 外壳崩溃时不会执行。遗留的 running run 会使
 * 会话始终显示「执行中」，且 `isBusy` 判定会拒绝用户发送新消息，会话被永久锁死。
 *
 * 分流依据是 step 的 `execution_started_at`（ARCHITECTURE.md 第 6 节的歧义边界），
 * 不是 run 上的字段：
 *
 * - 存在 `execution_started_at` 非空而 status 仍为 running 的 step：
 *   已进入执行器但未进入终态。该工具可能已执行完毕并产生副作用，
 *   也可能刚进入就崩溃，两者无法区分，因此整轮结果不可信。
 * - 不存在这样的 step：所有工具要么未开始，要么已有确定结果，本轮没有未知副作用。
 *
 * 两者都标记为终态，区别在 `stopReason`。不要为了界面简洁统一写成 user_interrupt：
 * 否则事后无法区分进程崩溃与用户停止。
 *
 * 判据只有一个：steps 表中带 `execution_started_at` 的 running 行。
 * 不要为 `runs` 另加 `execution_state` 等列：以没有写入方的列作为判据，
 * 会使所有 run 都被判定为可安全重放，即最危险的方向。
 *
 * 只回收无进程运行的 run，不能扫描全库：账本是共享的，一台机器上同时有多个写入者（两个工作
 * 区的 sidecar、开发态热重载、终端中的 `qy exec`），扫描全库会使后启动的进程把其他进程正在运行的轮次
 * 判定为中断。判据见 `isOrphan`，两个信号缺一不可。
 */
export function recoverStaleRuns(
  store: Store,
  previousExit?: ProcessExitObservation,
): {
  recovered: number
  ambiguous: number
  /** 有归属且归属进程仍在运行、本次跳过的 run 数。启动日志必须输出该数，否则「回收了 0 个」有歧义。 */
  heldByOthers: number
} {
  // 该查询取的是投影而不是表行：列名经过重命名，`ambiguous` 是计算列，
  // 因此行类型就地声明，不复用表的行类型。
  const all = store.db
    .query<
      { id: RunId; ownerPid: number | null; heartbeatAt: number | null; ambiguous: number },
      []
    >(
      `SELECT r.id AS id, r.owner_pid AS ownerPid, r.heartbeat_at AS heartbeatAt,
              EXISTS (
                SELECT 1 FROM steps s
                WHERE s.run_id = r.id
                  AND s.execution_started_at IS NOT NULL
                  AND s.status = 'running'
              ) AS ambiguous
       FROM runs r
       WHERE r.status IN ('running','queued')`,
    )
    .all()

  const rows = all.filter((r) => isOrphan(r.ownerPid, r.heartbeatAt))
  const heldByOthers = all.length - rows.length

  // 不能在此处提前返回。下方还有一次针对终态 run 下孤儿 step 的扫描，
  // 该扫描与本次是否有遗留 run 无关，最常见的情形正是
  // run 均已进入终态而其下仍有 running step。提前返回会使该扫描不执行。
  let ambiguous = 0
  const now = Date.now()
  const finishStmt = store.db.query(
    `UPDATE runs SET status = 'interrupted', stop_reason = ?, error_code = ?, error_message = ?,
     interruption_detail = ?, finished_at = ? WHERE id = ?`,
  )

  // 使用 `store.tx()` 而不是 `db.transaction`：此段先 SELECT 再 UPDATE，DEFERRED 事务
  // 在其他进程持有写锁时需从读事务升级，SQLite 直接返回 SQLITE_BUSY 且不经过 busy_timeout。
  // 两个实例同时启动是正常情形（两个工作区的 sidecar、开发态热重载）。
  store.tx(() => {
    for (const r of rows) {
      const isAmbiguous = Number(r.ambiguous) === 1
      if (isAmbiguous) ambiguous++
      settleRunningSteps(store, r.id)
      interruptRunningNodes(store, r.id)
      /*
       * 进程退出时已发出的 provider 请求，送达与计费都无法确认。run 收尾时必须
       * 同步写为 uncertain；保持 in_flight 会使账本始终显示后台仍在执行。
       * usage 保持原样（通常为 NULL），不得补 0 或用上一条回报填充。
       */
      const interruption: RunInterruption = {
        source: previousExit?.source ?? 'orphan_recovery',
        observedAt: previousExit?.observedAt ?? now,
        recordedAt: now,
        ownerPid: r.ownerPid,
        lastHeartbeatAt: r.heartbeatAt,
        ...(previousExit
          ? {
              exitKind: previousExit.exitKind,
              exitCode: previousExit.exitCode,
              signal: previousExit.signal,
              stderrTail: previousExit.stderrTail,
            }
          : {}),
        ambiguousToolExecution: isAmbiguous,
      }
      const requestDiagnostic: ProviderRequestDiagnostic = {
        causes: [],
        providerEvents: null,
        silentMs: null,
        transport: null,
        assistantChars: null,
        toolCallCount: null,
        // 进程已退出，不存在剩余重发次数；0 表示恢复流程不发送请求。
        retry: { decision: 'process_exit', attempt: null, max: 0, backoffMs: null, at: null },
      }
      store.db
        .query(
          `UPDATE provider_requests
           SET status = 'uncertain', completed_at = COALESCE(completed_at, ?),
               diagnostic = COALESCE(diagnostic, ?)
           WHERE run_id = ? AND status IN ('pending','in_flight')`,
        )
        .run(now, writeJson(requestDiagnostic), r.id)
      finishStmt.run(
        // 无歧义的情形写 `process_exit`，不写 `user_interrupt`：写成 user_interrupt 后
        // 事后无法区分进程崩溃与用户停止，
        // 界面只显示「已中断」，而用户并未停止。
        isAmbiguous ? 'internal_guard' : 'process_exit',
        isAmbiguous ? 'internal_error' : null,
        // 无歧义的情形不能写「本轮未开始执行」：判据只说明没有工具停留在执行中，
        // 已执行几十步、恰好在等待模型回复时中断的 run 同样满足该判据。
        isAmbiguous
          ? previousExit?.exitCode !== null && previousExit?.exitCode !== undefined
            ? `服务进程在工具执行期间退出（exit code ${previousExit.exitCode}），结果不可信`
            : '服务进程在工具执行期间退出，结果不可信'
          : previousExit?.exitCode !== null && previousExit?.exitCode !== undefined
            ? `服务进程退出（exit code ${previousExit.exitCode}），本轮中断`
            : '服务进程退出，本轮中断',
        writeJson(interruption),
        now,
        r.id,
      )
    }

    // 终态 run 下同样可能遗留孤儿 step。上方的扫描按 run 状态选取，不包含这些 step。
    //
    // 产生路径：生成器在 `tool.started` 的 yield 处被 `.return()` 终止
    // （客户端断开、用户切换会话），step 已由 openToolStep 写为 running 但无人收尾；
    // 随后 session 的 finally 把 run 标记为 interrupted 终态。因此该 step
    // 不会进入恢复流程，在库中永久保持 running。
    //
    // 影响不限于界面上一张持续显示加载状态的卡片：历史投影必须跳过含未终结调用的整个
    // batch（provider 要求每个 tool call 有配对结果），一条孤儿 step 会使同一批次中
    // 已成功的写文件结果一并从历史中移除，中断过的轮次在跨轮记忆中
    // 因此缺失这些结果。
    //
    // 派发任务卡上未进入终态的节点同理，且没有对应的 running step：派发后立即返回，
    // 子 agent 的生命周期与会话一致，其终态写在一张早已返回的卡上。重启之后
    // 进程中已无接收方处理该回执，节点停留在「进行中」时，该图既无法 approve
    // 也无法 revise。
    //
    // 节点只回收归属进程已不在运行的 run：卡上节点的终态由该 run 的归属进程在子 agent 完成时写入。
    // 不检查归属时，共用账本的任一进程启动都会把其他进程中仍在执行的节点写为中断。
    const orphanRuns = store.db
      .query<{ run_id: string; ownerPid: number | null }, []>(
        `SELECT DISTINCT s.run_id AS run_id, r.owner_pid AS ownerPid FROM steps s
         JOIN runs r ON r.id = s.run_id
         WHERE r.status NOT IN ('running','queued')
           AND (s.status = 'running'
                OR (json_type(s.payload, '$.nodes') = 'object'
                    AND EXISTS (
                      SELECT 1 FROM json_each(s.payload, '$.nodes') n
                      WHERE json_extract(n.value, '$.phase')
                            NOT IN ('done','failed','skipped','interrupted')
                    )))`,
      )
      .all()
    for (const o of orphanRuns) {
      settleRunningSteps(store, o.run_id as RunId)
      if (!ownerAlive(o.ownerPid)) interruptRunningNodes(store, o.run_id as RunId)
    }

    // 与上方的孤儿 step 同理：账本中可能存在 run 已收尾而已发送请求未写入终态的记录。
    // 终态 run 不可能合法地持有 in_flight 请求，只能按送达未知写为 uncertain。
    const orphanRequestDiagnostic: ProviderRequestDiagnostic = {
      causes: [],
      providerEvents: null,
      silentMs: null,
      transport: null,
      assistantChars: null,
      toolCallCount: null,
      retry: { decision: 'run_ended', attempt: null, max: 0, backoffMs: null, at: null },
    }
    store.db
      .query(
        `UPDATE provider_requests SET status = 'uncertain', completed_at = COALESCE(completed_at, ?),
             diagnostic = COALESCE(diagnostic, ?)
         WHERE status IN ('pending','in_flight')
           AND run_id IN (SELECT id FROM runs WHERE status NOT IN ('running','queued'))`,
      )
      .run(now, writeJson(orphanRequestDiagnostic))
  })

  return { recovered: rows.length, ambiguous, heldByOthers }
}

/** 心跳超过该时长未更新时，视为对应进程已不再运行该 run。心跳间隔为十秒，此值留六倍余量。 */
const HEARTBEAT_STALE_MS = 60_000

/**
 * 该 run 是否仍有进程在运行。
 *
 * 四条判据的顺序不可调换，每一条覆盖前一条的遗漏：
 *
 * 1. 没有归属：迁移之前的历史行。按原有规则回收，不能因无法识别而跳过。
 * 2. 归属是本进程的 pid：本进程刚启动，不可能拥有任何 run，因此该行必然是
 *    上一个进程留下的，且 Windows 把同一个 pid 复用给了本进程。本条必须在心跳判据之前：
 *    崩溃后立即重启时心跳只过去两三秒，按超时判定会认为它仍在运行，
 *    该 run 因此无人回收，会话被永久锁死。
 * 3. 该 pid 已不存在：进程已退出，回收。这是本函数的基本用途，不能弱化。
 *    `EPERM` 视为存活：宁可晚一分钟由心跳判据回收，也不误回收确实在运行的 run。
 * 4. pid 仍存在但心跳停止：pid 被复用，或该进程仍在但该轮已废弃。
 *
 * pid 判据只会因 pid 复用而误判，心跳判据只会因崩溃后立即重启而误判，因此两者都必须保留。
 */
function isOrphan(ownerPid: unknown, heartbeatAt: unknown): boolean {
  if (!ownerAlive(ownerPid)) return true
  const beat = Number(heartbeatAt)
  return !Number.isFinite(beat) || Date.now() - beat > HEARTBEAT_STALE_MS
}

/**
 * 归属进程是否仍在运行：`isOrphan` 的前三条判据，不含心跳。
 *
 * 终态 run 不再更新心跳（`touchRun`），判断其派发任务卡上的节点是否仍有进程处理时只能使用本函数。
 * pid 被复用时会判为存活，该卡上的节点推迟到之后某次启动时回收。
 */
function ownerAlive(ownerPid: unknown): boolean {
  const pid = Number(ownerPid)
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && pidAlive(pid)
}

function pidAlive(pid: number): boolean {
  try {
    // 信号 0 不投递信号，只做存在性与权限检查。
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

export function listRuns(store: Store, conversationId: ConversationId): Run[] {
  return store.db
    .query<RunRow, [string]>(
      'SELECT * FROM runs WHERE conversation_id = ? ORDER BY created_at ASC, id ASC',
    )
    .all(conversationId)
    .map(rowToRun)
}

/**
 * runtime 重建模型历史所需的内部快照。公开的 `Run` 有意不含该输入，避免 UI/API
 * 把内部上下文误认为可编辑的 run 属性。
 */
export function listRunContextSnapshots(
  store: Store,
  conversationId: ConversationId,
): { runId: RunId; userMessageId: MessageId | null; segments: RunContextSegment[] }[] {
  return store.db
    .query<Pick<RunRow, 'id' | 'user_message_id' | 'context_snapshot'>, [string]>(
      `SELECT id, user_message_id, context_snapshot
       FROM runs
       WHERE conversation_id = ?
       ORDER BY created_at ASC, id ASC`,
    )
    .all(conversationId)
    .map((row) => ({
      runId: row.id,
      userMessageId: row.user_message_id,
      segments: readJson(row.context_snapshot, [], 'runs.context_snapshot'),
    }))
}

/** 只在包内使用：历史页（`messages.ts`）按同一份映射读取 run 行。 */
export function rowToRun(r: RunRow): Run {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    workspaceId: r.workspace_id,
    userMessageId: r.user_message_id,
    messageIdUpperBound: r.message_id_upper_bound,
    model: r.model,
    clientRequestId: r.client_request_id,
    status: r.status,
    stopReason: r.stop_reason,
    usage: {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      // 直接透传 null，不要写 ?? 0，理由见 `RunRow.cached_tokens` 的注释。
      cachedTokens: r.cached_tokens,
      cacheWriteTokens: r.cache_write_tokens,
      reasoningTokens: r.reasoning_tokens,
      cost: r.cost,
      currency: r.currency,
      turns: readJson(r.usage_turns, [], 'runs.usage_turns'),
      ...mediaOf(r.media_usage),
    },
    stepCount: r.step_count,
    errorMessage: r.error_message,
    errorCode: r.error_code,
    interruption: readJson(r.interruption_detail, null, 'runs.interruption_detail'),
    dispatchStepId: r.dispatch_step_id,
    dispatchNodeId: r.dispatch_node_id,
    createdAt: r.created_at,
    finishedAt: r.finished_at,
  }
}
