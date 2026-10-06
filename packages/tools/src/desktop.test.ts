/**
 * 五个内置桌面工具。覆盖范围：`desktop.ts` 的参数校验、局部查询参数、层级消歧回执、
 * 动作前置条件、三态回执与动作后观察的透传、选择容器的选中项渲染、等待条件与终态、
 * 注册元数据，以及采集模式、
 * 两种采集区域参数、图片经由 `images` 通道传递、几何与图像尺寸的核对、不接受图片的模型，
 * 以及有限动作序列的逐步执行、引用接续、后置条件、七种停止边界与 `executed` 语义。
 * strict 参数另覆盖两种 OpenAI 接口的实际请求定义与 wheel 的空参数执行。
 *
 * 端口一侧由 `packages/server/src/desktop/bridge.test.ts` 与同目录的
 * `coordinator.test.ts` 覆盖。此处使用记录调用的模拟端口：断言的是交给端口的内容与
 * 是否交给端口，不是调用次数。
 */

import { describe, expect, test } from 'bun:test'
import type {
  DesktopActResult,
  DesktopElement,
  DesktopImage,
  DesktopPort,
  DesktopRefusal,
  DesktopSnapshot,
  ToolContext,
  ToolOutcome,
  ToolSpec,
} from '@qywork/agent'
import { openBatchBudget, ToolRegistry } from '@qywork/agent'
import { buildAdapter, DEFAULT_DENSITY, STREAM_IDLE_TIMEOUT_MS } from '@qywork/ai'
import type { DesktopAction } from '@qywork/core'
import {
  desktopActSequenceTool,
  desktopActTool,
  desktopObserveTool,
  desktopTools,
  desktopWaitTool,
  desktopWindowsTool,
} from './desktop.ts'
import { MAX_EDGE } from './image.ts'

/** 窗口根。同名按钮分属两个分组，只有祖先路径能区分它们。 */
const 窗口: DesktopElement = {
  ref: 'e1',
  windowRoot: true,
  depth: 0,
  role: 'window',
  name: '另存为',
  automationId: '',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 工具栏: DesktopElement = {
  ref: 'e2',
  parentRef: 'e1',
  depth: 1,
  role: 'tool_bar',
  name: '',
  automationId: 'bar',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 工具栏保存: DesktopElement = {
  ref: 'e3',
  parentRef: 'e2',
  depth: 2,
  role: 'button',
  name: '保存',
  automationId: 'save',
  enabled: true,
  offscreen: false,
  actions: [{ action: 'invoke', delivery: ['background'] }],
}
const 表单组: DesktopElement = {
  ref: 'e4',
  parentRef: 'e1',
  depth: 1,
  role: 'group',
  name: '文件',
  automationId: 'form',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 输入框: DesktopElement = {
  ref: 'e5',
  parentRef: 'e4',
  depth: 2,
  role: 'edit',
  name: '姓名',
  automationId: 'nameBox',
  value: '',
  enabled: true,
  offscreen: false,
  rect: { x: 300, y: 200, width: 120, height: 24 },
  actions: [{ action: 'set_value', delivery: ['background'] }],
}
const 表单保存: DesktopElement = {
  ref: 'e6',
  parentRef: 'e4',
  depth: 2,
  role: 'button',
  name: '保存',
  automationId: 'save2',
  enabled: true,
  offscreen: false,
  actions: [{ action: 'invoke', delivery: ['background'] }],
}
const 灰按钮: DesktopElement = {
  ref: 'e7',
  parentRef: 'e4',
  depth: 2,
  role: 'button',
  name: '提交',
  automationId: 'submit',
  enabled: false,
  offscreen: false,
  actions: [{ action: 'invoke', delivery: ['background'] }],
}

const 滑块: DesktopElement = {
  ref: 'e8',
  parentRef: 'e1',
  depth: 1,
  role: 'slider',
  name: '音量',
  automationId: 'slider',
  enabled: true,
  offscreen: false,
  actions: [{ action: 'set_range_value', delivery: ['background'] }],
  range: { value: 20, min: 0, max: 100, smallChange: 1, largeChange: 10 },
}
const 进度条: DesktopElement = {
  ref: 'e9',
  parentRef: 'e1',
  depth: 1,
  role: 'progress_bar',
  name: '进度',
  automationId: 'progress',
  enabled: true,
  offscreen: false,
  actions: [{ action: 'set_range_value', delivery: [], unavailable: 'read_only' }],
  range: { value: 35, min: 0, max: 100, smallChange: 0, largeChange: 0 },
}
const 三态复选: DesktopElement = {
  ref: 'e10',
  parentRef: 'e1',
  depth: 1,
  role: 'check_box',
  name: '三态',
  automationId: 'triCheck',
  enabled: true,
  offscreen: false,
  actions: [{ action: 'set_toggle', delivery: ['background'] }],
  toggle: 'off',
}
const 单选列表: DesktopElement = {
  ref: 'e11',
  parentRef: 'e1',
  depth: 1,
  role: 'list',
  name: '单选',
  automationId: 'singleList',
  enabled: true,
  offscreen: false,
  actions: [],
  selection: { multiple: false, required: false },
}
const 单选项: DesktopElement = {
  ref: 'e12',
  parentRef: 'e11',
  depth: 2,
  role: 'list_item',
  name: 'single-alpha',
  automationId: '',
  enabled: true,
  offscreen: false,
  actions: [
    { action: 'select', delivery: ['background'] },
    { action: 'add_to_selection', delivery: ['background'] },
    { action: 'remove_from_selection', delivery: ['background'] },
  ],
  selected: false,
}
const 树节点: DesktopElement = {
  ref: 'e13',
  parentRef: 'e1',
  depth: 1,
  role: 'tree_item',
  name: 'treeRoot',
  automationId: 'treeRoot',
  enabled: true,
  offscreen: false,
  actions: [
    { action: 'expand', delivery: ['background'] },
    { action: 'collapse', delivery: ['background'] },
  ],
  expand: 'collapsed',
}
const 长列表: DesktopElement = {
  ref: 'e14',
  parentRef: 'e1',
  depth: 1,
  role: 'list',
  name: '长列表',
  automationId: 'bigList',
  enabled: true,
  offscreen: false,
  actions: [
    { action: 'scroll', delivery: ['background'] },
    { action: 'realize_item', delivery: ['background'] },
  ],
  scroll: { vertical: 0 },
  selection: { multiple: false, required: false },
}
/** 前台模式开启时读取到的按钮：指针动作带有 foreground delivery，后台动作不变。 */
const 前台按钮: DesktopElement = {
  ref: 'e16',
  parentRef: 'e1',
  depth: 1,
  role: 'button',
  name: '前台',
  automationId: 'fgButton',
  enabled: true,
  offscreen: false,
  rect: { x: 400, y: 300, width: 100, height: 30 },
  actions: [
    { action: 'invoke', delivery: ['background'] },
    { action: 'click', delivery: ['foreground'] },
    { action: 'hover', delivery: ['foreground'] },
    { action: 'drag', delivery: ['foreground'] },
    { action: 'wheel', delivery: ['foreground'] },
  ],
}
/** 持有键盘焦点的控件。键盘动作只附加在该控件上。 */
const 焦点框: DesktopElement = {
  ref: 'e17',
  parentRef: 'e1',
  depth: 1,
  role: 'edit',
  name: '焦点',
  automationId: 'focusBox',
  value: '',
  enabled: true,
  offscreen: false,
  focused: true,
  rect: { x: 400, y: 400, width: 100, height: 24 },
  actions: [
    { action: 'set_value', delivery: ['background'] },
    { action: 'click', delivery: ['foreground'] },
    { action: 'type_text', delivery: ['foreground'] },
    { action: 'press_key', delivery: ['foreground'] },
  ],
}
/** 前台模式开启时的窗口根：窗口动作附加在窗口根上。 */
const 前台窗口: DesktopElement = {
  ...窗口,
  actions: [
    { action: 'activate', delivery: ['foreground'] },
    { action: 'set_window_state', delivery: ['foreground'] },
    { action: 'close_window', delivery: ['foreground'] },
    { action: 'move_window', delivery: ['foreground'] },
    { action: 'resize_window', delivery: ['foreground'] },
  ],
}
/**
 * 自绘界面的观察：树上只有窗口根，没有任何业务控件。
 *
 * 键盘动作附加在窗口根上：这类窗口无法提供持有焦点的控件。
 */
const 自绘窗口: DesktopElement = {
  ...窗口,
  name: '自绘',
  actions: [
    { action: 'activate', delivery: ['foreground'] },
    { action: 'type_text', delivery: ['foreground'] },
    { action: 'press_key', delivery: ['foreground'] },
  ],
}

const 文档框: DesktopElement = {
  ref: 'e15',
  parentRef: 'e1',
  depth: 1,
  role: 'edit',
  name: '正文',
  automationId: 'doc',
  value: '第一行中文内容',
  enabled: true,
  offscreen: false,
  actions: [
    { action: 'set_value', delivery: ['background'] },
    { action: 'select_text', delivery: ['background'] },
  ],
  text: true,
}

/** 收起的组合框：控件表中没有它的项，选中项只在 selection.selected 中。 */
const 组合框: DesktopElement = {
  ref: 'e18',
  parentRef: 'e1',
  depth: 1,
  role: 'combo_box',
  name: '部门',
  automationId: 'deptCombo',
  enabled: true,
  offscreen: false,
  actions: [
    { action: 'expand', delivery: ['background'] },
    { action: 'collapse', delivery: ['background'] },
  ],
  expand: 'collapsed',
  selection: { multiple: false, required: false, selected: ['市场部'] },
}

const TABLE = [
  窗口,
  工具栏,
  工具栏保存,
  表单组,
  输入框,
  表单保存,
  灰按钮,
  滑块,
  进度条,
  三态复选,
  单选列表,
  单选项,
  树节点,
  长列表,
  文档框,
  组合框,
]

/** 前台模式开启时的控件表。窗口根替换为带窗口动作的版本。 */
const FOREGROUND_TABLE = [前台窗口, ...TABLE.slice(1), 前台按钮, 焦点框]

/** 一个控件在 TABLE 中的全部祖先 ref，由近及远。 */
function ancestorsOf(element: DesktopElement): string[] {
  const out: string[] = []
  let at = element.parentRef
  while (at !== undefined) {
    out.push(at)
    at = TABLE.find((e) => e.ref === at)?.parentRef
  }
  return out
}

function snapshot(over: Partial<DesktopSnapshot> = {}): DesktopSnapshot {
  return {
    windowId: 'dw_1',
    app: '记事本',
    title: '未命名',
    observationId: 'do_1',
    capturedAt: 1,
    elements: TABLE,
    truncated: false,
    truncatedBy: [],
    filteredBy: [],
    visited: TABLE.length,
    windowEnabled: true,
    windowCovered: false,
    ...over,
  }
}

/**
 * 足以让 `imageSizeOf` 识别宽高的 PNG 字节：签名加 IHDR 头。
 *
 * 有意不含像素数据：长边在 `MAX_EDGE` 以内时 `shrinkImage` 不修改任何字节，
 * 该路径上不会解码图像。
 */
function png(width: number, height: number): string {
  const bytes = new Uint8Array(33)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set([0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52], 8)
  new DataView(bytes.buffer).setUint32(16, width)
  new DataView(bytes.buffer).setUint32(20, height)
  return Buffer.from(bytes).toString('base64')
}

function image(over: Partial<DesktopImage> = {}): DesktopImage {
  return {
    app: '记事本',
    title: '未命名',
    imageRef: 'di_1',
    data: png(506, 453),
    mime: 'image/png',
    geometry: {
      imageWidth: 506,
      imageHeight: 453,
      screen: { x: 87, y: 80, width: 506, height: 453 },
      dpi: 96,
      generation: '80,80,520,460@96#65537',
    },
    source: 'wgc',
    capturedAt: 2,
    ...over,
  }
}

interface Recorded {
  method: string
  input: unknown
}

function fakeDesktop(over: Partial<DesktopPort> = {}): {
  port: DesktopPort
  calls: Recorded[]
} {
  const calls: Recorded[] = []
  const note = (method: string, input: unknown) => {
    calls.push({ method, input })
  }
  const acted = (input: unknown): DesktopActResult => {
    note('act', input)
    return {
      dispatch: 'submitted',
      actionId: 'da_1',
      observation: snapshot({
        observationId: 'do_2',
        elements: [{ ...输入框, value: '张三' }],
      }),
    }
  }
  const base: DesktopPort = {
    foregroundEnabled: () => true,
    windows: async () => {
      note('windows', null)
      return [{ windowId: 'dw_1', app: '记事本', title: '未命名' }]
    },
    observe: async (input) => {
      note('observe', input)
      return snapshot({ windowId: input.windowId })
    },
    elements: (windowId, observationId) =>
      windowId === 'dw_1' && observationId === 'do_1' ? TABLE : null,
    captureImage: async (input) => {
      note('captureImage', input)
      return image()
    },
    act: async (input) => acted(input),
    readText: async (input) => {
      note('readText', input)
      return {
        app: '记事本',
        title: '未命名',
        text: '这是一段文本',
        truncated: false,
        selectionSupport: 'single',
        selection: [],
      }
    },
    wait: async (input) => {
      note('wait', input)
      return { found: true, observation: snapshot({ observationId: 'do_3' }) }
    },
    release: async () => {},
  }
  return { port: { ...base, ...over }, calls }
}

function ctxWith(desktop?: DesktopPort, signal = new AbortController().signal): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    conversationId: 'cv_test',
    runId: 'rn_test',
    model: 'test',
    contextWindow: 200_000,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: openBatchBudget(new Map(), Number.POSITIVE_INFINITY),
    sink: null,
    signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
    ...(desktop ? { desktop } : {}),
  }
}

function run(
  spec: ToolSpec,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  return spec.fn(args, ctx)
}

describe('注册元数据', () => {
  test('五个工具均属于 desktop 类目，权限效果单独列出', () => {
    expect(desktopTools.map((t) => t.name)).toEqual([
      'desktop_windows',
      'desktop_observe',
      'desktop_act',
      'desktop_act_sequence',
      'desktop_wait',
    ])
    for (const spec of desktopTools) {
      expect(spec.category).toBe('desktop')
      expect(spec.permissionEffect).toBe('desktop')
    }
  })

  /** 句柄进入参数表后，模型能够自行构造目标，因此参数表中不得出现句柄。 */
  test('参数表中没有窗口句柄，只有不透明 id', () => {
    for (const spec of desktopTools) {
      const props = (spec.parameters as { properties?: Record<string, unknown> }).properties ?? {}
      expect(Object.keys(props)).not.toContain('window')
      expect(Object.keys(props)).not.toContain('handle')
      expect(Object.keys(props)).not.toContain('pid')
    }
  })
})

describe('没有端口与已停止', () => {
  test('没有端口时如实报告，不视为已执行', async () => {
    const r = await run(desktopWindowsTool, {}, ctxWith())
    expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: 'unsupported' })
  })

  test('本轮已停止时不再发起新动作', async () => {
    const controller = new AbortController()
    controller.abort()
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e3' },
      ctxWith(port, controller.signal),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: 'aborted' })
    expect(calls).toEqual([])
  })
})

