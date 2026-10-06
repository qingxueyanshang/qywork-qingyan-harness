/**
 * 内容寻址正文库：`qywork_content.sqlite3`，与主账本 `qywork.sqlite3` 位于同一目录。
 *
 * 写入路径是 `pending_writes(write_id)` → 追加分片 → 定稿为不可变的
 * `content_blobs(content_hash)`。主账本只能引用已定稿的 blob。
 *
 * 使用独立数据库文件的原因：正文常达数 MB（网页、命令输出、下载内容），写入主账本会使
 * 主库体积失控、VACUUM 与备份开销随之增大；而正文是可回收的（删除旧会话的正文不影响账本的结构
 * 完整性）。分开存放才能独立 GC。
 *
 * 先暂存再定稿的原因：写入是流式的，一条命令可能输出 200 MB，无法先在内存中积累并算完哈希再写入。
 * 因此先向 `pending_writes` 追加分片，结束时按最终哈希移入不可变的 `content_blobs`。
 *
 * 主账本只能引用已定稿的 blob，这是硬约束。进程在写入中途崩溃时，
 * 留下的是一条 `pending_writes` 孤儿记录（可清理），而不是账本指向的不完整正文。
 * 顺序相反（先登记再写内容）会使崩溃后的账本指向不存在或不完整的正文，
 * 这种损坏在读取时才会被发现，届时已无法修复。
 *
 * 使用内容寻址的原因：同一网页获取两次、同一段输出重复出现时只存储一份。去重是附带效果；
 * 主要目的是以哈希作为身份：分页读取的游标绑定 content_hash，
 * 正文变化时游标立即失效，而不是返回错位的内容。
 *
 * 本文件的写事务一律使用 IMMEDIATE。三处事务都先读后写（下一个分片序号、
 * 是否已有同哈希的 blob、全部 blob 列表）。DEFERRED 从读事务升级为写事务时，
 * 若另一个进程正持有写锁，SQLite 直接返回 SQLITE_BUSY，不经过 `busy_timeout`；
 * 在事务起点取得写锁才会等待。
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { log } from '@qywork/core'
import { BUSY_TIMEOUT_MS, enableWal } from './db.ts'

/** 分片大小。过小则行数激增，过大则单次读取的放大明显。 */
export const CHUNK_BYTES = 256 * 1024

export const CONTENT_SCHEMA_VERSION = 1

/**
 * 已有库转换为增量回收需执行一次全库 VACUUM，此值是允许转换的体积上限。
 *
 * 本机实测 6.3 ms/MB（1 GB 5.2 秒、2 GB 12.7 秒），512 MB 约 3 秒。
 */
const VACUUM_LIMIT_BYTES = 512 * 1024 * 1024

export class ContentStoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = 'ContentStoreError'
  }
}

export interface BlobInfo {
  contentHash: string
  originalBytes: number
  chunkCount: number
}

/** 正文库与主账本位于同一目录：`qywork.sqlite3` → `qywork_content.sqlite3`。 */
export function contentPathFor(agentDbPath: string): string {
  if (agentDbPath === ':memory:') return ':memory:'
  return agentDbPath.replace(/(\.sqlite3?|\.db)?$/i, '_content$1')
}

export class ContentStore {
  readonly db: Database
  /** 进行中的写入：write_id → 增量哈希器。哈希器无法存入 SQLite，只能保存在内存中。 */
  private readonly hashers = new Map<string, Bun.CryptoHasher>()

