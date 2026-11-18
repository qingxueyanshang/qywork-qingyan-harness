/**
 * 文件预览的视图状态（缩放与阅读位置），按文件路径记录。切换到其他文件再切回、文件被改写后重新加载、
 * 整页刷新后，同一文件按记录恢复。各预览类型共用这一份记录，状态的结构由各类型自定。
 *
 * 只保留最近查看的 `LIMIT` 个文件：记录随刷新写入 sessionStorage，不限制时会随查看的文件数持续增长。
 */

import { readSession, writeSession } from '../../lib/session.ts'

const KEY = 'qywork.file.views'
const LIMIT = 50

/** 按最近写入的先后排列：最后一项是最近查看的文件。 */
type Views = [path: string, view: unknown][]

function views(): Views {
  return readSession<Views>(KEY) ?? []
}

export function readView<T>(path: string): T | undefined {
  return views().find(([p]) => p === path)?.[1] as T | undefined
}

export function writeView(path: string, view: unknown): void {
  const next = views().filter(([p]) => p !== path)
  next.push([path, view])
  writeSession(KEY, next.slice(-LIMIT))
}

/** 只改写记录中的部分字段，其余字段保留：同一文件的不同视图（渲染结果与源码）各自写入自己的字段。 */
export function patchView(path: string, patch: object): void {
  writeView(path, { ...readView<object>(path), ...patch })
}
