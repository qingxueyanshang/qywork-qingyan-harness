import { createSignal, For, onCleanup, Show } from 'solid-js'
import { explainApiError } from '../../lib/store/index.ts'

/**
 * 读取中与读取失败的统一界面：读取中一律为灰色占位（`Skeleton`、行内的 `PendingText`），不写「读取中」之类的文字；
 * 失败显示原因与重试（`LoadState`）。设置页与账号窗口都经这里，不各自手写。
 *
 * 占位延迟 `SLOW_MS` 才出现。判据是读取超过一段时间仍未返回，而不是尚未返回：
 * 服务在本机，设置页每次取数都在一帧内返回（已逐帧测量），立即绘制的结果是
 * 占位出现一帧后消失，只造成一次闪烁。阈值内返回时，占位不会出现。
 *
 * 失败状态必须与读取中有所区别：失败若与读取中相同，请求失败时界面停留在读取中，
 * 既不说明原因，也无法重试（实测原因是跨源预检被 401 拒绝，界面上无法看出请求未能发出）。
 * 失败不受阈值限制：它是终态，出现后立即渲染。
 */
const SLOW_MS = 200

/** 读取开始后超过 `SLOW_MS` 时为真。 */
function useSlow(): () => boolean {
  const [slow, setSlow] = createSignal(false)
  const timer = setTimeout(() => setSlow(true), SLOW_MS)
  onCleanup(() => clearTimeout(timer))
  return slow
}

/** 段落形状的占位：`lines` 条灰色条，最后一条较短。 */
export function Skeleton(props: { lines?: number }) {
  const slow = useSlow()
  const lines = () => Array.from({ length: props.lines ?? 3 }, (_, i) => i)
  return (
    <Show when={slow()}>
      <output class="skeleton" aria-label="读取中">
        <For each={lines()}>
          {(i) => <span class="skeleton-line" classList={{ short: i === lines().length - 1 }} />}
        </For>
      </output>
    </Show>
  )
}

/**
 * 读取中为占位，失败为原因与重试。`lines` 取接近读取完成后内容的行数，占位与内容的高度相近。
 * `busy` 为重试进行中：原因保留，按钮禁用。
 */
export function LoadState(props: {
  error: unknown
  onRetry: () => void
  lines?: number
  busy?: boolean
}) {
  return (
    <Show
      when={props.error}
      fallback={<Skeleton {...(props.lines ? { lines: props.lines } : {})} />}
    >
      <div class="settings-error">
        <span>{explainApiError(props.error, '读取失败')}</span>
        <button class="btn-ghost" type="button" disabled={props.busy} onClick={props.onRetry}>
          重试
        </button>
      </div>
    </Show>
  )
}

/** 行内的值：`value` 为 null 表示尚未读取到，超过 `SLOW_MS` 后显示一段占位条。 */
export function PendingText(props: { value: string | null }) {
  const slow = useSlow()
  return (
    <Show
      when={props.value !== null}
      fallback={
        <Show when={slow()}>
          <output class="skeleton-inline" aria-label="读取中" />
        </Show>
      }
    >
      {props.value}
    </Show>
  )
}
