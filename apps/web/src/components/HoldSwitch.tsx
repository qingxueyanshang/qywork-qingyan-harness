import {
  createMemo,
  createSignal,
  For,
  type JSX,
  onMount,
  Suspense,
  untrack,
  useContext,
} from 'solid-js'
import { RegionPending, suspendUntil } from '../lib/resource.ts'

/**
 * 按 `key` 切换内容。新一项挂起期间（懒加载的代码、`suspendUntil` 声明的首次读取）上一项保持显示，
 * 新一项解除挂起时两者在同一次更新中替换，界面不经过「已切换、无内容」的中间状态。
 *
 * 每一项各有一个 Suspense，项内的挂起不影响其他项。等待期间又切换到第三项时，等待中的一项随即卸载。
 * 挂起最长 `SLOW_MS`（见 `suspendUntil`），超时后显示新一项自身的读取中状态。
 *
 * 首次显示的内容解除挂起之前，同样挂起外层的 Suspense：嵌套在另一个 `HoldSwitch` 中时，
 * 外层切换会等待内层的首次内容。
 *
 * 边界：上一项在保留期间仍响应全局状态，不是静态快照；保留时长不超过 `SLOW_MS`。
 * `key` 按 `Object.is` 比较，取字符串等原始值。
 * `onShow` 在某一项成为显示项时调用（包括首次显示），供不在本组件中渲染的内容跟随显示项。
 */
export function HoldSwitch<K>(props: {
  key: K
  children: (key: K) => JSX.Element
  onShow?: (key: K) => void
}): JSX.Element {
  const [shown, setShown] = createSignal<K>(untrack(() => props.key))
  const [first, setFirst] = createSignal(false)
  suspendUntil(first)
  const keys = createMemo(() => (Object.is(props.key, shown()) ? [shown()] : [shown(), props.key]))
  return (
    <For each={keys()}>
      {(key) => (
        <Region
          onShow={() => {
            setFirst(true)
            setShown(() => key)
            props.onShow?.(key)
          }}
        >
          {props.children(key)}
        </Region>
      )}
    </For>
  )
}

/**
 * 可能挂起的内容（懒加载的组件、`suspendUntil` 声明的首次读取）的边界。
 *
 * 所在区域尚未显示时不设边界，挂起交给所在区域：切换时 `HoldSwitch` 保留上一项，新内容整体就绪后一次显示。
 * 所在区域已显示后创建、或不在任何区域中时，挂起由本组件承担并显示 `fallback`：已显示的 Suspense
 * 再次挂起时整体换为后备内容，界面先变空。
 */
export function HoldBoundary(props: {
  fallback?: JSX.Element
  children: JSX.Element
}): JSX.Element {
  const pending = useContext(RegionPending)
  if (pending !== undefined && untrack(pending)) return props.children
  return <Region fallback={props.fallback}>{props.children}</Region>
}

/** 一个 Suspense 区域：向内容提供区域是否尚未显示（`RegionPending`），首次显示时调用 `onShow`。 */
function Region(props: {
  fallback?: JSX.Element
  onShow?: () => void
  children: JSX.Element
}): JSX.Element {
  const [pending, setPending] = createSignal(true)
  return (
    <Suspense fallback={props.fallback}>
      <RegionPending.Provider value={pending}>
        <Shown
          onShow={() => {
            setPending(false)
            props.onShow?.()
          }}
        />
        {props.children}
      </RegionPending.Provider>
    </Suspense>
  )
}

/** 所在的 Suspense 解除挂起、内容插入文档时调用 `onShow`：Suspense 挂起期间其中的 `onMount` 推迟执行。 */
function Shown(props: { onShow: () => void }): JSX.Element {
  onMount(() => props.onShow())
  return null
}
