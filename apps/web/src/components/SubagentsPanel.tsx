import type { ConversationSubagentsResponse, NodePhase, WorkflowPhase } from '@qywork/core'
import { createMemo, createResource, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import { firstLine } from '../lib/step-view.ts'
import { client, ledgerRevision, openConversationTab, state } from '../lib/store/index.ts'
import { LoadState } from './settings/LoadState.tsx'

/**
 * 子 agent：这条会话派出去过的每一个，以及建过的每一张工作流。
 *
 * 会话流只画得出当前翻到的那几轮；这一页按账本列全，点一行翻开它那条子会话。
 * 外部 CLI 那一行不可点：它的正文在本机另一个进程里，账本上只有元数据。
 */
export default function SubagentsPanel() {
  // 判据按值去重，理由同运行页：对象字面量每次都是新的，memo 才有「没变就别重取」。
  const key = createMemo(
    () => ({ id: state.activeConversation, rev: ledgerRevision() }),
    undefined,
    { equals: (a, b) => a.id === b.id && a.rev === b.rev },
  )
  const [data, { refetch }] = createResource(key, async (k) =>
    k.id === null
      ? ({ subagents: [], workflows: [] } as ConversationSubagentsResponse)
      : await client.api<ConversationSubagentsResponse>(`/api/conversations/${k.id}/subagents`),
  )

  return (
    <div class="sub-panel">
      <Show
        when={loaded(data)}
        fallback={
          <div class="run-load">
            <LoadState error={data.error} onRetry={() => void refetch()} />
          </div>
        }
      >
        {(d) => (
          <>
            <Show when={d().subagents.length > 0}>
              <ul class="sub-list">
                <For each={d().subagents}>
                  {(item) => (
                    <li>
                      <button
                        type="button"
                        class="sub-row"
                        classList={{ static: item.kind === 'cli' }}
                        disabled={item.kind === 'cli'}
                        onClick={() => openConversationTab(item.id, item.name)}
                      >
                        <span class="sub-name truncate">{item.name}</span>
                        <span class="sub-meta truncate">
                          {KIND[item.kind]} · {item.model}
                        </span>
                        <span class="sub-state" classList={{ [item.status]: true }}>
                          {STATUS[item.status]}
                        </span>
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
            <For each={d().workflows}>
              {(wf) => (
                <section class="sub-group">
                  <header class="sub-group-head">
                    <span class="sub-name truncate">{firstLine(wf.goal)}</span>
                    <span class="sub-state" classList={{ [wf.phase]: true }}>
                      {WORKFLOW[wf.phase]}
                    </span>
                  </header>
                  <ul class="sub-list">
                    <For each={wf.nodes}>
                      {(node) => (
                        <li>
                          <button
                            type="button"
                            class="sub-row"
                            classList={{ static: !node.subagentId }}
                            disabled={!node.subagentId}
                            onClick={() =>
                              node.subagentId && openConversationTab(node.subagentId, node.label)
                            }
                          >
                            <span class="sub-name truncate">{node.id}</span>
                            <span class="sub-meta truncate">{node.label}</span>
                            <span class="sub-state" classList={{ [node.phase]: true }}>
                              {NODE[node.phase]}
                            </span>
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </section>
              )}
            </For>
          </>
        )}
      </Show>
    </div>
  )
}

const KIND = { role: '角色', temp: '临时', cli: '外部 CLI' } as const
const STATUS = { running: '进行中', idle: '空闲', failed: '失败' } as const
const WORKFLOW: Record<WorkflowPhase, string> = {
  running: '进行中',
  waiting_review: '待审查',
  completed: '已完成',
  failed: '失败',
}
const NODE: Record<NodePhase, string> = {
  waiting: '等待',
  queued: '排队',
  working: '进行中',
  done: '完成',
  failed: '失败',
  skipped: '跳过',
  interrupted: '中断',
}
