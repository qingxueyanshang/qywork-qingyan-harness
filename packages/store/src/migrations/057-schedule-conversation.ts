import type { Migration } from './shared.ts'

export const migration057: Migration = {
  id: 57,
  name: 'schedule_conversation',
  /**
   * 定时任务绑定会话：`last_run_conversation_id` 改名为 `conversation_id`，
   * 语义是最近一次触发所进入的会话。
   *
   * 默认触发将 prompt 作为一条用户消息发送到该列指向的会话，上下文在多次触发间延续；
   * 已有行指向最近一次触发创建的会话，保留原值即完成绑定。
   *
   * `new_conversation = 1` 的任务每次触发另建一个会话，各次互不可见，该列仍写入本次进入的
   * 会话，忙碌状态判定与终态投影因此使用同一路径。存量行默认为 0。
   *
   * 索引一并重建：`RENAME COLUMN` 会改写索引中的列引用，但不修改索引名。
   * 外键仍是 `ON DELETE SET NULL`：会话被删除后，下一次触发新建会话并写回该列。
   */
  sql: `
ALTER TABLE schedules RENAME COLUMN last_run_conversation_id TO conversation_id;
ALTER TABLE schedules ADD COLUMN new_conversation INTEGER NOT NULL DEFAULT 0;
DROP INDEX idx_schedules_last_conversation;
CREATE INDEX idx_schedules_conversation ON schedules(conversation_id);
`,
}