describe('目标解析与层级消歧', () => {
  test('仅在按 ref 唯一命中时交给端口', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_value',
        ref: 'e5',
        value: '张三',
      },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls).toEqual([
      {
        method: 'act',
        input: {
          windowId: 'dw_1',
          observationId: 'do_1',
          ref: 'e5',
          action: { kind: 'set_value', value: '张三' },
        },
      },
    ])
  })

  test('按 automationId 唯一命中', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', automationId: 'save2' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls[0]).toMatchObject({ input: { ref: 'e6' } })
  })

  /**
   * 两个同名按钮，选择第一个可能在错误的控件上执行动作，且不报错。
   *
   * 回执必须让模型能够区分两者：只有祖先路径能说明「一个在工具栏里、一个在文件组里」。
   */
  test('同名歧义时不执行，候选附带祖先路径返回给模型', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', name: '保存' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_target_ambiguous' })
    expect(r.message).toContain('e3')
    expect(r.message).toContain('e6')
    expect(r.message).toContain('window「另存为」 > tool_bar')
    expect(r.message).toContain('window「另存为」 > group「文件」')
    expect(calls).toEqual([])
  })

  /** 候选清单与动作回执共用长值规则：十个候选各输出一份长值会使整条结果超出上限。 */
  test('候选控件的长值只输出字数，原文不进入 message', async () => {
    const 长值 = '文'.repeat(60_000)
    const { port } = fakeDesktop({
      elements: () => [
        { ...窗口 },
        { ...工具栏 },
        { ...工具栏保存, value: 长值 },
        { ...表单组 },
        { ...表单保存, value: 长值 },
      ],
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', name: '保存' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_target_ambiguous' })
    expect(r.message).toContain(`值 ${长值.length} 字`)
    expect(r.message).not.toContain('文文文文文文')
    expect(r.message.length).toBeLessThan(500)
  })

  /** 祖先不在表中时只输出已找到的部分，不虚构路径。 */
  test('父控件不在本表中时祖先路径只写到中断处', async () => {
    const partial = [表单保存, 灰按钮].map((e) => ({ ...e }))
    const { port } = fakeDesktop({
      elements: () => [...partial, { ...工具栏保存 }],
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', name: '保存' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ errorKind: 'desktop_target_ambiguous' })
    expect(r.message).not.toContain('位于')
  })

  test('附加 role 收窄后仍不唯一即为歧义，无命中即为缺失', async () => {
    const { port } = fakeDesktop()
    const missing = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', name: '查无此名' },
      ctxWith(port),
    )
    expect(missing).toMatchObject({ executed: false, errorKind: 'desktop_target_missing' })
  })

  test('观察过期时要求重新观察，不发送任何帧', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_0', action: 'invoke', ref: 'e3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_observation_stale' })
    expect(calls).toEqual([])
  })

  test('本次观察中不存在的 ref 直接拒绝', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e99' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_ref_unknown' })
    expect(calls).toEqual([])
  })
})

describe('动作前置条件', () => {
  test('控件被禁用时不派发', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e7' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_precondition' })
    expect(calls).toEqual([])
  })

  test('控件不支持该动作时不派发，并说明它支持的动作', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'set_value', ref: 'e3', value: 'x' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_action_unsupported' })
    expect(r.message).toContain('invoke')
    expect(calls).toEqual([])
  })

  test('set_value 缺少 value 属于参数错误；空串表示清空，照常发送', async () => {
    const { port, calls } = fakeDesktop()
    const missing = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'set_value', ref: 'e5' },
      ctxWith(port),
    )
    expect(missing).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])

    await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'set_value', ref: 'e5', value: '' },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({ input: { action: { kind: 'set_value', value: '' } } })
  })

  test('invoke 带 value 属于参数错误，不静默忽略', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e3', value: 'x' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])
  })
})

describe('动作族：参数、目标态与前置条件', () => {
  /** 可用动作表能说明此刻能否执行，只读控件的动作项 delivery 为空且附带原因。 */
  test('delivery 为空的动作在本地即被拒绝，并如实返回原因', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_range_value',
        ref: 'e9',
        number: 50,
      },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_action_unsupported' })
    expect(r.message).toContain('read_only')
    expect(calls).toEqual([])
  })

  test('数值越界时在本地按观察中的区间拒绝，不截断到边界值', async () => {
    const { port, calls } = fakeDesktop()
    const over = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_range_value',
        ref: 'e8',
        number: 120,
      },
      ctxWith(port),
    )
    expect(over).toMatchObject({ executed: false, errorKind: 'desktop_precondition' })
    expect(over.message).toContain('0 到 100')
    expect(calls).toEqual([])

    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_range_value',
        ref: 'e8',
        number: 42,
      },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({ input: { action: { kind: 'set_range_value', value: 42 } } })
  })

  /** 参数是目标状态：已处于该状态时不发送动作，也不执行一次切换。 */
  test('set_toggle 按目标状态发送，已处于目标状态时不发送', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_toggle',
        ref: 'e10',
        state: 'indeterminate',
      },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({
      input: { action: { kind: 'set_toggle', state: 'indeterminate' } },
    })

    const again = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_toggle',
        ref: 'e10',
        state: 'off',
      },
      ctxWith(port),
    )
    expect(again).toMatchObject({ executed: false, errorKind: 'desktop_precondition' })
    expect(calls).toHaveLength(1)
  })

  /** 容器的多选约束位于祖先的字段上，本地沿 parentRef 即可判定。 */
  test('单选容器上的增选在本地被拒绝，select 照常发送', async () => {
    const { port, calls } = fakeDesktop()
    const add = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'add_to_selection', ref: 'e12' },
      ctxWith(port),
    )
    expect(add).toMatchObject({ executed: false, errorKind: 'desktop_precondition' })
    expect(calls).toEqual([])

    await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'select', ref: 'e12' },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({ input: { action: { kind: 'select' } } })
  })

  test('已收起的树节点不再 collapse，expand 照常发送', async () => {
    const { port, calls } = fakeDesktop()
    const again = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'collapse', ref: 'e13' },
      ctxWith(port),
    )
    expect(again).toMatchObject({ executed: false, errorKind: 'desktop_precondition' })
    expect(calls).toEqual([])

    await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'expand', ref: 'e13' },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({ input: { action: { kind: 'expand' } } })
  })

  test('scroll 的方向必填，步长默认一行', async () => {
    const { port, calls } = fakeDesktop()
    const missing = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'scroll', ref: 'e14' },
      ctxWith(port),
    )
    expect(missing).toMatchObject({ executed: false, errorKind: 'invalid_argument' })

    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'scroll',
        ref: 'e14',
        direction: 'down',
      },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({
      input: { action: { kind: 'scroll', direction: 'down', step: 'line' } },
    })
  })

  test('realize_item 必须提供项名，select_text 必须提供起点与长度', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'realize_item',
        ref: 'e14',
        itemName: 'row-0900',
      },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({
      input: { action: { kind: 'realize_item', name: 'row-0900' } },
    })

    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'select_text',
        ref: 'e15',
        start: 3,
        length: 4,
      },
      ctxWith(port),
    )
    expect(calls[1]).toMatchObject({
      input: { action: { kind: 'select_text', start: 3, length: 4 } },
    })

    const bare = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'realize_item', ref: 'e14' },
      ctxWith(port),
    )
    expect(bare).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  })

  /** 不属于该动作的参数一律拒绝：静默忽略会使未发生的写入看似已经发生。 */
  test('参数不属于该动作时拒绝，不静默忽略', async () => {
    const { port, calls } = fakeDesktop()
    for (const args of [
      { action: 'invoke', ref: 'e3', value: 'x' },
      { action: 'expand', ref: 'e13', number: 1 },
      { action: 'set_toggle', ref: 'e10', state: 'on', value: 'x' },
    ]) {
      const r = await run(
        desktopActTool,
        { windowId: 'dw_1', observationId: 'do_1', ...args },
        ctxWith(port),
      )
      expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    }
    expect(calls).toEqual([])
  })
})

describe('按需字段', () => {
  /** 两个开关相互独立，都只在显式关闭时才交给端口。 */
  test('includeValue 与 includeState 只在关闭时传给端口', async () => {
    const { port, calls } = fakeDesktop()
    await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(calls[0]).toEqual({ method: 'observe', input: { windowId: 'dw_1' } })

    await run(
      desktopObserveTool,
      { windowId: 'dw_1', includeValue: false, includeState: false },
      ctxWith(port),
    )
    expect(calls[1]).toEqual({
      method: 'observe',
      input: { windowId: 'dw_1', includeValue: false, includeState: false },
    })

    await run(desktopObserveTool, { windowId: 'dw_1', includeState: true }, ctxWith(port))
    expect(calls[2]).toEqual({ method: 'observe', input: { windowId: 'dw_1' } })
  })
})

describe('选择容器的选中项', () => {
  /** 收起的组合框在表中没有子控件，选中项只能由容器的字段提供。 */
  test('收起的组合框随观察提供选中项', async () => {
    const { port } = fakeDesktop()
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    const table = (r.data as unknown as DesktopSnapshot).elements
    const combo = table.find((e) => e.automationId === 'deptCombo')
    expect(combo?.selection?.selected).toEqual(['市场部'])
    expect(table.filter((e) => e.parentRef === combo?.ref)).toEqual([])
  })

  /** 修改选中项后，同次带回的观察中容器已是新值：模型无需再单独观察一次。 */
  test('动作同次带回的观察中容器的选中项已更新', async () => {
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'submitted',
        actionId: 'da_9',
        observation: snapshot({
          observationId: 'do_2',
          elements: [
            {
              ...单选列表,
              selection: { multiple: false, required: false, selected: ['single-alpha'] },
            },
            { ...单选项, selected: true },
          ],
        }),
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'select', ref: 'e12' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    const observation = (r.data as { observation: DesktopSnapshot }).observation
    expect(observation.elements.find((e) => e.ref === 'e11')?.selection?.selected).toEqual([
      'single-alpha',
    ])
  })

  /** 目标本身是容器时，该行输出选中项；列表不完整时一并说明。 */
  test('目标是容器时该行输出选中项与列表不完整的事实', async () => {
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'submitted',
        actionId: 'da_10',
        observation: snapshot({
          observationId: 'do_2',
          elements: [
            {
              ...长列表,
              selection: {
                multiple: true,
                required: false,
                selected: ['甲', '乙'],
                truncated: true,
              },
            },
          ],
        }),
      }),
    })
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'scroll',
        ref: 'e14',
        direction: 'down',
      },
      ctxWith(port),
    )
    expect(r.message).toContain('选中 "甲"、"乙" 等')
  })

  /** includeState=false 的观察中没有该字段，因此该行不输出选中项。 */
  test('不读取状态细节时该行不输出选中项', async () => {
    const 无状态长列表: DesktopElement = { ...长列表 }
    delete 无状态长列表.selection
    delete 无状态长列表.scroll
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'submitted',
        actionId: 'da_11',
        observation: snapshot({ observationId: 'do_2', elements: [无状态长列表] }),
      }),
    })
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'scroll',
        ref: 'e14',
        direction: 'down',
      },
      ctxWith(port),
    )
    expect(r.message).toContain('e14')
    expect(r.message).not.toContain('选中')
  })
})

describe('读取文本与选区', () => {
  test('capture=text 读取文档文本与选区，不更换观察编号', async () => {
    const { port, calls } = fakeDesktop({
      readText: async (input) => {
        calls.push({ method: 'readText', input })
        return {
          app: '记事本',
          title: '未命名',
          text: '第一行中文内容',
          truncated: true,
          selectionSupport: 'single',
          selection: [{ start: 3, text: '中文', truncated: false }],
        }
      },
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'text', observationId: 'do_1', ref: 'e15', maxChars: 50 },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls).toEqual([
      {
        method: 'readText',
        input: { windowId: 'dw_1', observationId: 'do_1', ref: 'e15', maxChars: 50 },
      },
    ])
    expect(r.data).toMatchObject({ ref: 'e15', truncated: true, selectionSupport: 'single' })
    expect(r.message).toContain('截断')
  })

  test('没有 TextPattern 的控件无法读取文本，不发送任何帧', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'text', observationId: 'do_1', ref: 'e3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ errorKind: 'desktop_action_unsupported' })
    expect(r.message).toContain('未提供 value')
    expect(r.message).not.toContain('当前值已在')
    expect(calls).toEqual([])
  })

  test('容器没有文本和值时提示读取子树，按提示可以取得控件表', async () => {
    const { port, calls } = fakeDesktop()
    const context = ctxWith(port)
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'text', observationId: 'do_1', ref: 'e4' },
      context,
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_action_unsupported' })
    expect(r.message).toContain('capture=structure、root=e4')
    expect(r.message).not.toContain('value 里')
    expect(calls).toEqual([])
    const next = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'structure', observationId: 'do_1', root: 'e4' },
      context,
    )
    expect(next.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['observe'])
  })

  test.each(['', '当前内容'])('仅在控件有 value 时提示读取值（%j）', async (value) => {
    const { port, calls } = fakeDesktop({ elements: () => [{ ...输入框, value }] })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'text', observationId: 'do_1', ref: 'e5' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_action_unsupported' })
    expect(r.message).toContain('当前值已在观察的 value 中')
    expect(calls).toEqual([])
  })
})

