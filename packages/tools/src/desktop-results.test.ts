/**
 * desktop 结果的投递上限处理。
 *
 * 覆盖范围：`desktop-results.ts` 的上限、大小判定、紧凑表示的无损往返、视图选取、
 * 长值处理、JSONL 存盘、资源引用与实际用量记账、无名结构容器的省略与 `depth` 重算、
 * `rect` 开关、动作字典的分组写法、差异投递的三个条件与差异形状，以及 `desktop.ts` 四个
 * 出口（observe 含附图分支、act、wait、act_sequence）接入它之后的结果形状。
 *
 * 夹具为合成数据：控件名称、值与窗口标题均不取自真实应用或网页。
 */

import { describe, expect, test } from 'bun:test'
import {
  batchRemaining,
  chargeBatchBudget,
  type DesktopElement,
  type DesktopPort,
  type DesktopSnapshot,
  deliveredTokens,
  markCompacted,
  openBatchBudget,
  type SinkPort,
  type ToolContext,
  type ToolOutcome,
} from '@qywork/agent'
import { DEFAULT_DENSITY } from '@qywork/ai'
import {
  desktopActSequenceTool,
  desktopActTool,
  desktopObserveTool,
  desktopWaitTool,
} from './desktop.ts'
import { desktopResult } from './desktop-results.ts'
import { observationBudget } from './sink.ts'

const WINDOW = 200_000
const LIMIT = observationBudget(WINDOW)
/** 单个控件的值长度即超出视图上限。 */
const LONG_VALUE = '合成长文本。'.repeat(10_000)

const 根: DesktopElement = {
  ref: 'e1',
  windowRoot: true,
  depth: 0,
  role: 'window',
  name: '合成窗口',
  automationId: '',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 外层: DesktopElement = {
  ref: 'e2',
  parentRef: 'e1',
  depth: 1,
  role: 'group',
  name: '外层分组',
  automationId: 'outer',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 内层: DesktopElement = {
  ref: 'e3',
  parentRef: 'e2',
  depth: 2,
  role: 'group',
  name: '内层分组',
  automationId: 'inner',
  enabled: true,
  offscreen: false,
  actions: [],
}
/** 值极长的控件，位于表的前部：视图放入它时预算仍充足，值仍只保留前缀。 */
const 长值框: DesktopElement = {
  ref: 'e4',
  parentRef: 'e1',
  depth: 1,
  role: 'edit',
  name: '长值框',
  automationId: 'longValue',
  value: LONG_VALUE,
  enabled: true,
  offscreen: false,
  actions: [{ action: 'set_value', delivery: ['background'] }],
}
const 焦点框: DesktopElement = {
  ref: 'e5',
  parentRef: 'e1',
  depth: 1,
  role: 'edit',
  name: '焦点框',
  automationId: 'focused',
  value: '',
  enabled: true,
  offscreen: false,
  focused: true,
  actions: [{ action: 'set_value', delivery: ['background'] }],
}
/** 动作目标，位于整张表的末尾：进入视图的先后由优先级决定，不由位置决定。 */
const 目标: DesktopElement = {
  ref: 'e6',
  parentRef: 'e3',
  depth: 3,
  role: 'button',
  name: '目标按钮',
  automationId: 'target',
  enabled: true,
  offscreen: false,
  actions: [{ action: 'invoke', delivery: ['background'] }],
}

function filler(count: number): DesktopElement[] {
  return Array.from({ length: count }, (_, i) => ({
    ref: `e${100 + i}`,
    parentRef: 'e1',
    depth: 1,
    role: 'text',
    name: `合成条目 ${i}`,
    automationId: `item-${i}`,
    value: `第 ${i} 行`,
    enabled: true,
    offscreen: false,
    actions: [],
  }))
}

/** 自身带有长值的动作目标，输入动作作用于该控件。 */
const 长值目标: DesktopElement = {
  ref: 'e7',
  parentRef: 'e3',
  depth: 3,
  role: 'edit',
  name: '长值目标',
  automationId: 'longTarget',
  value: LONG_VALUE,
  enabled: true,
  offscreen: false,
  actions: [{ action: 'type_text', delivery: ['foreground'] }],
}

/** 4000 个节点的合成控件表。 */
const 大表: DesktopElement[] = [根, 外层, 内层, 长值框, 焦点框, ...filler(3994), 目标]
const 长值目标表: DesktopElement[] = [根, 外层, 内层, 焦点框, ...filler(3995), 长值目标]
const 小表: DesktopElement[] = [根, 外层, 内层, 目标]

function snapshot(
  elements: DesktopElement[],
  over: Partial<DesktopSnapshot> = {},
): DesktopSnapshot {
  return {
    windowId: 'dw_1',
    app: '合成应用',
    title: '合成标题',
    observationId: 'do_1',
    capturedAt: 1,
    elements,
    truncated: false,
    truncatedBy: [],
    filteredBy: [],
    visited: elements.length,
    windowEnabled: true,
    windowCovered: false,
    ...over,
  }
}

function png(): string {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  new DataView(bytes.buffer).setUint32(16, 40)
  new DataView(bytes.buffer).setUint32(20, 30)
  return Buffer.from(bytes).toString('base64')
}

interface Acted {
  acts: number
}

function fakePort(table: DesktopElement[], acted: Acted): DesktopPort {
  const after = snapshot(table, { observationId: 'do_2' })
  return {
    foregroundEnabled: () => true,
    windows: async () => [{ windowId: 'dw_1', app: '合成应用', title: '合成标题' }],
    observe: async () => snapshot(table),
    elements: (windowId, observationId) =>
      windowId === 'dw_1' && (observationId === 'do_1' || observationId === 'do_2') ? table : null,
    captureImage: async () => ({
      app: '合成应用',
      title: '合成标题',
      imageRef: 'di_1',
      data: png(),
      mime: 'image/png',
      geometry: {
        imageWidth: 40,
        imageHeight: 30,
        screen: { x: 0, y: 0, width: 40, height: 30 },
        dpi: 96,
        generation: '0,0,40,30@96#1',
      },
      source: 'wgc',
      capturedAt: 2,
    }),
    act: async () => {
      acted.acts++
      return { dispatch: 'submitted', actionId: 'da_1', observation: after }
    },
    readText: async () => ({
      app: '合成应用',
      title: '合成标题',
      text: '',
      truncated: false,
      selectionSupport: 'none',
      selection: [],
    }),
    wait: async () => ({ found: true, observation: after }),
    release: async () => {},
  }
}

/** 观察与动作后的重读带有同一个超长标题。 */
function longTitlePort(title: string, acted: Acted): DesktopPort {
  const after = snapshot(大表, { observationId: 'do_2', title })
  return {
    ...fakePort(大表, acted),
    observe: async () => snapshot(大表, { title }),
    act: async () => {
      acted.acts++
      return { dispatch: 'submitted', actionId: 'da_1', observation: after }
    },
  }
}

function fakeSink(): SinkPort & { landed: Uint8Array[]; mimes: (string | null)[] } {
  const landed: Uint8Array[] = []
  const mimes: (string | null)[] = []
  return {
    landed,
    mimes,
    land(input) {
      landed.push(input.body)
      mimes.push(input.mimeType ?? null)
      return { resourceId: `rs_${landed.length}`, contentHash: 'sha256:x' }
    },
    read: () => null,
    stat: () => null,
  }
}

function context(desktop: DesktopPort, sink: SinkPort | null, contextWindow = WINDOW): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY),
    sink,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
    desktop,
  }
}

