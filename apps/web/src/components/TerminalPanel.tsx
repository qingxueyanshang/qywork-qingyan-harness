import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import {
  type Accessor,
  createEffect,
  createRoot,
  createSignal,
  onCleanup,
  onMount,
  type Setter,
  Show,
} from 'solid-js'
import { activePanelTab, holdPanelTab, theme, workspace } from '../lib/store/index.ts'
import { closeTerminal, openTerminal, resizeTerminal, writeTerminal } from '../lib/terminal.ts'

/**
 * 终端页。渲染在 xterm.js 里，进程在 Rust 侧的 PTY 里（见 `src-tauri/src/terminal.rs`）。
 *
 * **实例挂在模块上，按页签 id 存。** 切去看文件、甚至把整块面板收起来，命令都还得在跑、滚动历史还得
 * 在。而这两件事都会把组件整个卸载——所以 xterm 实例和它的宿主 div 存在模块级的 `panes` 里，组件
 * 挂载时把宿主搬进来、卸载时搬出去。**不要改成每次挂载新建一个 Terminal**：新实例没有历史，用户看
 * 到的是一块空白，而 PTY 那边还在跑。
 *
 * 因此**卸载不销毁**。真正的销毁只发生在这一页被关掉时，入口是 store 的
 * `holdPanelTab`（页签上的 × 和换项目都走它），见 `disposePane`。
 */

/** 滚轮一格翻几行。三行是各家终端的通行值，再多会在窄面板里一下子翻过头。 */
const WHEEL_LINES = 3

interface Pane {
  term: Terminal
  fit: FitAddon
  /** 常驻宿主。组件卸载只是把它摘下来，xterm 的 DOM 与滚动历史都留在上面。 */
  host: HTMLDivElement
  /** PTY 那条会话开着没有。子进程退出后回 `false`，「重开」据此再开一条。 */
  started: boolean
  /** 子进程的终态。`null` = 仍在运行。`code` 为 null 表示拿不到退出码。 */
  exit: Accessor<{ code: number | null } | null>
  setExit: Setter<{ code: number | null } | null>
}

/** 开着的终端，按页签 id 存。id 就是传给 Rust 的会话 id。 */
const panes = new Map<string, Pane>()

/**
 * ANSI 十六色。**不走设计令牌**：那套是给应用界面的，而 ANSI 是终端自己的约定，
 * 程序按色号输出，混用会让 `ls` 的目录色跟着按钮色变。亮暗各一套，只有底色、
 * 前景色、光标取自 CSS 变量——那三样才是「跟着主题走」的部分。
 */
const ANSI_DARK = {
  black: '#3b3b40',
  red: '#e06c60',
  green: '#79c07d',
  yellow: '#d9a75f',
  blue: '#6b9fe8',
  magenta: '#c08ada',
  cyan: '#5fb3c0',
  white: '#d6d6da',
  brightBlack: '#6b6b73',
  brightRed: '#f0857a',
  brightGreen: '#93d497',
  brightYellow: '#e8c07a',
  brightBlue: '#8bb6f0',
  brightMagenta: '#d4a5e6',
  brightCyan: '#7fc9d4',
  brightWhite: '#f2f2f3',
}
const ANSI_LIGHT = {
  black: '#16161a',
  red: '#c2371f',
  green: '#1a7f47',
  yellow: '#a86a12',
  blue: '#2f6feb',
  magenta: '#8b4bc4',
  cyan: '#0f7c8c',
  white: '#6b6b73',
  brightBlack: '#9a9aa2',
  brightRed: '#cb5541',
  brightGreen: '#2a9b5c',
  brightYellow: '#c08430',
  brightBlue: '#4a84ef',
  brightMagenta: '#a066d6',
  brightCyan: '#2b96a6',
  brightWhite: '#16161a',
}

/**
 * 现在是不是暗色。
 *
 * 判据和 `tokens.css` 完全一致：显式选了就按显式的，`system` 档没有 `data-theme`
 * 属性、交给系统偏好。两处各判一次必然出现「界面暗了终端还白着」。
 */
function isDark(): boolean {
  const pref = document.documentElement.getAttribute('data-theme')
  if (pref === 'dark') return true
  if (pref === 'light') return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return v || fallback
}