describe('三态回执与动作后观察', () => {
  /** 动作同次带回新观察：模型无需单独 observe 即可发送下一个动作。 */
  test('submitted 表示成功，结果中包含动作身份与新的观察编号', async () => {
    const { port } = fakeDesktop()
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_value',
        ref: 'e5',
        value: '张三',
      },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.data).toMatchObject({ dispatch: 'submitted', actionId: 'da_1' })
    const observation = (r.data as { observation: DesktopSnapshot }).observation
    expect(observation.observationId).toBe('do_2')
    expect(r.message).toContain('do_2')
    // 目标控件的新值直接出现在回执中，无需再读取一次。
    expect(r.message).toContain('张三')
  })

  test('not_dispatched 表示未执行，executed 为假', async () => {
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'not_dispatched',
        actionId: 'da_2',
        reason: 'read_only',
        observation: null,
        observationError: '动作没有派发，没有重读',
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'desktop_not_dispatched',
    })
    expect(r.message).toContain('read_only')
    expect(r.data).toMatchObject({ dispatch: 'not_dispatched' })
  })

  test('未派发也交付窗口准备后的新观察，仍明确标记动作未执行', async () => {
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'not_dispatched',
        actionId: 'da_2',
        reason: 'geometry_changed: minimized → restored',
        observation: snapshot({ observationId: 'do_2' }),
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'desktop_not_dispatched',
    })
    expect(r.data).toMatchObject({
      dispatch: 'not_dispatched',
      observation: { observationId: 'do_2' },
    })
    expect(r.message).toContain('未执行')
    expect(r.message).toContain('do_2')
  })

  /** 结果未知时禁止重发：它必须记为已执行。 */
  test('unknown 记为已执行，并要求先重新观察', async () => {
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'unknown',
        actionId: 'da_3',
        reason: 'provider 无响应',
        observation: null,
        observationError: '宿主不可用，动作之后没有重读',
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'desktop_unknown' })
    expect(r.message).toContain('结果未确认')
    expect(r.message).toContain('provider 无响应')
    expect(r.data).toMatchObject({ dispatch: 'unknown', actionId: 'da_3' })
  })

  /** 重读失败不改变执行事实：动作已经发出。 */
  test('submitted 但重读失败时仍记为已执行', async () => {
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'submitted',
        actionId: 'da_4',
        observation: null,
        observationError: '窗口已关闭',
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_observation_unavailable',
    })
    expect(r.data).toMatchObject({ dispatch: 'submitted' })
  })

  /**
   * 调用未返回时目标窗口无法读取，宿主改为返回窗口清单。回执必须指明新出现的窗口，
   * 模型下一步观察该窗口而不是目标窗口。
   */
  test('调用未返回时回执给出新窗口的 windowId，不报告无法读取控件表', async () => {
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'submitted',
        actionId: 'da_5',
        reason: '调用尚未返回，目标窗口已被禁用',
        observation: null,
        observationError: 'target_blocked: 动作调用尚未返回，没有重读目标窗口',
        blocking: [
          { windowId: 'dw_1', app: 'fixture.exe', title: '夹具', appeared: false },
          { windowId: 'dw_9', app: 'fixture.exe', title: '另存为', appeared: true },
        ],
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e3' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.message).toContain('dw_9')
    expect(r.message).toContain('另存为')
    expect(r.message).toContain('调用未返回')
    // 已有的目标窗口不列出：只指明新出现的窗口。
    expect(r.message).not.toContain('dw_1 fixture.exe 夹具')
    expect(r.data).toMatchObject({ dispatch: 'submitted' })
  })

  /** 结果未知时仍必须要求先读取状态，不得重放。 */
  test('调用未返回且没有证据时为 unknown，仍要求先重新观察', async () => {
    const { port } = fakeDesktop({
      act: async () => ({
        dispatch: 'unknown',
        actionId: 'da_6',
        reason: 'call_pending: 动作调用尚未返回，也没有可核实的生效证据',
        observation: null,
        observationError: 'target_blocked: 动作调用尚未返回，没有重读目标窗口',
        blocking: [{ windowId: 'dw_1', app: 'fixture.exe', title: '夹具', appeared: false }],
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'desktop_unknown' })
    expect(r.message).toContain('结果未确认')
    // 没有新窗口时如实列出当前窗口，不虚报新窗口。
    expect(r.message).toContain('当前窗口')
  })

  /** 端口自行声明的执行前拒绝优先于「已调用端口」这一判据。 */
  test('端口按 DesktopRefusal 拒绝时不记为已执行', async () => {
    class Refused extends Error implements DesktopRefusal {
      readonly errorKind = 'desktop_unavailable' as const
      readonly executed = false as const
    }
    const { port } = fakeDesktop({
      act: async () => {
        throw new Refused('本次执行的电脑控制已经结束')
      },
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_unavailable' })
  })
})

describe('局部读取、视图筛选与字段选择', () => {
  test('子树根与字段选择交给端口，角色与文字不交给端口', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopObserveTool,
      {
        windowId: 'dw_1',
        root: 'e4',
        role: 'button',
        query: '保存',
        includeValue: false,
      },
      ctxWith(port),
    )
    expect(calls[0]).toEqual({
      method: 'observe',
      input: { windowId: 'dw_1', root: 'e4', includeValue: false },
    })
  })

  test('角色与文字只筛选交给模型的视图：命中的控件连同祖先列出，并说明其余控件仍在观察中', async () => {
    const { port } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', role: 'button', query: '保存' },
      ctxWith(port),
    )
    const hits = TABLE.filter((e) => e.role === 'button' && e.name.includes('保存'))
    expect(hits.length).toBeGreaterThan(0)
    const refs = (r.data as { elements: DesktopElement[] }).elements.map((e) => e.ref)
    for (const hit of hits) expect(refs).toContain(hit.ref)
    for (const ref of refs) {
      const element = TABLE.find((e) => e.ref === ref)
      const isHit = hits.some((h) => h.ref === ref)
      const isAncestor = hits.some((h) => ancestorsOf(h).includes(ref))
      expect(isHit || isAncestor).toBe(true)
      expect(element).toBeDefined()
    }
    expect(r.data).toMatchObject({
      viewFilter: ['role=button', 'query=保存'],
      matched: hits.length,
    })
    expect(r.message).toContain('其余控件仍在本次观察中')
  })

  /**
   * 原始失败形状：按文字筛选出密码框之后，用同一份观察对登录按钮执行动作，返回「没有匹配的控件」。
   * 视图筛选不缩小控件表，筛选视图之外的控件仍能按同一个观察编号执行。
   */
  test('筛选视图之后，视图外的控件仍按同一个观察编号执行', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(desktopObserveTool, { windowId: 'dw_1', query: '姓名' }, ctxWith(port))
    const shown = (r.data as { elements: DesktopElement[] }).elements.map((e) => e.ref)
    expect(shown).not.toContain(表单保存.ref)
    const acted = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 表单保存.ref },
      ctxWith(port),
    )
    expect(acted.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['observe', 'act'])
  })

  test('未提供筛选参数时不向端口传递任何筛选条件', async () => {
    const { port, calls } = fakeDesktop()
    await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(calls[0]).toEqual({ method: 'observe', input: { windowId: 'dw_1' } })
  })

  test('观察的上限按参数范围截断，无法解析为数字即为参数错误', async () => {
    const { port, calls } = fakeDesktop()
    await run(desktopObserveTool, { windowId: 'dw_1', maxNodes: 99_999 }, ctxWith(port))
    expect(calls[0]).toMatchObject({ input: { windowId: 'dw_1', maxNodes: 4000 } })

    const bad = await run(desktopObserveTool, { windowId: 'dw_1', maxDepth: '很多' }, ctxWith(port))
    expect(bad).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  })

  /** 截断与读取范围含义不同：前者表示未读取完整，后者表示只读取了指定范围，回执中分别说明。 */
  test('截断与读取范围分别如实报告', async () => {
    const { port } = fakeDesktop({
      observe: async (input) =>
        snapshot({
          windowId: input.windowId,
          truncated: true,
          truncatedBy: ['max_nodes'],
          filteredBy: ['root=e4'],
          visited: 900,
        }),
    })
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(r.message).toContain('max_nodes')
    expect(r.message).toContain('root=e4')
    expect(r.data).toMatchObject({ visited: 900 })
  })

  /** 模态窗口遮挡时任何控件都无法操作，该说明必须出现在读数中。 */
  test('窗口被遮挡时观察如实说明', async () => {
    const { port } = fakeDesktop({
      observe: async (input) => snapshot({ windowId: input.windowId, windowEnabled: false }),
    })
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(r.message).toContain('模态窗口')
  })

  /**
   * 原始失败形状：被遮挡的浏览器窗口只返回外框且不计为截断，模型把用户的页面当作空页并改写了地址栏。
   * 读数必须说明窗口被遮挡，控件表同时照常交付。
   */
  test('窗口被遮挡时读数如实说明，结果中包含该字段', async () => {
    const { port } = fakeDesktop({
      observe: async (input) => snapshot({ windowId: input.windowId, windowCovered: true }),
    })
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(r.message).toContain('窗口被遮挡或已最小化')
    expect(r.data).toMatchObject({ windowCovered: true })
  })

  test('窗口未被遮挡时读数不包含该说明', async () => {
    const { port } = fakeDesktop()
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(r.message).not.toContain('窗口被遮挡')
  })
})

describe('采集模式', () => {
  /** 默认不采集图像：每增加一次采集，目标进程即增加一次合成与一次编码。 */
  test('未提供 capture 时只读取结构，不调用端口的采集入口', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(calls.map((c) => c.method)).toEqual(['observe'])
    expect(r.data).not.toHaveProperty('images')
    expect(r.data).not.toHaveProperty('imageRef')
  })

  test('capture=structure 同样不采集图像', async () => {
    const { port, calls } = fakeDesktop()
    await run(desktopObserveTool, { windowId: 'dw_1', capture: 'structure' }, ctxWith(port))
    expect(calls.map((c) => c.method)).toEqual(['observe'])
  })

  test('capture=region_image 只采集图像，不读取控件树', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image' },
      ctxWith(port),
    )
    expect(calls).toEqual([{ method: 'captureImage', input: { windowId: 'dw_1', maxEdge: 1568 } }])
    expect(r.status).toBe('success')
    expect(r.data).toMatchObject({ imageRef: 'di_1', source: 'wgc', imageCapturedAt: 2 })
  })

  test('capture=combined 同时读取控件树与图像，两个时刻分别记录', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'combined' },
      ctxWith(port),
    )
    expect(calls.map((c) => c.method)).toEqual(['observe', 'captureImage'])
    expect(r.data).toMatchObject({ capturedAt: 1, imageCapturedAt: 2, observationId: 'do_1' })
  })

  /** 已读取的控件树照常返回：图像采集失败不应使本次观察一并作废。 */
  test('combined 采图失败时仍返回控件表，并说明缺少图像的原因', async () => {
    const { port } = fakeDesktop({
      captureImage: async () => {
        throw new Error('window_minimized: 窗口已最小化，无法采集内容')
      },
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'combined' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.data).toMatchObject({ observationId: 'do_1' })
    expect(r.data).not.toHaveProperty('images')
    expect(String(r.data?.imageError)).toContain('window_minimized')
    expect(r.message).toContain('未采集到图像')
  })

  test('采集区域参数只在采集图像的模式下有效', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', around: 'e5', observationId: 'do_1' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])
  })

  test('around 与 imageRef 同时提供时不选择其一，立即拒绝', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      {
        windowId: 'dw_1',
        capture: 'region_image',
        around: 'e5',
        observationId: 'do_1',
        imageRef: 'di_1',
        imageRect: { x: 0, y: 0, width: 10, height: 10 },
      },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])
  })
})

describe('按控件与按图确定采集区域', () => {
  test('around 将控件包围盒向外扩展若干像素后交给端口', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopObserveTool,
      {
        windowId: 'dw_1',
        capture: 'region_image',
        observationId: 'do_1',
        around: 'e5',
        pad: 20,
      },
      ctxWith(port),
    )
    expect(calls[0]).toEqual({
      method: 'captureImage',
      input: {
        windowId: 'dw_1',
        maxEdge: 1568,
        region: { x: 280, y: 180, width: 160, height: 64 },
      },
    })
  })

  /**
   * combined 先读取控件树，旧观察编号随之作废。用调用方提供的编号解析 around，
   * 解析依据的是一份已不存在的表。
   */
  test('combined 的 around 按本次读取的控件表解析', async () => {
    const { port, calls } = fakeDesktop({
      // 该端口只接受 do_1；combined 读取控件树后取得的是 do_1 的内容，但不应再查询一次。
      elements: () => null,
      observe: async (input) => snapshot({ windowId: input.windowId, observationId: 'do_9' }),
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'combined', around: 'e5', pad: 5 },
      ctxWith(port),
    )
    // `elements` 恒返回 null：调用它会以「观察已失效」结束，无法采集图像。
    expect(r.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['captureImage'])
    expect(calls[0]).toMatchObject({
      input: { region: { x: 295, y: 195, width: 130, height: 34 } },
    })
  })

  test('combined 不接受 observationId', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'combined', observationId: 'do_1', around: 'e5' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])
  })

  test('未提供 pad 时按包围盒本身确定采集区域', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image', observationId: 'do_1', around: 'e5' },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({
      input: { region: { x: 300, y: 200, width: 120, height: 24 } },
    })
  })

  /** 没有包围盒的控件无法确定采集区域，构造的矩形采集到的是其他位置的画面。 */
  test('控件没有包围盒时拒绝采集，不发送任何帧', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image', observationId: 'do_1', around: 'e3' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_no_bounds' })
    expect(calls).toEqual([])
  })

  test('观察失效时 around 在本地即被拦截', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image', observationId: 'do_9', around: 'e5' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_observation_stale' })
    expect(calls).toEqual([])
  })

  test('imageRef 加 imageRect 原样交给端口换算', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopObserveTool,
      {
        windowId: 'dw_1',
        capture: 'region_image',
        imageRef: 'di_1',
        imageRect: { x: 10, y: 20, width: 100, height: 50 },
      },
      ctxWith(port),
    )
    expect(calls[0]).toEqual({
      method: 'captureImage',
      input: {
        windowId: 'dw_1',
        maxEdge: 1568,
        imageRef: 'di_1',
        imageRect: { x: 10, y: 20, width: 100, height: 50 },
      },
    })
  })

  test('提供 imageRef 而未提供 imageRect 时拒绝，不发送任何帧', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image', imageRef: 'di_1' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])
  })

  /** 失效的 imageRef 由端口判定，工具原样透传它的拒绝。 */
  test('端口拒绝失效的 imageRef 时原样返回给模型', async () => {
    const { port } = fakeDesktop({
      captureImage: async () => {
        const err = Object.assign(new Error('di_1 已失效：桌面宿主的代际已变化，请重新采图'), {
          errorKind: 'invalid_argument',
          executed: false,
        })
        throw err
      },
    })
    const r = await run(
      desktopObserveTool,
      {
        windowId: 'dw_1',
        capture: 'region_image',
        imageRef: 'di_1',
        imageRect: { x: 0, y: 0, width: 10, height: 10 },
      },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(r.message).toContain('已失效')
  })
})

