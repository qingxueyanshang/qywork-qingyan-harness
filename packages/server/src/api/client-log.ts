/**
 * 界面上报的运行记录（`POST /api/client-log`）：逐条写入电脑端的运行日志，scope 为 `web`。
 *
 * 接口对已配对的任何一端开放，因此每次最多 `CLIENT_LOG_MAX_ENTRIES` 条，正文、字段数与字段值都截断：
 * 日志只保留一个轮转文件，不加限制时一端的上报可以挤出全部启动与错误记录。
 */

import {
  CLIENT_LOG_MAX_ENTRIES,
  type ClientLogEntry,
  type ClientLogRequest,
  type LogLevel,
  log,
} from '@qywork/core'
import type { ApiHandler } from './types.ts'
import { json } from './types.ts'

const MAX_MESSAGE = 500
const MAX_FIELDS = 12
const MAX_VALUE = 300
const LEVELS: readonly LogLevel[] = ['info', 'warn', 'error']

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** 只保留标量字段；字符串截断。 */
function fieldsOf(raw: unknown): Record<string, string | number | boolean | null> {
  if (!raw || typeof raw !== 'object') return {}
  const out: Record<string, string | number | boolean | null> = {}
  for (const [k, v] of Object.entries(raw).slice(0, MAX_FIELDS)) {
    if (typeof v === 'string') out[clip(k, 40)] = clip(v, MAX_VALUE)
    else if (typeof v === 'number' || typeof v === 'boolean' || v === null) out[clip(k, 40)] = v
  }
  return out
}

function valid(entry: unknown): entry is ClientLogEntry {
  if (!entry || typeof entry !== 'object') return false
  const e = entry as Partial<ClientLogEntry>
  return (
    typeof e.at === 'number' &&
    Number.isFinite(e.at) &&
    Math.abs(e.at) < 8.64e15 &&
    typeof e.message === 'string' &&
    LEVELS.includes(e.level as LogLevel)
  )
}

export const handleClientLogApi: ApiHandler = async (url, req) => {
  if (url.pathname !== '/api/client-log' || req.method !== 'POST') return null
  const body = (await req.json().catch(() => null)) as Partial<ClientLogRequest> | null
  const entries = Array.isArray(body?.entries) ? body.entries : null
  if (!entries || !entries.every(valid)) return json({ error: '上报的记录格式不正确' }, 422)
  if (entries.length > CLIENT_LOG_MAX_ENTRIES) {
    return json({ error: `一次最多上报 ${CLIENT_LOG_MAX_ENTRIES} 条` }, 422)
  }
  const origin = clip(typeof body?.origin === 'string' ? body.origin : '', 20)
  const embedded = body?.embedded === true
  for (const e of entries) {
    log[e.level]('web', clip(e.message, MAX_MESSAGE), {
      ...fieldsOf(e.fields),
      origin,
      embedded,
      clientAt: new Date(e.at).toISOString(),
    })
  }
  return json({ ok: true })
}
