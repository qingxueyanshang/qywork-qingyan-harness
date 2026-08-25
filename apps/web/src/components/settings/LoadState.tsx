import { createSignal, onCleanup, Show } from 'solid-js'
import { explainApiError } from '../../lib/store/index.ts'

/**
 * 读取中 / 读取失败。
 *
 * **失败必须和加载中长得不一样。** 只有一句「读取配置…」的话，请求失败时它就是
 * 终态——面板永远停在那句话上，既不说为什么，也没有再试一次的路。
 * 实测撞到过的真实原因是跨源预检被 401 挡掉（server.ts 的 CORS_HEADERS），
 * 而界面上完全看不出「请求根本没发出去」。
 *
 * **「读取中」要等一段时间才出场。** 判据是「读了一会儿还没回来」，不是「还没回来」：
 * 服务在本机，设置页每一次取数都在一帧内返回（逐帧量过），立刻画它的结果是
 * 一行字出现一帧又消失，什么都没告诉用户，只留下一次重排——切类目时看到的
 * 那一下闪就是它。门槛内到达的，这行字从来不存在。
 *
 * 失败不受门槛管：它是终态，来了就画。
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
