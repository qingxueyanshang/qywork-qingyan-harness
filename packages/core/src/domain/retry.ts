/**
 * 暂时故障的自动重试间隔与等待。
 *
 * 暂时故障指请求得到了表示暂时无法处理的应答（429 限流、5xx），或连接在请求发出之前失败。
 * 请求发出之后没有任何应答时远端可能已经受理并计费，不属于暂时故障，不得按本间隔重新提交。
 * 生成的提交（`ai/media/http.ts`）与子 agent 的重新派发（`server/delegate.ts`）按本间隔重试，
 * 系统提示写给模型的间隔取自 `retryScheduleText`，三处使用同一份数值。
 */

/** 第 1、2、3 次重试之前的等待：30 秒、2 分钟、5 分钟。 */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 300_000]

/**
 * 抖动比例，只向后延，不早于间隔表。不要去掉：同一批同时被拒的请求按相同间隔等待，会在同一时刻
 * 再次超出限额；间隔在 30 秒以上时，十分之一已能把它们错开数秒。
 */
const JITTER = 0.1

/**
 * 第 `retry` 次重试（从 0 起）之前的等待毫秒数。接口给出更长的 Retry-After 时按其等待，
 * 但不超过间隔表的最大值：超过时按间隔表重试，用尽后报告失败，不让一次调用无限期等待。
 */
export function transientRetryDelay(retry: number, retryAfterMs: number | null = null): number {
  const delays = TRANSIENT_RETRY_DELAYS_MS
  const longest = delays[delays.length - 1]!
  const base = Math.max(
    delays[Math.min(retry, delays.length - 1)]!,
    Math.min(retryAfterMs ?? 0, longest),
  )
  return Math.round(base * (1 + Math.random() * JITTER))
}

/**
 * 间隔表前 `count` 项的中文写法（全部为「30 秒、2 分钟、5 分钟」），用于提示词、回执与日志。
 * 只列出间隔表的数值，抖动与 Retry-After 带来的延后不在其中。
 */
export function retryScheduleText(count = TRANSIENT_RETRY_DELAYS_MS.length): string {
  return TRANSIENT_RETRY_DELAYS_MS.slice(0, count)
    .map((ms) => (ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : `${ms / 1000} 秒`))
    .join('、')
}

/**
 * 等待 `ms` 毫秒。`signal` 中止时立即以中止原因拒绝并清除计时器：用户停止时重试随之取消，
 * 不在停止之后再发出请求。
 */
export function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
