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
  activeModelRow,
  type CliAgentRow,
  composerSeed,
  dropFollowUp,
  followUpMode,
  interrupt,
  isDesktopShell,
  isRunning,
  loadSkills,
  loadTeam,
  loadTeamClis,
  loadTools,
  panelMaximized,
  pickFiles,
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
  tauriListen,
  transcript,
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
 * 位置在输入区而不是设置里：它决定的是**下一轮**放行到哪一档，
 * 和「用哪个模型」是同一层的决定，随时要改。塞进设置意味着改一次要点四下，
 * 而且和模型选择器分处两地——同一个决定被拆成两个地方做。
 *
 * 只有两种模式，所以是一个开关而不是下拉。文案用「自动审批 / 完全访问」，
 * 不用配置里的 `auto` / `full`——后者是文件里的字面量，不是给人读的。
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
      // 握手只在连接时报一次模式，这里就地跟上；否则点完按钮不变，像是没生效。
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
        full() ? '不裁决，路径边界一并放开；凭证剥离仍在' : '只放行确定安全的命令，其余直接拒绝'
      }
      onClick={() => void toggle()}
    >
      <IconShield size={13} />
      {full() ? '完全访问' : '自动审批'}
    </button>
  )
}

/**
 * 停在这里的说法。**每一种状态都要有话说**，尤其两种：
 *
 * - `blocked` 必须把理由原样端出来。后端强制每一次 blocked 都带理由
 *   （`run-control.ts` 的 `STOP_NOTE`、撞上轮数上限那条），界面不显示的话，
 *   循环已经停下，而用户只看见「受阻」两个字。
 * - `active` 却没有一轮在跑，说的是「续行没开着」。**续起标记不落盘**
 *   （`server/runs.ts` 的 `GoalArm`：落盘的话一个失控后崩溃的循环会在下次
 *   启动时自己复活），所以进程重启、会话恢复之后目标还在账本里躺着，但不会
 *   自己再起一轮。这句话不说清楚，界面上就是「目标还在、什么都没发生」。
 */
function goalNote(goal: Goal, running: boolean): string {
  if (goal.status === 'blocked') return `受阻：${goal.blockedReason ?? '没给理由'}`
  if (goal.status === 'paused') return '已暂停'
  return running ? '自动续行中' : '没在自动跑，点继续接上'
}

/**
 * 当前目标：做的是什么、在不在跑、能不能停。
 *
 * **自动循环必须可见**：它一轮接一轮自己跑下去，而界面上只有正文在长。
 * 所以它常驻在输入框顶部，和等待队列共用同一组状态栏：目标回答「一轮接一轮
 * 要做到什么」，待办回答「这一轮进行到哪了」，用户抬眼就该同时看到这两句。
 *
 * **两个按钮各走哪条路**：
 * - **停止 = 中断这一轮**（`interrupt`）。run 收尾时服务端把目标置回 `paused`
 *   并解除续起标记，所以停这一轮就是停这个循环。**不另开一条「暂停目标」指令**：
 *   同一件事的第二个入口，两条路迟早对「当前有没有停」给出两种答案。
 * - **继续 = `goal.resume`**（`resumeGoal`）。它不只是把状态改回 `active`，
 *   是重新启用续行本身，并当场发起一轮。
 *
 * **做完就不显示了。** 它回答的是「还在跑吗」，`completed` 之后没有「还在」。而 `completed` 是终
 * 态，一条出边都没有——留一颗点了必然被服务端回绝的「继续」按钮，比不留更坏。
 *
 * **不显示轮数。** 这个循环没有轮数上限（见 `core` 里 `Goal` 的注释），所以没有「第几 / 共几」
 * 可显示。**也不显示已经跑了几轮**：那个数不影响用户的任何决定，摆出来只会把
 * 「做到没有」换成「跑了多久」——而循环该不该停，答案在目标本身，不在计数器。
 * 用户要的两件事这一行都有：它在不在跑，以及怎么让它停。
 *
 * **一行，且比输入框窄。** 挤不下的先截目标正文，再截状态，两处都有 title。高度是定死的（B9）——
 * 状态文字长短不一，让它撑高的话「停止」会跑位。
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
            {/* 正文长就截断 + title，不做悬停卡片：那张卡片承载的信息这一行本来
                就有，唯一的效果是鼠标划过时遮住下面那一行。 */}
            <span class="goal-text truncate" data-tip={g().objective}>
              {g().objective}
            </span>
            {/* 状态紧挨着「停止」：用户读到「在跑」的下一眼就该是让它停的那颗按钮。 */}
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
 * 桌面外壳的拖放接线。
 *
 * **HTML5 的 `ondrop` 在桌面端不触发**：Tauri 的 `drag_drop_handler_enabled`
 * 默认为真，OS 拖放被外壳截获。这不是障碍——被截获之后外壳 emit 的载荷里是
 * **绝对路径**，而 HTML5 那条永远只能给到 `File`，拿不到路径。
 *
 * 注册在模块级且只做一次：`tauriListen` 刻意不提供退订（见它的注释），
 * 挂进组件的话每次重挂载都会多一份永远摘不掉的监听。挂载点通过 `dropSink`
 * 换手，卸载时置空——事件照收，只是没有去处。
 *
 * 落点要做命中测试：这是**全窗**事件，拖到会话流上松手不该变成附件。
 */
