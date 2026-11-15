import type { Migration } from './shared.ts'

export const migration053: Migration = {
  id: 53,
  name: 'watcher_dot_paths',
  /**
   * 迁移 52 清除的是隐藏目录下的路径，以点开头的单个文件（脚本生成的 `.tmp-verify`、`.fin`
   * 等临时标记）与已删除的 `.chk` 文件仍留在账本中。已执行的迁移不修改内容，
   * 剩余部分由本迁移处理，清除方法与 52 相同。
   *
   * 同 52：观察器此后按 Git 的忽略规则判定，本迁移不重新执行。
   */
  sql: `
UPDATE steps SET payload = json_set(payload, '$.outcome.fileChanges',
  (SELECT json_group_array(json(c.value)) FROM json_each(steps.payload, '$.outcome.fileChanges') c
    WHERE NOT (json_extract(c.value, '$.additions') IS NULL
               AND (json_extract(c.value, '$.path') LIKE '.%'
                    OR json_extract(c.value, '$.path') LIKE '%/.%'))))
WHERE json_type(payload, '$.outcome.fileChanges') = 'array'
  AND EXISTS (SELECT 1 FROM json_each(steps.payload, '$.outcome.fileChanges') c
              WHERE json_extract(c.value, '$.additions') IS NULL
                AND (json_extract(c.value, '$.path') LIKE '.%'
                     OR json_extract(c.value, '$.path') LIKE '%/.%'));
UPDATE steps SET payload = json_set(payload, '$.nodes',
  (SELECT json_group_object(n.key,
     CASE WHEN json_type(n.value, '$.fileChanges') = 'array'
          THEN json(json_set(n.value, '$.fileChanges',
                 (SELECT json_group_array(json(c.value)) FROM json_each(n.value, '$.fileChanges') c
                   WHERE NOT (json_extract(c.value, '$.path') LIKE '.%'
                              OR json_extract(c.value, '$.path') LIKE '%/.%'))))
          ELSE json(n.value) END)
   FROM json_each(steps.payload, '$.nodes') n))
WHERE json_type(payload, '$.nodes') = 'object'
  AND EXISTS (SELECT 1 FROM json_each(steps.payload, '$.nodes') n, json_each(n.value, '$.fileChanges') c
              WHERE json_extract(c.value, '$.path') LIKE '.%'
                 OR json_extract(c.value, '$.path') LIKE '%/.%');
`,
}
