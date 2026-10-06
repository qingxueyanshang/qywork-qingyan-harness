/**
 * SQLite 连接与迁移。
 *
 * 使用 bun:sqlite（进程内、无编译依赖、同步 API）。同步 API 在此处是优点：
 * 账本写入必须在事件发给客户端之前落盘，异步驱动会使该顺序更难保证。
 */

import { Database } from 'bun:sqlite'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts'

/**
 * 打开账本的进程类别：`serve`（`qy serve`，桌面端与手机端连接的服务）或 `cli`（终端中的
 * `qy exec` 与交互式 `qy`）。创建轮次时写入 `runs.owner_kind`，同一会话被另一个进程占用时，
 * 提示据此指明占用方的位置。
 */
export type RunOwner = 'serve' | 'cli'

export interface StoreOptions {
  /** 数据库文件路径；':memory:' 用于测试。 */
  path: string
  /** 会创建轮次的进程入口必须提供；只读账本的命令（导出、用量、体检）与测试不提供，记为未声明。 */
  owner?: RunOwner
}

/** 写锁的等待上限。主库与正文库的 `busy_timeout` 以及 `enableWal` 的重试时长都取此值。 */
export const BUSY_TIMEOUT_MS = 5000

/**
 * 把连接切换到 WAL。
 *
 * 切换日志模式需要取得排他锁，而 SQLite 在这一步不调用 busy handler：全新库被多个进程同时打开时，
 * 后到的连接在 0 毫秒时即收到 SQLITE_BUSY，构造函数立即抛出。此处按 `BUSY_TIMEOUT_MS` 同一时长重试，
 * 补足 busy_timeout 在该语句上缺失的等待。库已是 WAL 时该语句是空操作，不会进入重试。
 */
export function enableWal(db: Database): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS
  for (;;) {
    try {
      db.exec('PRAGMA journal_mode = WAL')
      return
    } catch (err) {
      const code = String((err as { code?: unknown }).code ?? '')
      if (!code.startsWith('SQLITE_BUSY') || Date.now() >= deadline) throw err
      Bun.sleepSync(10)
    }
  }
}

/**
 * 执行一条迁移：SQL 逐条执行，再执行 `apply`。
 *
 * 不要把逐条执行改为 `db.exec(m.sql)`：Bun 1.4.2 执行多条语句时只报告最后一条的错误，
 * 中间某条失败时不报错，后续的 DROP / RENAME 照常执行，事务随之提交迁移到一半的状态。
 * 实测：重建表的 INSERT 违反 CHECK 后，旧表仍被删除，数据静默丢失。
 */
export function executeMigration(db: Database, migration: (typeof MIGRATIONS)[number]): void {
  if (migration.sql) for (const statement of splitStatements(migration.sql)) db.run(statement)
  migration.apply?.(db)
}

