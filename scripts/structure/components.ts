/**
 * 组件闭包计数：每个组件函数体内的响应式状态数与内嵌组件数。
 *
 * 组件：有名称、且自身的 `return`（或箭头函数的表达式体）含 JSX 的函数。名称取自函数声明、
 * 以函数初始化的变量、函数表达式自身的名称；`export default` 的匿名函数记为 `default`。
 * 不计匿名函数：JSX 中的渲染回调（`<For>{(x) => …}</For>`、`fallback`）与对象属性中的函数。
 * 判断是否返回 JSX 时不进入嵌套函数：`return list.map((x) => <li />)` 的外层函数不算组件。
 *
 * 归属：组件体内任意深度（含回调与立即执行的函数）的状态创建调用计入该组件；内嵌组件中的调用计入内嵌组件，
 * 不计入外层。内嵌组件本身也是组件，按同一上限检查，名称记为 `外层.内层`。
 *
 * 两个数度量的是移出一段代码时须逐个传递的闭包变量，不是文件规模。超过时的处理方向是把状态收拢为一个控制器对象、
 * 把内嵌组件移到独立文件并以控制器为参数或经 context 取得状态（`apps/web/src/components/canvas/board/controller.ts`
 * 的做法），不是把组件按长度拆成两个文件。
 */

import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import ts from 'typescript'
import { sourceFiles } from '../writing-style.ts'

const ROOT = join(import.meta.dir, '..', '..')

/** 未列入基线的组件允许的最大状态数。 */
export const STATE_CAP = 8
/** 未列入基线的组件允许的最大内嵌组件数。 */
export const INNER_CAP = 1

/**
 * 计为状态的创建函数：持有值的响应式源。派生值（`createMemo`）与副作用（`createEffect`）不计；
 * 返回多个信号的组合函数（`createCanvasController` 一类）不计，它们正是把状态移出组件闭包的做法。
 */
const STATE_CREATORS = new Set(['createSignal', 'createStore', 'sessionSignal', 'createResource'])

export interface ComponentCount {
  /** 组件名；内嵌组件为 `外层.内层`。 */
  name: string
  states: number
  inner: number
}

type Fn = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction

function isFn(node: ts.Node): node is Fn {
  return ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
}

function nameOf(fn: Fn): string | null {
  if (fn.name) return fn.name.text
  const parent = fn.parent
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
  if (ts.isExportAssignment(parent)) return 'default'
  if (ts.isFunctionDeclaration(fn)) return 'default'
  return null
}

/** 节点中含 JSX；不进入嵌套函数。 */
function hasJsx(node: ts.Node): boolean {
  if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node))
    return true
  if (isFn(node)) return false
  return ts.forEachChild(node, hasJsx) ?? false
}

/** 自身的 `return` 含 JSX；嵌套函数中的 `return` 不计。 */
function returnsJsx(fn: Fn): boolean {
  const body = fn.body
  if (body === undefined) return false
  if (!ts.isBlock(body)) return hasJsx(body)
  const visit = (node: ts.Node): boolean => {
    if (isFn(node)) return false
    if (ts.isReturnStatement(node)) return node.expression !== undefined && hasJsx(node.expression)
    return ts.forEachChild(node, visit) ?? false
  }
  return visit(body)
}

function isStateCall(node: ts.Node): boolean {
  if (!ts.isCallExpression(node)) return false
  const callee = node.expression
  const name = ts.isIdentifier(callee)
    ? callee.text
    : ts.isPropertyAccessExpression(callee)
      ? callee.name.text
      : null
  return name !== null && STATE_CREATORS.has(name)
}

/** 统计一份 `.tsx` 源码中的全部组件，按出现顺序返回。 */
export function countComponents(src: string): ComponentCount[] {
  const sf = ts.createSourceFile(
    'component.tsx',
    src,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  )
  const out: ComponentCount[] = []
  const visit = (node: ts.Node, owner: ComponentCount | null): void => {
    const name = isFn(node) && returnsJsx(node) ? nameOf(node) : null
    if (name !== null) {
      const record = { name: owner ? `${owner.name}.${name}` : name, states: 0, inner: 0 }
      if (owner) owner.inner++
      out.push(record)
      ts.forEachChild(node, (child) => visit(child, record))
      return
    }
    if (owner && isStateCall(node)) owner.states++
    ts.forEachChild(node, (child) => visit(child, owner))
  }
  visit(sf, null)
  return out
}

/** 前端（`apps/web/src`）非测试的 `.tsx`，相对仓库根、以 `/` 分隔。扫描范围取 `writing-style.ts` 的 `sourceFiles()`。 */
function componentFiles(): string[] {
  return sourceFiles()
    .map((f) => relative(ROOT, f).replaceAll('\\', '/'))
    .filter(
      (rel) =>
        rel.startsWith('apps/web/src/') &&
        rel.endsWith('.tsx') &&
        !/\.test\.tsx$|\/tests?\//.test(rel),
    )
}

/**
 * 前端全部非测试 `.tsx` 中各组件的状态数与内嵌组件数，键为 `相对路径#组件名`。
 * 同一文件中重名的组件依次加后缀 ` (2)`、` (3)`，不互相覆盖。
 */
export function measureComponents(): { states: Map<string, number>; inner: Map<string, number> } {
  const states = new Map<string, number>()
  const inner = new Map<string, number>()
  for (const rel of componentFiles()) {
    for (const c of countComponents(readFileSync(join(ROOT, rel), 'utf8'))) {
      let key = `${rel}#${c.name}`
      for (let k = 2; states.has(key); k++) key = `${rel}#${c.name} (${k})`
      states.set(key, c.states)
      inner.set(key, c.inner)
    }
  }
  return { states, inner }
}
