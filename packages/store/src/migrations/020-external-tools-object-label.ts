import type { Migration } from './shared.ts'

export const migration020: Migration = {
  id: 20,
  name: 'external_tools_object_label',
  /**
   * 外置工具的对象名统一为「MCP」/「插件」两个类名，**已写入磁盘的行同步转换**。
   *
   * 工具卡由**动词 + 对象 + 目标**三层组成。存量行中外置工具将具体的
   * `mcp:<server>/<tool>`（插件为清单自行声明的名称）写入了对象名，
   * 因此标题与目标是完全相同的字符串，目标层重复且不提供信息。对象名应写类名，
   * 具体字符串归 `action.target`。
   *
   * 不转换时不会报错：回放历史时旧卡片显示「调用mcp:github/search」，
   * 新卡片显示「调用MCP · mcp:github/search」，同一操作有两种表述。
   *
   * 判据与迁移 19 相同：**工具名中的 `__`**，只由 `mcp__<server>__<tool>` 与
   * 插件的 `<id>__<tool>` 两条命名路径产生，内置工具名均不含。
   * 两者以**是否以 `mcp__` 开头**区分。
   *
   * **`action.target` 不改动**：它应是具体字符串，本次只修改对象名层。
   *
   * 幂等：转换完成后再次执行，写入的仍是同样的两个类名。
   * 没有 `action` 的行由 WHERE 排除：否则 `json_set` 会为其新增一个键。
   */
  sql: `
UPDATE steps
SET payload = json_set(
  payload,
  '$.action.objectLabel',
  CASE WHEN instr(tool_name, 'mcp__') = 1 THEN 'MCP' ELSE '插件' END
)
WHERE tool_name IS NOT NULL
  AND instr(tool_name, '__') > 0
  AND json_extract(payload, '$.action.objectLabel') IS NOT NULL;
`,
}
