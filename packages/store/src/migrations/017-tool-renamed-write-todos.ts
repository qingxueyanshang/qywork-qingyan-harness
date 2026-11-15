import type { Migration } from './shared.ts'

export const migration017: Migration = {
  id: 17,
  name: 'tool_renamed_write_todos',
  /**
   * `update_plan` 改名为 `write_todos`，**已落库的 `tool_name` 同步转换**。
   *
   * 不转换的后果已经实测确认：待办面板完全为空。面板不由事件驱动，
   * 重新加载会话时从账本投影（`web` 的 `todosFromSteps`：查找最后一次成功的
   * 待办提交，整表在其 `args` 中），而投影按新名称查找，旧行仍是旧名称，
   * 因此没有任何一行匹配，界面上表现为历史数据丢失。
   *
   * **在数据中改名而不在投影中兼容两个名称**：后者是一条兼容分支，且会长期保留
   * （B3）。同一个工具改名后，账本中记录的工具名应随之更改，
   * 否则模型回放历史时会看到当前工具表中不存在的名称。
   *
   * 这不违反「已落盘的键名是历史事实」：该规则指的是**结构键名**（列名、
   * schema 版本键、迁移标记），不是记录内容中的值。
   */
  sql: `
UPDATE steps SET tool_name = 'write_todos' WHERE tool_name = 'update_plan';
`,
}