describe('图片通道与几何核对', () => {
  /** base64 留在 message 中模型无法理解，只会按长度计费；字节只经由 data.images 传递。 */
  test('图像字节经由 images 通道传递，不进入回执正文', async () => {
    const { port } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image' },
      ctxWith(port),
    )
    const images = (r.data as { images?: { data: string; mime: string }[] }).images ?? []
    expect(images).toHaveLength(1)
    expect(images[0]?.mime).toBe('image/png')
    expect(images[0]?.data.length).toBeGreaterThan(0)
    expect(r.message).not.toContain(images[0]?.data ?? '')
  })

  test('几何随图像一起返回，包含图像尺寸与对应的屏幕矩形', async () => {
    const { port } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image' },
      ctxWith(port),
    )
    expect(r.data).toMatchObject({
      geometry: {
        imageWidth: 506,
        imageHeight: 453,
        screen: { x: 87, y: 80, width: 506, height: 453 },
        dpi: 96,
      },
    })
    expect(r.message).toContain('506×453')
    expect(r.message).toContain('87,80')
  })

  /**
   * 几何在采集端确定，此处只核对。
   *
   * 尺寸不一致说明模型看到的图像与几何记录的不是同一张，按图计算的屏幕坐标是错误的。
   */
  test('图像尺寸与几何不一致时不把这张图交给模型', async () => {
    const { port } = fakeDesktop({
      captureImage: async () => image({ data: png(320, 240) }),
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', errorKind: 'desktop_image_mismatch' })
    expect(r.data).toBeUndefined()
  })

  test('combined 下尺寸不一致时仍返回控件表，不返回图像', async () => {
    const { port } = fakeDesktop({
      captureImage: async () => image({ data: png(320, 240) }),
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'combined' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.data).toMatchObject({ observationId: 'do_1' })
    expect(r.data).not.toHaveProperty('images')
    expect(String(r.data?.imageError)).toContain('不一致')
  })

  /** 备用方式采集时未重绘的区域为黑色，模型需要知道该图像能否作为依据。 */
  test('备用方式采集在回执中注明', async () => {
    const { port } = fakeDesktop({
      captureImage: async () => image({ source: 'print_window' }),
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image' },
      ctxWith(port),
    )
    expect(r.data).toMatchObject({ source: 'print_window' })
    expect(r.message).toContain('黑色')
  })
})

describe('不接受图片的模型', () => {
  /** 采集模型无法查看的图像需要付出完整的采集与编码开销，因此在采集之前即拒绝。 */
  test('vision=false 时采集图像的模式在发送请求之前拒绝', async () => {
    const { port, calls } = fakeDesktop()
    const ctx = { ...ctxWith(port), vision: false as const }
    for (const capture of ['region_image', 'combined']) {
      const r = await run(desktopObserveTool, { windowId: 'dw_1', capture }, ctx)
      expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: 'unsupported' })
      expect(r.message).toContain('capture=structure')
    }
    expect(calls).toEqual([])
  })

  test('vision=false 不影响结构化观察', async () => {
    const { port, calls } = fakeDesktop()
    const ctx = { ...ctxWith(port), vision: false as const }
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctx)
    expect(r.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['observe'])
  })

  /** 三种取值中只有 `false` 拒绝：`null` 表示没有来源信息，按允许处理。 */
  test('vision=null 时照常采集图像', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'region_image' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['captureImage'])
  })
})

describe('等待', () => {
  test('针对已知控件的条件按同一套规则解析目标，参数逐项交给端口', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopWaitTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        until: 'enabled',
        automationId: 'save2',
        timeoutMs: 999_999,
      },
      ctxWith(port),
    )
    expect(calls[0]).toMatchObject({
      method: 'wait',
      input: { ref: 'e6', until: 'enabled', timeoutMs: 60_000 },
    })
  })

  test('until=value 缺少 value 属于参数错误', async () => {
    const { port, calls } = fakeDesktop()
    const bad = await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'value', ref: 'e5' },
      ctxWith(port),
    )
    expect(bad).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toEqual([])
  })

  /** 等待的是尚不存在的控件或窗口，因此不应要求它先出现在某一份观察中。 */
  test('appears 与 window 不解析已有控件，按文字条件交给端口', async () => {
    const { port, calls } = fakeDesktop()
    await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'appears', name: '完成', role: 'button' },
      ctxWith(port),
    )
    // appears 匹配控件文字，window 匹配窗口标题：两种条件对应不同字段，不能混用。
    expect(calls[0]).toMatchObject({
      method: 'wait',
      input: { until: 'appears', query: '完成', role: 'button' },
    })
    expect((calls[0]?.input as { ref?: string }).ref).toBeUndefined()

    await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'window', name: '另存为' },
      ctxWith(port),
    )
    expect(calls[1]).toMatchObject({ method: 'wait', input: { until: 'window', title: '另存为' } })
    expect((calls[1]?.input as { query?: string }).query).toBeUndefined()
  })

  test('appears 与 window 缺少条件属于参数错误', async () => {
    const { port, calls } = fakeDesktop()
    for (const args of [{ until: 'window' }, { until: 'appears' }]) {
      const r = await run(
        desktopWaitTool,
        { windowId: 'dw_1', observationId: 'do_1', ...args },
        ctxWith(port),
      )
      expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    }
    expect(calls).toEqual([])
  })

  test('条件满足时带回新的观察编号', async () => {
    const { port } = fakeDesktop()
    const r = await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'enabled', ref: 'e6' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.message).toContain('do_3')
  })

  test('到期未满足不算执行失败，executed 为假，并带回到期时刻的控件表', async () => {
    const { port } = fakeDesktop({
      wait: async () => ({
        found: false,
        reason: 'timeout',
        observation: snapshot({ observationId: 'do_9' }),
      }),
    })
    const r = await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'enabled', ref: 'e7' },
      ctxWith(port),
    )
    expect(r).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'desktop_wait_timeout',
    })
    expect(r.data).toMatchObject({ found: false, reason: 'timeout' })
    expect(r.message).toContain('do_9')
  })

  /** 原始失败形状：等待刚点击过的链接的值，页面跳转后链接已不存在，轮询直至超时，回执只写 timeout。 */
  test('等待的控件已不存在时回执写明原因，不写为超时', async () => {
    const { port } = fakeDesktop({
      wait: async () => ({
        found: false,
        reason: 'target_gone',
        observation: snapshot({ observationId: 'do_9' }),
      }),
    })
    const r = await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'value', ref: 'e7', value: 'x' },
      ctxWith(port),
    )
    expect(r).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'desktop_wait_target_gone',
    })
    expect(r.message).toContain('e7 已不在窗口中，条件不会再成立')
    expect(r.message).not.toContain('timeout')
  })

  test('被取消时如实返回取消原因，不视为超时', async () => {
    const { port } = fakeDesktop({
      wait: async () => ({
        found: false,
        reason: 'cancelled',
        observation: null,
        observationError: '本次执行的电脑控制已经结束',
      }),
    })
    const r = await run(
      desktopWaitTool,
      { windowId: 'dw_1', observationId: 'do_1', until: 'gone', ref: 'e7' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_observation_unavailable' })
    expect(r.data).toMatchObject({ reason: 'cancelled' })
  })
})

test('窗口发现把不透明 id 与应用名交给模型', async () => {
  const { port } = fakeDesktop()
  const r = await run(desktopWindowsTool, {}, ctxWith(port))
  expect(r.status).toBe('success')
  expect(r.data).toEqual({
    windows: [{ windowId: 'dw_1', app: '记事本', title: '未命名' }],
    foregroundEnabled: true,
  })
})

/**
 * 前台动作按当前配置与控件能力分别检查，宿主在派发时再次核验配置。
 */
