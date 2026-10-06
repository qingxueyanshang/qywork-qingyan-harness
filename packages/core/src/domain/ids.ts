/**
 * 领域标识符。
 *
 * 全部使用带前缀的字符串 ID，不使用自增整数：这些表都有删除路径，自增主键会复用
 * 被删除的最大 id，导致 retry_of_run_id / step.artifact_id 等跨表引用静默指向
 * 另一行。带前缀的随机 ID 从结构上消除该问题，日志中也可直接识别类型。
 */

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

/** 时间戳段宽度。base36 下 9 位可表示到公元 5000 年后，长度恒定，不会增加位数。 */
const TS_WIDTH = 9
/** 同毫秒序号段宽度。base36 四位可表示每毫秒 167 万个，远超实际生成速率。 */
const SEQ_WIDTH = 4

let lastMs = 0
let seqInMs = 0

function base36(value: number, width: number): string {
  let out = ''
  let n = Math.max(0, Math.floor(value))
  while (n > 0) {
    out = ALPHABET[n % 36] + out
    n = Math.floor(n / 36)
  }
  return out.padStart(width, '0')
}

/**
 * 单调递增 ID：`<时间戳><同毫秒序号><随机后缀>`，三段均为**定宽**。
 *
 * 字典序必须严格等于生成顺序，两处正确性依赖于此：
 * - 会话/消息列表按 id 排序；
 * - `listMessages` 用 `id <= upperBound` 划定 run 的消息高水位。
 *
 * 只编码毫秒时间戳、后缀直接使用随机字节时，**同一毫秒内的 ID 字典序是随机的**。
 * 高水位会把同一毫秒内写入的前序消息误判为「在水位之后」，
 * 使其从 run 的历史中丢失（由 `ids.test.ts` 锁定）。
 *
 * 定宽同样是必需的：变长时 'aaa' 会排在数值更小的 'z9' 之前，跨越长度边界时排序失效。
 *
 * 时钟回拨（NTP 校时、虚拟机挂起恢复）时不回退：沿用上一个毫秒值并继续递增序号，
 * ID 中的时间戳可以略微超前，但顺序不得倒置。
 */
function monotonicId(): string {
  const now = Date.now()
  if (now > lastMs) {
    lastMs = now
    seqInMs = 0
  } else {
    seqInMs++
  }

  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  let tail = ''
  for (const b of bytes) tail += ALPHABET[b % 36]

  return `${base36(lastMs, TS_WIDTH)}${base36(seqInMs, SEQ_WIDTH)}${tail}`
}

export type ConversationId = string & { readonly __brand: 'ConversationId' }
export type MessageId = string & { readonly __brand: 'MessageId' }
export type RunId = string & { readonly __brand: 'RunId' }
export type StepId = string & { readonly __brand: 'StepId' }
export type ToolCallId = string & { readonly __brand: 'ToolCallId' }
export type ResourceId = string & { readonly __brand: 'ResourceId' }
export type ProviderRequestId = string & { readonly __brand: 'ProviderRequestId' }
export type WorkspaceId = string & { readonly __brand: 'WorkspaceId' }
export type GoalId = string & { readonly __brand: 'GoalId' }

export const newConversationId = () => `cv_${monotonicId()}` as ConversationId
export const newMessageId = () => `ms_${monotonicId()}` as MessageId
export const newRunId = () => `rn_${monotonicId()}` as RunId
export const newStepId = () => `st_${monotonicId()}` as StepId
export const newResourceId = () => `rs_${monotonicId()}` as ResourceId
export const newProviderRequestId = () => `pr_${monotonicId()}` as ProviderRequestId
export const newWorkspaceId = () => `ws_${monotonicId()}` as WorkspaceId
/**
 * 目标 id。**此处依赖「字典序即创建顺序」**：
 * `goal_events` 表没有自增列，会话的最新目标通过
 * `ORDER BY goal_id DESC` 取得。
 */
export const newGoalId = () => `gl_${monotonicId()}` as GoalId

/** 账本条目。不是领域实体，没有品牌类型，只是一行用量记录。 */
export const newUsageId = () => `ug_${monotonicId()}`
