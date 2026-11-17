import type { Database } from 'bun:sqlite'
import { type Migration, parsedObject } from './shared.ts'

function textValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 迁移 26 之前附在工具行 `content` 上的思考正文，改写为独立的 thinking step。
 *
 * 受影响 run 的 seq 全部映射为 `old * 2 + 1`，新的思考 step 写在 `old * 2`。step 顺序与
 * batch 的截止 step 戳因此都可按公式换算，无需推测空位。会话压缩边界只含两处 step
 * 戳，一并重写；迁移完成后运行时不再读取 `tool_action.content`。
 */
function migrateEmbeddedThinking(db: Database): void {
  const rows = db
    .query<{ id: string; run_id: string; seq: number; content: string; created_at: number }, []>(
      `SELECT id, run_id, seq, content, created_at
       FROM steps
       WHERE kind = 'tool_action' AND trim(COALESCE(content, '')) <> ''
       ORDER BY run_id, seq`,
    )
    .all()
  if (rows.length === 0) return

  const runs = new Set(rows.map((row) => row.run_id))
  const updateSeq = db.query('UPDATE steps SET seq = seq * 2 + 1 WHERE run_id = ?')
  for (const runId of runs) updateSeq.run(runId)

  const insert = db.query(
    `INSERT INTO steps
     (id, run_id, seq, kind, content, status, created_at)
     VALUES (?, ?, ?, 'thinking', ?, 'done', ?)`,
  )
  const clear = db.query(`UPDATE steps SET content = NULL WHERE id = ?`)
  const added = new Map<string, number>()
  for (const row of rows) {
    insert.run(
      `st_migrated_thinking_${row.id}`,
      row.run_id,
      row.seq * 2,
      row.content,
      row.created_at,
    )
    clear.run(row.id)
    added.set(row.run_id, (added.get(row.run_id) ?? 0) + 1)
  }
  const count = db.query('UPDATE runs SET step_count = step_count + ? WHERE id = ?')
  for (const [runId, amount] of added) count.run(amount, runId)

  const rewriteStamp = (value: unknown): unknown => {
    if (typeof value !== 'string') return value
    for (const runId of runs) {
      const prefix = `${runId}:`
      if (!value.startsWith(prefix)) continue
      const seq = Number(value.slice(prefix.length))
      if (!Number.isSafeInteger(seq) || seq < 0) return value
      return `${prefix}${String(seq * 2 + 1).padStart(9, '0')}`
    }
    return value
  }
  const manifests = db
    .query<{ id: string; compaction_manifest: string }, []>(
      `SELECT id, compaction_manifest FROM conversations WHERE compaction_manifest IS NOT NULL`,
    )
    .all()
  const updateManifest = db.query('UPDATE conversations SET compaction_manifest = ? WHERE id = ?')
  for (const row of manifests) {
    const manifest = parsedObject(row.compaction_manifest)
    if (!manifest) continue
    let changed = false
    if (typeof manifest.compactedThroughStep === 'string') {
      const next = rewriteStamp(manifest.compactedThroughStep)
      changed ||= next !== manifest.compactedThroughStep
      manifest.compactedThroughStep = next
    }
    const condensed = manifest.condensedThrough
    if (condensed && typeof condensed === 'object' && !Array.isArray(condensed)) {
      const cut = condensed as Record<string, unknown>
      if (typeof cut.step === 'string') {
        const next = rewriteStamp(cut.step)
        changed ||= next !== cut.step
        cut.step = next
      }
    }
    if (changed) updateManifest.run(JSON.stringify(manifest), row.id)
  }
}