interface Delivery {
  deliveredElements: number
  totalElements: number
  resourceId?: string
  unsaved?: string
}

/** 交给模型的控件：动作表替换为下标，省略与默认值相同的字段。 */
type CompactElement = Omit<DesktopElement, 'actions' | 'enabled' | 'offscreen' | 'automationId'> & {
  enabled?: boolean
  offscreen?: boolean
  automationId?: string
  actionSet: number
  nameOmittedChars?: number
  valueOmittedChars?: number
}

/** 字典中的一项：按投递方式分组的动作名，`unavailable` 是此刻无法执行的动作与原因。 */
type ActionGroups = Record<string, string[] | Record<string, string>>

interface DeliveredObservation {
  foregroundEnabled?: boolean
  app: string
  title: string
  defaults: { enabled: boolean; offscreen: boolean; automationId: string }
  actionSets: ActionGroups[]
  elements: CompactElement[]
  truncated: boolean
  truncatedBy: string[]
  filteredBy: string[]
  delivery?: Delivery
}

function observationOf(outcome: ToolOutcome): DeliveredObservation {
  const data = outcome.data as { observation?: unknown }
  return (data.observation ?? data) as DeliveredObservation
}

/** 动作表按动作名排序：分组写法不保留组间的原顺序，比较时两侧各排序一次。 */
function sorted(actions: DesktopElement['actions']): DesktopElement['actions'] {
  return [...actions].sort((a, b) => (a.action < b.action ? -1 : a.action > b.action ? 1 : 0))
}

/** 把字典中的一项还原为动作表。 */
function actionsOf(groups: ActionGroups | undefined): DesktopElement['actions'] {
  if (groups === undefined) throw new Error('actionSet 不在字典里')
  const out: DesktopElement['actions'] = []
  for (const [key, value] of Object.entries(groups)) {
    if (key === 'unavailable') {
      for (const [action, reason] of Object.entries(value as Record<string, string>)) {
        out.push({ action: action as never, delivery: [], unavailable: reason })
      }
      continue
    }
    for (const action of value as string[]) {
      out.push({ action: action as never, delivery: key.split('+') as never })
    }
  }
  return sorted(out)
}

/** 投递给模型的控件不含 `parentRef` 与 `rect`：层级由前序顺序与 `depth` 表达。 */
function delivered(
  elements: readonly DesktopElement[],
): Omit<DesktopElement, 'parentRef' | 'rect'>[] {
  return elements.map(({ parentRef: _parentRef, rect: _rect, ...rest }) => ({
    ...rest,
    actions: sorted(rest.actions),
  }))
}

/** 按结果自带的默认值与动作字典还原为完整控件。 */
function expand(observation: DeliveredObservation): DesktopElement[] {
  return observation.elements.map(({ actionSet, ...rest }) => {
    const actions = actionsOf(observation.actionSets[actionSet])
    return { ...observation.defaults, ...rest, actions } as DesktopElement
  })
}

/** 把存盘正文按行重组为一份观察。 */
function fromJsonl(body: Uint8Array): DesktopSnapshot {
  const lines = new TextDecoder().decode(body).split('\n')
  const meta = JSON.parse(lines[0] as string) as Omit<DesktopSnapshot, 'elements'>
  const elements = lines.slice(1).map((line) => JSON.parse(line) as DesktopElement)
  return { ...meta, elements }
}

async function actOnTarget(ctx: ToolContext, observationId = 'do_1'): Promise<ToolOutcome> {
  return desktopActTool.fn({ windowId: 'dw_1', observationId, action: 'invoke', ref: 'e6' }, ctx)
}

describe('小控件表整份内联', () => {
  test('控件按结果自带的字典还原后与观察逐字段相等（不含 parentRef），元数据不变，不含投递说明，也不落盘', async () => {
    const sink = fakeSink()
    const ctx = context(fakePort(小表, { acts: 0 }), sink)
    const r = await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx)
    const observation = observationOf(r)

    expect(expand(observation)).toEqual(delivered(小表))
    const { elements: _e, defaults: _d, actionSets: _a, ...meta } = observation
    const { elements: _source, ...sourceMeta } = snapshot(小表)
    expect(meta).toEqual({ ...sourceMeta, foregroundEnabled: true })
    expect(observation.delivery).toBeUndefined()
    expect(r.resources).toBeUndefined()
    expect(sink.landed).toHaveLength(0)
  })

  test('动作表去重：同一动作表只登记进字典一次，与默认值相同的字段不出现在控件上', async () => {
    const ctx = context(fakePort(小表, { acts: 0 }), fakeSink())
    const observation = observationOf(await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx))

    expect(observation.actionSets).toHaveLength(2)
    for (const e of observation.elements) {
      expect('enabled' in e).toBe(false)
      expect('offscreen' in e).toBe(false)
    }
  })

  /** 字典按投递方式分组：还原后与端口返回的动作表逐项相等，组内同名动作只写一次。 */
  test('动作字典按投递方式分组，还原后与原动作表逐项相等', async () => {
    const 混合: DesktopElement['actions'] = [
      { action: 'set_value', delivery: [], unavailable: 'read_only' },
      { action: 'invoke', delivery: ['background'] },
      { action: 'scroll_into_view', delivery: ['background'] },
      { action: 'click', delivery: ['foreground'] },
      { action: 'type_text', delivery: ['foreground'] },
    ]
    const 甲 = { ...目标, ref: 'e30', actions: 混合 }
    const 乙 = { ...目标, ref: 'e31', name: '另一个', actions: [...混合] }
    const ctx = context(fakePort([根, 甲, 乙], { acts: 0 }), fakeSink())
    const observation = observationOf(await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx))

    const [a, b] = observation.elements.filter((e) => e.ref === 'e30' || e.ref === 'e31')
    expect(a?.actionSet).toBe(b?.actionSet)
    expect(observation.actionSets[a?.actionSet ?? -1]).toEqual({
      background: ['invoke', 'scroll_into_view'],
      foreground: ['click', 'type_text'],
      unavailable: { set_value: 'read_only' },
    })
    expect(expand(observation)).toEqual(delivered([根, 甲, 乙]))
  })

  test('动作结果中的观察同样整份内联，回执字段不变', async () => {
    const sink = fakeSink()
    const ctx = context(fakePort(小表, { acts: 0 }), sink)
    const r = await actOnTarget(ctx)
    const data = r.data as { actionId: string; dispatch: string }

    expect(data.actionId).toBe('da_1')
    expect(data.dispatch).toBe('submitted')
    expect(expand(observationOf(r))).toEqual(delivered(小表))
    expect(sink.landed).toHaveLength(0)
  })

  /**
   * 原始失败形状：110 个控件，账号、密码与登录按钮位于第 84–91 项，其前为 73 个浏览器
   * 外框节点。按比例缩小后的上限只投递前 26 项，三个表单控件全部缺失。外框中的无名 pane
   * 是结构容器，不列出。
   */
  test('不超过单次投递上限的整窗控件表整份给出，位于末尾的表单控件全部包含在内', async () => {
    const 外框 = Array.from({ length: 73 }, (_, i) => ({
      ref: `e${10 + i}`,
      parentRef: 'e1',
      depth: 1,
      role: i % 3 === 0 ? 'button' : 'pane',
      name: i % 3 === 0 ? `工具栏按钮 ${i}` : '',
      automationId: i % 5 === 0 ? `view_${i}` : '',
      enabled: true,
      offscreen: false,
      rect: { x: i * 10, y: 0, width: 32, height: 32 },
      actions: [
        { action: 'scroll_into_view', delivery: ['background'] },
        { action: 'click', delivery: ['foreground'] },
        { action: 'hover', delivery: ['foreground'] },
        { action: 'drag', delivery: ['foreground'] },
      ],
    }))
    const 正文 = Array.from({ length: 36 }, (_, i) => ({
      ref: `e${100 + i}`,
      parentRef: 'e1',
      depth: 1,
      role: i === 10 || i === 12 ? 'edit' : i === 17 ? 'button' : 'text',
      name: i === 10 ? '请输入账号' : i === 12 ? '请输入密码' : i === 17 ? '登录' : `正文 ${i}`,
      automationId: '',
      ...(i === 10 || i === 12 ? { value: '' } : {}),
      enabled: true,
      offscreen: false,
      rect: { x: 400, y: 200 + i * 20, width: 240, height: 20 },
      actions:
        i === 17
          ? [
              { action: 'invoke', delivery: ['background'] },
              { action: 'click', delivery: ['foreground'] },
            ]
          : [
              { action: 'scroll_into_view', delivery: ['background'] },
              { action: 'click', delivery: ['foreground'] },
            ],
    }))
    const 窗口: DesktopElement = { ...根, ref: 'e1', actions: [] }
    const table = [窗口, ...外框, ...正文] as DesktopElement[]
    expect(table).toHaveLength(110)
    const ctx = context(fakePort(table, { acts: 0 }), fakeSink(), 1_000_000)
    const observation = observationOf(await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx))

    expect(observation.delivery).toBeUndefined()
    expect(expand(observation)).toEqual(delivered(table.filter((e) => e.name !== '')))
    const names = observation.elements.map((e) => e.name)
    expect(names).toContain('请输入账号')
    expect(names).toContain('请输入密码')
    expect(names).toContain('登录')
  })
})

