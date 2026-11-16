import { describe, expect, test } from 'bun:test'
import { processExitObservationOf, sanitizeProcessExitObservation } from './process-exit.ts'

describe('上一个 sidecar 进程的退出信息', () => {
  test('退出码、信号、时间和 stderr 原样解析，不因按真假值判断而丢失退出码 0', () => {
    expect(
      processExitObservationOf({
        kind: 'terminated',
        observedAtMs: 1234,
        code: 0,
        signal: 9,
        stderrTail: 'panic at worker.ts:8',
      }),
    ).toEqual({
      source: 'desktop_sidecar',
      observedAt: 1234,
      exitKind: 'terminated',
      exitCode: 0,
      signal: 9,
      stderrTail: 'panic at worker.ts:8',
    })
  })

  test('缺少可信的种类或时间时忽略，不能把普通 CLI 启动记为崩溃恢复', () => {
    expect(processExitObservationOf({ code: 1 })).toBeUndefined()
    expect(processExitObservationOf({ kind: 'terminated', observedAtMs: '1234' })).toBeUndefined()
    expect(processExitObservationOf('terminated')).toBeUndefined()
  })

  test('stderr 在落库前按已知值与 key 形状脱敏', () => {
    const observation = processExitObservationOf({
      kind: 'terminated',
      observedAtMs: 1234,
      code: null,
      signal: null,
      stderrTail: 'Authorization: sk-test-secret-1234567890',
    })!
    const sanitized = sanitizeProcessExitObservation(observation, {
      values: ['sk-test-secret-1234567890'],
    })
    expect(sanitized.stderrTail).not.toContain('sk-test-secret-1234567890')
    expect(sanitized.stderrTail).toContain('[REDACTED]')
  })
})
