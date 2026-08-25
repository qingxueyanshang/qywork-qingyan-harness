/**
 * 工具执行期间产出的事件怎么到达生成器。
 *
 * `run()` 是异步生成器，只能在**自己的执行栈**上 yield。而工具的中途输出
 * （shell 的 stdout / stderr）是在 `await registry.execute(...)` 里由回调产出的，
 * 那时控制权不在生成器手上——所以必须经过一个队列。
 *
 * 队列本身不是问题，**攒到整批跑完再取才是**：一次 `npm test` 实测跑 50.7 秒，
 * 那 50.7 秒里输出全压在内存里，界面上一个字节都不变，而这一格是
 * 「进程仍在跑」的唯一证据。所以这里给出的是「边等边取」，不是「等完再取」。
 */

import type { AgentEvent } from '@qywork/core'

/**
 * 单生产者单消费者的事件队列。
 *
 * `wait()` 在有事件可取、或被 `poke()` 过时立即兑现，否则挂起。
 * **那个「被 poke 过」的锁存不能省**：生产端先于消费端到达是常态
 * （工具在消费端还没开始等的时候就产出了第一行），锁存掉了就是一次永久挂起。
 */
export class EventQueue {
  private items: AgentEvent[] = []
  private wake: (() => void) | null = null
  private signalled = false

  push(event: AgentEvent): void {
    this.items.push(event)
    this.release()
  }

  /** 唤醒等待方而不入队。执行结束时调，让消费端有机会看到终态。 */
  poke(): void {
    this.release()
  }

  /** 取走全部积压。取完队列为空。 */
  drain(): AgentEvent[] {
    const out = this.items
    this.items = []
    return out
  }

  wait(): Promise<void> {
    if (this.signalled) {
      this.signalled = false
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.wake = resolve
    })
  }

  private release(): void {
    const w = this.wake
    if (w) {
      this.wake = null
      w()
    } else {
      this.signalled = true
    }
  }
}

/**
 * 一边等 `work`，一边把队列里的事件逐条交出去；`work` 的结果作为返回值。
 *
 * 调用方写 `const r = yield* drainUntil(queue, work)`——`yield*` 的求值结果
 * 就是这里的 `return`，所以不需要额外的出参。
 *
 * **异常不能直接往外抛**：那会跳过最后一次排空，工具已经产出的输出就丢了。
 * 所以先接住（`work` 自带 onRejected，不会多出一条 unhandledRejection），
 * 排空之后再原样重抛——中止语义与直接 `await` 时一致。
 *
 * `work` 结束之后不会再有入队：入队方只有这一批正在跑的工具。
 * 唯一的例外是中止——那一批还在跑，但它们的输出属于一个正在被放弃的波次，
 * 丢掉是对的，而且下一行就抛了。
 */
export async function* drainUntil<T>(
  queue: EventQueue,
  work: Promise<T>,
): AsyncGenerator<AgentEvent, T, unknown> {
  const state: { done: boolean; failed: boolean; value?: T; error?: unknown } = {
    done: false,
    failed: false,
  }
  void work
    .then(
      (v) => {
        state.value = v
      },
      (e) => {
        state.failed = true
        state.error = e
      },
    )
    .finally(() => {
      state.done = true
      queue.poke()
    })

  for (;;) {
    await queue.wait()
    for (const e of queue.drain()) yield e
    if (state.done) break
  }

  if (state.failed) throw state.error
  return state.value as T
}
