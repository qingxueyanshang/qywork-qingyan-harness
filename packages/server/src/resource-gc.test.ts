/**
 * 正文回收在生产生命周期上的两个调用点。**覆盖范围**：`api/conversations.ts` 的 DELETE 分支、
 * `server.ts` 里开库之后的那次回收与 `stop()` 的计时器释放，经 `runtime/sink.ts` 的协调器
 * 落到 `store/content.ts`。
 *
 * 并发一致性不在这里——那由 `runtime/resource-gc-race.test.ts` 的双进程用例覆盖。
 * 这里只回答「谁在什么时候调了它、调失败之后用户看到什么」。
 */

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WorkspaceId } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import { RuntimeSink } from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  createRun,
  createSchedule,
  getConversation,
  recordUsage,
  Store,
  upsertWorkspace,
  usageTotals,
} from '@qywork/store'
import { serve } from './server.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

const config: QyConfig = {
  active: { provider: 'fake', model: 'm' },
  providers: {
    fake: {
      kind: 'openai_responses',
      apiKey: 'sk-fake',
      baseUrl: 'http://127.0.0.1:1/v1',
      models: { m: {} },
    },
  },
  mode: 'auto',
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})

function fresh() {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-gc-'))
  const dbPath = join(dir, 'a.sqlite3')
  const store = new Store({ path: dbPath })
  const content = new ContentStore(contentPathFor(dbPath))
  const ws = upsertWorkspace(store, dir, 'W')
  cleanups.push(() => {
    content.close()
    store.close()
    // 删不掉不当失败：`serve()` 预热扩展是异步的，用例结束时它可能还握着这个目录。
    // 整个 .tmp/tests/run-* 由 scripts/run-tests.ts 统一收尾。
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {}
  })
  return { dir, dbPath, store, content, ws }
}

