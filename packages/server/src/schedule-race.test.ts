/**
 * 两个操作系统进程对同一条到期任务的竞争。**覆盖范围**：`store/schedules.ts` 的认领事务在
 * 跨进程下的排他性，经由 `schedule-race-child.ts` 起的两份真实 `serve()`。
 *
 * 单进程内的两个实例不足以证明这件事：认领事务是同步的，两次 tick 天然排队。这里用两个
 * `bun` 子进程共享同一个主库文件，并用一个 HTTP 屏障把它们的启动时刻对齐——两个进程都开完库、
 * 装配完之后才同时放行，竞争窗口因此落在 SQLite 的写事务上。
 *
 * 断言的是结果而不是时序：同一条任务只留下一条会话、一条 Run、一次模型请求。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { QyConfig } from '@qywork/runtime'
import { createConversation, createSchedule, Store, upsertWorkspace } from '@qywork/store'

/** 401 假 provider：只计数、只回鉴权失败，一次就落终态。 */
let providerCalls = 0
const provider = Bun.serve({
  port: 0,
  fetch() {
    providerCalls++
    return new Response(JSON.stringify({ error: { message: 'Incorrect API key provided' } }), {
      status: 401,
      headers: { 'content-type': 'application/json' },
    })
  },
})

let root = ''
let home = ''

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'qywork-race-'))
  home = await mkdtemp(join(tmpdir(), 'qywork-race-home-'))
  const config: QyConfig = {
    active: { provider: 'fake', model: 'deepseek-v4-flash' },
    providers: {
      fake: {
        kind: 'openai_responses',
        apiKey: 'sk-fake',
        baseUrl: `http://127.0.0.1:${provider.port}/v1`,
        models: { 'deepseek-v4-flash': {} },
      },
    },
    mode: 'auto',
  }
  // 子进程按 QYWORK_HOME 读这份配置，与 `qy serve` 同一条路径。
  await writeFile(join(home, 'config.json'), JSON.stringify(config), 'utf8')
})

afterAll(async () => {
  provider.stop(true)
  await rm(root, { recursive: true, force: true }).catch(() => {})
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

test('两个操作系统进程对同一条到期任务只认领一次', async () => {
  const workspaceRoot = await mkdtemp(join(root, 'ws-'))
  const dbPath = join(root, 'race.sqlite3')
  const seed = new Store({ path: dbPath })
  const ws = upsertWorkspace(seed, workspaceRoot, 'W')
  const conversation = createConversation(seed, {
    workspaceId: ws.id,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    title: '排任务的会话',
  })
  const s = createSchedule(
    seed,
    workspaceRoot,
    { title: '只该跑一次', prompt: '执行', kind: 'interval', everyMinutes: 1 },
    conversation.id,
  )
  seed.db.query('UPDATE schedules SET created_at = ? WHERE id = ?').run(Date.now() - 120_000, s.id)
  seed.close()

  // 屏障：两个子进程都到齐才放行，两边的 serve() 因此在同一刻起跳。
  let release = (): void => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let arrived = 0
  const barrier = Bun.serve({
    port: 0,
    async fetch() {
      arrived++
      if (arrived >= 2) release()
      await gate
      return new Response('go')
    },
  })

  const child = join(import.meta.dir, 'schedule-race-child.ts')
  const args = [dbPath, home, workspaceRoot, String(barrier.port), '2500']
  const procs = [0, 1].map(() =>
    Bun.spawn([process.execPath, child, ...args], { stdout: 'pipe', stderr: 'pipe' }),
  )

  const before = providerCalls
  const exits = await Promise.all(procs.map((p) => p.exited))
  const errs = await Promise.all(procs.map((p) => new Response(p.stderr).text()))
  barrier.stop(true)

  expect({ exits, errs }).toEqual({ exits: [0, 0], errs: ['', ''] })
  expect(arrived).toBe(2)

  const check = new Store({ path: dbPath })
  try {
    const count = (sql: string) => check.db.query<{ n: number }, []>(sql).get()?.n ?? 0
    expect(count('SELECT COUNT(*) AS n FROM conversations')).toBe(1)
    expect(count('SELECT COUNT(*) AS n FROM runs')).toBe(1)
    expect(providerCalls - before).toBe(1)
  } finally {
    check.close()
  }
}, 60_000)