type DropSink = {
  hit: (pos: { x: number; y: number }) => boolean
  over: (v: boolean) => void
  paths: (p: string[]) => void
}
let dropSink: DropSink | null = null
let dropWired = false

function wireShellDrop(): void {
  if (dropWired) return
  dropWired = true
  type DropPayload = { paths?: string[]; position?: { x: number; y: number } }
  void tauriListen<DropPayload>('tauri://drag-over', (pl) => {
    dropSink?.over(!!pl.position && dropSink.hit(pl.position))
  })
  void tauriListen<DropPayload>('tauri://drag-leave', () => dropSink?.over(false))
  void tauriListen<DropPayload>('tauri://drag-drop', (pl) => {
    dropSink?.over(false)
    if (!pl.position || !dropSink?.hit(pl.position)) return
    dropSink.paths(pl.paths ?? [])
  })
}

/**
 * 排着的跟进消息，作为输入框顶部的队列栏；它和正文、附件共用同一个输入框外壳。
 *
 * 卡上三个可点物：
 *
 * - **档位词** —— 按钮上写的是**点它会做什么**，不是这一条此刻的档位。
 *   排着队的显示「调整方向」，点了就注入当前这一轮，字随之换成「加入队列」，
 *   再点退回队列。会话空闲时队列里没有可注入的那一轮，字是「发送」，点了当场
 *   起一轮——三态同一种读法。不要改成显示当前档位：那样这一枚按钮上「发送」是
 *   动作、另两个词是状态，同一个位置两种读法。
 *   档位由服务端在同一个同步块里裁决，这里只负责显示。
 * - **修改** —— 从队列删除原条目，把正文和附件交回输入框；修改后走原发送入口。
 * - **删除** —— 删了就既不注入也不火发。
 *
 * **一行，定高（B9）**：正文长短不一，让它撑高的话删除按钮会跟着跑位。
 * 不做悬停卡片：那张卡承载的信息这一行本来就有。
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
                  {!isRunning() ? '发送' : f.steer ? '加入队列' : '调整方向'}
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
 * 三条交互决定：
 * - Enter 发送、Shift+Enter 换行。中文输入法组合期间（isComposing）必须放行，
 *   否则用拼音选词时按回车会把半截拼音发出去。
 * - 会话在跑时照样发得出去：这一条排进队列，去向由默认档决定，
 *   `Ctrl+Enter` 对单条走相反那一档。默认档在设置页，不常驻这里。
 * - 自适应高度，封顶后转内部滚动，不把会话区挤没。
 */
