export type TerminalOperation = 'open' | 'write' | 'resize'

export type TerminalDisconnected = {
  kind: 'disconnected'
  operation: TerminalOperation
  reason: string
}

export type TerminalEnd = { kind: 'exited'; code: number | null } | TerminalDisconnected

export function disconnectedTerminal(
  operation: TerminalOperation,
  error: unknown,
): TerminalDisconnected {
  return {
    kind: 'disconnected',
    operation,
    reason: error instanceof Error ? error.message : String(error),
  }
}

export function terminalEndLabel(end: TerminalEnd): string {
  if (end.kind === 'disconnected') return '终端连接已断开'
  return end.code === null ? '终端进程已退出' : `进程已退出（${end.code}）`
}

export function terminalWheelAction(
  buffer: 'normal' | 'alternate',
  shiftKey: boolean,
): 'native' | 'history' {
  return buffer === 'normal' && shiftKey ? 'history' : 'native'
}
