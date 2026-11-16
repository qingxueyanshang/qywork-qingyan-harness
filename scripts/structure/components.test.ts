/**
 * 覆盖范围：`components.ts` 的组件识别、状态计数与内嵌组件计数，
 * 以及前端全部组件对基线（`baseline.json` 的 `componentStates`、`innerComponents`）的检查。
 *
 * 失败表示组件闭包中的状态或内嵌组件超过上限或基线；处理方向是把状态收拢为组件之外的控制器对象，
 * 把内嵌组件移到独立文件，不是按长度拆分文件。
 */

import { describe, expect, test } from 'bun:test'
import { check, RULES, readBaseline } from './baseline.ts'
import { countComponents, measureComponents } from './components.ts'

const brief = (src: string) =>
  countComponents(src).map(({ name, states, inner }) => ({ name, states, inner }))

describe('组件识别', () => {
  test('函数声明、箭头函数、export default 的具名与匿名函数都识别为组件', () => {
    const src = [
      'export default function Panel() {',
      '  return <div />',
      '}',
      'export const Card = (p: { x: number }) => <span>{p.x}</span>',
      'const Row = function Item() {',
      '  return <li />',
      '}',
    ].join('\n')
    expect(brief(src).map((c) => c.name)).toEqual(['Panel', 'Card', 'Item'])
    expect(brief('export default function () {\n  return <div />\n}')[0]?.name).toBe('default')
    expect(brief('export default () => <div />')[0]?.name).toBe('default')
  })

  test('条件返回与片段同样识别；只在嵌套函数中出现 JSX 的函数与不返回 JSX 的函数不是组件', () => {
    const src = [
      'function Maybe(p: { on: boolean }) {',
      '  if (!p.on) return null',
      '  return p.on ? <A /> : <>b</>',
      '}',
      'function list(items: string[]) {',
      '  return items.map((x) => <li>{x}</li>)',
      '}',
      'function helper() {',
      '  return 1',
      '}',
      'function factory() {',
      '  return function View() {',
      '    return <div />',
      '  }',
      '}',
    ].join('\n')
    expect(brief(src).map((c) => c.name)).toEqual(['Maybe', 'View'])
  })
})

describe('状态计数', () => {
  test('计 createSignal、sessionSignal、createStore、createResource，含带类型参数与经命名空间的调用', () => {
    const src = [
      'export default function Panel() {',
      '  const [a] = createSignal(0)',
      '  const [b] = createSignal<string | null>(null)',
      "  const [c] = sessionSignal('k', 1)",
      '  const [d] = createStore({})',
      '  const [e] = createResource(load)',
      '  const [f] = solid.createSignal(0)',
      '  const g = createMemo(() => a() + 1)',
      '  createEffect(() => g())',
      '  const ctl = createCanvasController()',
      '  return <div />',
      '}',
    ].join('\n')
    expect(brief(src)).toEqual([{ name: 'Panel', states: 6, inner: 0 }])
  })

  test('嵌套的普通函数与匿名回调中的状态计入外层组件', () => {
    const src = [
      'export default function Panel() {',
      '  const make = () => {',
      '    const [x] = createSignal(0)',
      '    return x',
      '  }',
      '  return (',
      '    <For each={items}>',
      '      {(item) => {',
      '        const [open] = createSignal(false)',
      '        return <li />',
      '      }}',
      '    </For>',
      '  )',
      '}',
    ].join('\n')
    expect(brief(src)).toEqual([{ name: 'Panel', states: 2, inner: 0 }])
  })
})

describe('内嵌组件', () => {
  test('组件体内具名定义、返回 JSX 的函数计为内嵌组件；其中的状态计入内嵌组件，不计入外层', () => {
    const src = [
      'export default function Outer() {',
      '  const [a] = createSignal(0)',
      '  function Row(p: { id: string }) {',
      '    const [hover] = createSignal(false)',
      '    const cell = () => <td />',
      '    return <tr>{cell()}</tr>',
      '  }',
      '  const label = () => <b>{a()}</b>',
      '  const title = () => a() + 1',
      '  return <table>{label()}</table>',
      '}',
    ].join('\n')
    expect(brief(src)).toEqual([
      { name: 'Outer', states: 1, inner: 2 },
      { name: 'Outer.Row', states: 1, inner: 1 },
      { name: 'Outer.Row.cell', states: 0, inner: 0 },
      { name: 'Outer.label', states: 0, inner: 0 },
    ])
  })

  test('JSX 中的匿名渲染回调与 fallback 不计为内嵌组件', () => {
    const src = [
      'export default function List() {',
      '  return (',
      '    <Show when={ready()} fallback={<Empty />}>',
      '      <For each={items}>{(x) => <li>{x}</li>}</For>',
      '    </Show>',
      '  )',
      '}',
    ].join('\n')
    expect(brief(src)).toEqual([{ name: 'List', states: 0, inner: 0 }])
  })
})

describe('全仓组件', () => {
  const { states, inner } = measureComponents()

  test('只统计前端的非测试 .tsx', () => {
    const keys = [...states.keys()]
    expect(keys.length).toBeGreaterThan(0)
    expect(keys.filter((k) => !k.startsWith('apps/web/src/') || /\.test\.tsx#/.test(k))).toEqual([])
  })

  test('组件内的状态数不超过上限或基线，基线不留余量', () => {
    expect(check(RULES.componentStates, states, readBaseline().componentStates)).toEqual([])
  })

  test('组件内的内嵌组件数不超过上限或基线，基线不留余量', () => {
    expect(check(RULES.innerComponents, inner, readBaseline().innerComponents)).toEqual([])
  })
})
