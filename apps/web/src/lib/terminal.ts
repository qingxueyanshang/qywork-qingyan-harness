/**
 * 终端桥：xterm 这一侧与 Rust 的 PTY 之间只有这一层。
 *
 * **只在桌面端存在。** PTY 是本机进程和一对系统句柄，跨不过网络；调用方在渲染
 * 入口之前就该用 `isDesktopShell()` 判掉，而不是让这里抛错（CLAUDE.md B5）。
 *
 * 事件订阅**全局只挂一次**，按会话 id 分发。每开一条终端各挂一个监听的话，
 * 关掉的那些没人退订，输出会被投给已经销毁的 xterm 实例。
 */

import { tauriInvoke, tauriListen } from './store/index.ts'

type OutputHandler = (data: string) => void
type ExitHandler = (code: number | null) => void

const outputs = new Map<string, OutputHandler>()
const exits = new Map<string, ExitHandler>()
let wired: Promise<void> | null = null

function wire(): Promise<void> {
  wired ??= Promise.all([
    tauriListen<{ id: string; data: string }>('terminal:output', (e) => {
      outputs.get(e.id)?.(e.data)
    }),
    tauriListen<{ id: string; code: number | null }>('terminal:exit', (e) => {
      exits.get(e.id)?.(e.code ?? null)
    }),
  ]).then(() => undefined)
  return wired
}

/**
 * 开一条终端，**返回要回放的那段输出**。
 *
 * 接上一条已经在跑的会话时返回它的回放缓冲（外壳侧维护，见 `terminal.rs`），
 * 新起的会话返回空串。调用方要把它原样写进 xterm——那是重建屏幕，不是历史记录。
 */
export async function openTerminal(
  id: string,
  cwd: string,
  cols: number,
  rows: number,
  on: { output: OutputHandler; exit: ExitHandler },
): Promise<string> {
  outputs.set(id, on.output)
  exits.set(id, on.exit)
  // 先挂监听再开进程：反过来的话 shell 的第一行提示符可能在监听装好之前就输出完了，
  // 表现是终端开出来是空白的，敲一下回车才冒出提示符。
  await wire()
  return await tauriInvoke<string>('terminal_open', { id, cwd, cols, rows })
}

/** 外壳那边还开着哪几条会话。页签据此恢复，见 store 的 `restoreTerminalTabs`。 */
export function listTerminals(): Promise<string[]> {
  return tauriInvoke<string[]>('terminal_list')
}

export function writeTerminal(id: string, data: string): Promise<void> {
  return tauriInvoke<void>('terminal_write', { id, data })
}

export function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  return tauriInvoke<void>('terminal_resize', { id, cols, rows })
}

/**
 * 关掉一条终端：先摘监听，再让 Rust 杀掉 shell。
 *
 * **顺序不能反。** kill 会让收尸线程 emit 一次 `terminal:exit`，反过来的话那条事件
 * 会打进一个已经销毁的 xterm 实例。
 */
export function closeTerminal(id: string): Promise<void> {
  outputs.delete(id)
  exits.delete(id)
  return tauriInvoke<void>('terminal_close', { id })
}
