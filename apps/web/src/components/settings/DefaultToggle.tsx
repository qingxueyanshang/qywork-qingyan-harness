import type { RedactedConfig } from '../../lib/store/index.ts'

/** 取消默认对话模型：配置中不带默认值，新会话由用户在输入框选择模型。 */
export function withoutActive(cur: RedactedConfig): RedactedConfig {
  const { active: _active, ...rest } = cur
  return rest
}

/**
 * 默认模型的切换按钮：不是默认时显示「设为默认」；是默认时显示「默认」，悬停显示「取消默认」，点击取消。
 * 模型设置页的对话与生成模型、账号窗口的可用模型共用，写入的都是配置中的同一个默认值。
 */
export function DefaultToggle(props: {
  on: boolean
  disabled?: boolean
  onSet: () => void
  onUnset: () => void
}) {
  return (
    <button
      class="model-pick"
      classList={{ on: props.on }}
      type="button"
      disabled={props.disabled}
      onClick={() => (props.on ? props.onUnset() : props.onSet())}
    >
      {props.on ? (
        <>
          <span class="model-pick-state">默认</span>
          <span class="model-pick-undo">取消默认</span>
        </>
      ) : (
        '设为默认'
      )}
    </button>
  )
}
