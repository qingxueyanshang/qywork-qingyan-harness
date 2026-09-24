/**
 * desktop 结果的投递闸。
 *
 * **覆盖范围**：`desktop-results.ts` 的上限、大小判定、紧凑表示的无损往返、视图选取、
 * 长值处理、JSONL 存盘、资源引用与实际用量记账，以及 `desktop.ts` 四个出口（observe 含
 * 补图分支、act、wait、act_sequence）接上它之后的结果形状。
 *
 * 夹具是合成的：控件名称、值与窗口标题都不取自真实应用或网页。
 */

import { describe, expect, test } from 'bun:test'
import {
  chargeBatchBudget,
  type DesktopElement,
  type DesktopPort,
  type DesktopSnapshot,
  deliveredTokens,
  deliveryBudget,
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

const WINDOW = 200_000
const LIMIT = deliveryBudget(WINDOW).perCall
/** 一个控件的值长到单独一个就装不下视图。 */
const LONG_VALUE = '合成长文本。'.repeat(10_000)

const 根: DesktopElement = {
  ref: 'w#0',
  depth: 0,
  role: 'window',
  name: '合成窗口',
  automationId: '',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 外层: DesktopElement = {
  ref: 'g#1',
  parentRef: 'w#0',
  depth: 1,
  role: 'group',
  name: '外层分组',
  automationId: 'outer',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 内层: DesktopElement = {
  ref: 'g#2',
  parentRef: 'g#1',
  depth: 2,
  role: 'group',
  name: '内层分组',
  automationId: 'inner',
  enabled: true,
  offscreen: false,
  actions: [],
}
/** 值特别长的那一个，排在表的前面：视图装它时预算还很宽，值仍然只能留前缀。 */
const 长值框: DesktopElement = {
  ref: 'v#1',
  parentRef: 'w#0',
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
  ref: 'f#1',
  parentRef: 'w#0',
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
/** 动作目标，排在整张表的最后一个：优先进视图靠的是优先级，不是位置。 */
const 目标: DesktopElement = {
  ref: 't#1',
  parentRef: 'g#2',
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
    ref: `e#${i}`,
    parentRef: 'w#0',
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

/** 自己就带着长值的动作目标，打字动作打在它上面。 */
const 长值目标: DesktopElement = {
  ref: 't#2',
  parentRef: 'g#2',
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

/** 观察与动作后重读都带同一个超长标题。 */
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
    state: new Map(),
    sink,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => true,
    desktop,
  }
}

interface Delivery {
  deliveredElements: number
  totalElements: number
  resourceId?: string
  unsaved?: string
}

/** 交给模型的一个控件：动作表换成下标，与默认值相同的格省掉。 */
type CompactElement = Omit<DesktopElement, 'actions' | 'enabled' | 'offscreen' | 'automationId'> & {
  enabled?: boolean
  offscreen?: boolean
  automationId?: string
  actionSet: number
  nameOmittedChars?: number
  valueOmittedChars?: number
}

interface DeliveredObservation {
  app: string
  title: string
  defaults: { enabled: boolean; offscreen: boolean; automationId: string }
  actionSets: DesktopElement['actions'][]
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

/** 按结果自带的默认值与动作字典还原成完整控件。 */
function expand(observation: DeliveredObservation): DesktopElement[] {
  return observation.elements.map(({ actionSet, ...rest }) => {
    const actions = observation.actionSets[actionSet]
    if (actions === undefined) throw new Error(`actionSet ${actionSet} 不在字典里`)
    return { ...observation.defaults, ...rest, actions } as DesktopElement
  })
}

/** 存盘正文按行拼回一份观察。 */
function fromJsonl(body: Uint8Array): DesktopSnapshot {
  const lines = new TextDecoder().decode(body).split('\n')
  const meta = JSON.parse(lines[0] as string) as Omit<DesktopSnapshot, 'elements'>
  const elements = lines.slice(1).map((line) => JSON.parse(line) as DesktopElement)
  return { ...meta, elements }
}

async function actOnTarget(ctx: ToolContext, observationId = 'do_1'): Promise<ToolOutcome> {
  return desktopActTool.fn({ windowId: 'dw_1', observationId, action: 'invoke', ref: 't#1' }, ctx)
}

describe('小控件表整份内联', () => {
  test('控件按结果自带的字典还原后与观察逐字段相等，元数据原样，不带投递说明，也不落盘', async () => {
    const sink = fakeSink()
    const ctx = context(fakePort(小表, { acts: 0 }), sink)
    const r = await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx)
    const observation = observationOf(r)

    expect(expand(observation)).toEqual(小表)
    const { elements: _e, defaults: _d, actionSets: _a, ...meta } = observation
    const { elements: _source, ...sourceMeta } = snapshot(小表)
    expect(meta).toEqual(sourceMeta)
    expect(observation.delivery).toBeUndefined()
    expect(r.resources).toBeUndefined()
    expect(sink.landed).toHaveLength(0)
  })

  test('动作表去重：同一个动作表只进字典一次，与默认值相同的格不出现在控件上', async () => {
    const ctx = context(fakePort(小表, { acts: 0 }), fakeSink())
    const observation = observationOf(await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx))

    expect(observation.actionSets).toHaveLength(2)
    for (const e of observation.elements) {
      expect('enabled' in e).toBe(false)
      expect('offscreen' in e).toBe(false)
    }
  })

  test('动作结果里的观察同样整份内联，回执字段原样', async () => {
    const sink = fakeSink()
    const ctx = context(fakePort(小表, { acts: 0 }), sink)
    const r = await actOnTarget(ctx)
    const data = r.data as { actionId: string; dispatch: string }

    expect(data.actionId).toBe('da_1')
    expect(data.dispatch).toBe('submitted')
    expect(expand(observationOf(r))).toEqual(小表)
    expect(sink.landed).toHaveLength(0)
  })

  /**
   * 原始失败形状：110 个控件，账号、密码与登录按钮排在第 84–91 项，前面是 73 个浏览器
   * 外框节点。按比例缩过的上限只投前 26 项，三个表单控件全部缺席。
   */
  test('装得下单次投递上限的整窗控件表整份给出，排在末尾的表单控件都在', async () => {
    const 外框 = Array.from({ length: 73 }, (_, i) => ({
      ref: `w.0.${i}#42.1.${i}`,
      parentRef: 'w#42.1',
      depth: 2,
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
      ref: `w.1.${i}#42.2.${i}`,
      parentRef: 'w#42.1',
      depth: 2,
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
    const 窗口: DesktopElement = { ...根, ref: 'w#42.1', actions: [] }
    const table = [窗口, ...外框, ...正文] as DesktopElement[]
    expect(table).toHaveLength(110)
    const ctx = context(fakePort(table, { acts: 0 }), fakeSink(), 1_000_000)
    const observation = observationOf(await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx))

    expect(observation.delivery).toBeUndefined()
    expect(expand(observation)).toEqual(table)
    const names = observation.elements.map((e) => e.name)
    expect(names).toContain('请输入账号')
    expect(names).toContain('请输入密码')
    expect(names).toContain('登录')
  })
})

describe('大控件表只投一部分', () => {
  test('目标与它的祖先在视图里，即使目标排在整张表的最后', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const view = observationOf(await actOnTarget(ctx)).elements
    const refs = view.map((e) => e.ref)

    expect(refs).toContain('t#1')
    expect(refs).toContain('g#2')
    expect(refs).toContain('g#1')
    expect(refs).toContain('w#0')
    expect(view.length).toBeLessThan(大表.length)
  })

  test('当前焦点控件在视图里', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const view = observationOf(await actOnTarget(ctx)).elements
    expect(view.map((e) => e.ref)).toContain('f#1')
  })

  /** 动作行行尾的窗口名取自这两格，裁过的观察里它们必须还在。 */
  test('窗口的 app 与 title 留在原位置', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const observation = observationOf(await actOnTarget(ctx))
    expect(observation.app).toBe('合成应用')
    expect(observation.title).toBe('合成标题')
  })

  test('控件不从中间切开，长值留前 200 字并标出省略字数，动作表下标都指得到', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const observation = observationOf(await actOnTarget(ctx))
    const view = observation.elements
    for (const e of view) {
      expect(typeof e.ref).toBe('string')
      expect(typeof e.role).toBe('string')
      expect(typeof e.name).toBe('string')
      expect(observation.actionSets[e.actionSet]).toBeDefined()
    }
    const long = view.find((e) => e.ref === 'v#1')
    expect(long).toBeDefined()
    expect(long?.value).toBe(LONG_VALUE.slice(0, 200))
    expect(long?.valueOmittedChars).toBe(LONG_VALUE.length - 200)
    expect(observation.actionSets[long?.actionSet ?? -1]).toEqual(长值框.actions)
  })

  test('视图保持原始顺序', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const view = observationOf(await actOnTarget(ctx)).elements
    const order = 大表.map((e) => e.ref)
    const picked = view.map((e) => order.indexOf(e.ref))
    expect(picked).toEqual([...picked].sort((a, b) => a - b))
  })

  test('写明共多少、给了多少、其余在哪读', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const r = await actOnTarget(ctx)
    const delivery = observationOf(r).delivery

    expect(delivery?.totalElements).toBe(大表.length)
    expect(delivery?.deliveredElements).toBe(observationOf(r).elements.length)
    expect(delivery?.resourceId).toBe('rs_1')
    expect(delivery?.unsaved).toBeUndefined()
    expect(r.message).toContain(`已投 ${delivery?.deliveredElements}/${大表.length} 个控件`)
    expect(r.message).toContain('rs_1')
    expect(r.message).toContain('read_resource')
  })

  test('采集侧的未采全与投递侧的没给全分列', async () => {
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

  /** 标题由窗口自报、长度无界，而上限按整条结果计量：原值进视图时控件一个都投不出去。 */
  test('超长窗口标题只留前缀并标出省略字数，原值在存盘正文里，窗口名仍显示得出', async () => {
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

  test('observe 的 message 里超长标题只印前缀，控件照样投得出去', async () => {
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
 * 目标控件的值也可能很长。回执与控件表两处印同一份长文本时，回执自己就把上限吃满，
 * 视图只剩优先控件。
 */
describe('目标值很长时回执仍然短', () => {
  const 打字 = {
    windowId: 'dw_1',
    observationId: 'do_1',
    action: 'type_text',
    ref: 't#2',
    text: '尾巴',
  }

  function typingContext(afterValue: string, acted: Acted = { acts: 0 }): ToolContext {
    const after = snapshot(
      长值目标表.map((e) => (e.ref === 't#2' ? { ...e, value: afterValue } : e)),
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

  test('回执只印值有多少字，原文不进 message', async () => {
    const after = `${LONG_VALUE}尾巴`
    const r = await desktopActTool.fn(打字, typingContext(after))

    expect(r.message).toContain(`值 ${after.length} 字`)
    expect(r.message).toContain('在控件表里')
    expect(r.message).not.toContain('合成长文本。合成长文本。')
    expect(r.message.length).toBeLessThan(500)
  })

  test('整条结果不超过上限，视图里还有按原顺序补进来的控件', async () => {
    const r = await desktopActTool.fn(打字, typingContext(`${LONG_VALUE}尾巴`))
    const view = observationOf(r).elements

    const size = deliveredTokens(
      JSON.stringify({ message: r.message, data: r.data, resources: r.resources }),
      DEFAULT_DENSITY,
    )
    expect(size).toBeLessThanOrEqual(LIMIT)
    // 目标与祖先之外还装得下别的控件。
    expect(view.filter((e) => e.ref.startsWith('e#')).length).toBeGreaterThan(0)
    const target = view.find((e) => e.ref === 't#2')
    expect(target?.value).toBe(LONG_VALUE.slice(0, 200))
    expect(target?.valueOmittedChars).toBe(LONG_VALUE.length + 2 - 200)
  })

  test('读回按完整值判：目标里有这段文字就是一致', async () => {
    const r = await desktopActTool.fn(打字, typingContext(`${LONG_VALUE}尾巴`))
    expect(r.status).toBe('success')
    expect(r.message).not.toContain('读回不一致')
  })

  test('读回按完整值判：目标里没有这段文字就是不一致', async () => {
    const r = await desktopActTool.fn(打字, typingContext(LONG_VALUE))
    expect(r.status).toBe('failure')
    expect(r.executed).toBe(true)
    expect(r.errorKind).toBe('desktop_readback_mismatch')
    expect(r.message).toContain('读回不一致')
  })
})

describe('存盘正文与资源引用', () => {
  test('JSONL 第一行是非元素元数据，之后每行一个控件，拼回与原观察相等', async () => {
    const 带空值: DesktopElement = {
      ref: 'z#1',
      parentRef: 'w#0',
      depth: 1,
      role: 'edit',
      name: '',
      automationId: '',
      value: '',
      enabled: false,
      offscreen: false,
      weakIdentity: false,
      // 协议里没有 null 字段；夹具里造一个，锁住 JSONL 不把 null 折成缺席。
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

  test('资源引用进 outcome.resources，带状态、字节数与覆盖事实', async () => {
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

describe('存不下时照实说', () => {
  test('没有正文库：动作事实不变，不给地址，写明未返回的部分读不回来', async () => {
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
    // 不重做动作。
    expect(acted.acts).toBe(1)
  })

  test('写失败：原因照实回，仍然只投一部分，不发假地址', async () => {
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

  test('小表不受影响：没有 sink 也整份内联', async () => {
    const ctx = context(fakePort(小表, { acts: 0 }), null)
    const r = await desktopObserveTool.fn({ windowId: 'dw_1' }, ctx)
    expect(observationOf(r).delivery).toBeUndefined()
    expect(expand(observationOf(r))).toEqual(小表)
  })
})

describe('实际用量记账', () => {
  test('投多少记多少，只记一次', async () => {
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink())
    const before = chargeBatchBudget(ctx, 0).batchRemaining
    const r = await actOnTarget(ctx)
    const after = chargeBatchBudget(ctx, 0).batchRemaining

    const spent = deliveredTokens(
      JSON.stringify({ message: r.message, data: r.data, resources: r.resources }),
      DEFAULT_DENSITY,
    )
    expect(before - after).toBe(spent)
  })

  test('越过本波预算时动作不被拒，余额报 0，其后的读取准入不使用假余额', async () => {
    const small = 32_000
    const ctx = context(fakePort(大表, { acts: 0 }), fakeSink(), small)
    const { perCall, batchCap } = deliveryBudget(small)
    expect(chargeBatchBudget(ctx, perCall).ok).toBe(true)
    expect(chargeBatchBudget(ctx, batchCap - perCall - 200).ok).toBe(true)
    expect(chargeBatchBudget(ctx, 0).batchRemaining).toBe(200)

    const r = await actOnTarget(ctx)
    expect(r.status).toBe('success')
    expect((r.data as { dispatch: string }).dispatch).toBe('submitted')
    expect(chargeBatchBudget(ctx, 0).batchRemaining).toBe(0)
    // 累计值没有被截回上限：随后的读取准入照旧拒绝。
    expect(chargeBatchBudget(ctx, 100).ok).toBe(false)
  })
})

describe('四个出口', () => {
  test('observe 的补图分支：图片走 images 通道，不进存盘正文，窗口名仍在 data 顶层', async () => {
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

  test('wait 保留 found 与原因，只有观察被裁', async () => {
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
      { windowId: 'dw_1', observationId: 'do_1', until: 'enabled', ref: 't#1' },
      ctx,
    )
    const data = r.data as { found: boolean; reason: string }

    expect(r.status).toBe('failure')
    expect(r.executed).toBe(false)
    expect(data.found).toBe(false)
    expect(data.reason).toBe('timeout')
    expect(observationOf(r).delivery?.resourceId).toBe('rs_1')
    expect(observationOf(r).elements.map((e) => e.ref)).toContain('t#1')
  })

  test('序列保留逐步回执与停止点，只有最后那份观察按上限处理', async () => {
    const acted = { acts: 0 }
    const ctx = context(fakePort(大表, acted), fakeSink())
    const r = await desktopActSequenceTool.fn(
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        steps: [
          { action: 'invoke', ref: 't#1' },
          { action: 'invoke', ref: 't#1', expect: { until: 'gone' } },
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
    expect(observationOf(r).elements.map((e) => e.ref)).toContain('t#1')
    expect(acted.acts).toBe(2)
  })
})
