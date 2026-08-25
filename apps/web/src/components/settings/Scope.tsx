import { For, type JSX, Show } from 'solid-js'
import { type Scope, type ScopeDir, WRITABLE_SCOPES } from '../../lib/store/index.ts'
import { PathLine } from './Page.tsx'

/**
 * 作用域标签页：**项目**（工作区 `.agents/`）与**全局**（`~/.qywork/`）。
 *
 * ## 为什么按层分列，而不是列合并后的那一份
 *
 * 用户要能回答「这条记忆是跟着这个仓库走的，还是全局都生效的」。合并去重之后
 * 那个事实就没了——被项目层盖住的全局条目直接消失，「在全局改了却没生效」
 * 无从查起。分列之后它重新出现在全局那一栏里，所以**必须同时贴 `ShadowTag`**，
 * 否则界面等于宣称一条不生效的内容在生效。
 *
 * ## 内置层不出现
 *
 * 它随程序发布、只读、用户看不见，给它画一个标签页等于画一个点了没反应的按钮。
 *
 * ## 这里只管「看哪一层 / 加到哪一层」
 *
 * 不要往这一条里塞逐条启停：层是这条内容住在哪个目录，启停是某一轮用不用它，
 * 两件事的生效范围不同，合到一个控件上，取消勾选读起来就是从盘上删掉。
 */
export function ScopeTabs(props: {
  value: Scope
  onChange: (s: Scope) => void
  /** 每一层的落盘位置。有没有内容都列——「该去哪儿加」比「这里是空的」有用。 */
  dirs?: ScopeDir[]
  /** 这一页的动作（新增 / 导入），排在路径右边。
   *  放这一行而不是各自的区头：这三页的区头除了动作只剩一个与页名重复的标题，
   *  留着就是同一件事印两遍（B7）。 */
  actions?: JSX.Element
}) {
  const current = () => props.dirs?.find((d) => d.scope === props.value)
  return (
    <div class="scope-tabs">
      <div class="scope-tab-strip">
        <For each={WRITABLE_SCOPES}>
          {(s) => (
            <button
              class="scope-tab"
              classList={{ active: props.value === s.id }}
              type="button"
              onClick={() => props.onChange(s.id)}
            >
              {s.label}
            </button>
          )}
        </For>
      </div>
      {/* 路径与动作是右边一组：地方不够时先截路径，动作永远看得见。 */}
      <div class="scope-tail">
        <Show when={current()}>{(d) => <PathLine path={d().dir} />}</Show>
        <Show when={props.actions}>{props.actions}</Show>
      </div>
    </div>
  )
}

/**
 * 这一条被更高优先级的层盖住了，模型看到的是那一份。
 *
 * 这是**边界不是装饰**：不贴的话，全局那一栏里躺着一条永远不会被用到的内容，
 * 而它看起来和生效的那些一模一样。
 */
export function ShadowTag(props: { by: Scope }) {
  // 内置层不在 `WRITABLE_SCOPES` 里（它不可写），但它盖得住别人，所以这里要认它。
  const label = () =>
    props.by === 'builtin' ? '内置' : (WRITABLE_SCOPES.find((s) => s.id === props.by)?.label ?? '')
  return <span class="shadow-tag">被{label()}层盖住</span>
}
