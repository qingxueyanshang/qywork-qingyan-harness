import { describe, expect, test } from 'bun:test'
import { processExitObservationFromEnv, sanitizeProcessExitObservation } from './process-exit.ts'

describe('上一份 sidecar 的退出现场', () => {
  test('退出码、信号、时间和 stderr 原样解析，不用真假值吞掉退出码 0', () => {
    expect(
      processExitObservationFromEnv({
        QYWORK_PREVIOUS_EXIT_KIND: 'terminated',
        QYWORK_PREVIOUS_EXIT_AT_MS: '1234',
        QYWORK_PREVIOUS_EXIT_CODE: '0',
        QYWORK_PREVIOUS_EXIT_SIGNAL: '9',
        QYWORK_PREVIOUS_STDERR_TAIL: 'panic at worker.ts:8',
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

  test('缺少可信的种类或时间就忽略，不能把普通 CLI 启动编成崩溃恢复', () => {
    expect(processExitObservationFromEnv({ QYWORK_PREVIOUS_EXIT_CODE: '1' })).toBeUndefined()
    expect(
      processExitObservationFromEnv({
        QYWORK_PREVIOUS_EXIT_KIND: 'terminated',
        QYWORK_PREVIOUS_EXIT_AT_MS: 'not-a-number',
      }),
    ).toBeUndefined()
  })

  test('stderr 在落库前按已知值与 key 形状脱敏', () => {
    const observation = processExitObservationFromEnv({
      QYWORK_PREVIOUS_EXIT_KIND: 'terminated',
      QYWORK_PREVIOUS_EXIT_AT_MS: '1234',
      QYWORK_PREVIOUS_STDERR_TAIL: 'Authorization: sk-test-secret-1234567890',
    })!
    const sanitized = sanitizeProcessExitObservation(observation, {
      values: ['sk-test-secret-1234567890'],
    })
    expect(sanitized.stderrTail).not.toContain('sk-test-secret-1234567890')
    expect(sanitized.stderrTail).toContain('[REDACTED]')
  })
})