/** 将能由旧账本自身证明的字段改写为当前唯一结构；无法证明的事实不按配置推测。 */
function canonicalizeRuntimeRecords(db: Database): void {
  migrateEmbeddedThinking(db)

  // 旧投影将缺少 batch id 的每条工具行各视为一批；此处将该语义写入账本。
  db.exec(`
UPDATE steps
SET provider_batch_id = 'migrated:' || id
WHERE kind = 'tool_action' AND trim(COALESCE(provider_batch_id, '')) = '';
`)

  const rows = db
    .query<
      {
        id: string
        kind: string
        tool_name: string | null
        payload: string | null
        status: string
      },
      []
    >(`SELECT id, kind, tool_name, payload, status FROM steps WHERE payload IS NOT NULL`)
    .all()
  const updatePayload = db.query('UPDATE steps SET payload = ? WHERE id = ?')
  for (const row of rows) {
    const payload = parsedObject(row.payload)
    if (!payload) continue
    let changed = false

    if (row.kind === 'tool_action') {
      const outcome =
        payload.outcome && typeof payload.outcome === 'object' && !Array.isArray(payload.outcome)
          ? (payload.outcome as Record<string, unknown>)
          : null
      const data =
        outcome?.data && typeof outcome.data === 'object' && !Array.isArray(outcome.data)
          ? (outcome.data as Record<string, unknown>)
          : null
      const child = textValue(data?.conversationId)
      if (row.tool_name === 'subagent' && !textValue(payload.childConversationId) && child) {
        payload.childConversationId = child
        changed = true
      }

      if (
        row.tool_name === 'workflow' &&
        data &&
        !Array.isArray(data.receipts) &&
        Array.isArray(data.nodes)
      ) {
        const receipts = data.nodes.map((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return null
          const node = value as Record<string, unknown>
          const nodeId = textValue(node.nodeId)
          const agent = textValue(node.agent)
          const status = node.status
          const durationMs = node.durationMs
          if (
            !nodeId ||
            !agent ||
            (status !== 'done' && status !== 'failed' && status !== 'skipped') ||
            typeof durationMs !== 'number'
          ) {
            return null
          }
          return {
            nodeId,
            agent,
            label: textValue(node.label) || agent,
            status,
            output: typeof node.output === 'string' ? node.output : '',
            ...(typeof node.error === 'string' ? { error: node.error } : {}),
            durationMs,
            ...(typeof node.session === 'string' ? { session: node.session } : {}),
            ...(typeof node.conversationId === 'string'
              ? { conversationId: node.conversationId }
              : {}),
          }
        })
        if (receipts.every((receipt) => receipt !== null)) {
          const args =
            payload.args && typeof payload.args === 'object' && !Array.isArray(payload.args)
              ? (payload.args as Record<string, unknown>)
              : null
          data.workflowId = textValue(data.workflowId) || textValue(args?.workflowId) || row.id
          data.phase = outcome?.status === 'success' ? 'completed' : 'failed'
          data.receipts = receipts
          delete data.nodes
          changed = true
        }
      }
    } else if (row.kind === 'compaction' && !textValue(payload.phase)) {
      payload.phase = row.status === 'failure' ? 'failed' : 'done'
      changed = true
    }

    if (changed) updatePayload.run(JSON.stringify(payload), row.id)
  }

  // 仅当逐请求账本能唯一证明接口时，才为旧会话补写接口。没有证据或存在多个接口时保持空串，
  // 运行时要求用户重新选择；不以当前默认接口伪造历史归属。
  const conversations = db
    .query<{ id: string; model: string }, []>(
      `SELECT id, model FROM conversations WHERE trim(provider) = ''`,
    )
    .all()
  const routes = db.query<{ provider_name: string }, [string, string]>(
    `SELECT DISTINCT pr.provider_name
     FROM provider_requests pr
     JOIN runs r ON r.id = pr.run_id
     WHERE r.conversation_id = ? AND pr.model = ?
       AND trim(COALESCE(pr.provider_name, '')) <> ''`,
  )
  const updateProvider = db.query('UPDATE conversations SET provider = ? WHERE id = ?')
  for (const conversation of conversations) {
    const hits = routes.all(conversation.id, conversation.model)
    if (hits.length === 1) updateProvider.run(hits[0]!.provider_name, conversation.id)
  }
}

export const migration037: Migration = {
  id: 37,
  name: 'canonical_runtime_records',
  /**
   * 旧结构在此一次性转换完毕，读取路径不再长期维护两套语义。
   *
   * 可证明的事实原地迁移；provider 归属没有唯一账本证据时保持未绑定，
   * 由用户重新选择，不按当前配置的枚举顺序推测，以免选错端点、key 与计价。
   */
  apply(db) {
    canonicalizeRuntimeRecords(db)
  },
}
