/**
 * 界面运行记录的上报：加载失败、未处理的错误、连接变化与慢请求写入电脑端的运行日志（`POST /api/client-log`）。
 * 远程打开的界面在手机上运行，这些情况只有界面自己能观察到。
 *
 * - 记录先进入 sessionStorage 中的队列，连接可用时分批上报，上报成功后才移除；失败时留待下一次连接可用。
 * - 页面加载失败时界面代码尚未运行，`index.html` 把记录写入同一个键（`QUEUE_KEY`），下次加载成功、连接可用后补报。
 *   两处的键与条目形状（`ClientLogEntry`）必须一致。
 * - 队列最多保留 `QUEUE_MAX` 条，超出时丢弃最早的；每次页面加载最多记录 `ERRORS_PER_PAGE` 条未处理的错误，
 *   同一错误反复触发时不占满队列。
 */

import { CLIENT_LOG_MAX_ENTRIES, type ClientLogEntry, type LogLevel } from '@qywork/core'
import type { RequestTiming } from '../client.ts'
import { client } from './client.ts'
import { state } from './state.ts'

const QUEUE_KEY = 'qywork.clientLog'
const QUEUE_MAX = 50
const ERRORS_PER_PAGE = 20
/** 达到该耗时的请求作为慢请求上报（毫秒）。 */
const SLOW_REQUEST_MS = 2000
const LOG_PATH = '/api/client-log'

/** sessionStorage 不可用时（隐私模式）的队列；可用时与其内容相同。 */
let memory: ClientLogEntry[] = []
let flushing = false
let errors = 0

function readQueue(): ClientLogEntry[] {
  try {
    const raw = sessionStorage.getItem(QUEUE_KEY)
    return raw ? (JSON.parse(raw) as ClientLogEntry[]) : []
  } catch {
    return memory
  }
}

function writeQueue(list: ClientLogEntry[]): void {
  memory = list.slice(-QUEUE_MAX)
  try {
    if (memory.length) sessionStorage.setItem(QUEUE_KEY, JSON.stringify(memory))
    else sessionStorage.removeItem(QUEUE_KEY)
  } catch {
    // 同上：只保留在内存中，本页关闭后丢失。
  }
}

export function report(level: LogLevel, message: string, fields?: ClientLogEntry['fields']): void {
  writeQueue([...readQueue(), { at: Date.now(), level, message, ...(fields ? { fields } : {}) }])
  void flushReports()
}

/** 连接可用时分批上报队列。由连接进入可用状态与每次新增记录时调用；上报失败的记录保留在队列中。 */
export async function flushReports(): Promise<void> {
  if (flushing || state.connection !== 'ready') return
  flushing = true
  try {
    for (;;) {
      const batch = readQueue().slice(0, CLIENT_LOG_MAX_ENTRIES)
      if (!batch.length) return
      await client.api(LOG_PATH, {
        method: 'POST',
        // 与 `embed.ts` 的 `embedded` 同一判据。不导入它：该模块在顶层读取 `window`，而 store 在没有 DOM 的环境中也会被加载。
        body: JSON.stringify({
          origin: client.origin,
          embedded: window.parent !== window,
          entries: batch,
        }),
      })
      // 上报期间新增的记录追加在队尾，只移除已上报的前若干条。
      writeQueue(readQueue().slice(batch.length))
    }
  } catch {
    // 留待下一次连接可用时重试。
  } finally {
    flushing = false
  }
}

/** 慢请求与未收到响应的请求。上报自身的请求不计入，否则上报失败会不断产生新的记录。 */
export function reportRequest(t: RequestTiming): void {
  if (t.path === LOG_PATH) return
  if (t.status === 0) report('warn', '请求未收到响应', { ...t })
  else if (t.ms >= SLOW_REQUEST_MS) report('info', '慢请求', { ...t })
}

/** 调用栈保留的帧数。前几帧常在框架内部（如 Solid 的 `Show`），只保留三帧时无法定位到组件。 */
const STACK_FRAMES = 12

/** 调用栈压缩为一行：去掉每帧地址中的协议与主机，保留函数名、文件名与行列号。 */
export function compactStack(stack: string): string {
  return stack
    .split('\n')
    .slice(0, STACK_FRAMES + 1)
    .map((line) => line.trim().replace(/[a-z][\w+.-]*:\/\/[^/\s)]+\//gi, ''))
    .join(' | ')
}

/** 未处理的错误与拒绝。返回解除监听的函数。 */
export function observeClientErrors(): () => void {
  const record = (message: string, stack: string | undefined) => {
    if (errors >= ERRORS_PER_PAGE) return
    errors++
    report('error', message, stack ? { stack: compactStack(stack) } : undefined)
  }
  const onError = (e: ErrorEvent) => record(`未处理的错误：${e.message}`, e.error?.stack)
  const onRejection = (e: PromiseRejectionEvent) => {
    const r = e.reason
    record(
      `未处理的拒绝：${r instanceof Error ? r.message : String(r)}`,
      r instanceof Error ? r.stack : undefined,
    )
  }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
  }
}
