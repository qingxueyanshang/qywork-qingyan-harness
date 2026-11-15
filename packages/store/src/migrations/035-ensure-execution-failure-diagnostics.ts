import type { Database } from 'bun:sqlite'
import type { Migration } from './shared.ts'

function addTextColumnIfMissing(
  db: Database,
  table: 'provider_requests' | 'runs',
  column: 'diagnostic' | 'interruption_detail',
): void {
  const exists = db
    .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
    .all()
    .some((item) => item.name === column)
  if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`)
}

export const migration035: Migration = {
  id: 35,
  name: 'ensure_execution_failure_diagnostics',
  /**
   * 按实际表结构补列，不改写已写入的迁移标记。开发数据库可能已由其他结构占用
   * 迁移编号 34，仅按编号跳过会使运行期查询引用不存在的列。
   */
  apply(db) {
    addTextColumnIfMissing(db, 'runs', 'interruption_detail')
    addTextColumnIfMissing(db, 'provider_requests', 'diagnostic')
  },
}
