import type { Migration } from './shared.ts'

export const migration022: Migration = {
  id: 22,
  name: 'goals',
  /**
   * 目标与自动继续的账本。
   *
   * **每次变更写一行，附带完整快照。** 不采用单行目标就地 UPDATE：目标需要说明
   * 停止的原因，而就地更新只保留最后一次状态，中间的暂停、改写、
   * 轮次推进全部丢失，而这些正是用户回看时需要的内容。
   *
   * **主键即 `(goal_id, revision)`，不另设事件 id。** 复合主键将
   * 「同一 revision 不得写入两次」变为数据库层的约束，两个写入方冲突时
   * 后写入者直接抛错，而不是追加第二条同版本的记录且不报错。
   *
   * **会话的最新目标通过 `ORDER BY goal_id DESC` 获取**：`gl_` 前缀之后
   * 是定宽单调 id（`core/domain/ids.ts`），字典序严格等于创建顺序。
   * 因此无需自增列，也不存在自增 id 删除后被复用的问题。
   *
   * 索引包含 `conversation_id`：外键的级联删除依赖它，无索引即全表扫描。
   */
  sql: /* sql */ `
CREATE TABLE goal_events (
  goal_id         TEXT NOT NULL,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  revision        INTEGER NOT NULL,
  snapshot        TEXT NOT NULL,
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (goal_id, revision)
);
CREATE INDEX idx_goal_events_conv ON goal_events(conversation_id, goal_id);
`,
}
