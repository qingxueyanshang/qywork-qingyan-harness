import { For, Show } from 'solid-js'
import { resolvePermission, state } from '../lib/store/index.ts'
import { IconShield } from './Icons.tsx'

/**
 * 授权确认。
 *
 * 桌面端是居中卡片，手机端是底部弹出层（CSS 处理，不分两套组件）。
 * 预览必须显示**完整的命令原文或改动目标**——只说「要执行命令」的确认框
 * 等于没有确认，用户只会一路点允许。
 *
 * ## 允许按钮由服务端的 `scopes` 渲染，这里不列
 *
 * 这里原先硬编码两个按钮（「本会话允许」「允许」），而服务端发的是四档
 * ——`run` 和 `always` 谁也点不到。文件顶上还写着「四档范围来自协议，
 * 不在这里另发明」，那句话当时就是假的。
 *
 * 现在照事件里带来的清单渲染：**服务端是权威**，因为兑现这个范围的是它。
 * 拒绝按钮不在清单里——拒绝没有范围可言，拒了就是这一次拒了。
 */
export function PermissionSheet() {
  return (
    <Show when={state.permission}>
      {(ask) => (
        <div class="sheet-backdrop">
          <div class="sheet" role="alertdialog" aria-modal="true" aria-label="需要授权">
            <div class="sheet-head">
              <IconShield size={16} />
              <span>需要授权</span>
              <code class="sheet-tool">{ask().toolName}</code>
            </div>

            <pre class="sheet-preview">{ask().preview}</pre>

            <div class="sheet-actions">
              <button
                class="btn ghost"
                type="button"
                onClick={() => resolvePermission(false, 'once')}
              >
                拒绝
              </button>
              <For each={ask().scopes}>
                {(scope) => (
                  <button
                    // 主按钮给**范围最小**的那档，不是给最后一个：默认动作应当是
                    // 授权最少的那个。按 duration 判而不是按位置判——位置由服务端
                    // 的清单顺序决定，那不是这里该依赖的东西。
                    class={scope.duration === 'once' ? 'btn primary' : 'btn'}
                    type="button"
                    onClick={() => resolvePermission(true, scope.id)}
                  >
                    {scope.label}
                  </button>
                )}
              </For>
            </div>
          </div>
        </div>
      )}
    </Show>
  )
}
