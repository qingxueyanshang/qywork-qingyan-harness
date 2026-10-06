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
import {
  disconnectedTerminal,
  type TerminalEnd,
  type TerminalOperation,
  terminalEndLabel,
  terminalWheelAction,
} from '../lib/terminal-behavior.ts'

/**
 * 终端页。由 xterm.js 渲染，进程运行在 Rust 侧的 PTY 中（见 `src-tauri/src/terminal.rs`）。
 *
 * **实例保存在模块级，按页签 id 存储。** 切换到文件页乃至收起整个面板时，命令必须继续运行、滚动历史
 * 必须保留。而这两种操作都会卸载组件，因此 xterm 实例及其宿主 div 保存在模块级的 `panes` 中，组件
 * 挂载时移入宿主、卸载时移出。**不要改为每次挂载新建 Terminal**：新实例没有历史，显示为空白，
 * 而 PTY 仍在运行。
 *
 * 因此**卸载不销毁实例**。销毁只在关闭该页时发生，入口是 store 的
 * `holdPanelTab`（页签上的 × 经由它），见 `disposePane`。切换工作区只是使该页
 * 不再出现在当前页签列表中，PTY 与实例均保留。
 */

/** Shift + 滚轮查看历史时每格滚动三行。 */
const WHEEL_LINES = 3

interface Pane {
  term: Terminal
  fit: FitAddon
  /** 常驻宿主元素。组件卸载时只将其从文档中移除，xterm 的 DOM 与滚动历史保留在其中。 */
  host: HTMLDivElement
  /** PTY 会话可用时为 `true`；退出或连接断开后变为 `false`。 */
  started: boolean
  /** `null` 表示仍在运行；非空值区分进程退出与 PTY 连接断开。 */
  end: Accessor<TerminalEnd | null>
  setEnd: Setter<TerminalEnd | null>
}

/** 已打开的终端，按页签 id 存储。该 id 即传给 Rust 的会话 id。 */
const panes = new Map<string, Pane>()

/**
 * ANSI 十六色。**不使用设计令牌**：设计令牌用于应用界面，而 ANSI 是终端自身的约定，
 * 程序按色号输出，混用会使 `ls` 的目录颜色随按钮颜色变化。亮色与暗色各一套，只有背景色、
 * 前景色与光标取自 CSS 变量：这三项需要随主题变化。
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
 * 当前是否为暗色主题。
 *
 * 判据与 `tokens.css` 完全一致：用户显式选择时按显式值，`system` 档没有 `data-theme`
 * 属性，按系统偏好判定。两处判据不一致时，会出现界面为暗色而终端仍为亮色的情况。
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
    // **光标使用前景色，不使用 `--accent`。** 强调色在本仓库中只用于「当前选中」与
    // 「主操作」；用它绘制光标，该单元格会被误读为蓝色高亮而不是输入位置。
    cursor: cssVar('--text-primary', dark ? '#f2f2f3' : '#16161a'),
    // 光标下方字符的颜色。程序可以用 DECSCUSR 将光标切换为实心块，
    // 此时不设置该值，字符会与光标同色而无法辨认。
    cursorAccent: cssVar('--bg-app', dark ? '#16161a' : '#ffffff'),
    selectionBackground: cssVar('--accent-soft', 'rgba(128, 128, 128, 0.25)'),
    ...(dark ? ANSI_DARK : ANSI_LIGHT),
  }
}

/**
 * 主题同步**注册在模块级而不是组件中**，一次作用于所有实例。
 *
 * 注册在组件中时，收起面板期间切换主题，实例仍存在但不会更新配色，重新打开后仍是旧配色。
 * 两条路径都必须存在：显式切换经由 `theme()`，`system` 档没有 `data-theme` 属性，只能监听
 * 系统偏好；缺少任一条，都有一类情况不随主题变化。
 *
 * `createRoot` 只为该 effect 提供所有者。它随模块常驻，没有销毁时机，
 * 因此不调用 dispose。
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
 * 创建实例；实例已存在时把宿主移回 `slot`。
 *
 * **必须传入已在文档中的容器**：`term.open()` 挂载后立即测量字符宽高，游离节点
 * 的测量结果为 0，之后按尺寸计算行列的代码都会以 0 作除数。
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
    // **写字面字体栈，不要写 var(--font-mono)。** xterm 用 canvas 测量字符宽度，
    // 测量时不解析 CSS 变量，得到的是非法字体名，随后回退到比例字体，
    // 各列无法对齐。
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: 12,
    // **竖线 + 闪烁。** 实心方块与选中单个字符的外观相同，不闪烁时更难区分，
    // 用户无法识别输入位置，终端看起来像只读区域。
    // 这只是默认形状：程序发送 DECSCUSR 更换形状时以程序为准（如 vim）。
    cursorStyle: 'bar',
    cursorBlink: true,
    // 回滚缓冲行数。更大的值会占用更多内存，而增加的历史用户几乎不会查看。
    scrollback: 5000,
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)

  const [end, setEnd] = createSignal<TerminalEnd | null>(null)
  const pane: Pane = { term, fit, host, started: false, end, setEnd }
  panes.set(id, pane)
  applyTheme(pane)
  watchTheme()

  // 键盘输入原样写入 PTY。**不在此处解释按键**：回车、Ctrl-C、方向键都是字节，
  // 由 shell 自行识别；前端增加一层转换会与真实终端的行为不一致。
  // 鼠标报文也经由此路径（启用鼠标追踪的 TUI），因此写入失败时点击同样失效。
  term.onData((d) => void writeTerminal(id, d).catch((error) => markGone(id, pane, 'write', error)))

  /*
   * 普通滚轮交给 xterm 与终端程序，保留 TUI 的鼠标和固定底栏行为。
   * Shift + 滚轮在普通缓冲区查看历史；备用缓冲区没有可查看的历史。
   */
  host.addEventListener(
    'wheel',
    (ev) => {
      if (terminalWheelAction(term.buffer.active.type, ev.shiftKey) !== 'history') return
      ev.preventDefault()
      ev.stopPropagation()
      term.scrollLines(Math.sign(ev.deltaY) * WHEEL_LINES)
    },
    { capture: true, passive: false },
  )

  // 只在关闭该页时回收，组件卸载不触发回收：理由见文件头与 store 的 `holdPanelTab`。
  holdPanelTab(id, () => disposePane(id))

  return pane
}

