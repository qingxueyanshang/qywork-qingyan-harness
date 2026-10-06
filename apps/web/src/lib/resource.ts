import type { Resource } from 'solid-js'

/**
 * 读取 resource 的值：尚未取得时返回 `undefined`，出错时也返回 `undefined`，从不抛出。
 *
 * 不直接调用 `data()`：Solid 的 `resource()` 与 `resource.latest` 在出错时都会 `throw err`，
 * 依赖调用方外层的 `ErrorBoundary` 捕获。本应用没有设置 `ErrorBoundary`，抛出后无人捕获，
 * 当前帧的更新中途中断，页面停在不完整状态。已写好的错误界面也会因此成为死代码：
 * `<Show when={data()} fallback={<LoadState error={data.error} …/>}>` 中 `when` 先抛出，
 * `fallback` 不会生效，「接口失败时显示原因与重试」的路径无法执行。
 *
 * `state` 与 `error` 两个属性不会抛出，因此以它们作为判据，仅在确定安全时才读取值。
 *
 * 边界：
 * - `refreshing`（重新获取中）仍返回上一份值：重新获取不应使界面清空。
 * - 重新获取失败时返回 `undefined`，调用方显示错误界面。这是有意的设计：
 *   继续显示已知无法更新的数据、同时只在角落显示错误，会形成两本账。
 * - 读取该值不触发 Suspense。因此「加载中」须由调用方自己的 `fallback` 表达，
 *   不能依赖外层的 Suspense。
 */
export function loaded<T>(r: Resource<T>): T | undefined {
  return r.state === 'ready' || r.state === 'refreshing' ? r.latest : undefined
}