describe('前台动作', () => {
  function foregroundPort(over: Partial<DesktopPort> = {}) {
    const base = fakeDesktop(over)
    return {
      ...base,
      port: {
        ...base.port,
        elements: (windowId: string, observationId: string) =>
          windowId === 'dw_1' && observationId === 'do_1' ? FOREGROUND_TABLE : null,
      } as DesktopPort,
    }
  }

  test('前台操作显式关闭时返回配置原因，不报告控件不支持', async () => {
    const { port, calls } = fakeDesktop({ foregroundEnabled: () => false })
    for (const action of ['click', 'type_text', 'activate', 'set_window_state', 'close_window']) {
      const r = await run(
        desktopActTool,
        {
          windowId: 'dw_1',
          observationId: 'do_1',
          action,
          ref: 'e3',
          ...(action === 'type_text' ? { text: '张三' } : {}),
        },
        ctxWith(port),
      )
      expect(r).toMatchObject({
        status: 'failure',
        executed: false,
        errorKind: 'desktop_foreground_disabled',
      })
      expect(r.message).toContain('前台操作已关闭')
      expect(r.message).not.toContain('不支持')
    }
    expect(calls).toEqual([])
  })

  test('表中有 foreground delivery 时照常交给端口', async () => {
    const { port, calls } = foregroundPort()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'click', ref: 'e16', button: 'right' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls).toEqual([
      {
        method: 'act',
        input: {
          windowId: 'dw_1',
          observationId: 'do_1',
          ref: 'e16',
          action: { kind: 'click', button: 'right', count: 1 },
        },
      },
    ])
  })

  test('开关关闭后旧观察和图像定位都不能派发，后台动作仍可用', async () => {
    let enabled = true
    const { port, calls } = foregroundPort({ foregroundEnabled: () => enabled })
    const context = ctxWith(port)
    const listed = await run(desktopWindowsTool, {}, context)
    expect(listed.data).toMatchObject({ foregroundEnabled: true })
    enabled = false
    const closed = await run(desktopWindowsTool, {}, context)
    expect(closed.data).toMatchObject({ foregroundEnabled: false })
    calls.length = 0
    for (const args of [
      { action: 'activate', ref: 'e1' },
      { action: 'activate', ref: null },
      { action: 'set_window_state', windowState: 'normal', ref: 'e1' },
      { action: 'set_window_state', windowState: 'normal', ref: null },
      { action: 'click', imageRef: 'di_1', imageX: 20, imageY: 20 },
    ]) {
      const result = await run(
        desktopActTool,
        {
          windowId: 'dw_1',
          observationId: 'do_1',
          ...args,
        },
        context,
      )
      expect(result).toMatchObject({ executed: false, errorKind: 'desktop_foreground_disabled' })
      expect(result.message).toContain('更换 ref 或重试不会启用')
    }
    expect(calls).toEqual([])
    const background = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'invoke',
        ref: 'e3',
      },
      context,
    )
    expect(background.status).toBe('success')
  })

  test('前台开启但控件不提供动作时仍报告能力不支持', async () => {
    const { port } = fakeDesktop()
    const result = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'activate',
        ref: 'e1',
      },
      ctxWith(port),
    )
    expect(result.errorKind).toBe('desktop_action_unsupported')
    expect(result.message).not.toContain('已关闭')
  })

  test('双击按 count 表达，上限为 2', async () => {
    const { port, calls } = foregroundPort()
    await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'click', ref: 'e16', count: 2 },
      ctxWith(port),
    )
    expect((calls[0]?.input as { action: unknown }).action).toEqual({
      kind: 'click',
      button: 'left',
      count: 2,
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'click', ref: 'e16', count: 9 },
      ctxWith(port),
    )
    // 越界时截断到上限，不拒绝：三击没有额外语义，两次点击即为双击。
    expect(r.status).toBe('success')
    expect((calls[1]?.input as { action: { count: number } }).action.count).toBe(2)
  })

  test('键盘动作只附加在持有焦点的控件上', async () => {
    const { port, calls } = foregroundPort()
    const blocked = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'type_text', ref: 'e16', text: '张三' },
      ctxWith(port),
    )
    expect(blocked).toMatchObject({ executed: false, errorKind: 'desktop_action_unsupported' })
    const ok = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'type_text',
        ref: 'e17',
        text: '张三',
      },
      ctxWith(port),
    )
    expect(ok.status).toBe('success')
    expect((calls[0]?.input as { action: unknown }).action).toEqual({
      kind: 'type_text',
      text: '张三',
    })
  })

  /**
   * 自绘界面：树上只有窗口根，键盘动作附加在窗口根上，投递时不指定控件。
   *
   * 缺少该路径时，`type_text` 对这类应用完全不可用：它们无法提供持有键盘焦点的
   * 控件，模型只能改用 shell 自行编写脚本。
   */
  function 自绘Port(over: Partial<DesktopPort> = {}) {
    const base = fakeDesktop(over)
    return {
      ...base,
      port: {
        ...base.port,
        elements: (windowId: string, observationId: string) =>
          windowId === 'dw_1' && observationId === 'do_1' ? [自绘窗口] : null,
      } as DesktopPort,
    }
  }

  test('窗口根带有键盘动作时，不指定控件的输入按窗口投递', async () => {
    const { port, calls } = 自绘Port()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'type_text', text: '你好 hello' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls).toEqual([
      {
        method: 'act',
        input: {
          windowId: 'dw_1',
          observationId: 'do_1',
          action: { kind: 'type_text', text: '你好 hello' },
        },
      },
    ])
  })

  test('指定窗口根与不指定控件发送同一种请求，都不带 ref', async () => {
    const { port, calls } = 自绘Port()
    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'press_key',
        ref: 'e1',
        key: 'a',
        modifiers: ['ctrl'],
      },
      ctxWith(port),
    )
    expect(calls[0]?.input).toEqual({
      windowId: 'dw_1',
      observationId: 'do_1',
      action: { kind: 'press_key', key: 'a', modifiers: ['ctrl'] },
    })
  })

  /** 原始失败形状：activate 未提供 ref 时以「未指定目标」被拒绝，而 worker 执行它只需要窗口句柄。 */
  test('activate 未提供目标时作用于窗口，发出的请求带窗口根的 ref', async () => {
    const { port, calls } = 自绘Port()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'activate' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls[0]?.input).toEqual({
      windowId: 'dw_1',
      observationId: 'do_1',
      ref: 'e1',
      action: { kind: 'activate' },
    })
  })

  /** 原始失败形状：按键带截图坐标时回执说明「只能按控件执行」，而省略 ref 即可投递给焦点。 */
  test('键盘动作带图像点时回执指明省略 ref 即投递给焦点', async () => {
    const { port, calls } = 自绘Port()
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'press_key',
        key: 'enter',
        imageRef: 'di_1',
        imageX: 10,
        imageY: 10,
      },
      ctxWith(port),
    )
    expect(r.executed).toBe(false)
    expect(r.message).toContain('省略 ref 即投递给窗口当前的焦点')
    expect(r.message).not.toContain('只能按控件执行')
    expect(calls).toEqual([])
  })

  test('对不接受按键的控件按键时，回执指明省略 ref 即投递给焦点', async () => {
    const { port, calls } = fakeDesktop({
      elements: (windowId, observationId) =>
        windowId === 'dw_1' && observationId === 'do_1' ? [自绘窗口, 文档框] : null,
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'press_key', ref: 'e15', key: 'enter' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_action_unsupported' })
    expect(r.message).toContain('e15 不支持')
    expect(r.message).toContain('省略 ref 即投递给窗口当前的焦点')
    expect(calls).toEqual([])
  })

  /** 子树读取的根同样 `depth` 为 0、没有 `parentRef`，但它不是窗口元素。 */
  test('只读取过子树的观察没有窗口根，不指定控件的输入在派发之前被拒绝', async () => {
    const { windowRoot: _root, ...子树根 } = 自绘窗口
    const { port, calls } = fakeDesktop({
      elements: (windowId, observationId) =>
        windowId === 'dw_1' && observationId === 'do_1' ? [{ ...子树根, ref: 'e4' }] : null,
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'type_text', text: '张三' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_target_missing' })
    expect(r.message).toContain('先对整窗观察一次')
    expect(calls).toEqual([])
  })

  test('窗口根没有键盘动作时，不指定控件的输入在派发之前被拒绝', async () => {
    const { port, calls } = foregroundPort()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'type_text', text: '张三' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'desktop_action_unsupported' })
    expect(calls).toEqual([])
  })

  /**
   * `type_text` 之后回读的值中不包含输入的文字时不得报告成功。
   *
   * 派发事实与回读含义不同：投递接口接收全部字符只说明它们进入了目标的消息队列，
   * 目标控件中的最终文字需要按动作后的回读判定。缺少该判定时，把「那你」
   * 错误输入为「，」的一次输入在回执中与正确输入完全相同。
   */
  function typedPort(value: string | null) {
    // 值缺失时必须删除该键，而不是设为空串：空串表示控件当前为空，缺失表示该控件不返回值。
    const { value: _dropped, ...无值框 } = 焦点框
    return foregroundPort({
      act: async () => ({
        dispatch: 'submitted' as const,
        actionId: 'da_9',
        observation: snapshot({
          observationId: 'do_2',
          elements: [value === null ? 无值框 : { ...焦点框, value }],
        }),
      }),
    })
  }

  const 输入 = (port: DesktopPort, text: string) =>
    run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'type_text', ref: 'e17', text },
      ctxWith(port),
    )

  test('type_text 回读的值中不包含输入的文字时按回读不一致返回，不报告成功', async () => {
    const { port } = typedPort('哦哦行，，先用这个号跑吧')
    const r = await 输入(port, '哦哦行，那你先用这个号跑吧')
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_readback_mismatch',
    })
    expect(r.message).toContain('回读不一致')
    // 控件当前内容由观察中的对应行提供，回读说明中不再重复输出。
    expect(r.message).toContain('"哦哦行，，先用这个号跑吧"')
  })

  test('type_text 输入在已有内容之后时回读按是否包含判定，仍为成功', async () => {
    const { port } = typedPort('原有内容哦哦行，那你先用这个号跑吧')
    const r = await 输入(port, '哦哦行，那你先用这个号跑吧')
    expect(r.status).toBe('success')
    expect(r.message).not.toContain('回读不一致')
    expect(r.message).not.toContain('无法回读控件值')
  })

  test('type_text 的目标无法回读控件值时回执如实说明无法回读', async () => {
    const { port } = typedPort(null)
    const r = await 输入(port, '张三')
    expect(r.status).toBe('success')
    expect(r.message).toContain('无法回读控件值')
    expect(r.message).not.toContain('回读不一致')
  })

  /**
   * 全角标点不改变文字的投递方式：请求原样发送，回执中没有第二种投递方式，也不提及剪贴板。
   */
  test('含全角标点的文字按原文发送一次，回执不提及剪贴板', async () => {
    const seen: unknown[] = []
    const { port } = foregroundPort({
      act: async (input) => {
        seen.push(input.action)
        return {
          dispatch: 'submitted' as const,
          actionId: 'da_10',
          observation: snapshot({
            observationId: 'do_2',
            elements: [{ ...焦点框, value: '哦哦行，那你先用这个号跑吧' }],
          }),
        }
      },
    })
    const r = await 输入(port, '哦哦行，那你先用这个号跑吧')
    expect(r.status).toBe('success')
    expect(r.message).not.toContain('剪贴板')
    expect(r.data).not.toHaveProperty('delivery')
    expect(seen).toEqual([{ kind: 'type_text', text: '哦哦行，那你先用这个号跑吧' }])
  })

  test('回读只适用于 type_text，其他动作不按输入文字判定', async () => {
    const { port } = typedPort('别的值')
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_value',
        ref: 'e17',
        value: '张三',
      },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.message).not.toContain('回读不一致')
    expect(r.message).not.toContain('无法回读控件值')
  })

  test('键盘以外的动作未指定控件时仍然要求目标', async () => {
    const { port, calls } = 自绘Port()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'click' },
      ctxWith(port),
    )
    expect(r).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(r.message).toContain('需提供 ref、automationId 或 name 之一')
    expect(calls).toEqual([])
  })

  /**
   * 自绘界面的观察回执必须说明没有可操作控件以及下一步操作，否则模型会反复读取控件树，
   * 或改用 shell 编写截图脚本。
   */
  test('树上只有窗口与标题栏时，观察回执指出需要采集图像并提供坐标', async () => {
    const 标题栏: DesktopElement = {
      ref: 'e20',
      parentRef: 'e1',
      depth: 1,
      role: 'title_bar',
      name: '',
      automationId: 'TitleBar',
      value: '自绘',
      enabled: true,
      offscreen: false,
      actions: [{ action: 'set_value', delivery: ['background'] }],
    }
    const 关闭按钮: DesktopElement = {
      ref: 'e21',
      parentRef: 'e20',
      depth: 2,
      role: 'button',
      name: '关闭',
      automationId: 'Close',
      enabled: true,
      offscreen: false,
      actions: [{ action: 'invoke', delivery: ['background'] }],
    }
    const 画布: DesktopElement = {
      ref: 'e22',
      parentRef: 'e1',
      depth: 1,
      role: 'pane',
      name: '',
      automationId: 'canvas',
      enabled: true,
      offscreen: false,
      actions: [{ action: 'click', delivery: ['foreground'] }],
    }
    const bare = [自绘窗口, 画布, 标题栏, 关闭按钮]
    const { port, calls } = fakeDesktop({
      observe: async () => snapshot({ elements: bare }),
    })
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'structure' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.message).toContain('无可操作控件')
    // 同一次调用已附带整窗图，调用方无需再请求一次采图。
    const shots = calls.filter((c) => c.method === 'captureImage')
    expect(shots).toHaveLength(1)
    expect(shots[0]?.input).toMatchObject({ windowId: 'dw_1' })
    expect(r.message).toContain('di_1')
    expect((r.data as { images?: unknown[] }).images).toHaveLength(1)
    // 前台操作已开启（表中有 foreground），不应再说明它未启用。
    expect(r.message).not.toContain('前台操作未启用')
  })

  test('无可操作控件但模型不接受图片：只提供控件表，不采集模型无法查看的图像', async () => {
    const 画布: DesktopElement = {
      ref: 'e22',
      parentRef: 'e1',
      depth: 1,
      role: 'pane',
      name: '',
      automationId: 'canvas',
      enabled: true,
      offscreen: false,
      actions: [{ action: 'click', delivery: ['foreground'] }],
    }
    const { port, calls } = fakeDesktop({
      observe: async () => snapshot({ elements: [窗口, 画布] }),
    })
    const ctx = { ...ctxWith(port), vision: false }
    const r = await run(desktopObserveTool, { windowId: 'dw_1', capture: 'structure' }, ctx)
    expect(r.status).toBe('success')
    expect(r.message).toContain('无可操作控件')
    expect(calls.filter((c) => c.method === 'captureImage')).toEqual([])
  })

  test('控件表中有业务控件时不附图：调用方按控件表即可定位', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      { windowId: 'dw_1', capture: 'structure' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.message).not.toContain('无可操作控件')
    expect(calls.map((c) => c.method)).toEqual(['observe'])
  })

  test('前台操作关闭时，同一行补充说明其未启用', async () => {
    const 后台窗口: DesktopElement = { ...窗口, actions: [] }
    const 画布: DesktopElement = {
      ref: 'e22',
      parentRef: 'e1',
      depth: 1,
      role: 'pane',
      name: '',
      automationId: 'canvas',
      enabled: true,
      offscreen: false,
      actions: [],
    }
    const { port } = fakeDesktop({
      foregroundEnabled: () => false,
      observe: async () => snapshot({ elements: [后台窗口, 画布] }),
    })
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(r.message).toContain('无可操作控件')
    expect(r.message).toContain('前台操作已关闭')
    expect(r.data).toMatchObject({ foregroundEnabled: false })
  })

  test('空动作表不能被解释为前台操作已关闭', async () => {
    const { port } = fakeDesktop({
      foregroundEnabled: () => true,
      observe: async () => snapshot({ elements: [{ ...窗口, actions: [] }] }),
    })
    const result = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(result.data).toMatchObject({ foregroundEnabled: true })
    expect(result.message).not.toContain('前台操作已关闭')
  })

  /** 筛选结果为零个控件与窗口没有控件含义不同，混为一谈会产生错误的陈述。 */
  test('筛选或截断的观察不输出该说明', async () => {
    const { port } = fakeDesktop({
      observe: async () => snapshot({ elements: [自绘窗口], filteredBy: ['role=button'] }),
    })
    const filtered = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(filtered.message).not.toContain('没有暴露可操作的控件')

    const { port: cut } = fakeDesktop({
      observe: async () =>
        snapshot({ elements: [自绘窗口], truncated: true, truncatedBy: ['max_nodes'] }),
    })
    const truncated = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(cut))
    expect(truncated.message).not.toContain('没有暴露可操作的控件')
  })

  /** 有业务控件的窗口不应被描述为自绘界面。 */
  test('树中有可操作的业务控件时不输出该说明', async () => {
    const { port } = fakeDesktop()
    const r = await run(desktopObserveTool, { windowId: 'dw_1' }, ctxWith(port))
    expect(r.message).not.toContain('没有暴露可操作的控件')
  })

  test('组合键的修饰键按词表校验，重复项只保留一份', async () => {
    const { port, calls } = foregroundPort()
    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'press_key',
        ref: 'e17',
        key: 'a',
        modifiers: ['ctrl', 'ctrl'],
      },
      ctxWith(port),
    )
    expect((calls[0]?.input as { action: unknown }).action).toEqual({
      kind: 'press_key',
      key: 'a',
      modifiers: ['ctrl'],
    })
    const bad = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'press_key',
        ref: 'e17',
        key: 'a',
        modifiers: ['hyper'],
      },
      ctxWith(port),
    )
    expect(bad).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  })

  test('徽标键 / Command / Super 统一称为 meta，win 不是别名', async () => {
    const { port, calls } = foregroundPort()
    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'press_key',
        ref: 'e17',
        key: 'r',
        modifiers: ['meta'],
      },
      ctxWith(port),
    )
    expect((calls[0]?.input as { action: unknown }).action).toEqual({
      kind: 'press_key',
      key: 'r',
      modifiers: ['meta'],
    })
    const win = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'press_key',
        ref: 'e17',
        key: 'r',
        modifiers: ['win'],
      },
      ctxWith(port),
    )
    expect(win).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(calls).toHaveLength(1)
  })

  test('拖拽终点二选一：控件或像素偏移，同时提供即拒绝', async () => {
    const { port, calls } = foregroundPort()
    const byOffset = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'drag', ref: 'e16', dx: 80, dy: 0 },
      ctxWith(port),
    )
    expect(byOffset.status).toBe('success')
    expect(calls[0]?.input).toMatchObject({
      action: { kind: 'drag', to: { kind: 'offset', dx: 80, dy: 0 } },
    })
    const both = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'drag',
        ref: 'e16',
        toRef: 'e5',
        dx: 80,
      },
      ctxWith(port),
    )
    expect(both).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    const none = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'drag', ref: 'e16' },
      ctxWith(port),
    )
    expect(none).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  })

  test('按图定位与按控件定位互斥，且只有指针动作接受图像点', async () => {
    const { port, calls } = foregroundPort()
    const byImage = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'click',
        imageRef: 'di_1',
        imageX: 40,
        imageY: 50,
      },
      ctxWith(port),
    )
    expect(byImage.status).toBe('success')
    expect(calls[0]?.input).toEqual({
      windowId: 'dw_1',
      observationId: 'do_1',
      at: { imageRef: 'di_1', x: 40, y: 50 },
      action: { kind: 'click', button: 'left', count: 1 },
    })
    const both = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'click',
        ref: 'e16',
        imageRef: 'di_1',
        imageX: 1,
        imageY: 1,
      },
      ctxWith(port),
    )
    expect(both).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    const wrongKind = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'activate',
        imageRef: 'di_1',
        imageX: 1,
        imageY: 1,
      },
      ctxWith(port),
    )
    expect(wrongKind).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  })

  /**
   * 按图定位说明调用方依据图像而非控件表，动作后的控件数对它没有信息量。
   * 回执附带动作后的整窗图，省去随后单独的一次采图。
   */
  test('按图定位的动作回执附带动作后的整窗图', async () => {
    const { port, calls } = foregroundPort()
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'click',
        imageRef: 'di_1',
        imageX: 40,
        imageY: 50,
      },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['act', 'captureImage'])
    expect(calls[1]?.input).toEqual({ windowId: 'dw_1', maxEdge: MAX_EDGE })
    expect(r.message).toContain('click 已提交')
    expect(r.message).toContain('di_1')
    expect((r.data as { images?: unknown[] }).images).toHaveLength(1)
  })

  test('按图点击未派发但窗口准备已改变界面：回执附带新图，保持未执行', async () => {
    const { port, calls } = foregroundPort({
      act: async () => ({
        dispatch: 'not_dispatched',
        actionId: 'da_1',
        reason: 'geometry_changed',
        observation: snapshot({ observationId: 'do_2' }),
      }),
    })
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'click',
        imageRef: 'di_1',
        imageX: 40,
        imageY: 50,
      },
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(calls.map((c) => c.method)).toEqual(['captureImage'])
    expect((r.data as { images?: unknown[] }).images).toHaveLength(1)
  })

  test('纯拒绝且旧观察有效的按图动作不附图', async () => {
    const { port, calls } = foregroundPort({
      act: async () => ({
        dispatch: 'not_dispatched',
        actionId: 'da_1',
        reason: 'occluded: 680,853',
        observation: null,
        observationError: '动作没有派发，上一份观察仍然有效',
      }),
    })
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'click',
        imageRef: 'di_1',
        imageX: 40,
        imageY: 50,
      },
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(r.message).toContain('occluded')
    expect(calls.filter((c) => c.method === 'captureImage')).toEqual([])
  })

  test('按控件定位的动作不附图：控件表本身即可说明动作后的状态', async () => {
    const { port, calls } = foregroundPort()
    await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'click', ref: 'e16' },
      ctxWith(port),
    )
    expect(calls.filter((c) => c.method === 'captureImage')).toEqual([])
  })

  test('失效的 imageRef 由端口拒绝，回执记为未执行', async () => {
    const { port } = foregroundPort({
      act: async () => {
        throw Object.assign(new Error('di_1 已失效：桌面宿主的代际已变化，请重新采图'), {
          errorKind: 'invalid_argument',
          executed: false,
        } satisfies DesktopRefusal)
      },
    })
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'click',
        imageRef: 'di_1',
        imageX: 1,
        imageY: 1,
      },
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: 'invalid_argument' })
    expect(r.message).toContain('重新采图')
  })

  test('窗口动作使用 windowState，不与复选框的 state 混用', async () => {
    const { port, calls } = foregroundPort()
    await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_window_state',
        ref: 'e1',
        windowState: 'maximized',
      },
      ctxWith(port),
    )
    expect((calls[0]?.input as { action: unknown }).action).toEqual({
      kind: 'set_window_state',
      state: 'maximized',
    })
    const wrongParam = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_window_state',
        ref: 'e1',
        state: 'maximized',
      },
      ctxWith(port),
    )
    expect(wrongParam).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
  })

  test('部分派发记为未知，回执包含已发出的数量与下一步', async () => {
    const { port } = foregroundPort({
      act: async () => ({
        dispatch: 'unknown',
        actionId: 'da_7',
        reason: 'input_partial: 12 个输入事件只发出了 4 个，已发出的部分可能已经生效',
        observation: null,
        observationError: '目标窗口读不回来',
      }),
    })
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'type_text',
        ref: 'e17',
        text: '张三',
      },
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'desktop_unknown' })
    expect(r.message).toContain('只发出了 4 个')
    expect(r.message).toContain('结果未确认')
  })

  test('前台模式未启用时宿主的拒绝按未执行透传', async () => {
    const { port } = foregroundPort({
      act: async () => ({
        dispatch: 'not_dispatched',
        actionId: 'da_8',
        reason: 'foreground_disabled: 前台操作未启用',
        observation: null,
        observationError: '动作没有派发，没有重读',
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'click', ref: 'e16' },
      ctxWith(port),
    )
    expect(r).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'desktop_not_dispatched',
    })
    expect(r.message).toContain('foreground_disabled')
  })

  test('关闭窗口时带回提示框的窗口 id，供调用方继续观察', async () => {
    const { port } = foregroundPort({
      act: async () => ({
        dispatch: 'submitted',
        actionId: 'da_9',
        reason: '调用尚未返回，目标进程出现了新的顶层窗口',
        blocking: [
          { windowId: 'dw_1', app: '记事本', title: '未命名', appeared: false },
          { windowId: 'dw_2', app: '记事本', title: '', appeared: true },
        ],
        observation: null,
        observationError: 'target_blocked: 动作调用尚未返回，没有重读目标窗口',
      }),
    })
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'close_window', ref: 'e1' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.message).toContain('dw_2')
    expect(r.message).not.toContain('dw_1 记事本 未命名')
  })

  test('前台动作没有新增工具入口，工具名不变', () => {
    expect(desktopTools.map((t) => t.name)).toEqual([
      'desktop_windows',
      'desktop_observe',
      'desktop_act',
      'desktop_act_sequence',
      'desktop_wait',
    ])
  })

  test('改变窗口矩形的动作不能进入序列，整组在派发之前被拒绝', async () => {
    const { port, calls } = foregroundPort()
    for (const action of ['set_window_state', 'move_window', 'resize_window', 'close_window']) {
      const r = await run(
        desktopActSequenceTool,
        {
          windowId: 'dw_1',
          observationId: 'do_1',
          steps: [
            { action: 'set_value', ref: 'e5', value: '张三' },
            {
              action,
              ref: 'e16',
              ...(action === 'set_window_state' ? { windowState: 'maximized' } : {}),
              ...(action === 'move_window' ? { x: 1, y: 2 } : {}),
              ...(action === 'resize_window' ? { width: 300, height: 200 } : {}),
            },
          ],
        },
        ctxWith(port),
      )
      expect(r).toMatchObject({ status: 'failure', executed: false })
      expect(r.message).toContain('desktop_act')
    }
    expect(calls).toEqual([])
  })
})

