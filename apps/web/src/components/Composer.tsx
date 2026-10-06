import type { Attachment, ContextGroup, FollowUp, Goal } from '@qywork/core'
import {
  attachmentTypeOf,
  baseNameOf,
  CONTEXT_GROUPS,
  isInlineImage,
  mimeOf,
  toPosixPath,
} from '@qywork/core'
import { createEffect, createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { buildCommands, type Command, matchSlash } from '../lib/commands.ts'
import { matchesMention, mentionQuery, replaceMention } from '../lib/composer-suggestions.ts'
import { slashDispatch } from '../lib/slash.ts'
import {
  activeModel,
  activeModelRow,
  type CliAgentRow,
  composerSeed,
  dropFollowUp,
  extensionsRevision,
  followUpMode,
  hasRun,
  interrupt,
  isDesktopShell,
  isRunning,
  loadSkills,
  loadTeam,
  loadTeamClis,
  loadTools,
  modelCatalog,
  panelMaximized,
  pickFiles,
  registerDropSink,
  resumeGoal,
  type SkillMeta,
  sendMessage,
  setComposerSeed,
  setPermissionMode,
  setState,
  state,
  steerFollowUp,
  type TeamRoleRow,
  type ToolMeta,
  uploadAttachment,
  workspace,
} from '../lib/store/index.ts'
import { AttachmentThumb } from './AttachmentThumb.tsx'
import { BranchPicker } from './BranchPicker.tsx'
import {
  IconFolder,
  IconMcpSolid,
  IconPencil,
  IconPluginSolid,
  IconPlus,
  IconSend,
  IconShield,
  IconSkillSolid,
  IconStop,
  IconTrash,
  IconUsers,
  IconX,
} from './Icons.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { RunStatus } from './RunStatus.tsx'
import { VoiceButton } from './VoiceButton.tsx'

/**
 * 权限模式。
 *
 * 位于输入区而不是设置中：它决定下一轮的放行级别，
 * 与「使用哪个模型」属于同一层级的决定，需要随时修改。放入设置意味着每次修改需要点击四次，
 * 且与模型选择器分处两处，同一个决定被拆分到两个位置。
 *
 * 只有两种模式，因此使用开关而不是下拉框。文案使用「自动审批 / 完全访问」，
 * 不使用配置中的 `auto` / `full`：后者是配置文件中的字面量，不面向用户。
 */
function ModeChip() {
  const [busy, setBusy] = createSignal(false)
  const mode = () => state.capabilities?.mode ?? 'auto'
  const full = () => mode() === 'full'

  const toggle = async () => {
    if (busy()) return
    setBusy(true)
    const next = full() ? 'auto' : 'full'
    try {
      await setPermissionMode(next)
      // 握手只在连接时报告一次模式，此处就地同步；否则点击后按钮不变，看起来未生效。
      setState('capabilities', (c) => (c ? { ...c, mode: next } : c))
    } catch (e) {
      setState('notice', {
        message: e instanceof Error ? e.message : String(e),
        reason: 'config_write_failed',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      class="mode-chip"
      classList={{ full: full() }}
      type="button"
      disabled={busy()}
      aria-pressed={full()}
      data-tip={
        full() ? '不做权限检查，也不限制路径；仍剥离凭证' : '只放行确定安全的命令，其余直接拒绝'
      }
      onClick={() => void toggle()}
    >
      <IconShield size={13} />
      {full() ? '完全访问' : '自动审批'}
    </button>
  )
}

/**
 * 目标状态的说明文字。每一种状态都必须有说明，尤其以下两种：
 *
 * - `blocked` 必须原样显示理由。后端强制每一次 blocked 都附带理由
 *   （`run-control.ts` 的 `STOP_NOTE`、触发轮数上限的说明），界面不显示时，
 *   循环已经停止，而用户只看到「受阻」两个字。
 * - `active` 但没有运行中的一轮，含义是「自动继续未开启」。**自动继续标记不落盘**
 *   （`server/runs.ts` 的 `GoalArm`：若落盘，失控后崩溃的循环会在下次
 *   启动时自动恢复运行），因此进程重启、会话恢复之后目标仍保留在账本中，但不会
 *   自动启动新一轮。不说明这一点，界面上呈现的就是「目标仍在、但没有任何动作」。
 */
function goalNote(goal: Goal, running: boolean): string {
  if (goal.status === 'blocked') return `受阻：${goal.blockedReason ?? '未提供理由'}`
  if (goal.status === 'paused') return '已暂停'
  return running ? '自动继续中' : '自动继续未开启，点击「继续」恢复执行'
}

/**
 * 当前目标：内容、是否在运行、能否停止。
 *
 * **自动循环必须可见**：它逐轮自动执行，而界面上只有正文在增长。
 * 因此它常驻在输入框顶部，与等待队列共用同一组状态栏：目标回答「多轮执行
 * 要达成什么」，待办回答「本轮进行到哪一步」，用户应能同时看到这两项。
 *
 * **两个按钮的执行路径**：
 * - **停止 = 中断本轮**（`interrupt`）。run 收尾时服务端把目标置回 `paused`
 *   并解除自动继续标记，因此停止本轮即停止该循环。**不另设「暂停目标」指令**：
 *   同一操作有第二个入口时，两条路径终将对「当前是否已停止」给出不同答案。
 * - **继续 = `goal.resume`**（`resumeGoal`）。它不只把状态改回 `active`，
 *   而是重新启用自动继续，并立即发起一轮。
 *
 * **完成后不显示。** 它回答的是「是否仍在运行」，`completed` 之后不存在该问题。`completed` 是终
 * 态，没有任何出边：保留一个点击后必然被服务端拒绝的「继续」按钮，比不保留更差。
 *
 * **不显示轮数。** 该循环没有轮数上限（见 `core` 中 `Goal` 的注释），因此没有「第几轮 / 共几轮」
 * 可显示。也不显示已执行的轮数：该数值不影响用户的任何决定，显示后只会把
 * 「是否完成」转换为「运行了多久」，而循环是否应停止取决于目标本身，不取决于计数。
 * 用户需要的两项信息都在这一行中：是否在运行，以及如何停止。
 *
 * **单行，且窄于输入框。** 空间不足时先截断目标正文，再截断状态，两处都有悬停提示。高度固定（B9）：
 * 状态文字长短不一，若由内容撑高，「停止」按钮的位置会移动。
 */
function GoalChip() {
  const goal = () => state.goal
  const live = () => {
    const g = goal()
    return g && g.status !== 'completed' ? g : null
  }

  return (
    <Show when={live()}>
      {(g) => (
        <div class="goal-chip">
          <div class="goal-line">
            <span class="goal-label">目标</span>
            {/* 正文过长时截断并提供悬停提示，不做悬停卡片：卡片承载的信息这一行
                已经显示，唯一的效果是鼠标经过时遮挡下一行。 */}
            <span class="goal-text truncate" data-tip={g().objective}>
              {g().objective}
            </span>
            {/* 状态紧邻「停止」：用户读到运行状态后，紧接着应看到停止按钮。 */}
            <span
              class="goal-note truncate"
              classList={{ blocked: g().status === 'blocked' }}
              data-tip={goalNote(g(), isRunning())}
            >
              {goalNote(g(), isRunning())}
            </span>
            <Show
              when={isRunning()}
              fallback={
                <button class="goal-act" type="button" onClick={resumeGoal}>
                  继续
                </button>
              }
            >
              <button class="goal-act" type="button" onClick={interrupt}>
                停止
              </button>
            </Show>
          </div>
        </div>
      )}
    </Show>
  )
}

/**
 * 排队中的后续消息，显示为输入框顶部的队列栏；它与正文、附件共用同一个输入框外壳。
 *
 * 卡片上有三个可点击对象：
 *
 * - **档位按钮**：按钮文字表示点击后执行的动作，而不是该条消息当前的档位。
 *   排队中的消息显示「调整方向」，点击后注入当前一轮，文字随之变为「加入队列」，
 *   再次点击退回队列。会话空闲时没有可注入的运行轮次，文字为「发送」，点击后立即
 *   启动一轮。三种状态采用同一种读法。不要改为显示当前档位：那样同一个按钮上「发送」是
 *   动作、另两个词是状态，同一位置出现两种读法。
 *   档位由服务端在同一个同步块中裁决，此处只负责显示。
 * - **修改**：从队列删除原条目，把正文和附件交回输入框；修改后使用原发送入口。
 * - **删除**：删除后既不注入也不发送。
 *
 * **单行，固定高度（B9）**：正文长短不一，若由内容撑高，删除按钮的位置会随之移动。
 * 不做悬停卡片：卡片承载的信息这一行已经显示。
 */
function FollowUpCards(props: {
  onEdit: (followUp: FollowUp) => void
  thumbProps: (path: string) => { localUrl?: string }
}) {
  return (
    <Show when={state.followUps.length > 0}>
      <div class="followup-cards">
        <For each={state.followUps}>
          {(f) => (
            <div class="followup-card">
              <span class="followup-label">{f.steer ? '调整' : '队列'}</span>
              <Show when={(f.attachments?.length ?? 0) > 0}>
                <span class="followup-attachment-strip">
                  <For each={(f.attachments ?? []).slice(0, 3)}>
                    {(a) => (
                      <span class="followup-mini-attachment" data-tip={a.name}>
                        <AttachmentThumb
                          path={a.path}
                          name={a.name}
                          box={24}
                          {...props.thumbProps(a.path)}
                        />
                      </span>
                    )}
                  </For>
                  <Show when={(f.attachments?.length ?? 0) > 3}>
                    <span class="followup-attachment-more">
                      +{(f.attachments?.length ?? 0) - 3}
                    </span>
                  </Show>
                </span>
              </Show>
              <span
                class="followup-text truncate"
                data-tip={f.content || f.attachments?.map((a) => a.name).join('、')}
              >
                {f.content ||
                  (f.attachments?.length === 1
                    ? f.attachments[0]?.name
                    : `${f.attachments?.length ?? 0} 个附件`)}
              </span>
              <div class="followup-actions">
                <button
                  class="followup-act"
                  type="button"
                  onClick={() => steerFollowUp(f.id, !f.steer)}
                >
                  {!hasRun() ? '发送' : f.steer ? '加入队列' : '调整方向'}
                </button>
                <button
                  class="followup-act icon"
                  type="button"
                  aria-label="修改"
                  data-tip="修改"
                  onClick={() => props.onEdit(f)}
                >
                  <IconPencil size={16} />
                </button>
                <button
                  class="followup-act icon danger"
                  type="button"
                  aria-label="删除"
                  data-tip="删除"
                  onClick={() => dropFollowUp(f.id)}
                >
                  <IconTrash size={16} />
                </button>
              </div>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
}

type MentionOption = {
  id: string
  name: string
  label: string
  hint: string
  icon: Command['icon']
}

type PickerOption = { kind: 'command'; command: Command } | { kind: 'mention'; item: MentionOption }

function scopeLabel(skill: SkillMeta): string {
  if (skill.scope === 'project') return '项目技能'
  if (skill.scope === 'global') return '全局技能'
  return '内置技能'
}

function toolSource(tool: ToolMeta): string {
  if (tool.source.startsWith('mcp:')) return `MCP · ${tool.source.slice(4)}`
  if (tool.source.startsWith('plugin:')) return `插件 · ${tool.source.slice(7)}`
  return tool.source
}

function roleOption(role: TeamRoleRow): MentionOption {
  return {
    id: `agent:role:${role.id}`,
    name: role.id,
    label: `子 Agent · ${role.name}`,
    hint: role.description || '项目角色',
    icon: IconUsers,
  }
}

function cliOption(agent: CliAgentRow): MentionOption {
  return {
    id: `agent:cli:${agent.id}`,
    name: `cli:${agent.id}`,
    label: `外部 Agent · ${agent.vendor}`,
    hint: '已连接',
    icon: IconUsers,
  }
}

function toolOption(tool: ToolMeta): MentionOption {
  const source = toolSource(tool)
  return {
    id: `tool:${tool.name}`,
    name: tool.name,
    label: source,
    hint: tool.summary,
    icon: tool.source.startsWith('mcp:') ? IconMcpSolid : IconPluginSolid,
  }
}

/**
 * 输入区。
 *
 * 三条交互约定：
 * - Enter 发送、Shift+Enter 换行。中文输入法组合期间（isComposing）必须放行，
 *   否则用拼音选词时按回车会把未完成的拼音发送出去。
 * - 会话运行中仍可发送：该条消息进入队列，去向由默认档位决定，
 *   `Ctrl+Enter` 使单条消息使用相反的档位。默认档位在设置页设置，不在此处常驻显示。
 * - 高度自适应，达到上限后改为内部滚动，不挤占会话区。
 */
export function Composer(props: { empty: boolean }) {
  const [text, setText] = createSignal('')
  const [menuCursor, setMenuCursor] = createSignal(0)
  const [pending, setPending] = createSignal<Attachment[]>([])
  const [uploading, setUploading] = createSignal(0)
  const [dragOver, setDragOver] = createSignal(false)
  const [panelDockOpen, setPanelDockOpen] = createSignal(false)
  const [panelDockFocused, setPanelDockFocused] = createSignal(false)
  const [panelDockReady, setPanelDockReady] = createSignal(false)
  const [skillOptions, setSkillOptions] = createSignal<MentionOption[]>([])
  const [targetOptions, setTargetOptions] = createSignal<MentionOption[]>([])
  const [skillLoad, setSkillLoad] = createSignal<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const [targetLoad, setTargetLoad] = createSignal<'idle' | 'loading' | 'ready'>('idle')
  const [skillLoadNote, setSkillLoadNote] = createSignal<string | null>(null)
  const [targetLoadNote, setTargetLoadNote] = createSignal<string | null>(null)
  /**
   * 粘贴附件的本地预览地址，按落盘路径存储。
   *
   * 只增不减：一次会话中粘贴的图片数量有限，而按 chip 的生命周期撤销会与
   * 「发送后 Transcript 仍需显示」冲突。
   */
  const localThumbs = new Map<string, string>()
  /** 输入框中是否有可发送的内容。主按钮的四种状态与 `submit()` 共用此判据。 */
  const hasInput = () => text().trim().length > 0 || pending().length > 0
  /**
   * 面板放大时输入区默认收起，但不能收起正在编辑的草稿。
   * 上传中的附件也算作草稿：它尚未进入 `pending`，此时收起会使上传看起来已丢失。
   */
  const panelDockPinned = () => hasInput() || uploading() > 0 || dragOver()
  const panelDockVisible = () =>
    panelMaximized() && (panelDockOpen() || panelDockFocused() || panelDockPinned())
  /** 有本地预览时附带该字段，没有时省略整个键：`exactOptionalPropertyTypes` 不接受 undefined。 */
  const thumbProps = (path: string): { localUrl?: string } => {
    const u = localThumbs.get(path)
    return u ? { localUrl: u } : {}
  }
  let ta!: HTMLTextAreaElement
  let filePicker!: HTMLInputElement
  let wrap: HTMLDivElement | undefined
  let stopVoiceForSubmit = () => {}
  let panelDockCloseTimer: ReturnType<typeof setTimeout> | undefined
  let panelDockReadyTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 悬浮展开需要即时，收起需要留出从底部触发条移动到输入框的时间。
   * 160ms 足以跨过两者之间的间隙，同时避免鼠标离开后浮层明显滞留。
   */
  const clearPanelDockClose = () => {
    if (panelDockCloseTimer) clearTimeout(panelDockCloseTimer)
    panelDockCloseTimer = undefined
  }
  const cancelPanelDockReady = () => {
    if (panelDockReadyTimer) clearTimeout(panelDockReadyTimer)
    panelDockReadyTimer = undefined
  }
  const revealPanelDock = () => {
    if (!panelMaximized()) return
    clearPanelDockClose()
    setPanelDockOpen(true)
  }
  const closePanelDockSoon = () => {
    if (!panelMaximized()) return
    clearPanelDockClose()
    panelDockCloseTimer = setTimeout(() => {
      panelDockCloseTimer = undefined
      if (panelDockFocused() || panelDockPinned()) return
      setPanelDockOpen(false)
    }, 160)
  }

  createEffect(() => {
    const maximized = panelMaximized()
    clearPanelDockClose()
    cancelPanelDockReady()
    setPanelDockOpen(false)
    setPanelDockFocused(false)
    setPanelDockReady(false)
    if (!maximized) return

    // 先强制提交无过渡的隐藏样式，再启用悬浮动效；短定时不受后台帧节流影响。
    wrap?.getBoundingClientRect()
    panelDockReadyTimer = setTimeout(() => {
      panelDockReadyTimer = undefined
      setPanelDockReady(true)
    }, 16)
  })
  onCleanup(() => {
    clearPanelDockClose()
    cancelPanelDockReady()
  })

  /*
   * 候选按项目失效。Composer 在切换项目时不会重新挂载，若一直保留首次加载的
   * 结果，`#` / `@` 会显示上一个项目的技能、角色与 MCP。异步请求也绑定发起时的
   * workspace id；切换过程中返回的旧结果直接丢弃。
   */
  let suggestionWorkspace: string | null | undefined
  let suggestionEpoch = 0
  createEffect(() => {
    const next = `${workspace()?.id ?? ''}:${extensionsRevision()}`
    if (next === suggestionWorkspace) return
    suggestionWorkspace = next
    suggestionEpoch++
    setSkillOptions([])
    setTargetOptions([])
    setSkillLoad('idle')
    setTargetLoad('idle')
    setSkillLoadNote(null)
    setTargetLoadNote(null)
  })

  const ensureSkills = async () => {
    if (skillLoad() !== 'idle') return
    const owner = workspace()?.id ?? null
    const epoch = suggestionEpoch
    setSkillLoad('loading')
    setSkillLoadNote(null)
    try {
      const loaded = await loadSkills()
      if (epoch !== suggestionEpoch || (workspace()?.id ?? null) !== owner) return
      setSkillOptions(
        loaded.skills
          // 与运行时 `scanSkills` 的生效集合一致；被更高优先级同名技能覆盖的技能不作为可选项。
          .filter((skill) => skill.shadowedBy === null)
          .map((skill) => ({
            id: `skill:${skill.scope}:${skill.name}`,
            name: skill.name,
            label: scopeLabel(skill),
            hint: skill.description,
            icon: IconSkillSolid,
          })),
      )
      setSkillLoad('ready')
    } catch (error) {
      if (epoch !== suggestionEpoch || (workspace()?.id ?? null) !== owner) return
      setSkillLoad('error')
      setSkillLoadNote(`技能读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const ensureTargets = async () => {
    if (targetLoad() !== 'idle') return
    const owner = workspace()?.id ?? null
    const epoch = suggestionEpoch
    setTargetLoad('loading')
    setTargetLoadNote(null)

    /*
     * 三个来源互不影响：本机外部 CLI 探测失败，不应使已连接的 MCP 与项目角色
     * 一并消失。失败项在面板末尾报告，成功项仍可选择。
     */
    const [toolsResult, teamResult, cliResult] = await Promise.allSettled([
      loadTools(),
      loadTeam(),
      loadTeamClis(),
    ])
    if (epoch !== suggestionEpoch || (workspace()?.id ?? null) !== owner) return

    const failed: string[] = []
    const roles = teamResult.status === 'fulfilled' ? teamResult.value.roles : []
    if (teamResult.status === 'rejected') failed.push('项目角色')
    const agents = cliResult.status === 'fulfilled' ? cliResult.value.agents : []
    if (cliResult.status === 'rejected') failed.push('外部 Agent')
    const tools =
      toolsResult.status === 'fulfilled'
        ? toolsResult.value.tools.filter(
            (tool) => tool.source.startsWith('mcp:') || tool.source.startsWith('plugin:'),
          )
        : []
    if (toolsResult.status === 'rejected') failed.push('MCP / 插件')

    setTargetOptions([
      ...roles.map(roleOption),
      ...agents.filter((agent) => agent.connected).map(cliOption),
      ...tools.map(toolOption),
    ])
    setTargetLoad('ready')
    setTargetLoadNote(failed.length ? `部分来源读取失败：${failed.join('、')}` : null)
  }

  let mentionKind: string | null = null
  createEffect(() => {
    const query = mentionQuery(text())
    if (!query) {
      if (mentionKind !== null) suggestionEpoch++
      mentionKind = null
      setSkillLoad('idle')
      setTargetLoad('idle')
      return
    }
    const current = `${workspace()?.id ?? ''}:${extensionsRevision()}:${query.kind}`
    if (mentionKind === current) return
    mentionKind = current
    if (query.kind === 'skill') void ensureSkills()
    if (query.kind === 'target') void ensureTargets()
  })

  /*
   * 接收设置页传入的初始指令。
   *
   * **接收后立即清空信号**：它是一次性投递，若保留，下一次投递相同内容时信号没有变化，
   * effect 不会再次执行，按钮点击后没有响应。
   *
   * **不覆盖已输入的内容**：追加在末尾，中间空一行。用户正在输入时若被清空，
   * 丢失的是用户自己写的草稿。
   */
  createEffect(() => {
    const seed = composerSeed()
    if (seed === null) return
    setComposerSeed(null)
    setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${seed}` : seed))
    ta.focus()
    // 光标移到末尾：用户需要继续往下写，而不是从头修改。
    queueMicrotask(() => ta.setSelectionRange(ta.value.length, ta.value.length))
  })

  /**
   * 可取得源路径的入口：桌面端拖入、原生选择器。
   *
   * **纯前端处理，不发送任何请求。** 文件已在磁盘上，没有字节需要传输，
   * 这就是「不二次存储」的全部实现。
   *
   * `size` 填 0：此处无法取得字节数，而该字段没有消费者（约定写在 `Attachment` 上）。
   */
  const takePaths = (paths: string[]) => {
    const next = paths.filter(Boolean).map((raw) => {
      const path = toPosixPath(raw)
      const name = baseNameOf(path)
      return { type: attachmentTypeOf(name), name, mime: mimeOf(name), size: 0, path }
    })
    if (next.length) setPending((prev) => [...prev, ...next])
  }

  /**
   * 无法取得源路径的入口：剪贴板中只有位图，或浏览器不提供绝对路径。
   *
   * 这些字节除内存外没有第二份，因此落盘是第一次存储，而不是第二次。
   * 存储位置是 `~/.qywork/attachments/<会话id>/`，删除会话时整个目录一并删除。
   *
   * 失败逐个报告并继续处理其余文件：一张图片过大不应导致另外三张也添加失败。
   */
  const takeFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    const conversationId = state.activeConversation
    // 没有会话就没有归属，与「发送」使用同一判据（`sendMessage` 也在此情况下提前返回）。
    if (!conversationId) return
    setUploading((n) => n + list.length)
    for (const f of list) {
      try {
        const a = await uploadAttachment(f, conversationId)
        // 粘贴的文件已持有字节，缩略图直接使用它，省去一次读取。
        if (isInlineImage(a.path)) localThumbs.set(a.path, URL.createObjectURL(f))
        setPending((prev) => [...prev, a])
      } catch (e) {
        setState('notice', {
          message: `${f.name}：${e instanceof Error ? e.message : String(e)}`,
          reason: 'attachment_upload_failed',
        })
      } finally {
        setUploading((n) => n - 1)
      }
    }
  }

  /**
   * 把输入区登记为外壳拖放的接收方：命中测试使用输入区的矩形，路径交给 `takePaths`。
   * 机制以及不使用 HTML5 `ondrop` 的原因，见 `registerDropSink` 的注释。
   */
  onMount(() => {
    if (!isDesktopShell()) return
    const unregister = registerDropSink({
      hit: (pos) => {
        const r = wrap?.getBoundingClientRect()
        return !!r && pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom
      },
      over: setDragOver,
      paths: takePaths,
    })
    onCleanup(unregister)
  })

  /**
   * 斜杠命令。
   *
   * 只在整段草稿恰好是一个 `/xxx` 时弹出（见 `matchSlash`）：正文中的路径
   * `src/lib` 或代码中的除号不应弹出面板。
   */
  const slashHits = () => matchSlash(text())
  const executeSlash = (cmd: Command, arg?: string) => {
    // 先清空草稿再执行：命令可能打开浮层或切换会话，之后 setText 不一定仍作用于本组件。
    setText('')
    queueMicrotask(() => {
      ta.style.height = 'auto'
      cmd.run(arg)
    })
  }
  const runSlash = (cmd: Command) => {
    // 需要附带参数的命令（`/goal`）在面板中选中时不执行，只把命令名填入草稿：
    // 此时用户尚未说明要做什么，执行只会得到一个空目标。
    if (cmd.arg) {
      setText(`/${cmd.slash} `)
      queueMicrotask(() => {
        autosize()
        ta.focus()
      })
      return
    }
    executeSlash(cmd)
  }

  const autosize = () => {
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
  }

  /** `/`、`#`、`@` 共用一个弹层与一套键盘游标，任何时刻只显示当前词对应的一类。 */
  const pickerOptions = (): PickerOption[] => {
    const commands = slashHits()
    if (commands.length) return commands.map((command) => ({ kind: 'command', command }))

    const query = mentionQuery(text())
    if (!query) return []
    const source = query.kind === 'skill' ? skillOptions() : targetOptions()
    return source
      .filter((item) => matchesMention(query.query, item.name, item.label, item.hint))
      .map((item) => ({ kind: 'mention', item }))
  }

  const pickerOpen = () => slashHits().length > 0 || mentionQuery(text()) !== null

  const pickerNote = (): string | null => {
    const query = mentionQuery(text())
    if (!query) return null
    const hits = pickerOptions()
    if (query.kind === 'skill') {
      if (skillLoad() === 'loading' || skillLoad() === 'idle') return '正在读取技能…'
      if (skillLoad() === 'error') return skillLoadNote()
      return hits.length ? null : '没有匹配的技能'
    }
    if (targetLoad() === 'loading' || targetLoad() === 'idle')
      return '正在读取 MCP、插件与子 Agent…'
    return targetLoadNote() ?? (hits.length ? null : '没有匹配的调用目标')
  }

  const pickOption = (option: PickerOption) => {
    if (option.kind === 'command') {
      runSlash(option.command)
      return
    }
    const query = mentionQuery(text())
    if (!query) return
    setText(replaceMention(text(), query, option.item.name))
    setMenuCursor(0)
    queueMicrotask(() => {
      autosize()
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
    })
  }

  /**
   * 把一条等待中的消息取回输入框。队列仍通过服务端原有的删除指令更新，正文与附件
   * 直接回到本组件的草稿；已有草稿不覆盖，待编辑内容追加在末尾。
   */
  const editFollowUp = (followUp: FollowUp) => {
    dropFollowUp(followUp.id)
    if (followUp.content) {
      setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${followUp.content}` : followUp.content))
    }
    const attachments = followUp.attachments ?? []
    if (attachments.length) setPending((prev) => [...prev, ...attachments])
    queueMicrotask(() => {
      autosize()
      ta.focus()
      ta.setSelectionRange(ta.value.length, ta.value.length)
    })
  }

  /**
   * 发送消息。`flip` 表示该条消息使用与默认档位相反的档位（`Ctrl+Enter`）。
   *
   * **不因「正在运行」提前返回**：运行期间发送的消息进入队列，不被拒绝。
   */
  const submit = (flip = false) => {
    const v = text().trim()
    const files = pending()
    // 只有附件没有文字时也可发送：「看这张图」这类意图不应要求用户再输入文字。
    if (!v && files.length === 0) return

    /*
     * 所有提交方式都必须在此处识别命令。只识别带参数的 `/goal` 时，点击发送按钮提交的
     * `/compact`、`/new` 会被当作普通消息，而键盘补全面板能执行它们，同一行文字出现两种语义。
     */
    const dispatch = slashDispatch(v, buildCommands())
    if (dispatch.kind === 'run') {
      stopVoiceForSubmit()
      executeSlash(dispatch.command, dispatch.arg)
      return
    }
    if (dispatch.kind === 'await_argument') {
      runSlash(dispatch.command)
      return
    }

    /*
     * 未配置模型时拦截：当前会话无模型且没有可回退的默认模型时，提交只会在启动 run 时被
     * no_model 拒绝，此处直接显示「未配置模型」并保留草稿与附件。目录尚未加载
     * （cat 为 null）时不拦截，由服务端的 no_model 作为后备处理，避免误拦截。
     */
    const cat = modelCatalog()
    if (!activeModel()?.model && cat !== null && !cat.active) {
      setState('notice', { message: '未配置模型', reason: 'no_model' })
      return
    }

    /*
     * 图片能力未知时沿用现有的试发送语义；视频只有模型与协议均明确支持时才允许发送。
     * 能力不符时保留草稿与附件，由用户更换模型或移除媒体。
     */
    if (activeModelRow()?.vision === false && files.some((f) => f.type === 'image')) {
      setState('notice', {
        message: '当前模型不支持图片输入，请移除图片后再发送',
        reason: 'model_without_vision',
      })
      return
    }
    if (activeModelRow()?.video !== true && files.some((f) => f.type === 'video')) {
      setState('notice', {
        message: '当前模型不支持视频输入',
        reason: 'model_without_video',
      })
      return
    }

    const steer = flip ? followUpMode() === 'queue' : followUpMode() === 'steer'
    stopVoiceForSubmit()
    sendMessage(v, files.length ? files : undefined, steer)
    setText('')
    setPending([])
    queueMicrotask(() => {
      ta.style.height = 'auto'
      ta.focus()
    })
  }

  return (
    <div
      class="composer-wrap"
      classList={{
        'drag-over': dragOver(),
        'panel-dock-open': panelDockVisible(),
        'panel-dock-ready': panelDockReady(),
      }}
      ref={wrap}
      onPointerEnter={revealPanelDock}
      onPointerLeave={closePanelDockSoon}
      onFocusIn={() => {
        if (!panelMaximized()) return
        setPanelDockFocused(true)
        revealPanelDock()
      }}
      onFocusOut={() => {
        queueMicrotask(() => {
          if (!panelMaximized()) {
            setPanelDockFocused(false)
            return
          }
          if (wrap?.contains(document.activeElement)) return
          setPanelDockFocused(false)
          closePanelDockSoon()
        })
      }}
    >
      {/*
       * 只在右侧面板放大时出现。外观是一根底部把手，但命中区是一个完整按钮：
       * 鼠标悬浮时直接展开，可通过键盘 Tab 聚焦，点击后焦点进入正文输入框，不另建第二套输入入口。
       */}
      <button
        class="composer-reveal"
        type="button"
        aria-label="展开输入框"
        aria-controls="conversation-composer"
        aria-expanded={panelDockVisible()}
        onClick={() => {
          revealPanelDock()
          ta.focus()
        }}
      >
        <span aria-hidden="true" />
      </button>
      {/* 运行位置与输入框共用空会话布局判定，历史加载期间不重新推断。 */}
      <Show when={props.empty}>
        <div class="run-context">
          <span class="run-context-label">运行于</span>
          {/* 只显示，不可点击：切换项目在左栏点击即可，在此再放一个入口
              会形成同一操作的第二条路径。做成 button 还意味着存在可点开的浮层，
              而该浮层已删除。 */}
          <Show when={workspace()}>
            {(w) => (
              <span class="mode-chip static" data-tip={w().root}>
                <IconFolder size={13} />
                {w().name}
              </span>
            )}
          </Show>
          {/* 分支只在确为 git 仓库时显示：非仓库时显示一个空分支，
              等于提示用户「此处应有分支名」。 */}
          <Show when={state.git?.branch}>
            <BranchPicker />
          </Show>
        </div>
      </Show>

      <RunStatus />

      <form
        id="conversation-composer"
        class="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {/* 补全菜单以输入框定位，运行位置行不参与偏移计算。 */}
        <Show when={pickerOpen()}>
          <div class="composer-pop" role="listbox" aria-label="命令与引用">
            <For each={pickerOptions()}>
              {(option, i) => {
                const icon = () =>
                  option.kind === 'command' ? option.command.icon : option.item.icon
                const name = () =>
                  option.kind === 'command' ? `/${option.command.slash}` : `@${option.item.name}`
                const displayName = () => {
                  if (option.kind === 'command') return name()
                  return `${mentionQuery(text())?.sigil ?? '@'}${option.item.name}`
                }
                const label = () =>
                  option.kind === 'command' ? option.command.label : option.item.label
                const hint = () =>
                  option.kind === 'command' ? (option.command.hint ?? '') : option.item.hint
                return (
                  <button
                    class="composer-option"
                    classList={{ active: i() === menuCursor() }}
                    type="button"
                    role="option"
                    aria-selected={i() === menuCursor()}
                    onMouseEnter={() => setMenuCursor(i())}
                    onClick={() => pickOption(option)}
                  >
                    <span class="composer-option-icon">{icon()({ size: 14 }) as never}</span>
                    <code class="composer-option-name">{displayName()}</code>
                    <span class="composer-option-label truncate">{label()}</span>
                    <Show when={hint()}>
                      <span class="composer-option-hint truncate">{hint()}</span>
                    </Show>
                  </button>
                )
              }}
            </For>
            <Show when={pickerNote()}>
              {(note) => <div class="composer-pop-state">{note()}</div>}
            </Show>
          </div>
        </Show>

        {/* Goal 与等待队列共用输入框顶部的状态栏堆叠区：目标固定在上方，队列按顺序排在下方。
            两者同时出现时也只有一个外框和一套纵向次序，不互相覆盖。 */}
        <div class="composer-rails">
          <GoalChip />
          <FollowUpCards onEdit={editFollowUp} thumbProps={thumbProps} />
        </div>

        <div class="composer-body">
          {/* 待发送附件属于本次输入，放在输入框内部，而不是另起一张外部卡片。
            图片显示可辨认的缩略图；普通文件保留文件名卡片。区域最多两行，超出后在内部滚动。 */}
          <Show when={pending().length > 0 || uploading() > 0}>
            <div class="attach-row pending">
              <For each={pending()}>
                {(a, i) => (
                  <Show
                    when={isInlineImage(a.path)}
                    fallback={
                      <span class="attach-chip file" data-tip={a.path}>
                        <AttachmentThumb
                          path={a.path}
                          name={a.name}
                          box={20}
                          {...thumbProps(a.path)}
                        />
                        <span class="truncate">{a.name}</span>
                        <button
                          class="attach-x"
                          type="button"
                          aria-label={`移除 ${a.name}`}
                          onClick={() => setPending((prev) => prev.filter((_, j) => j !== i()))}
                        >
                          <IconX size={11} />
                        </button>
                      </span>
                    }
                  >
                    <span class="attach-image" data-tip={a.path}>
                      <AttachmentThumb
                        path={a.path}
                        name={a.name}
                        box={72}
                        {...thumbProps(a.path)}
                      />
                      <button
                        class="attach-image-x"
                        type="button"
                        aria-label={`移除 ${a.name}`}
                        onClick={() => setPending((prev) => prev.filter((_, j) => j !== i()))}
                      >
                        <IconX size={10} />
                      </button>
                    </span>
                  </Show>
                )}
              </For>
              <Show when={uploading() > 0}>
                <span class="attach-chip busy">上传中 {uploading()}</span>
              </Show>
            </div>
          </Show>

          <textarea
            ref={ta}
            class="composer-input"
            rows={1}
            placeholder="随心输入，可粘贴图片"
            onPaste={(e) => {
              const files = Array.from(e.clipboardData?.files ?? [])
              if (files.length) {
                // 仅在包含文件时拦截：拦截纯文本粘贴会导致无法正常粘贴代码。
                e.preventDefault()
                void takeFiles(files)
              }
            }}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              const files = Array.from(e.dataTransfer?.files ?? [])
              if (files.length) {
                e.preventDefault()
                void takeFiles(files)
              }
            }}
            value={text()}
            onInput={(e) => {
              setText(e.currentTarget.value)
              setMenuCursor(0)
              autosize()
            }}
            onKeyDown={(e) => {
              const hits = pickerOptions()
              const open = pickerOpen()
              if (open && !e.isComposing) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  if (hits.length) setMenuCursor((c) => Math.min(c + 1, hits.length - 1))
                  return
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  if (hits.length) setMenuCursor((c) => Math.max(c - 1, 0))
                  return
                }
                if (e.key === 'Escape') {
                  e.preventDefault()
                  const mention = mentionQuery(text())
                  setText(mention ? text().slice(0, mention.start) : '')
                  setMenuCursor(0)
                  queueMicrotask(autosize)
                  return
                }
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  const option = hits[menuCursor()]
                  if (option) pickOption(option)
                  return
                }
              }
              // 放大面板中的空输入区可用 Escape 立即收起；有草稿时不得替用户隐藏。
              if (e.key === 'Escape' && panelMaximized() && !hasInput()) {
                e.preventDefault()
                clearPanelDockClose()
                setPanelDockOpen(false)
                ta.blur()
                return
              }
              // isComposing：中文/日文输入法组合期间的回车用于选词，不能作为发送。
              // Ctrl/Cmd+Enter 使用与默认档位相反的档位；会话空闲时两者等价。
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault()
                submit(e.ctrlKey || e.metaKey)
              }
            }}
          />

          <div class="composer-bar">
            {/* 一个 `+` 按钮接收所有附件，不分图片与文件两个入口：对用户而言
              「把这个文件交给模型查看」是同一件事。

              桌面端使用系统对话框：它返回绝对路径，因此该入口与拖入一样
              不传输字节。`<input type="file">` 无法取得路径，它是浏览器端唯一的入口。 */}
            <input
              ref={filePicker}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const fs = e.currentTarget.files
                if (fs) void takeFiles(fs)
                // 清空 value：同一个文件连续选择两次也必须能触发 change。
                e.currentTarget.value = ''
              }}
            />
            <button
              class="icon-btn"
              type="button"
              aria-label="添加附件"
              data-tip="添加附件，也可直接粘贴或拖入"
              onClick={() => {
                if (isDesktopShell()) {
                  void pickFiles().then(takePaths)
                  return
                }
                filePicker.click()
              }}
            >
              <IconPlus size={16} />
            </button>

            <ModeChip />

            {/* 上下文占用排在模型之前：它表示本轮剩余的上下文容量，
              用户先查看容量，再选择模型。 */}
            <ContextMeter />

            <ModelPicker />

            <span class="spacer" />

            {/* 语音输入。特性检测不通过时组件自身不渲染，见 VoiceButton。 */}
            <VoiceButton
              draft={text()}
              bindSubmitStop={(stop) => {
                stopVoiceForSubmit = stop
              }}
              onText={(next) => {
                setText(next)
                autosize()
              }}
            />

            {/* 此处不显示金额：会话流末尾的运行读数条（Transcript 的 `.run-strip`）
              已显示同一金额。同源同值显示两次，会被读成两笔费用。
              金额保留在读数条中，是因为它与「本轮的执行情况」放在一起，
              而输入区工具栏服务于下一轮。 */}

            {/* 主按钮只有一个，位置与尺寸不变，只切换图标与语义：
                空闲 → 发送（无内容时 disabled）
                运行中 + 有内容 → 发送（按档位入队或注入）
                运行中 + 无内容 → 停止

              要停止时清空输入框即可。这不构成额外负担：正在输入的用户意图是发送，
              而不是停止本轮，两种意图不会同时成立，因此不应有两个按钮
              争用同一位置。

              「有内容」的判据必须与 submit() 一致：只有附件没有文字时也可发送。
              只检查文字时，粘贴一张图片而未输入文字的用户点击发送不会有响应。 */}
            <Show
              when={isRunning() && !hasInput()}
              fallback={
                <button class="send-btn" type="submit" disabled={!hasInput()} aria-label="发送">
                  <IconSend size={16} />
                </button>
              }
            >
              <button class="send-btn" type="button" onClick={interrupt} aria-label="停止">
                <IconStop size={16} />
              </button>
            </Show>
          </div>
        </div>
      </form>
    </div>
  )
}

/** 分组行的中文名称。键与 `CONTEXT_GROUPS` 一一对应，顺序由后者决定。 */
const GROUP_LABEL: Record<ContextGroup, string> = {
  historyMessages: '历史消息',
  executionRecords: '执行记录',
  intermediateContent: '工具结果',
  systemTools: '系统工具',
  mcpTools: 'MCP工具',
  systemPrompt: '系统提示词',
  memory: '记忆内容',
  skills: '技能清单',
  summary: '会话摘要',
  workspaceState: '工作区与状态',
}

/**
 * 分段颜色。按行序取色，不按值取色：颜色需要与标签绑定，
 * 用户再次打开时同一颜色仍对应同一类目。
 */
const SEG_COLOR = [
  '#6366f1',
  '#8b5cf6',
  '#a855f7',
  '#ec4899',
  '#f43f5e',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#14b8a6',
  '#0ea5e9',
  '#cbd5e1',
]

/** 紧凑记法：823 / 19.7k / 916.3k / 1M。数字用于快速比较大小，无需精确到个位。 */
function fmtTok(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function fmtLimit(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 1_000_000)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/**
 * 占用环。
 *
 * 数字用于读取数值，环用于快速判断占用程度，这是它与「5.2%」的分工。
 *
 * 两处细节由具体图形决定：
 * - **端点使用平头（默认 butt），不使用 round。** 圆头端点在 0% 时会绘制出一个小圆点，
 *   而新会话恒为 0%，该圆点看起来像已经占用了一小段。
 * - **从 -90° 开始绘制**，自十二点方向顺时针。不旋转时 SVG 从三点方向开始，
 *   低占用时那一小段位于右侧中部，无法看出是「刚开始」。
 */
function ContextRing(props: { percent: number }) {
  const CIRC = 2 * Math.PI * 6
  const offset = () => CIRC * (1 - Math.min(100, Math.max(0, props.percent)) / 100)
  return (
    <svg class="ctx-ring" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
      <circle class="ctx-ring-track" cx="8" cy="8" r="6" fill="none" stroke-width="3.2" />
      <circle
        class="ctx-ring-fill"
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke-width="3.2"
        stroke-dasharray={String(CIRC)}
        stroke-dashoffset={String(offset())}
        transform="rotate(-90 8 8)"
      />
    </svg>
  )
}

/**
 * 上下文占用。
 *
 * 点开后查看占用的构成：单独的「87%」无法据以操作，用户无法判断应压缩、
 * 删除记忆，还是更换上下文窗口更大的模型。
 *
 * **行集与行序固定，零值也显示：不得 `filter(n > 0)`，也不得按值排序。** 若行随值出现、消失或换
 * 位置，用户每次打开都需要重新查找关注的行；行数一变，浮层高度也随之变化（违反 B9）。
 * 按 `CONTEXT_GROUPS` 定序，十行始终存在，末尾固定为剩余空间。
 *
 * **「省略上下文」只在确实有省略时出现。** 它回答「哪些内容被移除」。压缩之前恒为 0，此时整段不渲染：
 * 恒为零的区块是噪声，而不是信息。
 */
function ContextMeter() {
  const [open, setOpen] = createSignal(false)

  /*
   * 点击外部时关闭。判据使用 `.ctx-wrap`（含按钮）而不是 `.ctx-pop`：`pointerdown` 先于
   * `click` 触发，若只判断浮层，点击按钮会先关闭一次，按钮自身的 click 又将其打开，浮层无法关闭。
   */
  createEffect(() => {
    if (!open()) return
    const onDown = (e: Event) => {
      if (!(e.target as HTMLElement | null)?.closest?.('.ctx-wrap')) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    onCleanup(() => {
      window.removeEventListener('pointerdown', onDown)
    })
  })

  const rows = () => {
    const c = state.context
    if (!c) return []
    const list = CONTEXT_GROUPS.map((key, i) => ({
      key: key as string,
      label: GROUP_LABEL[key],
      tokens: c.breakdown[key],
      color: SEG_COLOR[i] ?? '#cbd5e1',
    }))
    list.push({
      key: 'freeSpace',
      label: '剩余空间',
      tokens: Math.max(0, c.limit - c.tokens),
      color: SEG_COLOR[SEG_COLOR.length - 1]!,
    })
    return list
  }

  const omittedRows = () => {
    const o = state.context?.omitted
    if (!o) return []
    return [
      { key: 'historyOriginal', label: '历史消息原文', tokens: o.historyOriginal },
      { key: 'intermediateOriginal', label: '工具结果原文', tokens: o.intermediateOriginal },
    ].filter((r) => r.tokens > 0)
  }

  return (
    <Show when={state.context}>
      {(c) => (
        <span class="ctx-wrap">
          <button
            class="ctx-meter"
            classList={{ warn: c().percent > 75 }}
            type="button"
            aria-expanded={open()}
            data-tip={`${c().tokens.toLocaleString()} / ${c().limit.toLocaleString()} tokens`}
            onClick={() => setOpen((v) => !v)}
          >
            <ContextRing percent={c().percent} />
            <span class="ctx-meter-num">{c().unmeasuredVideos ? '未知' : `${c().percent}%`}</span>
          </button>
          <Show when={open()}>
            <div class="ctx-pop" role="dialog" aria-label="上下文占用明细">
              <div class="ctx-head">
                <span>
                  上下文
                  {c().unmeasuredVideos
                    ? '（视频未计入）'
                    : c().source === 'estimated'
                      ? '（估算）'
                      : c().source === 'projected'
                        ? '（含估算）'
                        : ''}
                </span>
                <span class="ctx-head-nums">
                  {fmtTok(c().tokens)} / {fmtLimit(c().limit)}
                </span>
              </div>
              <div class="ctx-stack" role="img" aria-label="上下文占用占比条">
                <For each={rows()}>
                  {(r) => (
                    <Show when={r.tokens > 0}>
                      <span
                        class="ctx-stack-seg"
                        style={{
                          width: `${Math.min(100, (r.tokens / Math.max(1, c().limit)) * 100)}%`,
                          background: r.color,
                        }}
                      />
                    </Show>
                  )}
                </For>
              </div>
              <ul class="ctx-rows">
                <For each={rows()}>
                  {(r) => (
                    <li class="ctx-row">
                      <span class="ctx-dot" style={{ background: r.color }} />
                      <span class="ctx-name">{r.label}</span>
                      <span class="ctx-num">{fmtTok(r.tokens)}</span>
                      <span class="ctx-pct">
                        {((r.tokens / Math.max(1, c().limit)) * 100).toFixed(1)}%
                      </span>
                    </li>
                  )}
                </For>
              </ul>
              <Show when={omittedRows().length > 0}>
                <div class="ctx-omitted">
                  <div class="ctx-subtitle">省略上下文</div>
                  <ul class="ctx-rows">
                    <For each={omittedRows()}>
                      {(r) => (
                        <li class="ctx-row">
                          <span class="ctx-dot ctx-dot-hollow" />
                          <span class="ctx-name">{r.label}</span>
                          <span class="ctx-num">{fmtTok(r.tokens)}</span>
                          <span class="ctx-pct">
                            {((r.tokens / Math.max(1, c().limit)) * 100).toFixed(1)}%
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </div>
              </Show>
            </div>
          </Show>
        </span>
      )}
    </Show>
  )
}
