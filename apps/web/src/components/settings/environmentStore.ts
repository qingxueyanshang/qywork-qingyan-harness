import type { EnvDependency } from '@qywork/core'
import { createSignal } from 'solid-js'
import { loadEnvironment } from '../../lib/store/index.ts'

/**
 * 设置页共用的运行环境检测结果：「通用 → 运行环境」与「模块」中的 Office、shell 两处读取同一份。
 *
 * 每次有页面显示时重新请求，服务端随之重新探测：安装完成后重新打开设置页即显示新结果。
 * 两页各自请求时，同一时刻的两处显示可能来自两次不同的探测。
 */

const [rows, setRows] = createSignal<EnvDependency[] | null>(null)
const [error, setError] = createSignal<unknown>(null)

/** 尚未取得时为 null。 */
export const environment = rows
export const environmentError = error

export async function reloadEnvironment(): Promise<void> {
  try {
    setRows(await loadEnvironment())
    setError(null)
  } catch (e) {
    setError(e)
  }
}
