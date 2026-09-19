import { For } from 'solid-js'

const CHOICES = [
  { on: false, label: '关闭' },
  { on: true, label: '启用' },
]

/**
 * 两格开关。设置页里每一处「开 / 关」都用它，各页各写一份的代价是改一处忘另一处。
 *
 * 不要取名 `Switch`：与 Solid 的控制流组件同名，开发模式下渲染到它即抛错，
 * 外层设置弹窗的页面切换随之失效。`reserved-names.test.ts` 守着这一条。
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
