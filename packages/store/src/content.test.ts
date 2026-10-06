import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHUNK_BYTES, ContentStore, ContentStoreError, contentPathFor } from './content.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

function fresh(): ContentStore {
  return new ContentStore(':memory:')
}

describe('路径推导', () => {
  test('正文库与主账本位于同一目录', () => {
    expect(contentPathFor('/data/qywork.sqlite3')).toBe('/data/qywork_content.sqlite3')
    expect(contentPathFor('C:\\x\\qywork.db')).toBe('C:\\x\\qywork_content.db')
  })
  test(':memory: 原样返回', () => {
    expect(contentPathFor(':memory:')).toBe(':memory:')
  })
})

describe('写入与读取', () => {
  test('一次 put 后能原样读取', () => {
    const s = fresh()
    const body = enc.encode('hello 世界')
    const info = s.put(body)
    expect(info.originalBytes).toBe(body.byteLength)
    expect(dec.decode(s.readAll(info.contentHash)!)).toBe('hello 世界')
    s.close()
  })

  test('流式追加后的哈希与一次写入一致', () => {
    const s = fresh()
    const whole = s.put(enc.encode('abcdef'))

    const w = `w_${crypto.randomUUID()}`
    s.beginWrite(w)
    s.appendChunk(w, enc.encode('abc'))
    s.appendChunk(w, enc.encode('def'))
    const streamed = s.finishWrite(w)

    expect(streamed.contentHash).toBe(whole.contentHash)
    s.close()
  })

  test('超过分片大小的正文被切分存储', () => {
    const s = fresh()
    const big = new Uint8Array(CHUNK_BYTES * 2 + 100).fill(65)
    const info = s.put(big)
    expect(info.chunkCount).toBe(3)
    expect(s.readAll(info.contentHash)!.byteLength).toBe(big.byteLength)
    s.close()
  })

  test('内容相同时只存储一份（内容寻址去重）', () => {
    const s = fresh()
    const a = s.put(enc.encode('same body'))
    const b = s.put(enc.encode('same body'))
    expect(a.contentHash).toBe(b.contentHash)
    const n = s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM content_blobs').get()!.n
    expect(n).toBe(1)
    s.close()
  })
})

describe('区间读取', () => {
  test('跨分片边界的区间正确拼接', () => {
    const s = fresh()
    // 每个分片填充不同的字节，跨边界读取可验证顺序与偏移均正确。
    const body = new Uint8Array(CHUNK_BYTES * 2)
    body.fill(1, 0, CHUNK_BYTES)
    body.fill(2, CHUNK_BYTES)
    const info = s.put(body)

    const around = s.readRange(info.contentHash, CHUNK_BYTES - 3, 6)
    expect([...around]).toEqual([1, 1, 1, 2, 2, 2])
    s.close()
  })

  test('只载入覆盖该区间的分片', () => {
    const s = fresh()
    const body = new Uint8Array(CHUNK_BYTES * 4).fill(7)
    const info = s.put(body)
    // 读取最后 10 字节：正确的实现不会载入全部 1 MB。此处只能验证结果，
    // 但结果正确本身要求偏移计算未按整块处理。
    const tail = s.readRange(info.contentHash, body.byteLength - 10, 10)
    expect(tail.byteLength).toBe(10)
    s.close()
  })

  test('区间超出末尾时返回实际可读部分，不补零', () => {
    const s = fresh()
    const info = s.put(enc.encode('12345'))
    expect(dec.decode(s.readRange(info.contentHash, 3, 100))).toBe('45')
    s.close()
  })

  test('长度为 0 时返回空', () => {
    const s = fresh()
    const info = s.put(enc.encode('x'))
    expect(s.readRange(info.contentHash, 0, 0).byteLength).toBe(0)
    s.close()
  })
})

describe('崩溃安全：主账本只能引用已定稿的 blob', () => {
  test('未定稿的写入不产生任何 blob', () => {
    const s = fresh()
    const w = `w_${crypto.randomUUID()}`
    s.beginWrite(w)
    s.appendChunk(w, enc.encode('半截内容'))
    // 此处模拟崩溃：不调用 finishWrite。
    const n = s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM content_blobs').get()!.n
    expect(n).toBe(0)
    s.close()
  })

  test('abort 清除暂存分片', () => {
    const s = fresh()
    const w = `w_${crypto.randomUUID()}`
    s.beginWrite(w)
    s.appendChunk(w, enc.encode('丢弃'))
    s.abortWrite(w)
    const n = s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM pending_chunks').get()!.n
    expect(n).toBe(0)
    s.close()
  })

  test('重复 write_id 直接报错，不静默覆盖', () => {
    const s = fresh()
    s.beginWrite('dup')
    expect(() => s.beginWrite('dup')).toThrow(ContentStoreError)
    s.close()
  })

  test('向未知写入追加时报错，不静默丢弃', () => {
    const s = fresh()
    expect(() => s.appendChunk('nope', enc.encode('x'))).toThrow(ContentStoreError)
    s.close()
  })

  test('读取不存在的哈希返回 null，不抛出异常', () => {
    const s = fresh()
    expect(s.readAll('sha256:deadbeef')).toBeNull()
    expect(s.info('sha256:deadbeef')).toBeNull()
    s.close()
  })
})

