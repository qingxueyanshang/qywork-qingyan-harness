/**
 * 受控页面上的观察与动作判定。
 *
 * 覆盖范围：`page.ts` 全部（AX 树与 DOM 快照的合并、可操作元素筛选、翻页、
 * 文档令牌与身份指纹的失效判定、命中点复核、五种动作的发送形状、上传、下载触发）。
 *
 * 对端是一个按脚本回帧的假调试端点：被测的是**客户端发出了什么、在什么条件下拒绝**。
 * 真浏览器上的动态 DOM、重名按钮、跨站 iframe、Shadow DOM 由端到端脚本覆盖，
 * 那些验的是另一件事（真实渲染引擎认不认），这里验的是判定本身。
 */

import { afterEach, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { CdpClient } from './cdp.ts'
import {
  actOnPage,
  BrowserAmbiguousRefError,
  BrowserStaleRefError,
  observePage,
  type PageHandle,
  uploadToPage,
  waitOnPage,
} from './page.ts'

interface Command {
  id: number
  method: string
  sessionId?: string
  params?: Record<string, unknown>
}

/** 一个可以被改写的页面模型。测试改它，客户端按 CDP 读它。 */
interface PageModel {
  token: string
  url: string
  title: string
  /** backendNodeId → 标签与属性。 */
  nodes: { backendNodeId: number; tag: string; attrs: Record<string, string> }[]
  ax: { backendDOMNodeId: number; role: string; name: string; value?: string; ignored?: boolean }[]
  /** 页内复核的结果，按 backendNodeId 给。缺省是「连着、身份对得上、命中自己」。 */
  inspect: Map<number, Record<string, unknown>>
  /** 已经不在文档里的节点，`DOM.resolveNode` 对它们报错。 */
  gone: Set<number>
  /** 头 N 次 `Accessibility.getFullAXTree` 回空树——模拟 AX 懒计算还没就绪。 */
  axDelayCalls: number
}

function domTree(model: PageModel): Record<string, unknown> {
  return {
    backendNodeId: 1,
    nodeName: '#document',
    nodeType: 9,
    children: model.nodes.map((n) => ({
      backendNodeId: n.backendNodeId,
      nodeName: n.tag.toUpperCase(),
      nodeType: 1,
      attributes: Object.entries(n.attrs).flat(),
      children: [],
    })),
  }
}

class FakePage {
  server: Bun.Server<undefined>
  received: Command[] = []
  model: PageModel = {
    token: 'doc-1',
    url: 'http://fixture/page',
    title: '夹具页',
    nodes: [],
    ax: [],
    inspect: new Map(),
    gone: new Set(),
    axDelayCalls: 0,
  }
  /** 等待器的下一次结果。 */
  waiterResult: Record<string, unknown> = { found: true, id: 1 }

  constructor() {
    const self = this
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(req, srv) {
        const url = new URL(req.url)
        if (url.pathname === '/json/version') {
          return Response.json({
            webSocketDebuggerUrl: `ws://127.0.0.1:${srv.port}/devtools/browser/fake`,
          })
        }
        return srv.upgrade(req) ? undefined : new Response('no', { status: 400 })
      },
      websocket: {
        message(ws: ServerWebSocket<undefined>, raw: string | Buffer) {
          const cmd = JSON.parse(String(raw)) as Command
          self.received.push(cmd)
          const out = self.answer(cmd)
          ws.send(
            JSON.stringify(
              'error' in out
                ? { id: cmd.id, error: { code: -32000, message: String(out.error) } }
                : { id: cmd.id, result: out },
            ),
          )
        },
      },
    })
  }

  answer(cmd: Command): Record<string, unknown> {
    const m = this.model
    switch (cmd.method) {
      case 'Target.getTargets':
        return { targetInfos: [{ targetId: 't1', type: 'page' }] }
      case 'Target.attachToTarget':
        return { sessionId: 's1' }
      case 'DOM.getDocument':
        return { root: domTree(m) }
      case 'Accessibility.getFullAXTree':
        if (m.axDelayCalls > 0) {
          m.axDelayCalls -= 1
          return { nodes: [] }
        }
        return {
          nodes: m.ax.map((n) => ({
            backendDOMNodeId: n.backendDOMNodeId,
            role: { value: n.role },
            name: { value: n.name },
            ...(n.value !== undefined ? { value: { value: n.value } } : {}),
            ...(n.ignored ? { ignored: true } : {}),
          })),
        }
      case 'DOM.resolveNode': {
        const backend = Number(cmd.params?.backendNodeId)
        if (m.gone.has(backend)) return { error: 'Node not found' }
        return { object: { objectId: `obj-${backend}` } }
      }
      case 'Runtime.callFunctionOn': {
        const backend = Number(String(cmd.params?.objectId ?? '').replace('obj-', ''))
        const decl = String(cmd.params?.functionDeclaration ?? '')
        if (decl.includes('SELECT') || decl.includes('el.tagName !== ')) {
          return { result: { value: { ok: true, value: 'b' } } }
        }
        if (decl.includes('setSelectionRange')) return { result: { value: { ok: true, had: 3 } } }
        const node = m.nodes.find((n) => n.backendNodeId === backend)
        const identity = [
          node?.tag ?? '',
          node?.attrs.id ?? '',
          node?.attrs.name ?? '',
          node?.attrs.type ?? '',
        ].join('|')
        return {
          result: {
            value: {
              connected: true,
              identity,
              x: 40,
              y: 20,
              width: 80,
              height: 20,
              sameTree: true,
              hit: node?.tag ?? null,
              disabled: false,
              label: node?.attrs.id ?? '元素',
              ...(m.inspect.get(backend) ?? {}),
            },
          },
        }
      }
      case 'Runtime.evaluate': {
        const expr = String(cmd.params?.expression ?? '')
        if (expr.includes('__qyworkTab')) return { result: { value: 'marker-1' } }
        if (expr.includes('__qyworkDoc')) {
          return { result: { value: { token: m.token, url: m.url, title: m.title } } }
        }
        if (expr.includes('__qyworkWait('))
          return { result: { value: { id: 7, immediate: false } } }
        if (expr.includes('__qyworkAwait(')) return { result: { value: this.waiterResult } }
        if (expr.includes('__qyworkDispose')) {
          return { result: { value: { waiters: 0, observers: 0, timers: 0 } } }
        }
        return { result: { value: null } }
      }
      default:
        return {}
    }
  }

  sent(method: string): Command[] {
    return this.received.filter((c) => c.method === method)
  }

  stop(): void {
    this.server.stop(true)
  }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})

