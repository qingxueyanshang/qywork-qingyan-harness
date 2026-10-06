/**
 * 页面状态的刷新恢复。
 *
 * `sessionSignal` 与 `createSignal` 用法相同，区别是初值取自记录：整页刷新后，以同一个键建立的信号
 * 得到刷新前的值。记录保存在 sessionStorage 中，只在刷新时恢复，应用重启后为初始状态：
 * 终端与内置浏览器页由外壳进程持有，重启后已不存在。
 *
 * 设值只写入内存中的待写表，`pagehide` 时一次写入 sessionStorage。不要改为每次设值都写入：
 * 拖动画布每帧修改视口、输入框每次按键修改草稿，sessionStorage 的写入是同步操作。
 * 读取先查待写表，因此组件卸载后再挂载时取得的是最近的值，而不是上次刷新前的值。
 *
 * 值必须能经 JSON 往返；Set 与 Map 由调用方提供转换（`SET_CODEC` / `MAP_CODEC`）。
 */

import { type Accessor, createSignal, type Setter } from 'solid-js'

const pending = new Map<string, unknown>()

/** 取记录中的值；没有记录或无法解析时为 `undefined`。 */
export function readSession<T>(key: string): T | undefined {
  if (pending.has(key)) return pending.get(key) as T | undefined
  try {
    const raw = sessionStorage.getItem(key)
    return raw === null ? undefined : (JSON.parse(raw) as T)
  } catch {
    // 隐私模式下 sessionStorage 可能抛出异常；记录无法读取时使用初值。
    return undefined
  }
}

/** 记录一个值，`pagehide` 时写入。`undefined` 表示删除记录。 */
export function writeSession(key: string, value: unknown): void {
  pending.set(key, value)
}

/** 把待写表写入 sessionStorage 并清空。由 `pagehide` 调用。 */
export function flushSession(): void {
  for (const [key, value] of pending) {
    try {
      if (value === undefined) sessionStorage.removeItem(key)
      else sessionStorage.setItem(key, JSON.stringify(value))
    } catch {
      // 同上：保存失败只影响刷新后的恢复。
    }
  }
  pending.clear()
}

globalThis.addEventListener('pagehide', flushSession)

/** 值与 JSON 之间的转换。 */
export interface SessionCodec<T> {
  save(value: T): unknown
  load(raw: unknown): T
}

export const SET_CODEC: SessionCodec<ReadonlySet<string>> = {
  save: (value) => [...value],
  load: (raw) => new Set(raw as string[]),
}

export const MAP_CODEC: SessionCodec<ReadonlyMap<string, boolean>> = {
  save: (value) => [...value],
  load: (raw) => new Map(raw as [string, boolean][]),
}

/** 初值取自记录、每次设值都记录的信号。 */
export function sessionSignal<T>(
  key: string,
  initial: T,
  codec?: SessionCodec<T>,
): [Accessor<T>, Setter<T>] {
  const raw = readSession<unknown>(key)
  const [get, set] = createSignal<T>(
    raw === undefined ? initial : codec ? codec.load(raw) : (raw as T),
  )
  const write = set as (next: unknown) => T
  const save = ((next: unknown) => {
    const value = write(next)
    writeSession(key, codec ? codec.save(value) : value)
    return value
  }) as Setter<T>
  return [get, save]
}
