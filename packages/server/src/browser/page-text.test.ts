/**
 * 页内函数（`page.ts` 的 `INSPECT_FN`、`SELECT_FN`、`FILL_FN`、`TYPING_GUARD_FN`）回归：直接执行页内函数，
 * 验证文字片段而非父容器的几何和命中、元素的命中点落在祖先上时的判定、不可用与只读的统一判定，
 * 以及选择之后被页面改回的回读。
 */
import { expect, test } from 'bun:test'
import { FILL_FN, INSPECT_FN, SELECT_FN, TYPING_GUARD_FN } from './page.ts'

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

test('多行文字取实际文字片段的中心，动作前重新测量，不使用缓存的旧坐标', () => {
  const { state, inspect } = textNode()
  expect(inspect()).toMatchObject({ x: 20, y: 28, sameTree: true, identity: '#text|F1' })
  state.bounds = rect(210, 220, 20, 16)
  state.fragments = [state.bounds]
  expect(inspect()).toMatchObject({ x: 220, y: 228, sameTree: true })
})

test('文字行间空白不是合法落点，兄弟节点遮挡时不因属于同一父容器而放行', () => {
  const { state, inspect } = textNode()
  expect(inspect(50, 25)).toMatchObject({ inBox: false, sameTree: false })
  state.hit = { contains: () => true }
  expect(inspect().sameTree).toBe(false)
})

test('没有文字矩形时不可点击，祖先被禁用时仍拒绝', () => {
  const { node, state, inspect } = textNode()
  node.parentElement.closest = () => ({ disabled: true })
  expect(inspect().disabled).toBe(true)
  state.fragments = []
  expect(inspect()).toMatchObject({ inBox: false, sameTree: false })
})

test('同一文本节点被复用为另一楼层的内容时，身份指纹随之改变', () => {
  const { node, inspect } = textNode()
  expect(inspect().identity).toBe('#text|F1')
  node.nodeValue = 'F2'
  expect(inspect().identity).toBe('#text|F2')
})

/**
 * 原始失败形状：点击落在圆角按钮的左上角，命中的是按钮的父容器，命中判定接受祖先，
 * 点击发往父容器而按钮不响应，结果为成功。
 */
test('命中点落在祖先上不算命中目标，目标为 pointer-events: none 时除外', () => {
  const style = { pointerEvents: 'auto' }
  const container = { tagName: 'DIV', contains: (n: unknown) => n === button, innerText: '开通' }
  const button: Record<string, unknown> = {
    nodeType: 1,
    tagName: 'BUTTON',
    id: '',
    isConnected: true,
    disabled: false,
    innerText: '开通',
    getAttribute: () => null,
    getBoundingClientRect: () => rect(100, 200, 96, 36),
    contains: (n: unknown) => n === button,
    getRootNode: () => ({ elementFromPoint: () => container }),
    ownerDocument: {
      defaultView: { innerWidth: 800, innerHeight: 600, getComputedStyle: () => style },
    },
  }
  const inspect = new Function(`return ${INSPECT_FN}`)() as (
    this: object,
    x?: number,
    y?: number,
  ) => { sameTree: boolean; hit: string | null }
  expect(inspect.call(button, 0, 0)).toMatchObject({ sameTree: false, hit: 'div' })
  style.pointerEvents = 'none'
  expect(inspect.call(button, 0, 0).sameTree).toBe(true)
})

/** 执行一个页内函数。`this` 是给定的假节点。 */
function run<T>(fn: string, self: object, ...args: unknown[]): T {
  return (new Function(`return ${fn}`)() as (this: object, ...a: unknown[]) => T).apply(self, args)
}

/** 按选择器回答 `closest` 的假元素：命中的选择器即该元素自身或某个祖先满足的条件。 */
function control(attrs: Record<string, unknown>, matches: (selector: string) => boolean) {
  return {
    nodeType: 1,
    tagName: 'BUTTON',
    isConnected: true,
    getAttribute: (name: string) => (attrs[name] as string | undefined) ?? null,
    closest: (selector: string) => (matches(selector) ? {} : null),
    ...attrs,
  }
}

/**
 * 原始失败形状：「不可用」有五份判定，点击只看 `el.disabled`，`aria-disabled` 与禁用 fieldset 中的按钮点击报告成功；
 * 选择框不做检查，禁用的 select 被改值；逐字输入不检查只读。各页内函数现在共用同一个判定。
 */
test('不可用与只读的判定各页内函数一致：aria-disabled、祖先禁用与只读均按不可用或只读处理', () => {
  const ariaDisabled = control({}, (s) => s.includes('[aria-disabled="true"]'))
  const inspected = run<{ disabled: boolean }>(INSPECT_FN, {
    ...ariaDisabled,
    getBoundingClientRect: () => rect(0, 0, 10, 10),
    contains: () => true,
    getRootNode: () => ({ elementFromPoint: () => null }),
    ownerDocument: {
      defaultView: { innerWidth: 800, innerHeight: 600, getComputedStyle: () => ({}) },
    },
  })
  expect(inspected.disabled).toBe(true)

  const select = {
    ...control({}, (s) => s.includes(':disabled')),
    tagName: 'SELECT',
    options: [{ value: 'a' }, { value: 'b' }],
  }
  expect(run<{ ok: boolean; reason?: string }>(SELECT_FN, select, 'b')).toEqual({
    ok: false,
    reason: 'disabled',
  })

  const readonly = { ...control({ readOnly: true }, () => false), tagName: 'INPUT', id: '' }
  expect(
    run<{ readonly: boolean }>(TYPING_GUARD_FN, {
      ...readonly,
      getRootNode: () => ({ activeElement: null }),
      ownerDocument: { activeElement: null },
    }).readonly,
  ).toBe(true)
  expect(run<{ ok: boolean; reason?: string }>(FILL_FN, readonly, 'x')).toMatchObject({
    ok: false,
    reason: 'readonly',
  })
})

test('选择之后页面随即改回原选项时按未被接受报告，不按写入的值报告成功', () => {
  const options = [
    { value: 'a', label: 'A' },
    { value: 'b', label: 'B' },
  ]
  const select: Record<string, unknown> = {
    ...control({}, () => false),
    tagName: 'SELECT',
    options,
    selectedIndex: 0,
    dispatchEvent(e: { type: string }) {
      if (e.type === 'change') select.selectedIndex = 0
    },
  }
  expect(run<{ ok: boolean; reason?: string; label?: string }>(SELECT_FN, select, 'b')).toEqual({
    ok: false,
    reason: 'rejected',
    label: 'A',
  })
})
