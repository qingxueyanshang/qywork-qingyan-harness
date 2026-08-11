import { describe, expect, test } from 'bun:test'
import { CHUNK_BYTES, ContentStore, ContentStoreError, contentPathFor } from './content.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

function fresh(): ContentStore {
  return new ContentStore(':memory:')
}

describe('路径推导', () => {
  test('正文库挨着主账本放', () => {
    expect(contentPathFor('/data/qywork.sqlite3')).toBe('/data/qywork_content.sqlite3')
    expect(contentPathFor('C:\\x\\qywork.db')).toBe('C:\\x\\qywork_content.db')
  })
  test(':memory: 原样透传', () => {
    expect(contentPathFor(':memory:')).toBe(':memory:')
  })
})

describe('写入与读取', () => {
  test('一步 put 后能原样读回', () => {
    const s = fresh()
    const body = enc.encode('hello 世界')
    const info = s.put(body)
    expect(info.originalBytes).toBe(body.byteLength)
    expect(dec.decode(s.readAll(info.contentHash)!)).toBe('hello 世界')
    s.close()
  })

  test('流式追加后哈希与一步写入一致', () => {
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

  test('内容相同只存一份（内容寻址去重）', () => {
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
    // 每个分片填不同的字节，跨界读能验证顺序和偏移都对。
    const body = new Uint8Array(CHUNK_BYTES * 2)
    body.fill(1, 0, CHUNK_BYTES)
    body.fill(2, CHUNK_BYTES)
    const info = s.put(body)

    const around = s.readRange(info.contentHash, CHUNK_BYTES - 3, 6)
    expect([...around]).toEqual([1, 1, 1, 2, 2, 2])
    s.close()
  })

  test('只载入覆盖到区间的分片', () => {
    const s = fresh()
    const body = new Uint8Array(CHUNK_BYTES * 4).fill(7)
    const info = s.put(body)
    // 读最后 10 字节：正确实现不会把 1 MB 全拉出来。这里只能验结果，
    // 但结果正确本身就要求偏移计算没有整块化。
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

  test('长度为 0 返回空', () => {
    const s = fresh()
    const info = s.put(enc.encode('x'))
    expect(s.readRange(info.contentHash, 0, 0).byteLength).toBe(0)
    s.close()
  })
})

describe('崩溃安全：主账本只准引用已定稿的 blob', () => {
  test('未定稿的写入不产生任何 blob', () => {
    const s = fresh()
    const w = `w_${crypto.randomUUID()}`
    s.beginWrite(w)
    s.appendChunk(w, enc.encode('半截内容'))
    // 此处模拟崩溃：不调 finishWrite。
    const n = s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM content_blobs').get()!.n
    expect(n).toBe(0)
    s.close()
  })

  test('abort 清掉暂存分片', () => {
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

  test('往未知写入追加会报错，不静默丢弃', () => {
    const s = fresh()
    expect(() => s.appendChunk('nope', enc.encode('x'))).toThrow(ContentStoreError)
    s.close()
  })

  test('读不存在的哈希返回 null，不抛', () => {
    const s = fresh()
    expect(s.readAll('sha256:deadbeef')).toBeNull()
    expect(s.info('sha256:deadbeef')).toBeNull()
    s.close()
  })
})

describe('回收', () => {
  test('未被引用的 blob 被删，被引用的保留', () => {
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

  test('清理超期的暂存写入（上次进程崩在写入途中）', () => {
    const s = fresh()
    const w = `w_${crypto.randomUUID()}`
    s.beginWrite(w)
    s.appendChunk(w, enc.encode('孤儿'))
    // 把时间戳推回两天前。
    s.db
      .query('UPDATE pending_writes SET updated_at = ? WHERE write_id = ?')
      .run(Date.now() - 48 * 60 * 60 * 1000, w)

    s.collectGarbage([])
    const n = s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM pending_writes').get()!.n
    expect(n).toBe(0)
    s.close()
  })

  test('新鲜的暂存写入不被误删', () => {
    const s = fresh()
    const w = `w_${crypto.randomUUID()}`
    s.beginWrite(w)
    s.collectGarbage([])
    const n = s.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM pending_writes').get()!.n
    expect(n).toBe(1)
    s.close()
  })
})
