/**
 * `messages` 表的读写，以及以用户消息为分页单位的会话读取：历史页与变更页。
 */

import {
  type ConversationChangeStep,
  type ConversationChangesPageResponse,
  type ConversationHistoryPage,
  type ConversationId,
  type FileChange,
  foldFileChanges,
  type Message,
  type MessageId,
  newMessageId,
  type Step,
} from '@qywork/core'
import { readJson, type Store, writeJson } from '../db.ts'
import type { MessageRow, RunRow, StepRow } from '../rows.ts'
import { latestTodos } from '../todos.ts'
import { rowToRun } from './runs.ts'
import { rowToStep } from './steps.ts'

export function appendMessage(
  store: Store,
  input: {
    conversationId: ConversationId
    role: Message['role']
    content: string
    attachments?: Message['attachments']
    /** 缺失表示用户本人发送，写入 NULL。见 `Message.origin`。 */
    origin?: 'subagent' | 'workflow' | 'command'
  },
): Message {
  const msg: Message = {
    id: newMessageId(),
    conversationId: input.conversationId,
    role: input.role,
    content: input.content,
    attachments: input.attachments ?? [],
    origin: input.origin ?? null,
    createdAt: Date.now(),
  }
  store.db
    .query(
      'INSERT INTO messages (id, conversation_id, role, content, attachments, origin, created_at) VALUES (?,?,?,?,?,?,?)',
    )
    .run(
      msg.id,
      msg.conversationId,
      msg.role,
      msg.content,
      writeJson(msg.attachments),
      msg.origin,
      msg.createdAt,
    )
  /*
   * 会话的最近修改时间随消息推进，这是它唯一因内容而推进的位置：该表只有
   * user 行（assistant 的回合由 steps 投影），因此每条新消息都经过此处。
   * 不推进时，列表排序与侧栏时间都停留在会话创建时刻。
   */
  store.db
    .query('UPDATE conversations SET updated_at = ? WHERE id = ?')
    .run(msg.createdAt, msg.conversationId)
  return msg
}

/**
 * 读取会话历史。
 *
 * `upperBound` 是 run 创建时固定的消息上界：执行锁在 run 创建之后才取得，
 * 排队期间用户可能又发送了消息，这些消息不属于本 run 的历史，
 * 纳入后模型会取得本轮之后才发送的消息。
 */
export function listMessages(
  store: Store,
  conversationId: ConversationId,
  upperBound?: MessageId | null,
): Message[] {
  const rows = upperBound
    ? store.db
        .query<MessageRow, [string, string]>(
          'SELECT * FROM messages WHERE conversation_id = ? AND id <= ? ORDER BY id ASC',
        )
        .all(conversationId, upperBound)
    : store.db
        .query<MessageRow, [string]>(
          'SELECT * FROM messages WHERE conversation_id = ? ORDER BY id ASC',
        )
        .all(conversationId)
  return rows.map(rowToMessage)
}

/**
 * 早于 `before` 的全部用户输入，按会话流中的先后排列。
 *
 * 用户输入有两个存放位置，与界面折叠会话流时的两个来源一一对应：发起轮次的输入是 `messages` 行，
 * 运行中途追加的输入是该轮 run 下 `kind='user'` 的 step。回执（origin 非空）与提供给模型的
 * 执行事实（`notice`）不是用户输入；正文为空的追加输入界面不渲染，此处同样不计入。
 * 只取正文开头：索引条目只显示一行标题。
 */
