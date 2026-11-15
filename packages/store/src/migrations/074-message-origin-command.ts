import type { Migration } from './shared.ts'

export const migration074: Migration = {
  id: 74,
  name: 'message_origin_command',
  /**
   * 后台命令结束时的回执与子 agent 回执经由同一入口发起一轮，`origin` 增加取值 `command`。
   * 表重建而不是 ALTER：SQLite 无法修改 CHECK 约束。理由与做法同迁移 65：没有表以外键引用 `messages`。
   */
  sql: `
CREATE TABLE messages_new (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role = 'user'),
  content         TEXT NOT NULL DEFAULT '',
  attachments     TEXT,
  created_at      INTEGER NOT NULL,
  origin          TEXT CHECK (origin IN ('subagent','workflow','command'))
);
INSERT INTO messages_new (id, conversation_id, role, content, attachments, created_at, origin)
  SELECT id, conversation_id, role, content, attachments, created_at, origin FROM messages;
DROP TABLE messages;
ALTER TABLE messages_new RENAME TO messages;
CREATE INDEX idx_msg_conv ON messages(conversation_id, id);
`,
}