describe('大控件表只投递一部分', () => {
  test('目标及其祖先在视图中，即使目标位于整张表的末尾', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const view = observationOf(await actOnTarget(ctx)).elements
    const refs = view.map((e) => e.ref)

    expect(refs).toContain('e6')
    expect(refs).toContain('e3')
    expect(refs).toContain('e2')
    expect(refs).toContain('e1')
    expect(view.length).toBeLessThan(大表.length)
  })

  test('当前焦点控件在视图中', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const view = observationOf(await actOnTarget(ctx)).elements
    expect(view.map((e) => e.ref)).toContain('e5')
  })

  /** 视图中的层级只由 `depth` 与顺序表达：祖先缺失时，焦点控件会被解读为前一个控件的子控件。 */
  test('焦点控件的祖先随其一起进入视图', async () => {
    const 深外层 = { ...外层, ref: 'e9', automationId: 'deepOuter' }
    const 深内层 = { ...内层, ref: 'e10', parentRef: 'e9', automationId: 'deepInner' }
    const 深焦点 = { ...焦点框, ref: 'e11', parentRef: 'e10', depth: 3 }
    const table = [根, ...filler(3994), 深外层, 深内层, 深焦点]
    const ctx = context(fakePort(table, { acts: 0 }), fakeSink())
    const view = observationOf(await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx)).elements

    expect(view.length).toBeLessThan(table.length)
    expect(view.map((e) => e.ref).slice(-3)).toEqual(['e9', 'e10', 'e11'])
  })

  /** 动作行末尾的窗口名取自这两个字段，裁剪后的观察中必须保留它们。 */
  test('窗口的 app 与 title 保留在原位置', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const observation = observationOf(await actOnTarget(ctx))
    expect(observation.app).toBe('合成应用')
    expect(observation.title).toBe('合成标题')
  })

  test('控件不从中间截断，长值保留前 200 字并标出省略字数，动作表下标均有效', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const observation = observationOf(await actOnTarget(ctx))
    const view = observation.elements
    for (const e of view) {
      expect(typeof e.ref).toBe('string')
      expect(typeof e.role).toBe('string')
      expect(typeof e.name).toBe('string')
      expect(observation.actionSets[e.actionSet]).toBeDefined()
    }
    const long = view.find((e) => e.ref === 'e4')
    expect(long).toBeDefined()
    expect(long?.value).toBe(LONG_VALUE.slice(0, 200))
    expect(long?.valueOmittedChars).toBe(LONG_VALUE.length - 200)
    expect(actionsOf(observation.actionSets[long?.actionSet ?? -1])).toEqual(sorted(长值框.actions))
  })

  test('视图保持原始顺序', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const view = observationOf(await actOnTarget(ctx)).elements
    const order = 大表.map((e) => e.ref)
    const picked = view.map((e) => order.indexOf(e.ref))
    expect(picked).toEqual([...picked].sort((a, b) => a - b))
  })

  test('写明总数、已投递数与其余部分的读取位置', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const r = await actOnTarget(ctx)
    const delivery = observationOf(r).delivery

    expect(delivery?.totalElements).toBe(大表.length)
    expect(delivery?.deliveredElements).toBe(observationOf(r).elements.length)
    expect(delivery?.resourceId).toBe('rs_1')
    expect(delivery?.unsaved).toBeUndefined()
    expect(r.message).toContain(`已投递 ${delivery?.deliveredElements}/${大表.length} 个控件`)
    expect(r.message).toContain('rs_1')
    expect(r.message).toContain('read_resource')
  })

  test('采集侧的采集不完整与投递侧的投递不完整分别列出', async () => {
    const port = fakePort(大表, { acts: 0 })
    const ctx = context(
      {
        ...port,
        observe: async () =>
          snapshot(大表, { truncated: true, truncatedBy: ['maxNodes'], filteredBy: ['role'] }),
      },
      fakeSink(),
    )
    const observation = observationOf(await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx))

    expect(observation.truncated).toBe(true)
    expect(observation.truncatedBy).toEqual(['maxNodes'])
    expect(observation.filteredBy).toEqual(['role'])
    expect(observation.delivery?.deliveredElements).toBeLessThan(大表.length)
  })

  test('整条结果不超过上限', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const r = await actOnTarget(ctx)
    const size = deliveredTokens(
      JSON.stringify({ message: r.message, data: r.data, resources: r.resources }),
      DEFAULT_DENSITY,
    )
    expect(size).toBeLessThanOrEqual(LIMIT)
  })

  /** 标题由窗口自行报告，长度无上限，而上限按整条结果计量：原值进入视图时，任何控件都无法投递。 */
  test('超长窗口标题只保留前缀并标出省略字数，原值在存盘正文中，窗口名仍能显示', async () => {
    const 长标题 = '合成标题'.repeat(2_000)
    const sink = fakeSink()
    const ctx = context(longTitlePort(长标题, { acts: 0 }), sink)
    const r = await actOnTarget(ctx)
    const observation = observationOf(r) as DeliveredObservation & { titleOmittedChars?: number }

    expect(observation.elements.length).toBeGreaterThan(0)
    expect(observation.title).toBe(长标题.slice(0, 200))
    expect(observation.titleOmittedChars).toBe(长标题.length - 200)
    expect(observation.app).toBe('合成应用')
    expect(fromJsonl(sink.landed[0] as Uint8Array).title).toBe(长标题)
    const size = deliveredTokens(
      JSON.stringify({ message: r.message, data: r.data, resources: r.resources }),
      DEFAULT_DENSITY,
    )
    expect(size).toBeLessThanOrEqual(LIMIT)
  })

  test('observe 的 message 中超长标题只输出前缀，控件仍能投递', async () => {
    const 长标题 = '合成标题'.repeat(2_000)
    const ctx = context(longTitlePort(长标题, { acts: 0 }), fakeSink())
    const r = await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx)

    expect(r.message).not.toContain(长标题)
    expect(r.message).toContain(`${长标题.slice(0, 200)}…`)
    const data = r.data as { elements: unknown[] }
    expect(data.elements.length).toBeGreaterThan(0)
  })
})

