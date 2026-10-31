import type { Attachment, FollowUp } from '@qywork/core'
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from 'solid-js'
import { buildCommands, type Command, matchSlash } from '../lib/commands.ts'
import { matchesMention, mentionQuery, replaceMention } from '../lib/composer-suggestions.ts'
import { sessionSignal } from '../lib/session.ts'
import { slashDispatch } from '../lib/slash.ts'
import {
  activeModel,
  activeModelRow,
  composerSeed,
  dropFollowUp,
  extensionsRevision,
  followUpMode,
  interrupt,
  isDesktopShell,
  isRunning,
  loadSkills,
  loadTeam,
  loadTeamClis,
  loadTools,
  modelCatalog,
  panelMaximized,
  registerDropSink,
  sendMessage,
  setComposerSeed,
  setState,
  state,
  workspace,
} from '../lib/store/index.ts'
import { BranchPicker } from './BranchPicker.tsx'
import { AttachButton, createAttachmentIntake, PendingAttachments } from './ComposerAttachments.tsx'
import { ContextMeter } from './ContextMeter.tsx'
import { FollowUpCards } from './FollowUpCards.tsx'
import { GoalChip } from './GoalChip.tsx'
import { IconFolder, IconSend, IconSkillSolid, IconStop } from './Icons.tsx'
import { ModeChip } from './ModeChip.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import {
  cliOption,
  type MentionOption,
  roleOption,
  scopeLabel,
  toolOption,
} from './mention-options.ts'
import { RunStatus } from './RunStatus.tsx'
import { VoiceButton } from './VoiceButton.tsx'

type PickerOption = { kind: 'command'; command: Command } | { kind: 'mention'; item: MentionOption }

type ComposerDraft = { text: string; attachments: Attachment[] }

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
  // 草稿按会话保存并在刷新后恢复；异步附件完成后仍写入发起时的会话。
  const [drafts, setDrafts] = sessionSignal<Record<string, ComposerDraft>>('qywork.drafts', {})
  const text = () => drafts()[state.activeConversation ?? '']?.text ?? ''
  const pending = () => drafts()[state.activeConversation ?? '']?.attachments ?? []
  const updateDraft = (
    conversationId: string | null,
    change: (draft: ComposerDraft) => ComposerDraft,
  ) => {
    if (!conversationId) return
    setDrafts((all) => ({
      ...all,
      [conversationId]: change(all[conversationId] ?? { text: '', attachments: [] }),
    }))
  }
  const setText = (next: string | ((current: string) => string)) => {
    updateDraft(state.activeConversation, (draft) => ({
      ...draft,
      text: typeof next === 'function' ? next(draft.text) : next,
    }))
  }
  const setPending = (
    next: Attachment[] | ((current: Attachment[]) => Attachment[]),
    conversationId = state.activeConversation,
  ) => {
    updateDraft(conversationId, (draft) => ({
      ...draft,
      attachments: typeof next === 'function' ? next(draft.attachments) : next,
    }))
  }
  const [menuCursor, setMenuCursor] = createSignal(0)
  const { uploading, thumbProps, takePaths, takeFiles } = createAttachmentIntake(setPending)
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
  /** 输入框中是否有可发送的内容。主按钮的四种状态与 `submit()` 共用此判据。 */
  const hasInput = () => text().trim().length > 0 || pending().length > 0
  /**
   * 面板放大时输入区默认收起，但不能收起正在编辑的草稿。
   * 上传中的附件也算作草稿：它尚未进入 `pending`，此时收起会使上传看起来已丢失。
   */
  const panelDockPinned = () => hasInput() || uploading() > 0 || dragOver()
  const panelDockVisible = () =>
    panelMaximized() && (panelDockOpen() || panelDockFocused() || panelDockPinned())
  let ta!: HTMLTextAreaElement
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
      paths: (paths) => takePaths(paths),
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
  createEffect(
    on(
      () => state.activeConversation,
      () => {
        setMenuCursor(0)
        setDragOver(false)
        autosize()
      },
    ),
  )

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
     * 图片能力未知时沿用现有的试发送语义。模型不接受原生视频时，后端把视频替换为一行说明，
     * 由模型调用 `read_file` 抽取关键帧读取（`agent` 的 `materialize`），因此只在模型连图片也不接受时拦截视频。
     * 能力不符时保留草稿与附件，由用户更换模型或移除媒体。
     */
    const row = activeModelRow()
    if (row?.vision === false && files.some((f) => f.type === 'image')) {
      setState('notice', {
        message: '当前模型不支持图片输入，请移除图片后再发送',
        reason: 'model_without_vision',
      })
      return
    }
    if (row?.vision === false && row.video !== true && files.some((f) => f.type === 'video')) {
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
          <PendingAttachments
            pending={pending()}
            uploading={uploading()}
            thumbProps={thumbProps}
            setPending={setPending}
          />

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
            <AttachButton takePaths={takePaths} takeFiles={takeFiles} />

            <ModeChip />

            {/* 上下文占用排在模型之前：它表示本轮剩余的上下文容量，
              用户先查看容量，再选择模型。 */}
            <ContextMeter />

            <ModelPicker />

            <span class="spacer" />

            {/* 语音输入。特性检测不通过时组件自身不渲染，见 VoiceButton。 */}
            <Show when={state.activeConversation} keyed>
              {(conversationId) => (
                <VoiceButton
                  draft={drafts()[conversationId]?.text ?? ''}
                  bindSubmitStop={(stop) => {
                    stopVoiceForSubmit = stop
                  }}
                  onText={(next) => {
                    updateDraft(conversationId, (draft) => ({ ...draft, text: next }))
                    autosize()
                  }}
                />
              )}
            </Show>

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
