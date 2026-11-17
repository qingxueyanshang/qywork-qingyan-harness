/**
 * 正文回收在生产生命周期上的两个调用点。**覆盖范围**：`api/conversations.ts` 的 DELETE 分支、
 * `server.ts` 中打开数据库之后的回收与 `stop()` 的计时器释放，经 `runtime/sink.ts` 的协调器
 * 到达 `store/content.ts`。
 *
 * 并发一致性不在此处验证，由 `runtime/resource-gc-race.test.ts` 的双进程用例覆盖。
 * 此处只验证调用方、调用时机，以及调用失败后接口返回的内容。
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
  listSchedules,
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

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn()
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
    // 删除失败不视为用例失败：Windows 上 SQLite 的文件句柄释放有延迟。
    // 整个 .tmp/tests/run-* 由 scripts/run-tests.ts 统一清理。
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

test('删除一条会话后另一条会话引用的正文仍保留；删除最后一条引用后才回收，用量记录不受影响', async () => {
  const { dir, store, content, ws } = fresh()
  const handle = startServer(store, content, dir)
  const a = conversationWithRun(store, ws.id)
  const b = conversationWithRun(store, ws.id)

  // 同一份字节经内容寻址去重为一个 blob，两条会话各有一行引用。
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
  // `read_resource` 经由同一个 `SinkPort.read`：另一条会话的引用仍存在，正文必须可以读取。
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

  // 用量账本不设外键：删除会话与回收正文都不改变它。
  expect(usageTotals(store)).toEqual(usageBefore)
})

test('回收之后：行已删除，页数与文件字节数分别减少', async () => {
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
  // 行已删除。
  expect(countOf(content.db, 'SELECT COUNT(*) AS n FROM content_chunks')).toBe(0)
  /*
   * 三个数分别断言：SQL 删除的行数、剩余的自由页数、文件大小是否减小。
   * `auto_vacuum` 为 INCREMENTAL 时，`collectGarbage` 末尾的 `incremental_vacuum`
   * 才把空闲页归还给文件系统，页数与字节数随之减少；仅凭删除行数无法确定磁盘占用已经减小。
   */
  expect(pragma('auto_vacuum')).toBe(2)
  expect(after.freelist).toBe(0)
  expect(after.pageCount).toBeLessThan(before.pageCount)
  expect(after.fileBytes).toBeLessThan(before.fileBytes)
})

test('回收失败与删除成功分别返回：会话已删除，另附空间未回收的说明', async () => {
  const { dir, store, content, ws } = fresh()
  const handle = startServer(store, content, dir)
  const c = conversationWithRun(store, ws.id)

  // 正文库不可用时回收必然抛出异常。删除操作使用主库，不受其影响。
  content.close()
  const res = await deleteConversation(handle, c.conv.id)

  expect(res.status).toBe(200)
  expect(res.body.ok).toBe(true)
  expect(String(res.body.reclaimError)).toMatch(/^已删除，但正文空间未回收：/)
  expect(getConversation(store, c.conv.id)).toBeNull()
})

test('上次进程遗留的无引用正文在启动时回收，仍被引用的正文保留', () => {
  const { dir, store, content, ws } = fresh()
  const c = conversationWithRun(store, ws.id)
  const kept = new RuntimeSink(store, content, c.run.id).land({
    toolName: 'run_command',
    sourceType: 'shell',
    body: enc.encode('还有人引用'),
  })
  // 正文已提交而引用未登记：进程在主库提交前退出时遗留的正是这一状态。
  const orphan = content.put(enc.encode('上次没登记完'))
  expect(countOf(content.db, 'SELECT COUNT(*) AS n FROM content_blobs')).toBe(2)

  startServer(store, content, dir)

  expect(content.info(orphan.contentHash)).toBeNull()
  expect(content.info(kept.contentHash)).not.toBeNull()
})

test('多次启动与关闭之后，已停止的服务不再认领到期任务', async () => {
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
    await handle.stop()
  }

  // 全部停止之后才写入一条到期任务。仍有计时器在运行时，它每 10 ms 触发一次，在下面的等待期间必然认领该任务。
  const home = createConversation(store, {
    workspaceId: ws.id,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    title: '排任务的会话',
  })
  const s = createSchedule(
    store,
    dir,
    { title: '不该被认领', prompt: '执行', kind: 'interval', everyMinutes: 1 },
    home.id,
  )
  store.db.query('UPDATE schedules SET created_at = ? WHERE id = ?').run(Date.now() - 120_000, s.id)
  /*
   * 不按固定时长等待：同周期的间隔计时器按到期时刻先后触发，此前登记、未被清除的 10 ms 计时器
   * 在本计时器触发三次的期间至少触发两次；认领在计时器回调的同步段中写入账本。
   */
  await new Promise<void>((resolve) => {
    let fired = 0
    const probe = setInterval(() => {
      fired += 1
      if (fired < 3) return
      clearInterval(probe)
      resolve()
    }, 10)
  })

  // 认领会启动一轮并推进游标，两者都未发生。
  expect(countOf(store.db, 'SELECT COUNT(*) AS n FROM runs')).toBe(0)
  expect(listSchedules(store, dir, Date.now())[0]!.lastRunAt).toBe(undefined)
  expect(ws.rootPath).toBe(dir)
})
