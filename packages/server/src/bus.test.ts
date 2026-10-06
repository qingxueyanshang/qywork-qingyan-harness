/**
 * 事件总线的按会话隔离。
 *
 * 覆盖范围：`bus.ts` 全部（`publish` / `setSubscription` / `replayFrom` / 可见性判定）。
 *
 * 本测试锁定一组真实症状：切换会话之后界面显示的是上一条会话的内容，偶尔无响应。
 * 根因不在「切换」相关代码中，而在本模块：归属信息只用于发送时的过滤，
 * 从不随帧发出，而该过滤在三处存在遗漏：
 *
 * 1. 空订阅集被视为「全订阅」，因此前端发送 `subscribe([])` 以退订，收到的却是全部事件；
 * 2. 断线补发路径上没有过滤，一次重连最多推送 5000 帧其他会话的事件；
 * 3. 客户端无法取得归属，因而无法自行过滤。
 *
 * 因此以下每条断言针对的都是原始失败形状（A2 的根治判定第 5 条），
 * 而不是「新增的保护分支被命中」。
 */

import { describe, expect, test } from 'bun:test'
import type { AgentEvent, ConversationId, EventEnvelope } from '@qywork/core'
import { EventBus, type Subscriber } from './bus.ts'

const c1 = 'cv_one' as ConversationId
const c2 = 'cv_two' as ConversationId

/** 最小的会话内事件。使用 text.delta，因为它是跨会话混入的主要来源：它不带 conversationId。 */
const delta = (s: string): AgentEvent =>
  ({ type: 'text.delta', runId: 'run_x', stepId: 'st_x', delta: s }) as AgentEvent

/** 工作区级事件：没有可归属的会话，所有订阅者都应收到。 */
const gitState: AgentEvent = {
  type: 'git.state',
  workspaceId: 'ws_1',
  branch: 'master',
  upstream: null,
  ahead: 0,
  behind: 0,
  staged: 0,
  unstaged: 0,
  untracked: 0,
  conflicted: 0,
} as AgentEvent

function attach(bus: EventBus, id: string, conversations: Set<ConversationId> | null) {
  const got: EventEnvelope[] = []
  const sub: Subscriber = {
    id,
    origin: 'desktop',
    conversations,
    send: (f) => got.push(f),
  }
  bus.subscribe(sub)
  return { sub, got, types: () => got.map((f) => f.event.type) }
}

describe('归属随帧发出', () => {
  test('帧上带 conversationId：客户端据此判断，不能只保留在服务端内存中', () => {
    const bus = new EventBus()
    const frame = bus.publish(delta('a'), c1)
    expect(frame.conversationId).toBe(c1)
  })

  test('工作区级事件不带该字段，而不是带空串', () => {
    const bus = new EventBus()
    expect(bus.publish(gitState).conversationId).toBeUndefined()
  })
})

describe('订阅语义：null 与空集含义不同', () => {
  test('null 表示尚未声明，接收全部会话事件：首次连接时界面尚未选择会话', () => {
    const bus = new EventBus()
    const a = attach(bus, 'a', null)
    bus.publish(delta('x'), c1)
    bus.publish(delta('y'), c2)
    expect(a.got).toHaveLength(2)
  })

  /**
   * 本用例即原始失败形状。
   *
   * 前端切换项目时发送 `client.subscribe([])`，意图是退订。`visibleTo` 中若写成
   * `if (sub.conversations.size === 0) return true`，空集即被视为全订阅，
   * 所有会话的事件都会发送到该客户端，而客户端会无条件写入当前 transcript。
   */
  test('空集表示明确不接收任何会话事件，不是全订阅', () => {
    const bus = new EventBus()
    const a = attach(bus, 'a', null)
    bus.setSubscription('a', [])

    bus.publish(delta('x'), c1)
    bus.publish(delta('y'), c2)
    expect(a.got).toHaveLength(0)
  })

  test('空集仍接收工作区级事件：退订的是会话事件，不是全部事件', () => {
    const bus = new EventBus()
    const a = attach(bus, 'a', null)
    bus.setSubscription('a', [])

    bus.publish(gitState)
    expect(a.types()).toEqual(['git.state'])
  })

  test('订阅 c1 时只接收 c1 的事件', () => {
    const bus = new EventBus()
    const a = attach(bus, 'a', new Set([c1]))
    bus.publish(delta('mine'), c1)
    bus.publish(delta('theirs'), c2)
    expect(a.got).toHaveLength(1)
    expect(a.got[0]?.conversationId).toBe(c1)
  })
})

describe('断线补发按订阅过滤', () => {
  /**
   * **原始失败形状**：重连之后界面中混入了另一条会话的正文。
   *
   * `replayFrom` 只按 seq 过滤时，补发路径上没有任何可见性判断：
   * 按会话隔离只在实时推送上成立、在补发上不成立，等同于没有隔离。
   */
  test('只补发订阅范围内的帧', () => {
    const bus = new EventBus()
    bus.publish(delta('c1-a'), c1)
    bus.publish(delta('c2-a'), c2)
    bus.publish(delta('c1-b'), c1)

    const onlyC1: Subscriber = {
      id: 'r',
      origin: 'mobile',
      conversations: new Set([c1]),
      send: () => {},
    }
    const replay = bus.replayFrom({ streamId: bus.streamId, lastSeq: 0 }, onlyC1)
    expect(replay?.map((f) => f.conversationId)).toEqual([c1, c1])
  })

  test('工作区级事件照常补发：它没有可归属的会话', () => {
    const bus = new EventBus()
    bus.publish(gitState)
    bus.publish(delta('other'), c2)

    const onlyC1: Subscriber = {
      id: 'r',
      origin: 'mobile',
      conversations: new Set([c1]),
      send: () => {},
    }
    expect(
      bus.replayFrom({ streamId: bus.streamId, lastSeq: 0 }, onlyC1)?.map((f) => f.event.type),
    ).toEqual(['git.state'])
  })

  test('已同步到最新时返回空数组，不是 null', () => {
    const bus = new EventBus()
    bus.publish(delta('a'), c1)
    const sub: Subscriber = { id: 'r', origin: 'cli', conversations: null, send: () => {} }
    expect(bus.replayFrom({ streamId: bus.streamId, lastSeq: bus.currentSeq }, sub)).toEqual([])
  })

  /** 缺口超出保留窗口时须明确返回 null，使客户端改为全量重新拉取，而不是静默缺少若干条。 */
  test('缺口超出保留窗口时返回 null', () => {
    const bus = new EventBus()
    for (let i = 0; i < 5100; i++) bus.publish(delta(String(i)), c1)
    const sub: Subscriber = { id: 'r', origin: 'cli', conversations: null, send: () => {} }
    expect(bus.replayFrom({ streamId: bus.streamId, lastSeq: 1 }, sub)).toBe(null)
  })
})