export function Composer() {
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
   * 粘贴进来的那一份的本地预览地址，按落盘路径存。
   *
   * 只增不减：一次会话里粘几张图是有限的，而按 chip 的生命周期撤销会与
   * 「发送后 Transcript 仍要显示」冲突。
   */
  const localThumbs = new Map<string, string>()
  /** 输入框里有没有可发的内容。主按钮的四态与 `submit()` 共用这一条判据。 */
  const hasInput = () => text().trim().length > 0 || pending().length > 0
  /**
   * 面板放大时输入区默认收起，但不能把正在编辑的草稿从用户眼前拿走。
   * 上传中的附件也算草稿：它还没变成 `pending`，此时收起会像是上传被吞了。
   */
  const panelDockPinned = () => hasInput() || uploading() > 0 || dragOver()
  const panelDockVisible = () =>
    panelMaximized() && (panelDockOpen() || panelDockFocused() || panelDockPinned())
  /** 有本地预览就带上，没有就整个键不出现——`exactOptionalPropertyTypes` 不收 undefined。 */
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
   * 悬浮展开要即时，收起要留出从底部触发条移到输入框的时间。
   * 160ms 足够跨过两者间的小缝，同时避免鼠标已经离开后浮层仍明显滞留。
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
   * 候选按项目失效。Composer 本身切项目时不会重挂，如果把第一次加载的结果一直
   * 留着，`#` / `@` 会显示上一个项目的技能、角色与 MCP。异步请求也绑定发起时的
   * workspace id；切换途中回来的旧结果直接丢弃。
   */
  let suggestionWorkspace: string | null | undefined
  createEffect(() => {
    const next = workspace()?.id ?? null
    if (next === suggestionWorkspace) return
    suggestionWorkspace = next
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
    setSkillLoad('loading')
    setSkillLoadNote(null)
    try {
      const loaded = await loadSkills()
      if ((workspace()?.id ?? null) !== owner) return
      setSkillOptions(
        loaded.skills
          // 与运行时 `scanSkills` 的生效集合一致；被高优先级同名技能盖住的不冒充可选。
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
      if ((workspace()?.id ?? null) !== owner) return
      setSkillLoad('error')
      setSkillLoadNote(`技能读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const ensureTargets = async () => {
    if (targetLoad() !== 'idle') return
    const owner = workspace()?.id ?? null
    setTargetLoad('loading')
    setTargetLoadNote(null)

    /*
     * 三个来源互不拖累：本机外部 CLI 探测失败，不应让已经连好的 MCP 与项目角色
     * 一起消失。失败项就近报在面板末尾，成功项仍可选。
     */
    const [toolsResult, teamResult, cliResult] = await Promise.allSettled([
      loadTools(),
      loadTeam(),
      loadTeamClis(),
    ])
    if ((workspace()?.id ?? null) !== owner) return

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

  createEffect(() => {
    const query = mentionQuery(text())
    if (query?.kind === 'skill') void ensureSkills()
    if (query?.kind === 'target') void ensureTargets()
  })

  /*
   * 收下设置页递过来的起手指令。
   *
   * **收下就把信号清空**：它是一次性投递，留着的话下一次投同一句话时信号没变化，
   * effect 不会再跑，按钮看起来就是点了没反应。
   *
   * **不覆盖已经敲了一半的内容**：接在后面，中间空一行。用户正打字时被清空，
   * 丢掉的是他自己写的那段草稿。
   */
  createEffect(() => {
    const seed = composerSeed()
    if (seed === null) return
    setComposerSeed(null)
    setText((cur) => (cur.trim() ? `${cur.trimEnd()}\n\n${seed}` : seed))
    ta.focus()
    // 光标落到末尾：用户要接着往下写，不是从头改。
    queueMicrotask(() => ta.setSelectionRange(ta.value.length, ta.value.length))
  })

  /**
   * 拿得到源路径的那条入口：桌面端拖入、原生选择器。
   *
   * **纯前端，一个请求都不打。** 文件已经在磁盘上了，没有任何字节需要搬——
   * 这就是「不二次存储」的全部实现。
   *
   * `size` 填 0：这里拿不到字节数，而这一格没有消费者（约定写在 `Attachment` 上）。
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
   * 拿不到源路径的那条：剪贴板里只有位图，或者浏览器不给绝对路径。
   *
   * 这一份字节除了内存里没有第二处，所以落盘是**第一次**存储不是第二次。
   * 落点是 `~/.qywork/attachments/<会话id>/`，删会话时整个目录一起走。
   *
   * 失败**逐个报**并继续处理其余的：一张图太大不该让另外三张也白选。
   */
  const takeFiles = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    const conversationId = state.activeConversation
    // 没有会话就没有归属，和「发送」同一个判据（`sendMessage` 也在这里早退）。
    if (!conversationId) return
    setUploading((n) => n + list.length)
    for (const f of list) {
      try {
        const a = await uploadAttachment(f, conversationId)
        // 粘贴的那一份手里就有字节，缩略图直接用它，省掉一次回读。
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
   * 把这个组件登记成拖放的落点：命中测试按输入区的矩形，路径交给 `takePaths`。
   * 机制与为什么不用 HTML5 `ondrop`，见 `DropSink` 的注释。
   *
   * 只在挂载时注册一次：`tauriListen` 不提供退订，而这个组件是常驻单挂载。
   */
  onMount(() => {
    if (!isDesktopShell()) return
    dropSink = {
      hit: (pos) => {
        const r = wrap?.getBoundingClientRect()
        return !!r && pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom
      },
      over: setDragOver,
      paths: takePaths,
    }
    wireShellDrop()
    onCleanup(() => {
      dropSink = null
    })
  })

  /**
   * 斜杠命令。
   *
   * 只在**整段草稿就是一个 `/xxx`** 时才弹（见 `matchSlash`）——正文里的路径
   * `src/lib` 或代码里的除号不该把面板弹出来。
   */
  const slashHits = () => matchSlash(text())
  const executeSlash = (cmd: Command, arg?: string) => {
    // 先清草稿再执行：命令可能会开浮层或换会话，那之后 setText 未必还落在这个组件上。
    setText('')
    queueMicrotask(() => {
      ta.style.height = 'auto'
      cmd.run(arg)
    })
  }
  const runSlash = (cmd: Command) => {
    // 要跟一段话的命令（`/goal`）在面板里选中**不执行**，只把命令名填进草稿——
    // 这时候用户还没说要做什么，跑起来只能跑一个空目标。
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

  /** `/`、`#`、`@` 共用一张弹层与一套键盘游标，任何时刻只有当前词对应的一类。 */
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
   * 把一条等待消息取回输入框。队列仍通过服务端原有的删除指令收敛，输入正文与附件
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
   * 发出去。`flip` = 这一条走与默认档相反的那一档（`Ctrl+Enter`）。
   *
   * **不再因为「正在跑」早退**：跑着的时候发消息是排队，不是被拒。
   */
  const submit = (flip = false) => {
    const v = text().trim()
    const files = pending()
    // 只有附件没有文字也能发——「看这张图」这种意图不该逼用户再打几个字。
    if (!v && files.length === 0) return

    /*
     * 所有提交方式都在这里认命令。此前只截带参数的 `/goal`，因此点击发送按钮提交
     * `/compact`、`/new` 会被当成普通消息；键盘补全面板却能执行，因此同一行字有两种语义。
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
     * 图片能力未知时沿用现有试发语义；视频只有模型与协议均明确支持时才允许发送。
     * 能力不符时保留草稿与附件，由用户换模型或移除媒体。
     */
    if (activeModelRow()?.vision === false && files.some((f) => f.type === 'image')) {
      setState('notice', {
        message: '当前模型不属于多模态，请取消图片发送',
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
       * 只在右侧面板放大时出现。视觉是一根底部把手，但命中区是一颗完整按钮：
       * 鼠标悬浮直接展开，键盘 Tab 能到，点击后焦点落进正文输入，不制造第二套输入入口。
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
      {/* 空会话时的「这一轮会跑在哪」。**不写标语**——一句口号不携带任何信息，
          而 B7 的判据是「删掉这句用户还能不能用」。留下的 chip 每一个都在
          回答一个真问题，而且每一个都点得动。

          **审批模式不在这里。** 它就在下面那条工具栏上常驻，而且是同一个
          `<ModeChip>`——同一个开关在同一屏出现两次，用户得先判断这两个是不是
          一回事。工作区和分支不同：工具栏上没有它们。 */}
      <Show when={transcript().length === 0}>
        <div class="run-context">
          <span class="run-context-label">运行于</span>
          {/* 只显示，不可点：换项目在左栏点一下就是了，这里再放一个入口
              就是同一个动作的第二条路。做成 button 还会承诺一个可点开的浮层，
              而那个浮层已经删了。 */}
          <Show when={workspace()}>
            {(w) => (
              <span class="mode-chip static" data-tip={w().root}>
                <IconFolder size={13} />
                {w().name}
              </span>
            )}
          </Show>
          {/* 分支只在真是 git 仓库时出现——不是仓库的时候显示一个空分支
              等于告诉用户「这里本该有一个分支名」。 */}
          <Show when={state.git?.branch}>
            <BranchPicker />
          </Show>
        </div>
      </Show>

      <RunStatus />

      {/* 输入补全向上开：输入区贴着窗口底部。命令、技能与调用目标共用一套尺寸和键盘行为。 */}
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

      <form
        id="conversation-composer"
        class="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {/* Goal 与等待队列共用输入框顶部的状态栏栈：目标固定在上，队列按顺序在下。
            两者同时出现也只有一个外框、一套纵向次序，不互相覆盖。 */}
        <div class="composer-rails">
          <GoalChip />
          <FollowUpCards onEdit={editFollowUp} thumbProps={thumbProps} />
        </div>

        <div class="composer-body">
          {/* 待发附件属于这次输入，挂在输入框内部而不是另起一张外部卡片。
            图片显示可辨认的缩略图；普通文件保留文件名卡。区域最多两行，超出后内部滚动。 */}
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
                // 有文件才拦：拦掉纯文本粘贴会让人没法正常贴代码。
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
              // 放大面板里的空输入区可用 Escape 当场收回；有草稿时绝不替用户藏。
              if (e.key === 'Escape' && panelMaximized() && !hasInput()) {
                e.preventDefault()
                clearPanelDockClose()
                setPanelDockOpen(false)
                ta.blur()
                return
              }
              // isComposing：中文/日文输入法组合期的回车属于选词，不能当发送。
              // Ctrl/Cmd+Enter 走与默认档相反的那一档；会话空闲时两者等价。
              if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
                e.preventDefault()
                submit(e.ctrlKey || e.metaKey)
              }
            }}
          />

          <div class="composer-bar">
            {/* 一个 `+` 收所有附件，不做图片/文件两个入口——对用户来说
              「把这个文件给它看」是同一件事。

              桌面端走系统对话框：它给的是**绝对路径**，因此这条入口和拖入一样
              不搬字节。`<input type="file">` 拿不到路径，那是浏览器端唯一的路。 */}
            <input
              ref={filePicker}
              type="file"
              multiple
              style={{ display: 'none' }}
              onChange={(e) => {
                const fs = e.currentTarget.files
                if (fs) void takeFiles(fs)
                // 清空 value：同一个文件连选两次也要能触发 change。
                e.currentTarget.value = ''
              }}
            />
            <button
              class="icon-btn"
              type="button"
              aria-label="添加附件"
              data-tip="添加附件（也可直接粘贴或拖入）"
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

            {/* 上下文占用排在模型前面：它是「这一轮还装得下多少」，
              而模型是「拿什么去装」——先看容量再挑模型。 */}
            <ContextMeter />

            <ModelPicker />

            <span class="spacer" />

            {/* 语音输入。特性检测不通过时它自己不渲染，见 VoiceButton。 */}
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

            {/* 这里不放金额：会话流末尾那条运行读数（Transcript 的 `.run-strip`）
              已经在显示同一笔钱。同源同值显示两遍，读起来是两笔账。
              留在那边是因为它和「这一轮跑成什么样」在一起，
              而输入区的工具栏是给下一轮用的。 */}

            {/* 主按钮**只有一枚**，位置与尺寸不变，只换图标与语义：
                空闲 → 发送（没内容时 disabled）
                运行中 + 有内容 → 发送（按档位入队或注入）
                运行中 + 没内容 → 停止

              想停止就把输入框清空。这不是代价：正在打字的人要的是发出去，
              不是停下这一轮，两个意图不在同一时刻成立，所以不该有两枚按钮在这里
              争同一个位置。

              「有内容」的判据必须和 submit() 一致：只有附件没有文字也能发。
              只看文字的话，粘一张图不打字的用户点发送没反应。 */}
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

/** 分组行的中文名。键与 `CONTEXT_GROUPS` 一一对应，顺序由后者决定。 */
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
 * 段色。**按行序取，不按值取**——颜色要和标签绑定，
 * 这样用户第二次打开时「那条紫的」还是同一个类目。
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

/** 紧凑记法：823 / 19.7k / 916.3k / 1M。数字要能一眼比大小，不是要精确到个位。 */
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
 * 数字要读，环不用读——扫一眼就知道满没满，这是它和「5.2%」的分工。
 *
 * 两处细节是被具体形状逼出来的：
 * - **端点用平头（默认 butt），不用 round。** 圆头端点在 0% 时会自己画出一个小圆点，
 *   而新会话恒为 0%——那个点看起来像已经占了一小段。
 * - **-90° 起画**，从十二点走顺时针。不转的话 SVG 从三点开始，
 *   低占用时那一小段挂在右侧腰上，看不出是「刚开始」。
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
 * 点开看**被谁占的**——一个孤零零的「87%」不可操作：用户既不知道该压缩、
 * 该删记忆、还是该换个窗口更大的模型。
 *
 * **行集与行序是固定的，零值也显示：不许 `filter(n > 0)`，也不许按值排序。**行会随值出现、消失、换
 * 位置，用户每次打开都得重新扫一遍才能找到关心的那一行；而行数一变，浮层高度跟着跳（B9 明令禁
 * 止）。按 `CONTEXT_GROUPS` 定序，十行恒在，末尾固定是剩余空间。
 *
 * **「省略上下文」只在真的省略了才出现。** 它回答「什么被拿掉了」。压缩之前恒为 0，此时整段不渲染
 * —— 一个恒零的区块是噪声，而不是信息。
 */
function ContextMeter() {
  const [open, setOpen] = createSignal(false)

  /*
   * 点在外面就关。判据取 `.ctx-wrap`（含按钮）而不是 `.ctx-pop`：`pointerdown` 排在
   * `click` 前面，只圈浮层的话点按钮会先关一次、它自己的 click 又切回开，永远关不掉。
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
            <span class="ctx-meter-num">{c().percent}%</span>
          </button>
          <Show when={open()}>
            <div class="ctx-pop" role="dialog" aria-label="上下文占用明细">
              <div class="ctx-head">
                <span>上下文</span>
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
