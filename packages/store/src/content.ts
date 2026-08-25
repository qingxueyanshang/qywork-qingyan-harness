/**
 * 内容寻址正文库：`agent_content.sqlite3`，与 `agent.sqlite3` 并列。
 *
 * 写入路径是 `pending_writes(write_id)` → 追加分片 → 定稿进不可变的
 * `content_blobs(content_hash)`。**主账本只准引用已定稿的 blob。**
 *
 * **为什么单独一个数据库文件。** 正文动辄几 MB（网页、命令输出、下载物），塞进主账本会有三个后果：
 * 主库体积失控、VACUUM 和备份代价随之膨胀、而正文是**可回收**的（旧会话的正文删了不影响账本的结构
 * 完整性）。分开放才能独立 GC。
 *
 * **为什么先暂存再定稿。** 写入是流式的：一条命令可能输出 200 MB，不可能先攒在内存里算完哈希再写。
 * 所以先往 `pending_writes` 追加分片，收尾时才按最终哈希搬进不可变的 `content_blobs`。
 *
 * **主账本只准引用已定稿的 blob** —— 这条是硬约束。进程在写到一半时崩溃，
 * 留下的是一条 `pending_writes` 孤儿记录（可清理），而不是一个账本指向的半截正文。
 * 反过来做（先登记再写内容）会让崩溃后的账本指向不存在或不完整的正文，
 * 而那种损坏是读的时候才发现的，届时已经无从修复。
 *
 * **为什么内容寻址。** 同一个网页抓两次、同一段输出重复出现，只存一份。去重是副产品；
 * 主要目的是**哈希即身份**：分页读取的游标绑定 content_hash，
 * 正文变了游标立刻失效，而不是返回错位内容。
 */

import { Database } from 'bun:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 分片大小。太小则行数暴涨，太大则单次读放大明显。 */
export const CHUNK_BYTES = 256 * 1024

export const CONTENT_SCHEMA_VERSION = 1

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

/** 主账本挨着放：`qywork.sqlite3` → `qywork_content.sqlite3`。 */
export function contentPathFor(agentDbPath: string): string {
  if (agentDbPath === ':memory:') return ':memory:'
  return agentDbPath.replace(/(\.sqlite3?|\.db)?$/i, '_content$1')
}

export function canonicalSha256(raw: Uint8Array): string {
  const h = new Bun.CryptoHasher('sha256')
  h.update(raw)
  return `sha256:${h.digest('hex')}`
}

export class ContentStore {
  readonly db: Database
  /** 进行中的写入：write_id → 滚动哈希器。哈希器不能存 SQLite，只能在内存里滚。 */
  private readonly hashers = new Map<string, Bun.CryptoHasher>()

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.ensureSchema()
  }

  private ensureSchema(): void {
    // auto_vacuum 必须在建表**之前**设置，建表后再设是空操作。
    // 正文是会被大量删除的，没有它文件只增不减。
    const hasTables = this.db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'")
      .get()
    if ((hasTables?.n ?? 0) === 0) this.db.exec('PRAGMA auto_vacuum = INCREMENTAL')

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
      // 唯一约束是这里唯一可能的失败，转成有名字的错误。
      // 原始异常不带上：它只会说「UNIQUE constraint failed」，
      // 而调用方要知道的是「这个 writeId 已经被占了」。
      throw new ContentStoreError('WRITE_ID_EXISTS', `写入 id 已存在：${writeId}`)
    }
    this.hashers.set(writeId, new Bun.CryptoHasher('sha256'))
    return writeId
  }

  /**
   * 追加一段正文。
   *
   * 按 `CHUNK_BYTES` 切分而不是原样存：调用方给多大就存多大的话，
   * 一次 50 MB 的 write 会变成一行 50 MB 的 BLOB，读的时候必须整块载入内存。
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
      // 哈希器只存在于内存：进程重启后旧的 pending write 无法续写，只能作废。
      throw new ContentStoreError('WRITE_NOT_RESUMABLE', `写入不可续：${writeId}`)
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
    this.db.transaction(() => {
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
    })()

    return data.byteLength
  }

  /**
   * 定稿：把暂存分片搬进不可变的 blob，返回内容哈希。
   *
   * 整体在一个事务里：**不存在「blob 已登记但分片只搬了一半」的中间态**。
   * 哈希已存在时直接丢弃暂存分片——内容寻址的去重就在这里发生。
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

    this.db.transaction(() => {
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
      // 无论是否去重，暂存都要清掉。
      this.db.query('DELETE FROM pending_writes WHERE write_id = ?').run(writeId)
    })()

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
    // 直接删而不是标 aborted：暂存分片没有任何保留价值，留着只是占空间。
    this.db.query('DELETE FROM pending_writes WHERE write_id = ?').run(writeId)
  }

  /** 一步到位：小正文不需要流式写入的复杂度。 */
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
   * 只取覆盖到该区间的分片，不整块载入——这正是分片存储的意义所在。
   * 读一个 200 MB 输出的第 3 页不该把 200 MB 拉进内存。
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
   * 删掉没有任何引用的 blob。
   *
   * 引用集合由**调用方**给出（它在主账本里，跨库外键不存在）。
   * 传空集合会清空整个正文库——所以调用方必须确保它查的是全量引用，
   * 而不是某个会话的局部引用。
   */
  collectGarbage(referenced: Iterable<string>): { removed: number } {
    const keep = new Set(referenced)
    const all = this.db
      .query<{ content_hash: string }, []>('SELECT content_hash FROM content_blobs')
      .all()
    let removed = 0
    const del = this.db.query('DELETE FROM content_blobs WHERE content_hash = ?')
    this.db.transaction(() => {
      for (const row of all) {
        if (keep.has(row.content_hash)) continue
        del.run(row.content_hash)
        removed++
      }
      // 超过 24 小时还没定稿的暂存写入 = 上次进程崩在写入途中，内存里的哈希器早已丢失，
      // 续写不可能，留着纯占空间。
      this.db
        .query('DELETE FROM pending_writes WHERE updated_at < ?')
        .run(Date.now() - 24 * 60 * 60 * 1000)
    })()
    if (removed > 0) this.db.exec('PRAGMA incremental_vacuum')
    return { removed }
  }

  close(): void {
    this.db.close()
  }
}
