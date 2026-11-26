/**
 * `steps` 表的读写：追加与原地收尾、派发任务卡的节点状态，以及中断与回收时的终态写入。
 */

import {
  type AgentEvent,
  type ConversationId,
  type FileChange,
  type NodePhase,
  type NodeState,
  newStepId,
  type RunId,
  type Step,
  type StepId,
  type StepPayload,
  type ToolActionStatus,
} from '@qywork/core'
import type { ContentStore } from '../content.ts'
import { readJson, type Store, writeJson } from '../db.ts'
import type { StepRow } from '../rows.ts'
import { hasImageBytes, storeToolImages } from '../tool-images.ts'

export function appendStep(
  store: Store,
  input: {
    runId: RunId
    seq: number
    kind: Step['kind']
    toolName?: string | null
    toolCallId?: string | null
    providerBatchId?: string | null
    callIndex?: number | null
    executionWaveIndex?: number | null
    content?: string | null
    payload?: Step['payload']
    status?: Step['status']
  },
): Step {
  const step: Step = {
    id: newStepId(),
    runId: input.runId,
    seq: input.seq,
    kind: input.kind,
    toolName: input.toolName ?? null,
    toolCallId: input.toolCallId ?? null,
    providerBatchId: input.providerBatchId ?? null,
    callIndex: input.callIndex ?? null,
    executionWaveIndex: input.executionWaveIndex ?? null,
    executionStartedAt: null,
    durationMs: null,
    content: input.content ?? null,
    payload: input.payload ?? null,
    status: input.status ?? 'done',
    createdAt: Date.now(),
  }
  store.db
    .query(
      `INSERT INTO steps (id, run_id, seq, kind, tool_name, tool_call_id, provider_batch_id,
       call_index, execution_wave_index, execution_started_at, content, payload, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      step.id,
      step.runId,
      step.seq,
      step.kind,
      step.toolName,
      step.toolCallId,
      step.providerBatchId,
      step.callIndex,
      step.executionWaveIndex,
      null,
      step.content,
      writeJson(step.payload),
      step.status,
      step.createdAt,
    )
  store.db.query('UPDATE runs SET step_count = step_count + 1 WHERE id = ?').run(input.runId)
  return step
}

/** 开始、进度与结束更新同一条压缩记录，刷新时直接从 steps 恢复。 */
export function recordCompactionStep(
  store: Store,
  runId: RunId,
  seq: number,
  payload: Extract<NonNullable<Step['payload']>, { kind: 'compaction' }>,
): void {
  const status =
    payload.phase === 'started' ? 'running' : payload.phase === 'done' ? 'success' : 'failure'
  const existing = store.db
    .query<{ id: string }, [string, number]>(
      "SELECT id FROM steps WHERE run_id = ? AND seq = ? AND kind = 'compaction'",
    )
    .get(runId, seq)
  if (existing) {
    store.db
      .query('UPDATE steps SET status = ?, payload = ? WHERE id = ?')
      .run(status, writeJson(payload), existing.id)
  } else {
    appendStep(store, { runId, seq, kind: 'compaction', status, payload })
  }
}

/**
 * 标记工具即将执行。
 *
 * 必须在调用执行器之前单独提交：该时间戳是崩溃恢复的歧义边界。
 * 有该时间戳表示可能已执行（不可重放）；没有表示确定未执行（可安全重放）。
 */
export function markStepExecuting(store: Store, id: StepId): void {
  store.db.query('UPDATE steps SET execution_started_at = ? WHERE id = ?').run(Date.now(), id)
}

const SETTLED_PHASES: ReadonlySet<NodePhase> = new Set(['done', 'failed', 'skipped', 'interrupted'])

/**
 * 将派发任务卡上一个节点的状态写回工具 step（`$.nodes.<nodeId>`）。
 *
 * 每次变化立即写入，不等待 `settleToolStep`：用户可能在子 agent 运行期间离开父会话，
 * 返回时从账本重建卡片，此时运行期的 `team.member` 事件已经错过。
 *
 * 不限制卡的状态：一个节点失败后卡先返回父会话，其余节点照常运行，
 * 它们的终态仍写在派发它们的卡上。
 *
 * 整条替换该节点的状态，与界面按 `team.member` 逐个节点替换一致。先以 null 删除旧键再写入：
 * `json_patch` 是逐字段合并，直接写入时上一状态的字段（如中断留下的 `error`）会残留在新状态中。
 *
 * 节点 id 由模型给出，可能含点号或方括号，因此用 `json_object` 构造键再以 `json_patch` 写入。
 * 不要改为把 id 拼接到 JSON 路径字符串中：这类 id 会被解释为路径分隔符。
 */
export function setStepNodeState(store: Store, id: StepId, nodeId: string, state: NodeState): void {
  store.db
    .query(
      `UPDATE steps
       SET payload = json_set(
             coalesce(payload, '{}'),
             '$.nodes',
             json_patch(
               json_patch(
                 coalesce(json_extract(payload, '$.nodes'), json('{}')),
                 json_object(?, NULL)
               ),
               json_object(?, json(?))
             )
           )
       WHERE id = ? AND kind = 'tool_action'`,
    )
    .run(nodeId, nodeId, JSON.stringify(state), id)
}

type ToolResultPayload = Extract<StepPayload, { kind: 'tool_result' }>

/**
 * 一次调用一行，原地从 running 更新到终态；不产生第二行。
 *
 * 结果中的图像字节在此写入正文库，payload 只存引用（见 `tool-images.ts`）。这是工具结果写入账本的
 * 唯一入口，带图像字节的结果必须提供正文库，未提供时抛出，不写入字节。
 *
 * 返回写入的 payload。本轮的工具消息由它生成（`agent` 的 `LoopPersistence.settleTool`），与重建历史出自同一份记录。
 */
export function settleToolStep(
  store: Store,
  id: StepId,
  status: ToolActionStatus,
  payload: ToolResultPayload,
  /**
   * 本次调用的执行时长。由执行方提供，不在此处计算：它度量的是执行器的起止时刻，
   * 而此处只能取得写入时刻。
   */
  durationMs?: number,
  content?: ContentStore,
): ToolResultPayload {
  return store.tx(() => {
    const current = store.db
      .query<{ payload: string | null; run_id: string; tool_name: string | null }, [string]>(
        'SELECT payload, run_id, tool_name FROM steps WHERE id = ?',
      )
      .get(id)
    const before = readJson<Step['payload']>(current?.payload ?? null, null, 'steps.payload')
    const nodes =
      before?.kind === 'tool_call' || before?.kind === 'tool_result' ? before.nodes : undefined
    let settled = nodes ? { ...payload, nodes } : payload
    if (hasImageBytes(settled.outcome.data)) {
      if (!content) throw new Error(`工具结果 ${id} 含图像字节，写入账本需要正文库`)
      if (!current) throw new Error(`未找到执行记录 ${id}`)
      settled = {
        ...settled,
        outcome: {
          ...settled.outcome,
          data: storeToolImages(
            store,
            content,
            { runId: current.run_id, stepId: id, toolName: current.tool_name ?? '' },
            settled.outcome.data as Record<string, unknown>,
          ),
        },
      }
    }
    store.db
      .query('UPDATE steps SET status = ?, payload = ?, duration_ms = ? WHERE id = ?')
      .run(status, writeJson(settled), durationMs ?? null, id)
    return settled
  })
}

/**
 * 把后台命令转入后台之后的文件改动追加到发起它的 step 的 `outcome.fileChanges`，返回实际追加的改动与该 step 所属的 run。
 * step 已不存在（会话已删除）时返回 null；尚未写入结果时抛出异常，不要改为跳过：跳过时改动会静默丢失。
 *
 * 同一会话中该 step 及其后的 step 已报告为新建或修改的路径不再追加：后台观察与转入后台前的窗口在交界处重叠，
 * 与其间打开的观察窗口、文件工具也会观察到同一次改动，重复追加时合计中的行数计入两次。删除照常追加。
 * 调用时 step 已写入结果：`run_command` 返回后 loop 在同一批微任务中写入结果，命令结束后的观察器收尾至少经过一次文件 I/O 回调。
 */
export function appendStepFileChanges(
  store: Store,
  id: StepId,
  changes: FileChange[],
): { runId: RunId; changes: FileChange[] } | null {
  return store.tx(() => {
    const row = store.db
      .query<
        { payload: string | null; run_id: string; conversation_id: string; ord: number },
        [string]
      >(
        `SELECT s.payload, s.run_id, r.conversation_id, s.rowid AS ord
         FROM steps s JOIN runs r ON r.id = s.run_id WHERE s.id = ?`,
      )
      .get(id)
    if (!row) return null
    const payload = readJson<Step['payload']>(row.payload, null, 'steps.payload')
    if (payload?.kind !== 'tool_result')
      throw new Error(`执行记录 ${id} 尚未写入结果，无法追加文件改动`)
    const reported = new Set(
      store.db
        .query<{ path: string }, [string, number]>(
          `SELECT DISTINCT json_extract(c.value, '$.path') AS path
           FROM runs r JOIN steps s ON s.run_id = r.id
           JOIN json_each(s.payload, '$.outcome.fileChanges') c
           WHERE r.conversation_id = ? AND s.rowid >= ?
             AND json_extract(c.value, '$.changeType') != 'deleted'`,
        )
        .all(row.conversation_id, row.ord)
        .map((r) => r.path),
    )
    const appended = changes.filter((c) => c.changeType === 'deleted' || !reported.has(c.path))
    if (appended.length > 0) {
      store.db
        .query(
          `UPDATE steps SET payload = json_set(payload, '$.outcome.fileChanges', json(?)) WHERE id = ?`,
        )
        .run(JSON.stringify([...(payload.outcome.fileChanges ?? []), ...appended]), id)
    }
    return { runId: row.run_id as RunId, changes: appended }
  })
}

/**
 * 将一次尝试留下的思考 step 写为失败终态。
 *
 * 供轮内自动重发使用。思考 step 创建时即为 `done`，而 `settleRunningSteps` 只处理 `running`，
 * 因此无法覆盖这类 step。
 *
 * 不删除：这些 step 确实发生过，且已逐 delta 渲染给用户；
 * 删除会使已渲染的思考从界面上消失。标记 `failure` 供投影侧使用：
 * `stepsToUnits` 据此把失败尝试的思考排除在模型视图之外，
 * 否则它会与重发尝试的思考拼接成一条回传给 provider。
 */
export function failThinkingSteps(store: Store, ids: StepId[]): void {
  if (ids.length === 0) return
  const marks = ids.map(() => '?').join(',')
  store.db
    .query(`UPDATE steps SET status = 'failure' WHERE kind = 'thinking' AND id IN (${marks})`)
    .run(...ids)
}

/**
 * 将同一会话中这些工具调用的 step 标记为图片未送达（payload 的 `imagesUndelivered`），返回被标记的 step id。
 *
 * `runId` 只用于限定会话：调用可能属于该会话的上一个 run。只标记已有结果的行。
 */
export function markImagesUndelivered(store: Store, runId: RunId, toolCallIds: string[]): StepId[] {
  if (toolCallIds.length === 0) return []
  const marks = toolCallIds.map(() => '?').join(',')
  return store.tx(() => {
    const rows = store.db
      .query<{ id: string; payload: string | null }, string[]>(
        `SELECT s.id, s.payload FROM steps s JOIN runs r ON r.id = s.run_id
         WHERE r.conversation_id = (SELECT conversation_id FROM runs WHERE id = ?)
           AND s.kind = 'tool_action' AND s.tool_call_id IN (${marks})`,
      )
      .all(runId, ...toolCallIds)
    const marked: StepId[] = []
    for (const row of rows) {
      const payload = readJson<Step['payload']>(row.payload, null, 'steps.payload')
      if (payload?.kind !== 'tool_result') continue
      store.db
        .query('UPDATE steps SET payload = ? WHERE id = ?')
        .run(writeJson({ ...payload, imagesUndelivered: true }), row.id)
      marked.push(row.id as StepId)
    }
    return marked
  })
}

/**
 * 会话中是否有「接口拒绝了包含图片的请求」的执行事实，且接口与模型与给定的相同
 * （user step payload 的 `imagesRejected`）。
 */
export function conversationRejectsImages(
  store: Store,
  conversationId: ConversationId,
  provider: string,
  model: string,
): boolean {
  return hasRejectionFact(store, conversationId, 'imagesRejected', provider, model)
}

/** 同 `conversationRejectsImages`，执行事实是「接口拒绝了包含视频的请求」（payload 的 `videosRejected`）。 */
export function conversationRejectsVideos(
  store: Store,
  conversationId: ConversationId,
  provider: string,
  model: string,
): boolean {
  return hasRejectionFact(store, conversationId, 'videosRejected', provider, model)
}

function hasRejectionFact(
  store: Store,
  conversationId: ConversationId,
  field: 'imagesRejected' | 'videosRejected',
  provider: string,
  model: string,
): boolean {
  return (
    store.db
      .query<{ one: number }, [string, string, string]>(
        `SELECT 1 AS one FROM steps s JOIN runs r ON r.id = s.run_id
         WHERE r.conversation_id = ? AND s.kind = 'user'
           AND json_extract(s.payload, '$.${field}.provider') = ?
           AND json_extract(s.payload, '$.${field}.model') = ?
         LIMIT 1`,
      )
      .get(conversationId, provider, model) !== null
  )
}

export function appendTextToStep(store: Store, id: StepId, text: string): void {
  store.db.query("UPDATE steps SET content = COALESCE(content,'') || ? WHERE id = ?").run(text, id)
}

/**
 * 该轮是否有已进入执行器而未结束的工具调用。与启动时回收（`recoverStaleRuns`）同一判据。
 *
 * 只读状态列，不解析 payload：它在一轮的收尾路径上决定终态，payload 损坏时也必须能给出结果，
 * 否则 run 行停留在 running。
 */
export function stepInExecution(store: Store, runId: RunId): boolean {
  return (
    store.db
      .query<{ hit: number }, [string]>(
        `SELECT EXISTS (
           SELECT 1 FROM steps
           WHERE run_id = ? AND status = 'running' AND execution_started_at IS NOT NULL
         ) AS hit`,
      )
      .get(runId)?.hit === 1
  )
}

/**
 * 将一个 run 下所有仍为 running 的 step 写为终态。
 *
 * 分两种情形处理，不能合并。判据是 `execution_started_at`，即崩溃恢复的歧义边界：
 *
 * - 非空：已进入执行器。工具可能已执行完毕并产生副作用，也可能刚进入就崩溃，
 *   两者无法区分。因此写 `executed: true`（保守假设已执行）与「结果未知」。
 *   向模型断言未执行等于要求它重做；若该工具是 `write_file` 或 `run_command`，
 *   会产生重复副作用。
 * - 为空：未进入执行器。这是确定未发生的事，如实标记 `executed: false`。
 *   同样写成「结果未知」会使模型在每次中断后都用一轮核实所有工具，
 *   包括明显未执行的工具。
 *
 * 两种情形必须分别 UPDATE：用同一份 payload 一并覆盖时，「确定未执行」会被记为
 * 「可能执行过」。
 *
 * 只写入 outcome，不得整份替换 payload。两条语句都使用 `json_set`，只修改 `$.kind` 与 `$.outcome`；
 * `$.action` 与 `$.args` 保持不变。`action` 是前端唯一的标题来源（它由 ToolSpec 按参数
 * 解析，前端无法推测）；整份 payload 替换为只含 outcome 的对象后，该 step 在会话流中
 * 只显示一个红色的「失败」，没有动词、对象与目标，用户无法判断中断发生在哪一步。
 *
 * payload 不是合法 JSON 的行先只写状态、payload 原样保留：`json_set` 对它抛出异常，整条语句随之失败。
 */
export function settleRunningSteps(store: Store, runId: RunId): void {
  store.db
    .query(
      `UPDATE steps SET status = 'failure'
       WHERE run_id = ? AND status = 'running' AND NOT json_valid(coalesce(payload, '{}'))`,
    )
    .run(runId)
  store.db
    .query(
      `UPDATE steps SET status = 'failure',
         payload = json_set(payload, '$.phase', 'failed', '$.reasonCode', 'aborted')
       WHERE run_id = ? AND kind = 'compaction' AND status = 'running'`,
    )
    .run(runId)
  const settle = (executionStarted: boolean, outcome: Record<string, unknown>) =>
    store.db
      .query(
        `UPDATE steps
         SET status = 'failure',
             payload = json_set(coalesce(payload, '{}'), '$.kind', 'tool_result', '$.outcome', json(?))
         WHERE run_id = ? AND status = 'running'
           AND execution_started_at IS ${executionStarted ? 'NOT NULL' : 'NULL'}`,
      )
      .run(JSON.stringify(outcome), runId)

  settle(true, {
    status: 'failure',
    executed: true,
    message: '执行期间被中断，结果未知',
    errorKind: 'interrupted',
    resultState: 'unknown',
  })
  settle(false, {
    status: 'failure',
    executed: false,
    message: '未开始执行即被中断',
    errorKind: 'interrupted',
  })
}

/**
 * `settleRunningSteps` 改写过的工具行对应的结束事件。收尾发生在会话的生成器关闭之后，此时已无法经事件流发出；
 * 调用方在本轮结束后发布这些事件，界面上的状态与刷新后一致。不要改为由界面在轮次结束时自行把运行中的行记为失败：
 * 那会在界面上另立一份收尾规则，与账本中的结果不一致。
 */
export function settledToolEvents(
  store: Store,
  runId: RunId,
): Extract<AgentEvent, { type: 'tool.finished' }>[] {
  return listSteps(store, runId).flatMap((step) => {
    const payload = step.payload
    if (step.kind !== 'tool_action' || payload?.kind !== 'tool_result') return []
    if (payload.outcome.errorKind !== 'interrupted') return []
    return [
      {
        type: 'tool.finished' as const,
        runId,
        stepId: step.id,
        toolCallId: step.toolCallId ?? '',
        status: 'failure' as const,
        outcome: payload.outcome,
        durationMs: step.durationMs ?? 0,
      },
    ]
  })
}

/**
 * 传给 SQLite JSON 函数的 payload 表达式：`column` 为合法 JSON 时取其值，否则为 NULL。
 * JSON 函数对不合法的 JSON 抛出异常，一行损坏的 payload 会使整条语句失败；经本表达式后该行按没有该字段处理。
 * 用 `CASE` 而不是在 WHERE 中并列 `json_valid(...) AND`：SQLite 不保证 WHERE 各项的求值顺序。
 */
export function validPayload(column: string): string {
  return `CASE WHEN json_valid(${column}) THEN ${column} END`
}

/**
 * 将该轮派发任务卡上未进入终态的节点标记为中断，返回改动过的节点。
 *
 * 不在 run 收尾时调用。子 agent 的生命周期与会话一致，不随派发它的轮次结束：
 * 收尾时扫描会把仍在运行的节点记为中断，而其回执数分钟后才到达。
 * 调用点只有两处：用户停止会话，以及重启回收（进程中已无接收方处理这些回执）。
 *
 * 不限于仍为 running 的卡：派发后立即返回，节点的终态写在一张已返回的卡上。
 *
 * `stopping` 是本次已停止、仍在退出的子 agent 会话 id。执行它们的节点不在此处改写，
 * 由其完成回调写入终态：提前写入时账本显示已结束而子 agent 仍在执行，此期间的修订会再次派发它。
 */
export function interruptRunningNodes(
  store: Store,
  runId: RunId,
  stopping?: ReadonlySet<string>,
): { stepId: string; nodeId: string; state: NodeState }[] {
  const cards = store.db
    .query<{ id: string; payload: string }, [string]>(
      `SELECT id, payload FROM steps
       WHERE run_id = ? AND json_type(${validPayload('payload')}, '$.nodes') = 'object'`,
    )
    .all(runId)
  const changed: { stepId: string; nodeId: string; state: NodeState }[] = []
  for (const card of cards) {
    const payload = JSON.parse(card.payload) as { nodes: Record<string, NodeState> }
    let dirty = false
    for (const [nodeId, state] of Object.entries(payload.nodes)) {
      if (SETTLED_PHASES.has(state.phase)) continue
      if (state.phase === 'working' && state.subagentId && stopping?.has(state.subagentId)) continue
      const next: NodeState = { ...state, phase: 'interrupted', error: '调用中断' }
      payload.nodes[nodeId] = next
      changed.push({ stepId: card.id, nodeId, state: next })
      dirty = true
    }
    if (!dirty) continue
    store.db
      .query('UPDATE steps SET payload = ? WHERE id = ?')
      .run(JSON.stringify(payload), card.id)
  }
  return changed
}

export function listSteps(store: Store, runId: RunId): Step[] {
  return store.db
    .query<StepRow, [string]>('SELECT * FROM steps WHERE run_id = ? ORDER BY seq ASC')
    .all(runId)
    .map(rowToStep)
}

/** 读取一条 step。它不属于该会话（按所属 run 判定）或不存在时返回 null。 */
export function getConversationStep(
  store: Store,
  conversationId: ConversationId,
  id: StepId,
): Step | null {
  const row = store.db
    .query<StepRow, [string, string]>(
      'SELECT s.* FROM steps s JOIN runs r ON r.id = s.run_id WHERE s.id = ? AND r.conversation_id = ?',
    )
    .get(id, conversationId)
  return row ? rowToStep(row) : null
}

/** 只在包内使用：历史页（`messages.ts`）按同一份映射读取 step 行。 */
export function rowToStep(r: StepRow): Step {
  return {
    id: r.id,
    runId: r.run_id,
    seq: r.seq,
    kind: r.kind,
    toolName: r.tool_name,
    toolCallId: r.tool_call_id,
    providerBatchId: r.provider_batch_id,
    callIndex: r.call_index,
    executionWaveIndex: r.execution_wave_index,
    executionStartedAt: r.execution_started_at,
    durationMs: r.duration_ms,
    content: r.content,
    payload: readJson(r.payload, null, 'steps.payload'),
    status: r.status,
    createdAt: r.created_at,
  }
}