/**
 * 外壳侧的会话已不可用：进入与退出事件相同的终态。
 *
 * PTY 会话表在 Rust 侧，`started` 只是它在前端的镜像，平时依靠 `terminal:exit`
 * 事件同步。该事件未送达时，镜像始终停留在「已打开」，键盘与鼠标报文持续写入一个
 * 不存在的会话，终端停留在上一帧且不响应操作。命令被拒是权威方的答复，
 * **必须就地处理，不能忽略**。
 *
 * 断连状态保留失败操作与错误原文，界面只显示简短状态。
 */
function markGone(id: string, pane: Pane, operation: TerminalOperation, error: unknown): void {
  if (pane.end()) return
  const end = disconnectedTerminal(operation, error)
  console.error(`[terminal:${id}] ${operation}: ${end.reason}`)
  pane.started = false
  pane.setEnd(end)
}

/** 关闭一个终端：终止进程、销毁实例、移除 DOM。只由 `holdPanelTab` 调用。 */
function disposePane(id: string): void {
  const pane = panes.get(id)
  if (!pane) return
  panes.delete(id)
  pane.host.remove()
  pane.term.dispose()
  // 关闭失败时没有可执行的后续操作：页签已移除，该 shell 最迟在应用退出时由 `shutdown` 回收。
  void closeTerminal(id).catch(() => {})
}

/**
 * 将 xterm 测得的行列数同步给 PTY，无法计算尺寸时跳过。
 *
 * **不要直接调用 `fit.fit()`。** 它只排除 `NaN`，不排除 `Infinity`：尚未测得字符宽度时
 * （容器刚插入 DOM、该页处于隐藏状态）单元格宽度为 0，`可用宽度 / 0` 得到 `Infinity`，
 * 该值仍会传给 `term.resize()`，一次即可使实例失效：之后不滚动、不回显、不响应键盘，
 * 控制台也不一定报错。因此自行调用 `proposeDimensions()` 并逐项校验。
 *
 * 会话尚未建立时只调整本地尺寸，不发送给 PTY：此时发送必然返回「会话不存在」。
 * 会话建立后 `ensureStarted` 会补发一次。
 */
function syncSize(id: string, pane: Pane): void {
  const dims = pane.fit.proposeDimensions()
  if (!dims) return
  const { cols, rows } = dims
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || cols < 1 || rows < 1) return
  if (cols !== pane.term.cols || rows !== pane.term.rows) pane.term.resize(cols, rows)
  if (!pane.started) return
  void resizeTerminal(id, pane.term.cols, pane.term.rows).catch((error) =>
    markGone(id, pane, 'resize', error),
  )
}

