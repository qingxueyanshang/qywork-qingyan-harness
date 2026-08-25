import type { JSX } from 'solid-js'
import { Show } from 'solid-js'

/**
 * 一行设置：左边标题（可带一句话），右边控件。若干行叠成一张卡。
 *
 * **为什么值得有这个形状。** 不是为了好看，是为了**扫读**。行式把「可改的项」压成右缘对齐的一列，
 * 找某个开关时眼睛只扫右缘；上下堆叠的表单里控件宽度各不相同，
 * 找一格要从上往下读一遍标题。
 *
 * **什么该用它，什么不该。** 判据是**控件宽度有没有界**：
 * - 有界（主题、思考强度、开关、只读状态）→ 行式。
 * - 无界（模型 id、baseUrl、key、多行清单、JSON 编辑框）→ 保持上下堆叠，
 *   值本身就是要读要编辑的正文，挤到右边一列会把它压成一条缝。
 *
 * 所以这个组件**故意不接受 textarea 那类子元素**——不是拦不住，是写在这里
 * 免得下一个人把 baseUrl 也塞进来。
 */
export function Row(props: {
  label: string
  /** 一句话。只在**不写就会做错事**时才写（B7），介绍性的话一律不要。 */
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
 * 控件宽度无界的那一格：多行清单、长输入。控件自己占一整行。
 *
 * **说明跟着标题走，不跟着控件走。** 排成「标题 / 控件 / 说明」三层的话，
 * 读到说明时人已经在往下一格看了，而它解释的是上面那一格——
 * 一个标题的说明和标题分居控件两侧，本来就没道理。
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
 * 一整块只读的长值（路径这类）。
 *
 * 它不进 `Row`：绝对路径动辄七八十个字符，挤到右边一列只会被截断，
 * 而路径截断了就没用了——用户看它就是为了照着找文件。
 */
export function PathRow(props: { label: string; value: string; hint?: string }) {
  return (
    <Field label={props.label} {...(props.hint ? { hint: props.hint } : {})}>
      <code class="field-path">{props.value}</code>
    </Field>
  )
}