/**
 * 按引号与注释之外的分号切分。迁移中不写触发器：此处无法正确切分 `BEGIN … END` 内部的分号，
 * 需要触发器时改用 `apply`。
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = []
  let start = 0
  let i = 0
  const push = (end: number) => {
    const statement = sql.slice(start, end)
    const code = statement.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, '').trim()
    if (/\bCREATE\s+TRIGGER\b/i.test(code)) throw new Error('迁移 SQL 不支持触发器，改用 apply')
    if (code) statements.push(statement)
  }
  while (i < sql.length) {
    const c = sql[i]
    if (c === "'" || c === '"') {
      const close = sql.indexOf(c, i + 1)
      i = close < 0 ? sql.length : close + 1
    } else if (c === '-' && sql[i + 1] === '-') {
      const newline = sql.indexOf('\n', i)
      i = newline < 0 ? sql.length : newline + 1
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2)
      i = close < 0 ? sql.length : close + 2
    } else {
      if (c === ';') {
        push(i)
        start = i + 1
      }
      i++
    }
  }
  push(sql.length)
  return statements
}

export class Store {
  readonly db: Database
  /** 见 `RunOwner`。null 表示未声明。 */
  readonly owner: RunOwner | null

  constructor(opts: StoreOptions) {
    this.owner = opts.owner ?? null
    this.db = new Database(opts.path, { create: true })
    this.applyPragmas()
    this.migrate()
  }

  private applyPragmas(): void {
    /*
     * 并发写入等待。桌面端与手机端同时操作时避免直接返回 SQLITE_BUSY。
     *
     * 必须是第一条。下方的 `journal_mode` 本身需要取锁：两个进程同时打开同一个
     * WAL 库时，先到的进程正在执行 WAL 恢复并持有排他锁，后到的进程收到 SQLITE_BUSY_RECOVERY。
     * 若尚未设置等待上限，该语句没有重试余地，构造函数立即抛出异常。
     */
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    // WAL：读写互不阻塞。agent 写入 step 的同时界面在读取，没有 WAL 时两者互相阻塞。
    enableWal(this.db)
    // NORMAL：WAL 下已足够安全（崩溃不丢失已提交事务，只可能丢失最后一次 checkpoint），
    // 比 FULL 快一个数量级。agent 每一步都写入磁盘，该差别可被感知。
    this.db.exec('PRAGMA synchronous = NORMAL')
    // 必须开启外键：schema 中的 ON DELETE CASCADE 依赖它，SQLite 默认关闭外键。
    this.db.exec('PRAGMA foreign_keys = ON')
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
    /*
     * 库中存在本程序无法识别的迁移，表明该文件被更新的版本写入过。此时必须在打开阶段停止。
     *
     * `migrate()` 只补执行本程序未执行过的迁移，无法识别的迁移也会放行；放行之后本程序会按旧的表
     * 结构继续读写同一个文件，新版本添加的列与表在本程序中没有写入方，两个版本轮流启动即
     * 互相覆盖。不设降级、只读或跳过开关：任何一种都会使该路径重新出现。
     */
    const ahead = [...applied].filter((id) => id > SCHEMA_VERSION)
    if (ahead.length > 0) {
      const newest = Math.max(...ahead)
      const file = this.db.filename
      this.db.close()
      throw new Error(
        `数据库的结构版本 ${newest} 高于本程序的 ${SCHEMA_VERSION}，请升级 qywork 后再打开：${file}`,
      )
    }
    for (const m of MIGRATIONS) {
      // 上方读取的列表只用于跳过：已登记的迁移不会被撤销，跳过它总是正确的。
      if (applied.has(m.id)) continue
      // 每条迁移一个事务：失败时整条回滚，不留下迁移到一半的状态。
      // IMMEDIATE 在进入回调前取得写权：`apply()` 可能先读后写，DEFERRED 下的升级在另一个
      // 实例同时初始化时直接返回 SQLITE_BUSY，不经过 busy_timeout。
      this.db
        .transaction(() => {
          // 取得写权之后再查询一次：另一个进程可能在本进程读取列表之后刚好执行完该迁移。
          // 不要只凭上方的列表决定是否执行，否则会把已完成的迁移重新执行一遍。
          if (this.db.query('SELECT 1 FROM _migrations WHERE id = ?').get(m.id)) return
          executeMigration(this.db, m)
          this.db
            .query('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)')
            .run(m.id, m.name, Date.now())
        })
        .immediate()
    }
  }

  /**
   * 写事务包装。回调抛出异常即整体回滚。
   *
   * 使用 IMMEDIATE 在进入回调前取得写权：默认的 DEFERRED 若先 SELECT 再写入，
   * 遇到其他写入者时会从读事务升级，SQLite 直接返回 SQLITE_BUSY，
   * 不经过 busy_timeout。在事务起点等待写权，才能既保持原子性又遵守等待上限。
   */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate()
  }

  /**
   * 关闭连接。不保证释放操作系统的文件句柄。
   *
   * 同一个连接上经 `db.query()` 执行过的互异 SQL 超过 `Database.MAX_QUERY_CACHE_SIZE`
   * 之后，被缓存淘汰的 prepared statement 不会 finalize，`sqlite3_close()` 返回
   * SQLITE_BUSY：`-wal` / `-shm` 留在磁盘上，文件在进程退出前保持占用。
   * 同一进程内不要在关闭数据库之后删除或移动库文件。
   *
   * 不要传 `throwOnError`：该失败在常规用量下每次都会发生，调用方无从补救，
   * 而调用点多在 `finally` 中，抛出会替换正在传播的错误。
   */
  close(): void {
    this.db.close()
  }
}

/** JSON 列的读写辅助函数：null 与 'null' 必须能够区分。 */
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