/**
 * 启动该会话的 PTY。
 *
 * **归属与目录取自同一份工作区快照**：分两次读取时，若期间切换了工作区，会把 A 的 id
 * 与 B 的根目录配对。没有活动工作区时不启动：该 PTY 无法归属任何页签列表。
 */
async function ensureStarted(id: string, pane: Pane): Promise<void> {
  if (pane.started) return
  const ws = workspace()
  if (!ws) {
    markGone(id, pane, 'open', new Error('没有打开的项目'))
    return
  }
  pane.started = true
  pane.setEnd(null)
  try {
    const backlog = await openTerminal(id, ws.id, ws.root, pane.term.cols, pane.term.rows, {
      output: (d) => pane.term.write(d),
      exit: (code) => {
        pane.started = false
        pane.setEnd({ kind: 'exited', code })
      },
    })
    // 连接到已在运行的会话时，先重放外壳保存的输出，否则重新连接后
    // 显示为空屏：shell 仍在运行，但需按键后才有输出。
    if (backlog) pane.term.write(backlog)
    // 会话建立后再同步一次尺寸：从调用到会话建立期间，面板可能已被拖宽或放大。
    syncSize(id, pane)
  } catch (e) {
    // 启动失败时在终端内显示错误，而不是静默留下空白区域：用户关注的正是此处。
    pane.term.write(`\r\n\x1b[31m${e instanceof Error ? e.message : String(e)}\x1b[0m\r\n`)
    markGone(id, pane, 'open', e)
  }
}

/**
 * 重开：先关闭旧会话，再打开新会话。
 *
 * **不能只调用 `ensureStarted`。** 进入终态的另一条路径是命令被拒（见 `markGone`），
 * 此时 Rust 侧的会话可能仍在表中：`terminal_open` 识别到该 id 会直接返回成功而不启动进程，
 * 按钮点击后没有响应。关闭一个已不存在的 id 是允许的，外壳返回成功。
 *
 * 该步骤只用于「重开」按钮，挂载时调用 `ensureStarted` 之前不能先关闭会话：
 * 页面刷新后前端镜像为空而 shell 仍在运行，先关闭会终止用户正在使用的进程。
 */
async function restart(id: string, pane: Pane): Promise<void> {
  await closeTerminal(id).catch(() => {})
  await ensureStarted(id, pane)
  // 焦点必须回到终端：按钮随终态栏一起移除后，焦点会落到 body 上，
  // 新启动的 shell 收不到任何按键，外观与退出前的终端相同。
  pane.term.focus()
}

export default function TerminalPanel(props: { id: string }) {
  const [slot, setSlot] = createSignal<HTMLDivElement>()
  /** 取得实例后才能渲染退出状态栏。首帧时实例尚不存在，因此使用信号而不是 `panes.get()`。 */
  const [pane, setPane] = createSignal<Pane>()

  onMount(() => {
    const el = slot()
    if (!el) return
    const id = props.id
    // 先将容器插入 DOM 再创建实例，理由见 `ensurePane`。
    const p = ensurePane(id, el)
    setPane(p)
    syncSize(id, p)
    void ensureStarted(id, p)

    // 尺寸随容器变化：面板可拖宽或放大，PTY 必须同步收到
    // 新的行列数，否则 less / vim 会按旧宽度排版。
    // 首帧无法测得字符宽高，`syncSize` 会自行跳过；观察器随后会立即再次触发。
    const ro = new ResizeObserver(() => syncSize(id, p))
    ro.observe(el)

    onCleanup(() => {
      ro.disconnect()
      // 只移除宿主元素，不销毁实例：进程仍在运行，切回后需继续查看。
      p.host.remove()
    })
  })

  /*
   * 切换到该页时将焦点交给终端。
   *
   * **必须使用 effect，不能只在 `onMount` 中执行一次**：切换页签不会重新挂载该组件（各页
   * 始终挂载，只是隐藏），只在挂载时聚焦时，从其他页切回后光标不闪烁，
   * 而 xterm 失焦时绘制的正是不闪烁的光标，与终端无响应时外观相同。
   *
   * 隐藏的页不获取焦点：对 `display: none` 中的元素聚焦是空操作，而该 effect
   * 会在每次切换页签时对每一页各执行一次。
   */
  createEffect(() => {
    if (activePanelTab() === props.id) pane()?.term.focus()
  })

  return (
    <div class="terminal-panel">
      <div class="term-slot" ref={setSlot} />
      {/* 进程退出或连接断开后提供同一个恢复入口。 */}
      <Show when={pane()?.end()}>
        {(e) => (
          <footer class="term-foot">
            <span>{terminalEndLabel(e())}</span>
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
