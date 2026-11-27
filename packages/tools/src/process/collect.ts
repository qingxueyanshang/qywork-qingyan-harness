/** 等待子进程结束并读取其输出。与 `spawn.ts` 的 `spawnGuarded` 配对：启动与等待各有唯一入口。 */

import type { ProcessLike } from '../runner.ts'
import { makeOutputDecoder } from './decode.ts'
import { killTree } from './tree.ts'

/**
 * 进程退出后，读取管道中剩余字节的时限。
 *
 * 这不是超时后备处理：正常命令上它没有开销，EOF 紧随退出到达，下方的 race
 * 立即结束。只有后代进程持有写端时才产生这一次固定的少量等待。
 *
 * 取值依据：写端在管道写满时阻塞，因此进程退出前其输出已被读取
 * （本机实测 `seq 1 200000` 加一个后台孙进程，退出时 1288895 字节完整无缺，
 * 最后一个 chunk 比退出早 9ms）；退出后剩余的至多是一个内核缓冲区
 * （Windows 默认 64KB），读取它只是本地内存拷贝。200ms 是为调度抖动留的余量，
 * 不是为命令留的时间。
 */
const DRAIN_AFTER_EXIT_MS = 200

export interface CollectedProcess {
  exitCode: number
  stdout: string
  stderr: string
  /** `timeoutMs` 到期，或 `idleMs` 到期且 `busy` 判定进程树没有在工作，进程树已终止。 */
  timedOut: boolean
  /**
   * 进程已经退出，但仍有后代进程持有输出管道，读取由本地主动结束。
   *
   * 调用方应据此告知上游：后台仍有进程在运行，其后续输出不在本结果中。
   * 启动后台服务的脚本属于这种情况，且结果中没有其他迹象。
   */
  backgroundHeld: boolean
}

export interface CollectOptions {
  /** 到期后终止进程树。不提供时不设超时，只适用于不可能长时间运行的命令。 */
  timeoutMs?: number
  /**
   * 无输出时限：任一条流每收到一片输出即重置计时，到期后终止进程树并报告 `timedOut`。
   *
   * 与 `timeoutMs` 相互独立，两者都提供时先到期的生效。二者判据不同：
   * `timeoutMs` 计量总时长，无法区分仍在输出与已停止响应；
   * `idleMs` 计量两片输出之间的间隔，只要仍在输出就持续等待。
   */
  idleMs?: number
  /**
   * `idleMs` 到期时先调用：返回 true 表示进程树仍在工作（占用 CPU、读写磁盘），重新计时而不终止。
   * 没有输出不等于没有进展：输出接到 `| tail` 时在命令结束后才一次送出，长时间计算本身也可能不输出。
   */
  busy?: () => Promise<boolean>
  /** 中断信号。abort 时终止进程树，使用户点击停止后子进程确实停止。 */
  signal?: AbortSignal
  /** 每片解码后的文本先经过此函数，其返回值计入结果。脱敏与流式回传都在此完成。 */
  onText?: (channel: 'stdout' | 'stderr', text: string) => string
  /** 流结束时追加的内容（通常是脱敏器的跨片缓冲）。返回值不再经过 `onText`。 */
  onEnd?: (channel: 'stdout' | 'stderr') => string
  /**
   * 每条流的字符上限。它限制的是读取本身，而不只是返回值：
   * 读取完毕再截断时，一条 `yes` 命令会在截断生效之前耗尽内存。
   * 是否达到上限由调用方判断（长度达到上限即是），此处只负责停止读取。
   */
  maxChars?: number
}

/**
 * 等待子进程执行完毕，并读取其输出的字节。
 *
 * 这是等待子进程的唯一入口，理由与 `spawnGuarded` 是启动子进程的唯一入口相同：
 * 等待逻辑分散在各处时，完成判据需要分别实现，实现错误的一处不会报错，
 * 只会永久阻塞。
 *
 * 完成判据是进程退出，不是管道 EOF。EOF 表示所有继承了写端的进程都已关闭写端，这取决于
 * 一组不属于本次调用的进程。任何经 shell 派生、脱离父子关系后继续存活的进程都能永久持有
 * 写端，启动后台服务的脚本正是这种情况，且这是脚本的正确行为：服务本应继续运行。
 * 实测 `bash -c 'echo hello; sleep 20 &'`：26ms 收到退出码，6 秒后 EOF 仍未到达。
 *
 * 以 EOF 为判据的代价不限于本次调用：调用方不返回 → `run-control` 的 finally
 * 不执行 → `runs.release` 不执行 → 该会话此后拒绝所有新任务，且用户点击
 * 停止也无法停止（停止只是 abort，无法结束一个不返回的 await），直到重启服务。
 *
 * 退出后仍需短暂等待：退出后立即停止读取会静默丢失字节，内核缓冲中可能还有最后一段输出。
 * 因此退出后留出 `DRAIN_AFTER_EXIT_MS` 读取剩余字节，到期仍无 EOF 即判定有后代进程持有写端，
 * 取消读取并如实报告 `backgroundHeld`。
 */
