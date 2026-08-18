import { Show } from 'solid-js'
import { explainApiError } from '../../lib/store/index.ts'

/**
 * 读取中 / 读取失败。
 *
 * **失败必须和加载中长得不一样。** 只有一句「读取配置…」的话，请求失败时它就是
 * 终态——面板永远停在那句话上，既不说为什么，也没有再试一次的路。
 * 实测撞到过的真实原因是跨源预检被 401 挡掉（server.ts 的 CORS_HEADERS），
 * 而界面上完全看不出「请求根本没发出去」。
 */
export function LoadState(props: { error: unknown; onRetry: () => void }) {
  return (
    <Show when={props.error} fallback={<div class="settings-loading">读取中…</div>}>
      <div class="settings-error">
        <span>{explainApiError(props.error, '读取失败')}</span>
        <button class="btn-ghost" type="button" onClick={props.onRetry}>
          重试
        </button>
      </div>
    </Show>
  )
}