function listTurnsBefore(
  store: Store,
  conversationId: ConversationId,
  before: string,
): ConversationHistoryPage['earlierTurns'] {
  const messages = store.db
    .query<
      { id: MessageId; text: string; attachments: string | null; origin: string | null },
      [string, string]
    >(
      `SELECT id, substr(content, 1, 240) AS text, attachments, origin FROM messages
       WHERE conversation_id = ? AND id < ?
       ORDER BY id ASC`,
    )
    .all(conversationId, before)
  // 回复取该输入之后、下一条用户输入之前的第一段正文，与界面对已加载条目的取法相同。
  const steps = store.db
    .query<{ id: string; kind: 'user' | 'text'; text: string; message: string }, [string, string]>(
      `SELECT s.id, s.kind, substr(s.content, 1, 360) AS text, r.user_message_id AS message
       FROM steps s JOIN runs r ON r.id = s.run_id
       WHERE r.conversation_id = ? AND r.user_message_id < ?
         AND s.content <> ''
         AND (s.kind = 'text' OR (s.kind = 'user'
           AND json_extract(s.payload, '$.origin') IS NULL
           AND COALESCE(json_extract(s.payload, '$.notice'), 0) = 0))
       ORDER BY r.created_at ASC, r.id ASC, s.seq ASC`,
    )
    .all(conversationId, before)
  const byMessage = new Map<string, typeof steps>()
  for (const step of steps) {
    const list = byMessage.get(step.message) ?? []
    list.push(step)
    byMessage.set(step.message, list)
  }
  const turns: ConversationHistoryPage['earlierTurns'] = []
  for (const row of messages) {
    if (row.origin === null) {
      const text =
        row.text.trim() ||
        readJson<{ name: string }[]>(row.attachments, [], 'messages.attachments')
          .map((a) => a.name)
          .join('、')
      turns.push({ id: row.id, text, reply: '' })
    }
    for (const step of byMessage.get(row.id) ?? []) {
      if (step.kind === 'user') turns.push({ id: step.id, text: step.text, reply: '' })
      else {
        const turn = turns.at(-1)
        if (turn && !turn.reply && step.text.trim()) turn.reply = step.text
      }
    }
  }
  return turns
}

/**
 * 为界面读取一页完整的用户轮次。
 *
 * 不要改为分别读取 messages、runs 并为每个 run 读取一次 steps：请求数随轮数线性增长，
 * 浏览器需等待全部请求、解析全部 JSON 并一次挂载整棵 DOM。分页边界与批量读取
 * 由账本层负责：一页只选 `limit` 条用户消息，再一次取齐它们的 run 与 steps。模型重建历史仍使用无分页的 `listMessages` / `buildHistory`，不受影响。
 */
export function listConversationHistoryPage(
  store: Store,
  conversationId: ConversationId,
  input: { before?: MessageId | null; limit: number },
): ConversationHistoryPage {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)))
  const before = input.before ?? null
  const rows = before
    ? store.db
        .query<MessageRow, [string, string, number]>(
          `SELECT * FROM messages
           WHERE conversation_id = ? AND id < ?
           ORDER BY id DESC LIMIT ?`,
        )
        .all(conversationId, before, limit + 1)
    : store.db
        .query<MessageRow, [string, number]>(
          `SELECT * FROM messages
           WHERE conversation_id = ?
           ORDER BY id DESC LIMIT ?`,
        )
        .all(conversationId, limit + 1)

  // 用户轮次的步骤数差异很大：仅限制十条消息仍可能一次返回超过 1000 步。
  // 按已落库的 step_count 收缩本页，始终保留至少一轮且不拆开同一轮的工具记录。
  const candidates = rows.slice(0, limit)
  const counts = candidates.length
    ? store.db
        .query<{ user_message_id: string; steps: number }, string[]>(
          `SELECT user_message_id, SUM(step_count) AS steps FROM runs
           WHERE conversation_id = ? AND user_message_id IN (${candidates.map(() => '?').join(',')})
           GROUP BY user_message_id`,
        )
        .all(conversationId, ...candidates.map((row) => row.id))
    : []
  const byMessage = new Map(counts.map((row) => [row.user_message_id, row.steps]))
  let stepCount = 0
  let take = 0
  for (const row of candidates) {
    const next = stepCount + (byMessage.get(row.id) ?? 0)
    if (take > 0 && next > 200) break
    stepCount = next
    take += 1
  }
  const selected = candidates.slice(0, take)
  const hasMore = rows.length > selected.length
  const oldest = selected.at(-1)?.id ?? null
  const messages = selected.toReversed().map(rowToMessage)

  const userIds = selected.map((row) => row.id)
  const marks = userIds.length ? userIds.map(() => '?').join(',') : 'NULL'
  // 手动压缩没有 user_message_id，按发生时间归入同一分页区间。
  const lowerTime = hasMore ? selected.at(-1)!.created_at : 0
  const upperTime = before
    ? (store.db
        .query<{ created_at: number }, [string, string]>(
          'SELECT created_at FROM messages WHERE conversation_id = ? AND id = ?',
        )
        .get(conversationId, before)?.created_at ?? 0)
    : Number.MAX_SAFE_INTEGER
  const runs = store.db
    .query<RunRow, (string | number)[]>(
      `SELECT * FROM runs
       WHERE conversation_id = ? AND (user_message_id IN (${marks})
         OR (user_message_id IS NULL AND created_at >= ? AND created_at < ?))
       ORDER BY created_at ASC, id ASC`,
    )
    .all(conversationId, ...userIds, lowerTime, upperTime)
    .map(rowToRun)

  const runIds = runs.map((run) => run.id)
  const steps = runIds.length
    ? store.db
        .query<StepRow, string[]>(
          `SELECT s.* FROM steps s
           JOIN runs r ON r.id = s.run_id
           WHERE s.run_id IN (${runIds.map(() => '?').join(',')})
           ORDER BY r.created_at ASC, r.id ASC, s.seq ASC`,
        )
        .all(...runIds)
        .map(rowToStep)
    : []

  // 续接调用引用的首次调用不在本页时一并读取：图结构只记录在首次调用的参数中。只读取本会话的 step。
  const inPage = new Set<string>(steps.map((step) => step.id))
  const wanted = new Set<string>()
  for (const step of steps) {
    if (step.toolName !== 'workflow') continue
    const payload = step.payload
    const workflowId =
      payload?.kind === 'tool_call' || payload?.kind === 'tool_result'
        ? payload.args?.workflowId
        : undefined
    if (typeof workflowId === 'string' && workflowId && !inPage.has(workflowId)) {
      wanted.add(workflowId)
    }
  }
  const workflowStarts = [...wanted].flatMap((id) => {
    const row = store.db
      .query<StepRow, [string, string]>(
        `SELECT s.* FROM steps s JOIN runs r ON r.id = s.run_id
         WHERE s.id = ? AND r.conversation_id = ?`,
      )
      .get(id, conversationId)
    return row ? [rowToStep(row)] : []
  })

  const earlierTurns = hasMore && oldest ? listTurnsBefore(store, conversationId, oldest) : []

  return {
    messages,
    runs,
    steps,
    earlierTurns,
    // 与 tools/runtime 读取待办使用同一账本投影；不属于分页结果。
    todos: latestTodos(store, conversationId) ?? [],
    workflowStarts,
    nextCursor: hasMore ? (oldest as MessageId) : null,
  }
}

