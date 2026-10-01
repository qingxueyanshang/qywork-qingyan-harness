/**
 * SQLite 连接与迁移。
 *
 * 用 bun:sqlite（进程内、零编译依赖、同步 API）。同步 API 在这里是优点不是缺点：
 * 账本写入必须在「事件发给客户端之前」落盘，异步驱动只会让这个顺序更难保证。
 */

import { Database } from 'bun:sqlite'
import { MIGRATIONS, SCHEMA_VERSION } from './schema.ts'

/**
 * 打开账本的是哪一类进程：`serve`（`qy serve`，桌面端与手机端连的服务）或 `cli`（终端里的
 * `qy exec` 与交互式 `qy`）。建轮时写进 `runs.owner_kind`，同一会话被另一个进程占着时，
 * 提示据此说出占用方在哪里。
 */
export type RunOwner = 'serve' | 'cli'

export interface StoreOptions {
  /** 数据库文件路径；':memory:' 用于测试。 */
  path: string
  /** 会建轮的进程入口必须给；只读账本的命令（导出、用量、体检）与测试不给，记为未声明。 */
  owner?: RunOwner
}

/** 写锁的等待上限。主库与正文库的 `busy_timeout` 和 `enableWal` 的重试时长都取它。 */
export const BUSY_TIMEOUT_MS = 5000

/**
 * 把连接切到 WAL。
 *
 * 切日志模式要取排他锁，而 SQLite 在这一步不调用 busy handler：全新库被几个进程同时打开时，
 * 后到的连接 0 毫秒就收到 SQLITE_BUSY，构造函数当场抛出。这里按 `BUSY_TIMEOUT_MS` 同一时长重试，
 * 补上 busy_timeout 在这条语句上缺的那段等待。库已经是 WAL 时这条是空操作，不会进入重试。
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
 * 执行一条迁移：SQL 逐条执行，再跑 `apply`。
 *
 * 不要把逐条执行换回 `db.exec(m.sql)`：Bun 1.4.2 执行多条语句时只报最后一条的错，
 * 中间某条失败被吞掉，后面的 DROP / RENAME 照常执行，事务随之提交半迁移状态。
 * 实测：重建表的 INSERT 违反 CHECK 后，旧表仍被删掉，数据静默丢失。
 */
export function executeMigration(db: Database, migration: (typeof MIGRATIONS)[number]): void {
  if (migration.sql) for (const statement of splitStatements(migration.sql)) db.run(statement)
  migration.apply?.(db)
}

/**
 * 按引号与注释之外的分号切分。迁移里不写触发器：`BEGIN … END` 内部的分号在这里切不开，
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
  /** 见 `RunOwner`。null = 未声明。 */
  readonly owner: RunOwner | null

  constructor(opts: StoreOptions) {
    this.owner = opts.owner ?? null
    this.db = new Database(opts.path, { create: true })
    this.applyPragmas()
    this.migrate()
  }

  private applyPragmas(): void {
    /*
     * 并发写等待。桌面端 + 手机端同时操作时避免直接 SQLITE_BUSY。
     *
     * **必须是第一条。** 下面那条 `journal_mode` 本身就要取锁：两个进程同时开同一个
     * WAL 库时，先到的那个在做 WAL 恢复并持有排他锁，后到的收到 SQLITE_BUSY_RECOVERY。
     * 等待上限还没设，这一条就没有重试余地，构造函数当场抛。
     */
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    // WAL：读写不互相阻塞。agent 边写 step 边有 UI 在读，没有 WAL 会互相卡住。
    enableWal(this.db)
    // NORMAL：WAL 下已经足够安全（崩溃不丢已提交事务，只可能丢最后一次 checkpoint），
    // 比 FULL 快一个数量级。agent 每步都写盘，这个差别是可感知的。
    this.db.exec('PRAGMA synchronous = NORMAL')
    // 外键必须开：schema 里的 ON DELETE CASCADE 全靠它，默认是关的。
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
     * 库里有本程序不认识的迁移 = 这个文件被更新的版本写过。此时必须停在打开这一步。
     *
     * `migrate()` 只补自己没跑过的那几条，认不出的照样放行；放行之后本程序会按旧的表
     * 结构继续读写同一个文件，新版本加的列与表在这里没有写入方，两个版本轮流启动即
     * 互相覆盖。不设降级、只读或跳过开关：任何一种都让这条路径重新出现。
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
      // 上面读到的列表只用于跳过：已登记的迁移不会被撤销，跳过它总是对的。
      if (applied.has(m.id)) continue
      // 每条迁移一个事务：失败就整条回滚，不留半迁移状态。
      // IMMEDIATE 在进回调前取写权：`apply()` 可能先读后写，DEFERRED 下的升级在另一个
      // 实例同时初始化时直接回 SQLITE_BUSY，不走 busy_timeout。
      this.db
        .transaction(() => {
          // 拿到写权之后再查一次：另一个进程可能在本进程读完列表之后刚跑完这一条。
          // 不要只凭上面那份列表决定执行，否则会把已完成的迁移重跑一遍。
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
   * 写事务包装。回调抛异常即整体回滚。
   *
   * 用 IMMEDIATE 在进回调前取得写权：默认 DEFERRED 若先 SELECT 再写，
   * 遇到其他写者时是从读事务升级，SQLite 会直接回 SQLITE_BUSY，
   * 不会走 busy_timeout。写权在事务起点等待，才能既保持原子性又遵守等待上限。
   */
  tx<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate()
  }

  /**
   * 关闭连接。**不保证释放 OS 文件句柄。**
   *
   * 同一个连接上经 `db.query()` 执行过的互异 SQL 超过 `Database.MAX_QUERY_CACHE_SIZE`
   * 之后，被缓存淘汰的 prepared statement 不会 finalize，`sqlite3_close()` 返回
   * SQLITE_BUSY：`-wal` / `-shm` 留在盘上，文件在进程退出前保持占用。
   * 同进程内不要在关库之后删除或移动库文件。
   *
   * 不要传 `throwOnError`：这个失败在常规用量下每次都发生，调用方无从补救，
   * 而调用点多在 `finally` 里，抛出会替换掉正在传播的那个错误。
   */
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
