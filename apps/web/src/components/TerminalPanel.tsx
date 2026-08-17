import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { createEffect, createSignal, onCleanup, onMount, Show } from 'solid-js'
import { theme, workspace } from '../lib/store/index.ts'
import { openTerminal, resizeTerminal, writeTerminal } from '../lib/terminal.ts'

/**
 * 终端面板。渲染在 xterm.js 里，进程在 Rust 侧的 PTY 里（见 `src-tauri/src/terminal.rs`）。
 *
 * ## 实例是模块级的，不随页签生死
 *
 * 切去看文件再切回来，命令还得在跑、滚动历史还得在。而页签切换会把这个组件整个
 * 卸载——所以 xterm 实例和它的宿主 div 挂在模块上，组件挂载时把宿主搬进来、
 * 卸载时搬出去。**不要改成每次挂载新建一个 Terminal**：新实例没有历史，
 * 用户看到的是一块空白，而 PTY 那边其实还在跑。
 *
 * ## 一条会话就够
 *
 * 多标签终端是另一件事（要有标签条、要有关掉哪一条的语义）。现在只有一条，
 * id 写死；真需要多条时把 `SESSION` 换成参数，Rust 那边本来就是按 id 存的。
 */

/** 唯一那条会话的 id。Rust 侧按 id 存 PTY，改成多条时这里换成参数即可。 */
const SESSION = 'main'

/** 滚轮一格翻几行。三行是各家终端的通行值，再多会在窄面板里一下子翻过头。 */
const WHEEL_LINES = 3

let term: Terminal | null = null
let fit: FitAddon | null = null
/** 常驻宿主。切页签只是把它从面板里摘下来，xterm 的 DOM 和滚动历史都留在上面。 */
let host: HTMLDivElement | null = null
let started = false

/** 子进程的终态。`null` = 还活着。`code` 为 null 表示拿不到退出码。 */
const [exit, setExit] = createSignal<{ code: number | null } | null>(null)

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

