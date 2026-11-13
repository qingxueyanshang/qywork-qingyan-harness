/**
 * 缓存未命中归因：把一个会话中每次主请求的未命中量分为六类，各项之和恒等于未命中量。
 * 纯函数，结果在读取时计算，不落盘。
 *
 * 未命中量 m = 输入 + 缓存写入；输入总量 t = 输入 + 命中 + 缓存写入。三种协议的适配器回报的输入
 * 都不含命中与写入，未回报命中时输入即为总量，因此 t 在两种情形下都是请求的输入总量。
 *
 * 新增内容 = clamp(t_N − t_P + R, 0, m)：P 是 N 之前最近一条带用量的主请求，R 是两者之间
 * 改写过 manifest 的压缩的回收量之和。余量整体归入第一条成立的原因：切换模型、工具变化、
 * 缓存过期、压缩、其他。缓存过期必须排在压缩之前：缓存已失效时，其间的压缩不再造成额外的未命中。
 */

import type { ProviderRequest } from '../model.ts'

export type CacheMissCause =
  | 'newContent'
  | 'compaction'
  | 'modelSwitch'
  | 'toolChange'
  | 'cacheExpiry'
  | 'other'

/** 各类未命中的 token 数。键集与 `CacheMissCause` 恒等，各值之和等于未命中量。 */
export type CacheMissAttribution = Record<CacheMissCause, number>

/** 归因所需的请求行字段，与 `ProviderRequest` 同名，请求行可直接传入。 */
export type CacheMissRequest = Pick<
  ProviderRequest,
  | 'model'
  | 'providerName'
  | 'providerKind'
  | 'cacheRouteFingerprint'
  | 'providerInputTokens'
  | 'providerCachedTokens'
  | 'providerCacheWriteTokens'
  | 'providerCacheWrite1hTokens'
  | 'createdAt'
  | 'sentAt'
  | 'completedAt'
>

/** 压缩记录：`createdAt` 取压缩步骤的创建时刻，其余字段取自压缩步骤的 payload。 */
export interface CacheMissCompaction {
  createdAt: number
  /** 0 表示未改写 manifest（跳过或失败），这类记录不参与归因。 */
  manifestRevision: number
  /** 压缩前占用。 */
  occupancy?: number
  /** 压缩后占用。缺少该项或 `occupancy` 时，该条的回收量按 0 计。 */
  occupancyAfter?: number
}

/** 5 分钟是各家缓存有效期中最短的一档，没有分档值时取该档。 */
const SHORT_TTL_MS = 5 * 60_000
const LONG_TTL_MS = 60 * 60_000

/**
 * 逐条归因。`requests` 是同一会话的全部主请求（不含摘要请求），按创建顺序排列；
 * `compactions` 是同一会话的压缩记录，顺序不限。返回值与 `requests` 逐条对应：
 * 没有用量或未回报命中量的请求为 null。
 *
 * 压缩位于 P 与 N 之间的判据是 `P.createdAt < 压缩.createdAt <= N.createdAt`：
 * 压缩步骤在下一次请求行创建之前写入，两者可能落在同一毫秒。
 *
 * 缓存有效期取同一线路（接口名、协议、型号均相同）不晚于 P 的最近一条有写入且带分档值的请求：
 * 其 1 小时档写入大于 0 时取 60 分钟，否则取 5 分钟；没有这样的请求时取 5 分钟。
 * 线路实际使用 1 小时档但不回报分档值时，5 至 60 分钟内由压缩造成的未命中会计为缓存过期。
 */
export function attributeCacheMisses(
  requests: readonly CacheMissRequest[],
  compactions: readonly CacheMissCompaction[],
): (CacheMissAttribution | null)[] {
  const rewrites = compactions.filter((c) => c.manifestRevision > 0)
  // 每条线路最近一次带分档值的写入对应的有效期。只在请求带用量时更新，
  // 因此处理 N 时表中的值都来自不晚于 P 的请求。
  const ttlOfLine = new Map<string, number>()
  let prev: CacheMissRequest | null = null
  return requests.map((n) => {
    const result = attribute(n, prev, rewrites, ttlOfLine)
    if (n.providerInputTokens !== null) {
      prev = n
      if ((n.providerCacheWriteTokens ?? 0) > 0 && n.providerCacheWrite1hTokens !== null) {
        ttlOfLine.set(lineOf(n), n.providerCacheWrite1hTokens > 0 ? LONG_TTL_MS : SHORT_TTL_MS)
      }
    }
    return result
  })
}

function attribute(
  n: CacheMissRequest,
  p: CacheMissRequest | null,
  rewrites: readonly CacheMissCompaction[],
  ttlOfLine: ReadonlyMap<string, number>,
): CacheMissAttribution | null {
  if (n.providerInputTokens === null || n.providerCachedTokens === null) return null
  const miss = n.providerInputTokens + (n.providerCacheWriteTokens ?? 0)
  const out: CacheMissAttribution = {
    newContent: 0,
    compaction: 0,
    modelSwitch: 0,
    toolChange: 0,
    cacheExpiry: 0,
    other: 0,
  }
  if (p === null) {
    out.newContent = miss
    return out
  }
  const between = rewrites.filter((c) => c.createdAt > p.createdAt && c.createdAt <= n.createdAt)
  const reclaimed = between.reduce(
    (sum, c) =>
      sum +
      (c.occupancy !== undefined && c.occupancyAfter !== undefined
        ? c.occupancy - c.occupancyAfter
        : 0),
    0,
  )
  const fresh = Math.min(miss, Math.max(0, totalOf(n) - totalOf(p) + reclaimed))
  out.newContent = fresh
  const ttl = ttlOfLine.get(lineOf(n)) ?? SHORT_TTL_MS
  out[residualCause(p, n, between.length > 0, ttl)] = miss - fresh
  return out
}

function residualCause(
  p: CacheMissRequest,
  n: CacheMissRequest,
  compacted: boolean,
  ttl: number,
): Exclude<CacheMissCause, 'newContent'> {
  if (lineOf(p) !== lineOf(n)) return 'modelSwitch'
  if (p.cacheRouteFingerprint !== n.cacheRouteFingerprint) return 'toolChange'
  if (n.sentAt !== null && p.completedAt !== null && n.sentAt - p.completedAt > ttl) {
    return 'cacheExpiry'
  }
  return compacted ? 'compaction' : 'other'
}

/** 输入总量。调用方已确认 `providerInputTokens` 不为 null。 */
function totalOf(r: CacheMissRequest): number {
  return (
    (r.providerInputTokens ?? 0) + (r.providerCachedTokens ?? 0) + (r.providerCacheWriteTokens ?? 0)
  )
}

function lineOf(r: CacheMissRequest): string {
  return JSON.stringify([r.providerName, r.providerKind, r.model])
}
