import type { JSX } from 'solid-js'
import { Show } from 'solid-js'

/**
 * 一行设置：左侧为标题（可附一句说明），右侧为控件。多行组成一张卡片。
 *
 * 采用行式布局是为了便于扫读：可修改的项在右缘对齐成一列，
 * 查找某个开关时只需扫视右缘；上下堆叠的表单中控件宽度各不相同，
 * 查找一项需要从上往下读一遍标题。
 *
 * 适用范围的判据是控件宽度是否有界：
 * - 有界（主题、思考强度、开关、只读状态）→ 行式。
 * - 无界（模型 id、baseUrl、key、多行清单、JSON 编辑框）→ 保持上下堆叠，
 *   值本身就是需要阅读和编辑的正文，放入右侧一列会使宽度过窄。
 *
 * 因此本组件不用于 textarea 等宽度无界的控件。类型上不做限制，
 * 此处的约定用于防止把 baseUrl 等输入框放入行式布局。
 */
export function Row(props: {
  label: string
  /** 一句说明。仅在缺少它会导致误操作时填写（B7），不写介绍性内容。 */
  hint?: string
  children: JSX.Element
}) {
  return (
    <div class="setting-row">
      <div class="setting-row-text">
        <span class="setting-row-label">{props.label}</span>
        <Show when={props.hint}>{(h) => <span class="setting-row-hint">{h()}</span>}</Show>
      </div>
      <div class="setting-row-control">{props.children}</div>
    </div>
  )
}

/**
 * 控件宽度无界的设置项：多行清单、长输入。控件独占一行。
 *
 * 说明紧随标题，不放在控件之后。排成「标题 / 控件 / 说明」三层时，
 * 说明与它所解释的标题分处控件两侧，读者读到说明时视线已移向下一项。
 */
export function Field(props: { label: string; hint?: string; children: JSX.Element }) {
  return (
    <div class="setting-row stack">
      <div class="setting-row-text">
        <span class="setting-row-label">{props.label}</span>
        <Show when={props.hint}>{(h) => <span class="setting-row-hint">{h()}</span>}</Show>
      </div>
      {props.children}
    </div>
  )
}

/**
 * 只读的长值（如路径）。
 *
 * 不使用 `Row`：绝对路径常有七八十个字符，放入右侧一列会被截断，
 * 而截断的路径无法用于查找文件。
 */
export function PathRow(props: { label: string; value: string; hint?: string }) {
  return (
    <Field label={props.label} {...(props.hint ? { hint: props.hint } : {})}>
      <code class="field-path">{props.value}</code>
    </Field>
  )
}
