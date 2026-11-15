import type { Migration } from './shared.ts'

export const migration009: Migration = {
  id: 9,
  name: 'workspace_removed_at',
  /**
   * 从列表中移除项目不再等于删除该项目的全部数据。
   *
   * **行必须保留。** `conversations.workspace_id` 是 `ON DELETE CASCADE`，而 `workspaceOf` 需要
   * join 该行才能确定会话在哪个根目录下运行。删除该行后，会话将无法打开。避免中间态的办法不只
   * 删除行一种：**行保留，但不出现在列表中**。
   *
   * 移除只改变列表中是否显示，不改变能否读取：`listWorkspaces` 过滤
   * `removed_at IS NULL`，而 `workspaceOf` / `getWorkspace` **一律不过滤**。
   * 会话、消息、run、step 均不改动，重新添加同一路径即全部恢复
   * （`root_path` 是 UNIQUE，upsert 命中同一行并清除该标记）。
   *
   * 移除的语义因此与其他部分一致：`usage_ledger` 同样刻意不设外键，
   * 本月花费不应因项目从列表中移除而减少。
   *
   * **不提供彻底删除。** 没有该需求即不实现（B5）。需要清理数据时可使用备份与 SQL；
   * 增加一个入口就要增加一套多次确认的交互，以及一条可永久删除数据的路径。
   *
   * `NULL` 表示在列表中。使用时间戳而不是布尔值：移除时间将来需要显示，
   * 届时布尔值只能再增加一列。
   */
  sql: `
ALTER TABLE workspaces ADD COLUMN removed_at INTEGER;
`,
}
