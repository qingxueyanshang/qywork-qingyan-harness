import type { Migration } from './shared.ts'

export const migration065: Migration = {
  id: 65,
  name: 'user_only_messages',
  /**
   * `messages` 只存储用户发送的消息：助手回复与工具记录始终在 `steps` 中，`role = 'assistant'` 没有写入方，
   * `runs.assistant_message_id` 恒为 NULL。
   *
   * 表重建而不是 ALTER：SQLite 无法修改 CHECK 约束。存量库若有助手行，本迁移在插入时失败并整体回滚；
   * 不要改为先删除再插入：先删除时会丢失数据且不报错。没有表以外键引用 `messages`，重建不会引发级联删除。
   */
  sql: `
CREATE TABLE messages_new (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role = 'user'),
  content         TEXT NOT NULL DEFAULT '',
  attachments     TEXT,
  created_at      INTEGER NOT NULL,
  origin          TEXT CHECK (origin IN ('subagent','workflow'))
);
INSERT INTO messages_new (id, conversation_id, role, content, attachments, created_at, origin)
  SELECT id, conversation_id, role, content, attachments, created_at, origin FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX idx_msg_conv ON messages(conversation_id, id);
ALTER TABLE runs DROP COLUMN assistant_message_id;
`,
}
