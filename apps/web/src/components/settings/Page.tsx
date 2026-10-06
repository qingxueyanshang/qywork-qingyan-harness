import type { JSX } from 'solid-js'
import { Show } from 'solid-js'
import { IconFile } from '../Icons.tsx'

/**
 * 设置页的版面构件：页头、分区、条目卡、空态框。
 *
 * 集中定义的原因：记忆 / 技能 / MCP / 插件 / Agent Team 五页展示的是同一类内容，
 * 即「该层有哪些条目、如何新增」。各页分别实现版面时，同一个「暂无内容」
 * 会出现五种高度与底色。
 *
 * 页头整体固定在滚动区顶部：标题、说明与右上角的动作属于同一块。只固定标题时，滚动后标题与
 * 动作按钮会错开。
 */

/**
 * 页头。`desc` 只写界面上别处没有的边界，例如「重启后生效」「全局安装对所有项目生效」。
 * 控件本身已能表达的内容不在此处重复。
 *
 * 说明与标题位于同一行：页头固定在顶部，另起一行会使每一页多占一行高度，
 * 而说明的信息量不足以占用一行。超出宽度时截断（`.page-desc`）。
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
 * 页面中的一个分区。标题可省略：只有一个分区的页面无需分区标题。
 *
 * 动作按钮属于分区而不属于页头：一页中可能有多个分区各自支持新增（角色 / 后端、
 * 技能 / 指令），动作全部放在页头时，用户无法判断新增到哪个分区。
 *
 * `desc` 与 `path` 都排在分区标题行中，不另起一行：两者各只有一句，
 * 单独占一行会使下方内容下移。超出宽度时截断。
 */
export function Section(props: {
  title?: string
  desc?: string
  /** 该分区的落盘位置，紧随标题排列。不分层的页面使用它，分层的页面使用 `ScopeTabs`。 */
  path?: string
  actions?: JSX.Element
  children: JSX.Element
}) {
  return (
    <section class="settings-block">
      <Show when={props.title || props.desc || props.path || props.actions}>
        <div class="settings-block-head">
          <Show when={props.title}>{(t) => <h3>{t()}</h3>}</Show>
          <Show when={props.desc}>{(d) => <p class="section-desc">{d()}</p>}</Show>
          <Show when={props.path}>{(p) => <PathLine path={p()} />}</Show>
          <Show when={props.actions}>
            <div class="section-actions">{props.actions}</div>
          </Show>
        </div>
      </Show>
      {props.children}
    </section>
  )
}

/**
 * 一个条目：名称与一行说明，右侧放置徽标与动作按钮。
 *
 * `onOpen` 决定名称区域是否为按钮。动作按钮必须位于名称区域之外：
 * 嵌套在按钮中的按钮无法点击，而「点击卡片打开、点击 × 删除」是本页最常用的两个操作。
 *
 * `children` 位于下方，占满卡片宽度：MCP 的工具名、插件的隔离状态都比一行说明长。
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
 * 单行显示，从左侧截断。绝对路径常超过一行，换行后比正文更显眼，而它只是
 * 位置说明。从左侧截断是因为末尾的目录名才包含有效信息。
 *
 * 内层的 `dir="ltr"` 不能省略：外层为把省略号放在左侧设置了 `direction: rtl`，
 * 缺少内层设置时整串会反向排版，盘符移到路径末尾。
 */
export function PathLine(props: { path: string }) {
  return (
    <code class="path-line">
      <span dir="ltr">{props.path}</span>
    </code>
  )
}

/**
 * 分区的空状态。
 *
 * 空状态框内再放一次分区的动作按钮：分区为空时用户的视线位于空状态框，
 * 而分区标题行中的新增按钮距离较远。此时它是唯一相关的操作，不属于重复显示。
 *
 * 只写一句「暂无 X」，不写引导文案（B7）：下一步操作由按钮表达，
 * 「点击新建创建你的第一个…」这类句子删除后不影响使用。
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
