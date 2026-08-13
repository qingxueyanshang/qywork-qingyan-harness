import { createResource, createSignal, For, Show } from 'solid-js'
import {
  loadTeam,
  openSettings,
  runTeam,
  selectConversation,
  setOverlay,
  state,
  type TeamInfo,
} from '../lib/store/index.ts'
import { IconCheck, IconSpinner, IconX } from './Icons.tsx'

/**
 * Agent Team 面板。
 *
 * 编排图与角色来自工作区的 `.qy/team.json`。**这个面板只读**，
 * 但改配置现在有地方去了：左栏的「Agent 团队」直接编辑同一个文件。
 *
 * 这里原先写的理由是「做界面等于配置有两个来源，而两个来源迟早分叉」。
 * 担心成立，结论下错了：分叉来自「界面自己另存一份」，不来自「有界面」。
 * 设置页读写的就是 `.qy/team.json` 本身，来源仍然只有一个。
 *
 * 职责分开：**面板看正在发生什么**（谁在跑、谁卡住、谁失败），
 * **设置页改它该怎么跑**。没配的时候把入口指过去，而不是让用户
 * 自己去找那个文件——「在工作区 .qy/team.json 里定义」对着桌面端用户
 * 基本等于一句空话，他手边不一定有编辑器。
 */
export function TeamPanel() {
  const [team] = createResource<TeamInfo>(loadTeam)
  const [goal, setGoal] = createSignal('')

  const start = () => {
    const g = goal().trim()
    if (!g || state.running) return
    runTeam(g)
    setGoal('')
  }

  return (
    <div class="team-panel">
      <Show when={team()?.error}>
        {/* 配置坏了要说出来。静默当作「没配」会让用户以为功能不存在。 */}
        <div class="team-error">{team()!.error}</div>
      </Show>

      <Show
        when={(team()?.roles.length ?? 0) > 0}
        fallback={
          <div class="team-empty">
            <p>还没有配置 Agent Team。</p>
            <p class="hint">
              定义 <code>backends</code> 与 <code>roles</code>，可以把 codex / claude / qy
              当作角色后端编排起来。
            </p>
            <button class="btn-ghost" type="button" onClick={() => openSettings('team')}>
              去编辑 team.json
            </button>
          </div>
        }
      >
        <div class="team-roles">
          <For each={team()!.roles}>
            {(r) => (
              <div class="team-role">
                <div class="team-role-head">
                  <span class="team-role-name">{r.name}</span>
                  <code class="team-role-backend">{r.backend}</code>
                </div>
                <Show when={r.description}>
                  <div class="team-role-desc">{r.description}</div>
                </Show>
              </div>
            )}
          </For>
        </div>

        <div class="team-run">
          <textarea
            class="team-goal"
            rows={2}
            placeholder="这一轮要达成什么？"
            value={goal()}
            onInput={(e) => setGoal(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start()
            }}
          />
          <button
            class="team-start"
            type="button"
            disabled={!goal().trim() || state.running}
            onClick={start}
          >
            开始编排
          </button>
        </div>
      </Show>

      <Show when={state.teamMembers.length > 0}>
        <div class="team-progress">
          <For each={state.teamMembers}>
            {(m) => (
              // 成员做完之后整行可点：子会话不在会话列表里（source=team），
              // 这里是看「它到底读了什么、跑了哪些命令」的唯一入口。
              // 没有子会话的（CLI 后端、还在跑的）就是一个普通的 div，
              // 不渲染成一个点了没反应的按钮。
              <div
                class="team-member"
                classList={{ failed: m.phase === 'failed', openable: !!m.childConversationId }}
                {...(m.childConversationId
                  ? {
                      role: 'button',
                      tabindex: 0,
                      title: '打开这个成员的完整对话',
                      onClick: () => {
                        setOverlay(null)
                        void selectConversation(m.childConversationId as string)
                      },
                    }
                  : {})}
              >
                <span class="team-member-mark">
                  <Show
                    when={m.phase === 'done' || m.phase === 'failed'}
                    fallback={<IconSpinner size={12} />}
                  >
                    <Show when={m.phase === 'done'} fallback={<IconX size={12} />}>
                      <IconCheck size={12} />
                    </Show>
                  </Show>
                </span>
                <span class="team-member-name">{m.roleName}</span>
                <span class="team-member-summary truncate">{m.summary ?? phaseLabel(m.phase)}</span>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  )
}

function phaseLabel(phase: string): string {
  const map: Record<string, string> = {
    spawned: '已派发',
    working: '进行中',
    // blocked 单列：它等的是**人**，不是机器。用户看到这个才知道该去回答门禁。
    blocked: '等待人工确认',
    done: '完成',
    failed: '失败',
  }
  return map[phase] ?? phase
}
