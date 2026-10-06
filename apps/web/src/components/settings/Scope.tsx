import { For, type JSX, Show } from 'solid-js'
import { type Scope, type ScopeDir, WRITABLE_SCOPES } from '../../lib/store/index.ts'
import { PathLine } from './Page.tsx'

/**
 * 作用域标签页：项目（工作区 `.agents/`）与全局（`~/.qywork/`）。
 *
 * 按层分列而不显示合并结果：用户需要判断一条记忆属于当前仓库还是全局生效。合并去重后，
 * 被项目层覆盖的全局条目不再显示，「在全局修改后未生效」无法排查。分列后该条目显示在全局一栏中，
 * 因此必须同时附加 `ShadowTag`，否则界面会把一条不生效的内容显示为生效。
 *
 * 不显示内置层：它随程序发布、只读且对用户不可见，为它提供标签页等于提供一个点击后无响应的按钮。
 *
 * 本组件只负责「查看哪一层 / 新增到哪一层」。不要在此加入逐条启停：层表示内容所在的目录，启停
 * 表示某一轮是否使用它，两者的生效范围不同；合并到一个控件后，取消勾选会被理解为从磁盘删除。
 */
export function ScopeTabs(props: {
  value: Scope
  onChange: (s: Scope) => void
  /** 每一层的落盘位置。无论该层是否有内容都列出：新增位置比空状态提示更有用。 */
  dirs?: ScopeDir[]
  /** 本页的动作（新增 / 导入），排在路径右侧。
   *  放在此行而不放在分区标题中：这三页的分区标题除动作外只有一个与页名重复的标题，
   *  保留它会重复显示同一信息（B7）。 */
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
      {/* 路径与动作在右侧成组：空间不足时先截断路径，动作始终可见。 */}
      <div class="scope-tail">
        <Show when={current()}>{(d) => <PathLine path={d().dir} />}</Show>
        <Show when={props.actions}>{props.actions}</Show>
      </div>
    </div>
  )
}

/**
 * 该条目被更高优先级的层覆盖，模型使用的是覆盖它的条目。
 *
 * 该标记是边界声明：缺少它时，全局一栏中会有一条永远不会被使用的条目，
 * 且外观与生效的条目相同。
 */
export function ShadowTag(props: { by: Scope }) {
  // 内置层不在 `WRITABLE_SCOPES` 中（不可写），但可以覆盖其他层，因此此处需要识别它。
  const label = () =>
    props.by === 'builtin' ? '内置' : (WRITABLE_SCOPES.find((s) => s.id === props.by)?.label ?? '')
  return <span class="shadow-tag">被{label()}层覆盖</span>
}
