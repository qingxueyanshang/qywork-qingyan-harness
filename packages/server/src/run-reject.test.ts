/**
 * 起轮前被拒时发出的事件序列。
 *
 * **覆盖范围**：`run-control.ts` 里 `startRun` 的五条拒绝出口（占位失败、项目目录
 * 查不到、三处都取不到模型、会话装配抛错、装配 adapter 抛错），以及 `runs.ts` 在
 * 释放占位时广播忙闲那一手。这五条都不产生 run 行，因此**不会有 `run.finished`**，
 * 终态是 `conversation.busy: false`（约定写在 `core` 的 `RunErrorEvent` 上）。
 * 目标续起与跟进消息那两条路在 `goal-loop.test.ts` / `followup.test.ts`。
 *
 * 断言的是**整条序列**而不是「有没有发过 run.error」：漏掉忙闲那一条时界面停在
 * 「生成中」，而只断言错误码的用例仍是绿的。
 *
 * 占位成功的四条出口序列同形：`busy=true` → `run.error` → `busy=false`。
 * 报错在前、释放在后，因为释放是收尾路径做的最后一件事。
 */

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationId, EventEnvelope } from '@qywork/core'
import type { QyConfig } from '@qywork/runtime'
import {
  ContentStore,
  contentPathFor,
  createConversation,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import { EventBus } from './bus.ts'
import { startRun } from './run-control.ts'
import { RunManager } from './runs.ts'
import { SubagentRegistry } from './subagents.ts'

let dir = ''
let store: Store
let content: ContentStore
let bus: EventBus
let runs: RunManager
let subagents: SubagentRegistry
let workspaceId = ''
let events: EventEnvelope[] = []

/**
 * 假接口档案。`apiKey` 传空串时 `buildAdapter` 在本地就抛 `no_api_key`，
 * 一个请求都不发——用例因此不需要起 provider。
 */
function config(apiKey: string): QyConfig {
  return {
    active: { provider: 'fake', model: 'deepseek-v4-flash' },
    providers: {
      fake: {
        kind: 'openai_responses',
        apiKey,
        baseUrl: 'https://example.invalid/v1',
        models: { 'deepseek-v4-flash': {} },
      },
    },
    mode: 'auto',
  } as QyConfig
}

function deps(cfg: QyConfig) {
  return { store, content, config: cfg, bus, runs, subagents }
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'qywork-reject-'))
  const dbPath = join(dir, 'reject.sqlite3')
  store = new Store({ path: dbPath })
  content = new ContentStore(contentPathFor(dbPath))
  bus = new EventBus()
  subagents = new SubagentRegistry()
  runs = new RunManager(store, bus, subagents)
  workspaceId = upsertWorkspace(store, dir, 'reject-ws').id
  bus.subscribe({
    id: 'test',
    origin: 'cli',
    conversations: null,
    send: (frame) => events.push(frame),
  })
})

afterAll(async () => {
  store?.close()
  content?.close()
  await rm(dir, { recursive: true, force: true }).catch(() => {})
})

function conversation(model = 'deepseek-v4-flash'): ConversationId {
  events = []
  return createConversation(store, {
    workspaceId: workspaceId as never,
    provider: model ? 'fake' : '',
    model,
  }).id
}

/** 收到的事件压成可比的一行，忙闲带上真假值，错误带上码与 runId。 */
function trace(): string[] {
  return events.map((frame) => {
    const e = frame.event
    if (e.type === 'conversation.busy') return `busy=${e.busy}`
    if (e.type === 'run.error') return `run.error ${e.code} runId=${JSON.stringify(e.runId)}`
    return e.type
  })
}

test('没配 key —— 装配 adapter 就抛，忙闲落回闲', async () => {
  const cv = conversation()
  await startRun(cv, '你好', undefined, deps(config('')))
  // 拒绝在后台那段异步里收尾，等它跑完再读序列。
  await Bun.sleep(200)

  expect(trace()).toEqual(['busy=true', 'run.error no_api_key runId=""', 'busy=false'])
  expect(runs.hasRun(cv)).toBe(false)
})

test('一个模型都没配 —— 回结构化 no_model，忙闲落回闲', async () => {
  const cv = conversation('')
  const cfg = config('sk-fake')
  // 删键而不是置 undefined：`exactOptionalPropertyTypes` 开着，可选键不收 undefined。
  delete cfg.active
  await startRun(cv, '你好', undefined, deps(cfg))

  expect(trace()).toEqual(['busy=true', 'run.error no_model runId=""', 'busy=false'])
  expect(runs.hasRun(cv)).toBe(false)
})

test('会话已有任务在跑 —— 只回错误，不动忙闲', async () => {
  const cv = conversation()
  expect(runs.reserve(cv)).toBe(true)
  events = []

  await startRun(cv, '你好', undefined, deps(config('sk-fake')))

  /*
   * **这一条没有忙闲事件是对的。** 占位在另一轮名下，这条会话此刻确实仍在跑；
   * 补一条 `busy=false` 会把正在跑的那一轮在界面上抹成闲的。
   */
  expect(trace()).toEqual(['run.error internal_error runId=""'])
  expect(runs.hasRun(cv)).toBe(true)
  runs.release(cv)
})

/**
 * 起轮序言里抛出的错。
 *
 * 用 `PRAGMA query_only` 让 SQLite 拒写来注入：`new Session()` 装配时要
 * `upsertWorkspace` 回写工作区的最近打开时间，那是占位之后的第一处落库，
 * 而 SQLite 的写在真实运行里会因并发写锁、磁盘满、库文件只读而失败。
 *
 * 断言到「下一条消息照常起轮」为止：占位漏放的表现不是这一轮报了什么，
 * 而是**此后**每条消息都被回绝「已有任务在执行」，直到进程重启。
 */
test('会话装配抛错 —— 占位跟着释放，下一条消息照常起轮', async () => {
  const cv = conversation()
  store.db.run('PRAGMA query_only = true')
  try {
    await startRun(cv, '你好', undefined, deps(config('sk-fake')))
  } finally {
    store.db.run('PRAGMA query_only = false')
  }

  expect(trace()).toEqual(['busy=true', 'run.error internal_error runId=""', 'busy=false'])
  expect(runs.hasRun(cv)).toBe(false)

  events = []
  await startRun(cv, '再来一次', undefined, deps(config('')))
  await Bun.sleep(200)
  expect(trace()).toEqual(['busy=true', 'run.error no_api_key runId=""', 'busy=false'])
})

test('会话查不到项目目录 —— 占位立刻释放', async () => {
  const cv = conversation()
  store.db.run('delete from workspaces where id = ?', [workspaceId])
  events = []

  await startRun(cv, '你好', undefined, deps(config('sk-fake')))

  expect(trace()).toEqual(['busy=true', 'run.error internal_error runId=""', 'busy=false'])
  expect(runs.hasRun(cv)).toBe(false)
})
