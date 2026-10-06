import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunId } from '@qywork/core'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  createRun,
  getResource,
  listResourcesForRun,
  registerResource,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import { collectResourceGarbage, RuntimeSink } from './sink.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

function fresh() {
  const store = new Store({ path: ':memory:' })
  const content = new ContentStore(':memory:')
  const ws = upsertWorkspace(store, '/tmp/ws', 'ws')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'p',
    model: 'm',
    title: 't',
  })
  const run = createRun(store, {
    conversationId: conv.id,
    workspaceId: ws.id,
    model: 'm',
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  return { store, content, run, sink: new RuntimeSink(store, content, run.id) }
}

describe('落盘顺序：正文先定稿，账本后登记', () => {
  test('land 之后账本行与正文均存在，且哈希一致', () => {
    const { store, content, sink } = fresh()
    const body = enc.encode('完整的命令输出'.repeat(100))

    const { resourceId, contentHash } = sink.land({
      toolName: 'run_command',
      sourceType: 'shell:stdout',
      body,
      mimeType: 'text/plain',
      coverage: { totalBytes: body.byteLength, truncated: true },
    })

    const row = getResource(store, resourceId)!
    expect(row.contentHash).toBe(contentHash)
    expect(row.sizeBytes).toBe(body.byteLength)
    expect(row.status).toBe('complete')
    expect(dec.decode(content.readAll(contentHash)!)).toBe(dec.decode(body))
    store.close()
    content.close()
  })

  test('正文库写入失败时不留下账本孤儿行', () => {
    const { store, content, sink } = fresh()
    content.close() // 模拟正文库不可用

    expect(() =>
      sink.land({ toolName: 'run_command', sourceType: 'shell', body: enc.encode('x') }),
    ).toThrow()

    // 关键断言：账本中没有指向不存在正文的行。
    // 顺序颠倒的实现（先登记再写入正文）会在此处留下一行无法读取的资源。
    const rows = store.db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM intermediate_resources')
      .get()!
    expect(rows.n).toBe(0)
    store.close()
  })

  test('覆盖信息原样保存', () => {
    const { store, content, sink } = fresh()
    const { resourceId } = sink.land({
      toolName: 'web_fetch',
      sourceType: 'http',
      body: enc.encode('page'),
      coverage: { totalBytes: 999, deliveredBytes: 4, truncated: true, query: 'https://x.dev' },
    })
    const row = getResource(store, resourceId)!
    expect(row.coverage.query).toBe('https://x.dev')
    expect(row.coverage.totalBytes).toBe(999)
    store.close()
    content.close()
  })
})

describe('读取', () => {
  test('按偏移分段读取，拼接结果等于原文', () => {
    const { store, content, sink } = fresh()
    const text = '0123456789'.repeat(50)
    const { resourceId } = sink.land({
      toolName: 'run_command',
      sourceType: 'shell',
      body: enc.encode(text),
    })

    let acc = ''
    for (let off = 0; off < text.length; off += 137) {
      acc += dec.decode(sink.read(resourceId, off, 137)!)
    }
    expect(acc).toBe(text)
    store.close()
    content.close()
  })

  test('stat 以内容库为准：正文被回收后必须报告不存在', () => {
    const { store, content, sink } = fresh()
    const { resourceId } = sink.land({
      toolName: 'run_command',
      sourceType: 'shell',
      body: enc.encode('will be collected'),
    })
    expect(sink.stat(resourceId)).not.toBeNull()

    // 以空引用集合模拟 run 被删除、正文被 GC 回收的情形，账本行仍保留（由测试直接构造）。
    content.collectGarbage([])

    // 账本行仍在，正文已删除。必须返回 null，而不是返回一个无法读取的长度：
    // 后者会使模型按该长度调用 read_resource，收到空内容却判定为已读完。
    expect(sink.stat(resourceId)).toBeNull()
    store.close()
    content.close()
  })

  test('未知 resource id 返回 null 而不是抛出异常', () => {
    const { store, content, sink } = fresh()
    expect(sink.stat('rs_nope')).toBeNull()
    expect(sink.read('rs_nope', 0, 10)).toBeNull()
    store.close()
    content.close()
  })
})

describe('回收', () => {
  test('仍被账本引用的正文不会被删除', () => {
    const { store, content, sink } = fresh()
    const { resourceId } = sink.land({
      toolName: 'run_command',
      sourceType: 'shell',
      body: enc.encode('还在用'),
    })

    const { removed } = collectResourceGarbage(store, content)
    expect(removed).toBe(0)
    expect(sink.stat(resourceId)).not.toBeNull()
    store.close()
    content.close()
  })

  test('run 被删除后正文随之可回收', () => {
    const { store, content, sink, run } = fresh()
    sink.land({ toolName: 'run_command', sourceType: 'shell', body: enc.encode('随 run 消失') })

    // 删除 run 会级联删除 intermediate_resources 行，引用随之消失。
    store.db.query('DELETE FROM runs WHERE id = ?').run(run.id)
    expect(listResourcesForRun(store, run.id)).toHaveLength(0)

    const { removed } = collectResourceGarbage(store, content)
    expect(removed).toBe(1)
    store.close()
    content.close()
  })

  test('两条记录指向同一份正文时，删除其中一条后另一条仍可读取（内容寻址去重）', () => {
    const { store, content, sink, run } = fresh()
    const body = enc.encode('一模一样的输出')
    const a = sink.land({ toolName: 'run_command', sourceType: 'shell', body })
    const b = sink.land({ toolName: 'run_command', sourceType: 'shell', body })
    expect(a.contentHash).toBe(b.contentHash)

    store.db.query('DELETE FROM intermediate_resources WHERE id = ?').run(a.resourceId)
    collectResourceGarbage(store, content)

    // b 仍引用同一个哈希，正文必须保留。
    expect(sink.stat(b.resourceId)).not.toBeNull()
    expect(listResourcesForRun(store, run.id)).toHaveLength(1)
    store.close()
    content.close()
  })
})

/*
 * 正文定稿之后、引用登记之前的交错执行。
 *
 * 此处的两组连接指向同一对库文件。`:memory:` 无法构造该场景：内存库的每个连接各有一份数据，
 * 第二个连接无法读取第一个连接的写入，也就不存在锁竞争。
 */
describe('正文定稿与引用登记之间的交错', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
  })

  function onDisk() {
    const dir = mkdtempSync(join(tmpdir(), 'qywork-sink-'))
    dirs.push(dir)
    const dbPath = join(dir, 'a.sqlite3')
    const store = new Store({ path: dbPath })
    const ws = upsertWorkspace(store, dir, 'ws')
    const conv = createConversation(store, {
      workspaceId: ws.id,
      provider: 'p',
      model: 'm',
      title: 't',
    })
    const run = createRun(store, {
      conversationId: conv.id,
      workspaceId: ws.id,
      model: 'm',
      clientRequestId: crypto.randomUUID(),
      userMessageId: null,
      messageIdUpperBound: null,
      contextSnapshot: [],
    })
    return { dbPath, store, run }
  }

  test('不持有主库写锁的两步写入，交错执行的回收会留下悬空引用', () => {
    const { dbPath, store, run } = onDisk()
    const content = new ContentStore(contentPathFor(dbPath))
    const otherStore = new Store({ path: dbPath })
    const otherContent = new ContentStore(contentPathFor(dbPath))

    // 原始失败形状：正文先定稿，另一个连接随即查询全量引用并回收，之后引用才登记。
    const blob = content.put(enc.encode('E10'))
    const { removed } = collectResourceGarbage(otherStore, otherContent)
    const res = registerResource(store, {
      runId: run.id,
      toolName: 'run_command',
      sourceType: 'shell',
      status: 'complete',
      contentHash: blob.contentHash,
      sizeBytes: blob.originalBytes,
    })

    expect({
      removed,
      referenceExists: getResource(store, res.id) !== null,
      bodyExists: content.info(blob.contentHash) !== null,
    }).toEqual({ removed: 1, referenceExists: true, bodyExists: false })

    otherContent.close()
    otherStore.close()
    content.close()
    store.close()
  })

  test('同一交错经由 land 执行：回收方无法取得主库写锁，引用与正文均保留', () => {
    const { dbPath, store, run } = onDisk()
    const otherStore = new Store({ path: dbPath })
    const otherContent = new ContentStore(contentPathFor(dbPath))
    // 锁冲突要等满 `busy_timeout` 才报错，而此次锁冲突发生在同一线程中：
    // 持锁方正在执行该回调，继续等待只会使测试多耗时 5 秒。
    otherStore.db.exec('PRAGMA busy_timeout = 50')

    let attempt = '没跑到'
    class GcAfterPut extends ContentStore {
      override put(raw: Uint8Array, resourceId?: string): ReturnType<ContentStore['put']> {
        const blob = super.put(raw, resourceId)
        try {
          attempt = `removed:${collectResourceGarbage(otherStore, otherContent).removed}`
        } catch (err) {
          attempt = err instanceof Error ? err.message : String(err)
        }
        return blob
      }
    }
    const content = new GcAfterPut(contentPathFor(dbPath))
    const landed = new RuntimeSink(store, content, run.id).land({
      toolName: 'run_command',
      sourceType: 'shell',
      body: enc.encode('E10'),
    })

    expect(attempt).toMatch(/database is locked|SQLITE_BUSY/)
    expect(getResource(store, landed.resourceId)?.contentHash).toBe(landed.contentHash)
    expect(content.info(landed.contentHash)).not.toBeNull()

    otherContent.close()
    otherStore.close()
    content.close()
    store.close()
  })

  test('登记失败只留下可回收的孤儿正文', () => {
    const { dbPath, store } = onDisk()
    const content = new ContentStore(contentPathFor(dbPath))
    // 不存在的 run id：外键约束在登记步骤失败，主库事务回滚，而正文已在另一个库中提交。
    const sink = new RuntimeSink(store, content, 'rn_nope' as RunId)

    expect(() =>
      sink.land({ toolName: 'run_command', sourceType: 'shell', body: enc.encode('孤儿') }),
    ).toThrow()

    const rows = store.db
      .query<{ n: number }, []>('SELECT COUNT(*) AS n FROM intermediate_resources')
      .get()!
    expect(rows.n).toBe(0)
    expect(collectResourceGarbage(store, content).removed).toBe(1)

    content.close()
    store.close()
  })
})
