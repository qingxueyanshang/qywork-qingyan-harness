import type { Migration } from './shared.ts'

export const migration052: Migration = {
  id: 52,
  name: 'watcher_hidden_dirs',
  /**
   * 清除工作区观察器按点前缀排除的规则生效期间记入账本的隐藏目录路径（`.xxx/` 下的路径）。
   * 只清除观察器判定的记录（没有 `additions` 的），文件类工具的精确明细不改动；派发任务卡各节点的
   * `fileChanges` 全部来自观察器，按路径清除。
   *
   * 观察器此后按 Git 的忽略规则判定，项目自身的点路径不再被排除。本迁移不重新执行，
   * 也不恢复已清除的记录。
   */
  sql: `
UPDATE steps SET payload = json_set(payload, '$.outcome.fileChanges',
  (SELECT json_group_array(json(c.value)) FROM json_each(steps.payload, '$.outcome.fileChanges') c
    WHERE NOT (json_extract(c.value, '$.additions') IS NULL
               AND (json_extract(c.value, '$.path') LIKE '.%/%'
                    OR json_extract(c.value, '$.path') LIKE '%/.%/%'))))
WHERE json_type(payload, '$.outcome.fileChanges') = 'array'
  AND EXISTS (SELECT 1 FROM json_each(steps.payload, '$.outcome.fileChanges') c
              WHERE json_extract(c.value, '$.additions') IS NULL
                AND (json_extract(c.value, '$.path') LIKE '.%/%'
                     OR json_extract(c.value, '$.path') LIKE '%/.%/%'));
UPDATE steps SET payload = json_set(payload, '$.nodes',
  (SELECT json_group_object(n.key,
     CASE WHEN json_type(n.value, '$.fileChanges') = 'array'
          THEN json(json_set(n.value, '$.fileChanges',
                 (SELECT json_group_array(json(c.value)) FROM json_each(n.value, '$.fileChanges') c
                   WHERE NOT (json_extract(c.value, '$.path') LIKE '.%/%'
                              OR json_extract(c.value, '$.path') LIKE '%/.%/%'))))
          ELSE json(n.value) END)
   FROM json_each(steps.payload, '$.nodes') n))
WHERE json_type(payload, '$.nodes') = 'object'
  AND EXISTS (SELECT 1 FROM json_each(steps.payload, '$.nodes') n, json_each(n.value, '$.fileChanges') c
              WHERE json_extract(c.value, '$.path') LIKE '.%/%'
                 OR json_extract(c.value, '$.path') LIKE '%/.%/%');
`,
}
