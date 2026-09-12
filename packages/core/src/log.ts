/**
 * 运行日志的唯一出口。sidecar 各包只调 `log.*`，落到哪里由 sink 决定。
 *
 * sink 可注入：默认写 stderr；`qy serve` 启动时换成文件 sink（实现在 `@qywork/runtime`，
 * 那一层才拿得到数据目录）。这个包不引 node 模块，也不在模块顶层碰 `process`：
 * 它同时被浏览器端打进包里。
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogRecord {
  /** 毫秒时间戳。 */
  at: number
  level: LogLevel
  /** 来源模块，写进方括号里。 */
  scope: string
  message: string
  fields?: Record<string, unknown>
}

export type LogSink = (record: LogRecord) => void

const LEVEL_TAG: Record<LogLevel, string> = { info: 'INFO ', warn: 'WARN ', error: 'ERROR' }

const stderrSink: LogSink = (record) => {
  process.stderr.write(`${formatLogLine(record)}\n`)
}

let sink: LogSink = stderrSink

/** 换 sink。传 `null` 回到 stderr。 */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? stderrSink
}

/**
 * 一条记录一行：`时间 级别 [scope] 正文 key=value …`。
 *
 * 正文里的换行缩进成续行，字段跟在正文首行之后——多行正文（stderr 尾部、堆栈）
 * 不会把字段推到看不见的地方。
 */
export function formatLogLine(record: LogRecord): string {
  const [first = '', ...rest] = record.message.split(/\r?\n/)
  const fields = record.fields
    ? Object.entries(record.fields)
        .map(([k, v]) => ` ${k}=${fieldValue(v)}`)
        .join('')
    : ''
  const head = `${new Date(record.at).toISOString()} ${LEVEL_TAG[record.level]} [${record.scope}] ${first}${fields}`
  return rest.length ? `${head}\n${rest.map((line) => `    ${line}`).join('\n')}` : head
}

function fieldValue(v: unknown): string {
  if (typeof v === 'string') return v === '' || /[\s"=]/.test(v) ? JSON.stringify(v) : v
  if (typeof v === 'number' || typeof v === 'boolean' || v === null || v === undefined)
    return String(v)
  if (v instanceof Error) return JSON.stringify(v.stack ?? v.message)
  return JSON.stringify(v)
}

function emit(
  level: LogLevel,
  scope: string,
  message: string,
  fields?: Record<string, unknown>,
): void {
  const record: LogRecord = { at: Date.now(), level, scope, message, ...(fields ? { fields } : {}) }
  // sink 写不动（磁盘满、句柄失效）时退回 stderr。日志本身不能成为让进程退出的原因。
  try {
    sink(record)
  } catch {
    stderrSink(record)
  }
}

export const log = {
  info: (scope: string, message: string, fields?: Record<string, unknown>): void =>
    emit('info', scope, message, fields),
  warn: (scope: string, message: string, fields?: Record<string, unknown>): void =>
    emit('warn', scope, message, fields),
  error: (scope: string, message: string, fields?: Record<string, unknown>): void =>
    emit('error', scope, message, fields),
}
