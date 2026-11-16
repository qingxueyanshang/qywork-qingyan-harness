/**
 * 桌面外壳把上一个 qy serve 进程的终态交给恢复进程时使用的字段，只含必要字段。
 * 它随凭据经标准输入的那一行 JSON 交付（`previousExit`），不经环境变量：其中的 stderr 尾部
 * 可能含有任意输出，环境块由 serve 启动的全部子进程继承。
 */

import type { ProcessExitObservation } from '@qywork/store'
import { redactSecrets } from '@qywork/tools'

const KINDS = new Set<unknown>(['terminated', 'output_channel_closed'])

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 解析 `previousExit`：`{ kind, observedAtMs, code, signal, stderrTail }`。
 * 缺少可信的种类或时间时返回 undefined：不能把普通启动记为崩溃恢复。
 */
export function processExitObservationOf(value: unknown): ProcessExitObservation | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const fields = value as Record<string, unknown>
  const observedAt = finiteNumber(fields.observedAtMs)
  if (!KINDS.has(fields.kind) || observedAt === null) return undefined
  return {
    source: 'desktop_sidecar',
    observedAt,
    exitKind: fields.kind as ProcessExitObservation['exitKind'],
    exitCode: finiteNumber(fields.code),
    signal: finiteNumber(fields.signal),
    stderrTail: typeof fields.stderrTail === 'string' ? fields.stderrTail.trim() || null : null,
  }
}

/** 原生层无法读取 provider 配置；到 server 持久化边界才有完整的凭证集，可据此安全脱敏。 */
export function sanitizeProcessExitObservation(
  observation: ProcessExitObservation,
  secrets: { values: string[] },
): ProcessExitObservation {
  return {
    ...observation,
    stderrTail: observation.stderrTail
      ? redactSecrets(observation.stderrTail, secrets).slice(-8_192)
      : null,
  }
}
