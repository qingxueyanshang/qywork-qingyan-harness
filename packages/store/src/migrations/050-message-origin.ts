import type { Migration } from './shared.ts'

export const migration050: Migration = {
  id: 50,
  name: 'message_origin',
  /**
   * 子 agent 与 workflow 的回执以 user 角色发给模型，写入数据库时以本列与用户本人的消息区分。
   * 可空：旧行与用户发送的消息均为 NULL，不回填。
   */
  sql: `
ALTER TABLE messages ADD COLUMN origin TEXT CHECK (origin IN ('subagent','workflow'));
`,
}