/**
 * 有限动作序列：一次调用交付一组已确定的后台动作。
 *
 * 此处的模拟端口比前一个多一层状态：动作按语义作用于一份可变的控件表，每次动作更换一个
 * 观察编号。序列的判据是上一步带回的控件表，始终返回同一份表的模拟端口无法验证
 * 引用接续。
 */
describe('有限动作序列', () => {
  type ActOverride = {
    dispatch?: DesktopActResult['dispatch']
    reason?: string
    blocking?: { windowId: string; app: string; title: string; appeared: boolean }[]
    observation?: DesktopSnapshot | null
    observationError?: string
  }

  function sequencePort(options: { acts?: (ActOverride | null)[]; onAct?: () => void } = {}) {
    const calls: Recorded[] = []
    let table = TABLE.map((e) => ({ ...e }))
    let observationId = 'do_1'
    let nextObservation = 1
    let nextAction = 0

    const bump = (): DesktopSnapshot => {
      nextObservation += 1
      observationId = `do_${nextObservation}`
      return snapshot({ observationId, elements: table })
    }
    const apply = (ref: string | undefined, action: DesktopAction): void => {
      const at = table.findIndex((e) => e.ref === ref)
      const target = table[at]
      if (!target) return
      if (action.kind === 'set_value') table[at] = { ...target, value: action.value }
      if (action.kind === 'set_toggle') table[at] = { ...target, toggle: action.state }
      if (action.kind === 'select') table[at] = { ...target, selected: true }
    }
    const adopt = (over: ActOverride): void => {
      if (!over.observation) return
      table = over.observation.elements.map((e) => ({ ...e }))
      observationId = over.observation.observationId
    }

    const port: DesktopPort = {
      foregroundEnabled: () => true,
      windows: async () => [{ windowId: 'dw_1', app: '记事本', title: '未命名' }],
      observe: async () => snapshot({ observationId, elements: table }),
      elements: (windowId, asked) =>
        windowId === 'dw_1' && asked === observationId ? table : null,
      captureImage: async () => image(),
      act: async (input) => {
        calls.push({ method: 'act', input })
        nextAction += 1
        options.onAct?.()
        const over = options.acts?.[nextAction - 1] ?? null
        const dispatch = over?.dispatch ?? 'submitted'
        if (dispatch === 'submitted') apply(input.ref, input.action)
        const actionId = `da_${nextAction}`
        if (!over) return { dispatch, actionId, observation: bump() }
        if (over.observation === null) {
          if (dispatch !== 'not_dispatched' || over.observationError !== undefined)
            observationId = ''
          return {
            dispatch,
            actionId,
            ...(over.reason === undefined ? {} : { reason: over.reason }),
            ...(over.blocking ? { blocking: over.blocking } : {}),
            observation: null,
            observationError:
              over.observationError ??
              (dispatch === 'not_dispatched'
                ? '动作没有派发，上一份观察仍然有效'
                : '目标窗口此刻读不动'),
          }
        }
        if (over.observation) adopt(over)
        return {
          dispatch,
          actionId,
          ...(over.reason === undefined ? {} : { reason: over.reason }),
          observation: over.observation ?? bump(),
        }
      },
      readText: async () => ({
        app: '记事本',
        title: '未命名',
        text: '',
        truncated: false,
        selectionSupport: 'none',
        selection: [],
      }),
      wait: async (input) => {
        calls.push({ method: 'wait', input })
        return { found: false, reason: 'timeout', observation: bump() }
      },
      release: async () => {},
    }
    return { port, calls, current: () => table }
  }

  function seq(steps: Record<string, unknown>[]): Record<string, unknown> {
    return { windowId: 'dw_1', observationId: 'do_1', steps }
  }

  test('序列中关闭前台操作后停止后续前台步骤，已提交结果保留', async () => {
    let enabled = true
    const base = sequencePort({
      onAct: () => {
        enabled = false
      },
    })
    const port = { ...base.port, foregroundEnabled: () => enabled }
    const result = await run(
      desktopActSequenceTool,
      seq([
        { action: 'invoke', ref: 'e3' },
        { action: 'click', imageRef: 'di_1', imageX: 20, imageY: 20 },
        { action: 'press_key', key: 'enter' },
      ]),
      ctxWith(port),
    )
    expect(result).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_foreground_disabled',
    })
    expect(result.data).toMatchObject({
      foregroundEnabled: false,
      dispatched: [1],
      notExecuted: [2, 3],
    })
    expect(result.message).toContain('前台操作已关闭')
    expect(base.calls.filter((call) => call.method === 'act')).toHaveLength(1)
  })

  /**
   * 自绘界面的常见三步操作。控件表中只有窗口根：第一步按图提供坐标，后两步投递给窗口本身。
   * 一次调用执行完毕，末尾附带一张动作后的整窗图。
   */
  test('自绘界面：按图点击与两步键盘操作一次执行完毕，末尾附带动作后的图', async () => {
    const bare = [自绘窗口]
    const calls: Recorded[] = []
    let observationId = 'do_1'
    let acted = 0
    const port: DesktopPort = {
      foregroundEnabled: () => true,
      windows: async () => [{ windowId: 'dw_1', app: '自绘', title: '自绘' }],
      observe: async () => snapshot({ observationId, elements: bare }),
      elements: (windowId, asked) => (windowId === 'dw_1' && asked === observationId ? bare : null),
      captureImage: async (input) => {
        calls.push({ method: 'captureImage', input })
        return image()
      },
      act: async (input) => {
        calls.push({ method: 'act', input })
        acted += 1
        observationId = `do_${acted + 1}`
        return {
          dispatch: 'submitted',
          actionId: `da_${acted}`,
          observation: snapshot({ observationId, elements: bare }),
        }
      },
      readText: async () => {
        throw new Error('这一步不读文本')
      },
      wait: async () => {
        throw new Error('这一步不等待')
      },
      release: async () => {},
    }

    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'click', imageRef: 'di_1', imageX: 700, imageY: 900 },
        { action: 'type_text', text: '好的' },
        { action: 'press_key', key: 'enter' },
      ]),
      ctxWith(port),
    )

    expect(r.status).toBe('success')
    expect(r.executed).toBe(true)
    expect(calls.map((c) => c.method)).toEqual(['act', 'act', 'act', 'captureImage'])
    const acts = calls.slice(0, 3).map((c) => c.input as Record<string, unknown>)
    expect(acts[0]).toMatchObject({ at: { imageRef: 'di_1', x: 700, y: 900 } })
    // 两步键盘操作不指定控件：目标是窗口本身，帧中既没有 ref 也没有 at。
    expect(acts[1]).not.toHaveProperty('ref')
    expect(acts[1]).not.toHaveProperty('at')
    expect(acts[1]).toMatchObject({ action: { kind: 'type_text', text: '好的' } })
    expect(acts[2]).toMatchObject({ action: { kind: 'press_key', key: 'enter' } })
    // 每一步按上一步带回的编号发出。
    expect(acts.map((a) => a.observationId)).toEqual(['do_1', 'do_2', 'do_3'])
    expect(r.message).toContain('di_1')
    expect((r.data as { images?: unknown[] }).images).toHaveLength(1)
  })

  test('整组都按控件定位时不附图', async () => {
    const { port, calls } = sequencePort()
    await run(
      desktopActSequenceTool,
      seq([{ action: 'set_value', ref: 'e5', value: '张三' }]),
      ctxWith(port),
    )
    expect(calls.filter((c) => c.method === 'captureImage')).toEqual([])
  })

  test('按图定位的步骤不接受 expect：没有可判定的控件', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        {
          action: 'click',
          imageRef: 'di_1',
          imageX: 1,
          imageY: 2,
          expect: { until: 'selected' },
        },
      ]),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(r.message).toContain('expect')
    expect(calls).toEqual([])
  })

  /**
   * 未派发的步骤没有发出任何系统调用，控件表与观察编号保持不变且仍然有效。
   * 回执说明这一点，调用方据此修改条件后重试，无需先重新观察。
   */
  test('第一步即未派发：控件表未作废，回执说明当前编号仍然有效', async () => {
    const { port } = sequencePort({
      acts: [{ dispatch: 'not_dispatched', reason: 'occluded: 680,853', observation: null }],
    })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'select', ref: 'e12' },
      ]),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(r.message).toContain('occluded: 680,853')
    expect(r.message).toContain('观察 do_1 仍然有效')
    expect(r.message).not.toContain('无法读取最后一份控件表')
  })

  test('未派发时交付新观察并停止序列，不重复或继续后续动作', async () => {
    const { port, calls } = sequencePort({
      acts: [
        {
          dispatch: 'not_dispatched',
          reason: 'geometry_changed',
          observation: snapshot({ observationId: 'do_2' }),
        },
      ],
    })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'select', ref: 'e12' },
      ]),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(r.data).toMatchObject({ observation: { observationId: 'do_2' }, notExecuted: [1, 2] })
    expect(r.message).not.toContain('观察 do_1 仍然有效')
    expect(calls).toHaveLength(1)
  })

  test('未派发且窗口准备后重读失败：不再声称旧观察有效', async () => {
    const { port, calls } = sequencePort({
      acts: [
        {
          dispatch: 'not_dispatched',
          reason: 'geometry_changed',
          observation: null,
          observationError: 'provider_timeout: 窗口准备后重读失败',
        },
      ],
    })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'select', ref: 'e12' },
      ]),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(r.message).not.toContain('仍然有效')
    expect(r.message).toContain('窗口准备后重读失败')
    expect(calls).toHaveLength(1)
  })

  test('按图序列未派发但返回新观察时附图，后续点击不执行', async () => {
    const { port, calls } = sequencePort({
      acts: [
        {
          dispatch: 'not_dispatched',
          reason: 'geometry_changed',
          observation: snapshot({ observationId: 'do_2' }),
        },
      ],
    })
    let captured = 0
    port.captureImage = async () => {
      captured += 1
      return image()
    }
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'click', imageRef: 'di_1', imageX: 40, imageY: 50 },
        { action: 'click', imageRef: 'di_1', imageX: 60, imageY: 70 },
      ]),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(calls).toHaveLength(1)
    expect(captured).toBe(1)
    expect((r.data as { images?: unknown[] }).images).toHaveLength(1)
  })

  test('逐步执行，每步一个 actionId，动作按顺序携带发出时刻的观察编号发出', async () => {
    const { port, calls, current } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'set_toggle', ref: 'e10', state: 'on' },
        { action: 'select', ref: 'e12' },
      ]),
      ctxWith(port),
    )

    expect(r.status).toBe('success')
    expect(r.executed).toBe(true)
    expect(calls.map((c) => c.method)).toEqual(['act', 'act', 'act'])
    const inputs = calls.map((c) => c.input as { observationId: string; ref: string })
    expect(inputs.map((i) => i.ref)).toEqual(['e5', 'e10', 'e12'])
    // 每一步按上一步带回的编号发出，不重复使用第一个编号。
    expect(inputs.map((i) => i.observationId)).toEqual(['do_1', 'do_2', 'do_3'])

    const data = r.data as {
      steps: { index: number; actionId: string; dispatch: string; durationMs: number }[]
      dispatched: number[]
      notExecuted: number[]
      observation: DesktopSnapshot
    }
    expect(data.steps.map((s) => s.actionId)).toEqual(['da_1', 'da_2', 'da_3'])
    expect(new Set(data.steps.map((s) => s.actionId)).size).toBe(3)
    expect(data.steps.every((s) => s.dispatch === 'submitted')).toBe(true)
    expect(data.steps.every((s) => typeof s.durationMs === 'number')).toBe(true)
    expect(data.dispatched).toEqual([1, 2, 3])
    expect(data.notExecuted).toEqual([])
    expect(data.observation.observationId).toBe('do_4')
    expect(r.message).toContain('3 步全部提交')

    // 夹具自身的状态可以证明这三步确实已执行。
    const table = current()
    expect(table.find((e) => e.ref === 'e5')?.value).toBe('张三')
    expect(table.find((e) => e.ref === 'e10')?.toggle).toBe('on')
    expect(table.find((e) => e.ref === 'e12')?.selected).toBe(true)
  })

  test('序列只调用端口，不经过任何模型请求通道', async () => {
    const { port, calls } = sequencePort()
    await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'invoke', ref: 'e3' },
      ]),
      ctxWith(port),
    )
    expect(calls.every((c) => c.method === 'act' || c.method === 'wait')).toBe(true)
  })

  test('每一步经进度通道上报一次', async () => {
    const { port } = sequencePort()
    const sent: { channel: string; delta: string }[] = []
    const ctx: ToolContext = {
      ...ctxWith(port),
      emit: (channel, delta) => {
        sent.push({ channel, delta })
      },
    }
    await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'invoke', ref: 'e3' },
      ]),
      ctx,
    )
    expect(sent).toHaveLength(2)
    expect(sent.every((s) => s.channel === 'progress')).toBe(true)
    expect(sent[0]?.delta).toContain('1 set_value e5 已提交')
    expect(sent[1]?.delta).toContain('2 invoke e3 已提交')
  })

  test('第 2 步结果未知时停止，第 3 步不执行', async () => {
    const { port, calls } = sequencePort({
      acts: [null, { dispatch: 'unknown', reason: '调用超时' }],
    })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'set_toggle', ref: 'e10', state: 'on' },
        { action: 'invoke', ref: 'e3' },
      ]),
      ctxWith(port),
    )

    expect(calls).toHaveLength(2)
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'desktop_unknown' })
    const data = r.data as { dispatched: number[]; notExecuted: number[]; stoppedAt: number }
    expect(data.dispatched).toEqual([1, 2])
    expect(data.notExecuted).toEqual([3])
    expect(data.stoppedAt).toBe(2)
    expect(r.message).toContain('结果未确认')
    expect(r.message).toContain('结果未确认')
    expect(r.message).toContain('未执行 3 invoke')
  })

  test('某步未执行时停止，已派发的前缀如实保留', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'invoke', ref: 'e7' },
        { action: 'invoke', ref: 'e3' },
      ]),
      ctxWith(port),
    )

    // 第 2 步的目标是禁用控件：本地判定后即停止，未发送任何帧。
    expect(calls).toHaveLength(1)
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_precondition',
    })
    const data = r.data as { dispatched: number[]; notExecuted: number[] }
    expect(data.dispatched).toEqual([1])
    expect(data.notExecuted).toEqual([2, 3])
    expect(r.message).toContain('2 invoke e7 未执行')
  })

  test('第一步即未执行时整组记为未执行', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'invoke', ref: 'e7' },
        { action: 'set_value', ref: 'e5', value: '张三' },
      ]),
      ctxWith(port),
    )
    expect(calls).toEqual([])
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect((r.data as { dispatched: number[] }).dispatched).toEqual([])
  })

  test('后置条件按动作带回的观察判定，满足时不发送等待', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        {
          action: 'set_value',
          ref: 'e5',
          value: '张三',
          expect: { until: 'value', value: '张三' },
        },
        {
          action: 'set_toggle',
          ref: 'e10',
          state: 'on',
          expect: { until: 'toggle', state: 'on' },
        },
        { action: 'select', ref: 'e12', expect: { until: 'selected' } },
      ]),
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['act', 'act', 'act'])
    const data = r.data as { steps: { expect?: { until: string; met: boolean } }[] }
    expect(data.steps.map((s) => s.expect)).toEqual([
      { until: 'value', met: true },
      { until: 'toggle', met: true },
      { until: 'selected', met: true },
    ])
    expect(r.message).toContain('后置条件 value 已满足')
  })

  test('后置条件等待未满足即截断后缀', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        {
          action: 'set_value',
          ref: 'e5',
          value: '张三',
          expect: { until: 'value', value: '李四', timeoutMs: 200 },
        },
        { action: 'invoke', ref: 'e3' },
      ]),
      ctxWith(port),
    )
    // 观察中判定不成立时才发送等待，等待到期仍不成立即停止。
    expect(calls.map((c) => c.method)).toEqual(['act', 'wait'])
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_postcondition',
    })
    const data = r.data as { dispatched: number[]; notExecuted: number[] }
    expect(data.dispatched).toEqual([1])
    expect(data.notExecuted).toEqual([2])
    expect(r.message).toContain('后置条件 value 未满足')
  })

  test('toggle 与 selected 没有宿主等待，不成立时立即停止', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        {
          action: 'set_toggle',
          ref: 'e10',
          state: 'on',
          expect: { until: 'toggle', state: 'indeterminate' },
        },
      ]),
      ctxWith(port),
    )
    expect(calls.map((c) => c.method)).toEqual(['act'])
    expect(r).toMatchObject({ status: 'failure', errorKind: 'desktop_postcondition' })
  })

  test('调用没有返回时截断后缀，并带回新出现的窗口 id', async () => {
    const { port, calls } = sequencePort({
      acts: [
        null,
        {
          observation: null,
          blocking: [
            { windowId: 'dw_1', app: '记事本', title: '未命名', appeared: false },
            { windowId: 'dw_9', app: '记事本', title: '未保存', appeared: true },
          ],
        },
      ],
    })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'invoke', ref: 'e3' },
        { action: 'invoke', ref: 'e6' },
      ]),
      ctxWith(port),
    )
    expect(calls).toHaveLength(2)
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'desktop_blocked' })
    expect(r.message).toContain('dw_9')
    expect(r.message).not.toContain('最后观察')
    const data = r.data as { blocking: { windowId: string }[]; notExecuted: number[] }
    expect(data.blocking.map((w) => w.windowId)).toEqual(['dw_1', 'dw_9'])
    expect(data.notExecuted).toEqual([3])
  })

  test('动作之后无法读取控件表时截断后缀', async () => {
    const { port, calls } = sequencePort({
      acts: [{ observation: null, observationError: '宿主不可用' }],
    })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'invoke', ref: 'e3' },
      ]),
      ctxWith(port),
    )
    expect(calls).toHaveLength(1)
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_observation_unavailable',
    })
    expect(r.message).toContain('宿主不可用')
  })

  test('步骤之间检查取消，已派发的步骤不重放', async () => {
    const controller = new AbortController()
    const { port, calls } = sequencePort({ onAct: () => controller.abort() })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'invoke', ref: 'e3' },
      ]),
      ctxWith(port, controller.signal),
    )
    expect(calls).toHaveLength(1)
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'aborted' })
    expect((r.data as { notExecuted: number[] }).notExecuted).toEqual([2])
  })

  test('超过长度上限时整组被拒绝，不派发任何一步', async () => {
    const { port, calls } = sequencePort()
    const steps = Array.from({ length: 11 }, () => ({
      action: 'set_value',
      ref: 'e5',
      value: '张三',
    }))
    const r = await run(desktopActSequenceTool, seq(steps), ctxWith(port))
    expect(calls).toEqual([])
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(r.message).toContain('最多 10 步')
  })

  test('close_window 无论位于哪一步都被拒绝，不派发任何一步', async () => {
    const { port, calls } = sequencePort()
    const notLast = await run(
      desktopActSequenceTool,
      seq([
        { action: 'close_window', ref: 'e1' },
        { action: 'set_value', ref: 'e5', value: '张三' },
      ]),
      ctxWith(port),
    )
    const last = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'close_window', ref: 'e1' },
      ]),
      ctxWith(port),
    )
    for (const r of [notLast, last]) {
      expect(r).toMatchObject({ status: 'failure', executed: false })
      expect(r.message).toContain('desktop_act')
    }
    expect(calls).toEqual([])
  })

  test('无法识别的动作名使整组被拒绝', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([{ action: 'frobnicate', ref: 'e5' }]),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(calls).toEqual([])
  })

  test('步骤中提供了不属于该动作的参数时整组拒绝', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([{ action: 'invoke', ref: 'e3', value: '张三' }]),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(r.message).toContain('invoke 不接受 value')
    expect(calls).toEqual([])
  })

  test('步骤与后置条件中无关的参数填写空值时照常执行', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        {
          action: 'set_value',
          ref: 'e5',
          automationId: '',
          name: '',
          role: '',
          value: '张三',
          number: null,
          state: '',
          direction: '',
          step: '',
          itemName: '',
          start: null,
          length: null,
          expect: {
            until: 'value',
            value: '张三',
            state: '',
            name: '',
            role: '',
            timeoutMs: null,
          },
        },
      ]),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'success', executed: true })
    expect(calls.filter((c) => c.method === 'act')).toHaveLength(1)
  })

  test('toggle 与 selected 不接受 timeoutMs', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        {
          action: 'set_toggle',
          ref: 'e10',
          state: 'on',
          expect: { until: 'toggle', state: 'on', timeoutMs: 500 },
        },
      ]),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(r.message).toContain('timeoutMs')
    expect(calls).toEqual([])
  })

  test('引用接续：子树之外的旧 ref 在新编号下仍可解析', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'invoke', ref: 'e3' },
      ]),
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    const second = calls[1]?.input as { observationId: string; ref: string }
    expect(second.ref).toBe('e3')
    expect(second.observationId).toBe('do_2')
  })

  test('引用接续：新观察中没有该 ref 时停止并返回给模型，不另选控件替代', async () => {
    const rebuilt = TABLE.map((e) => (e.ref === 'e10' ? { ...e, ref: 'e77' } : { ...e }))
    const { port, calls } = sequencePort({
      acts: [{ observation: snapshot({ observationId: 'do_9', elements: rebuilt }) }],
    })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'set_toggle', ref: 'e10', state: 'on' },
      ]),
      ctxWith(port),
    )
    expect(calls).toHaveLength(1)
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_ref_unknown',
    })
    expect(r.message).toContain('2 set_toggle e10 未执行')
  })

  test('引用接续：按 automationId 定位的步骤在新观察中重新解析', async () => {
    const rebuilt = TABLE.map((e) => (e.ref === 'e10' ? { ...e, ref: 'e77' } : { ...e }))
    const { port, calls } = sequencePort({
      acts: [{ observation: snapshot({ observationId: 'do_9', elements: rebuilt }) }],
    })
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'set_toggle', automationId: 'triCheck', state: 'on' },
      ]),
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    const second = calls[1]?.input as { observationId: string; ref: string }
    expect(second.ref).toBe('e77')
    expect(second.observationId).toBe('do_9')
  })

  test('目标歧义时停在该步骤，候选按祖先路径列出', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'invoke', name: '保存' },
      ]),
      ctxWith(port),
    )
    expect(calls).toHaveLength(1)
    expect(r).toMatchObject({
      status: 'failure',
      executed: true,
      errorKind: 'desktop_target_ambiguous',
    })
    expect(r.message).toContain('匹配 2 个')
  })

  test('初始观察已经失效时不派发任何一步', async () => {
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      {
        windowId: 'dw_1',
        observationId: 'do_404',
        steps: [{ action: 'set_value', ref: 'e5', value: '张三' }],
      },
      ctxWith(port),
    )
    expect(calls).toEqual([])
    expect(r).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'desktop_observation_stale',
    })
  })

  test('本轮已停止时整组不发起', async () => {
    const controller = new AbortController()
    controller.abort()
    const { port, calls } = sequencePort()
    const r = await run(
      desktopActSequenceTool,
      seq([{ action: 'set_value', ref: 'e5', value: '张三' }]),
      ctxWith(port, controller.signal),
    )
    expect(calls).toEqual([])
    expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: 'aborted' })
  })

  test('没有端口时如实报告，不视为已执行', async () => {
    const r = await run(desktopActSequenceTool, seq([{ action: 'invoke', ref: 'e3' }]), ctxWith())
    expect(r).toMatchObject({ status: 'failure', executed: false, errorKind: 'unsupported' })
  })

  test('端口声明执行前拒绝时该步骤记为未执行', async () => {
    const refusal: DesktopRefusal = { errorKind: 'desktop_unavailable', executed: false }
    const { port } = sequencePort()
    const failing: DesktopPort = {
      ...port,
      act: async () => {
        throw Object.assign(new Error('电脑控制此刻不可用'), refusal)
      },
    }
    const r = await run(
      desktopActSequenceTool,
      seq([{ action: 'set_value', ref: 'e5', value: '张三' }]),
      ctxWith(failing),
    )
    expect(r).toMatchObject({
      status: 'failure',
      executed: false,
      errorKind: 'desktop_unavailable',
    })
  })

  test('端口未声明执行事实时按可能已生效结束', async () => {
    const { port } = sequencePort()
    const failing: DesktopPort = {
      ...port,
      act: async () => {
        throw new Error('连接断了')
      },
    }
    const r = await run(
      desktopActSequenceTool,
      seq([
        { action: 'set_value', ref: 'e5', value: '张三' },
        { action: 'invoke', ref: 'e3' },
      ]),
      ctxWith(failing),
    )
    expect(r).toMatchObject({ status: 'failure', executed: true, errorKind: 'desktop_unknown' })
    expect(r.message).toContain('结果未确认')
    const data = r.data as { dispatched: number[]; notExecuted: number[] }
    expect(data.dispatched).toEqual([1])
    expect(data.notExecuted).toEqual([2])
  })
})

