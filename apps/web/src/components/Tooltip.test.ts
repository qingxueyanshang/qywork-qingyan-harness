/**
 * 覆盖 `Tooltip.tsx` 的约定：悬停文案一律使用 `data-tip`，原生 `title` 只保留在 `iframe` 上作为无障碍名称。
 * 扫描 `apps/web/src` 下全部非测试 `.tsx`，按语法树判定，组件的同名属性（如 `ConfirmDialog` 的 `title`）不计入。
 */
import { expect, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const src = resolve(import.meta.dir, '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name)
    if (e.isDirectory()) return sources(path)
    return e.name.endsWith('.tsx') && !e.name.includes('.test.') ? [path] : []
  })
}

function nativeTitles(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const hits: string[] = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'title') {
      const tag = node.parent.parent.tagName.getText(sf)
      if (/^[a-z]/.test(tag) && tag !== 'iframe') {
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        hits.push(`${relative(src, file).replaceAll('\\', '/')}:${line} <${tag}>`)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return hits
}

test('悬停文案使用 data-tip：除 iframe 外，元素上没有原生 title', () => {
  expect(sources(src).flatMap(nativeTitles)).toEqual([])
})
