/** 文本指针定位回归：直接执行页内函数，验证文字片段而非父容器的几何和命中。 */
import { expect, test } from 'bun:test'
import { INSPECT_FN } from './page.ts'

const rect = (x: number, y: number, width: number, height: number) => ({
  x,
  y,
  width,
  height,
  left: x,
  top: y,
  right: x + width,
  bottom: y + height,
})

function textNode() {
  const parent = { closest: () => null as object | null }
  const state = {
    bounds: rect(10, 20, 200, 60),
    fragments: [rect(10, 20, 20, 16), rect(10, 60, 200, 16)],
    hit: parent as object | null,
  }
  const node = {
    nodeType: 3,
    nodeValue: 'F1',
    isConnected: true,
    parentElement: parent,
    ownerDocument: {
      defaultView: { innerWidth: 800, innerHeight: 600 },
      createRange: () => ({
        selectNodeContents: (target: unknown) => expect(target).toBe(node),
        getBoundingClientRect: () => state.bounds,
        getClientRects: () => state.fragments,
      }),
    },
    getRootNode: () => ({ elementFromPoint: () => state.hit }),
  }
  const inspect = new Function(`return ${INSPECT_FN}`)() as (
    this: object,
    x?: number,
    y?: number,
  ) => {
    x: number
    y: number
    identity: string
    sameTree: boolean
    inBox: boolean
    disabled: boolean
  }
  return { node, state, inspect: (x?: number, y?: number) => inspect.call(node, x, y) }
}

test('多行文字取真实文字片段中心，动作前重新量取而非缓存旧坐标', () => {
  const { state, inspect } = textNode()
  expect(inspect()).toMatchObject({ x: 20, y: 28, sameTree: true, identity: '#text|F1' })
  state.bounds = rect(210, 220, 20, 16)
  state.fragments = [state.bounds]
  expect(inspect()).toMatchObject({ x: 220, y: 228, sameTree: true })
})

test('文字行间空白不成为合法落点，兄弟遮挡不按同一父容器放行', () => {
  const { state, inspect } = textNode()
  expect(inspect(50, 25)).toMatchObject({ inBox: false, sameTree: false })
  state.hit = { contains: () => true }
  expect(inspect().sameTree).toBe(false)
})

test('没有文字矩形不能点击，禁用祖先仍拒绝', () => {
  const { node, state, inspect } = textNode()
  node.parentElement.closest = () => ({ disabled: true })
  expect(inspect().disabled).toBe(true)
  state.fragments = []
  expect(inspect()).toMatchObject({ inBox: false, sameTree: false })
})

test('复用同一文本节点改成另一楼层，身份指纹同步改变', () => {
  const { node, inspect } = textNode()
  expect(inspect().identity).toBe('#text|F1')
  node.nodeValue = 'F2'
  expect(inspect().identity).toBe('#text|F2')
})
