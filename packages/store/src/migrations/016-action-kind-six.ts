import type { Migration } from './shared.ts'

export const migration016: Migration = {
  id: 16,
  name: 'action_kind_six',
  /**
   * 动作轴从九个值收敛为六个，**已写入磁盘的行同步转换**。
   *
   * 不转换的后果已经实测：代码中的动作枚举修改完成后，账本中的旧 step 仍带有
   * `execute` / `search` / `plan`，回放时前端未查到动词，卡片标题回退为原始工具名，
   * 界面上直接出现 `update_plan` 这类内部字段。**修改协议而不转换数据，修改即不完整。**
   *
   * 每条映射均有依据：
   * `execute` / `delegate` → `run`（运行命令、运行编排节点都属于运行）、
   * `search` → `query`（搜索是查询的一种）、`fetch` → `read`（读取一份已知资源）、
   * `plan` → `write`（该工具提交待办清单，首次提交即创建）。
   *
   * `plan` 的映射同时将对象名从「计划」改为「待办」：该工具产出的始终是待办清单，
   * 「计划／方案」指另一类内容（说明实施方法的文档），名称应予区分。
   *
   * **这是一次性转换，不是兼容层**：转换完成后，代码中没有任何分支识别旧值。
   */
  sql: `
UPDATE steps
SET payload = json_set(payload, '$.action.objectLabel', '待办')
WHERE json_extract(payload, '$.action.kind') = 'plan';

UPDATE steps
SET payload = json_set(
  payload,
  '$.action.kind',
  CASE json_extract(payload, '$.action.kind')
    WHEN 'execute'  THEN 'run'
    WHEN 'delegate' THEN 'run'
    WHEN 'search'   THEN 'query'
    WHEN 'fetch'    THEN 'read'
    WHEN 'plan'     THEN 'write'
  END
)
WHERE json_extract(payload, '$.action.kind') IN ('execute', 'delegate', 'search', 'fetch', 'plan');

UPDATE steps
SET payload = json_set(
  payload,
  '$.outcome.message',
  replace(json_extract(payload, '$.outcome.message'), '计划已更新', '待办已更新')
)
WHERE json_extract(payload, '$.outcome.message') LIKE '计划已更新%';
`,
}
