import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, watch } from 'node:fs'
import { join, relative } from 'node:path'

/** Windows 的访问时间通知也会触发 change；只有文件路径或内容变化才通知重载。 */
export function watchSource(
  root: string,
  include: (file: unknown) => boolean,
  onChange: () => void,
): ReturnType<typeof watch> {
  const included = (file: string): boolean =>
    !/(^|\/)(node_modules|dist|\.git)(\/|$)/.test(file) && include(file)
  const fingerprint = (file: string): string | null => {
    try {
      return createHash('sha256')
        .update(readFileSync(join(root, file)))
        .digest('hex')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null
      throw error
    }
  }
  const scan = (): Map<string, string> => {
    const files = new Map<string, string>()
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', '.git'].includes(entry.name) || entry.isSymbolicLink())
          continue
        const path = join(dir, entry.name)
        if (entry.isDirectory()) visit(path)
        else if (entry.isFile()) {
          const file = relative(root, path).replaceAll('\\', '/')
          if (!included(file)) continue
          const value = fingerprint(file)
          if (value !== null) files.set(file, value)
        }
      }
    }
    visit(root)
    return files
  }

  let files = scan()
  return watch(root, { recursive: true }, (event, name) => {
    // 目录重命名可能只通知目录本身，必须比较整个文件集合。
    if (event === 'rename' || name === null) {
      const next = scan()
      const changed =
        next.size !== files.size || [...next].some(([file, value]) => files.get(file) !== value)
      files = next
      if (changed) onChange()
      return
    }
    const file = name.replaceAll('\\', '/')
    if (!included(file)) return
    const value = fingerprint(file)
    if (value === (files.get(file) ?? null)) return
    if (value === null) files.delete(file)
    else files.set(file, value)
    onChange()
  })
}
