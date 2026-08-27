import type { Attachment, ContextGroup, Goal } from '@qywork/core'
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
import { slashCall } from '../lib/slash.ts'
import {
  composerSeed,
  dropFollowUp,
  followUpMode,
  interrupt,
  isDesktopShell,
  isRunning,
  pickFiles,
  resumeGoal,
  sendMessage,
  setComposerSeed,
  setPermissionMode,
  setState,
  state,
  steerFollowUp,
  tauriListen,
  transcript,
  uploadAttachment,
  workspace,
} from '../lib/store/index.ts'
import { AttachmentThumb } from './AttachmentThumb.tsx'
import { BranchPicker } from './BranchPicker.tsx'
import { IconFolder, IconPlus, IconSend, IconShield, IconStop, IconX } from './Icons.tsx'
import { ModelPicker } from './ModelPicker.tsx'
import { RunStatus } from './RunStatus.tsx'
import { VoiceButton } from './VoiceButton.tsx'

/**
 * 权限模式。
 *
 * 位置在输入区而不是设置里：它决定的是**下一轮**能不能不问就动手，
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
        full() ? '完全访问：不再逐条询问；凭证与 .qy/ 的硬边界仍然生效' : '自动审批：拿不准的会问你'
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
 * 所以它常驻在输入框正上方，和这一轮的待办进度同一片区域：目标回答「一轮接一轮
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
 * 排着的跟进消息，一条一张卡，在输入框上方。
 *
 * 卡上两个可点物，不多也不少：
 *
 * - **档位词** —— 按钮上写的是**点它会做什么**，不是这一条此刻的档位。
 *   排着队的显示「调整方向」，点了就注入当前这一轮，字随之换成「加入队列」，
 *   再点退回队列。会话空闲时队列里没有可注入的那一轮，字是「发送」，点了当场
 *   起一轮——三态同一种读法。不要改成显示当前档位：那样这一枚按钮上「发送」是
 *   动作、另两个词是状态，同一个位置两种读法。
 *   档位由服务端在同一个同步块里裁决，这里只负责显示。
 * - **删除** —— 删了就既不注入也不火发。
 *
 * **一行，定高（B9）**：正文长短不一，让它撑高的话删除按钮会跟着跑位。
 * 不做悬停卡片：那张卡承载的信息这一行本来就有。
 */