/**
 * strict 工具 schema 把每个可选参数都列入 `required` 并在类型中加入 `null`，
 * 模型因此为无关参数填写 `null`。这些 `null` 必须与未提供等价。
 */
describe('可选参数填写空值', () => {
  /** 按 strict 形状补全：schema 中的每个键都存在，未指定的键填写 null。 */
  function strictArgs(spec: ToolSpec, named: Record<string, unknown>): Record<string, unknown> {
    const props = (spec.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(props)) out[key] = key in named ? named[key] : null
    return out
  }

  test('两种 OpenAI 接口允许 wheel 的无关枚举填写 null，并按原坐标派发滚动', async () => {
    const registry = new ToolRegistry()
    registry.register(desktopActTool)
    registry.register(desktopObserveTool)
    const bodies: Record<string, unknown>[] = []
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      async fetch(req) {
        bodies.push((await req.json()) as Record<string, unknown>)
        const frame = new URL(req.url).pathname.endsWith('/responses')
          ? { type: 'response.completed', response: { status: 'completed', output: [] } }
          : { choices: [{ delta: {}, finish_reason: 'stop' }] }
        return new Response(`data: ${JSON.stringify(frame)}\n\n`, {
          headers: { 'content-type': 'text/event-stream' },
        })
      },
    })
    const args = strictArgs(desktopActTool, {
      windowId: 'dw_1',
      observationId: 'do_1',
      action: 'wheel',
      direction: 'up',
      amount: 6,
      imageRef: 'di_1',
      imageX: 1030,
      imageY: 375,
    })
    try {
      for (const kind of ['openai_responses', 'openai_chat_completions'] as const) {
        const adapter = buildAdapter({
          kind,
          model: 'gpt-6-astra',
          apiKey: 'test',
          baseUrl: `http://127.0.0.1:${server.port}`,
        })
        for await (const _ of adapter.stream({
          model: 'gpt-6-astra',
          system: [],
          messages: [{ role: 'user', content: '向上滚动' }],
          tools: registry.schemas(),
          maxOutputTokens: 64,
          idleTimeoutMs: STREAM_IDLE_TIMEOUT_MS,
        })) {
          // 消费本地端点的响应，检查实际发送的参数定义。
        }
        const raw = (bodies.at(-1)!.tools as Record<string, unknown>[])[0]!
        const tool = (raw.function ?? raw) as {
          strict: boolean
          parameters: {
            required: string[]
            properties: Record<string, { type: string | string[]; enum?: unknown[] }>
          }
        }
        expect(tool.strict).toBe(true)
        for (const [key, value] of Object.entries(args)) {
          expect(tool.parameters.required).toContain(key)
          const field = tool.parameters.properties[key]!
          if (value === null) expect(field.type).toContain('null')
          if (field.enum) expect(field.enum).toContain(value)
        }
        const { port, calls } = fakeDesktop()
        const result = await registry.execute('desktop_act', args, ctxWith(port))
        expect(result).toMatchObject({ status: 'success', executed: true })
        expect(calls.find((call) => call.method === 'act')?.input).toEqual({
          windowId: 'dw_1',
          observationId: 'do_1',
          at: { imageRef: 'di_1', x: 1030, y: 375 },
          action: { kind: 'wheel', direction: 'up', amount: 6 },
        })
        const rawObserve = (bodies.at(-1)!.tools as Record<string, unknown>[])[1]!
        const observe = (rawObserve.function ?? rawObserve) as {
          name: string
          parameters: {
            properties: { imageRect: { type: string[]; required: string[] } }
          }
        }
        expect(observe.name).toBe('desktop_observe')
        expect(observe.parameters.properties.imageRect.type).toEqual(['object', 'null'])
        expect(observe.parameters.properties.imageRect.required).toEqual([
          'x',
          'y',
          'width',
          'height',
        ])
      }
    } finally {
      server.stop(true)
    }
  })

  test('structure 观察附带 imageRect: null 时仍读取控件树', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopObserveTool,
      strictArgs(desktopObserveTool, { windowId: 'dw_1', capture: 'structure' }),
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['observe'])
  })

  test('structure 的 imageRect 空对象仍被拒绝，按回执改为 null 后只读取控件树', async () => {
    const { port, calls } = fakeDesktop()
    const context = ctxWith(port)
    const args = strictArgs(desktopObserveTool, {
      windowId: 'dw_1',
      capture: 'structure',
      query: '检测',
      around: '',
      imageRef: '',
      pad: 0,
      imageRect: {},
    })
    const rejected = await run(desktopObserveTool, args, context)
    expect(rejected).toMatchObject({ executed: false, errorKind: 'invalid_argument' })
    expect(rejected.message).toContain('capture=structure')
    expect(rejected.message).toContain('imageRect 不要填 {}')
    expect(rejected.message).toContain('null')
    expect(calls).toEqual([])
    const corrected = await run(desktopObserveTool, { ...args, imageRect: null }, context)
    expect(corrected.status).toBe('success')
    expect(calls.map((c) => c.method)).toEqual(['observe'])
  })

  test('invoke 附带约二十个其他 null 参数时仍然派发', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      strictArgs(desktopActTool, {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'invoke',
        ref: 'e3',
      }),
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(calls.filter((c) => c.method === 'act')).toHaveLength(1)
    expect((calls.find((c) => c.method === 'act')?.input as { action: unknown }).action).toEqual({
      kind: 'invoke',
    })
  })

  test('空值填写空串时同样派发：模型的两种填写方式均已出现过', async () => {
    const { port, calls } = fakeDesktop()
    const padded = strictArgs(desktopActTool, {
      windowId: 'dw_1',
      observationId: 'do_1',
      action: 'set_value',
      ref: 'e5',
      value: '张三',
    })
    // 字符串型参数填写空串，数值型参数填写 null：实测中模型混用这两种填写方式。
    for (const [key, v] of Object.entries(padded)) if (v === null) padded[key] = ''
    padded.number = null
    padded.imageRect = null
    const r = await run(desktopActTool, padded, ctxWith(port))
    expect(r.status).toBe('success')
    expect(calls.filter((c) => c.method === 'act')).toHaveLength(1)
  })

  /**
   * 原始失败形状（DeepSeek Flash，strict 与原样 schema 下均出现）：无关参数填写字符串 "null"、
   * 空串、0 与 "0"，imageRef 也填写 "null"。这些值被视为已提供时，invoke 先被当作按图定位拒绝，
   * 再按多余参数拒绝，模型更换填写方式连续调用 8 次均未派发。
   */
  test('空值填写字符串 null、0 与 "0" 时照常按控件派发', async () => {
    const { port, calls } = fakeDesktop()
    const padded = strictArgs(desktopActTool, {
      windowId: 'dw_1',
      observationId: 'do_1',
      action: 'invoke',
      ref: 'e3',
    })
    for (const key of Object.keys(padded)) if (padded[key] === null) padded[key] = 'null'
    padded.imageRef = 'null'
    padded.number = '0'
    padded.dx = 0
    padded.count = 0
    const r = await run(desktopActTool, padded, ctxWith(port))
    expect(r.status).toBe('success')
    expect((calls.find((c) => c.method === 'act')?.input as { action: unknown }).action).toEqual({
      kind: 'invoke',
    })
  })

  test('确实提供了不属于该动作的值时仍立即拒绝', async () => {
    const { port, calls } = fakeDesktop()
    const r = await run(
      desktopActTool,
      strictArgs(desktopActTool, {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'invoke',
        ref: 'e3',
        value: '张三',
      }),
      ctxWith(port),
    )
    expect(r).toMatchObject({ status: 'failure', executed: false })
    expect(r.message).toContain('invoke 不接受 value')
    expect(calls).toEqual([])
  })
})

