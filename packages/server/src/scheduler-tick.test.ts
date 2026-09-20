/**
 * 生产的 tick 间隔常量本身。**覆盖范围**：`scheduler.ts` 的 `SCHEDULER_TICK_MS` 缺省值，
 * 以及 `server.ts` 不传 `schedulerTickMs` 时的装配。
 *
 * **这条测试要跑半分多钟，是全仓最慢的一条。** 它必须存在：其余调度用例都经
 * `ServeOptions.schedulerTickMs` 注入毫秒级间隔，因此那个缺省值改成 30 分钟、
 * 或者 `startScheduler` 的第二个参数在装配时被漏掉，全部照样绿。
 * 这条不注入任何间隔，等的就是真实的第一跳。
 *
 * 只等一跳，不等第二跳：要验的是缺省值能把任务带到终态，不是间隔的精度。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { configPath, loadConfig, type QyConfig } from '@qywork/runtime'
import { createConversation, createSchedule, Store, upsertWorkspace } from '@qywork/store'
import { serve } from './server.ts'

/** 401 假 provider：`auth_failed` 不在重发名单里，一次就落终态。 */
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

test('不注入间隔：生产的缺省 tick 把一条到期任务带到 Run 终态', async () => {
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
  // 建出来就已经到期：`isDue` 按 createdAt 与游标算，回拨两分钟让第一跳就认领得到。
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
    // 第一跳不可能早于 30 秒：早于它说明装配处又把间隔注了进去。
    expect(waited).toBeGreaterThanOrEqual(30_000)
    // 只认领一次：绑定的那条会话原样复用，一条 Run。
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