function applyTheme(pane: Pane): void {
  const dark = isDark()
  pane.term.options.theme = {
    background: cssVar('--bg-app', dark ? '#16161a' : '#ffffff'),
    foreground: cssVar('--text-primary', dark ? '#f2f2f3' : '#16161a'),
    // **光标用前景色，不用 `--accent`。** 强调色在这个仓库里只归「当前选中」和
    // 「主操作」用，拿它画光标，那一格会被读成一块蓝色高亮而不是输入位置。
    cursor: cssVar('--text-primary', dark ? '#f2f2f3' : '#16161a'),
    // 光标底下那个字符的颜色。程序可以用 DECSCUSR 把光标切回实心块，
    // 那时不给这个值，字会和光标同色、直接看不见。
    cursorAccent: cssVar('--bg-app', dark ? '#16161a' : '#ffffff'),
    selectionBackground: cssVar('--accent-soft', 'rgba(128, 128, 128, 0.25)'),
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  }
}

/**
 * 主题跟着走，**挂在模块上而不是组件里**，而且一次管所有实例。
 *
 * 挂在组件里的话：收起面板期间切主题，实例仍存活但没人给它换色，切回来是旧配色。
 * 两条路都要有——显式切换走 `theme()`，`system` 档没有 `data-theme` 属性，只能听
 * 系统偏好；缺一条就有一半情况不跟随。
 *
 * `createRoot` 只为给这个 effect 一个所有者。它随模块常驻，没有该销毁的时机，
 * 所以不接 dispose。
 */
let themeWatched = false
function watchTheme(): void {
  if (themeWatched) return
  themeWatched = true
  const applyAll = () => {
    for (const pane of panes.values()) applyTheme(pane)
  }
  createRoot(() =>
    createEffect(() => {
      theme()
      applyAll()
    }),
  )
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyAll)
}

/**
 * 建实例，已经有就把宿主搬回 `slot`。
 *
 * **必须传一个已经在文档里的容器**：`term.open()` 一挂上就去量字符宽高，而游离节点
 * 量出来是 0——后面任何一次按尺寸算行列的代码都会拿 0 当除数。
 */
