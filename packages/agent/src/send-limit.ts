/**
 * 同一端点、同一模型同时在途的请求数上限。只由第三方报告的并发超限触发；从未被拒绝的端点不设上限。
 *
 * 并发超限由本进程同时发出的请求数引起，但上限不是固定值：同一第三方实测，本机在途 0–9 个时拒绝率为 0，
 * 15–24 个时 13–14%，30 个以上约一半，而在途 25 个时仍有 72% 正常完成。被拒的请求约 43 秒后才收到错误，
 * 退避 2–4 秒后的重发有 37% 再次被拒。因此不设固定上限，按拒绝自适应：被拒时降到拒绝时刻在途数的四分之三，
 * 此后每完成一次放宽 1/上限。
 *
 * 一批几乎同时被拒的请求只收紧一次：只有在最近一次收紧之后才发出的请求被拒，才再次收紧。
 * 否则同一次饱和中到达的每一条拒绝各收紧一次，上限连乘四分之三，降到远低于第三方实际可承受的数量。
 *
 * 状态由本进程内的全部轮次共用（`sendLimiter`）：第三方的并发按请求方计算，不区分会话与子 agent。
 */

import { diagnosticEndpoint, ProviderError } from '@qywork/ai'
import { log } from '@qywork/core'

/** 第三方在流内错误事件中报告并发超限时的 code。 */
const CONCURRENCY_REJECTED = 'gateway_concurrency_limit'

export type SendOutcome = 'completed' | 'concurrency_rejected' | 'failed'

/** 第三方是否报告了并发超限。 */
export function concurrencyRejected(err: unknown): boolean {
  return err instanceof ProviderError && err.detail?.providerCode === CONCURRENCY_REJECTED
}

interface Lane {
  inFlight: number
  /** null 表示未被拒绝、不限制。可以是小数：每次完成放宽 1/上限，取整后比较。 */
  limit: number | null
  /** 收紧的次数。请求记录发出时的值，据此判断其拒绝是否已被计入。 */
  generation: number
  waiting: (() => void)[]
}

export class SendLimiter {
  private readonly lanes = new Map<string, Lane>()

  /**
   * 取得一个在途名额，返回释放函数（只生效一次）。达到上限时按到达顺序排队；`signal` 中止时退出队列，
   * 以中止原因拒绝。
   */
  async acquire(key: string, signal: AbortSignal): Promise<(outcome: SendOutcome) => void> {
    signal.throwIfAborted()
    const lane = this.lane(key)
    if (lane.waiting.length || !open(lane)) {
      log.info('agent', '同时在途的请求已达上限，排队等待', {
        lane: key,
        inFlight: lane.inFlight,
        limit: Math.floor(lane.limit ?? 0),
      })
      await new Promise<void>((resolve, reject) => {
        const grant = () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        }
        const onAbort = () => {
          lane.waiting.splice(lane.waiting.indexOf(grant), 1)
          reject(signal.reason)
        }
        lane.waiting.push(grant)
        signal.addEventListener('abort', onAbort, { once: true })
      })
    } else {
      lane.inFlight++
    }
    const generation = lane.generation
    let done = false
    return (outcome) => {
      if (done) return
      done = true
      this.release(key, lane, outcome, generation)
    }
  }

  private lane(key: string): Lane {
    let lane = this.lanes.get(key)
    if (!lane) {
      lane = { inFlight: 0, limit: null, generation: 0, waiting: [] }
      this.lanes.set(key, lane)
    }
    return lane
  }

  private release(key: string, lane: Lane, outcome: SendOutcome, generation: number): void {
    const inFlight = lane.inFlight
    lane.inFlight--
    if (outcome === 'concurrency_rejected' && generation === lane.generation) {
      const before = lane.limit
      lane.limit = Math.max(1, Math.floor(Math.min(lane.limit ?? inFlight, inFlight) * 0.75))
      lane.generation++
      log.warn('agent', '第三方报告并发超限，降低同时在途的请求数上限', {
        lane: key,
        inFlight,
        from: before === null ? '不限' : Math.floor(before),
        to: lane.limit,
      })
    } else if (outcome === 'completed' && lane.limit !== null) {
      lane.limit += 1 / lane.limit
    }
    // 名额直接交给排在最前的等待者（计入在途后再唤醒），新到达者不能在唤醒与恢复之间插队。
    while (lane.waiting.length && open(lane)) {
      lane.inFlight++
      lane.waiting.shift()!()
    }
  }
}

function open(lane: Lane): boolean {
  return lane.limit === null || lane.inFlight < Math.floor(lane.limit)
}

/** 本进程共用的实例。 */
export const sendLimiter = new SendLimiter()

/**
 * 按端点与模型分别计数。实测被拒的 1,353 次中 1,287 次来自同一个模型；只按端点计数时，
 * 同一第三方上的其他模型会因该模型被拒而一并排队。
 */
export function sendLane(adapter: {
  endpoint?: string
  kind: string
  spec: { id: string }
}): string {
  // 去除认证段与查询串：该值写入日志。
  return `${diagnosticEndpoint(adapter.endpoint) ?? adapter.kind} ${adapter.spec.id}`
}
