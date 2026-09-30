/**
 * 覆盖 `rename.ts`：只有 Windows 上的短暂占用错误重试，其余立即抛出，重试有上限。
 */

import { describe, expect, test } from 'bun:test'
import { retryWhileBusy } from './rename.ts'

function failing(codes: string[]): { op: () => Promise<string>; calls: () => number } {
  let n = 0
  return {
    op: async () => {
      const code = codes[n++]
      if (code) throw Object.assign(new Error(code), { code })
      return 'ok'
    },
    calls: () => n,
  }
}

describe('rename 重试', () => {
  test('Windows 上 EPERM、EBUSY 之后成功', async () => {
    const f = failing(['EPERM', 'EBUSY'])
    expect(await retryWhileBusy(f.op, 'win32')).toBe('ok')
    expect(f.calls()).toBe(3)
  })

  test('不是占用错误立即抛出', async () => {
    const f = failing(['ENOENT'])
    await expect(retryWhileBusy(f.op, 'win32')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(f.calls()).toBe(1)
  })

  test('非 Windows 的 EPERM 立即抛出', async () => {
    const f = failing(['EPERM'])
    await expect(retryWhileBusy(f.op, 'linux')).rejects.toMatchObject({ code: 'EPERM' })
    expect(f.calls()).toBe(1)
  })

  test('一直被占用：重试 6 次后抛出最后一次的错误', async () => {
    const f = failing(Array(10).fill('EPERM'))
    await expect(retryWhileBusy(f.op, 'win32')).rejects.toMatchObject({ code: 'EPERM' })
    expect(f.calls()).toBe(7)
  })
})