/**
 * 原始失败形状：资源管理器隐藏了已知扩展名，重命名框中只有「盘点草稿-0037」。模型在一个序列中执行
 * F2 → 输入「盘点终稿-0037.txt」→ 回车，输入投递给窗口，回执只说明「已执行」，文件变为 `.txt.txt`。
 * 回执必须给出输入框在输入前后的值，模型才能看到框中原本没有扩展名。
 */
describe('type_text 回执中的输入框原值与现值', () => {
  const 改名窗口: DesktopElement = {
    ...窗口,
    actions: [
      { action: 'type_text', delivery: ['foreground'] },
      { action: 'press_key', delivery: ['foreground'] },
    ],
  }
  const 改名框: DesktopElement = { ...焦点框, name: '盘点草稿-0037', value: '盘点草稿-0037' }

  function renamePort() {
    const base = fakeDesktop({
      act: async () => ({
        dispatch: 'submitted' as const,
        actionId: 'da_1',
        observation: snapshot({
          observationId: 'do_2',
          elements: [改名窗口, { ...改名框, value: '盘点终稿-0037.txt' }],
        }),
      }),
    })
    return {
      ...base,
      port: {
        ...base.port,
        elements: (windowId: string, observationId: string) =>
          windowId === 'dw_1' && observationId === 'do_1' ? [改名窗口, 改名框] : null,
      } as DesktopPort,
    }
  }

  test('输入投递给窗口时，回执按持有焦点的输入框输出原值与现值', async () => {
    const { port } = renamePort()
    const r = await run(
      desktopActTool,
      { windowId: 'dw_1', observationId: 'do_1', action: 'type_text', text: '盘点终稿-0037.txt' },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.message).toContain('e17 原值 "盘点草稿-0037" → 现值 "盘点终稿-0037.txt"')
  })

  test('序列中的 type_text 步骤同样输出原值与现值', async () => {
    const { port } = renamePort()
    const r = await run(
      desktopActSequenceTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        steps: [{ action: 'type_text', text: '盘点终稿-0037.txt' }],
      },
      ctxWith(port),
    )
    expect(r.message).toContain('原值 "盘点草稿-0037" → 现值 "盘点终稿-0037.txt"')
    expect((r.data as { steps: { input?: unknown }[] }).steps[0]?.input).toEqual({
      ref: 'e17',
      before: '盘点草稿-0037',
      after: '盘点终稿-0037.txt',
    })
  })
})

describe('set_value 回执中的原值', () => {
  /** 隐藏扩展名时的重命名：名称单元格的原值没有扩展名，写入带扩展名的全名，回执必须给出原值。 */
  test('单动作 set_value 回执补充原值，现值保留在目标所在行', async () => {
    const 名称格: DesktopElement = { ...焦点框, name: '名称', value: '盘点草稿-0037' }
    const base = fakeDesktop({
      act: async () => ({
        dispatch: 'submitted' as const,
        actionId: 'da_1',
        observation: snapshot({
          observationId: 'do_2',
          elements: [窗口, { ...名称格, value: '盘点终稿-0037.txt' }],
        }),
      }),
    })
    const port = {
      ...base.port,
      elements: (windowId: string, observationId: string) =>
        windowId === 'dw_1' && observationId === 'do_1' ? [窗口, 名称格] : null,
    } as DesktopPort
    const r = await run(
      desktopActTool,
      {
        windowId: 'dw_1',
        observationId: 'do_1',
        action: 'set_value',
        ref: 'e17',
        value: '盘点终稿-0037.txt',
      },
      ctxWith(port),
    )
    expect(r.status).toBe('success')
    expect(r.message).toContain('原值 "盘点草稿-0037"')
    expect(r.message).toContain('= "盘点终稿-0037.txt"')
    expect(r.message).not.toContain('→ 现值')
  })
})
