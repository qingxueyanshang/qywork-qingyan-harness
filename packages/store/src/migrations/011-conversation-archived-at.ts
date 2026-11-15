import type { Migration } from './shared.ts'

export const migration011: Migration = {
  id: 11,
  name: 'conversation_archived_at',
  /**
   * 归档会话：**从会话列表中移除，此后新建的会话照常显示**。
   *
   * **与 `runtime/src/archive.ts` 名称相同而含义不同。** 后者是会话**导出**：产出 markdown / json，
   * 只读，产出物是静态的，不承诺可写回。此处的归档是不在列表中显示，数据均不改动。两者都称为
   * archive 容易造成误读，因此在此说明；导出部分保持原名。
   *
   * **数据不删除，但界面上无法访问。** `listConversations` 过滤归档会话，`getConversation` **不过滤**，
   * 按 id 仍可读取。这与迁移 9 移除项目的处理一致：状态标记只改变是否显示。区别是移除的项目
   * 可通过重新添加同一路径恢复，而归档没有对应的恢复入口。**这是用户明确要求的行为**（原话：「不
   * 是列表收敛，是不在会话里面显示了，新开对话还是会显示新的」），不是遗漏。将来若需要恢复，应增加一
   * 个视图，而不是修改此语义。
   */
  sql: `
ALTER TABLE conversations ADD COLUMN archived_at INTEGER;
`,
}
