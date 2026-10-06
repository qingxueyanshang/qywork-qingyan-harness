import { For } from 'solid-js'

const CHOICES = [
  { on: false, label: '关闭' },
  { on: true, label: '启用' },
]

/**
 * 两项开关。设置页中所有「开 / 关」控件都使用它；各页分别实现会导致修改时遗漏其中一处。
 *
 * 不要取名 `Switch`：与 Solid 的控制流组件同名，开发模式下渲染到它即抛错，
 * 外层设置弹窗的页面切换随之失效。由 `reserved-names.test.ts` 检查。
 */
export function OnOff(props: { on: boolean; onPick: (on: boolean) => void }) {
  return (
    <div class="seg">
      <For each={CHOICES}>
        {(o) => (
          <button
            class="seg-item"
            classList={{ active: props.on === o.on }}
            type="button"
            onClick={() => props.onPick(o.on)}
          >
            {o.label}
          </button>
        )}
      </For>
    </div>
  )
}