export async function collectProcess(
  proc: ProcessLike,
  opts: CollectOptions = {},
): Promise<CollectedProcess> {
  const text: Record<'stdout' | 'stderr', string> = { stdout: '', stderr: '' }
  let timedOut = false
  let backgroundHeld = false
  // 类型从 `getReader()` 推断：直接写 `ReadableStreamDefaultReader` 会使用
  // Bun 的全局声明（多一个 `readMany`），与 `node:stream/web` 的声明不一致。
  const readers: ReturnType<ReadableStream<Uint8Array>['getReader']>[] = []

  // 无输出计时。每片输出重置一次，因此计量的是两片之间的间隔而不是总时长。
  // 进程退出后必须停止：退出后还有一段读取剩余缓冲的时间，其间没有输出属于正常情况，
  // 不停止时一次正常退出会被报告为 `timedOut`。
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  // 每次计时一个序号：检查进程树期间若收到输出（序号已变）或进程已退出，本次到期作废。
  let idleGen = 0
  let finished = false
  const stopIdle = () => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = null
  }
  const armIdle = () => {
    if (opts.idleMs === undefined) return
    stopIdle()
    const gen = ++idleGen
    idleTimer = setTimeout(() => void onIdle(gen), opts.idleMs)
  }
  const onIdle = async (gen: number) => {
    const working = opts.busy ? await opts.busy().catch(() => false) : false
    if (gen !== idleGen || finished) return
    if (working) {
      armIdle()
      return
    }
    timedOut = true
    killTree(proc)
  }

  // 使用显式 reader 而不是 `for await`：后者把流锁定在循环中，结束时在外部调用
  // `stream.cancel()` 会直接抛出 `locked`；若不 cancel 而只是放弃该 promise，
  // 孤儿进程向管道写入多少，此处内存就增长多少，造成内存泄漏。
  const pump = async (stream: ReadableStream<Uint8Array>, channel: 'stdout' | 'stderr') => {
    const reader = stream.getReader()
    readers.push(reader)
    const decoder = makeOutputDecoder()
    const append = (decoded: string) => {
      text[channel] += opts.onText ? opts.onText(channel, decoded) : decoded
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        armIdle()
        append(decoder.write(value))
        if (opts.maxChars !== undefined && text[channel].length >= opts.maxChars) {
          // 必须 cancel，不能只 break。读端未关闭时，写端写满后阻塞，
          // 进程无法退出，输出上限会成为新的阻塞点。
          await reader.cancel().catch(() => {})
          break
        }
      }
    } finally {
      // 解码器暂存的末尾一行先经过 `onText`，再取 `onEnd`：脱敏器的跨片缓冲须包含这一行。
      const rest = decoder.end()
      if (rest) append(rest)
      const tail = opts.onEnd?.(channel)
      if (tail) text[channel] += tail
    }
  }

  // 先启动计时再开始读取：不输出任何字节的进程同样必须在到期时终止。
  armIdle()
  const pumping = Promise.all([pump(proc.stdout, 'stdout'), pump(proc.stderr, 'stderr')])

  // 总时长到期、无输出到期与中断都终止整个进程树：启动的是 shell 或会派生子进程的程序，
  // 只终止它本身时，实际执行命令的进程仍在运行（详见 `killTree`）。
  const timer =
    opts.timeoutMs === undefined
      ? null
      : setTimeout(() => {
          timedOut = true
          killTree(proc)
        }, opts.timeoutMs)
  const onAbort = () => killTree(proc)
  opts.signal?.addEventListener('abort', onAbort, { once: true })
  // 注册之前已中止的信号不再派发 abort 事件，只注册时进程运行到自行退出为止。
  if (opts.signal?.aborted) onAbort()

  try {
    const exitCode = await proc.exited
    finished = true
    stopIdle()
    const drained = await Promise.race([
      pumping.then(() => true),
      Bun.sleep(DRAIN_AFTER_EXIT_MS).then(() => false),
    ])
    if (!drained) {
      backgroundHeld = true
      for (const reader of readers) await reader.cancel().catch(() => {})
      await pumping
    }
    return { exitCode, stdout: text.stdout, stderr: text.stderr, timedOut, backgroundHeld }
  } finally {
    if (timer !== null) clearTimeout(timer)
    finished = true
    stopIdle()
    opts.signal?.removeEventListener('abort', onAbort)
  }
}
