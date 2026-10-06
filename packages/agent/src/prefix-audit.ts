/**
 * 冻结前缀审计。
 *
 * 提示缓存的命中条件是前缀逐字节相同。相差一个字节，整段前缀即重新计费，
 * 且不产生任何报错：provider 不说明缓存未命中的原因，
 * 只按全价计费。账单只显示缓存命中率低，不显示原因。
 *
 * 因此本模块执行两项检查，一项在事前，一项在事后：
 *
 * 1. 静态审计（`auditFrozenText`）：扫描前缀文本中是否有本身会变化的字段，
 *    包括日期、绝对路径、计数、时间戳。这是唯一能在改动合入前拦截问题的检查，
 *    由回归测试执行。
 * 2. 运行时审计（`PrefixAudit`）：按会话记录前缀的哈希，变化时报告，
 *    并指出变化的段序号与新内容。静态审计只能识别已知的错误模式，
 *    实际的漂移往往来自未预见的写法，例如在前缀中拼接了变量。
 *
 * 两者缺一不可：只有静态审计会遗漏问题，只有运行时审计则要在产生费用后才能发现。
 */

import type { SystemBlock } from '@qywork/ai'

/**
 * 冻结区的边界是最后一个缓存断点（含该断点）。
 *
 * 断点之后的内容允许变化，将其计入审计范围会产生大量误报，
 * 误报过多会使真实告警被忽略。
 */
export function frozenBlocks(system: SystemBlock[]): SystemBlock[] {
  let lastBreak = -1
  for (const [i, b] of system.entries()) {
    if (b.cacheBreakpoint) lastBreak = i
  }
  // 没有断点表示未声明冻结区，审计范围为空而不是全部。
  // 若判定为全部，任何一次正常的历史增长都会被报告为漂移。
  return lastBreak < 0 ? [] : system.slice(0, lastBreak + 1)
}

export function hashFrozen(system: SystemBlock[]): string {
  const h = new Bun.CryptoHasher('sha256')
  for (const b of frozenBlocks(system)) {
    h.update(b.text)
    /*
     * 分隔符不能省略：`['ab','']` 与 `['a','b']` 拼接结果相同，但它们是不同的前缀。
     *
     * 必须写成转义 `\0`，不能写入原始 NUL 字节：0x00 在源码中不可见，
     * 且会使 grep 把整个文件视为二进制（`Binary file matches`），
     * 导致在本文件中 grep 任何内容都无法得到匹配行。
     */
    h.update('\0')
  }
  return h.digest('hex').slice(0, 16)
}

// ───────────────────────── 静态审计 ─────────────────────────

export interface VolatileHit {
  /** 命中的模式名，用于给出可执行的修改建议。 */
  kind: string
  /** 原文片段。 */
  sample: string
  /** 变化原因。 */
  why: string
}

/**
 * 本身会变化的字段。
 *
 * 每一条都对应一种实际可能出现的错误，而不是对理论上可能变化的字段的穷举：
 * 清单越长，误报越多，审计结果越容易被忽略。
 */
