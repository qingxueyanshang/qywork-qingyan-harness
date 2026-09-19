/**
 * 覆盖 `apps/web/src` 下全部 `.tsx`：本地组件不得与 Solid 的控制流组件同名。
 *
 * 开发模式下 solid-refresh 按组件名登记模块内的组件。本地组件取名 `Switch` 时，
 * 渲染到它的那一刻抛 `Cannot read properties of undefined (reading 'when')`，
 * 外层 `<Switch>/<Match>` 随之停止切换，整个设置弹窗不再响应。生产构建与 happy-dom
 * 下的组件测试都复现不出来，所以按名字守。
 */
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const RESERVED = [
  'Show',
  'For',
  'Index',
  'Switch',
  'Match',
  'Suspense',
  'SuspenseList',
  'ErrorBoundary',
  'Portal',
  'Dynamic',
]

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) tsxFiles(path, out)
    else if (entry.name.endsWith('.tsx') && !entry.name.endsWith('.test.tsx')) out.push(path)
  }
  return out
}

test('本地组件不与 Solid 控制流组件同名', () => {
  const declared = new RegExp(
    `^(?:export\\s+)?(?:function|const)\\s+(${RESERVED.join('|')})\\b`,
    'm',
  )
  const offenders = tsxFiles(join(import.meta.dir, '..'))
    .map((path) => ({ path, hit: declared.exec(readFileSync(path, 'utf8'))?.[1] }))
    .filter((f) => f.hit !== undefined)
    .map((f) => `${f.path}: ${f.hit}`)
  expect(offenders).toEqual([])
})
