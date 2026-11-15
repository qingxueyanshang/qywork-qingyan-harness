import type { Migration } from './shared.ts'

export const migration010: Migration = {
  id: 10,
  name: 'workspace_pinned_at',
  /**
   * 置顶项目。
   *
   * 按 `last_opened_at` 倒序得到的是最近打开的项目，不是常用项目。项目增多后，
   * 一次临时切换就会使常用项目的位置下移，而用户预期常用项目位置稳定。
   *
   * 存时间戳不存布尔值：多个置顶项目之间也需要确定顺序（后置顶的在前），
   * 布尔值届时只能再增加一列。`NULL` 表示未置顶。
   */
  sql: `
ALTER TABLE workspaces ADD COLUMN pinned_at INTEGER;
`,
}