function conversationWithRun(store: Store, workspaceId: WorkspaceId) {
  const conv = createConversation(store, { workspaceId, provider: 'p', model: 'm', title: 't' })
  const run = createRun(store, {
    conversationId: conv.id,
    workspaceId,
    model: 'm',
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  return { conv, run }
}

function startServer(store: Store, content: ContentStore, workspaceRoot: string, tickMs?: number) {
  const handle = serve({
    store,
    config,
    content,
    workspaceRoot,
    port: 0,
    host: '127.0.0.1',
    ...(tickMs === undefined ? {} : { schedulerTickMs: tickMs }),
  })
  cleanups.push(() => handle.stop())
  return handle
}

async function deleteConversation(handle: ReturnType<typeof serve>, id: string) {
  const res = await fetch(`http://127.0.0.1:${handle.port}/api/conversations/${id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${handle.token}` },
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

const countOf = (db: { query: Store['db']['query'] }, sql: string) =>
  db.query<{ n: number }, []>(sql).get()?.n ?? 0

test('删掉一条会话，另一条引用的正文还在；删掉最后一条引用才回收，费用账不受影响', async () => {
  const { dir, store, content, ws } = fresh()
  const handle = startServer(store, content, dir)
  const a = conversationWithRun(store, ws.id)
  const b = conversationWithRun(store, ws.id)

  // 同一份字节 → 内容寻址去重成一个 blob，两条会话各有一行引用。
  const body = enc.encode('共享的命令输出'.repeat(500))
  const landedA = new RuntimeSink(store, content, a.run.id).land({
    toolName: 'run_command',
    sourceType: 'shell',
    body,
  })
  const landedB = new RuntimeSink(store, content, b.run.id).land({
    toolName: 'run_command',
    sourceType: 'shell',
    body,
  })
  expect(landedA.contentHash).toBe(landedB.contentHash)

  for (const c of [a, b]) {
    recordUsage(store, {
      kind: 'run',
      runId: c.run.id,
      conversationId: c.conv.id,
      workspaceId: ws.id,
      model: 'm',
      provider: 'p',
      inputTokens: 100,
      outputTokens: 20,
      cost: 0.5,
    })
  }
  const usageBefore = usageTotals(store)

  expect(await deleteConversation(handle, a.conv.id)).toEqual({ status: 200, body: { ok: true } })
  // `read_resource` 走的就是这条 `SinkPort.read`：另一条会话的引用还在，正文必须读得回。
  const readBack = new RuntimeSink(store, content, b.run.id).read(
    landedB.resourceId,
    0,
    body.byteLength,
  )
  expect(dec.decode(readBack!)).toBe(dec.decode(body))

  expect(await deleteConversation(handle, b.conv.id)).toEqual({ status: 200, body: { ok: true } })
  expect(content.info(landedA.contentHash)).toBeNull()
  expect(countOf(content.db, 'SELECT COUNT(*) AS n FROM content_chunks')).toBe(0)
  expect(countOf(content.db, 'SELECT COUNT(*) AS n FROM content_blobs')).toBe(0)

  // 账本不设外键，删会话不动它；回收正文更不该动它。
  expect(usageTotals(store)).toEqual(usageBefore)
})

test('回收之后：行删了，页数与文件字节数分别降下来', async () => {
  const { dir, dbPath, store, content, ws } = fresh()
  const handle = startServer(store, content, dir)
  const c = conversationWithRun(store, ws.id)
  new RuntimeSink(store, content, c.run.id).land({
    toolName: 'run_command',
    sourceType: 'shell',
    body: new Uint8Array(8 * 1024 * 1024),
  })

  const pragma = (name: string) =>
    content.db.query<Record<string, number>, []>(`PRAGMA ${name}`).get()?.[name] ?? -1
  const before = {
    pageCount: pragma('page_count'),
    freelist: pragma('freelist_count'),
    fileBytes: statSync(contentPathFor(dbPath)).size,
  }

  expect(await deleteConversation(handle, c.conv.id)).toEqual({ status: 200, body: { ok: true } })

  const after = {
    pageCount: pragma('page_count'),
    freelist: pragma('freelist_count'),
    fileBytes: statSync(contentPathFor(dbPath)).size,
  }
  // 行确实删了。
  expect(countOf(content.db, 'SELECT COUNT(*) AS n FROM content_chunks')).toBe(0)
  /*
   * 三个数分开看：SQL 删掉几行、自由页还剩几页、文件本身有没有缩。
   * `auto_vacuum` 是 INCREMENTAL 时 `collectGarbage` 末尾那句 `incremental_vacuum`
   * 才真的把页还回去，页数与字节数才跟着降——否则删除行数不代表磁盘已经缩小。
   */
  expect(pragma('auto_vacuum')).toBe(2)
  expect(after.freelist).toBe(0)
  expect(after.pageCount).toBeLessThan(before.pageCount)
  expect(after.fileBytes).toBeLessThan(before.fileBytes)
})

test('回收失败与删除成功分开回：会话确实删了，另给一句空间没收回来', async () => {
  const { dir, store, content, ws } = fresh()
  const handle = startServer(store, content, dir)
  const c = conversationWithRun(store, ws.id)

  // 正文库不可用 = 回收必然抛。删除本身走的是主库，不受它影响。
  content.close()
  const res = await deleteConversation(handle, c.conv.id)

  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(true)
  expect(String(res.body.reclaimError)).toMatch(/^已删除，但正文空间没回收：/)
  expect(getConversation(store, c.conv.id)).toBeNull()
})

test('上次进程留下的孤儿正文在启动时回收，仍被引用的留着', () => {
  const { dir, store, content, ws } = fresh()
  const c = conversationWithRun(store, ws.id)
  const kept = new RuntimeSink(store, content, c.run.id).land({
    toolName: 'run_command',
    sourceType: 'shell',
    body: enc.encode('还有人引用'),
  })
  // 正文提交了、引用没登记——进程在主库提交前退出留下的就是这个形状。
  const orphan = content.put(enc.encode('上次没登记完'))
  expect(countOf(content.db, 'SELECT COUNT(*) AS n FROM content_blobs')).toBe(2)

  startServer(store, content, dir)

  expect(content.info(orphan.contentHash)).toBeNull()
  expect(content.info(kept.contentHash)).not.toBeNull()
})

test('反复启动关闭之后，停掉的服务不再认领到期任务', async () => {
  const { dir, store, content, ws } = fresh()
  for (let i = 0; i < 3; i++) {
    const handle = serve({
      store,
      config,
      content,
      workspaceRoot: dir,
      port: 0,
      host: '127.0.0.1',
      schedulerTickMs: 10,
    })
    await Bun.sleep(60)
    handle.stop()
  }

  // 全停之后才放一条到期任务。还有计时器在跑的话，10 ms 一跳，下面这段等待里必被认领。
  const s = createSchedule(store, dir, {
    title: '不该被认领',
    prompt: '执行',
    kind: 'interval',
    everyMinutes: 1,
  })
  store.db.query('UPDATE schedules SET created_at = ? WHERE id = ?').run(Date.now() - 120_000, s.id)
  await Bun.sleep(400)

  expect(countOf(store.db, 'SELECT COUNT(*) AS n FROM conversations')).toBe(0)
  expect(countOf(store.db, 'SELECT COUNT(*) AS n FROM runs')).toBe(0)
  expect(ws.rootPath).toBe(dir)
})
