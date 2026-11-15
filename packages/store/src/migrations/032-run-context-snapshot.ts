import type { Migration } from './shared.ts'

export const migration032: Migration = {
  id: 32,
  name: 'run_context_snapshot',
  /**
   * run 开始时的非对话上下文快照。它与 run 在同一行原子写入，重启、压缩
   * 与重放都从此处读取，不再在每次 provider 请求时临时重新计算。
   *
   * NULL 只表示迁移前的历史 run；新 run 必须写入 JSON 数组（空数组也写 `[]`）。
   */
  sql: `ALTER TABLE runs ADD COLUMN context_snapshot TEXT;`,
}
