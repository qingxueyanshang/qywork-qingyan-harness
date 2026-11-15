import { createEffect, For, Match, Show, Switch } from 'solid-js'
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
 * 展开内容。必须提供标题行之外的信息，且每种动作对应一种主体内容，
 * 而不是罗列所有可能的块。
 *
 * 只渲染 `outcome.message` 等于复述标题行：「读取 packages/server/src/git.ts」
 * 展开后显示「读取 packages/server/src/git.ts（278 行）」，用户展开后没有获得新信息。
 * 有信息量的是参数：修改的 diff、执行的命令、读取的范围都在 `args` 中。
 *
 * 划分方式：
 *   待办：清单逐行（勾选 / 加载动画 / 空心圆点）
 *   编辑：diff →（分隔线）→ 结果
 *   运行：命令原文 →（分隔线）→「输出」标签 + 输出
 *   创建：新内容全文 → 结果
 *   其余：参数表 →（分隔线）→ 结果
 *
 * 失败时错误正文排在最前，之后用分隔线隔开，其下是与成功时相同的主体。不要为失败另写一套主体：
 * 失败时最需要核对的是执行了什么，而参数表跳过超过 400 字的值，长命令与修改内容会因此不显示。
 *
 * 「结果」字段取 `outcome.data`（`content` / `stdout` / `entries` / `matches`），
 * 无法取得时才回退到 `message`：message 只是一句摘要，不是正文。
 *
 * 自带主体块的分支一律使用 `noMessage`。编辑与创建的 message 是
 * 「编辑 x（1 处）」「创建 x」，与标题行的「修改文件 · x」内容重复，
 * 回退时会在正文下方再显示一个复述标题的灰色块。没有主体块的「其余」分支
 * 保留回退：搜索无匹配时，「匹配 0 个文件」是展开内容中唯一的结论。
 */
export function StepBody(props: { item: TranscriptItem }) {
  const args = () => props.item.args ?? {}
  const kind = () => props.item.action?.kind

  return (
    <>
      <Show when={props.item.status === 'failure'}>
        <pre class="fold-out err">{props.item.outcome?.message || '（无错误正文）'}</pre>
        <div class="fold-divider" />
      </Show>
      <Switch fallback={<Generic item={props.item} />}>
        {/*
         * 中途输出排在最前。运行时 `outcome` 尚不存在，进入下方任何分支
         * 都只显示空卡片；该分支只在 `status === 'running'` 时成立，
         * 到达终态后自动让位，无需额外清理。
         */}
        <Match when={props.item.status === 'running' && props.item.stdout}>
          <LiveOutput item={props.item} />
        </Match>

        {/*
         * 待办清单。不能交给通用参数表分支处理：整个清单的 JSON 位于一个单元格中，
         * 状态位于 `"status":"in_progress"` 的引号之间，判断哪些条目已完成
         * 需要逐个辨认。该分支提供标题行没有的信息，即每一条的状态。
         *
         * 使用 `noMessage`：回执是「第 3/4 步：编写 main.js」，而清单中该条目已带有
         * 加载动画标记，再显示回执即为重复。
         */}
        <Match when={todosOf(args()) !== null}>
          <div class="fold-todos">
            <TodoList todos={todosOf(args())!} />
          </div>
        </Match>

        <Match when={kind() === 'edit' && diffFrom(args()) !== null}>
          {(() => {
            const d = diffFrom(args())!
            return (
              <pre class="fold-diff">
                <Show when={d.removed}>
                  <span class="del">{d.removed}</span>
                </Show>
                <Show when={d.added}>
                  <span class="add">{d.added}</span>
                </Show>
              </pre>
            )
          })()}
          <Result item={props.item} withDivider noMessage />
        </Match>

        {/* 没有命令原文的运行类调用（批量运行画布）按「其余」显示参数表：
            失败时只有参数能说明本次执行的对象。 */}
        <Match when={kind() === 'run' && firstString(args(), 'command', 'script', 'code')}>
          {(cmd) => (
            <>
              <pre class="fold-code">{cmd()}</pre>
              <Result item={props.item} label="输出" withDivider />
            </>
          )}
        </Match>

        <Match when={kind() === 'write' && firstString(args(), 'content', 'text') !== ''}>
          <pre class="fold-code">{clamp(firstString(args(), 'content', 'text'))}</pre>
          <Result item={props.item} noMessage />
        </Match>
      </Switch>
    </>
  )
}

function Generic(props: { item: TranscriptItem }) {
  const rows = () => argsRows(props.item.args ?? {})
  return (
    <>
      <Show when={rows().length > 0}>
        <ArgsTable rows={rows()} />
      </Show>
      <Result item={props.item} withDivider={rows().length > 0} />
    </>
  )
}

/**
 * 「结果」字段。
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
  label?: string
  withDivider?: boolean
  /**
   * 无法取得正文时不回退到 `outcome.message`：message 只是标题行的复述（编辑、创建）。
   * 失败时同样不回退，message 已作为错误正文显示在展开内容的最上方。
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
        <>
          <Show when={props.withDivider}>
            <div class="fold-divider" />
          </Show>
          <Show when={props.label}>
            <div class="fold-tag">{props.label}</div>
          </Show>
          <pre class="fold-out">{clamp(collapseCarriageReturns(body()))}</pre>
        </>
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
