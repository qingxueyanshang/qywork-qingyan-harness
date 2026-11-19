/**
 * 自动重试的间隔与等待，共三套：
 * - 暂时故障的间隔表（`TRANSIENT_RETRY_DELAYS_MS`、`transientRetryDelay`）：子 agent 一轮之内的重发
 *   （`agent/loop/attempt.ts`，`RunInput.transientResend`）按此等待，次数为表的长度；系统提示写给模型的重试间隔
 *   取自 `retryScheduleText`，两处使用同一份数值。
 * - 重发的退避（`RESEND_LIMIT`、`resendDelay`）：顶层会话一轮之内的重发，以及生成的提交与素材上传被限流、
 *   连接失败或上传得到暂时不可用答复后的重试。
 * - 等待服务恢复的间隔（`RECOVERY_WAITS_MS`）：顶层会话的重发用尽之后，本轮继续等待对端恢复。
 *
 * 暂时故障指请求得到了表示暂时无法处理的应答（429 限流、5xx），或连接在请求发出之前失败。
 * 请求发出之后没有任何应答时远端可能已经受理并计费，不属于暂时故障，不得按本间隔重新提交。
 */

/**
 * 第 1、2、3 次重试之前的等待：30 秒、2 分钟、5 分钟。
 *
 * 子 agent 按此重发 3 次，用尽后失败回执立即交给派发它的会话：子 agent 重发期间父会话只能取得「仍在执行」，
 * 次数与间隔共同决定父会话最晚何时得知失败。2026-11-13 至 16 的账本中，失败后经重发恢复的 28 个请求轮次
 * 有 25 个在前 3 次重发之内恢复。
 */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 300_000]

/**
 * 抖动比例，只向后延。不要去除：同一批同时被拒的请求按相同间隔等待，会在同一时刻再次超出限额。
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

/** 间隔表前 `count` 项的中文写法（全部为「30 秒、2 分钟、5 分钟」），用于提示词。 */
export function retryScheduleText(count = TRANSIENT_RETRY_DELAYS_MS.length): string {
  return TRANSIENT_RETRY_DELAYS_MS.slice(0, count)
    .map((ms) => (ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : `${ms / 1000} 秒`))
    .join('、')
}

/** 请求被拒绝后的一次自动重试等待：第几次、上限与上次失败的原因。等待期间远端没有受理请求。 */
export interface RetryWait {
  attempt: number
  max: number
  reason: string
}

/**
 * 重试的显示文字，对话请求的重试提示、画布卡片的状态标签与悬停提示、生成工具的进度共用：
 * `retryAttemptText` 为「第 N/M 次重试」，`retryCauseText` 为「上次失败：原因」。
 */
export function retryAttemptText(retry: Pick<RetryWait, 'attempt' | 'max'>): string {
  return `第 ${retry.attempt}/${retry.max} 次重试`
}

export function retryCauseText(reason: string): string {
  return `上次失败：${reason}`
}

/**
 * 被限流或连接中断后原样重发的次数上限。对话请求一轮之内的重发（`agent/loop/attempt.ts`）、生成的提交与
 * 素材上传的重试（`ai/media/http.ts`）与 art 卡片请求的重试（`runtime/art.ts`）共用该值与 `resendDelay`；
 * 生成一侧按失败的类别各自计数。
 *
 * **该数值只在此处定义**，界面上「正在重连 N / M」中的 M 由 `run.retrying` 事件传递，不得在前端重复定义。
 *
 * 取 5 的依据是 2026-08-22 的一次实测：长思考请求 11/11 在 `reasoning_content`
 * 输出中途以 EOF 结束（无 `finish_reason`、无 `[DONE]`、无网络错误），短请求正常结束。
 * 中断的是上游的某条线路而不是整条链路，重发一次不足以恢复；每次尝试本身耗时数十秒至
 * 两分钟，5 次不构成对上游的密集请求。
 */
export const RESEND_LIMIT = 5

/**
 * 顶层会话的 `RESEND_LIMIT` 次重发用尽、失败仍属于暂时故障时，本轮继续等待对端恢复的各次最长等待：2、4、8、8、8 分钟，
 * 合计 30 分钟。同一端点与模型上本进程任一请求成功时提前结束等待（`agent/send-limit.ts` 的 `nextCompletion`），
 * 随后重发真实请求；表的长度即等待恢复期间的重发次数。
 *
 * 取 30 分钟：账本中服务侧失败之后，同一型号与接口的下一次成功请求在 2 分钟内的占 23%，30 分钟内的占 54%；
 * 更晚的成功多来自用户之后重新发起的会话，无法区分对端何时恢复。
 */
export const RECOVERY_WAITS_MS: readonly number[] = [120_000, 240_000, 480_000, 480_000, 480_000]

/** 重发退避的首个间隔。对端故障的恢复为秒级，更短的首个间隔等于不退避地反复请求对端。 */
const RESEND_BACKOFF_BASE_MS = 4_000

/** 单次退避上限。五次重发前依次等待约 4、8、16、32、60 秒，合计约两分钟。 */
const RESEND_BACKOFF_MAX_MS = 60_000

/** 按上游给出的 Retry-After 等待的上限。超过时等待该上限后重发，次数用尽即报告失败，避免一次请求长时间处于等待状态。 */
const RETRY_AFTER_MAX_MS = 60_000

/**
 * 第 `resends` 次重发（从 0 起）之前的等待毫秒数。对话请求的重发与生成的重试只经本函数计算等待，两处不另行处理 Retry-After。
 * - 退避间隔：4 秒起每次加倍，不超过 60 秒，另加至多十分之一的随机延后，使同时被拒的多个请求错开重发时刻。
 * - 上游给出等待时间（`retryAfterMs`）时按其等待，不短于退避间隔，不超过 60 秒。给出 0 时按退避间隔：
 *   立即重发会在数毫秒内用尽次数。
 */
export function resendDelay(resends: number, retryAfterMs: number | null): number {
  const step = Math.min(RESEND_BACKOFF_BASE_MS * 2 ** resends, RESEND_BACKOFF_MAX_MS)
  const backoff = Math.round(step * (1 + Math.random() * JITTER))
  return Math.max(backoff, Math.min(retryAfterMs ?? 0, RETRY_AFTER_MAX_MS))
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
