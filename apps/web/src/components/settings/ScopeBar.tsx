import { Show } from 'solid-js'
import type { Scope, ScopeDir } from '../../lib/store/index.ts'

/**
 * 「加到哪一层」的选择条，以及每一层的落盘位置。
 *
 * ## 为什么只在「加」的时候出现
 *
 * 列表本身**不按层分组**：模型看到的是三层合并去重之后的一份，界面照着分组
 * 会给出一个模型从来不曾看到的视图。所以每条自己标一个层，列表还是那一列。
 *
 * ## 为什么没有开关
 *
 * 设置页回答「我要改什么」，会话右侧面板回答「这一轮怎么跑」。逐条开关属于后者，
 * 而且它只影响当前那一个会话——放在这里会让人以为关掉就是全局关掉了。
 *
 * 内置层不出现：它随程序发布、只读、用户看不见，给它画一个选项等于画一个
 * 点了没反应的按钮。
 */
export function ScopeBar(props: {
  value: Scope
  onChange: (s: Scope) => void
  /** 每一层的落盘位置。有没有内容都列——「该去哪儿加」比「这里是空的」有用。 */
  dirs?: ScopeDir[]
}) {
  const current = () => props.dirs?.find((d) => d.scope === props.value)
  return (
    <div class="scope-bar">
      <div class="tab-strip">
        <button
          class="tab-chip"
          classList={{ active: props.value === 'user' }}
          type="button"
          onClick={() => props.onChange('user')}
        >
          用户级
        </button>
        <button
          class="tab-chip"
          classList={{ active: props.value === 'global' }}
          type="button"
          onClick={() => props.onChange('global')}
        >
          全局
        </button>
      </div>
      <Show when={current()}>{(d) => <code class="field-path">{d().dir}</code>}</Show>
    </div>
  )
}

const LABEL: Record<Scope, string> = { builtin: '内置', user: '用户级', global: '全局' }

/** 一条内容来自哪一层。列表里每行贴一个，不然合并去重之后就分不出谁是谁。 */
export function ScopeTag(props: { scope: Scope }) {
  return (
    <span class="scope-tag" data-scope={props.scope}>
      {LABEL[props.scope]}
    </span>
  )
}
