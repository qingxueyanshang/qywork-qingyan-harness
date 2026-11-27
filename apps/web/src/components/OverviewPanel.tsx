import type { ConversationBoardResponse } from '@qywork/core'
import { createMemo, createResource, For, type JSX, Show } from 'solid-js'
import { collapseWorkflowItems } from '../lib/render-items.ts'
import { createRefreshKey, loaded } from '../lib/resource.ts'
import {
  canvasTitle,
  client,
  ledgerRevision,
  openCliTab,
  openConversationTab,
  openFileInPanel,
  state,
  stopBackgroundCommand,
  transcript,
} from '../lib/store/index.ts'
import { IconCanvas, IconSpinner, IconUser } from './Icons.tsx'
import { TodoList } from './TodoList.tsx'

type Subagent = ConversationBoardResponse['subagents'][number]

/**
 * 右侧面板的看板：当前会话的待办、后台任务、子 agent 与画布，四组纵向排列，空组不显示，全部为空时空白。
 *
 * 待办与后台任务读取实时快照（`state.todos`、`state.backgroundCommands`）；子 agent 与画布由
 * `/api/conversations/:id/board` 从账本读取。后两者没有推送：账本进度、本会话中已结束的工具调用数或
 * 任一会话的忙态变化时重新读取。子 agent 的派发与结束都改变其子会话的忙态，画布工具结束时已结束的调用数增加。
 *
 * 后台任务只在此处显示，不在输入框顶部另列：同一信息只显示一处。
 */
export function OverviewPanel() {
  const revision = () =>
    [
      ledgerRevision(),
      transcript().filter((i) => i.kind === 'tool' && i.status !== 'running').length,
      state.busyConversations.join(','),
    ].join('|')
  const key = createRefreshKey(() => state.activeConversation, revision)
  // 结果带上所属会话：切换会话后、新结果到达之前，资源仍保留上一会话的值，按会话核对后才显示。
  const [board] = createResource(key, async (k) =>
    k.scope === null
      ? null
      : {
          scope: k.scope,
          ...(await client.api<ConversationBoardResponse>(`/api/conversations/${k.scope}/board`)),
        },
  )
  const current = createMemo(() => {
    const b = loaded(board)
    return b && b.scope === state.activeConversation ? b : null
  })
  const subagents = () => current()?.subagents ?? []
  const canvases = () => current()?.canvases ?? []

  return (
    <div class="overview-panel">
      <Show when={state.todos.length > 0}>
        <Section title="待办">
          <TodoList todos={state.todos} />
        </Section>
      </Show>
      <Show when={state.backgroundCommands.length > 0}>
        <Section title="后台任务">
          <For each={state.backgroundCommands}>
            {(c) => (
              <div class="overview-row running">
                <span class="overview-mark">
                  <IconSpinner size={12} />
                </span>
                <span class="overview-label truncate" data-tip={c.command}>
                  {c.command}
                </span>
                {/* 停止只结束这一项，行的去留以服务端快照为准。 */}
                <button
                  class="overview-act"
                  type="button"
                  onClick={() => stopBackgroundCommand(c.id)}
                >
                  停止
                </button>
              </div>
            )}
          </For>
        </Section>
      </Show>
      <Show when={subagents().length > 0}>
        <Section title="子 agent">
          <For each={subagents()}>{(a) => <SubagentRow agent={a} />}</For>
        </Section>
      </Show>
      <Show when={canvases().length > 0}>
        <Section title="画布">
          <For each={canvases()}>
            {(path) => (
              <button
                class="overview-row"
                type="button"
                data-tip={path}
                onClick={() => openFileInPanel(path)}
              >
                <span class="overview-mark">
                  <IconCanvas size={12} />
                </span>
                <span class="overview-label truncate">{canvasTitle(path)}</span>
              </button>
            )}
          </For>
        </Section>
      </Show>
    </div>
  )
}

function Section(props: { title: string; children: JSX.Element }) {
  return (
    <section class="overview-section">
      <div class="overview-head">{props.title}</div>
      {props.children}
    </section>
  )
}

/**
 * 外部 CLI 子 agent 的输出页位置：会话流中最近一张派发它的卡片与节点。外部 CLI 的子会话没有正文，
 * 输出记录在派发卡上，因此与卡片上的节点打开同一页（`DelegateCard`）。卡片所在的轮次尚未加载时为 null。
 */
function cliNodeOf(id: string): { stepId: string; nodeId: string } | null {
  const items = collapseWorkflowItems(transcript())
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    const states = item.workflow ? item.workflow.states : (item.nodes ?? {})
    for (const [nodeId, s] of Object.entries(states)) {
      if (s.subagentId === id) return { stepId: item.id, nodeId }
    }
  }
  return null
}

/**
 * 一个子 agent。运行中取自忙态（派发方占用子会话时发布），与侧栏、宠物的运行状态同一来源。
 * 内置子 agent 打开子会话页；外部 CLI 打开其输出页，派发卡未加载时该行不可点击。
 */
function SubagentRow(props: { agent: Subagent }) {
  const running = () => state.busyConversations.includes(props.agent.id)
  const open = createMemo((): (() => void) | null => {
    const { id, title, kind } = props.agent
    if (kind !== 'cli') return () => openConversationTab(id, title)
    const at = cliNodeOf(id)
    return at ? () => openCliTab(at.stepId, at.nodeId, title) : null
  })
  const body = () => (
    <>
      <span class="overview-mark">
        <Show when={running()} fallback={<IconUser size={12} />}>
          <IconSpinner size={12} />
        </Show>
      </span>
      <span class="overview-label truncate">{props.agent.title}</span>
    </>
  )
  return (
    <Show
      when={open()}
      fallback={
        <div class="overview-row" classList={{ running: running() }}>
          {body()}
        </div>
      }
    >
      {(go) => (
        <button
          class="overview-row"
          classList={{ running: running() }}
          type="button"
          onClick={() => go()()}
        >
          {body()}
        </button>
      )}
    </Show>
  )
}