/**
 * 目标控件的值也可能很长。回执与控件表同时输出同一份长文本时，回执本身即占满上限，
 * 视图只剩优先控件。
 */
describe('目标值很长时回执仍保持简短', () => {
  const 打字 = {
    windowId: 'dw_1',
    observationId: 'do_1',
    action: 'type_text',
    ref: 'e7',
    text: '尾巴',
  }

  function typingContext(afterValue: string, acted: Acted = { acts: 0 }): ToolContext {
    const after = snapshot(
      长值目标表.map((e) => (e.ref === 'e7' ? { ...e, value: afterValue } : e)),
      { observationId: 'do_2' },
    )
    return context(
      {
        ...fakePort(长值目标表, acted),
        act: async () => {
          acted.acts++
          return { dispatch: 'submitted', actionId: 'da_1', observation: after }
        },
      },
      fakeSink(),
    )
  }

  test('回执只输出值的字数，原文不进入 message', async () => {
    const after = `${LONG_VALUE}尾巴`
    const r = await desktopActTool.fn(打字, typingContext(after))

    expect(r.message).toContain(`值 ${after.length} 字`)
    expect(r.message).toContain('见控件表')
    expect(r.message).not.toContain('合成长文本。合成长文本。')
    expect(r.message.length).toBeLessThan(500)
  })

  test('整条结果不超过上限，视图中还包含按原顺序补入的控件', async () => {
    const r = await desktopActTool.fn(打字, typingContext(`${LONG_VALUE}尾巴`))
    const view = observationOf(r).elements

    const size = deliveredTokens(
      JSON.stringify({ message: r.message, data: r.data, resources: r.resources }),
      DEFAULT_DENSITY,
    )
    expect(size).toBeLessThanOrEqual(LIMIT)
    // 除目标与祖先外，还能容纳其他控件。
    expect(view.filter((e) => e.name.startsWith('合成条目')).length).toBeGreaterThan(0)
    const target = view.find((e) => e.ref === 'e7')
    expect(target?.value).toBe(LONG_VALUE.slice(0, 200))
    expect(target?.valueOmittedChars).toBe(LONG_VALUE.length + 2 - 200)
  })

  test('回读按完整值判定：目标中包含输入的文字即为一致', async () => {
    const r = await desktopActTool.fn(打字, typingContext(`${LONG_VALUE}尾巴`))
    expect(r.status).toBe('success')
    expect(r.message).not.toContain('回读不一致')
  })

  test('回读按完整值判定：目标中不包含输入的文字即为不一致', async () => {
    const r = await desktopActTool.fn(打字, typingContext(LONG_VALUE))
    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(r.errorKind).toBe('desktop_readback_mismatch')
    expect(r.message).toContain('回读不一致')
  })
})

describe('存盘正文与资源引用', () => {
  test('JSONL 第一行是非元素元数据，之后每行一个控件，重组后与原观察相等', async () => {
    const 带空值: DesktopElement = {
      ref: 'e8',
      parentRef: 'e1',
      depth: 1,
      role: 'edit',
      name: '',
      automationId: '',
      value: '',
      enabled: false,
      offscreen: false,
      weakIdentity: false,
      // 协议中没有 null 字段；夹具中构造一个，确保 JSONL 不把 null 转换为缺失。
      selection: { multiple: false, required: false, selected: [], truncated: null },
      actions: [],
    } as unknown as DesktopElement
    const table = [...大表, 带空值]
    const sink = fakeSink()
    const ctx = context(fakePort(table, { acts: 0 }), sink)
    const source = snapshot(table, { observationId: 'do_2' })

    await actOnTarget(ctx)
    expect(sink.landed).toHaveLength(1)
    expect(sink.mimes[0]).toBe('application/x-ndjson')

    const body = sink.landed[0] as Uint8Array
    const lines = new TextDecoder().decode(body).split('\n')
    expect(lines).toHaveLength(table.length + 1)
    expect(JSON.parse(lines[0] as string)).toEqual({ ...source, elements: undefined })

    const back = fromJsonl(body)
    expect(back).toEqual(source)
    const last = back.elements[back.elements.length - 1] as DesktopElement & {
      selection: { truncated: unknown }
    }
    expect(last.value).toBe('')
    expect(last.name).toBe('')
    expect(last.enabled).toBe(false)
    expect(last.depth).toBe(1)
    expect(last.weakIdentity).toBe(false)
    expect(last.selection.truncated).toBeNull()
    expect('rect' in last).toBe(false)
    expect(back.elements[3]?.value).toBe(LONG_VALUE)
  })

  test('资源引用写入 outcome.resources，包含状态、字节数与覆盖事实', async () => {
    const sink = fakeSink()
    const ctx = context(fakePort(大表, { acts: 0 }), sink)
    const r = await actOnTarget(ctx)
    const body = sink.landed[0] as Uint8Array

    expect(r.resources).toHaveLength(1)
    const ref = r.resources?.[0]
    expect(String(ref?.resourceId)).toBe('rs_1')
    expect(ref?.status).toBe('complete')
    expect(ref?.contentHash).toBeNull()
    expect(ref?.sizeBytes).toBe(body.byteLength)
    expect(ref?.mimeType).toBe('application/x-ndjson')
    expect(ref?.coverage.totalBytes).toBe(body.byteLength)
    expect(ref?.coverage.truncated).toBe(true)
    expect(ref?.coverage.deliveredBytes).toBeLessThan(body.byteLength)
  })
})

