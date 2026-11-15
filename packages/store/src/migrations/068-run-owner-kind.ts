import type { Migration } from './shared.ts'

export const migration068: Migration = {
  id: 68,
  name: 'run_owner_kind',
  /**
   * 占用该轮的进程类别：`serve`（桌面端与手机端连接的服务）或 `cli`（终端的 qy）。
   * 另一个进程在同一会话上启动一轮被拒绝时，提示据此说明占用方的位置。
   * NULL 表示迁移前的旧行，或建库时未声明进程类别（测试）。不回填。
   */
  sql: `ALTER TABLE runs ADD COLUMN owner_kind TEXT;`,
}
