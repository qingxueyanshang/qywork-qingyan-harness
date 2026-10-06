/** 覆盖 `terminal-behavior.ts`：终端终态文案与滚轮归属。 */
import { describe, expect, test } from 'bun:test'
import { disconnectedTerminal, terminalEndLabel, terminalWheelAction } from './terminal-behavior.ts'

describe('终端终态', () => {
  test('连接故障与进程退出使用不同状态', () => {
    const disconnected = disconnectedTerminal('resize', new Error('终端会话已不存在'))
    expect(disconnected).toEqual({
      kind: 'disconnected',
      operation: 'resize',
      reason: '终端会话已不存在',
    })
    expect(terminalEndLabel(disconnected)).toBe('终端连接已断开')
    expect(terminalEndLabel({ kind: 'exited', code: 0 })).toBe('进程已退出（0）')
    expect(terminalEndLabel({ kind: 'exited', code: null })).toBe('终端进程已退出')
  })
})

describe('终端滚轮', () => {
  test('普通滚轮事件交给终端程序处理，Shift 加滚轮查看普通缓冲区历史', () => {
    expect(terminalWheelAction('normal', false)).toBe('native')
    expect(terminalWheelAction('normal', true)).toBe('history')
    expect(terminalWheelAction('alternate', false)).toBe('native')
    expect(terminalWheelAction('alternate', true)).toBe('native')
  })
})
