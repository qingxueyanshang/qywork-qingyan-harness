import type { CloudUsage } from '@qywork/core'
import { For } from 'solid-js'
import { compact } from '../../lib/step-view.ts'
import { formatCredits } from './format.ts'

/** 列数：53 周，最后一列是本周。 */
const WEEKS = 53
const DAY_MS = 86_400_000

type Day = CloudUsage['days'][number]

/** 本地日期 `YYYY-MM-DD`；云端按电脑所在时区分日，两边须使用同一种写法才能对上。 */
function localDay(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 周一为每列第一格。 */
function weekdayIndex(d: Date): number {
  return (d.getDay() + 6) % 7
}

interface Cell {
  day: string
  /** 0 为没有请求；1–4 按 token 在有请求的日子中的名次分档。 */
  level: number
  usage: Day | null
  /** 本周中今天之后的日期：不绘制。 */
  future: boolean
}

/** 按列（周）排列的方格与每列上方的月份标签（该列含有某月 1 日时显示）。 */
export function activityCells(days: Day[], today: Date): { cells: Cell[]; months: string[] } {
  const byDay = new Map(days.map((d) => [d.day, d]))
  const active = days.map((d) => d.tokens).filter((t) => t > 0)
  // 按名次分档：不超过该值的天数占有请求天数的比例，向上取整到四档，用量最多的一天总是第 4 档。
  // 不要改为按四分位数的取值分档：只有一天有请求时，它落在最浅的一档。
  const level = (tokens: number) =>
    tokens <= 0 ? 0 : Math.ceil((4 * active.filter((t) => t <= tokens).length) / active.length)

  const start = new Date(today)
  start.setHours(12, 0, 0, 0)
  start.setTime(start.getTime() - ((WEEKS - 1) * 7 + weekdayIndex(today)) * DAY_MS)
  const todayKey = localDay(today)
  const cells: Cell[] = []
  const months: string[] = []
  for (let col = 0; col < WEEKS; col++) {
    let label = ''
    for (let row = 0; row < 7; row++) {
      const date = new Date(start.getTime() + (col * 7 + row) * DAY_MS)
      const key = localDay(date)
      if (date.getDate() === 1) label = `${date.getMonth() + 1}月`
      const usage = byDay.get(key) ?? null
      cells.push({ day: key, level: level(usage?.tokens ?? 0), usage, future: key > todayKey })
    }
    months.push(label)
  }
  return { cells, months }
}

/** 近 53 周逐日的 token 用量，每格一天，颜色按档位加深。 */
export function ActivityGrid(props: { days: Day[] }) {
  const grid = () => activityCells(props.days, new Date())
  return (
    <div class="account-activity">
      <div class="account-activity-months" aria-hidden="true">
        <For each={grid().months}>{(m) => <span>{m}</span>}</For>
      </div>
      <div class="account-activity-grid">
        <For each={grid().cells}>
          {(c) => (
            <span
              class="account-activity-cell"
              classList={{ future: c.future }}
              data-level={c.level}
              data-tip={
                c.future
                  ? undefined
                  : c.usage
                    ? `${c.day} · ${compact(c.usage.tokens)} token · ${formatCredits(c.usage.credits)} 积分 · ${c.usage.requests} 次`
                    : c.day
              }
            />
          )}
        </For>
      </div>
    </div>
  )
}
