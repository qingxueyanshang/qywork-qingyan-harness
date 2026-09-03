/**
 * SQLite 连接与迁移。
 *
 * 用 bun:sqlite（进程内、零编译依赖、同步 API）。同步 API 在这里是优点不是缺点：
 * 账本写入必须在「事件发给客户端之前」落盘，异步驱动只会让这个顺序更难保证。
 */

import { Database } from 'bun:sqlite'
import { MIGRATIONS } from './schema.ts'

export interface StoreOptions {
  /** 数据库文件路径；':memory:' 用于测试。 */
  path: string
}

export class Store {
  readonly db: Database

  constructor(opts: StoreOptions) {
    this.db = new Database(opts.path, { create: true })
    this.applyPragmas()
    this.migrate()
  }

  private applyPragmas(): void {
    // WAL：读写不互相阻塞。agent 边写 step 边有 UI 在读，没有 WAL 会互相卡住。
    this.db.exec('PRAGMA journal_mode = WAL')
    // NORMAL：WAL 下已经足够安全（崩溃不丢已提交事务，只可能丢最后一次 checkpoint），
    // 比 FULL 快一个数量级。agent 每步都写盘，这个差别是可感知的。
    this.db.exec('PRAGMA synchronous = NORMAL')
    // 外键必须开：schema 里的 ON DELETE CASCADE 全靠它，默认是关的。
    this.db.exec('PRAGMA foreign_keys = ON')
    // 并发写等待。桌面端 + 手机端同时操作时避免直接 SQLITE_BUSY。
    this.db.exec('PRAGMA busy_timeout = 5000')
  }

  private migrate(): void {
    this.db.exec(
      'CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
    )
    const applied = new Set(
      this.db
        .query<{ id: number }, []>('SELECT id FROM _migrations')
        .all()
        .map((r) => r.id),
    )
    for (const m of MIGRATIONS) {
      if (applied.has(m.id)) continue
      // 每条迁移一个事务：失败就整条回滚，不留半迁移状态。
      this.db.transaction(() => {
        if (m.sql) this.db.exec(m.sql)
        m.apply?.(this.db)
        this.db
          .query('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)')
          .run(m.id, m.name, Date.now())
      })()
    }
  }

  /**
   * 写事务包装。回调抛异常即整体回滚。
   *
   * 用 IMMEDIATE 在进回调前取得写权：默认 DEFERRED 若先 SELECT 再写，
   * 遇到其他写者时是从读事务升级，SQLite 会直接回 SQLITE_BUSY，
   * 不会走 busy_timeout。写权在事务起点等待，才能既保持原子性又遵守等待上限。
   */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate()
  }

  close(): void {
    this.db.close()
  }
}

/** JSON 列的读写助手：null 与 'null' 必须能区分开。 */
export function readJson<T>(raw: string | null, fallback: T): T {
  if (raw === null || raw === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

export function writeJson(value: unknown): string | null {
  return value === null || value === undefined ? null : JSON.stringify(value)
}