/**
 * 服务端重启之后重连。
 *
 * **原始失败形状**：sidecar 重启（开发态热重载、崩溃后重新启动），客户端持有上一代的
 * `lastSeq=800`，而新总线的 `seq=0`。只比较大小时 `800 >= 0` 被判定为「已是最新」，
 * 补发零条、resync 为假：界面始终停留在断线时的状态，该轮一直显示执行中，
 * 而账本中它在新进程启动时已被 `recoverStaleRuns` 判定为中断。
 */
describe('流更换后不能按位置比较大小', () => {
  const sub = (): Subscriber => ({
    id: 'r',
    origin: 'desktop',
    conversations: null,
    send: () => {},
  })

  test('上一代服务的位置一律返回 null，即使该值大于新流的 seq', () => {
    const before = new EventBus()
    for (let i = 0; i < 800; i++) before.publish(delta(String(i)), c1)

    const after = new EventBus()
    expect(after.currentSeq).toBe(0)
    expect(after.replayFrom({ streamId: before.streamId, lastSeq: before.currentSeq }, sub())).toBe(
      null,
    )
  })

  /**
   * 大幅落后时仍返回 null，不能只补发新流中的一段。
   *
   * 重连有退避（最长 15 秒），期间新服务可能已经推送几百条：此时
   * `lastSeq` 不再大于 `seq`，环中也仍保留第一帧，只按位置计算会补发
   * 「新流的 (lastSeq, now]」并声明补发完整，而被跳过的是新流开头的一段。
   */
  test('新流已推送更多帧时仍返回 null，不按位置补发其中一段', () => {
    const before = new EventBus()
    for (let i = 0; i < 10; i++) before.publish(delta(String(i)), c1)

    const after = new EventBus()
    for (let i = 0; i < 50; i++) after.publish(delta(String(i)), c1)
    expect(after.replayFrom({ streamId: before.streamId, lastSeq: 10 }, sub())).toBe(null)
  })

  test('两条总线的流身份必定不同：判据不能依赖恒定不变的值', () => {
    expect(new EventBus().streamId).not.toBe(new EventBus().streamId)
  })
})

/**
 * 保留窗口的字节上限。
 *
 * 原始失败形状：`qy serve` 在持续负载下 RSS 从约 105 MB 单调增长到约 430 MB，重启即回落。
 * 内存由该环持有：`tool.delta` 每帧带一整段命令输出（实测约 109 KB），
 * 帧数上限 5000 折合几百 MB。
 */
describe('保留窗口按字节设上限', () => {
  const sub = (): Subscriber => ({
    id: 'b',
    origin: 'desktop',
    conversations: null,
    send: () => {},
  })

  /** 一帧约 1 MB 的命令输出，结构与 `tool.delta` 一致。 */
  const bigDelta = (): AgentEvent =>
    ({
      type: 'tool.delta',
      runId: 'run_x',
      stepId: 'st_x',
      channel: 'stdout',
      delta: 'x'.repeat(1024 * 1024),
    }) as AgentEvent

  test('大帧累计达到字节上限即淘汰，环长度远低于帧数上限', () => {
    const bus = new EventBus()
    for (let i = 0; i < 200; i++) bus.publish(bigDelta(), c1)

    // 环中剩余帧数只能从补发结果反推：最早一帧之前的位置均无法补发。
    let retained = 0
    for (let lastSeq = bus.currentSeq; lastSeq > 0; lastSeq--) {
      if (bus.replayFrom({ streamId: bus.streamId, lastSeq: lastSeq - 1 }, sub()) === null) break
      retained++
    }
    expect(retained).toBeLessThan(200)
    expect(retained).toBeGreaterThan(0)
  })

  test('最早的位置无法补发（改为 resync），最新的位置仍可补发', () => {
    const bus = new EventBus()
    for (let i = 0; i < 200; i++) bus.publish(bigDelta(), c1)

    expect(bus.replayFrom({ streamId: bus.streamId, lastSeq: 0 }, sub())).toBe(null)
    const tail = bus.replayFrom({ streamId: bus.streamId, lastSeq: bus.currentSeq - 1 }, sub())
    expect(tail?.length).toBe(1)
    expect(tail?.[0]?.seq).toBe(bus.currentSeq)
  })

  test('小帧不触发字节淘汰：帧数上限内的全部可补发', () => {
    const bus = new EventBus()
    for (let i = 0; i < 4000; i++) bus.publish(delta(String(i)), c1)

    const all = bus.replayFrom({ streamId: bus.streamId, lastSeq: 0 }, sub())
    expect(all?.length).toBe(4000)
  })
})
