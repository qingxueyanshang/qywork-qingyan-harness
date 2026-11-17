import type { Migration } from './shared.ts'

export const migration051: Migration = {
  id: 51,
  name: 'run_dispatch',
  /**
   * 子会话的每一轮由哪次任务派发产生，在创建 run 时写入该行：父会话中派发任务卡的 step 与卡片上的对应节点。
   * 变更投影据此将子会话的写入归入父轮，不按时间推断：派发任务在派出后立即返回，父 step 在 100 余毫秒内即结束，
   * 子会话的 run 在此之后才创建，按执行窗口推断会将其全部排除。
   * 旧行回填：归入该轮创建之前最近一次派发该子会话的节点。
   */
  sql: `
ALTER TABLE runs ADD COLUMN dispatch_step_id TEXT;
ALTER TABLE runs ADD COLUMN dispatch_node_id TEXT;
CREATE INDEX idx_runs_dispatch ON runs(dispatch_step_id);
UPDATE runs SET
  dispatch_step_id = (
    SELECT s.id FROM steps s
    JOIN runs pr ON pr.id = s.run_id
    JOIN json_each(s.payload, '$.nodes') n
    WHERE pr.conversation_id = (SELECT parent_conversation_id FROM conversations WHERE id = runs.conversation_id)
      AND s.payload IS NOT NULL
      AND json_extract(n.value, '$.subagentId') = runs.conversation_id
      AND s.created_at <= runs.created_at
    ORDER BY s.created_at DESC, n.key LIMIT 1),
  dispatch_node_id = (
    SELECT n.key FROM steps s
    JOIN runs pr ON pr.id = s.run_id
    JOIN json_each(s.payload, '$.nodes') n
    WHERE pr.conversation_id = (SELECT parent_conversation_id FROM conversations WHERE id = runs.conversation_id)
      AND s.payload IS NOT NULL
      AND json_extract(n.value, '$.subagentId') = runs.conversation_id
      AND s.created_at <= runs.created_at
    ORDER BY s.created_at DESC, n.key LIMIT 1)
WHERE conversation_id IN (SELECT id FROM conversations WHERE parent_conversation_id IS NOT NULL);
`,
}
