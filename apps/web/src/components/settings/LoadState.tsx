import { createSignal, onCleanup, Show } from 'solid-js'
import { explainApiError } from '../../lib/store/index.ts'

/**
 * 读取中 / 读取失败。
 *
 * 失败状态必须与加载中状态有所区别。若只有一句「读取配置…」，请求失败时它就成为
 * 终态：面板始终停留在这句话上，既不说明原因，也无法重试。
 * 实测到的原因是跨源预检被 401 拒绝（server.ts 的 CORS_HEADERS），
 * 而界面上无法看出请求未能发出。
 *
 * 「读取中」延迟一段时间才显示。判据是读取超过一段时间仍未返回，而不是尚未返回：
 * 服务在本机，设置页每次取数都在一帧内返回（已逐帧测量），立即绘制的结果是
 * 一行文字出现一帧后消失，不提供任何信息，只造成一次重排，即切换类目时的
 * 闪烁。阈值内返回时，这行文字不会出现。
 *
 * 失败不受阈值限制：它是终态，出现后立即渲染。
 */
const SLOW_MS = 200

export function LoadState(props: { error: unknown; onRetry: () => void }) {
  const [slow, setSlow] = createSignal(false)
  const timer = setTimeout(() => setSlow(true), SLOW_MS)
  onCleanup(() => clearTimeout(timer))

  return (
    <Show
      when={props.error}
      fallback={
        <Show when={slow()}>
          <div class="settings-loading">读取中…</div>
        </Show>
      }
    >
      <div class="settings-error">
        <span>{explainApiError(props.error, '读取失败')}</span>
        <button class="btn-ghost" type="button" onClick={props.onRetry}>
          重试
        </button>
      </div>
    </Show>
  )
}