function applyTheme(): void {
  if (!term) return
  const dark = isDark()
  term.options.theme = {
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
 * 建实例。**必须传一个已经在文档里的容器**：`term.open()` 一挂上就去量字符宽高，
 * 而游离节点量出来是 0——后面任何一次按尺寸算行列的代码都会拿 0 当除数。
 */
function ensureTerm(slot: HTMLElement): { term: Terminal; host: HTMLDivElement } {
  if (term && host) {
    slot.appendChild(host)
    return { term, host }
  }

  host = document.createElement('div')
  host.className = 'term-host'
  slot.appendChild(host)

  term = new Terminal({
    // **写字面字体栈，不要写 var(--font-mono)。** xterm 用 canvas 量字符宽度，
    // 量的时候不解析 CSS 变量，拿到的是一个非法字体名 → 回落到比例字体 →
    // 每一列都对不齐。
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 12,
    // **竖线 + 闪烁。** 实心方块和「选中一个字符」长得一模一样，不闪就更像——
    // 用户看不出那是输入位置，会以为这块终端是只读的。
    // 这只是默认形状：程序自己发 DECSCUSR 换形状时以程序为准（vim 就会换）。
    cursorStyle: 'bar',
    cursorBlink: true,
    // 回滚缓冲。再大就是拿内存换一段用户几乎不会翻到的历史。
    scrollback: 5000,
  })
  fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)
  applyTheme()

  // 键盘输入原样送进 PTY。**不在这里解释按键**——回车、Ctrl-C、方向键都是字节，
  // 由 shell 自己认；前端插一层翻译就会和真终端的行为对不上。
  term.onData((d) => void writeTerminal(SESSION, d).catch(() => {}))

  /*
   * 滚轮由我们接管，不交给程序。
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
      if (!term || term.buffer.active.type === 'alternate') return
      ev.preventDefault()
      ev.stopPropagation()
      term.scrollLines(Math.sign(ev.deltaY) * WHEEL_LINES)
    },
    { capture: true, passive: false },
  )

  return { term, host }
}

/**
 * 把 xterm 量出来的行列数同步给 PTY，尺寸算不出来就整个跳过。
 *
 * **不要直接调 `fit.fit()`。** 它只挡 `NaN` 不挡 `Infinity`：字符宽度还没量到时
 * （容器刚进 DOM、面板正被折叠）单元格宽是 0，`可用宽度 / 0` 得到 `Infinity`，
 * 它照样交给 `term.resize()`，一次就把实例打废——之后不滚动、不回显、不响应键盘，
 * 而且控制台不一定有报错。所以自己取 `proposeDimensions()` 并逐项校验。
 *
 * 会话还没建好时只改本地不发给 PTY：那时候发过去必然是「会话不存在」。
 * 开完之后 `ensureStarted` 会自己补一次。
 */
function syncSize(): void {
  if (!term || !fit) return
  const dims = fit.proposeDimensions()
  if (!dims) return
  const { cols, rows } = dims
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return
  if (cols !== term.cols || rows !== term.rows) term.resize(cols, rows)
  if (!started) return
  void resizeTerminal(SESSION, term.cols, term.rows).catch(() => {})
}

async function ensureStarted(): Promise<void> {
  if (started || !term) return
  started = true
  setExit(null)
  try {
    await openTerminal(SESSION, workspace()?.root ?? '', term.cols, term.rows, {
      output: (d) => term?.write(d),
      exit: (code) => {
        started = false
        setExit({ code })
      },
    })
    // 开完再对一次：从调用到会话建好这段时间里，面板可能已经被拖宽或放大了。
    syncSize()
  } catch (e) {
    started = false
    // 起不来要说在终端里，不是静默留一块黑：用户盯着的就是这块地方。
    term.write(`\r\n\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n`)
  }
}

export default function TerminalPanel() {
  const [slot, setSlot] = createSignal<HTMLDivElement>()

  onMount(() => {
    const el = slot()
    if (!el) return
    // 容器先进 DOM 再建实例，理由见 `ensureTerm`。
    const { host: h, term: t } = ensureTerm(el)
    syncSize()
    void ensureStarted()
    // 切到这个页签就是要用它，焦点得跟过来。**不聚焦的代价不止是要多点一下**：
    // xterm 只在聚焦时让光标闪，失焦时画一个不闪的光标——那看起来就像终端死了。
    t.focus()

    // 尺寸跟着容器走：面板可以拖宽、可以放大到大半屏，而 PTY 那边必须同步收到
    // 新的行列数，否则 less / vim 会按旧宽度排版。
    // 首帧那次量不到字符宽高，`syncSize` 会自己跳过；观察器随后立刻会再来一次。
    const ro = new ResizeObserver(() => syncSize())
    ro.observe(el)

    onCleanup(() => {
      ro.disconnect()
      // 只把宿主摘下来，不销毁：进程还在跑，下次切回来要接着看。
      h.remove()
    })
  })

  // 主题跟着走。依赖写成 `theme()` 是为了让显式切换也触发；`system` 档由下面那个
  // matchMedia 监听补上——两条路缺一条就会有一半情况不跟随。
  createEffect(() => {
    theme()
    applyTheme()
  })
  onMount(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => applyTheme()
    mq.addEventListener('change', onChange)
    onCleanup(() => mq.removeEventListener('change', onChange))
  })

  return (
    <div class="terminal-panel">
      <div class="term-slot" ref={setSlot} />
      {/* 进程退出要有终态，还要给得出下一步。只显示「已退出」而不给重开，
          用户唯一的出路是切走再切回来——那是让人自己去猜的交互。 */}
      <Show when={exit()}>
        {(e) => (
          <footer class="term-foot">
            <span>{e().code === null ? '进程已结束' : `进程已退出（${e().code}）`}</span>
            <button
              class="btn-ghost"
              type="button"
              onClick={() => {
                term?.clear()
                void ensureStarted()
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