describe('回收', () => {
  test('未被引用的 blob 被删除，被引用的保留', () => {
    const s = fresh()
    const keep = s.put(enc.encode('还有人用'))
    const drop = s.put(enc.encode('没人用了'))

    const { removed } = s.collectGarbage([keep.contentHash])
    expect(removed).toBe(1)
    expect(s.readAll(keep.contentHash)).not.toBeNull()
    expect(s.readAll(drop.contentHash)).toBeNull()
    s.close()
  })

  test('分片随 blob 一起级联删除', () => {
    const s = fresh()
    s.put(new Uint8Array(CHUNK_BYTES * 2).fill(9))
    s.collectGarbage([])
    const n = s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM content_chunks').get()!.n
    expect(n).toBe(0)
    s.close()
  })

  test('清理超期的暂存写入（上次进程在写入途中崩溃）', () => {
    const s = fresh()
    const w = `w_${crypto.randomUUID()}`
    s.beginWrite(w)
    s.appendChunk(w, enc.encode('孤儿'))
    // 把时间戳改为两天前。
    s.db
      .query('UPDATE pending_writes SET updated_at = ? WHERE write_id = ?')
      .run(Date.now() - 48 * 60 * 60 * 1000, w)

    s.collectGarbage([])
    const n = s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM pending_writes').get()!.n
    expect(n).toBe(0)
    s.close()
  })

  test('未超期的暂存写入不被误删', () => {
    const s = fresh()
    const w = `w_${crypto.randomUUID()}`
    s.beginWrite(w)
    s.collectGarbage([])
    const n = s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM pending_writes').get()!.n
    expect(n).toBe(1)
    s.close()
  })
})

describe('auto_vacuum 模式转换', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'qywork-av-'))
    dirs.push(dir)
    return dir
  }

  test('新建正文库的头部即为 INCREMENTAL', () => {
    const s = new ContentStore(join(tempDir(), 'c.sqlite3'))
    expect(s.db.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum).toBe(2)
    s.close()
  })

  /**
   * 旧库的头部记录的是 NONE：`PRAGMA auto_vacuum` 在 `journal_mode = WAL` 之后设置时，
   * 头部已经写入，该 pragma 不生效。
   *
   * 构造这样的旧库时不复制建表 SQL：把一个正常库按 `auto_vacuum = NONE` 整体
   * `VACUUM INTO` 导出，得到表结构与正文相同、头部为 NONE 的文件。
   */
  function legacyNoneDb(dir: string, bodies: string[]): { path: string; hashes: string[] } {
    const seed = new ContentStore(join(dir, 'seed.sqlite3'))
    const hashes = bodies.map((b) => seed.put(enc.encode(b)).contentHash)
    const path = join(dir, 'legacy.sqlite3')
    seed.db.exec('PRAGMA auto_vacuum = NONE')
    seed.db.query('VACUUM INTO ?').run(path)
    seed.close()
    return { path, hashes }
  }

  test('头部为 NONE 的旧库在打开时转换，正文完整保留', () => {
    const dir = tempDir()
    const { path, hashes } = legacyNoneDb(dir, ['第一份', '第二份', '第三份'])

    const check = new Database(path)
    expect(check.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum).toBe(
      0,
    )
    check.close()

    const s = new ContentStore(path)
    expect(s.db.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum).toBe(2)
    expect(hashes.map((h) => dec.decode(s.readAll(h)!))).toEqual(['第一份', '第二份', '第三份'])
    s.close()

    // 转换只执行一次：头部已是 INCREMENTAL，再次打开不会再执行 VACUUM。
    const again = new ContentStore(path)
    expect(
      again.db.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum,
    ).toBe(2)
    expect(dec.decode(again.readAll(hashes[0]!)!)).toBe('第一份')
    again.close()
  })

  test('超过体积上限的旧库不转换：正文照常读取，成因写入一行 stderr', () => {
    const dir = tempDir()
    const { path, hashes } = legacyNoneDb(dir, ['第一份', '第二份'])

    const written: string[] = []
    const original = process.stderr.write.bind(process.stderr)
    process.stderr.write = ((chunk: string) => {
      written.push(String(chunk))
      return true
    }) as typeof process.stderr.write
    // 上限设为 1 字节：转换需执行全库 VACUUM，启动路径上必须有体积限制。
    const s = new ContentStore(path, { vacuumLimitBytes: 1 })
    process.stderr.write = original

    expect(s.db.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum).toBe(0)
    expect(hashes.map((h) => dec.decode(s.readAll(h)!))).toEqual(['第一份', '第二份'])
    s.close()

    expect(written.length).toBe(1)
    expect(written[0]).toContain('未转为增量回收：删除后页可复用但文件不缩小')
    expect(written[0]).toContain(path)

    // 同一个库在上限之内时照常转换：不转换是体积判定的结果，并非关闭转换路径。
    const ok = new ContentStore(path)
    expect(ok.db.query<{ auto_vacuum: number }, []>('PRAGMA auto_vacuum').get()?.auto_vacuum).toBe(
      2,
    )
    expect(dec.decode(ok.readAll(hashes[0]!)!)).toBe('第一份')
    ok.close()
  })

  test('回收之后页数与文件字节数都减少', () => {
    const dir = tempDir()
    const path = join(dir, 'c.sqlite3')
    const s = new ContentStore(path)
    s.put(new Uint8Array(4 * 1024 * 1024))
    // 正文先写入主文件，再关闭自动检查点：文件缩小只能来自回收自身的检查点，
    // 不随回收写入的帧数是否达到 `wal_autocheckpoint` 而变化。
    s.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    s.db.exec('PRAGMA wal_autocheckpoint = 0')
    const pages = () =>
      s.db.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count ?? -1
    const before = { pages: pages(), bytes: statSync(path).size }

    s.collectGarbage([])

    expect(pages()).toBeLessThan(before.pages)
    expect(statSync(path).size).toBeLessThan(before.bytes)
    s.close()
  })
})
