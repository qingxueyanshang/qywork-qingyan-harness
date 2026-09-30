/**
 * 原子替换用的 rename。Windows 上杀毒、索引、同步客户端会在文件刚写完时短暂打开它，
 * 这期间对它的 rename 报 `EPERM` / `EACCES` / `EBUSY`；进程内无法避免，按退避重试。
 * 其他平台上这几个错误码表示真的没有权限，不重试。
 */

import { rename } from 'node:fs/promises'

const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY'])
/** 退避 10、20、40…320 ms，共约 630 ms。实测这类占用在几十毫秒内释放。 */
const RETRIES = 6

/** 按退避重试 `op`，只对 Windows 上的短暂占用错误重试；其余错误与最后一次失败原样抛出。 */
export async function retryWhileBusy<T>(
  op: () => Promise<T>,
  platform: NodeJS.Platform = process.platform,
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await op()
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code
      if (platform !== 'win32' || attempt >= RETRIES || !code || !TRANSIENT.has(code)) throw err
      await new Promise((resolve) => setTimeout(resolve, 10 * 2 ** attempt))
    }
  }
}

export function renameWithRetry(from: string, to: string): Promise<void> {
  return retryWhileBusy(() => rename(from, to))
}