/** 一个带按钮、输入框、下拉和一段正文的页面。 */
function fixtureModel(page: FakePage): void {
  page.model.nodes = [
    { backendNodeId: 10, tag: 'button', attrs: { id: 'go' } },
    { backendNodeId: 11, tag: 'input', attrs: { id: 'box', type: 'text', name: 'q' } },
    { backendNodeId: 12, tag: 'select', attrs: { id: 'pick' } },
    { backendNodeId: 13, tag: 'span', attrs: { id: 'out' } },
    { backendNodeId: 14, tag: 'div', attrs: { id: 'wrap' } },
    { backendNodeId: 15, tag: 'input', attrs: { id: 'file', type: 'file' } },
  ]
  page.model.ax = [
    { backendDOMNodeId: 10, role: 'button', name: '提交' },
    { backendDOMNodeId: 11, role: 'textbox', name: '关键词', value: '' },
    { backendDOMNodeId: 12, role: 'combobox', name: '选择' },
    { backendDOMNodeId: 13, role: 'StaticText', name: '结果：42' },
    { backendDOMNodeId: 14, role: 'generic', name: '' },
    { backendDOMNodeId: 15, role: 'button', name: '选择文件' },
  ]
}

async function connect(page: FakePage): Promise<PageHandle> {
  const client = await CdpClient.connect(page.server.port ?? 0)
  cleanups.push(() => client.close())
  const { sessionId } = await client.attachByMarker('marker-1')
  return { client, sessionId, tabId: 'bt_1' }
}

test('观察把 AX 语义与节点属性合成一张元素表，无角色的容器不进表', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  const handle = await connect(fake)

  const { observation } = await observePage(handle, {})
  expect(observation.url).toBe('http://fixture/page')
  expect(observation.title).toBe('夹具页')
  const byName = new Map(observation.elements.map((e) => [e.name, e]))
  expect(byName.get('提交')?.tag).toBe('button')
  expect(byName.get('关键词')?.inputType).toBe('text')
  expect(byName.get('结果：42')?.role).toBe('StaticText')
  // 无角色无名字的容器不占编号——它对模型没有任何可做的事。
  expect(observation.elements.some((e) => e.tag === 'div')).toBe(false)
  expect(observation.truncated).toBe(false)
})

