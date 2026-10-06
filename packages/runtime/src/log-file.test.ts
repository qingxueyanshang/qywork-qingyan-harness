/** 覆盖 `log-file.ts`：追加、轮转、不镜像时不写入 stderr。 */

import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LogRecord } from '@qywork/core'
import { fileLogSink } from './log-file.ts'

const record = (message: string): LogRecord => ({
  at: Date.UTC(2026, 8, 12),
  level: 'info',
  scope: 't',
  message,
})

describe('fileLogSink', () => {
  test('每条日志追加为一行，目录不存在时创建', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-log-'))
    const sink = fileLogSink(join(root, 'logs'), { mirror: false })
    sink(record('one'))
    sink(record('two'))
    sink.close()
    expect(readFileSync(sink.path, 'utf8').split('\n')).toEqual([
      '2026-09-12T00:00:00.000Z INFO  [t] one',
      '2026-09-12T00:00:00.000Z INFO  [t] two',
      '',
    ])
  })

  test('超过上限时重命名为 .1 并重新打开，只保留一份旧日志', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-log-'))
    const sink = fileLogSink(root, { mirror: false, maxBytes: 60 })
    sink(record('first'))
    sink(record('second'))
    sink(record('third'))
    sink.close()
    const current = readFileSync(sink.path, 'utf8')
    const previous = readFileSync(`${sink.path}.1`, 'utf8')
    expect(current).toContain('third')
    expect(current).not.toContain('second')
    expect(previous).toContain('second')
    expect(previous).not.toContain('first')
    expect(existsSync(`${sink.path}.2`)).toBe(false)
  })

  test('重新打开时从已有文件的大小继续计算', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qy-log-'))
    const first = fileLogSink(root, { mirror: false, maxBytes: 60 })
    first(record('first'))
    first.close()
    const second = fileLogSink(root, { mirror: false, maxBytes: 60 })
    second(record('second'))
    second.close()
    expect(readFileSync(second.path, 'utf8')).toContain('second')
    expect(readFileSync(`${second.path}.1`, 'utf8')).toContain('first')
  })
})
