/**
 * 日志文件 sink：一行一条追加，超过上限改名成 `.1` 后重开。
 *
 * 同步写。日志量小（连接开合、启动停止、异常），而进程级兜底要在 `exit(1)` 之前把
 * 最后一行落盘，异步写做不到。
 *
 * 默认同时镜像到 stderr：终端里跑 `qy serve` 的人照旧看得到，桌面壳也照旧能攒
 * stderr 尾部作退出记录。
 */

import { closeSync, fstatSync, mkdirSync, openSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { formatLogLine, type LogSink } from '@qywork/core'

export const LOG_FILE = 'qy.log'
const MAX_BYTES = 5 * 1024 * 1024

export interface FileLogSink extends LogSink {
  path: string
  close(): void
}

export function fileLogSink(
  dir: string,
  opts: { file?: string; maxBytes?: number; mirror?: boolean } = {},
): FileLogSink {
  const path = join(dir, opts.file ?? LOG_FILE)
  const maxBytes = opts.maxBytes ?? MAX_BYTES
  const mirror = opts.mirror ?? true
  mkdirSync(dir, { recursive: true })
  let fd = openSync(path, 'a')
  let size = fstatSync(fd).size

  const rotate = (): void => {
    closeSync(fd)
    // 只留上一份：日志不是账本，保两份足够回看一次故障。
    renameSync(path, `${path}.1`)
    fd = openSync(path, 'a')
    size = 0
  }

  const sink = ((record) => {
    const line = `${formatLogLine(record)}\n`
    if (mirror) process.stderr.write(line)
    const bytes = Buffer.byteLength(line)
    if (size > 0 && size + bytes > maxBytes) rotate()
    size += writeSync(fd, line)
  }) as FileLogSink
  sink.path = path
  sink.close = () => closeSync(fd)
  return sink
}
