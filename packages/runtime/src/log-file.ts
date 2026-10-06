/**
 * 日志文件 sink：每条日志追加为一行，超过上限时重命名为 `.1` 并重新打开。
 *
 * 使用同步写入。日志量小（连接建立与关闭、启动与停止、异常），而进程级后备处理须在
 * `exit(1)` 之前将最后一行写入磁盘，异步写入无法保证这一点。
 *
 * 默认同时镜像到 stderr：在终端中运行 `qy serve` 的用户照常可见，桌面外壳同样能够缓冲
 * stderr 末尾作为退出记录。
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
    // 只保留上一份：日志不是账本，两份足以回溯一次故障。
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
