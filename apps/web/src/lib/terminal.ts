/**
 * 终端桥：xterm 与 Rust PTY 之间的唯一中间层。
 *
 * 仅桌面端存在。PTY 是本机进程与一对系统句柄，无法跨网络使用；调用方应在渲染
 * 入口之前用 `isDesktopShell()` 排除非桌面端，而不是由此处抛出异常（CLAUDE.md B5）。
 *
 * 事件订阅全局只注册一次，按会话 id 分发。若每打开一个终端各注册一个监听，
 * 已关闭终端的监听无人注销，输出会被投递给已销毁的 xterm 实例。
 */

import { tauriInvoke, tauriListen } from './store/index.ts'

/** `terminal_list` 的一行。与 Rust `TerminalSession` 结构相同。 */
export interface TerminalSession {
  id: string
  /** 该会话所属的工作区 id。创建后不再修改。 */
  workspaceId: string
  /** 外壳进程中的创建序号，与内置浏览器页共用一个计数器。页签条按它排序。 */
  createdSeq: number
}

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
 * 打开一个终端，返回需要回放的输出。
 *
 * 重新连接已在运行的会话时返回其回放缓冲（由外壳侧维护，见 `terminal.rs`），
 * 新建的会话返回空串。调用方须将其原样写入 xterm：这是重建屏幕内容，不是历史记录。
 *
 * `workspaceId` 是该会话的归属，重新连接时外壳按它核对：与记录不一致的工作区会被拒绝。
 */
export async function openTerminal(
  id: string,
  workspaceId: string,
  cwd: string,
  cols: number,
  rows: number,
  on: { output: OutputHandler; exit: ExitHandler },
): Promise<string> {
  outputs.set(id, on.output)
  exits.set(id, on.exit)
  // 先注册监听再启动进程：顺序相反时 shell 的第一行提示符可能在监听注册之前就已输出，
  // 终端打开后为空白，按一次回车才显示提示符。
  await wire()
  return await tauriInvoke<string>('terminal_open', { id, workspaceId, cwd, cols, rows })
}

export function writeTerminal(id: string, data: string): Promise<void> {
  return tauriInvoke<void>('terminal_write', { id, data })
}

export function resizeTerminal(id: string, cols: number, rows: number): Promise<void> {
  return tauriInvoke<void>('terminal_resize', { id, cols, rows })
}

/**
 * 关闭一个终端：先移除监听，再由 Rust 结束 shell 进程。
 *
 * 顺序不能颠倒：kill 会使回收线程 emit 一次 `terminal:exit`，顺序颠倒时该事件
 * 会被投递给已销毁的 xterm 实例。
 */
export function closeTerminal(id: string): Promise<void> {
  outputs.delete(id)
  exits.delete(id)
  return tauriInvoke<void>('terminal_close', { id })
}