const VOLATILE_PATTERNS: { kind: string; re: RegExp; why: string }[] = [
  {
    kind: 'date',
    re: /\d{4}-\d{2}-\d{2}/,
    why: '日期每天变化；当前日期应放在上下文末尾的注记中',
  },
  {
    kind: 'time',
    re: /\d{1,2}:\d{2}(:\d{2})?/,
    why: '时间随每次请求变化',
  },
  {
    kind: 'abs-path',
    // 尾部只要求 1 个字符：`/tmp/ws` 等短路径同样是绝对路径，
    // 要求 3 个字符会将其遗漏，而漏报是本审计最需要避免的错误。
    re: /(?:[A-Za-z]:\\[^\s"']+|\/(?:home|Users|tmp|var)\/[^\s"']+)/,
    why: '绝对路径因机器与工作区而异；工作区路径应放在上下文末尾的注记中',
  },
  {
    kind: 'timestamp',
    re: /\b1[6-9]\d{11}\b|\b1[6-9]\d{8}\b/,
    why: '毫秒或秒级时间戳每次都会变化',
  },
  {
    kind: 'uuid',
    re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    why: 'run id、会话 id 等标识每轮都会变化',
  },
]

/** 扫描一段冻结文本中是否存在本身就会变化的字段。 */
export function auditFrozenText(text: string): VolatileHit[] {
  const hits: VolatileHit[] = []
  for (const p of VOLATILE_PATTERNS) {
    const m = p.re.exec(text)
    if (m) hits.push({ kind: p.kind, sample: m[0], why: p.why })
  }
  return hits
}

export function auditFrozenPrefix(system: SystemBlock[]): VolatileHit[] {
  return frozenBlocks(system).flatMap((b) => auditFrozenText(b.text))
}

// ───────────────────────── 运行时审计 ─────────────────────────

export interface DriftReport {
  cacheKey: string
  previousHash: string
  currentHash: string
  /** 第一处不同的段序号。-1 表示段数变化。 */
  blockIndex: number
  /** 变化前后的片段，各截取 120 字：足以看出改动内容，又不会使日志过长。 */
  before: string
  after: string
  /** 漂移的累计次数。反复漂移与单次漂移是两种不同的缺陷。 */
  occurrence: number
}

/**
 * 按 cacheKey 记录前缀，变化时报告。
 *
 * 只记录哈希不够：需要指出变化的段序号与新内容，因此保留各段原文。
 * 前缀通常为数 KB，每个会话一份，代价可以忽略；没有原文的漂移报告
 * 只能说明有内容变化，无法用于定位。
 */
export class PrefixAudit {
  private readonly seen = new Map<string, { hash: string; blocks: string[]; drifts: number }>()

  observe(cacheKey: string, system: SystemBlock[]): DriftReport | null {
    const blocks = frozenBlocks(system).map((b) => b.text)
    const hash = hashFrozen(system)
    const prev = this.seen.get(cacheKey)

    if (!prev) {
      this.seen.set(cacheKey, { hash, blocks, drifts: 0 })
      return null
    }
    if (prev.hash === hash) return null

    const drifts = prev.drifts + 1
    const idx = firstDifference(prev.blocks, blocks)
    const report: DriftReport = {
      cacheKey,
      previousHash: prev.hash,
      currentHash: hash,
      blockIndex: idx,
      before: idx >= 0 ? clip(prev.blocks[idx] ?? '') : `${prev.blocks.length} 段`,
      after: idx >= 0 ? clip(blocks[idx] ?? '') : `${blocks.length} 段`,
      occurrence: drifts,
    }
    // 用新值替换旧值：下一次与上一次的值比较，否则第一次漂移之后
    // 每一轮都会重复报告同一条，真正的第二次漂移会被掩盖。
    this.seen.set(cacheKey, { hash, blocks, drifts })
    return report
  }

  /** 会话结束时清除，避免长期运行的服务内存无限增长。 */
  forget(cacheKey: string): void {
    this.seen.delete(cacheKey)
  }

  get size(): number {
    return this.seen.size
  }
}

function firstDifference(a: string[], b: string[]): number {
  if (a.length !== b.length) return -1
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return i
  }
  return -1
}

function clip(text: string): string {
  return text.length <= 120 ? text : `${text.slice(0, 120)}…`
}

/** 供人阅读的漂移说明，用于日志。 */
export function describeDrift(d: DriftReport): string {
  const where = d.blockIndex >= 0 ? `第 ${d.blockIndex + 1} 段` : '段数'
  return (
    `冻结前缀发生漂移（第 ${d.occurrence} 次，${where}）：${d.previousHash} → ${d.currentHash}\n` +
    `  之前：${d.before}\n  之后：${d.after}\n` +
    '  整段前缀的提示缓存因此失效，按全价重新计费。'
  )
}
