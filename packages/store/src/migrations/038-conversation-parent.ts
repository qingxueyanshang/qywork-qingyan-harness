import type { Migration } from './shared.ts'

export const migration038: Migration = {
  id: 38,
  name: 'conversation_parent',
  /**
   * 子会话所属的父会话。派发任务时写入，此后账本汇总、级联删除、运行页三项
   * 都以此列为依据，不再从 step 的 JSON 中反查两种结构。
   *
   * `ON DELETE CASCADE`：删除父会话时子会话一并删除，不留下孤立记录。账目不受影响：
   * `usage_ledger` 没有外键，按设计这些行的生命周期长于业务数据。
   *
   * NULL 表示顶层会话，或迁移之前创建的子会话。
   */
  sql: `
ALTER TABLE conversations
  ADD COLUMN parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE;
CREATE INDEX idx_conv_parent ON conversations(parent_conversation_id);
`,
}
