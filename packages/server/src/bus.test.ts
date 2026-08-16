/**
 * 事件总线的按会话隔离。
 *
 * 覆盖范围：`bus.ts` 全部（`publish` / `setSubscription` / `replayFrom` / 可见性判定）。
 *
 * 这份测试是被一组真实症状逼出来的：切会话之后界面显示的是上一条会话的内容、
 * 偶尔卡死。根因不在「切换」那段代码里，在这里——**归属信息只用于发送那一刻的
 * 过滤，从不随帧发出**，而那层过滤在三处漏了：
 *
 * 1. 空订阅集被当成「全订阅」，于是前端发 `subscribe([])` 想退订，收到的是全部；
 * 2. 断线补发这条路上根本没有过滤，重连一次最多灌 5000 帧别人的事件；
 * 3. 客户端拿不到归属，无法自保。
 *
 * 所以下面每一条断言的形状都是**原始失败形状**（A2 的根治判定第 5 条），
 * 不是「新加的保护分支命中了」。
 */

import { describe, expect, test } from 'bun:test'
import type { AgentEvent, ConversationId, EventEnvelope } from '@qywork/core'
import { EventBus, type Subscriber } from './bus.ts'

const c1 = 'cv_one' as ConversationId
const c2 = 'cv_two' as ConversationId

/** 一条最小的会话内事件。用 text.delta 是因为它正是串台的主力——它不带 conversationId。 */
const delta = (s: string): AgentEvent =>
  ({ type: 'text.delta', runId: 'run_x', stepId: 'st_x', delta: s }) as AgentEvent

/** 工作区级事件：没有会话可归属，谁都该收到。 */
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
  test('帧上带 conversationId —— 客户端据此判断，不能只留在服务端内存里', () => {
    const bus = new EventBus()
    const frame = bus.publish(delta('a'), c1)
    expect(frame.conversationId).toBe(c1)
  })

  test('工作区级事件不带这个字段，而不是带一个空串', () => {
    const bus = new EventBus()
    expect(bus.publish(gitState).conversationId).toBeUndefined()
  })
})

describe('订阅语义：null 和空集不是一回事', () => {
  test('null = 还没声明过，会话事件全收 —— 首连时界面还没选会话', () => {
    const bus = new EventBus()
    const a = attach(bus, 'a', null)
    bus.publish(delta('x'), c1)
    bus.publish(delta('y'), c2)
    expect(a.got).toHaveLength(2)
  })

  /**
   * **这条就是原始失败形状。**
   *
   * 前端切项目时发 `client.subscribe([])`，本意是退订。`visibleTo` 里写一句
   * `if (sub.conversations.size === 0) return true` 就把空集当成了全订阅，
   * 于是所有会话的事件一起涌向这个客户端，而客户端无条件写进当前 transcript。
   */
  test('空集 = 明确不要任何会话事件，不是全订阅', () => {
    const bus = new EventBus()
    const a = attach(bus, 'a', null)
    bus.setSubscription('a', [])

    bus.publish(delta('x'), c1)
    bus.publish(delta('y'), c2)
    expect(a.got).toHaveLength(0)
  })

  test('空集仍然收工作区级事件 —— 退订的是会话，不是一切', () => {
    const bus = new EventBus()
    const a = attach(bus, 'a', null)
    bus.setSubscription('a', [])

    bus.publish(gitState)
    expect(a.types()).toEqual(['git.state'])
  })

  test('订了 c1 就只收 c1 的', () => {
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
   * **原始失败形状**：重连之后界面里混进了另一条会话的正文。
   *
   * `replayFrom` 只按 seq 过滤的话，补发路径上就没有任何可见性判断——
   * 按会话隔离在实时推送上成立、在补发上不成立，等于没有。
   */
  test('只补出订阅范围内的帧', () => {
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

  test('工作区级事件照补 —— 它没有会话可归属', () => {
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

  test('已经同步到最新时补出空数组，不是 null', () => {
    const bus = new EventBus()
    bus.publish(delta('a'), c1)
    const sub: Subscriber = { id: 'r', origin: 'cli', conversations: null, send: () => {} }
    expect(bus.replayFrom({ streamId: bus.streamId, lastSeq: bus.currentSeq }, sub)).toEqual([])
  })

  /** 缺口超出保留窗口要明确回 null，让客户端改走全量重拉，而不是悄悄少几条。 */
  test('缺口超出保留窗口回 null', () => {
    const bus = new EventBus()
    for (let i = 0; i < 5100; i++) bus.publish(delta(String(i)), c1)
    const sub: Subscriber = { id: 'r', origin: 'cli', conversations: null, send: () => {} }
    expect(bus.replayFrom({ streamId: bus.streamId, lastSeq: 1 }, sub)).toBe(null)
  })
})

/**
 * 服务端重启之后重连。
 *
 * **原始失败形状**：sidecar 重启（开发态热重载、崩溃拉起），客户端带着上一代的
 * `lastSeq=800` 撞上新总线的 `seq=0`。只比大小的话 `800 >= 0` 判成「已是最新」，
 * 补发零条、resync 为假——于是界面永远停在断线那一刻，那一轮一直显示执行中，
 * 而账本里它在新进程启动时就被 `recoverStaleRuns` 判成中断了。
 */
describe('换了一条流就不能按位置比大小', () => {
  const sub = (): Subscriber => ({
    id: 'r',
    origin: 'desktop',
    conversations: null,
    send: () => {},
  })

  test('上一代服务的位置一律回 null，哪怕那个数比新流的 seq 大', () => {
    const before = new EventBus()
    for (let i = 0; i < 800; i++) before.publish(delta(String(i)), c1)

    const after = new EventBus()
    expect(after.currentSeq).toBe(0)
    expect(after.replayFrom({ streamId: before.streamId, lastSeq: before.currentSeq }, sub())).toBe(
      null,
    )
  })

  /**
   * 落后一大截也仍然是 null，不能只补新流里那一段。
   *
   * 重连有退避（最长 15 秒），这段时间里新服务可能已经推了几百条——那时
   * `lastSeq` 不再大于 `seq`，环里也还留着第一帧，只按位置算会补出
   * 「新流的 (lastSeq, now]」并宣称补全了，而被跳过的恰恰是新流开头那一段。
   */
  test('新流已经推了更多帧，照样 null —— 不能补出一段假的缺口', () => {
    const before = new EventBus()
    for (let i = 0; i < 10; i++) before.publish(delta(String(i)), c1)

    const after = new EventBus()
    for (let i = 0; i < 50; i++) after.publish(delta(String(i)), c1)
    expect(after.replayFrom({ streamId: before.streamId, lastSeq: 10 }, sub())).toBe(null)
  })

  test('两条总线的流身份必定不同 —— 判据不能落在一个恒等的值上', () => {
    expect(new EventBus().streamId).not.toBe(new EventBus().streamId)
  })
})
