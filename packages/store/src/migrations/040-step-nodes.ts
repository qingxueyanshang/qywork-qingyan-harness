import type { Migration } from './shared.ts'

export const migration040: Migration = {
  id: 40,
  name: 'step_nodes',
  /**
   * 派发任务卡的节点信息合并为 `$.nodes` 一份：旧格式中单个派发写 `$.childConversationId`、
   * 工作流图写 `$.children`，两个键都只有子会话 id，没有状态。旧行按 step 的终态
   * 推导每个节点的 phase，名称取子会话标题。
   */
  sql: `
UPDATE steps
SET payload = json_set(
      json_remove(payload, '$.childConversationId'),
      '$.nodes',
      json_object('child', json_object(
        'phase', CASE status WHEN 'success' THEN 'done' WHEN 'failure' THEN 'failed' ELSE 'interrupted' END,
        'label', coalesce((SELECT title FROM conversations
                           WHERE id = json_extract(steps.payload, '$.childConversationId')), ''),
        'subagentId', json_extract(payload, '$.childConversationId'))))
WHERE kind = 'tool_action' AND json_type(payload, '$.childConversationId') = 'text';
UPDATE steps
SET payload = json_set(
      json_remove(payload, '$.children'),
      '$.nodes',
      (SELECT json_group_object(je.key, json_object(
         'phase', CASE steps.status WHEN 'success' THEN 'done' WHEN 'failure' THEN 'failed' ELSE 'interrupted' END,
         'label', coalesce((SELECT title FROM conversations WHERE id = je.value), ''),
         'subagentId', je.value))
       FROM json_each(steps.payload, '$.children') je))
WHERE kind = 'tool_action' AND json_type(payload, '$.children') = 'object';
`,
}