function ensurePane(id: string, slot: HTMLElement): Pane {
  const existing = panes.get(id)
  if (existing) {
    slot.appendChild(existing.host)
    return existing
  }

  const host = document.createElement('div')
  host.className = 'term-host'
  slot.appendChild(host)

  const term = new Terminal({
    // **写字面字体栈，不要写 var(--font-mono)。** xterm 用 canvas 量字符宽度，
    // 量的时候不解析 CSS 变量，拿到的是一个非法字体名 → 回落到比例字体 →
    // 每一列都对不齐。
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 12,
    // **竖线 + 闪烁。** 实心方块和「选中一个字符」长得一模一样，不闪就更像——
    // 用户看不出那是输入位置，整块终端读起来像只读的。
    // 这只是默认形状：程序自己发 DECSCUSR 换形状时以程序为准（vim 就会换）。
    cursorStyle: 'bar',
    cursorBlink: true,
    // 回滚缓冲。再大就是拿内存换一段用户几乎不会翻到的历史。
    scrollback: 5000,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)

  const [exit, setExit] = createSignal<{ code: number | null } | null>(null)
  const pane: Pane = { term, fit, host, started: false, exit, setExit }
  panes.set(id, pane)
  applyTheme(pane)
  watchTheme()

  // 键盘输入原样送进 PTY。**不在这里解释按键**——回车、Ctrl-C、方向键都是字节，
  // 由 shell 自己认；前端插一层翻译就会和真终端的行为对不上。
  // 鼠标报文走的也是这一条（开了鼠标追踪的 TUI），所以写失败等于点击也失败。
  term.onData((d) => void writeTerminal(id, d).catch(() => markGone(pane)))

  /*
   * 滚轮由本组件接管，不交给程序。
   *
   * 程序一开鼠标追踪（`CSI ?1002h`，全屏 TUI 的常规做法），xterm 就把滚轮当成
   * 鼠标事件转发过去，终端自己**一行都滚不动**——而且既然从不滚动，那条
   * 「滚动时淡入」的滚动条也永远不出现。实测：普通态 viewportY 277→273，
   * 开了追踪之后纹丝不动，**按住 Shift 也没用**（xterm 6 没留这个逃生口）。
   *
   * **在宿主上用捕获阶段接，不用 `attachCustomWheelEventHandler`。** 后者要等
   * 事件走到 xterm 自己那个监听器才轮得到；捕获阶段挂在最外层，先到先得，
   * 再 `stopPropagation` 掐死后续转发。
   *
   * 代价说清楚：正常缓冲区里的程序从此收不到滚轮事件。这是有意的取舍——
   * 这块面板是用来回看输出的，翻历史比让 TUI 收到滚轮更要紧。
   * 备用缓冲区例外：那里没有回滚可翻，滚轮本来就该归程序（`less` / `vim` 自己处理）。
   */
  host.addEventListener(
    'wheel',
    (ev) => {
      if (term.buffer.active.type === 'alternate') return
      ev.preventDefault()
      ev.stopPropagation()
      term.scrollLines(Math.sign(ev.deltaY) * WHEEL_LINES)
    },
    { capture: true, passive: false },
  )

  // 这一页被关掉时才收，组件卸载不算——理由见文件头与 store 的 `holdPanelTab`。
  holdPanelTab(id, () => disposePane(id))

  return pane
}

/**
 * 会话在外壳那边已经用不了了：落到和退出事件同一个终态。
 *
 * PTY 会话表在 Rust 侧，`started` 只是它在前端的镜像，平时靠 `terminal:exit`
 * 一条事件同步。事件没送到时镜像会一直停在「开着」，键盘与鼠标报文继续写进一个
 * 不存在的会话——用户面前是一块画着上一帧、点了没反应的终端。命令被拒是权威
 * 本身的答复，**要就地消费掉，不能吞**。
 *
 * 退出码给 `null`：这条路上读不到子进程的终态，只知道会话不能用了。
 */
function markGone(pane: Pane): void {
  if (pane.exit()) return
  pane.started = false
  pane.setExit({ code: null })
}

/** 收掉一条终端：杀进程、销毁实例、摘掉 DOM。只由 `holdPanelTab` 那条路调。 */
function disposePane(id: string): void {
  const pane = panes.get(id)
  if (!pane) return
  panes.delete(id)
  pane.host.remove()
  pane.term.dispose()
  // 关不掉也没有下一步可给：页签已经没了，这条 shell 最迟在应用退出时被 `shutdown` 收掉。
  void closeTerminal(id).catch(() => {})
}

/**
 * 把 xterm 量出来的行列数同步给 PTY，尺寸算不出来就整个跳过。
 *
 * **不要直接调 `fit.fit()`。** 它只挡 `NaN` 不挡 `Infinity`：字符宽度还没量到时
 * （容器刚进 DOM、这一页正被藏起来）单元格宽是 0，`可用宽度 / 0` 得到 `Infinity`，
 * 它照样交给 `term.resize()`，一次就让实例失效——之后不滚动、不回显、不响应键盘，
 * 而且控制台不一定有报错。所以自己取 `proposeDimensions()` 并逐项校验。
 *
 * 会话还没建好时只改本地不发给 PTY：那时候发过去必然是「会话不存在」。
 * 开完之后 `ensureStarted` 会自己补一次。
 */
function syncSize(id: string, pane: Pane): void {
  const dims = pane.fit.proposeDimensions()
  if (!dims) return
  const { cols, rows } = dims
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return
  if (cols !== pane.term.cols || rows !== pane.term.rows) pane.term.resize(cols, rows)
  if (!pane.started) return
  void resizeTerminal(id, pane.term.cols, pane.term.rows).catch(() => markGone(pane))
}

async function ensureStarted(id: string, pane: Pane): Promise<void> {
  if (pane.started) return
  pane.started = true
  pane.setExit(null)
  try {
    const backlog = await openTerminal(
      id,
      workspace()?.root ?? '',
      pane.term.cols,
      pane.term.rows,
      {
        output: (d) => pane.term.write(d),
        exit: (code) => {
          pane.started = false
          pane.setExit({ code })
        },
      },
    )
    // 接上一条已经在跑的会话时，先把外壳存着的那段重放进来，否则用户接回来
    // 面对的是一块空屏——shell 仍在运行，但要敲一下才看得出来。
    if (backlog) pane.term.write(backlog)
    // 开完再对一次：从调用到会话建好这段时间里，面板可能已经被拖宽或放大了。
    syncSize(id, pane)
  } catch (e) {
    pane.started = false
    // 起不来要说在终端里，不是静默留一块黑：用户盯着的就是这块地方。
    pane.term.write(`\r\n\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n`)
  }
}

/**
 * 重开：先收掉旧会话，再开新的。
 *
 * **不能只调 `ensureStarted`。** 落到终态的另一条路是命令被拒（见 `markGone`），
 * 那时 Rust 侧的会话可能还在表里——`terminal_open` 认得这个 id 就直接返回成功，
 * 什么也不起，按钮点下去没反应。关一个已经不在的 id 是允许的，外壳返回成功。
 *
 * 这一步只属于「重开」这颗按钮：挂载时那次 `ensureStarted` 不能先关——
 * 页面刷新后前端的镜像是空的而 shell 还在跑，先关就把用户手上的进程杀了。
 */
async function restart(id: string, pane: Pane): Promise<void> {
  await closeTerminal(id).catch(() => {})
  await ensureStarted(id, pane)
  // 焦点要跟回终端：按钮随终态条一起消失，焦点会掉到 body 上，
  // 因此新起的 shell 收不到任何按键，与退出前那块终端的形状一致。
  pane.term.focus()
}

export default function TerminalPanel(props: { id: string }) {
  const [slot, setSlot] = createSignal<HTMLDivElement>()
  /** 拿到实例之后才画得出退出那一条。首帧还没有，所以是信号而不是 `panes.get()`。 */
  const [pane, setPane] = createSignal<Pane>()

  onMount(() => {
    const el = slot()
    if (!el) return
    const id = props.id
    // 容器先进 DOM 再建实例，理由见 `ensurePane`。
    const p = ensurePane(id, el)
    setPane(p)
    syncSize(id, p)
    void ensureStarted(id, p)

    // 尺寸跟着容器走：面板可以拖宽、可以放大到大半屏，而 PTY 那边必须同步收到
    // 新的行列数，否则 less / vim 会按旧宽度排版。
    // 首帧那次量不到字符宽高，`syncSize` 会自己跳过；观察器随后立刻会再来一次。
    const ro = new ResizeObserver(() => syncSize(id, p))
    ro.observe(el)

    onCleanup(() => {
      ro.disconnect()
      // 只把宿主摘下来，不销毁：进程还在跑，下次切回来要接着看。
      p.host.remove()
    })
  })

  /*
   * 翻到这一页就把焦点给它。
   *
   * **必须是 effect，不能只在 `onMount` 里做一次**：切页签不重挂这个组件（那些页
   * 一直挂着，只是被藏起来），只在挂载时聚焦的话，从别的页切回来光标不闪——
   * 而 xterm 失焦时画的就是一个不闪的光标，与终端不响应时的形状一致。
   *
   * 藏起来的那一页不抢焦点：`display: none` 里的元素聚焦本来就是空操作，而这一条
   * 会在每次切页签时对每一页各跑一次。
   */
  createEffect(() => {
    if (activePanelTab() === props.id) pane()?.term.focus()
  })

  return (
    <div class="terminal-panel">
      <div class="term-slot" ref={setSlot} />
      {/* 进程退出要有终态，还要给得出下一步。只显示「已退出」而不给重开，
          用户唯一的出路是切走再切回来——那是让人自己去猜的交互。 */}
      <Show when={pane()?.exit()}>
        {(e) => (
          <footer class="term-foot">
            <span>{e().code === null ? '进程已结束' : `进程已退出（${e().code}）`}</span>
            <button
              class="btn-ghost"
              type="button"
              onClick={() => {
                const p = pane()
                if (!p) return
                p.term.clear()
                void restart(props.id, p)
              }}
            >
              重开
            </button>
          </footer>
        )}
      </Show>
    </div>
  )
}
