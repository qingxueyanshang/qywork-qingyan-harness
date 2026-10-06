import { resolve } from 'node:path'

const pending = new Map<string, Promise<void>>()

/** 按规范路径串行执行；多个路径按固定顺序加锁，迁移不会因交叉等待而死锁。 */
export async function withFileLocks<T>(paths: string[], action: () => Promise<T>): Promise<T> {
  const keys = [
    ...new Set(
      paths.map((p) => {
        const absolute = resolve(p)
        return process.platform === 'win32' ? absolute.toLowerCase() : absolute
      }),
    ),
  ].sort()
  const releases: (() => void)[] = []
  try {
    for (const key of keys) {
      const previous = pending.get(key) ?? Promise.resolve()
      let release!: () => void
      const current = new Promise<void>((done) => {
        release = done
      })
      pending.set(key, current)
      await previous
      releases.push(() => {
        if (pending.get(key) === current) pending.delete(key)
        release()
      })
    }
    return await action()
  } finally {
    for (const release of releases.reverse()) release()
  }
}
