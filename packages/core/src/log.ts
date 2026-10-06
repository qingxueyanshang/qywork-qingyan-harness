/**
 * 运行日志的唯一出口。sidecar 各包只调用 `log.*`，输出位置由 sink 决定。
 *
 * sink 可注入：默认写入 stderr；`qy serve` 启动时替换为文件 sink（实现位于 `@qywork/runtime`，
 * 只有该层能取得数据目录）。本包不引用 node 模块，也不在模块顶层访问 `process`：
 * 它同时被打包进浏览器端。
 */

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogRecord {
  /** 毫秒时间戳。 */
  at: number
  level: LogLevel
  /** 来源模块，写在方括号中。 */
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

/** 替换 sink。传入 `null` 时恢复为 stderr。 */
export function setLogSink(next: LogSink | null): void {
  sink = next ?? stderrSink
}

/**
 * 一条记录一行：`时间 级别 [scope] 正文 key=value …`。
 *
 * 正文换行后的各行缩进输出，字段位于正文首行之后：多行正文（stderr 尾部、堆栈）
 * 不会把字段推到难以查看的位置。
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
  // sink 无法写入（磁盘已满、句柄失效）时改用 stderr。日志本身不能导致进程退出。
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
