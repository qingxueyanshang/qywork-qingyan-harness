/**
 * 工具执行期间产生的事件如何传递到生成器。
 *
 * `run()` 是异步生成器，只能在**自身的执行栈**上 yield。而工具的中途输出
 * （shell 的 stdout / stderr）在 `await registry.execute(...)` 期间由回调产生，
 * 此时控制权不在生成器，因此必须经由队列传递。
 *
 * **不能等整批执行完成后再从队列取出**：一次 `npm test` 实测运行 50.7 秒，
 * 期间输出全部积压在内存中，界面上的输出区域没有任何变化，而该区域是
 * 「进程仍在运行」的唯一依据。因此本模块在等待期间持续取出事件，不在执行结束后一次取出。
 */

import type { AgentEvent } from '@qywork/core'

/**
 * 单生产者单消费者的事件队列。
 *
 * `wait()` 在有事件可取或已被 `poke()` 时立即兑现，否则挂起。
 * **「已被 poke」的锁存标记不能省略**：生产端先于消费端到达是常态
 * （工具在消费端开始等待之前就产生了第一行输出），缺少锁存会导致永久挂起。
 */
export class EventQueue {
  private items: AgentEvent[] = []
  private wake: (() => void) | null = null
  private signalled = false

  push(event: AgentEvent): void {
    this.items.push(event)
    this.release()
  }

  /** 唤醒等待方，不入队。执行结束时调用，使消费端能够观察到终态。 */
  poke(): void {
    this.release()
  }

  /** 取出全部积压事件，之后队列为空。 */
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
 * 等待 `work` 期间逐条交出队列中的事件；`work` 的结果作为返回值。
 *
 * 调用方写 `const r = yield* drainUntil(queue, work)`：`yield*` 的求值结果
 * 即本函数的 `return` 值，因此无需额外的输出参数。
 *
 * **异常不能直接向外抛出**：否则会跳过最后一次排空，导致工具已产生的输出丢失。
 * 因此先捕获（`work` 自带 onRejected，不会产生额外的 unhandledRejection），
 * 排空之后再原样重新抛出，中止语义与直接 `await` 时一致。
 *
 * `work` 结束之后不会再有入队：入队方只有当前这一批正在运行的工具。
 * 唯一的例外是中止：这一批工具仍在运行，但其输出属于正在被放弃的波次，
 * 应当丢弃，且随后立即重新抛出。
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
