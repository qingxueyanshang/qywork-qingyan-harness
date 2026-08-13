import type { Attachment } from '@qywork/core'
import { createSignal, For, Show } from 'solid-js'
import { type Command, matchSlash } from '../lib/commands.ts'
import {
  interrupt,
  openPanel,
  sendMessage,
  setOverlay,
  setPermissionMode,
  setState,
  state,
  uploadAttachment,
  workspace,
} from '../lib/store/index.ts'
import {
  IconActivity,
  IconBranch,
  IconFolder,
  IconPlus,
  IconSend,
  IconShield,
  IconSpinner,
  IconStop,
  IconX,
} from './Icons.tsx'
import { EffortPicker, ModelPicker } from './ModelPicker.tsx'
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
      title={
        full()
          ? '完全访问：不再逐条询问。凭证不进子进程、输出屏蔽凭证、禁止写 .qy/ 这三条硬边界仍然生效。'
          : '自动审批：由硬边界 + 静态规则 + 分类器裁决，拿不准的会问你。'
      }
      onClick={() => void toggle()}
    >
      <IconShield size={13} />
      {full() ? '完全访问' : '自动审批'}
    </button>
  )
}

/**
 * 这一轮跑到哪了：进度 + 改了多少。
 *
 * **一条居中的状态条，不是两块各自贴边的东西。** 参照物（Codex）把
 * 「第 3 / 6 步」和「35 个文件已更改 +227 -2139」放进同一枚胶囊里，
 * 理由是它们回答的是同一个问题——这一轮进行得怎么样了。拆成两处的话，
 * 眼睛要在输入区上方来回找，而它们本来就该一起读。
 *
 * 居中是跟着这条来的：它不属于任何一侧的控件，是整轮的状态。左对齐时
 * 它看起来像输入框长出来的一个附件。
 *
 * 步数取**正在做的那一条**（1-based），不是已完成数：进行中的第 3 步
 * 报成「第 2 步」会让人以为它卡住了。全部做完就没有进行中的那条，
 * 这时才回落到已完成数。
 */
function RunStatusChip() {
  const todos = () => state.todos
  const total = () => todos().length
  const done = () => todos().filter((t) => t.status === 'completed').length
  const step = () => {
    const i = todos().findIndex((t) => t.status === 'in_progress')
    return i >= 0 ? i + 1 : done()
  }
  const files = () => state.fileChanges
  const additions = () => files().reduce((s, c) => s + c.additions, 0)
  const deletions = () => files().reduce((s, c) => s + c.deletions, 0)

  return (
    <Show when={total() > 0 || files().length > 0}>
      <div class="run-status">
        <div class="changes-chip">
          <Show when={total() > 0}>
            {/* 转圈只在真的还在跑时给：停下来之后它还在转，是在说一件不成立的事。 */}
            <Show when={state.running}>
              <IconSpinner size={12} />
            </Show>
            {/* 点步数打开计划面板。完整清单收在那边，这里只报进度——
                不给入口的话，用户得自己去右侧翻出「计划」这个标签页。 */}
            <button
              class="plan-jump"
              type="button"
              title="查看完整计划"
              onClick={() => openPanel('plan')}
            >
              第 {step()} / {total()} 步
            </button>
          </Show>
          {/* 两段都在时才要分隔点——只有一段时它会变成一个悬空的符号。 */}
          <Show when={total() > 0 && files().length > 0}>
            <span class="sep" aria-hidden="true">
              ·
            </span>
          </Show>
          <Show when={files().length > 0}>
            <strong>{files().length} 个文件已更改</strong>
            <span class="add">+{additions()}</span>
            <span class="del">-{deletions()}</span>
          </Show>
        </div>
      </div>
    </Show>
  )
}

/**
 * 输入区。
 *
 * 两条交互决定：
 * - Enter 发送、Shift+Enter 换行。中文输入法组合期间（isComposing）必须放行，
 *   否则用拼音选词时按回车会把半截拼音发出去。
 * - 自适应高度，封顶后转内部滚动，不把会话区挤没。
 */