test('AX 树首拍为空但 DOM 有可交互元素时，重取后拿到元素，不返回 0', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  // 头两次 getFullAXTree 回空树，第三次才给真树——模拟 AX 懒计算刚加载时还没就绪。
  fake.model.axDelayCalls = 2
  const handle = await connect(fake)

  const { observation } = await observePage(handle, {})
  // 静态表单不得因为首拍空树就返回 0 元素。
  expect(observation.elements.length).toBeGreaterThan(0)
  expect(observation.elements.some((e) => e.name === '提交')).toBe(true)
  // 重取过：第一拍加两次重试。
  expect(fake.sent('Accessibility.getFullAXTree').length).toBeGreaterThanOrEqual(3)
})

test('AX 树始终为空时从 DOM 快照兜底出可交互元素，语义降级但不为 0', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  // 超过重取上限都拿不到 AX 树。
  fake.model.axDelayCalls = 1000
  const handle = await connect(fake)

  const { observation } = await observePage(handle, {})
  // DOM 兜底只收真实可交互标签：button / input / select，span 与 div 不进表。
  const tags = observation.elements.map((e) => e.tag).sort()
  expect(tags).toEqual(['button', 'input', 'input', 'select'])
  expect(observation.elements.some((e) => e.tag === 'div' || e.tag === 'span')).toBe(false)
})

test('真的没有可交互元素的页仍返回 0，不重取也不造假元素', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  // 只有一段正文，一个可交互元素都没有。
  fake.model.nodes = [{ backendNodeId: 20, tag: 'p', attrs: { id: 'note' } }]
  fake.model.ax = [{ backendDOMNodeId: 20, role: 'paragraph', name: '说明' }]
  const handle = await connect(fake)

  const { observation } = await observePage(handle, {})
  // 正文进表，可交互元素 0——这是事实，不是缺陷。
  expect(observation.elements.every((e) => e.role !== 'button')).toBe(true)
  // 没有可交互元素就不进重取：只取一次 AX 树。
  expect(fake.sent('Accessibility.getFullAXTree')).toHaveLength(1)
})

test('元素超过上限时如实报截断，offset 取得到后面的', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fake.model.nodes = Array.from({ length: 130 }, (_, i) => ({
    backendNodeId: 100 + i,
    tag: 'button',
    attrs: { id: `b${i}` },
  }))
  fake.model.ax = fake.model.nodes.map((n, i) => ({
    backendDOMNodeId: n.backendNodeId,
    role: 'button',
    name: `按钮 ${i}`,
  }))
  const handle = await connect(fake)

  const first = await observePage(handle, {})
  expect(first.observation.elements).toHaveLength(120)
  expect(first.observation.truncated).toBe(true)
  const rest = await observePage(handle, { offset: 120 })
  expect(rest.observation.elements).toHaveLength(10)
  expect(rest.observation.truncated).toBe(false)
  expect(rest.observation.elements[0]?.name).toBe('按钮 120')
})

test('点击前复核命中点，落在别的元素上即报歧义且不发鼠标事件', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  const handle = await connect(fake)
  const { record, observation } = await observePage(handle, {})
  const go = observation.elements.find((e) => e.name === '提交')!

  fake.model.inspect.set(10, { sameTree: false, hit: 'div' })
  const before = fake.sent('Input.dispatchMouseEvent').length
  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: go.ref,
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserAmbiguousRefError)
  expect(fake.sent('Input.dispatchMouseEvent')).toHaveLength(before)
})

test('点击命中时按元素中心发下压与抬起两条事件', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  const handle = await connect(fake)
  const { record, observation } = await observePage(handle, {})
  const go = observation.elements.find((e) => e.name === '提交')!

  const r = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: go.ref,
  })
  expect(r.point).toEqual({ x: 40, y: 20 })
  const mouse = fake.sent('Input.dispatchMouseEvent')
  expect(mouse.map((c) => c.params?.type)).toEqual(['mousePressed', 'mouseReleased'])
})

