import { createEffect, For, type JSX, Match, Show, Switch } from 'solid-js'
import {
  argsRows,
  clamp,
  collapseCarriageReturns,
  diffFrom,
  firstString,
  listOf,
  todosOf,
} from '../../../lib/step-view.ts'
import type { TranscriptItem } from '../../../lib/store/index.ts'
import { deferredError, loadDeferredOutcome } from '../../../lib/store/views/deferred.ts'
import { TodoList } from '../../TodoList.tsx'

/**
 * 运行中的中途输出。
 *
 * 只在工具运行时出现；执行完毕后由展开内容的终态分支接替，两者不会同时存在。
 *
 * 自行滚动到底部的理由与思考块相同：`.fold-live` 是内层滚动容器，
 * 会话流的底部跟随只作用于外层，不跟随时新到达的行持续追加在视口之外。
 */
function LiveOutput(props: { item: TranscriptItem }) {
  let pre: HTMLPreElement | undefined
  createEffect(() => {
    void props.item.stdout
    if (pre) pre.scrollTop = pre.scrollHeight
  })
  return (
    <pre class="fold-live" ref={pre}>
      {collapseCarriageReturns(props.item.stdout ?? '')}
    </pre>
  )
}

/**
 * 展开内容：输入、输出、错误三段，标题与顺序固定，没有内容的段不显示。
 *
 * - 输入：待办清单、修改的差异、命令或脚本原文、写入的内容，其余工具为参数表。按参数的形状选择，
 *   不按工具名选择。待办清单不交给参数表：整个清单的 JSON 位于一个单元格中，无法逐条辨认状态。
 * - 输出：运行中为实时输出，结束后为结果正文（`outcome.data` 的 `content` / `stdout` / 列表）。
 * - 错误：失败时的原因（`outcome.message`）。
 *
 * 只显示 `outcome.message` 等于复述标题行：「读取 a.ts」展开后显示「读取 a.ts（278 行）」，用户没有获得新信息。
 * 因此输入已有专用内容（差异、写入内容、待办）时输出不回退到 message：编辑与创建的 message 复述标题。
 * 参数表下的输出保留回退：搜索无匹配时，「匹配 0 个文件」是展开内容中唯一的结论。
 */
export function StepBody(props: { item: TranscriptItem }) {
  const args = () => props.item.args ?? {}
  const kind = () => props.item.action?.kind
  // 历史页只带了结果的小字段：展开时读取完整结果（`views/deferred.ts`）。
  createEffect(() => {
    if (props.item.outcome?.deferred) void loadDeferredOutcome(props.item.id)
  })
  const todos = () => todosOf(args())
  const diff = () => (kind() === 'edit' ? diffFrom(args()) : null)
  const code = () => firstString(args(), 'command', 'script', 'code')
  const content = () => (kind() === 'write' ? firstString(args(), 'content', 'text') : '')
  const rows = () => argsRows(args())
  // 输入已有专用内容时，输出不回退到复述标题的 message。
  const dedicated = () => todos() !== null || diff() !== null || content() !== ''
  const running = () => props.item.status === 'running'
  const failed = () => props.item.status === 'failure'

  return (
    <>
      <Show when={deferredError(props.item.id)}>
        {(message) => <pre class="fold-out err">无法读取完整结果：{message()}</pre>}
      </Show>
      <Switch>
        <Match when={todos()}>
          {(list) => (
            <Section title="输入">
              <div class="fold-todos">
                <TodoList todos={list()} />
              </div>
            </Section>
          )}
        </Match>
        <Match when={diff()}>
          {(d) => (
            <Section title="输入">
              <pre class="fold-diff">
                <Show when={d().removed}>
                  <span class="del">{d().removed}</span>
                </Show>
                <Show when={d().added}>
                  <span class="add">{d().added}</span>
                </Show>
              </pre>
            </Section>
          )}
        </Match>
        <Match when={code()}>
          {(text) => (
            <Section title="输入">
              <pre class="fold-code">{text()}</pre>
            </Section>
          )}
        </Match>
        <Match when={content()}>
          {(text) => (
            <Section title="输入">
              <pre class="fold-code">{clamp(text())}</pre>
            </Section>
          )}
        </Match>
        <Match when={rows().length > 0}>
          <Section title="输入">
            <ArgsTable rows={rows()} />
          </Section>
        </Match>
      </Switch>
      <Show when={running()} fallback={<Result item={props.item} noMessage={dedicated()} />}>
        <Show when={props.item.stdout}>
          <Section title="输出">
            <LiveOutput item={props.item} />
          </Section>
        </Show>
      </Show>
      <Show when={failed()}>
        <Section title="错误">
          <pre class="fold-out err">{props.item.outcome?.message || '（无错误正文）'}</pre>
        </Section>
      </Show>
    </>
  )
}

/** 展开内容中的一段：标题加正文。各段之间的间距由样式表的 `.fold-section + .fold-section` 提供。 */
function Section(props: { title: string; children: JSX.Element }) {
  return (
    <div class="fold-section">
      <div class="fold-tag">{props.title}</div>
      {props.children}
    </div>
  )
}

/**
 * 「输出」段。
 *
 * 取值顺序：`data.content` → `data.stdout` → `data.stderr` → `data.output` → 列表型 →
 * `outcome.message`。`output` 键供 MCP 与插件工具使用：它们的 data 结构由第三方
 * 决定，`output` 是其中的常见键；内置工具不产生该键（派发任务的两个工具渲染为图卡片，不经过此处）。
 *
 * 失败时把 `stderr` 提到最前：错误信息通常只写入错误流，而 stdout 往往另有内容
 * （测试的进度输出、服务器的启动日志），按成功时的顺序取值会取得 stdout，实际的
 * 错误信息被排在后面。内容为空时整个字段不渲染：空 `<pre>` 只会在展开内容中留下
 * 一个没有内容的边框。
 */
function Result(props: {
  item: TranscriptItem
  /**
   * 无法取得正文时不回退到 `outcome.message`：message 只是标题行的复述（编辑、创建）。
   * 失败时同样不回退，message 已显示在「错误」段。
   */
  noMessage?: boolean
}) {
  const text = () => {
    const data = (props.item.outcome?.data ?? {}) as Record<string, unknown>
    const keys =
      props.item.status === 'failure'
        ? ['stderr', 'content', 'stdout', 'output']
        : ['content', 'stdout', 'stderr', 'output']
    for (const k of keys) {
      if (typeof data[k] === 'string' && (data[k] as string).trim()) return data[k] as string
    }
    const list = listOf(data)
    if (list) return list.join(NEWLINE)
    return props.noMessage || props.item.status === 'failure'
      ? ''
      : (props.item.outcome?.message ?? '')
  }

  return (
    <Show when={text().trim()}>
      {(body) => (
        <Section title="输出">
          <pre class="fold-out">{clamp(collapseCarriageReturns(body()))}</pre>
        </Section>
      )}
    </Show>
  )
}

const NEWLINE = String.fromCharCode(10)

function ArgsTable(props: { rows: [string, string][] }) {
  return (
    <table class="args-table">
      <tbody>
        <For each={props.rows}>
          {([k, v]) => (
            <tr>
              <th>{k}</th>
              <td>{v}</td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
  )
}
