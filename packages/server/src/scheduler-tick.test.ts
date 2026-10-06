/**
 * 生产环境的 tick 间隔常量。**覆盖范围**：`scheduler.ts` 的 `SCHEDULER_TICK_MS` 缺省值，
 * 以及 `server.ts` 不传 `schedulerTickMs` 时的装配。
 *
 * **该测试需要运行半分钟以上，是全仓最慢的测试。** 它必须存在：其余调度用例都经由
 * `ServeOptions.schedulerTickMs` 注入毫秒级间隔，因此缺省值被改为 30 分钟、
 * 或 `startScheduler` 的第二个参数在装配时被遗漏时，全部用例仍然通过。
 * 本用例不注入任何间隔，等待真实的第一次 tick。
 *
 * 只等待第一次 tick，不等待第二次：验证的是缺省值能使任务到达终态，而不是间隔的精度。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPath, loadConfig, type QyConfig } from '@qywork/runtime'
import { createConversation, createSchedule, Store, upsertWorkspace } from '@qywork/store'
import { serve } from './server.ts'

/** 401 假 provider：`auth_failed` 不在重发名单中，一次即进入终态。 */
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

let home = ''
let root = ''
let prevHome: string | undefined

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'qywork-tick-'))
  prevHome = process.env.QYWORK_HOME
  home = await mkdtemp(join(tmpdir(), 'qywork-tick-home-'))
  process.env.QYWORK_HOME = home
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
  await writeFile(configPath(), JSON.stringify(config), 'utf8')
})

afterAll(async () => {
  if (prevHome === undefined) delete process.env.QYWORK_HOME
  else process.env.QYWORK_HOME = prevHome
  provider.stop(true)
  await rm(root, { recursive: true, force: true }).catch(() => {})
  await rm(home, { recursive: true, force: true }).catch(() => {})
})

test('不注入间隔：生产环境的缺省 tick 使到期任务的 Run 进入终态', async () => {
  const dir = await mkdtemp(join(root, 'ws-'))
  const store = new Store({ path: join(root, 'tick.sqlite3') })
  const ws = upsertWorkspace(store, dir, '定时')
  const home = createConversation(store, {
    workspaceId: ws.id,
    provider: 'fake',
    model: 'deepseek-v4-flash',
    title: '排任务的会话',
  })
  const made = createSchedule(
    store,
    dir,
    { title: '每分钟一次', prompt: '汇报一次。', kind: 'interval', everyMinutes: 1 },
    home.id,
  )
  // 创建时即已到期：`isDue` 按 createdAt 与游标计算，回拨两分钟使第一次 tick 即可认领。
  store.db
    .query('UPDATE schedules SET created_at = ? WHERE id = ?')
    .run(Date.now() - 120_000, made.id)

  const startedAt = Date.now()
  const handle = serve({
    store,
    config: await loadConfig(),
    workspaceRoot: dir,
    port: 0,
    host: '127.0.0.1',
  })

  try {
    const deadline = startedAt + 90_000
    let run: { status: string; error_code: string | null } | null = null
    while (Date.now() < deadline) {
      run =
        store.db
          .query<{ status: string; error_code: string | null }, []>(
            "SELECT status, error_code FROM runs WHERE status IN ('done','failed','interrupted') LIMIT 1",
          )
          .get() ?? null
      if (run) break
      await Bun.sleep(500)
    }
    const waited = Date.now() - startedAt
    if (!run) throw new Error(`等了 ${waited} ms 仍没有落终态的 Run`)

    expect(run.status).toBe('failed')
    expect(run.error_code).toBe('auth_failed')
    expect(providerCalls).toBeGreaterThan(0)
    // 第一次 tick 不可能早于 30 秒：早于 30 秒说明装配处注入了间隔。
    expect(waited).toBeGreaterThanOrEqual(30_000)
    // 只认领一次：复用绑定的会话，只有一条 Run。
    const counts = store.db
      .query<{ conversations: number; runs: number }, []>(
        'SELECT (SELECT count(*) FROM conversations) AS conversations, (SELECT count(*) FROM runs) AS runs',
      )
      .get()
    expect(counts).toEqual({ conversations: 1, runs: 1 })
  } finally {
    handle.stop()
    store.close()
  }
}, 120_000)