test('换过文档之后整份观察失效，不重新定位到同名元素', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  const handle = await connect(fake)
  const { record, observation } = await observePage(handle, {})
  const go = observation.elements.find((e) => e.name === '提交')!

  fake.model.token = 'doc-2'
  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: go.ref,
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserStaleRefError)
  expect(String((err as Error).message)).toContain('重新观察')
})

test('同一个编号指到另一个节点时判失效，不照旧点下去', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  const handle = await connect(fake)
  const { record, observation } = await observePage(handle, {})
  const go = observation.elements.find((e) => e.name === '提交')!

  // backendNodeId 被复用到了另一个节点：标签与 id 都变了。
  fake.model.nodes = fake.model.nodes.map((n) =>
    n.backendNodeId === 10 ? { ...n, tag: 'a', attrs: { id: 'other' } } : n,
  )
  const before = fake.sent('Input.dispatchMouseEvent').length
  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: go.ref,
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserStaleRefError)
  expect(fake.sent('Input.dispatchMouseEvent')).toHaveLength(before)
})

test('节点已从文档移除时报失效', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  const handle = await connect(fake)
  const { record, observation } = await observePage(handle, {})
  const go = observation.elements.find((e) => e.name === '提交')!

  fake.model.gone.add(10)
  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: go.ref,
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserStaleRefError)
})

test('fill 先聚焦、再选中原有内容、最后插入文本', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  const handle = await connect(fake)
  const { record, observation } = await observePage(handle, {})
  const box = observation.elements.find((e) => e.name === '关键词')!

  await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'fill',
    ref: box.ref,
    text: '批二',
  })
  const order = fake.received
    .map((c) => c.method)
    .filter((m) => m === 'DOM.focus' || m === 'Input.insertText')
  expect(order).toEqual(['DOM.focus', 'Input.insertText'])
  expect(fake.sent('Input.insertText')[0]?.params?.text).toBe('批二')
})

test('press 只认按键表里的名字，认不出的一条事件都不发', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  const handle = await connect(fake)
  const { record } = await observePage(handle, {})

  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'press',
    key: 'Ctrl+Shift+Q',
  }).catch((e: Error) => e.message)
  expect(String(err)).toContain('不支持的按键')
  expect(fake.sent('Input.dispatchKeyEvent')).toHaveLength(0)

  await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'press',
    key: 'Enter',
  })
  expect(fake.sent('Input.dispatchKeyEvent').map((c) => c.params?.type)).toEqual([
    'keyDown',
    'keyUp',
  ])
})

test('scroll 不给元素时作用在整页上', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  const handle = await connect(fake)
  const { record } = await observePage(handle, {})

  await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'scroll',
    deltaY: 300,
  })
  const wheel = fake.sent('Input.dispatchMouseEvent')[0]
  expect(wheel?.params?.type).toBe('mouseWheel')
  expect(wheel?.params?.deltaY).toBe(300)
})

test('等待只观察，结束后清掉页内等待器', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  const handle = await connect(fake)

  fake.waiterResult = { found: false, reason: 'timeout', id: 7 }
  expect(await waitOnPage(handle, '#late', 500)).toEqual({ found: false, reason: 'timeout' })
  const evaluated = fake.sent('Runtime.evaluate').map((c) => String(c.params?.expression))
  expect(evaluated.some((e) => e.includes('__qyworkWait('))).toBe(true)
  expect(evaluated.some((e) => e.includes('__qyworkDispose('))).toBe(true)
  // 等待期间不发任何输入事件。
  expect(fake.sent('Input.dispatchMouseEvent')).toHaveLength(0)
  expect(fake.sent('Input.dispatchKeyEvent')).toHaveLength(0)
})

test('上传把路径原样交给文件输入元素', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  const handle = await connect(fake)
  const { record, observation } = await observePage(handle, {})
  const file = observation.elements.find((e) => e.name === '选择文件')!

  const r = await uploadToPage(handle, record, file.ref, ['C:/ws/a.txt'])
  expect(r.files).toEqual(['C:/ws/a.txt'])
  const sent = fake.sent('DOM.setFileInputFiles')[0]
  expect(sent?.params?.files).toEqual(['C:/ws/a.txt'])
  expect(sent?.params?.backendNodeId).toBe(15)
})
