/**
 * 测试进程的内存看门狗，由 `test-setup.ts` 为每个测试文件启动一个。
 *
 * 在工作线程中运行：主线程陷入同步循环时事件循环停止，`--timeout` 与定时器都不再触发，
 * 工作线程仍能检查。`process.memoryUsage().rss` 是整个进程的常驻内存，不只是本线程。
 * 超过上限时结束整个进程，测试工具把该文件记为失败，退出码非零。
 *
 * 提示用 `writeSync(2, …)` 直接写入标准错误：工作线程的 `process.stderr` 经主线程的事件循环转发，
 * 主线程阻塞时这一行不会输出。
 */
import { writeSync } from 'node:fs'
import { workerData } from 'node:worker_threads'

const { file, limitMb } = workerData as { file: string; limitMb: number }

setInterval(() => {
  const mb = process.memoryUsage().rss / 2 ** 20
  if (mb <= limitMb) return
  writeSync(2, `测试进程内存 ${mb.toFixed(0)} MB，超过上限 ${limitMb} MB，已结束进程：${file}\n`)
  process.kill(process.pid, 'SIGKILL')
}, 200)
