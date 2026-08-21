import type { JSX } from 'solid-js'
import { Show } from 'solid-js'
import { IconFile } from '../Icons.tsx'

/**
 * 设置页的版面构件：页头、分区、条目卡、空态框。
 *
 * ## 为什么集中在一处
 *
 * 记忆 / 技能 / MCP / 插件 / Agent Team 五页说的是同一件事的五个实例——
 * 「这一层装了哪些东西，怎么加一个」。各页自己拼版面的话，同一个「暂无内容」
 * 会长出五种高度、五种底色，而它们本来该是同一个东西。
 *
 * ## 页头钉在滚动区顶上，且整块一起钉
 *
 * 标题、说明、右上角动作是同一块。只钉标题的话，滚过之后它和动作按钮会错开一整段。
 */

/**
 * 页头。`desc` 只写**别处看不到的边界**——「改完要重启」「装在全局对所有项目生效」
 * 这类。控件本身说得清的事不在这里再说一遍。
 *
 * 说明与标题**同一行**：页头是钉住的，另起一行会让每一页都多占一档高度，
 * 而它承载的信息量配不上那一档。放不下时它自己截断（`.page-desc`）。
 */
export function PageHead(props: { title: string; desc?: string; actions?: JSX.Element }) {
  return (
    <header class="page-head">
      <div class="page-head-row">
        <h2 class="page-title">{props.title}</h2>
        <Show when={props.desc}>{(d) => <p class="page-desc">{d()}</p>}</Show>
        <Show when={props.actions}>
          <div class="page-head-actions">{props.actions}</div>
        </Show>
      </div>
    </header>
  )
}

/**
 * 一页里的一段。标题可省——只有一段内容的页面不需要给它起名字。
 *
 * **动作归分区，不归页头。** 一页里可能有好几段各自能加东西（角色 / 后端、
 * 技能 / 指令），动作全堆在页头的话，用户按下去不知道加到哪一段里。
 */
export function Section(props: {
  title?: string
  desc?: string
  actions?: JSX.Element
  children: JSX.Element
}) {
  return (
    <section class="settings-block">
      <Show when={props.title || props.actions}>
        <div class="settings-block-head">
          <Show when={props.title}>{(t) => <h3>{t()}</h3>}</Show>
          <Show when={props.actions}>
            <div class="section-actions">{props.actions}</div>
          </Show>
        </div>
      </Show>
      <Show when={props.desc}>{(d) => <p class="section-desc">{d()}</p>}</Show>
      {props.children}
    </section>
  )
}

/**
 * 一条内容。名字 + 一行说明，右侧留给徽标和动作。
 *
 * `onOpen` 决定名字那一块是不是按钮。**动作按钮永远在这块之外**——
 * 套在按钮里的按钮点不动，而「点卡片打开、点叉删掉」正是这一页最常用的两个动作。
 *
 * `children` 挂在下面，整卡宽：MCP 的工具名、插件的隔离状态都比一行说明长。
 */
export function EntryCard(props: {
  name: string
  desc?: string
  badge?: JSX.Element
  actions?: JSX.Element
  onOpen?: () => void
  children?: JSX.Element
}) {
  const head = (
    <>
      <div class="entry-title">
        <span class="entry-name">{props.name}</span>
        {props.badge}
      </div>
      <Show when={props.desc}>{(d) => <div class="entry-desc truncate">{d()}</div>}</Show>
    </>
  )
  return (
    <div class="entry-card">
      <div class="entry-row">
        <Show when={props.onOpen} fallback={<div class="entry-main">{head}</div>} keyed>
          {(open) => (
            <button class="entry-main" type="button" onClick={() => open()}>
              {head}
            </button>
          )}
        </Show>
        <Show when={props.actions}>
          <div class="entry-actions">{props.actions}</div>
        </Show>
      </div>
      {props.children}
    </div>
  )
}

/**
 * 一条落盘路径。
 *
 * **单行，从左边截。** 绝对路径动辄两行，换行之后它比正文还显眼，而它只是
 * 「这东西在哪儿」的一条说明。截左边是因为尾巴（目录名）才带信息。
 *
 * 里面那层 `dir="ltr"` 不能省：外面为了把省略号挪到左边写了 `direction: rtl`，
 * 不带它的话整串会被反向排版，盘符跑到路径末尾去。
 */
export function PathLine(props: { path: string }) {
  return (
    <code class="path-line">
      <span dir="ltr">{props.path}</span>
    </code>
  )
}

/**
 * 这一段是空的。
 *
 * **出路要在眼前。** 空的时候用户正盯着这个框，而这一段的「加一个」按钮在
 * 上面那行区头里——离得远，且空框本身把它推得更远。所以把同一组动作在这里
 * 再放一次：这不是重复，是这一刻唯一相关的东西。
 *
 * **只写一句「暂无 X」，不写引导文案**（B7）：该干什么由按钮说，
 * 多一句「点击新建创建你的第一个…」删掉了用户照样会用。
 */
export function EmptyBox(props: { label: string; actions?: JSX.Element }) {
  return (
    <div class="empty-box">
      <IconFile size={26} />
      <span>{props.label}</span>
      <Show when={props.actions}>
        <div class="empty-actions">{props.actions}</div>
      </Show>
    </div>
  )
}
