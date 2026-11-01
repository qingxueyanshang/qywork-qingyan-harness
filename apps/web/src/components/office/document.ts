/**
 * Office 预览的共用部分：按路径与修改时间取得文件字节、与解析 Worker 的请求和回复、失败原因与能力边界的文案。
 *
 * - 只在路径或修改时间变化时重新加载，判据经 memo 且为字符串（与 `FileView` 的 PDF 相同）。
 *   重新加载期间保留上一份内容，新内容就绪后才交给调用方替换，调用方据此保留位置。
 * - Worker 由调用方以 `new Worker(new URL('./x-worker.ts', import.meta.url), { type: 'module' })` 创建后交给
 *   `connectWorker`。不要把这一表达式移入本模块、改为传入地址：打包工具只识别调用处的这一字面形式，
 *   改写后 Worker 文件按普通资源原样复制，打包版无法运行。以模块 Worker 从同源文件加载：打包版 CSP 为
 *   `default-src 'self'`，不放行 `blob:` 地址的 Worker。
 */

import type { OpcFailure } from '@qywork/ooxml/opc'
import {
  type Accessor,
  batch,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from 'solid-js'
import { ApiError } from '../../lib/client.ts'
import { client, explainApiError } from '../../lib/store/index.ts'

/** 主线程发给 Worker 的消息：`id` 用于对应回复。 */
export interface WorkerRequest<T> {
  readonly id: number
  readonly body: T
}

/**
 * Worker 的回复。Worker 须捕获处理中的异常并以 `error` 回复：异步处理函数中的异常不会触发主线程
 * `Worker` 的 `error` 事件，主线程会一直等待。
 */
export type WorkerReply<T> =
  | { readonly id: number; readonly body: T }
  | { readonly id: number; readonly error: string }

export interface WorkerChannel<Req extends { readonly kind: string }, Replies> {
  /** 发送一条请求；`transfer` 中的缓冲区转移给 Worker。通道关闭或 Worker 出错时拒绝。 */
  request<K extends Req['kind'] & keyof Replies>(
    body: Extract<Req, { readonly kind: K }>,
    transfer?: Transferable[],
  ): Promise<Replies[K]>
  /** 结束 Worker，拒绝尚未回复的请求。可重复调用。 */
  close(): void
}

/** `Replies` 为请求种类到回复内容的对应。 */
export function connectWorker<Req extends { readonly kind: string }, Replies>(
  worker: Worker,
): WorkerChannel<Req, Replies> {
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >()
  let next = 0
  let closed = false

  const fail = (reason: Error) => {
    closed = true
    worker.terminate()
    for (const p of pending.values()) p.reject(reason)
    pending.clear()
  }
  worker.onmessage = (e: MessageEvent<WorkerReply<unknown>>) => {
    const p = pending.get(e.data.id)
    if (!p) return
    pending.delete(e.data.id)
    if ('error' in e.data) p.reject(new Error(e.data.error))
    else p.resolve(e.data.body)
  }
  worker.onerror = (e) => fail(new Error(e.message || '无法启动解析线程'))

  return {
    request(body, transfer = []) {
      if (closed) return Promise.reject(new Error('解析线程已结束'))
      const id = next++
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve: resolve as (value: unknown) => void, reject })
        worker.postMessage({ id, body } satisfies WorkerRequest<typeof body>, { transfer })
      })
    },
    close() {
      if (!closed) fail(new Error('解析线程已结束'))
    },
  }
}

/**
 * 按 `source` 的路径与修改时间取得文件字节并交给 `load`。`load` 返回字符串表示失败原因；返回文档时在同一批更新中
 * 清除失败原因并调用 `show`。返回当前的失败原因，没有失败时为 `null`。
 * 路径或修改时间再次变化、组件卸载时中止进行中的加载：`signal` 中止后 `load` 的结果不再采用。
 */
export function createDocumentLoader<T extends object>(
  source: () => { readonly path: string; readonly mtime: number },
  load: (bytes: ArrayBuffer, signal: AbortSignal) => Promise<T | string>,
  show: (doc: T) => void,
): Accessor<string | null> {
  const [error, setError] = createSignal<string | null>(null)
  const key = createMemo(() => {
    const s = source()
    return JSON.stringify([s.path, s.mtime])
  })
  let loading: AbortController | null = null
  createEffect(
    on(key, () => {
      loading?.abort()
      const controller = new AbortController()
      loading = controller
      const { signal } = controller
      const url = `/api/files/raw?path=${encodeURIComponent(source().path)}`
      void (async () => {
        const res = await client.raw(url, { signal })
        if (!res.ok) throw new ApiError(res.status, url, await res.text().catch(() => ''))
        return load(await res.arrayBuffer(), signal)
      })().then(
        (next) => {
          if (signal.aborted) return
          if (typeof next === 'string') setError(next)
          else
            batch(() => {
              setError(null)
              show(next)
            })
        },
        (err: unknown) => {
          if (!signal.aborted) setError(explainApiError(err, '预览失败'))
        },
      )
    }),
  )
  onCleanup(() => loading?.abort())
  return error
}

export function failureText(failure: { readonly kind: OpcFailure['kind'] }): string {
  switch (failure.kind) {
    case 'encrypted':
      return '文件已加密'
    case 'legacy':
      return '旧格式文件，暂不支持预览'
    case 'not-office':
      return '不是 Office 文件'
    case 'corrupt':
      return '文件已损坏'
  }
}

/** 能力边界一行：按 `labels` 的顺序列出计数大于 0 的种类；都为 0 时为 `null`。 */
export function boundaryText<K extends string>(
  counts: Partial<Record<K, number>>,
  labels: Readonly<Record<K, string>>,
): string | null {
  const parts: string[] = []
  for (const [kind, label] of Object.entries(labels) as [K, string][]) {
    const n = counts[kind] ?? 0
    if (n > 0) parts.push(`${label} ${n}`)
  }
  return parts.length > 0 ? `未显示：${parts.join('、')}` : null
}
