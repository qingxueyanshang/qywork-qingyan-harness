import { Show } from 'solid-js'
import { setState, state } from '../lib/store/index.ts'

/**
 * 操作失败与指令被拒绝的回执（`state.notice`）。按 fail-closed 原则，拒绝必须在界面上显示。
 *
 * 显示在会话流末尾；面板覆盖会话流时（窄屏全屏、面板放大）另显示在面板页签栏下方（`panel-notice`），
 * 同一时刻只有一处可见：面板中的操作失败时，会话流末尾的回执被面板遮住。
 * 使用 <output> 而不是 div + role="status"：两者隐含语义相同，前者少一个属性。
 */
export function NoticeCard(props: { class?: string }) {
  return (
    <Show when={state.notice}>
      {(n) => (
        <output class={props.class ? `notice-card ${props.class}` : 'notice-card'}>
          <span>{n().message}</span>
          <button class="btn-ghost sm" type="button" onClick={() => setState('notice', null)}>
            关闭
          </button>
        </output>
      )}
    </Show>
  )
}
