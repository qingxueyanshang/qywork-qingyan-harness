/** 输入区工具栏的权限模式开关。 */

import { activeMode, setMode, state } from '../lib/store/index.ts'
import { IconShield } from './Icons.tsx'

/**
 * 当前会话的权限模式。
 *
 * 位于输入区而不是设置中：它决定该会话的放行级别，与「使用哪个模型」属于同一层级的决定，
 * 同样按会话保存，需要随时修改。运行中不禁用：之后的每次命令裁决即按新模式执行。
 *
 * 只有两种模式，因此使用开关而不是下拉框。文案使用「自动审批 / 完全访问」，
 * 不使用 `auto` / `full`：后者是协议中的字面量，不面向用户。
 */
export function ModeChip() {
  const full = () => activeMode() === 'full'

  return (
    <button
      class="mode-chip"
      classList={{ full: full() }}
      type="button"
      disabled={!state.activeConversation}
      aria-pressed={full()}
      data-tip={
        full() ? '不做权限检查，也不限制路径；仍剥离凭证' : '只放行确定安全的命令，其余直接拒绝'
      }
      onClick={() => setMode(full() ? 'auto' : 'full')}
    >
      <IconShield size={13} />
      {full() ? '完全访问' : '自动审批'}
    </button>
  )
}
