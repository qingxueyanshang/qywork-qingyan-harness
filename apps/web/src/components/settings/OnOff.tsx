/**
 * 开关。设置页中所有「开 / 关」控件都使用它；各页分别实现会导致同一页上出现两种开关，
 * 修改时遗漏其中一处。样式为全局的 `.switch`（`styles/app/controls.css`）。
 *
 * 不要取名 `Switch`：与 Solid 的控制流组件同名，开发模式下渲染到它即抛错，
 * 外层设置弹窗的页面切换随之失效。由 `reserved-names.test.ts` 检查。
 */
export function OnOff(props: { label: string; on: boolean; onPick: (on: boolean) => void }) {
  return (
    <input
      class="switch"
      type="checkbox"
      role="switch"
      aria-label={props.label}
      aria-checked={props.on}
      checked={props.on}
      onChange={(e) => props.onPick(e.currentTarget.checked)}
    />
  )
}