export function Composer() {
  const [text, setText] = createSignal('')
  const [slashCursor, setSlashCursor] = createSignal(0)
  const [pending, setPending] = createSignal<Attachment[]>([])
  const [uploading, setUploading] = createSignal(0)
  let ta!: HTMLTextAreaElement
  let filePicker!: HTMLInputElement

  /**
   * 收附件。`+` 号、粘贴、拖入**走同一条路**——三个入口三套逻辑必然漂移成
   * 「拖进来能用、粘贴进来不能用」，而那种不一致最难被当成 bug 报出来。
   *
   * 上传失败**逐个报**并继续处理其余的：一张图太大不该让另外三张也白选。
   */
  const take = async (files: FileList | File[]) => {
    const list = Array.from(files)
    if (!list.length) return
    setUploading((n) => n + list.length)
    for (const f of list) {
      try {
        const a = await uploadAttachment(f)
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

  const submit = () => {
    const v = text().trim()
    const files = pending()
    // 只有附件没有文字也能发——「看这张图」这种意图不该逼用户再打几个字。
    if ((!v && files.length === 0) || state.running) return
    sendMessage(v, files.length ? files : undefined)
    setText('')
    setPending([])
    queueMicrotask(() => {
      ta.style.height = 'auto'
      ta.focus()
    })
  }

  return (
    <div class="composer-wrap">
      {/* 空会话时的「这一轮会跑在哪」。**不写标语**——一句口号不携带任何信息，
          而 B7 的判据是「删掉这句用户还能不能用」。留下的 chip 每一个都在
          回答一个真问题，而且每一个都点得动。

          **审批模式不在这里。** 它就在下面那条工具栏上常驻，而且是同一个
          `<ModeChip>`——同一个开关在同一屏出现两次，用户得先判断这两个是不是
          一回事。工作区和分支不同：工具栏上没有它们。 */}
      <Show when={state.transcript.length === 0}>
        <div class="run-context">
          <span class="run-context-label">运行于</span>
          {/* 只显示，不可点：换项目在左栏点一下就是了，这里再放一个入口
              就是同一个动作的第二条路。做成 button 还会承诺一个点开的东西，
              而那个浮层已经删了。 */}
          <Show when={workspace()}>
            {(w) => (
              <span class="mode-chip static" title={w().root}>
                <IconFolder size={13} />
                {w().name}
              </span>
            )}
          </Show>
          {/* 分支只在真是 git 仓库时出现——不是仓库的时候显示一个空分支
              等于告诉用户「这里本该有东西」。 */}
          <Show when={state.git?.branch}>
            {(b) => (
              <button class="mode-chip" type="button" onClick={() => openPanel('git')}>
                <IconBranch size={13} />
                {b()}
              </button>
            )}
          </Show>
        </div>
      </Show>

      {/* 悬浮在输入框上沿，不占文档流：占了的话每次出现/消失都会把整块输入区
          往上顶一格。pointer-events:none 保证它不挡住输入框的点击。 */}

      {/* 待发附件。只列名字不做缩略图墙：一行一个看得清、删得掉，
          而缩略图会把输入区顶掉半屏。 */}
      <Show when={pending().length > 0 || uploading() > 0}>
        <div class="attach-row">
          <For each={pending()}>
            {(a, i) => (
              <span class="attach-chip" title={a.path}>
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

      <RunStatusChip />

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
              void take(files)
            }
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            const files = Array.from(e.dataTransfer?.files ?? [])
            if (files.length) {
              e.preventDefault()
              void take(files)
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
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />

        <div class="composer-bar">
          {/* 一个 `+` 收所有附件，不做图片/文件两个入口——对用户来说
              「把这个东西给它看」是同一件事。 */}
          <input
            ref={filePicker}
            type="file"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => {
              const fs = e.currentTarget.files
              if (fs) void take(fs)
              // 清空 value：同一个文件连选两次也要能触发 change。
              e.currentTarget.value = ''
            }}
          />
          <button
            class="icon-btn"
            type="button"
            aria-label="添加附件"
            title="添加附件（也可直接粘贴或拖入）"
            onClick={() => filePicker.click()}
          >
            <IconPlus size={16} />
          </button>

          <ModeChip />

          {/* 模型和思考装在同一个盒子里：它是模型的旋钮，两者是一组，不是两个
              并列控件。装进盒子之后这一对的间距由盒子自己说了算，与工具栏其余
              控件的间距互不影响——之前靠负边距去抵消工具栏 gap，改一处动全身。 */}
          <div class="model-group">
            <ModelPicker />
            <EffortPicker />
          </div>

          <ContextMeter />

          {/* 运行详情。挨着上下文占用放：一个回答「上下文被谁占了」，
              一个回答「钱花在哪一轮」，都是这个会话的账。 */}
          <button
            class="icon-btn"
            type="button"
            aria-label="运行详情"
            title="运行详情（会话累计与逐轮账目）"
            onClick={() => setOverlay('runs')}
          >
            <IconActivity size={15} />
          </button>

          <span class="spacer" />

          {/* 语音输入。特性检测不通过时它自己不渲染，见 VoiceButton。 */}
          <VoiceButton
            draft={text()}
            onText={(next) => {
              setText(next)
              autosize()
            }}
          />

          {/* 这里曾经还有一个 `${usage.costUsd}`，和会话流末尾那条运行状态
              （Transcript 的 `.run-status`）显示的是同一笔钱、同一个值。
              同源同值显示两遍，只会让人以为是两笔账。留下的是运行状态那条：
              它和「这一轮跑成什么样」在一起，而输入区的工具栏是给下一轮用的。 */}

          {/* 发送按钮的 disabled 判据必须和 submit() 一致：只有附件没有文字也能发
              （见 submit 里那条注释）。只看文字的话，粘一张图不打字的用户点发送
              没反应，只有知道按 Enter 的人发得出去。 */}
          <Show
            when={state.running}
            fallback={
              <button
                class="send-btn"
                type="submit"
                disabled={!text().trim() && pending().length === 0}
                aria-label="发送"
              >
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

/**
 * 上下文占用。
 *
 * 点开看**被谁占的**——一个孤零零的「87%」不可操作：用户既不知道该压缩、
 * 该删记忆、还是该换个窗口更大的模型。
 *
 * 分组数字来自 `context` 事件的 `breakdown`。它在协议里躺了很久、生产者一直写死
 * 全 0；后端刚按 `_group` 填了真值，这里是它的第一个消费者。
 *
 * **各组之和略小于总数**：总数量的是整个序列化请求体，含 JSON 骨架开销。
 * 这句写在弹层里，不写的话「加起来对不上」会被当成 bug。
 */
function ContextMeter() {
  const [open, setOpen] = createSignal(false)
  const rows = () => {
    const b = state.context?.breakdown
    if (!b) return []
    return (
      [
        ['系统提示词', b.systemPrompt],
        ['工具定义', b.toolSchemas],
        ['技能', b.skills],
        ['对话历史', b.historyMessages],
        ['执行记录', b.executionRecords],
        ['压缩摘要', b.summary],
        ['工作区状态', b.workspaceState],
      ] as [string, number][]
    )
      .filter(([, n]) => n > 0)
      .sort((a, b2) => b2[1] - a[1])
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
            title={`${c().tokens.toLocaleString()} / ${c().limit.toLocaleString()} tokens`}
            onClick={() => setOpen((v) => !v)}
          >
            {c().percent}%
          </button>
          <Show when={open() && rows().length > 0}>
            <div class="ctx-pop" role="dialog" aria-label="上下文占用明细">
              <div class="ctx-total">
                {c().tokens.toLocaleString()} / {c().limit.toLocaleString()}
              </div>
              <ul class="ctx-rows">
                <For each={rows()}>
                  {([label, n]) => (
                    <li class="ctx-row">
                      <span class="ctx-name">{label}</span>
                      <span
                        class="ctx-bar"
                        style={{ '--w': `${Math.min(100, (n / Math.max(1, c().tokens)) * 100)}%` }}
                      />
                      <span class="ctx-num">{n.toLocaleString()}</span>
                    </li>
                  )}
                </For>
              </ul>
              <div class="ctx-note">各组之和略小于总数：总数含请求体本身的结构开销。</div>
            </div>
          </Show>
        </span>
      )}
    </Show>
  )
}
