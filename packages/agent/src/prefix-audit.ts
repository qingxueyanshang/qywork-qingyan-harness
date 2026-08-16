/**
 * 冻结前缀审计。
 *
 * 提示缓存的命中条件是**前缀逐字节相同**。差一个字节，整段前缀重新计费——
 * 而且这件事**完全静默**：provider 不会说「你的缓存没命中因为第 3 段变了」，
 * 它只是照全价收钱。账单上看到的是「缓存命中率低」，看不到原因。
 *
 * 所以这里做两件事，一件事前一件事后：
 *
 * 1. **静态审计**（`auditFrozenText`）：扫前缀文本里有没有**天生会变**的东西——
 *    日期、绝对路径、计数、时间戳。这是唯一能在**改动落地前**拦住的检查，
 *    有回归测试盯着。
 * 2. **运行时审计**（`PrefixAudit`）：按会话记住前缀的哈希，变了就报，
 *    并指出**第几段、变成了什么**。静态审计只认得出已知的坏模式，
 *    真正的漂移往往来自「顺手在前缀里拼了个变量」这种没见过的写法。
 *
 * 两者缺一不可：只有静态的会漏，只有运行时的要等真的花了钱才知道。
 */

import type { SystemBlock } from '@qywork/ai'

/**
 * 冻结区的边界是**最后一个缓存断点**（含）。
 *
 * 断点之后的内容本来就允许变化，把它们算进审计范围会得到一片假警报——
 * 而假警报多了，真警报就没人看了。
 */
export function frozenBlocks(system: SystemBlock[]): SystemBlock[] {
  let lastBreak = -1
  for (const [i, b] of system.entries()) {
    if (b.cacheBreakpoint) lastBreak = i
  }
  // 一个断点都没有 = 没有声明冻结区，审计范围为空而不是「全部」。
  // 判成全部的话，任何一次正常的历史增长都会被报成漂移。
  return lastBreak < 0 ? [] : system.slice(0, lastBreak + 1)
}

export function hashFrozen(system: SystemBlock[]): string {
  const h = new Bun.CryptoHasher('sha256')
  for (const b of frozenBlocks(system)) {
    h.update(b.text)
    /*
     * 分隔符不能省：["ab",""] 与 ["a","b"] 拼起来一样，但它们是不同的前缀。
     *
     * 必须写成转义 `\0`，**不能是裸的 NUL 字节**：真的 0x00 在源码里完全看不见，
     * 而且它让整个文件被 grep 当成二进制（`Binary file matches`）——
     * 于是在这个文件里搜任何东西都搜不到。
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
  /** 为什么它会变。 */
  why: string
}

/**
 * 天生会变的东西。
 *
 * 每一条都对应一次真实可能犯的错，不是「理论上可能变」的穷举：
 * 这份清单越长，误报越多，越没人看。
 */
const VOLATILE_PATTERNS: { kind: string; re: RegExp; why: string }[] = [
  {
    kind: 'date',
    re: /\d{4}-\d{2}-\d{2}/,
    why: '日期每天都变；当前日期应该放在尾区注记里',
  },
  {
    kind: 'time',
    re: /\d{1,2}:\d{2}(:\d{2})?/,
    why: '时间每次请求都变',
  },
  {
    kind: 'abs-path',
    // 尾部只要求 1 个字符：`/tmp/ws` 这种短路径同样是绝对路径，
    // 要求 3 个字符会把它漏掉——而漏报正是这个审计最不能出的错。
    re: /(?:[A-Za-z]:\\[^\s"']+|\/(?:home|Users|tmp|var)\/[^\s"']+)/,
    why: '绝对路径因机器而异，也因工作区而异；工作区路径属于尾区注记',
  },
  {
    kind: 'timestamp',
    re: /\b1[6-9]\d{11}\b|\b1[6-9]\d{8}\b/,
    why: '毫秒/秒时间戳每次都变',
  },
  {
    kind: 'uuid',
    re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
    why: 'run id / 会话 id 之类每轮都变',
  },
]

/** 扫一段冻结文本里有没有天生会变的东西。 */
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
  /** 第一处不同的段序号。-1 = 段数变了。 */
  blockIndex: number
  /** 变化前后的片段，各截 120 字。够看出改了什么，又不至于把日志刷爆。 */
  before: string
  after: string
  /** 这是第几次漂移。反复漂移和只漂一次是两种不同的 bug。 */
  occurrence: number
}

/**
 * 按 cacheKey 记住前缀，变了就报。
 *
 * 只记哈希与文本**不够**——要指出「第几段、改成了什么」，所以整段留着。
 * 前缀通常几 KB，一个会话一份，代价可以忽略；而没有原文的漂移报告
 * 只能告诉你「有东西变了」，那等于没报。
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
    // 用新值替换旧值：下一次比的是「相对上一次」，否则第一次漂移之后
    // 每一轮都会重复报同一条，真正的第二次漂移反而被淹掉。
    this.seen.set(cacheKey, { hash, blocks, drifts })
    return report
  }

  /** 会话结束时清掉，避免长期运行的服务无限增长。 */
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

/** 一行人读的漂移说明。给日志用。 */
export function describeDrift(d: DriftReport): string {
  const where = d.blockIndex >= 0 ? `第 ${d.blockIndex + 1} 段` : '段数'
  return (
    `冻结前缀发生漂移（第 ${d.occurrence} 次，${where}）：${d.previousHash} → ${d.currentHash}\n` +
    `  之前：${d.before}\n  之后：${d.after}\n` +
    '  这会让整段前缀的提示缓存失效，按全价重新计费。'
  )
}