  constructor(path: string, opts?: { vacuumLimitBytes?: number }) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    // 必须先设置等待上限，理由与主库的 `applyPragmas` 相同：`journal_mode` 本身需要取锁。
    this.db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
    /*
     * auto_vacuum 记录在数据库头部，只有在头部写入之前设置才生效，而 `journal_mode = WAL`
     * 会写入头部，因此本条必须排在它之前。正文会被大量删除，没有它时文件只增不减，
     * `collectGarbage` 末尾的 `incremental_vacuum` 也退化为空操作。
     */
    this.db.exec('PRAGMA auto_vacuum = INCREMENTAL')
    enableWal(this.db)
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    /*
     * 头部已写成其他模式的库只能通过 VACUUM 转换：VACUUM 按当前连接的 auto_vacuum
     * 设置整体重写，完成后头部即为 INCREMENTAL。
     *
     * 只在头部不是 INCREMENTAL 时执行一次，执行之后该判断恒为假，不会再次进入。
     *
     * 超过 `VACUUM_LIMIT_BYTES` 的库不转换。构造函数在 `serve()`、`qy exec`、`qy tui`
     * 三处都在开始服务之前调用，本次 VACUUM 是同步的；本机实测 6.3 ms/MB，2 GB 需 12.7 秒，
     * 桌面端会在窗口出现之前黑屏十余秒。512 MB 约 3 秒，是启动路径上可接受的一次性上限。
     * 未转换的库照常读写，只是删除后文件不缩小，每次打开时将成因写入一行 stderr。
     */
    const mode = this.db.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()
    if (mode?.auto_vacuum !== 2) {
      const limit = opts?.vacuumLimitBytes ?? VACUUM_LIMIT_BYTES
      const bytes = this.pageBytes()
      if (bytes <= limit) this.db.exec('VACUUM')
      else {
        log.warn('content', '正文库过大，未转为增量回收：删除后页可复用但文件不缩小', {
          path,
          mb: Math.round(bytes / 1048576),
        })
      }
    }
    this.ensureSchema()
  }

  /** 当前占用的字节数。取 `page_count * page_size`，不用 `stat`：部分页仍在 WAL 中，尚未写回主文件。 */
  private pageBytes(): number {
    const pages = this.db.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count
    const size = this.db.query<{ page_size: number }, []>('PRAGMA page_size').get()?.page_size
    return (pages ?? 0) * (size ?? 0)
  }

  private ensureSchema(): void {
    this.db.exec(/* sql */ `
      CREATE TABLE IF NOT EXISTS content_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_writes (
        write_id       TEXT PRIMARY KEY,
        resource_id    TEXT,
        state          TEXT NOT NULL CHECK (state IN ('open','aborted')),
        observed_bytes INTEGER NOT NULL DEFAULT 0,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS pending_chunks (
        write_id     TEXT NOT NULL REFERENCES pending_writes(write_id) ON DELETE CASCADE,
        chunk_index  INTEGER NOT NULL,
        data         BLOB NOT NULL,
        stored_bytes INTEGER NOT NULL,
        PRIMARY KEY (write_id, chunk_index)
      );

      CREATE TABLE IF NOT EXISTS content_blobs (
        content_hash   TEXT PRIMARY KEY,
        original_bytes INTEGER NOT NULL,
        chunk_count    INTEGER NOT NULL,
        created_at     INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS content_chunks (
        content_hash TEXT NOT NULL REFERENCES content_blobs(content_hash) ON DELETE CASCADE,
        chunk_index  INTEGER NOT NULL,
        data         BLOB NOT NULL,
        stored_bytes INTEGER NOT NULL,
        PRIMARY KEY (content_hash, chunk_index)
      );
    `)
    this.db
      .query("INSERT OR IGNORE INTO content_meta(key, value) VALUES ('schema_version', ?)")
      .run(String(CONTENT_SCHEMA_VERSION))
  }

  // ─────────────────────────── 写入 ───────────────────────────

  beginWrite(writeId: string, resourceId?: string): string {
    const now = Date.now()
    try {
      this.db
        .query(
          `INSERT INTO pending_writes (write_id, resource_id, state, observed_bytes, created_at, updated_at)
           VALUES (?, ?, 'open', 0, ?, ?)`,
        )
        .run(writeId, resourceId ?? null, now, now)
    } catch {
      // 唯一约束冲突是此处唯一可能的失败，转换为具名错误。
      // 不附带原始异常：它只包含「UNIQUE constraint failed」，
      // 而调用方需要知道的是该 writeId 已被占用。
      throw new ContentStoreError('WRITE_ID_EXISTS', `写入 id 已存在：${writeId}`)
    }
    this.hashers.set(writeId, new Bun.CryptoHasher('sha256'))
    return writeId
  }

  /**
   * 追加一段正文。
   *
   * 按 `CHUNK_BYTES` 切分而不是原样存储：按调用方给出的大小存储时，
   * 一次 50 MB 的 write 会成为一行 50 MB 的 BLOB，读取时必须整块载入内存。
   */
  appendChunk(writeId: string, data: Uint8Array): number {
    if (data.byteLength === 0) return 0
    const row = this.db
      .query<{ state: string; observed_bytes: number }, [string]>(
        'SELECT state, observed_bytes FROM pending_writes WHERE write_id = ?',
      )
      .get(writeId)
    if (!row) throw new ContentStoreError('WRITE_NOT_FOUND', `未知写入 id：${writeId}`)
    if (row.state !== 'open') {
      throw new ContentStoreError('WRITE_NOT_OPEN', `写入已是 ${row.state}：${writeId}`)
    }

    const hasher = this.hashers.get(writeId)
    if (!hasher) {
      // 哈希器只存在于内存中：进程重启后旧的 pending write 无法续写，只能作废。
      throw new ContentStoreError('WRITE_NOT_RESUMABLE', `写入无法续写：${writeId}`)
    }
    hasher.update(data)

    const nextIndex =
      (this.db
        .query<{ m: number }, [string]>(
          'SELECT COALESCE(MAX(chunk_index), -1) AS m FROM pending_chunks WHERE write_id = ?',
        )
        .get(writeId)?.m ?? -1) + 1

    const stmt = this.db.query(
      'INSERT INTO pending_chunks (write_id, chunk_index, data, stored_bytes) VALUES (?,?,?,?)',
    )
    this.db
      .transaction(() => {
        let idx = nextIndex
        for (let off = 0; off < data.byteLength; off += CHUNK_BYTES) {
          const slice = data.subarray(off, Math.min(off + CHUNK_BYTES, data.byteLength))
          stmt.run(writeId, idx++, slice, slice.byteLength)
        }
        this.db
          .query(
            'UPDATE pending_writes SET observed_bytes = observed_bytes + ?, updated_at = ? WHERE write_id = ?',
          )
          .run(data.byteLength, Date.now(), writeId)
      })
      .immediate()

    return data.byteLength
  }

  /**
   * 定稿：把暂存分片移入不可变的 blob，返回内容哈希。
   *
   * 整个过程在一个事务中完成：不存在「blob 已登记但分片只移入一半」的中间状态。
   * 哈希已存在时直接丢弃暂存分片，内容寻址的去重即在此发生。
   */
  finishWrite(writeId: string): BlobInfo {
    const hasher = this.hashers.get(writeId)
    if (!hasher) throw new ContentStoreError('WRITE_NOT_FOUND', `未知写入 id：${writeId}`)
    const contentHash = `sha256:${hasher.digest('hex')}`
    this.hashers.delete(writeId)

    const meta = this.db
      .query<{ observed_bytes: number }, [string]>(
        'SELECT observed_bytes FROM pending_writes WHERE write_id = ?',
      )
      .get(writeId)
    if (!meta) throw new ContentStoreError('WRITE_NOT_FOUND', `未知写入 id：${writeId}`)

    const existing = this.db
      .query<{ original_bytes: number; chunk_count: number }, [string]>(
        'SELECT original_bytes, chunk_count FROM content_blobs WHERE content_hash = ?',
      )
      .get(contentHash)

    this.db
      .transaction(() => {
        if (!existing) {
          const count =
            this.db
              .query<{ n: number }, [string]>(
                'SELECT COUNT(*) AS n FROM pending_chunks WHERE write_id = ?',
              )
              .get(writeId)?.n ?? 0
          this.db
            .query(
              'INSERT INTO content_blobs (content_hash, original_bytes, chunk_count, created_at) VALUES (?,?,?,?)',
            )
            .run(contentHash, meta.observed_bytes, count, Date.now())
          this.db
            .query(
              `INSERT INTO content_chunks (content_hash, chunk_index, data, stored_bytes)
             SELECT ?, chunk_index, data, stored_bytes FROM pending_chunks WHERE write_id = ?`,
            )
            .run(contentHash, writeId)
        }
        // 无论是否去重，都要清除暂存数据。
        this.db.query('DELETE FROM pending_writes WHERE write_id = ?').run(writeId)
      })
      .immediate()

    return {
      contentHash,
      originalBytes: existing?.original_bytes ?? meta.observed_bytes,
      chunkCount:
        existing?.chunk_count ??
        this.db
          .query<{ chunk_count: number }, [string]>(
            'SELECT chunk_count FROM content_blobs WHERE content_hash = ?',
          )
          .get(contentHash)?.chunk_count ??
        0,
    }
  }

  abortWrite(writeId: string): void {
    this.hashers.delete(writeId)
    // 直接删除而不是标记为 aborted：暂存分片没有任何保留价值，保留只会占用空间。
    this.db.query('DELETE FROM pending_writes WHERE write_id = ?').run(writeId)
  }

  /** 一次完成写入：小正文无需流式写入的复杂度。 */
  put(raw: Uint8Array, resourceId?: string): BlobInfo {
    const writeId = `w_${crypto.randomUUID()}`
    this.beginWrite(writeId, resourceId)
    try {
      this.appendChunk(writeId, raw)
      return this.finishWrite(writeId)
    } catch (err) {
      this.abortWrite(writeId)
      throw err
    }
  }

  // ─────────────────────────── 读取 ───────────────────────────

  info(contentHash: string): BlobInfo | null {
    const row = this.db
      .query<{ original_bytes: number; chunk_count: number }, [string]>(
        'SELECT original_bytes, chunk_count FROM content_blobs WHERE content_hash = ?',
      )
      .get(contentHash)
    return row
      ? { contentHash, originalBytes: row.original_bytes, chunkCount: row.chunk_count }
      : null
  }

  /**
   * 按字节区间读取。
   *
   * 只取覆盖该区间的分片，不整块载入，这是分片存储的意义所在。
   * 读取 200 MB 输出的第 3 页不应把 200 MB 载入内存。
   */
  readRange(contentHash: string, start: number, length: number): Uint8Array {
    if (length <= 0) return new Uint8Array(0)
    const end = start + length
    const firstChunk = Math.floor(start / CHUNK_BYTES)
    const lastChunk = Math.floor((end - 1) / CHUNK_BYTES)

    const rows = this.db
      .query<{ chunk_index: number; data: Uint8Array }, [string, number, number]>(
        `SELECT chunk_index, data FROM content_chunks
         WHERE content_hash = ? AND chunk_index BETWEEN ? AND ?
         ORDER BY chunk_index ASC`,
      )
      .all(contentHash, firstChunk, lastChunk)

    const out = new Uint8Array(length)
    let written = 0
    for (const row of rows) {
      const chunkStart = row.chunk_index * CHUNK_BYTES
      const from = Math.max(0, start - chunkStart)
      const to = Math.min(row.data.byteLength, end - chunkStart)
      if (to <= from) continue
      const slice = row.data.subarray(from, to)
      out.set(slice, written)
      written += slice.byteLength
    }
    return written === length ? out : out.subarray(0, written)
  }

  readAll(contentHash: string): Uint8Array | null {
    const meta = this.info(contentHash)
    if (!meta) return null
    return this.readRange(contentHash, 0, meta.originalBytes)
  }

  // ─────────────────────────── 回收 ───────────────────────────

  /**
   * 删除没有任何引用的 blob。
   *
   * 引用集合由调用方给出（引用位于主账本中，不存在跨库外键）。
   * 传入空集合会清空整个正文库，因此调用方必须确保查询的是全量引用，
   * 而不是某个会话的局部引用。
   */
  collectGarbage(referenced: Iterable<string>): { removed: number } {
    const keep = new Set(referenced)
    const all = this.db
      .query<{ content_hash: string }, []>('SELECT content_hash FROM content_blobs')
      .all()
    let removed = 0
    const del = this.db.query('DELETE FROM content_blobs WHERE content_hash = ?')
    this.db
      .transaction(() => {
        for (const row of all) {
          if (keep.has(row.content_hash)) continue
          del.run(row.content_hash)
          removed++
        }
        // 超过 24 小时仍未定稿的暂存写入表明上次进程在写入途中崩溃，内存中的哈希器已经丢失，
        // 无法续写，保留只会占用空间。
        this.db
          .query('DELETE FROM pending_writes WHERE updated_at < ?')
          .run(Date.now() - 24 * 60 * 60 * 1000)
      })
      .immediate()
    if (removed > 0) {
      this.db.exec('PRAGMA incremental_vacuum')
      /*
       * WAL 模式下主文件在检查点时才截短。只依赖自动检查点时，回收写入的帧数不足
       * `wal_autocheckpoint`，或检查点发生在删除与回收之间，文件都保持原大小。
       * PASSIVE 不等待读者：有其他连接正在读取时本次无法完全截短，由之后的检查点完成。
       */
      this.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    }
    return { removed }
  }

  close(): void {
    this.db.close()
  }
}
