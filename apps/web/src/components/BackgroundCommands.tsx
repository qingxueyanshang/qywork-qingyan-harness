/** 输入框顶部的后台命令栏：当前会话每条后台命令一行，提供停止。 */

import { For, Show } from 'solid-js'
import { state, stopBackgroundCommand } from '../lib/store/index.ts'

/**
 * 正在后台运行的命令，与等待队列同属输入框顶部的状态栏，行的形态与队列行相同。
 *
 * 只放对象与操作：命令原文与「停止」。停止只结束这一条命令，不影响本轮与其他命令；
 * 命令结束、被停止后该行随服务端快照移除。
 *
 * 单行，固定高度（B9）：命令过长时在本行截断，悬停显示全文。
 */
export function BackgroundCommands() {
  return (
    <Show when={state.backgroundCommands.length > 0}>
      <div class="followup-cards">
        <For each={state.backgroundCommands}>
          {(c) => (
            <div class="followup-card">
              <span class="followup-label">后台</span>
              <span class="followup-text truncate" data-tip={c.command}>
                {c.command}
              </span>
              <div class="followup-actions">
                <button
                  class="followup-act danger"
                  type="button"
                  onClick={() => stopBackgroundCommand(c.id)}
                >
                  停止
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}