function FollowUpCards() {
  return (
    <Show when={state.followUps.length > 0}>
      <div class="followup-cards">
        <For each={state.followUps}>
          {(f) => (
            <div class="followup-card">
              <span class="followup-text truncate" data-tip={f.content}>
                {f.content}
              </span>
              <button
                class="followup-act"
                type="button"
                onClick={() => steerFollowUp(f.id, !f.steer)}
              >
                {!isRunning() ? '发送' : f.steer ? '加入队列' : '调整方向'}
              </button>
              <button
                class="followup-act drop"
                type="button"
                aria-label="删除"
                onClick={() => dropFollowUp(f.id)}
              >
                <IconX size={12} />
              </button>
            </div>
          )}
        </For>
      </div>
    </Show>
  )
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
  const [slashCursor, setSlashCursor] = createSignal(0)
  const [pending, setPending] = createSignal<Attachment[]>([])
  const [uploading, setUploading] = createSignal(0)
  const [dragOver, setDragOver] = createSignal(false)
  /**
   * 粘贴进来的那一份的本地预览地址，按落盘路径存。
   *
   * 只增不减：一次会话里粘几张图是有限的，而按 chip 的生命周期撤销会与
   * 「发送后 Transcript 仍要显示」冲突。
   */
  const localThumbs = new Map<string, string>()
  /** 输入框里有没有可发的内容。主按钮的四态与 `submit()` 共用这一条判据。 */
  const hasInput = () => text().trim().length > 0 || pending().length > 0
  /** 有本地预览就带上，没有就整个键不出现——`exactOptionalPropertyTypes` 不收 undefined。 */
  const thumbProps = (path: string): { localUrl?: string } => {
    const u = localThumbs.get(path)
    return u ? { localUrl: u } : {}
  }
  let ta!: HTMLTextAreaElement
  let filePicker!: HTMLInputElement
  let wrap: HTMLDivElement | undefined

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
   *
   * 命令表和 Ctrl-K 那个面板**是同一份**（`lib/commands.ts`）。两份清单
   * 必然漂移成「Ctrl-K 搜得到、打 / 搜不到」，而那种不一致没人会当成 bug。
   */
  const slashHits = () => matchSlash(text())
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
    // 先清草稿再执行：命令可能会开浮层或换会话，那之后 setText 未必还落在这个组件上。
    setText('')
    queueMicrotask(() => {
      ta.style.height = 'auto'
      cmd.run()
    })
  }

  const autosize = () => {
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`
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
     * 带参数的斜杠命令在这里被截下来，**不发成一条消息**。
     *
     * 只截「确实是命令名 + 确实带了参数」这一种：`/goal` 光杆走的是补全面板
     * （`runSlash` 把它填回草稿），认不出的 `/xxx` 原样当正文发出去——
     * 静默丢掉一句用户打的话，比把它当消息发出去坏得多。
     */
    const call = slashCall(v)
    const cmd = call ? buildCommands().find((c) => c.slash === call.name && c.arg) : null
    if (cmd && call?.arg) {
      setText('')
      queueMicrotask(() => {
        ta.style.height = 'auto'
        cmd.run(call.arg)
      })
      return
    }

    const steer = flip ? followUpMode() === 'queue' : followUpMode() === 'steer'
    sendMessage(v, files.length ? files : undefined, steer)
    setText('')
    setPending([])
    queueMicrotask(() => {
      ta.style.height = 'auto'
      ta.focus()
    })
  }

  return (
    <div class="composer-wrap" classList={{ 'drag-over': dragOver() }} ref={wrap}>
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

      {/* 待发附件。一行一个看得清、删得掉，**不做缩略图墙**——那会把输入区顶掉半屏。
          左边那格是定尺的（20px），图片放缩略图、文件放通用图标，行高不随内容变。 */}
      <Show when={pending().length > 0 || uploading() > 0}>
        <div class="attach-row">
          <For each={pending()}>
            {(a, i) => (
              <span class="attach-chip" data-tip={a.path}>
                <AttachmentThumb path={a.path} name={a.name} box={20} {...thumbProps(a.path)} />
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
            )}
          </For>
          <Show when={uploading() > 0}>
            <span class="attach-chip busy">上传中 {uploading()}</span>
          </Show>
        </div>
      </Show>

      {/* 目标在进度条之下、输入框之上：它是常驻的（跨轮存在），所以占流，
          不像那条整轮状态条那样悬浮——悬浮层一多就会互相盖住。 */}
      <GoalChip />

      <FollowUpCards />

      <RunStatus />

      {/* 斜杠弹层向上开：输入区贴着窗口底部。 */}
      <Show when={slashHits().length > 0}>
        <div class="slash-pop" role="listbox" aria-label="命令">
          <For each={slashHits()}>
            {(cmd, i) => (
              <button
                class="slash-item"
                classList={{ active: i() === slashCursor() }}
                type="button"
                role="option"
                aria-selected={i() === slashCursor()}
                onMouseEnter={() => setSlashCursor(i())}
                onClick={() => runSlash(cmd)}
              >
                <span class="slash-icon">{cmd.icon({ size: 14 }) as never}</span>
                <code class="slash-name">/{cmd.slash}</code>
                <span class="slash-label truncate">{cmd.label}</span>
                <Show when={cmd.hint}>
                  <span class="slash-hint truncate">{cmd.hint}</span>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Show>

      <form
        class="composer"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
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
            setSlashCursor(0)
            autosize()
          }}
          onKeyDown={(e) => {
            const hits = slashHits()
            if (hits.length > 0 && !e.isComposing) {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSlashCursor((c) => Math.min(c + 1, hits.length - 1))
                return
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSlashCursor((c) => Math.max(c - 1, 0))
                return
              }
              if (e.key === 'Escape') {
                e.preventDefault()
                setText('')
                return
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                const cmd = hits[slashCursor()]
                if (cmd) runSlash(cmd)
                return
              }
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
                <span class="ctx-head-title">
                  上下文
                  {/* 成色紧跟标题，不另起一行：它是「上下文」这个数的定语，
                      不是一条独立信息。百分比不重复——弹层正下方那个按钮就是它。 */}
                  <span class="ctx-source">
                    {c().source === 'actual' ? '实际统计' : '估算统计'}
                  </span>
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