describe('无法保存时如实说明', () => {
  test('没有正文库：动作事实不变，不提供地址，写明未返回的部分无法读取', async () => {
    const acted = { acts: 0 }
    const ctx = context(fakePort(大表, acted), null)
    const r = await actOnTarget(ctx)
    const delivery = observationOf(r).delivery

    expect(r.status).toBe('success')
    expect(r.executed).toBeUndefined()
    expect((r.data as { dispatch: string }).dispatch).toBe('submitted')
    expect(r.resources).toBeUndefined()
    expect(delivery?.resourceId).toBeUndefined()
    expect(delivery?.unsaved).toBe('本次执行没有正文库')
    expect(r.message).toContain('未保存')
    expect(r.message).toContain('无法回读')
    expect(r.message).not.toContain('read_resource')
    // 不重新执行动作。
    expect(acted.acts).toBe(1)
  })

  test('写入失败：如实返回原因，仍只投递一部分，不提供无效地址', async () => {
    const acted = { acts: 0 }
    const failing: SinkPort = {
      land() {
        throw new Error('磁盘满了')
      },
      read: () => null,
      stat: () => null,
    }
    const ctx = context(fakePort(大表, acted), failing)
    const r = await actOnTarget(ctx)
    const delivery = observationOf(r).delivery

    expect(r.status).toBe('success')
    expect(delivery?.unsaved).toBe('磁盘满了')
    expect(delivery?.deliveredElements).toBeLessThan(大表.length)
    expect(r.resources).toBeUndefined()
    expect(r.message).toContain('磁盘满了')
    expect(acted.acts).toBe(1)
  })

  test('小表不受影响：没有 sink 时同样整份内联', async () => {
    const ctx = context(fakePort(小表, { acts: 0 }), null)
    const r = await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx)
    expect(observationOf(r).delivery).toBeUndefined()
    expect(expand(observationOf(r))).toEqual(delivered(小表))
  })
})

describe('实际用量记账', () => {
  test('按实际投递量记账，只记一次', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    openBatchBudget(ctx.state, 1_000_000)
    const r = await actOnTarget(ctx)

    const spent = deliveredTokens(
      JSON.stringify({ message: r.message, data: r.data, resources: r.resources }),
      DEFAULT_DENSITY,
    )
    expect(1_000_000 - batchRemaining(ctx)).toBe(spent)
  })

  test('超出本次决策额度时不拒绝动作，余额报告为 0，其后的读取准入不使用虚假余额', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    openBatchBudget(ctx.state, 1000)
    expect(chargeBatchBudget(ctx, 800).ok).toBe(true)
    expect(batchRemaining(ctx)).toBe(200)

    const r = await actOnTarget(ctx)
    expect(r.status).toBe('success')
    expect((r.data as { dispatch: string }).dispatch).toBe('submitted')
    expect(batchRemaining(ctx)).toBe(0)
    // 累计值未被截断到额度：随后的读取准入仍然拒绝。
    expect(chargeBatchBudget(ctx, 100).ok).toBe(false)
  })
})

describe('四个出口', () => {
  test('observe 的附图分支：图片经由 images 通道，不进入存盘正文，窗口名仍在 data 顶层', async () => {
    const sink = fakeSink()
    const ctx = context(fakePort(大表, { acts: 0 }), sink)
    const r = await desktopObserveTool.fn({ windowId: 'dw_1', capture: 'combined' }, ctx)
    const data = r.data as { app: string; title: string; images?: { data: string }[] }

    expect(data.app).toBe('合成应用')
    expect(data.title).toBe('合成标题')
    expect(data.images).toHaveLength(1)
    const body = new TextDecoder().decode(sink.landed[0] as Uint8Array)
    expect(body).not.toContain(data.images?.[0]?.data as string)
    expect(observationOf(r).delivery?.resourceId).toBe('rs_1')
  })

  test('wait 保留 found 与原因，只裁剪观察', async () => {
    const port = fakePort(大表, { acts: 0 })
    const ctx = context(
      {
        ...port,
        wait: async () => ({
          found: false,
          reason: 'timeout',
          observation: snapshot(大表, { observationId: 'do_2' }),
        }),
      },
      fakeSink(),
    )
    const r = await desktopWaitTool.fn(
      { windowId: 'dw_1', observationId: 'do_1', until: 'enabled', ref: 'e6' },
      ctx,
    )
    const data = r.data as { found: boolean; reason: string }

    expect(r.status).toBe('failure')
    expect(r.executed).toBe(false)
    expect(data.found).toBe(false)
    expect(data.reason).toBe('timeout')
    expect(observationOf(r).delivery?.resourceId).toBe('rs_1')
    expect(observationOf(r).elements.map((e) => e.ref)).toContain('e6')
  })

  test('序列保留逐步回执与停止点，只有最后一份观察按上限处理', async () => {
    const acted = { acts: 0 }
    const ctx = context(fakePort(大表, acted), fakeSink())
    const r = await desktopActSequenceTool.fn(
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        steps: [
          { action: 'invoke', ref: 'e6' },
          { action: 'invoke', ref: 'e6', expect: { until: 'gone' } },
        ],
      },
      ctx,
    )
    const data = r.data as {
      steps: { index: number; dispatch: string }[]
      dispatched: number[]
      notExecuted: number[]
      stoppedAt?: number
      stopReason?: string
    }

    expect(data.steps.map((s) => s.index)).toEqual([1, 2])
    expect(data.dispatched).toEqual([1, 2])
    expect(data.notExecuted).toEqual([])
    expect(data.stoppedAt).toBe(2)
    expect(typeof data.stopReason).toBe('string')
    expect(observationOf(r).delivery?.totalElements).toBe(大表.length)
    expect(observationOf(r).elements.map((e) => e.ref)).toContain('e6')
    expect(acted.acts).toBe(2)
  })
})