/**
 * 变更面板的一页：该会话中写入过文件的轮次，最新的在前。
 *
 * 与历史页分开：历史页按完整用户轮次切分，一页中可能没有任何文件写入，面板若用它翻页
 * 会把整段会话流一并加载到主区。此处只选取有写入的用户消息；游标与历史页相同，
 * 为用户消息 id，作为排他上界。
 *
 * 一轮的写入有三个来源，返回同一形状（`ConversationChangeStep`）：
 * - 本会话 step 的 `outcome.fileChanges`；
 * - 内置子 agent 在子会话中的 step：子会话的 run 建行时记录了 `dispatch_step_id`（父会话中
 *   派发任务卡的 step），据此归入父轮次。这是创建 run 时写入的事实，不是按时间推断的；
 * - 外部 CLI 节点：父 step 的 `nodes[*].fileChanges`，由观察器提供，不含行数。
 *
 * `totals` 是整条会话的合计：三个来源合并计算，按轮次分别折叠后再相加。界面中的各行
 * 使用同一个 `foldFileChanges`，两处各自折叠时表头与行不一致。
 */
export function listConversationChangesPage(
  store: Store,
  conversationId: ConversationId,
  input: { before?: MessageId | null; limit: number },
): ConversationChangesPageResponse {
  const limit = Math.max(1, Math.min(100, Math.trunc(input.limit)))
  const before = input.before ?? null
  type Params = Record<string, string | number>
  const base: Params = { $conv: conversationId, $now: Date.now() }
  const rows = <T>(sql: string, extra: Params = {}): T[] =>
    store.db.query<T, [Params]>(sql).all({ ...base, ...extra })

  // 三个来源的写入清单，不含 args。`delegated` 按子会话 run 上的 `dispatch_step_id` 归入父轮次；
  // 名称取子会话标题，与派发任务卡上对应节点的 label 同源。
  const cte = `
    WITH own AS (
      SELECT r.user_message_id AS turn_id, s.id AS step_id
      FROM runs r JOIN steps s ON s.run_id = r.id
      WHERE r.conversation_id = $conv AND r.user_message_id IS NOT NULL
        AND json_array_length(json_extract(s.payload, '$.outcome.fileChanges')) > 0
    ),
    nodes AS (
      SELECT r.user_message_id AS turn_id, s.id AS step_id, s.created_at AS at,
             coalesce(s.duration_ms, r.finished_at - s.created_at, $now - s.created_at) AS duration,
             n.key AS node_id,
             json_extract(n.value, '$.subagentId') AS subagent_id,
             json_extract(n.value, '$.label') AS label,
             coalesce(json_array_length(json_extract(n.value, '$.fileChanges')), 0) AS cli_writes
      FROM runs r
      JOIN steps s ON s.run_id = r.id AND s.payload IS NOT NULL
        AND json_type(s.payload, '$.nodes') = 'object'
      JOIN json_each(s.payload, '$.nodes') n
      WHERE r.conversation_id = $conv AND r.user_message_id IS NOT NULL
    ),
    delegated AS (
      SELECT r.user_message_id AS turn_id, cs.id AS step_id,
             (SELECT title FROM conversations WHERE id = cr.conversation_id) AS label
      FROM runs r
      JOIN steps s ON s.run_id = r.id
      JOIN runs cr ON cr.dispatch_step_id = s.id
      JOIN steps cs ON cs.run_id = cr.id
      WHERE r.conversation_id = $conv AND r.user_message_id IS NOT NULL
        AND json_array_length(json_extract(cs.payload, '$.outcome.fileChanges')) > 0
    )`

  type TurnRow = Pick<MessageRow, 'id' | 'content' | 'origin' | 'created_at'>
  const turnRows = rows<TurnRow>(
    `${cte}
     SELECT m.id, m.content, m.origin, m.created_at FROM messages m
     WHERE m.conversation_id = $conv ${before ? 'AND m.id < $before' : ''}
       AND (EXISTS (SELECT 1 FROM own WHERE own.turn_id = m.id)
         OR EXISTS (SELECT 1 FROM delegated WHERE delegated.turn_id = m.id)
         OR EXISTS (SELECT 1 FROM nodes WHERE nodes.turn_id = m.id AND nodes.cli_writes > 0))
     ORDER BY m.id DESC LIMIT $limit`,
    { $limit: limit + 1, ...(before ? { $before: before } : {}) },
  )

  /*
   * 整条会话的合计，按轮次折叠后再相加：同一路径在一轮中创建后又删除时不应计入
   * （`foldFileChanges`），而这一判断只在同一轮次的范围内成立。
   *
   * 三个来源与选取轮次使用同一套 CTE；排序取 `steps.rowid`：三条支路都取自该表，
   * rowid 即写入顺序，而折叠只依赖先后顺序。选取轮次与合计只读取 fileChange 的四个字段，
   * 不把 args（整份文件内容）读入内存。
   */
  const totalRows = rows<{
    turn_id: string
    path: string
    change_type: FileChange['changeType']
    additions: number | null
    deletions: number | null
  }>(
    `${cte}
     SELECT turn_id, path, change_type, additions, deletions FROM (
       SELECT own.turn_id AS turn_id, json_extract(c.value, '$.path') AS path,
              json_extract(c.value, '$.changeType') AS change_type,
              json_extract(c.value, '$.additions') AS additions,
              json_extract(c.value, '$.deletions') AS deletions, s.rowid AS ord
       FROM own JOIN steps s ON s.id = own.step_id
       JOIN json_each(s.payload, '$.outcome.fileChanges') c
       UNION ALL
       SELECT delegated.turn_id, json_extract(c.value, '$.path'),
              json_extract(c.value, '$.changeType'), json_extract(c.value, '$.additions'),
              json_extract(c.value, '$.deletions'), cs.rowid
       FROM delegated JOIN steps cs ON cs.id = delegated.step_id
       JOIN json_each(cs.payload, '$.outcome.fileChanges') c
       UNION ALL
       SELECT nodes.turn_id, json_extract(c.value, '$.path'),
              json_extract(c.value, '$.changeType'), json_extract(c.value, '$.additions'),
              json_extract(c.value, '$.deletions'), s.rowid
       FROM nodes JOIN steps s ON s.id = nodes.step_id
       JOIN json_each(s.payload, '$.nodes') n ON n.key = nodes.node_id
       JOIN json_each(n.value, '$.fileChanges') c
       WHERE nodes.cli_writes > 0
     ) WHERE path IS NOT NULL ORDER BY turn_id, ord`,
  )
  const perTurn = new Map<string, FileChange[]>()
  for (const row of totalRows) {
    const list = perTurn.get(row.turn_id) ?? []
    list.push({
      path: row.path,
      changeType: row.change_type,
      ...(row.additions === null ? {} : { additions: row.additions }),
      ...(row.deletions === null ? {} : { deletions: row.deletions }),
    })
    perTurn.set(row.turn_id, list)
  }
  const totals = { paths: [] as string[], additions: 0, deletions: 0 }
  for (const list of perTurn.values()) {
    for (const folded of foldFileChanges(list)) {
      if (!totals.paths.includes(folded.path)) totals.paths.push(folded.path)
      totals.additions += folded.additions
      totals.deletions += folded.deletions
    }
  }

  const hasMore = turnRows.length > limit
  const selected = turnRows.slice(0, limit)
  if (selected.length === 0) return { turns: [], totals, nextCursor: null }
  const ids = JSON.stringify(selected.map((row) => row.id))
  const inSelected = 'IN (SELECT value FROM json_each($ids))'

  interface WriteRow {
    turn_id: string
    id: string
    tool_name: string | null
    payload: string | null
    at: number
    seq: number
    label: string | null
    via: 0 | 1
  }
  const writeRows = [
    ...rows<WriteRow>(
      `${cte}
       SELECT own.turn_id, s.id, s.tool_name, s.payload, s.created_at AS at, s.seq, NULL AS label, 0 AS via
       FROM own JOIN steps s ON s.id = own.step_id WHERE own.turn_id ${inSelected}`,
      { $ids: ids },
    ),
    ...rows<WriteRow>(
      `${cte}
       SELECT d.turn_id, cs.id, cs.tool_name, cs.payload, cs.created_at AS at, cs.seq, d.label, 1 AS via
       FROM delegated d JOIN steps cs ON cs.id = d.step_id WHERE d.turn_id ${inSelected}`,
      { $ids: ids },
    ),
  ]
  interface CliRow {
    turn_id: string
    step_id: string
    node_id: string
    label: string | null
    at: number
    duration: number
    changes: string
  }
  const cliRows = rows<CliRow>(
    `${cte}
     SELECT nodes.turn_id, nodes.step_id, nodes.node_id, nodes.label, nodes.at, nodes.duration,
            json_extract(n.value, '$.fileChanges') AS changes
     FROM nodes JOIN steps s ON s.id = nodes.step_id
     JOIN json_each(s.payload, '$.nodes') n ON n.key = nodes.node_id
     WHERE nodes.cli_writes > 0 AND nodes.turn_id ${inSelected}`,
    { $ids: ids },
  )

  const byTurn = new Map<string, { at: number; seq: number; step: ConversationChangeStep }[]>()
  const push = (turnId: string, at: number, seq: number, step: ConversationChangeStep) => {
    const list = byTurn.get(turnId) ?? []
    list.push({ at, seq, step })
    byTurn.set(turnId, list)
  }
  for (const row of writeRows) {
    const payload = readJson<Step['payload']>(row.payload, null, 'steps.payload')
    if (payload?.kind !== 'tool_result' || !payload.outcome.fileChanges?.length) continue
    push(row.turn_id, row.at, row.seq, {
      id: row.id,
      toolName: row.tool_name ?? '',
      ...(payload.args ? { args: payload.args } : {}),
      fileChanges: payload.outcome.fileChanges,
      via: row.via ? { name: row.label ?? '' } : null,
    })
  }
  for (const row of cliRows) {
    // 按派发 step 结束的时刻排序；同一毫秒内排在子会话的写入之后。
    push(row.turn_id, row.at + row.duration, Number.MAX_SAFE_INTEGER, {
      id: `${row.step_id}:${row.node_id}`,
      toolName: 'cli',
      fileChanges: readJson<FileChange[]>(row.changes, [], 'steps.payload'),
      via: { name: row.label ?? '' },
    })
  }

  return {
    turns: selected.map((row) => ({
      userMessageId: row.id as MessageId,
      text: row.content,
      origin: row.origin,
      createdAt: row.created_at,
      steps: (byTurn.get(row.id) ?? [])
        .sort((a, b) => a.at - b.at || a.seq - b.seq)
        .map((entry) => entry.step),
    })),
    totals,
    nextCursor: hasMore ? (selected.at(-1)?.id as MessageId) : null,
  }
}

function rowToMessage(r: MessageRow): Message {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    role: r.role,
    content: r.content,
    attachments: readJson(r.attachments, [], 'messages.attachments'),
    origin: r.origin,
    createdAt: r.created_at,
  }
}
