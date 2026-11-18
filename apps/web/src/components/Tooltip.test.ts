/**
 * 覆盖 `Tooltip.tsx` 的约定：悬停文案一律使用 `data-tip`，原生 `title` 只保留在 `iframe` 上作为无障碍名称。
 * 扫描 `apps/web/src` 下全部非测试 `.tsx`，按语法树判定，组件的同名属性（如 `ConfirmDialog` 的 `title`）不计入。
 *
 * 另覆盖提示的上下位置。原始失败形状：内置浏览器地址栏按钮的提示显示在下方，被地址栏下方的原生子视图遮挡，
 * 始终不可见。
 */
import { afterAll, beforeAll, describe, expect, jest, test } from 'bun:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
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

describe('提示的位置', () => {
  beforeAll(() => {
    GlobalRegistrator.register({ url: 'http://localhost/', height: 768 })
  })
  afterAll(async () => {
    await GlobalRegistrator.unregister()
  })

  /** 悬停在一个上沿 y=100、高 20 的按钮上，返回提示的纵坐标。提示高 24，间距 6。 */
  async function tipTop(place: string | undefined): Promise<number> {
    const { render } = await import('solid-js/web')
    const { Tooltip } = await import('./Tooltip.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(Tooltip, host as unknown as HTMLElement)
    const tip = host.querySelector<HTMLElement>('.tooltip')!
    Object.defineProperty(tip, 'offsetWidth', { value: 40 })
    Object.defineProperty(tip, 'offsetHeight', { value: 24 })
    const target = document.createElement('button')
    target.dataset.tip = '后退'
    if (place) target.dataset.tipPlace = place
    target.getBoundingClientRect = () =>
      ({ left: 10, top: 100, right: 30, bottom: 120, width: 20, height: 20 }) as DOMRect
    document.body.append(target)
    jest.useFakeTimers()
    try {
      target.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse' }))
      jest.advanceTimersByTime(400)
      const y = /translate\([^,]+px, (-?\d+)px\)/.exec(tip.style.transform)?.[1]
      return Number(y)
    } finally {
      jest.useRealTimers()
      dispose()
      host.remove()
      target.remove()
    }
  }

  test('默认显示在下方；带 data-tip-place="above" 时显示在上方', async () => {
    expect(await tipTop(undefined)).toBe(126)
    expect(await tipTop('above')).toBe(70)
  })
})