describe('精简投递', () => {
  const 盒 = { x: 400, y: 300, width: 240, height: 32 }
  const 登录页: DesktopElement = { ...根, name: '合成登录页' }
  const 说明: DesktopElement = {
    ref: 'e20',
    parentRef: 'e1',
    depth: 1,
    role: 'text',
    name: '说明文字',
    automationId: '',
    enabled: true,
    offscreen: false,
    rect: 盒,
    actions: [],
  }
  /** 无名 pane，只承载层级。带有 scroll_into_view 动作，该动作不算作状态。 */
  const 外壳: DesktopElement = {
    ref: 'e21',
    parentRef: 'e1',
    depth: 1,
    role: 'pane',
    name: '',
    automationId: 'shell',
    enabled: true,
    offscreen: false,
    rect: 盒,
    actions: [{ action: 'scroll_into_view', delivery: ['background'] }],
  }
  const 表单: DesktopElement = {
    ref: 'e22',
    parentRef: 'e21',
    depth: 2,
    role: 'group',
    name: '登录',
    automationId: 'login',
    enabled: true,
    offscreen: false,
    rect: 盒,
    actions: [],
  }
  const 夹层: DesktopElement = {
    ref: 'e23',
    parentRef: 'e22',
    depth: 3,
    role: 'custom',
    name: '',
    automationId: '',
    enabled: true,
    offscreen: false,
    rect: 盒,
    actions: [],
  }
  const 账号: DesktopElement = {
    ref: 'e24',
    parentRef: 'e23',
    depth: 4,
    role: 'edit',
    name: '账号',
    automationId: '',
    value: '',
    enabled: true,
    offscreen: false,
    rect: { x: 420, y: 310, width: 200, height: 24 },
    actions: [{ action: 'set_value', delivery: ['background'] }],
  }
  /** 无名但带有滚动位置：存在状态，照常列出。 */
  const 滚动区: DesktopElement = { ...外壳, ref: 'e25', automationId: '', scroll: { vertical: 0 } }
  /** 无名但被禁用：属于非默认状态，照常列出。 */
  const 灰容器: DesktopElement = { ...夹层, ref: 'e26', parentRef: 'e1', depth: 1, enabled: false }
  const 精简表 = [登录页, 说明, 外壳, 表单, 夹层, 账号, 滚动区, 灰容器]

  /** 端口形状去除 `parentRef` 与 `rect`，改用投递中的 `depth`。 */
  function lean(e: DesktopElement, depth: number): Omit<DesktopElement, 'parentRef' | 'rect'> {
    const { parentRef: _parentRef, rect: _rect, ...rest } = e
    return { ...rest, depth }
  }

  /**
   * 保留原 `depth` 时，账号框为第 4 层而前面没有第 3 层的控件，会被解读为说明文字所在层级的子控件；
   * 重算后它的父控件是前面最近的第 1 层「登录」。
   */
  test('无名结构容器不列出，depth 按列出的祖先计算，其余字段与端口形状逐字段相同', async () => {
    const ctx = context(fakePort(精简表, { acts: 0 }), fakeSink())
    const observation = observationOf(await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx))

    expect(expand(observation)).toEqual([
      lean(登录页, 0),
      lean(说明, 1),
      lean(表单, 1),
      lean(账号, 2),
      lean(滚动区, 1),
      lean(灰容器, 1),
    ])
  })

  test('includeRect 为真时包含 rect；默认观察与动作之后的观察均不包含', async () => {
    const ctx = context(fakePort(精简表, { acts: 0 }), fakeSink())
    const withRect = observationOf(
      await desktopObserveTool.fn({ windowId: 'dw_1', includeRect: true }, ctx),
    )
    expect(withRect.elements.find((e) => e.ref === 'e24')?.rect).toEqual(账号.rect)
    expect(withRect.elements.find((e) => e.ref === 'e1')?.rect).toBeUndefined()

    const plain = observationOf(
      await desktopObserveTool.fn({ windowId: 'dw_1', includeRect: false }, ctx),
    )
    expect(plain.elements.some((e) => 'rect' in e)).toBe(false)

    const acted = await desktopActTool.fn(
      { windowId: 'dw_1', observationId: 'do_1', action: 'set_value', ref: 'e24', value: '甲' },
      ctx,
    )
    expect(JSON.stringify(acted.data)).not.toContain('"rect"')
  })

  test('动作目标是无名容器时仍然列出，其下层级以它为基准计算', async () => {
    const ctx = context(fakePort(精简表, { acts: 0 }), fakeSink())
    const acted = await desktopActTool.fn(
      { windowId: 'dw_1', observationId: 'do_1', action: 'scroll_into_view', ref: 'e21' },
      ctx,
    )
    const shown = observationOf(acted).elements
    expect(shown.map((e) => e.ref)).toContain('e21')
    expect(shown.find((e) => e.ref === 'e22')?.depth).toBe(2)

    const observed = observationOf(await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx))
    expect(observed.elements.map((e) => e.ref)).not.toContain('e21')
  })

  test('按角色或文字筛选出的结构容器仍然列出，命中数不变', async () => {
    const ctx = context(fakePort(精简表, { acts: 0 }), fakeSink())
    const byRole = await desktopObserveTool.fn({ windowId: 'dw_1', role: 'pane' }, ctx)
    expect(observationOf(byRole).elements.map((e) => e.ref)).toEqual(['e1', 'e21', 'e25'])
    expect(byRole.message).toContain('命中的 2 个控件')

    const byQuery = await desktopObserveTool.fn({ windowId: 'dw_1', query: 'shell' }, ctx)
    expect(observationOf(byQuery).elements.map((e) => e.ref)).toEqual(['e1', 'e21'])
    expect(byQuery.message).toContain('命中的 1 个控件')
  })

  test('「已投递 N/M」只统计列出的控件，结构容器不计为未投递', async () => {
    const 容器们 = Array.from({ length: 50 }, (_, i) => ({
      ...外壳,
      ref: `e${9000 + i}`,
      automationId: '',
    }))
    const ctx = context(fakePort([...大表, ...容器们], { acts: 0 }), fakeSink())
    const delivery = observationOf(await actOnTarget(ctx)).delivery

    expect(delivery?.totalElements).toBe(大表.length)
  })

  test('存盘正文仍是端口返回的整份控件表：结构容器、rect 与原 depth 均保留', async () => {
    const 带容器的大表 = [...大表.slice(0, -1), 外壳, 表单, 夹层, 账号, 目标]
    const sink = fakeSink()
    const ctx = context(fakePort(带容器的大表, { acts: 0 }), sink)
    await actOnTarget(ctx)

    const back = fromJsonl(sink.landed[0] as Uint8Array)
    expect(back.elements).toEqual(带容器的大表)
  })

  /**
   * 合成一张浏览器结构的控件表：外框三层无名 pane 包含标题栏按钮、工具栏与地址栏，网页正文
   * 六层无名 group 包含文字、链接、两个输入框与一个登录按钮，每个控件均带有包围盒与指针动作。
   */
  function browserShaped(): { host: DesktopElement[]; port: DesktopElement[] } {
    const pointer: DesktopElement['actions'] = [
      { action: 'scroll_into_view', delivery: ['background'] },
      { action: 'click', delivery: ['foreground'] },
      { action: 'hover', delivery: ['foreground'] },
      { action: 'drag', delivery: ['foreground'] },
    ]
    const host: DesktopElement[] = []
    const children = new Map<string, number>()
    const add = (parent: DesktopElement | null, over: Partial<DesktopElement>): DesktopElement => {
      const at = parent === null ? 0 : (children.get(parent.ref) ?? 0)
      if (parent !== null) children.set(parent.ref, at + 1)
      const path = parent === null ? 'w' : `${parent.ref.split('#')[0]}.${at}`
      const n = host.length + 1
      const e: DesktopElement = {
        ref: `${path}#42.657644.4.93.12.${100 + n}`,
        ...(parent === null ? {} : { parentRef: parent.ref }),
        depth: parent === null ? 0 : parent.depth + 1,
        role: 'pane',
        name: '',
        automationId: '',
        enabled: true,
        offscreen: false,
        rect: { x: (n * 37) % 1900, y: (n * 23) % 1100, width: 160, height: 28 },
        actions: pointer,
        ...over,
      }
      host.push(e)
      return e
    }
    const win = add(null, { role: 'window', name: '合成登录页 - 合成浏览器', actions: [] })
    let chrome = win
    for (let i = 0; i < 3; i++) chrome = add(chrome, {})
    for (const [name, id] of [
      ['最小化', 'view_2'],
      ['还原', 'view_4'],
      ['关闭', 'view_7'],
    ] as const) {
      add(chrome, { role: 'button', name, automationId: id })
    }
    const bar = add(chrome, { role: 'tool_bar', name: '应用栏', automationId: 'view_1000' })
    for (let i = 0; i < 12; i++) {
      add(bar, { role: 'button', name: `工具栏按钮 ${i}`, automationId: `view_${1001 + i}` })
    }
    add(bar, {
      role: 'edit',
      name: '地址和搜索栏',
      automationId: 'view_1021',
      value: 'https://example.test/login',
    })
    let page = add(win, {
      role: 'document',
      name: '合成登录页',
      value: 'https://example.test/login',
    })
    for (let i = 0; i < 6; i++) page = add(page, { role: 'group' })
    for (let i = 0; i < 20; i++) {
      const row = add(page, { role: 'group' })
      add(row, { role: i % 2 === 0 ? 'text' : 'link', name: `正文条目 ${i}` })
    }
    const form = add(page, { role: 'group' })
    add(form, { role: 'edit', name: '请输入账号', value: '' })
    add(form, { role: 'edit', name: '请输入密码', value: '' })
    add(form, { role: 'button', name: '登录' })
    const id = new Map(host.map((e, i) => [e.ref, `e${i + 1}`]))
    const port = host.map((e, i) => ({
      ...e,
      ref: id.get(e.ref) as string,
      ...(e.parentRef === undefined ? {} : { parentRef: id.get(e.parentRef) as string }),
      ...(i === 0 ? { windowRoot: true } : {}),
    }))
    return { host, port }
  }

  /** 端口直接返回宿主 ref 时的投递：包含长编号、rect 与结构容器，字典规则与当前投递相同。 */
  function hostShapedChars(table: readonly DesktopElement[]): number {
    const sets: string[] = []
    const elements = table.map(
      ({ actions, parentRef: _parentRef, enabled, offscreen, automationId, ...rest }) => {
        const key = JSON.stringify(actions)
        if (!sets.includes(key)) sets.push(key)
        return {
          ...rest,
          ...(enabled ? {} : { enabled }),
          ...(offscreen ? { offscreen } : {}),
          ...(automationId ? { automationId } : {}),
          actionSet: sets.indexOf(key),
        }
      },
    )
    const actionSets = sets.map((s) => JSON.parse(s) as unknown)
    const defaults = { enabled: true, offscreen: false, automationId: '' }
    return JSON.stringify({ defaults, actionSets, elements }).length
  }

  /** 该表的比值约为三成；投递中重新加入 `rect` 或长编号时，比值超过四成。 */
  test('浏览器结构的控件表：精简投递不足宿主编号写法的四成', async () => {
    const { host, port } = browserShaped()
    const ctx = context(fakePort(port, { acts: 0 }), fakeSink())
    const observation = observationOf(await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx))
    const { defaults, actionSets, elements } = observation
    const leanChars = JSON.stringify({ defaults, actionSets, elements }).length

    expect(observation.delivery).toBeUndefined()
    expect(leanChars).toBeLessThanOrEqual(hostShapedChars(host) * 0.4)
  })
})

