import { Show } from 'solid-js'
import { resolvePermission, state } from '../lib/store/index.ts'
import { IconShield } from './Icons.tsx'

/**
 * 授权确认。
 *
 * 桌面端是居中卡片，手机端是底部弹出层（CSS 处理，不分两套组件）。
 * 预览必须显示**完整的命令原文或改动目标**——只说「要执行命令」的确认框
 * 等于没有确认，用户只会一路点允许。
 *
 * 四档范围来自协议，不在这里另发明：once / run / session / always。
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
              <button class="btn" type="button" onClick={() => resolvePermission(true, 'session')}>
                本会话允许
              </button>
              <button
                class="btn primary"
                type="button"
                onClick={() => resolvePermission(true, 'once')}
              >
                允许
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  )
}
