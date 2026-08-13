/**
 * `qy usage` —— 问「这个月花了多少」。
 *
 * `runs` 上的 usage 答不了这个问题：它按 run 存，而删会话是正常操作。
 * 账本是独立的一张表，没有外键，所以账目比业务数据活得久。
 *
 *   qy usage                 最近 30 天
 *   qy usage --days 7        最近 7 天
 *   qy usage --by day        按天（还可以 model / workspace / kind）
 *   qy usage --json          给脚本用
 */

import { formatCosts } from '@qywork/core'
import { dataPath } from '@qywork/runtime'
import { type GroupBy, Store, usageBy, usageTotals } from '@qywork/store'

const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'

const GROUPS: GroupBy[] = ['model', 'day', 'workspace', 'kind', 'currency']

export async function runUsage(args: string[]): Promise<number> {
  const json = args.includes('--json')
  const daysFlag = args.indexOf('--days')
  const days = daysFlag >= 0 ? Number(args[daysFlag + 1] ?? '30') : 30
  const byFlag = args.indexOf('--by')
  const by = byFlag >= 0 ? (args[byFlag + 1] as GroupBy) : 'model'

  if (!Number.isFinite(days) || days <= 0) {
    process.stderr.write(`--days 要是一个正数，收到：${args[daysFlag + 1]}\n`)
    return 2
  }
  if (!GROUPS.includes(by)) {
    process.stderr.write(`--by 只能是 ${GROUPS.join(' / ')}，收到：${by}\n`)
    return 2
  }

  const store = new Store({ path: dataPath() })
  try {
    const since = Date.now() - days * 86_400_000
    const totals = usageTotals(store, { since })
    const rows = usageBy(store, by, { since })

    if (json) {
      process.stdout.write(`${JSON.stringify({ since, days, by, totals, rows }, null, 2)}\n`)
      return 0
    }

    if (totals.entries === 0) {
      process.stderr.write(`最近 ${days} 天没有记录。\n`)
      return 0
    }

    process.stdout.write(`${BOLD}最近 ${days} 天${RESET} ${DIM}共 ${totals.entries} 笔${RESET}\n\n`)
    const width = Math.max(...rows.map((r) => displayWidth(r.key)), 8)
    for (const r of rows) {
      process.stdout.write(
        `  ${pad(r.key, width)}  ${formatCosts(r.cost)}  ` +
          `${DIM}入 ${num(r.inputTokens)} 出 ${num(r.outputTokens)} ${cacheNote(r.cachedTokens)}${RESET}\n`,
      )
    }
    process.stdout.write(
      `\n  ${pad('合计', width)}  ${BOLD}${formatCosts(totals.cost)}${RESET}  ` +
        `${DIM}入 ${num(totals.inputTokens)} 出 ${num(totals.outputTokens)} ${cacheNote(totals.cachedTokens)}${RESET}\n`,
    )
    return 0
  } finally {
    store.close()
  }
}

/** 未回报显示「未回报」，不显示 0——后者是个具体但错误的结论。 */
function cacheNote(cached: number | null): string {
  return cached === null ? '缓存未回报' : `缓存 ${num(cached)}`
}

function num(n: number): string {
  return n.toLocaleString('en-US')
}

/** 中文字符占两列。不按显示宽度对齐的话，中英混排的表格会全歪。 */
function displayWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹯＀-｠￠-￦]/.test(ch) ? 2 : 1
  return w
}

function pad(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - displayWidth(s)))
}