describe('差异投递', () => {
  /** 一张不超过单次上限的表：窗口根、两个分组，每个分组下有一组可点击的条目。 */
  function page(prefix: string, count: number): DesktopElement[] {
    const click: DesktopElement['actions'] = [
      { action: 'invoke', delivery: ['background'] },
      { action: 'click', delivery: ['foreground'] },
    ]
    const groups: DesktopElement[] = [
      { ...外层, ref: 'e2', name: `${prefix}甲组` },
      { ...外层, ref: 'e3', name: `${prefix}乙组`, automationId: 'outer2' },
    ]
    const items = Array.from({ length: count }, (_, i) => ({
      ref: `e${10 + i}`,
      parentRef: i % 2 === 0 ? 'e2' : 'e3',
      depth: 2,
      role: 'button',
      name: `${prefix}条目 ${i}`,
      automationId: `item-${i}`,
      enabled: true,
      offscreen: false,
      actions: click,
    }))
    return [根, ...groups, ...items]
  }

  /** 观察返回第 0 份，之后每次动作依次返回下一份，编号为 do_1、do_2……。 */
  function steppedPort(tables: DesktopElement[][]): { port: DesktopPort; acted: string[] } {
    const acted: string[] = []
    let at = 0
    const snap = (i: number) =>
      snapshot(tables[i] as DesktopElement[], { observationId: `do_${i + 1}` })
    return {
      acted,
      port: {
        ...fakePort(tables[0] as DesktopElement[], { acts: 0 }),
        observe: async () => snap(0),
        elements: (_windowId, observationId) => tables[Number(observationId.slice(3)) - 1] ?? null,
        act: async (input) => {
          acted.push(input.ref ?? '')
          at = Math.min(at + 1, tables.length - 1)
          return { dispatch: 'submitted', actionId: `da_${at}`, observation: snap(at) }
        },
      },
    }
  }

  interface DiffObservation {
    observationId: string
    since?: string
    unchanged?: number
    elements?: CompactElement[]
    added?: (CompactElement & { parentRef?: string })[]
    changed?: (CompactElement & { parentRef?: string })[]
    removed?: string[]
    actionSets: ActionGroups[]
  }

  const diffOf = (r: ToolOutcome) => observationOf(r) as unknown as DiffObservation
  const act = (ctx: ToolContext, observationId: string, ref = 'e10') =>
    desktopActTool.fn({ windowId: 'dw_1', observationId, action: 'invoke', ref }, ctx)

  /** 原始失败形状：点击后界面没有变化，下一份观察仍整份重新投递。 */
  test('动作之后界面未变化：只投递一句「与基底相同」，字符数不足整份的一成', async () => {
    const table = page('', 80)
    const ctx = context(steppedPort([table, table]).port, fakeSink())
    const base = await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx)
    const after = await act(ctx, 'do_1')
    const diff = diffOf(after)

    expect(diff.since).toBe('do_1')
    expect(diff.observationId).toBe('do_2')
    expect(diff.unchanged).toBe(delivered(table).length)
    expect([diff.added, diff.changed, diff.removed]).toEqual([[], [], []])
    expect(diff.elements).toBeUndefined()
    expect(after.message).toContain('与 do_1 相比：新增 0、改变 0、消失 0')
    const full = JSON.stringify(observationOf(base)).length
    expect(JSON.stringify(observationOf(after)).length).toBeLessThanOrEqual(full * 0.1)
  })

  test('新增、改变与消失分别列出：新增与改变整行给出并附带 parentRef，字典只包含用到的项', async () => {
    const before = page('', 80)
    const after = before
      .filter((e) => e.ref !== 'e11')
      .map((e) => (e.ref === 'e12' ? { ...e, name: '改名的条目', enabled: false } : e))
    const added: DesktopElement = {
      ...目标,
      ref: 'e200',
      parentRef: 'e3',
      depth: 2,
      name: '新出现的按钮',
    }
    const ctx = context(steppedPort([before, [...after, added]]).port, fakeSink())
    await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx)
    const diff = diffOf(await act(ctx, 'do_1'))

    expect(diff.removed).toEqual(['e11'])
    expect(diff.changed?.map((e) => [e.ref, e.name, e.enabled, e.parentRef])).toEqual([
      ['e12', '改名的条目', false, 'e2'],
    ])
    expect(diff.added?.map((e) => [e.ref, e.depth, e.parentRef])).toEqual([['e200', 2, 'e3']])
    expect(diff.actionSets.map((groups) => actionsOf(groups))).toEqual([
      sorted(目标.actions),
      sorted((before[3] as DesktopElement).actions),
    ])
  })

  /** 压缩按全部消息保留尾部：其他工具的大结果可能使基底移出保留范围，因此基底之后完成过压缩即不再使用它。 */
  test('基底之后完成过一次压缩：整份投递，并成为新的基底', async () => {
    const table = page('', 80)
    const ctx = context(steppedPort([table, table, table]).port, fakeSink())
    await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx)
    markCompacted(ctx.state)

    const whole = diffOf(await act(ctx, 'do_1'))
    expect(whole.since).toBeUndefined()
    expect(whole.elements).toHaveLength(delivered(table).length)
    expect(diffOf(await act(ctx, 'do_2')).since).toBe('do_2')
  })

  test('更换父控件的控件记为改变：差异中的行不在原位置，只比较投递字段会遗漏它', async () => {
    const before = page('', 80)
    const moved = before.map((e) => (e.ref === 'e10' ? { ...e, parentRef: 'e3' } : e))
    const ctx = context(steppedPort([before, moved]).port, fakeSink())
    await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx)
    const diff = diffOf(await act(ctx, 'do_1'))

    expect(diff.changed?.map((e) => [e.ref, e.parentRef])).toEqual([['e10', 'e3']])
  })

  test('页面跳转后未变化的控件不足一半：整份投递，并成为下一次差异的基底', async () => {
    const first = page('', 80)
    const jumped = page('另一页 ', 80)
    const ctx = context(steppedPort([first, jumped, jumped]).port, fakeSink())
    await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx)

    const whole = diffOf(await act(ctx, 'do_1'))
    expect(whole.since).toBeUndefined()
    expect(whole.elements).toHaveLength(delivered(jumped).length)
    expect(diffOf(await act(ctx, 'do_2')).since).toBe('do_2')
  })

  test('基底与之后的差异累计超过单次上限：整份投递，从该份重新累计', async () => {
    const table = page('', 80)
    const input = (
      observationId: string,
      place: 'top' | 'observation',
      state: Map<string, unknown>,
    ) => ({
      ctx: { sink: fakeSink(), contextWindow: WINDOW, density: DEFAULT_DENSITY, state },
      toolName: 'desktop_act',
      snapshot: snapshot(table, { observationId }),
      place,
      incremental: place === 'observation',
      lead: 'x',
    })
    const size = (parts: { message: string; data: unknown }) =>
      deliveredTokens(JSON.stringify({ message: parts.message, data: parts.data }), DEFAULT_DENSITY)
    // 先测量一份整份投递与一份差异的大小。
    const probe = openBatchBudget(new Map<string, unknown>(), Number.POSITIVE_INFINITY)
    const base = size(desktopResult(input('do_1', 'top', probe)))
    const diff = size(desktopResult(input('do_2', 'observation', probe)))
    const limit = base + diff + Math.floor(diff / 2)

    const state = openBatchBudget(new Map<string, unknown>(), Number.POSITIVE_INFINITY)
    const run = (id: string, place: 'top' | 'observation') =>
      desktopResult({ ...input(id, place, state), limit }).data as Record<string, unknown>
    run('do_1', 'top')
    expect((run('do_2', 'observation').observation as DiffObservation).since).toBe('do_1')
    const third = run('do_3', 'observation').observation as DiffObservation
    expect(third.since).toBeUndefined()
    expect(third.elements).toBeDefined()
    expect((run('do_4', 'observation').observation as DiffObservation).since).toBe('do_3')
  })

  /** 历史只追加：整窗的整份投递之后，局部读取范围的基底仍在上下文中，仍作为基底使用。 */
  test('基底按窗口与读取范围分别记录：整窗整份投递不使同一窗口局部读取范围的基底失效', async () => {
    const table = page('', 80)
    const state = openBatchBudget(new Map<string, unknown>(), Number.POSITIVE_INFINITY)
    const run = (observationId: string, scope: string | undefined, incremental: boolean) =>
      desktopResult({
        ctx: { sink: fakeSink(), contextWindow: WINDOW, density: DEFAULT_DENSITY, state },
        toolName: incremental ? 'desktop_act' : 'desktop_observe',
        snapshot: snapshot(table, { observationId, ...(scope !== undefined ? { scope } : {}) }),
        place: incremental ? 'observation' : 'top',
        ...(incremental ? { incremental: true } : {}),
        lead: 'x',
      }).data as Record<string, unknown>
    run('do_1', 'e2', false)
    run('do_2', undefined, false)
    expect((run('do_3', 'e2', true).observation as DiffObservation).since).toBe('do_1')
    expect((run('do_4', undefined, true).observation as DiffObservation).since).toBe('do_2')
  })

  test('筛选后的视图不作为基底，分页的观察不作为基底且使之前的基底失效', async () => {
    const table = page('', 80)
    const filtered = context(steppedPort([table, table]).port, fakeSink())
    await desktopObserveTool.fn({ windowId: 'dw_1', role: 'button' }, filtered)
    expect(diffOf(await act(filtered, 'do_1')).since).toBeUndefined()

    // 小表先整份投递并成为基底，随后同一窗口的观察过大而只能分页：之前的基底随之失效。
    const { port } = steppedPort([table, 大表, table])
    const paged = context({ ...port, observe: async () => snapshot(table) }, fakeSink())
    await desktopObserveTool.fn({ windowId: 'dw_1' }, paged)
    expect(observationOf(await act(paged, 'do_1', 'e10')).delivery?.resourceId).toBeDefined()
    expect(diffOf(await act(paged, 'do_2', 'e6')).since).toBeUndefined()
  })

  test('带 rect 的整份观察不作为基底', async () => {
    const table = page('', 80)
    const ctx = context(steppedPort([table, table]).port, fakeSink())
    await desktopObserveTool.fn({ windowId: 'dw_1', includeRect: true }, ctx)
    expect(diffOf(await act(ctx, 'do_1')).since).toBeUndefined()
  })

  test('基底只在本 run 内有效：新 run 的第一次重读整份投递', async () => {
    const table = page('', 80)
    const { port } = steppedPort([table, table])
    await desktopObserveTool.fn({ windowId: 'dw_1' }, context(port, fakeSink()))
    const next = diffOf(await act(context(port, fakeSink()), 'do_1'))
    expect(next.since).toBeUndefined()
    expect(next.elements).toBeDefined()
  })

  test('差异中未列出的控件沿用基底中的编号，下一次动作使用差异那一份的观察编号', async () => {
    const table = page('', 80)
    const { port, acted } = steppedPort([table, table, table])
    const ctx = context(port, fakeSink())
    await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx)
    const diff = diffOf(await act(ctx, 'do_1'))
    expect(diff.since).toBe('do_1')

    const next = await act(ctx, diff.observationId, 'e40')
    expect(next.status).toBe('success')
    expect(acted).toEqual(['e10', 'e40'])
  })
})
