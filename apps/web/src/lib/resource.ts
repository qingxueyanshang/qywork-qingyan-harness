import type { Resource } from 'solid-js'

/**
 * 取一个 resource 的值：**没取回来给 `undefined`，出错也给 `undefined`，从不抛。**
 *
 * **为什么不直接写 `data()`。** Solid 的 `resource()` 和 `resource.latest` 在出错时都是 `throw err
 * `，指望调用方外面有 `ErrorBoundary` 接住。这个应用一个都没有——抛出去没人接，那一帧的更新半途
 * 中断，页面停在残缺状态。**更坏的是它把已经写好的错误界面变成了死代码**：
 * `<Show when={data()} fallback={<LoadState error={data.error} …/>}>` 这种写法里，`when` 先抛，
 * `fallback` 永远轮不到，因此「接口失败时显示原因 + 重试」这条路从来没有跑通过。
 *
 * `state` 和 `error` 两个属性不抛，所以判据用它们，值只在确定安全时才读。
 *
 * **边界**：
 * - `refreshing`（重取中）照样给上一份值：重取不该让界面闪空。
 * - 重取失败会退回 `undefined`，调用方落到错误界面。**这是有意的**：
 *   继续显示一份已知拿不到最新状态的数据，而错误只挂在角落里，就是两本账。
 * - 读它**不进 Suspense**。所以「加载中」要由调用方自己的 `fallback` 表达，
 *   指望外面那层 Suspense 是不行的。
 */
export function loaded<T>(r: Resource<T>): T | undefined {
  return r.state === 'ready' || r.state === 'refreshing' ? r.latest : undefined
}
