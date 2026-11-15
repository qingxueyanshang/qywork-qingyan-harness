import type { Migration } from './shared.ts'

export const migration054: Migration = {
  id: 54,
  name: 'schedules',
  /**
   * 定时任务从全机共用的 JSON 文件迁入主账本。
   *
   * 到期判定、认领与创建会话必须在同一个写事务中完成，否则两个服务实例会对同一条到期
   * 任务各启动一轮；JSON 只能在单进程内排队，无法跨进程裁决。
   *
   * 表中只有配置与触发游标：上一次的执行结果按 `last_run_conversation_id` 关联的 Run 读取。
   * 会话被删除时该列置空，`last_run_at` 保留：触发已发生是事实，与执行记录是否存在无关。
   *
   * 建表不包含数据迁移：旧文件的读取与改名由运行装配层执行，迁移不读取开发机的全局配置目录。
   */
  sql: `
CREATE TABLE schedules (
  id                       TEXT PRIMARY KEY,
  workspace_root           TEXT NOT NULL,
  title                    TEXT NOT NULL,
  prompt                   TEXT NOT NULL,
  kind                     TEXT NOT NULL CHECK (kind IN ('interval','daily')),
  every_minutes            INTEGER,
  at_hour                  INTEGER,
  at_minute                INTEGER,
  enabled                  INTEGER NOT NULL,
  created_at               INTEGER NOT NULL,
  last_run_at              INTEGER,
  last_run_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL
);
CREATE INDEX idx_schedules_workspace ON schedules(workspace_root);
CREATE INDEX idx_schedules_last_conversation ON schedules(last_run_conversation_id);
`,
}
