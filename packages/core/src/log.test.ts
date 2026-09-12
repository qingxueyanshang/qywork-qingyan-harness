/** 覆盖 `log.ts`：行格式、字段、续行、sink 注入与 sink 失败时的退路。 */

import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { formatLogLine, type LogRecord, log, setLogSink } from './log.ts'

afterEach(() => setLogSink(null))

describe('formatLogLine', () => {
  const at = Date.UTC(2026, 8, 12, 1, 2, 3, 4)

  test('时间 级别 [scope] 正文', () => {
    expect(formatLogLine({ at, level: 'warn', scope: 'server', message: '端口已占用' })).toBe(
      '2026-09-12T01:02:03.004Z WARN  [server] 端口已占用',
    )
  })

  test('字段跟在正文之后，含空白或等号的字符串加引号', () => {
    const line = formatLogLine({
      at,
      level: 'info',
      scope: 'ws',
      message: 'close',
      fields: { code: 1006, origin: 'desktop', reason: 'a b', empty: '', obj: { x: 1 } },
    })
    expect(line).toBe(
      '2026-09-12T01:02:03.004Z INFO  [ws] close code=1006 origin=desktop reason="a b" empty="" obj={"x":1}',
    )
  })

  test('多行正文缩进成续行，字段留在首行', () => {
    const line = formatLogLine({
      at,
      level: 'error',
      scope: 'process',
      message: 'boom\n  at a\n  at b',
      fields: { code: 1 },
    })
    expect(line.split('\n')).toEqual([
      '2026-09-12T01:02:03.004Z ERROR [process] boom code=1',
      '      at a',
      '      at b',
    ])
  })
})

describe('sink', () => {
  test('注入后 log.* 走注入的 sink', () => {
    const seen: LogRecord[] = []
    setLogSink((r) => seen.push(r))
    log.info('a', 'one')
    log.error('b', 'two', { k: 'v' })
    expect(seen.map((r) => [r.level, r.scope, r.message, r.fields])).toEqual([
      ['info', 'a', 'one', undefined],
      ['error', 'b', 'two', { k: 'v' }],
    ])
  })

  test('sink 抛错时退回 stderr，不向调用方抛', () => {
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      setLogSink(() => {
        throw new Error('disk full')
      })
      expect(() => log.warn('x', 'still logged')).not.toThrow()
      expect(String(write.mock.calls[0]?.[0])).toContain('[x] still logged')
    } finally {
      write.mockRestore()
    }
  })
})
