import {
  type Accessor,
  createComputed,
  createContext,
  createEffect,
  createResource,
  createSignal,
  onCleanup,
  type Resource,
  untrack,
  useContext,
} from 'solid-js'

/**
 * 读取超过该时长仍未完成时才显示读取中的状态（占位条、加载提示）；切换时旧内容也最多保留该时长。
 * 服务在本机时读取多在一至三帧内完成，立即显示读取中的状态只会使内容消失一两帧再出现。
 */
export const SLOW_MS = 200

/**
 * 所在区域是否尚未显示，由 `HoldSwitch` 的每一项与 `HoldBoundary` 提供。
 * 区域显示之后创建的组件调用 `suspendUntil` 不再挂起：已显示的 Suspense 再次挂起时整体换为后备内容，界面先变空。
 */
export const RegionPending = createContext<Accessor<boolean>>()

/**
 * 挂起所在的 Suspense，直到 `ready()` 首次为真或经过 `SLOW_MS`。只生效一次：此后 `ready()` 再变为假不再挂起，
 * 重新读取期间界面保持原样。不在 Suspense 之内调用、所在区域已显示（`RegionPending`）时没有作用。
 *
 * 供 `HoldSwitch` 中的内容声明首次读取：挂起期间 `HoldSwitch` 保留上一项。超时后解除挂起，
 * 显示内容自身的读取中状态，因此读取一直不返回时切换不会停在上一项。
 * 对 resource 写作 `suspendUntil(() => !data.loading)`。
 */
export function suspendUntil(ready: Accessor<boolean>): void {
  const pending = useContext(RegionPending)
  if (untrack(ready) || (pending !== undefined && !untrack(pending))) return
  let release = () => {}
  const [gate] = createResource(
    () =>
      new Promise<true>((resolve) => {
        release = () => resolve(true)
      }),
  )
  const timer = setTimeout(() => release(), SLOW_MS)
  onCleanup(() => {
    clearTimeout(timer)
    release()
  })
  createComputed(() => {
    if (ready()) release()
  })
  // 只在等待期间读取：`gate()` 在 Suspense 中登记挂起，解除后本计算重新执行、不再读取，登记随之撤销。
  createComputed(() => {
    if (gate.state === 'pending') gate()
  })
}

/**
 * 切换显示对象时保留上一个值，直到 `ready(正在显示的值)` 为真或经过 `SLOW_MS`，再换为当前值。
 *
 * 用于数据由 store 提供、切换后上一个对象的数据随即被移除的场合（会话流、左栏的会话列表）：
 * 保留的是切换前取得的对象本身，store 移除该对象后它的内容不变，可以继续渲染。
 * `ready` 收到正在显示的值，正在显示的值没有内容可保留时应返回真。
 * 超时后直接跟随当前值，直到下一次就绪；`ready` 在同一对象上变为假（重新读取）时同样保留。
 */
export function createHeld<T>(value: Accessor<T>, ready: (shown: T) => boolean): Accessor<T> {
  const [shown, setShown] = createSignal<T>(untrack(value), { equals: false })
  let timer: ReturnType<typeof setTimeout> | undefined
  let late = false
  createComputed(() => {
    const next = value()
    const isReady = ready(untrack(shown))
    if (isReady || late) {
      clearTimeout(timer)
      timer = undefined
      if (isReady) late = false
      setShown(() => next)
    } else if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined
        late = true
        setShown(() => untrack(value))
      }, SLOW_MS)
    }
  })
  onCleanup(() => clearTimeout(timer))
  return shown
}

/** 合并同一对象的连续失效；切换对象立即生效，持续更新时每个窗口仍取一次最新值。 */
export function createRefreshKey<K, R>(
  scope: Accessor<K>,
  revision: Accessor<R>,
  interval = 250,
): Accessor<{ scope: K; revision: R }> {
  const [key, setKey] = createSignal({ scope: scope(), revision: revision() })
  let timer: ReturnType<typeof setTimeout> | undefined
  const cancel = () => {
    clearTimeout(timer)
    timer = undefined
  }
  createEffect(() => {
    const next = { scope: scope(), revision: revision() }
    const previous = untrack(key)
    if (next.scope !== previous.scope) {
      cancel()
      setKey(next)
    } else if (next.revision !== previous.revision && timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined
        setKey({ scope: scope(), revision: revision() })
      }, interval)
    }
  })
  onCleanup(cancel)
  return key
}

/**
 * 读取 resource 的值：尚未取得时返回 `undefined`，出错时也返回 `undefined`，从不抛出。
 *
 * 不直接调用 `data()`：Solid 的 `resource()` 与 `resource.latest` 在出错时都会 `throw err`，
 * 依赖调用方外层的 `ErrorBoundary` 捕获。本应用没有设置 `ErrorBoundary`，异常不被捕获，
 * 当前帧的更新中途中断，页面停留在不完整的状态。错误界面也因此无法显示：
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
