/**
 * 启动轮次前被拒绝时发出的事件序列。
 *
 * **覆盖范围**：`run-control.ts` 中 `startRun` 的六个拒绝出口（占位失败、未找到项目
 * 目录、三处均无法取得模型、会话装配抛错、装配 adapter 抛错、会话被另一个进程占用），
 * 以及 `runs.ts` 在释放占位时的忙闲广播。这六个出口都不产生 run 行，因此**不会有 `run.finished`**，
 * 终态是 `conversation.busy: false`（约定写在 `core` 的 `RunErrorEvent` 上）。
 * 目标自动继续与跟进消息两条路径由 `goal-loop.test.ts` / `followup.test.ts` 覆盖。
 *
 * 断言的是**整条序列**而不是是否发出过 run.error：遗漏忙闲事件时界面停留在
 * 「生成中」，而只断言错误码的用例仍会通过。
 *
 * 占位成功后的四个出口序列相同：`busy=true` → `run.error` → `busy=false`。
 * 报错在前、释放在后，因为释放是收尾路径的最后一步。
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
  listMessages,
  Store,
  upsertWorkspace,
} from '@qywork/store'
import { EventBus } from './bus.ts'
import { startRun } from './run-control.ts'
import { RunManager } from './runs.ts'
import { SubagentRegistry } from './subagents.ts'

let dir = ''
let dbPath = ''
let store: Store
let content: ContentStore
let bus: EventBus
let runs: RunManager
let subagents: SubagentRegistry
let workspaceId = ''
let events: EventEnvelope[] = []

/**
 * 假接口配置。`apiKey` 传入空串时 `buildAdapter` 在本地即抛出 `no_api_key`，
 * 不发送任何请求，用例因此无需启动 provider。
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
  dbPath = join(dir, 'reject.sqlite3')
  store = new Store({ path: dbPath, owner: 'serve' })
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

/** 将收到的事件压缩为可比较的一行：忙闲事件附带布尔值，错误附带错误码与 runId。 */
function trace(): string[] {
  return events.map((frame) => {
    const e = frame.event
    if (e.type === 'conversation.busy') return `busy=${e.busy}`
    if (e.type === 'run.error') return `run.error ${e.code} runId=${JSON.stringify(e.runId)}`
    return e.type
  })
}

test('未配置 key：装配 adapter 时抛出，忙闲状态恢复为空闲', async () => {
  const cv = conversation()
  await startRun(cv, '你好', undefined, deps(config('')))
  // 拒绝在后台异步流程中结束，等待其执行完毕后再读取序列。
  await Bun.sleep(200)

  expect(trace()).toEqual(['busy=true', 'run.error no_api_key runId=""', 'busy=false'])
  expect(runs.hasRun(cv)).toBe(false)
})

test('未配置任何模型：返回结构化的 no_model，忙闲状态恢复为空闲', async () => {
  const cv = conversation('')
  const cfg = config('sk-fake')
  // 删除键而不是设为 undefined：`exactOptionalPropertyTypes` 已开启，可选键不接受 undefined。
  delete cfg.active
  await startRun(cv, '你好', undefined, deps(cfg))

  expect(trace()).toEqual(['busy=true', 'run.error no_model runId=""', 'busy=false'])
  expect(runs.hasRun(cv)).toBe(false)
})

test('会话已有任务运行中：只返回错误，不改变忙闲状态', async () => {
  const cv = conversation()
  expect(runs.reserve(cv)).toBe(true)
  events = []

  await startRun(cv, '你好', undefined, deps(config('sk-fake')))

  /*
   * **该用例不应产生忙闲事件。** 占位属于另一轮，该会话当前确实仍在运行；
   * 补发 `busy=false` 会使正在运行的轮次在界面上显示为空闲。
   */
  expect(trace()).toEqual(['run.error internal_error runId=""'])
  expect(runs.hasRun(cv)).toBe(true)
  runs.release(cv)
})

/**
 * 同一会话被另一个进程占用（终端的 qy 正在运行该会话）。占用进程是 `store` 包的测试子进程，
 * 创建一轮后不退出。跨进程的判定位于账本的 `createRun`，本进程的占位表中没有该会话，
 * 因此序列与「装配抛错」相同，`run.error` 的正文指明占用方。
 */
test('会话被另一个进程占用：返回错误并指明占用方，该错误不写入数据库，忙闲状态恢复为空闲', async () => {
  const cv = conversation()
  const holder = Bun.spawn(
    [process.execPath, join(import.meta.dir, '../../store/src/concurrency-child.ts')],
    {
      env: {
        ...process.env,
        QY_CC_MODE: 'hold',
        QY_CC_DB: dbPath,
        QY_CC_ARG: `${cv}|${workspaceId}`,
        QY_CC_OWNER: 'cli',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )
  try {
    const reader = holder.stdout.getReader()
    let text = ''
    while (!text.includes(String.fromCharCode(10))) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    expect(JSON.parse(text.trim()).ok).toBe(true)
    events = []

    await startRun(cv, '你好', undefined, deps(config('sk-fake')))
    await Bun.sleep(300)

    expect(trace()).toEqual(['busy=true', 'run.error internal_error runId=""', 'busy=false'])
    const error = events.map((f) => f.event).find((e) => e.type === 'run.error')
    expect(error?.type === 'run.error' ? error.message : '').toContain(
      `该会话已在终端的 qy 中执行（pid ${holder.pid}）`,
    )
    expect(listMessages(store, cv)).toEqual([])
    expect(runs.hasRun(cv)).toBe(false)
  } finally {
    holder.kill()
    await holder.exited
  }
}, 30_000)

/**
 * 启动轮次的准备阶段抛出的错误。
 *
 * 用 `PRAGMA query_only` 使 SQLite 拒绝写入以注入错误：`new Session()` 装配时需要由
 * `upsertWorkspace` 写回工作区的最近打开时间，这是占位之后的第一处写入，
 * 而 SQLite 写入在真实运行中会因并发写锁、磁盘已满、库文件只读而失败。
 *
 * 断言延续到下一条消息照常启动轮次为止：未释放占位的后果不在本轮的报错，
 * 而在于**此后**每条消息都被拒绝为「已有任务在执行」，直到进程重启。
 */
test('会话装配抛错：占位随之释放，下一条消息照常启动轮次', async () => {
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

test('未找到会话的项目目录：占位立即释放', async () => {
  const cv = conversation()
  store.db.run('delete from workspaces where id = ?', [workspaceId])
  events = []

  await startRun(cv, '你好', undefined, deps(config('sk-fake')))

  expect(trace()).toEqual(['busy=true', 'run.error internal_error runId=""', 'busy=false'])
  expect(runs.hasRun(cv)).toBe(false)
})
