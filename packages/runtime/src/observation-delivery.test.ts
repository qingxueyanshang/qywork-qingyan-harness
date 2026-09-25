/**
 * 观察结果从工具边界一直走到会话账本的整条链路。
 *
 * **覆盖范围**：`tools/desktop-results.ts`、`tools/browser-results.ts`、`tools/resources.ts`
 * 与 `runtime/sink.ts` 的 `RuntimeSink` / `collectResourceGarbage` 在真实 `Store` +
 * `ContentStore` 上的合作；`agent/registry.ts` 的 `ToolRegistry.execute` 与批级记账；
 * `runtime/transcript.ts` 的工具结果信封与 `agent/loop/request.ts` 当轮信封的同形；
 * `agent/compaction.ts` 的 `condenseMessage` 对资源引用的保留；差异投递的基底与差异在
 * `agent/loop/request.ts` 的 `collapseSuperseded` 下的取代关系。
 *
 * 工具侧的上限、视图选取与故障降级在 `tools/desktop-results.test.ts`、
 * `tools/browser-results.test.ts`、`tools/resources.test.ts` 里用内存 sink 验过，
 * 这里只验跨层的部分：真实分片存储、step 落账、回放、收纳、回收与跨工具记账。
 *
 * 夹具全部合成：控件名、元素名、页面标题与地址都不取自真实应用或网页。
 * 正文按内容库的分片大小构造——跨分片读回才证得了分片拼接没有错位，
 * 断言用 `ContentStore.info().chunkCount` 取实际分片数，不在测试里复制那个常数。
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AgentLoop,
  type BrowserElement,
  type BrowserObservation,
  type BrowserOptionsPage,
  type BrowserPort,
  type BrowserSelectOption,
  type CompactionOutcome,
  type CompactionPort,
  chargeBatchBudget,
  condenseMessage,
  type DesktopElement,
  type DesktopPort,
  type DesktopSnapshot,
  deliveryBudget,
  type LoopPersistence,
  resetBatchBudget,
  type SinkPort,
  type ToolContext,
  type ToolContextBase,
  ToolRegistry,
} from '@qywork/agent'
import type { ChatRequest, LlmAdapter, ProviderEvent, WireMessage, WireToolCall } from '@qywork/ai'
import { DEFAULT_DENSITY, estimateRequest, lookupModel } from '@qywork/ai'
import type { AgentEvent, ConversationId, RunId, StepId, WorkspaceId } from '@qywork/core'
import {
  appendStep,
  appendTextToStep,
  ContentStore,
  contentPathFor,
  createConversation,
  createRun,
  getResource,
  listSteps,
  markStepExecuting,
  Store,
  settleToolStep,
  upsertWorkspace,
} from '@qywork/store'
import { registerBuiltinTools } from '@qywork/tools'
import { collectResourceGarbage, RuntimeSink } from './sink.ts'
import { stepsToUnits } from './transcript.ts'

const WINDOW = 200_000

// ─────────────────────────── 夹具 ───────────────────────────

/** 控件行的行尾标记。命中落在长行末尾，从行首截出来的那段里没有它。 */
const 行尾标记 = '末尾标记-'
/** 带行尾标记的控件个数。搜索续查要在真实分片存储上跨页，这个数远超单页输出量。 */
const 条目数 = 480

/** 一个控件的值长到单独一个就装不下视图，用来验长值留在存盘正文里。 */
const 长值 = '合成长文本。'.repeat(10_000)

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
const 分组: DesktopElement = {
  ref: 'e2',
  parentRef: 'e1',
  depth: 1,
  role: 'group',
  name: '合成分组 🙂',
  automationId: 'group',
  enabled: true,
  offscreen: false,
  actions: [],
}
const 焦点框: DesktopElement = {
  ref: 'e3',
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
const 长值框: DesktopElement = {
  ref: 'e4',
  parentRef: 'e1',
  depth: 1,
  role: 'edit',
  name: '长值框',
  automationId: 'longValue',
  value: 长值,
  enabled: true,
  offscreen: false,
  actions: [{ action: 'set_value', delivery: ['background'] }],
}
/**
 * 空串、false、0 与一个 null 字段一起进存盘正文。
 *
 * 协议里没有 null 字段，夹具里造一个：JSONL 把 null 折成缺席与把缺席补成 null
 * 都会让回读与原观察不等，而两种都不会报错。
 */
const 特殊值: DesktopElement = {
  ref: 'e5',
  parentRef: 'e1',
  depth: 0,
  role: 'edit',
  name: '',
  automationId: '',
  value: '',
  enabled: false,
  offscreen: false,
  weakIdentity: false,
  selection: { multiple: false, required: false, selected: [], truncated: null },
  actions: [],
} as unknown as DesktopElement
/** 动作目标，排在整张表最后：进视图靠优先级，不靠位置。 */
const 目标: DesktopElement = {
  ref: 'e6',
  parentRef: 'e2',
  depth: 2,
  role: 'button',
  name: '目标按钮',
  automationId: 'target',
  enabled: true,
  offscreen: false,
  actions: [{ action: 'invoke', delivery: ['background'] }],
}

/** `value` 写在最后一个键上，标记因此落在这一行的行尾。 */
function 条目(i: number): DesktopElement {
  return {
    ref: `e${100 + i}`,
    parentRef: 'e1',
    depth: 1,
    role: 'text',
    name: `合成条目 ${i} 🙂 ${'甲乙丙丁'.repeat(40)}`,
    automationId: `item-${i}`,
    enabled: true,
    offscreen: false,
    actions: [],
    value: `合成取值 ${'戊己庚辛'.repeat(40)} ${行尾标记}${i}`,
  }
}

const 大表: DesktopElement[] = [
  根,
  分组,
  焦点框,
  长值框,
  特殊值,
  ...Array.from({ length: 条目数 }, (_, i) => 条目(i + 1)),
  目标,
]
const 小表: DesktopElement[] = [根, 分组, 目标]

function 快照(elements: DesktopElement[], observationId = 'do_1'): DesktopSnapshot {
  return {
    windowId: 'dw_1',
    app: '合成应用',
    title: '合成标题 🙂',
    observationId,
    capturedAt: 1,
    elements,
    truncated: false,
    truncatedBy: [],
    filteredBy: [],
    visited: elements.length,
    windowEnabled: true,
    windowCovered: false,
  }
}

function desktopPort(table: DesktopElement[]): DesktopPort {
  const after = 快照(table, 'do_2')
  return {
    windows: async () => [{ windowId: 'dw_1', app: '合成应用', title: '合成标题 🙂' }],
    observe: async () => 快照(table),
    elements: (windowId, observationId) =>
      windowId === 'dw_1' && (observationId === 'do_1' || observationId === 'do_2') ? table : null,
    captureImage: async () => {
      throw new Error('本组夹具不截图')
    },
    act: async () => ({ dispatch: 'submitted', actionId: 'da_1', observation: after }),
    readText: async () => ({
      app: '合成应用',
      title: '合成标题 🙂',
      text: '',
      truncated: false,
      selectionSupport: 'none',
      selection: [],
    }),
    wait: async () => ({ found: true, observation: after }),
    release: async () => {},
  }
}

/** 名称、值与正文按采集侧的 200 字上限写满，一律用中文占满字节。 */
function 大元素(i: number): BrowserElement {
  return {
    ref: `e${i}`,
    role: 'button',
    name: `合成元素 ${'子丑寅卯'.repeat(48)}`,
    tag: 'button',
    value: `合成取值 ${'辰巳午未'.repeat(48)}`,
    text: `合成正文 ${'申酉戌亥'.repeat(48)} ${行尾标记}${i}`,
  }
}

/** 缺席的 `checked` / `expanded` / `selected` 不许在往返里变成 false。 */
const 状态齐全: BrowserElement = {
  ref: 'e117',
  role: 'checkbox',
  name: '合成复选框 🙂',
  tag: 'input',
  inputType: 'checkbox',
  checked: false,
  expanded: false,
  selected: false,
  disabled: false,
  value: '',
}

function 选项(i: number): BrowserSelectOption {
  return {
    label: `合成选项 ${i} ${'甲乙丙丁'.repeat(48)}`,
    value: `合成取值 ${i} ${'壬癸子丑'.repeat(48)}`,
  }
}

/** 三个下拉合计 90 个选项摘要，与采集侧的合计上限同量级。 */
function 下拉(ref: string): BrowserElement {
  return {
    ref,
    role: 'combobox',
    name: '合成下拉 🙂 甲乙丙',
    tag: 'select',
    value: '',
    options: [
      { label: '', value: '' },
      ...Array.from({ length: 28 }, (_, i) => 选项(i)),
      { label: '丁🙂', value: 'd', disabled: true },
    ],
    optionsTotal: 420,
    optionsTruncated: true,
  }
}

const 大页: BrowserObservation = {
  tabId: 'bt_1',
  url: 'https://合成站点.invalid/list',
  title: '合成长列表 🙂',
  observationId: 'ob_2',
  elements: [
    ...Array.from({ length: 116 }, (_, i) => 大元素(i + 1)),
    状态齐全,
    下拉('e118'),
    下拉('e119'),
    下拉('e120'),
  ],
  truncated: true,
  framesPending: ['f9c1'],
}

/** 30 项是采集侧一次返回的选项上限，每项的 label 与 value 各按 200 字写满。 */
const 大选项页: BrowserOptionsPage = {
  tabId: 'bt_1',
  observationId: 'ob_1',
  ref: 'e119',
  items: [
    ...Array.from({ length: 28 }, (_, i) => ({
      label: `合成选项 ${i} ${'庚辛壬癸'.repeat(48)}`,
      value: `合成取值 ${'寅卯辰巳'.repeat(48)}`,
    })),
    { label: '', value: '', disabled: true },
    { label: '末项🙂', value: 'last', selected: true },
  ],
  total: 420,
  offset: 40,
  nextOffset: 70,
}

function browserPort(page: BrowserObservation): BrowserPort {
  return {
    tabs: async () => [
      { tabId: 'bt_1', url: 'https://合成站点.invalid/', title: '合成小页', controlled: true },
    ],
    open: async (url) => ({ tabId: 'bt_9', url, title: '', controlled: true }),
    bind: async (tabId) => ({
      tabId,
      url: 'https://合成站点.invalid/',
      title: '合成小页',
      controlled: true,
    }),
    close: async () => {},
    navigate: async () => ({ observation: page, settle: 'quiet' }),
    observe: async (input) => (input.optionsFor ? 大选项页 : page),
    act: async () => ({ element: 'button 提交', observation: page, settle: 'quiet' }),
    wait: async () => ({ found: true, observation: page }),
    upload: async (input) => ({ files: input.paths }),
    download: async (input) => ({ path: input.absolutePath, bytes: 3 }),
    release: async () => {},
  }
}

// ─────────────────────────── 装配 ───────────────────────────

interface Harness {
  dir: string
  dbPath: string
  store: Store
  content: ContentStore
  workspaceId: WorkspaceId
  conversationId: ConversationId
  runId: RunId
  sink: RuntimeSink
  registry: ToolRegistry
}

/**
 * 每条用例一对真实库文件。
 *
 * **目录不在这里删**：关库不保证释放文件句柄（见 `Store.close`），Windows 上同进程
 * `rmSync` 报 EBUSY。整轮的临时目录由 `scripts/run-tests.ts` 在测试子进程退出之后统一清掉。
 */
const open: Harness[] = []
afterEach(() => {
  for (const h of open.splice(0)) {
    try {
      h.content.close()
    } catch {
      // 用例可能已经关掉正文库来造写失败。
    }
    h.store.close()
  }
})

function harness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'qywork-observation-'))
  const dbPath = join(dir, 'a.sqlite3')
  const store = new Store({ path: dbPath })
  const content = new ContentStore(contentPathFor(dbPath))
  const ws = upsertWorkspace(store, dir, 'ws')
  const conv = createConversation(store, {
    workspaceId: ws.id,
    provider: 'p',
    model: 'm',
    title: 't',
  })
  const run = createRun(store, {
    conversationId: conv.id,
    workspaceId: ws.id,
    model: 'm',
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  })
  const registry = new ToolRegistry()
  registerBuiltinTools(registry, { desktop: true, browser: true })
  const h: Harness = {
    dir,
    dbPath,
    store,
    content,
    workspaceId: ws.id,
    conversationId: conv.id,
    runId: run.id,
    sink: new RuntimeSink(store, content, run.id),
    registry,
  }
  open.push(h)
  return h
}

function toolCtx(input: {
  h: Harness
  window?: number
  sink?: SinkPort | null
  desktop?: DesktopPort
  browser?: BrowserPort
}): ToolContext {
  return {
    workspaceRoot: input.h.dir,
    conversationId: input.h.conversationId,
    runId: input.h.runId,
    model: 'test',
    contextWindow: input.window ?? WINDOW,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: input.sink === undefined ? input.h.sink : input.sink,
    signal: new AbortController().signal,
    emit: () => {},
    requestPermission: async () => ({ allowed: true }),
    ...(input.desktop ? { desktop: input.desktop } : {}),
    ...(input.browser ? { browser: input.browser } : {}),
  }
}

type Outcome = Awaited<ReturnType<ToolRegistry['execute']>>

interface Resourceful {
  resources?: { resourceId: string }[]
}

function resourceIdOf(outcome: Outcome): string {
  const refs = (outcome as Resourceful).resources ?? []
  expect(refs).toHaveLength(1)
  return String(refs[0]?.resourceId)
}

/** 存进内容库的那份字节，与工具结果无关地从账本取回。 */
function storedBody(h: Harness, resourceId: string): Uint8Array {
  const row = getResource(h.store, resourceId)
  expect(row?.contentHash).toBeTruthy()
  const body = h.content.readAll(row?.contentHash ?? '')
  expect(body).not.toBeNull()
  return body as Uint8Array
}

/** 沿 `nextOffset` 逐页读到末尾，返回拼回来的正文。页不前进就失败。 */
async function readWhole(h: Harness, ctx: ToolContext, resourceId: string): Promise<string> {
  const registry = h.registry
  let offset: number | null = 0
  let last = -1
  let out = ''
  let guard = 0
  while (offset !== null) {
    const r = await registry.execute('read_resource', { resource_id: resourceId, offset }, ctx)
    expect(r.status).toBe('success')
    const page = r.data as unknown as { content: string; offset: number; nextOffset: number | null }
    expect(page.offset).toBeGreaterThan(last)
    last = page.offset
    out += page.content
    offset = page.nextOffset
    guard++
    expect(guard).toBeLessThan(500)
  }
  return out
}

interface Hit {
  line: number
  offset: number
  lineOffset: number
  text: string
  wholeLine: boolean
}

async function searchWhole(
  h: Harness,
  ctx: ToolContext,
  resourceId: string,
  query: string,
): Promise<Hit[]> {
  const registry = h.registry
  let offset: number | null = 0
  const hits: Hit[] = []
  let guard = 0
  while (offset !== null) {
    const r = await registry.execute(
      'read_resource',
      { resource_id: resourceId, query, offset },
      ctx,
    )
    expect(r.status).toBe('success')
    const page = r.data as unknown as { hits: Hit[]; nextOffset: number | null }
    hits.push(...page.hits)
    offset = page.nextOffset
    guard++
    expect(guard).toBeLessThan(200)
  }
  return hits
}

/** 存盘正文按行拼回一份观察。 */
function fromJsonl(text: string): { meta: Record<string, unknown>; rows: unknown[] } {
  const lines = text.split('\n')
  return {
    meta: JSON.parse(lines[0] as string) as Record<string, unknown>,
    rows: lines.slice(1).map((line) => JSON.parse(line) as unknown),
  }
}

// ─────────────────────────── 真实分片存储上的存盘与回读 ───────────────────────────

describe('真实内容库：存盘正文跨分片，沿 nextOffset 完整读回', () => {
  test('desktop 大观察：回读字节与存盘正文相等，逐行与原观察字段值深等', async () => {
    const h = harness()
    const ctx = toolCtx({ h, desktop: desktopPort(大表) })
    const r = await h.registry.execute(
      'desktop_act',
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e6' },
      ctx,
    )
    expect(r.status).toBe('success')

    const id = resourceIdOf(r)
    const stored = storedBody(h, id)
    const hash = getResource(h.store, id)?.contentHash ?? ''
    // 跨分片才证得了分片拼接没有错位。
    expect(h.content.info(hash)?.chunkCount).toBeGreaterThan(1)

    const back = await readWhole(h, ctx, id)
    expect(back).not.toContain('�')
    expect(Buffer.from(back, 'utf8').equals(Buffer.from(stored))).toBe(true)

    const { meta, rows } = fromJsonl(back)
    const { elements, ...expected } = 快照(大表, 'do_2')
    expect(meta).toEqual(expected)
    expect(rows).toEqual(elements)
    // 缺席、null、false、0、空串与长值都按原样回来。
    const 回读特殊 = rows.find((e) => (e as DesktopElement).ref === 'e5') as Record<string, unknown>
    expect(回读特殊.value).toBe('')
    expect(回读特殊.enabled).toBe(false)
    expect(回读特殊.depth).toBe(0)
    expect((回读特殊.selection as { truncated: unknown }).truncated).toBeNull()
    expect('rect' in 回读特殊).toBe(false)
    expect((rows.find((e) => (e as DesktopElement).ref === 'e4') as DesktopElement).value).toBe(
      长值,
    )
  })

  test('browser 大页：回读字节与存盘正文相等，缺席的状态位没有被补成 false', async () => {
    const h = harness()
    const ctx = toolCtx({ h, browser: browserPort(大页) })
    const r = await h.registry.execute('browser_observe', { tabId: 'bt_1' }, ctx)
    expect(r.status).toBe('success')

    const id = resourceIdOf(r)
    const stored = storedBody(h, id)
    const hash = getResource(h.store, id)?.contentHash ?? ''
    expect(h.content.info(hash)?.chunkCount).toBeGreaterThan(1)

    const back = await readWhole(h, ctx, id)
    expect(back).not.toContain('�')
    expect(Buffer.from(back, 'utf8').equals(Buffer.from(stored))).toBe(true)

    const { meta, rows } = fromJsonl(back)
    const { elements, ...expected } = 大页
    expect(meta).toEqual(expected)
    expect(rows).toEqual(elements)
    const 普通 = rows[0] as BrowserElement
    expect('checked' in 普通).toBe(false)
    expect('expanded' in 普通).toBe(false)
    const 复选 = rows.find((e) => (e as BrowserElement).ref === 'e117') as BrowserElement
    expect(复选.checked).toBe(false)
    expect(复选.value).toBe('')
  })

  /**
   * 选项页一次最多 30 项、每项 200 字，正文进不了第二个分片。
   * 这条验的是同一条回读路径在小正文上的字段保全，跨分片由上面两条覆盖。
   */
  test('browser 选项页：回读字节与存盘正文相等，所属观察与翻页位置原样', async () => {
    const h = harness()
    const ctx = toolCtx({ h, browser: browserPort(大页) })
    const r = await h.registry.execute(
      'browser_observe',
      { tabId: 'bt_1', optionsFor: { observationId: 'ob_1', ref: 'e119' } },
      ctx,
    )
    expect(r.status).toBe('success')

    const id = resourceIdOf(r)
    const back = await readWhole(h, ctx, id)
    expect(Buffer.from(back, 'utf8').equals(Buffer.from(storedBody(h, id)))).toBe(true)

    const { meta, rows } = fromJsonl(back)
    const { items, ...expected } = 大选项页
    expect(meta).toEqual(expected)
    expect(rows).toEqual(items)
    const data = r.data as { total: number; offset: number; nextOffset: number; ref: string }
    expect(data.total).toBe(420)
    expect(data.offset).toBe(40)
    expect(data.nextOffset).toBe(70)
    expect(data.ref).toBe('e119')
  })
})

describe('真实分片存储上的搜索续查', () => {
  test('长控件行行尾的命中：跨页读完不漏不重，返回整条控件记录，lineOffset 指向该控件的行首', async () => {
    const h = harness()
    const ctx = toolCtx({ h, desktop: desktopPort(大表) })
    const r = await h.registry.execute('desktop_observe', { windowId: 'dw_1' }, ctx)
    const id = resourceIdOf(r)

    // 元数据一行，之后是 `大表` 的元素；带标记的第一个控件因此落在第 7 行。
    const 首行 = 1 + 大表.findIndex((e) => e.ref === 'e101') + 1
    const hits = await searchWhole(h, ctx, id, 行尾标记)
    expect(hits.map((x) => x.line)).toEqual(Array.from({ length: 条目数 }, (_, i) => 首行 + i))
    expect(new Set(hits.map((x) => x.offset)).size).toBe(条目数)
    // 行号与命中正文互相对得上：漏一条、重一条都会让这一组错位。
    for (const hit of hits) expect(hit.text).toContain(`${行尾标记}${hit.line - 首行 + 1}`)

    // 命中在行尾：返回的是整条控件记录，从行首的 ref 起，可直接解析。
    const 末条 = hits[hits.length - 1] as Hit
    expect(末条.wholeLine).toBe(true)
    expect(末条.text).toContain(`${行尾标记}${条目数}`)
    expect((JSON.parse(末条.text) as { ref: string }).ref).toBe(`e${100 + 条目数}`)

    // 拿 lineOffset 当 offset 读回来的是这个控件整行的行首。
    const 整行 = await h.registry.execute(
      'read_resource',
      { resource_id: id, offset: 末条.lineOffset, length: 64 },
      ctx,
    )
    expect(
      String((整行.data as { content: string }).content).startsWith(`{"ref":"e${100 + 条目数}"`),
    ).toBe(true)
  })

  test('单页装不下时给出续查位置，读到末尾才为 null', async () => {
    const h = harness()
    const ctx = toolCtx({ h, desktop: desktopPort(大表) })
    const id = resourceIdOf(await h.registry.execute('desktop_observe', { windowId: 'dw_1' }, ctx))

    const first = await h.registry.execute(
      'read_resource',
      { resource_id: id, query: 行尾标记 },
      ctx,
    )
    const data = first.data as { hits: Hit[]; nextOffset: number | null }
    expect(data.hits.length).toBeGreaterThan(0)
    expect(data.hits.length).toBeLessThan(条目数)
    expect(data.nextOffset).not.toBeNull()
    expect(first.message).toContain(`offset=${data.nextOffset}`)
  })
})

// ─────────────────────────── 各层同形 ───────────────────────────

const okOutcome: CompactionOutcome = {
  status: 'compacted',
  summarized: false,
  manifest: {
    revision: 1,
    compactedThroughMessageId: null,
    compactedMessageCount: 0,
    summary: '摘要',
    facts: { filesTouched: [], openItems: [], userConstraints: [] },
    createdAt: 0,
  },
}

/** 按脚本回放的假 adapter，并把每次收到的请求原样留下。 */
function scriptedAdapter(turns: (WireToolCall[] | null)[], seen: ChatRequest[]): LlmAdapter {
  let turn = 0
  const spec = lookupModel('claude-opus-5', 'anthropic_messages')
  return {
    kind: 'anthropic_messages',
    transmits: { effort: true },
    spec,
    async *stream(req: ChatRequest): AsyncGenerator<ProviderEvent, void, unknown> {
      seen.push(req)
      const calls = turns[turn++] ?? null
      yield { type: 'request_prepared', measuredInputTokens: estimateRequest(req, spec.density) }
      yield { type: 'response_started', headersAt: Date.now() }
      if (calls) yield { type: 'tool_calls', calls, at: Date.now() }
      else yield { type: 'text_delta', delta: '完成', at: Date.now() }
      yield { type: 'done', stopReason: calls ? 'tool_use' : 'end_turn', rawStopReason: '' }
    },
  }
}

/** step 落进真库；`userSteps` 记 run 内有没有被补发过用户消息。 */
function persistence(store: Store, counters: { userSteps: number }): LoopPersistence {
  let seq = 0
  return {
    nextSeq: () => ++seq,
    openTextStep: (runId, s) => appendStep(store, { runId, seq: s, kind: 'text', content: '' }).id,
    openThinkingStep: (runId, s) =>
      appendStep(store, { runId, seq: s, kind: 'thinking', content: '' }).id,
    landUserStep: (runId, s, input) => {
      counters.userSteps++
      return appendStep(store, { runId, seq: s, kind: 'user', content: input.text }).id
    },
    failThinkingSteps: () => {},
    appendText: (stepId, delta) => appendTextToStep(store, stepId as StepId, delta),
    openToolStep: (runId, s, call, batchId, callIndex, waveIndex, action) =>
      appendStep(store, {
        runId,
        seq: s,
        kind: 'tool_action',
        toolName: call.name,
        toolCallId: call.id,
        providerBatchId: batchId,
        callIndex,
        executionWaveIndex: waveIndex,
        status: 'running',
        payload: { kind: 'tool_call', args: call.arguments, action },
      }).id,
    markExecuting: (stepId) => markStepExecuting(store, stepId as StepId),
    settleTool: (stepId, status, outcome, args, action, durationMs) =>
      settleToolStep(
        store,
        stepId as StepId,
        status,
        { kind: 'tool_result', args, outcome, action },
        durationMs,
      ),
    saveUsage: () => {},
    recordCompaction: () => {},
    openRequest: () => 'pr_test',
    markRequestSent: () => {},
    settleRequest: () => {},
  }
}

function makeBase(h: Harness, runId: RunId, desktop: DesktopPort): () => ToolContextBase {
  return () => ({
    workspaceRoot: h.dir,
    conversationId: h.conversationId,
    runId,
    model: 'test',
    contextWindow: WINDOW,
    density: DEFAULT_DENSITY,
    vision: null,
    resources: new Map(),
    state: new Map(),
    sink: new RuntimeSink(h.store, h.content, runId),
    signal: new AbortController().signal,
    requestPermission: async () => ({ allowed: true }),
    desktop,
  })
}

/** 同一个会话里再开一条 run：换 run 读同一个资源，以及把上一条 run 的消息投影回历史。 */
function anotherRun(h: Harness): RunId {
  return createRun(h.store, {
    conversationId: h.conversationId,
    workspaceId: h.workspaceId,
    model: 'm',
    clientRequestId: crypto.randomUUID(),
    userMessageId: null,
    messageIdUpperBound: null,
    contextSnapshot: [],
  }).id
}

function toolMessageOf(messages: WireMessage[], callId: string): WireMessage {
  const m = messages.find((x) => x.role === 'tool' && x.toolCallId === callId)
  expect(m).toBeDefined()
  return m as WireMessage
}

function replayToolContent(h: Harness, runId: RunId, callId: string): string {
  const messages = stepsToUnits(listSteps(h.store, runId)).flatMap((u) => u.messages)
  const content = toolMessageOf(messages, callId).content
  expect(typeof content).toBe('string')
  return content as string
}

function countRows(h: Harness): { refs: number; blobs: number } {
  const n = (sql: string, db: Store | ContentStore) =>
    db.db.query<{ n: number }, []>(sql).get()?.n ?? 0
  return {
    refs: n('SELECT COUNT(*) AS n FROM intermediate_resources', h.store),
    blobs: n('SELECT COUNT(*) AS n FROM content_blobs', h.content),
  }
}

/** 跑一轮：一次 desktop 动作加一次收尾，返回当轮信封与落账所需的那几项。 */
async function runDesktopAct(
  h: Harness,
  table: DesktopElement[],
): Promise<{ runId: RunId; callId: string; live: string }> {
  const runId = h.runId
  const callId = 'c_desktop_1'
  const seen: ChatRequest[] = []
  const loop = new AgentLoop({
    adapter: scriptedAdapter(
      [
        [
          {
            id: callId,
            name: 'desktop_act',
            arguments: { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e6' },
          },
        ],
        null,
      ],
      seen,
    ),
    registry: h.registry,
    systemPrompt: 'sys',
    persist: persistence(h.store, { userSteps: 0 }),
    makeToolContext: makeBase(h, runId, desktopPort(table)),
  })
  for await (const _ of loop.run({ runId, history: [], signal: new AbortController().signal })) {
    // 事件由具体用例各自断言，这里只把 run 跑完。
  }
  expect(seen).toHaveLength(2)
  const live = toolMessageOf((seen[1] as ChatRequest).messages, callId).content
  expect(typeof live).toBe('string')
  return { runId, callId, live: live as string }
}

describe('同一份结果在各层同形', () => {
  test('当轮请求信封与回放信封逐字相同，资源 id 是同一个已定稿 id', async () => {
    const h = harness()
    const { runId, callId, live } = await runDesktopAct(h, 大表)

    const envelope = JSON.parse(live) as { resources?: string[]; result?: unknown; tool: string }
    expect(envelope.tool).toBe('desktop_act')
    expect(envelope.resources).toHaveLength(1)
    const id = String(envelope.resources?.[0])

    // 账本里就这一条引用，指向的正是信封里那个 id。
    expect(getResource(h.store, id)?.toolName).toBe('desktop_act')
    expect(countRows(h)).toEqual({ refs: 1, blobs: 1 })

    expect(replayToolContent(h, runId, callId)).toBe(live)
    // 回放只是读账本：不重新生成地址，也不再存一份正文。
    expect(countRows(h)).toEqual({ refs: 1, blobs: 1 })
  })

  test('小控件表整份内联：两侧同样逐字相同，且不产生资源', async () => {
    const h = harness()
    const { runId, callId, live } = await runDesktopAct(h, 小表)

    const envelope = JSON.parse(live) as { resources?: string[]; result?: Record<string, unknown> }
    expect(envelope.resources).toBeUndefined()
    // 投递形状是紧凑的：按结果自带的默认值与动作字典还原后，与去掉 parentRef 的原表相等。
    // 字典按投递方式分组，`小表` 的动作表每张都只有一种投递方式，还原顺序与原表一致。
    const observation = envelope.result?.observation as {
      defaults: Record<string, unknown>
      actionSets: Record<string, string[]>[]
      elements: (Record<string, unknown> & { actionSet: number })[]
    }
    const expanded = observation.elements.map(({ actionSet, ...rest }) => ({
      ...observation.defaults,
      ...rest,
      actions: Object.entries(observation.actionSets[actionSet] ?? {}).flatMap(
        ([delivery, names]) => names.map((action) => ({ action, delivery: delivery.split('+') })),
      ),
    }))
    expect(expanded).toEqual(小表.map(({ parentRef: _parentRef, ...rest }) => rest))
    expect(countRows(h)).toEqual({ refs: 0, blobs: 0 })
    expect(replayToolContent(h, runId, callId)).toBe(live)
  })

  test('sequence：逐步回执与停止点落账，回放与当轮逐字相同', async () => {
    const h = harness()
    const runId = h.runId
    const callId = 'c_seq_1'
    const seen: ChatRequest[] = []
    const loop = new AgentLoop({
      adapter: scriptedAdapter(
        [
          [
            {
              id: callId,
              name: 'desktop_act_sequence',
              arguments: {
                windowId: 'dw_1',
                observationId: 'do_1',
                steps: [
                  { action: 'invoke', ref: 'e6' },
                  { action: 'invoke', ref: 'e6', expect: { until: 'gone' } },
                ],
              },
            },
          ],
          null,
        ],
        seen,
      ),
      registry: h.registry,
      systemPrompt: 'sys',
      persist: persistence(h.store, { userSteps: 0 }),
      makeToolContext: makeBase(h, runId, desktopPort(大表)),
    })
    for await (const _ of loop.run({
      runId,
      history: [],
      signal: new AbortController().signal,
    })) {
      // 事件在这条用例里不作断言，只把 run 跑完。
    }

    const live = toolMessageOf((seen[1] as ChatRequest).messages, callId).content as string
    const envelope = JSON.parse(live) as {
      resources?: string[]
      result?: { steps: { index: number }[]; dispatched: number[]; stoppedAt?: number }
    }
    expect(envelope.result?.steps.map((s) => s.index)).toEqual([1, 2])
    expect(envelope.result?.dispatched).toEqual([1, 2])
    expect(envelope.result?.stoppedAt).toBe(2)
    expect(envelope.resources).toHaveLength(1)
    expect(replayToolContent(h, runId, callId)).toBe(live)
  })

  /**
   * 观察 → 动作（界面几乎没变，差异投递）→ 动作（页面跳转，整份投递）。
   *
   * 差异标 partial，不收起基底；下一份整份投递同时收起基底与差异。差异那一条的回放与当轮
   * 逐字相同。
   */
  test('差异投递：请求里基底与差异并存，下一份整份同时收起两者，回放与当轮逐字相同', async () => {
    const h = harness()
    const runId = h.runId
    const 改名 = 小表.map((e) => (e.ref === 'e6' ? { ...e, name: '改过名的按钮' } : e))
    const 跳转 = [
      根,
      { ...分组, ref: 'e90', name: '另一页' },
      { ...目标, ref: 'e91', parentRef: 'e90' },
    ]
    const tables = [小表, 改名, 跳转]
    let at = 0
    const snap = (i: number) => 快照(tables[i] as DesktopElement[], `do_${i + 1}`)
    const port: DesktopPort = {
      ...desktopPort(小表),
      observe: async () => snap(0),
      elements: (_windowId, observationId) => tables[Number(observationId.slice(3)) - 1] ?? null,
      act: async () => {
        at += 1
        return { dispatch: 'submitted', actionId: `da_${at}`, observation: snap(at) }
      },
    }
    const act = (id: string, observationId: string) => ({
      id,
      name: 'desktop_act',
      arguments: { windowId: 'dw_1', observationId, action: 'invoke', ref: 'e6' },
    })
    const seen: ChatRequest[] = []
    const loop = new AgentLoop({
      adapter: scriptedAdapter(
        [
          [{ id: 'c_obs', name: 'desktop_observe', arguments: { windowId: 'dw_1' } }],
          [act('c_act1', 'do_1')],
          [act('c_act2', 'do_2')],
          null,
        ],
        seen,
      ),
      registry: h.registry,
      systemPrompt: 'sys',
      persist: persistence(h.store, { userSteps: 0 }),
      makeToolContext: makeBase(h, runId, port),
    })
    for await (const _ of loop.run({ runId, history: [], signal: new AbortController().signal })) {
      // 事件在这条用例里不作断言，只把 run 跑完。
    }
    expect(seen).toHaveLength(4)
    type Envelope = { result_omitted?: true; result?: Record<string, unknown> }
    const envelopeIn = (req: ChatRequest, callId: string) =>
      JSON.parse(toolMessageOf(req.messages, callId).content as string) as Envelope
    const observationIn = (e: Envelope) => e.result?.observation as Record<string, unknown>

    const afterDiff = seen[2] as ChatRequest
    expect(envelopeIn(afterDiff, 'c_obs').result?.elements).toBeDefined()
    const diff = observationIn(envelopeIn(afterDiff, 'c_act1'))
    expect(diff.since).toBe('do_1')
    expect((diff.changed as { ref: string }[]).map((e) => e.ref)).toEqual(['e6'])

    const afterJump = seen[3] as ChatRequest
    expect(envelopeIn(afterJump, 'c_obs').result_omitted).toBe(true)
    expect(envelopeIn(afterJump, 'c_act1').result_omitted).toBe(true)
    const jumped = observationIn(envelopeIn(afterJump, 'c_act2'))
    expect(jumped.since).toBeUndefined()
    expect(jumped.elements).toHaveLength(跳转.length)

    const live = toolMessageOf(afterDiff.messages, 'c_act1').content as string
    expect(replayToolContent(h, runId, 'c_act1')).toBe(live)
  })
})

describe('收纳之后地址仍在', () => {
  test('resources 保留、result 被省略，拿这个 id 仍能读回全文', async () => {
    const h = harness()
    const { runId, callId, live } = await runDesktopAct(h, 大表)
    const id = String((JSON.parse(live) as { resources: string[] }).resources[0])

    const condensed = condenseMessage({
      role: 'tool',
      content: live,
      toolCallId: callId,
    } as WireMessage)
    const envelope = JSON.parse(condensed.content as string) as {
      resources?: string[]
      result?: unknown
      result_omitted?: boolean
    }
    expect(envelope.resources).toEqual([id])
    expect(envelope.result).toBeUndefined()
    expect(envelope.result_omitted).toBe(true)

    // 回放出来的那一份收纳后同形：两侧不同形的话，同一次调用在本轮与下一轮长得不一样。
    const replayed = condenseMessage({
      role: 'tool',
      content: replayToolContent(h, runId, callId),
      toolCallId: callId,
    } as WireMessage)
    expect(replayed.content).toBe(condensed.content)

    const ctx = toolCtx({ h, desktop: desktopPort(大表) })
    const back = await readWhole(h, ctx, id)
    expect(Buffer.from(back, 'utf8').equals(Buffer.from(storedBody(h, id)))).toBe(true)
  })
})

describe('重启、切会话与回收之后仍读得到', () => {
  test('关掉再打开两个库：同一个 id 读回的正文一字不差', async () => {
    const h = harness()
    const ctx = toolCtx({ h, desktop: desktopPort(大表) })
    const id = resourceIdOf(await h.registry.execute('desktop_observe', { windowId: 'dw_1' }, ctx))
    const before = await readWhole(h, ctx, id)

    h.content.close()
    h.store.close()
    h.store = new Store({ path: h.dbPath })
    h.content = new ContentStore(contentPathFor(h.dbPath))

    // 切会话：另开一条 run 的 sink 去读同一个 id。
    const other = anotherRun(h)
    const reopened = toolCtx({
      h,
      sink: new RuntimeSink(h.store, h.content, other),
      desktop: desktopPort(大表),
    })
    expect(await readWhole(h, reopened, id)).toBe(before)
  })

  test('活着的 run：回收一次正文还在；run 被删后才随之回收，读回报资源不存在', async () => {
    const h = harness()
    const ctx = toolCtx({ h, desktop: desktopPort(大表) })
    const id = resourceIdOf(await h.registry.execute('desktop_observe', { windowId: 'dw_1' }, ctx))

    expect(collectResourceGarbage(h.store, h.content).removed).toBe(0)
    expect(h.sink.stat(id)).not.toBeNull()
    expect((await readWhole(h, ctx, id)).length).toBeGreaterThan(0)

    // 沿用现有的级联删除：删 run → 账本行随之消失 → 正文才可回收。
    h.store.db.query('DELETE FROM runs WHERE id = ?').run(h.runId)
    expect(collectResourceGarbage(h.store, h.content).removed).toBe(1)

    const gone = await h.registry.execute('read_resource', { resource_id: id }, ctx)
    expect(gone.status).toBe('failure')
    expect(gone.errorKind).toBe('resource_not_found')
  })
})

describe('实际用量跨工具可见', () => {
  test('超预算的观察不被拒、用量全记，随后的读取工具看到的余额是 0', async () => {
    const h = harness()
    const window = 32_000
    const { perCall, batchCap } = deliveryBudget(window)
    const ctx = toolCtx({ h, window, desktop: desktopPort(大表) })
    writeFileSync(join(h.dir, 'note.txt'), '合成正文\n'.repeat(50), 'utf8')

    resetBatchBudget(ctx.state)
    // 本波先前的读取已经用掉大部分预算。
    expect(chargeBatchBudget(ctx, perCall).ok).toBe(true)
    expect(chargeBatchBudget(ctx, batchCap - perCall - 200).ok).toBe(true)
    expect(chargeBatchBudget(ctx, 0).batchRemaining).toBe(200)

    const act = await h.registry.execute(
      'desktop_act',
      { windowId: 'dw_1', observationId: 'do_1', action: 'invoke', ref: 'e6' },
      ctx,
    )
    expect(act.status).toBe('success')
    expect((act.data as { dispatch: string }).dispatch).toBe('submitted')

    expect(chargeBatchBudget(ctx, 0).batchRemaining).toBe(0)
    // 累计值没有被截回上限：连 0 token 的准入都不再通过。
    expect(chargeBatchBudget(ctx, 0).ok).toBe(false)

    const read = await h.registry.execute('read_file', { path: 'note.txt' }, ctx)
    expect(read.status).toBe('failure')
    expect(read.errorKind).toBe('result_too_large')
    expect(read.message).toContain('本批还剩 0')
  })
})

describe('越过收纳线之后同一轮继续', () => {
  test('历史里带 resources 的观察结果：收纳后接着调 read_resource，不用补发用户消息', async () => {
    const h = harness()
    const first = await runDesktopAct(h, 大表)
    const id = String((JSON.parse(first.live) as { resources: string[] }).resources[0])

    const history = stepsToUnits(listSteps(h.store, first.runId)).flatMap((u) => u.messages)
    const runId = anotherRun(h)
    const callId = 'c_read_1'
    const seen: ChatRequest[] = []
    const counters = { userSteps: 0 }
    let folded = false
    const compaction: CompactionPort = {
      project: (messages) => (folded ? messages.map(condenseMessage) : messages),
      run: async () => {
        folded = true
        return okOutcome
      },
    }
    const loop = new AgentLoop({
      adapter: scriptedAdapter(
        [
          [{ id: callId, name: 'read_resource', arguments: { resource_id: id, query: 行尾标记 } }],
          null,
        ],
        seen,
      ),
      registry: h.registry,
      systemPrompt: 'sys',
      persist: persistence(h.store, counters),
      makeToolContext: makeBase(h, runId, desktopPort(大表)),
      compaction,
    })

    const events: AgentEvent[] = []
    for await (const ev of loop.run({
      runId,
      history,
      // 锚点把占用顶到软阈值之上：1M 窗口 × 0.8 → 800,000。
      anchor: {
        tokens: 900_000,
        throughMessageId: null,
        model: 'claude-opus-5',
        headTokens: 0,
        envelopeFingerprint: null,
      },
      signal: new AbortController().signal,
    })) {
      events.push(ev)
    }

    expect(events.some((e) => e.type === 'compaction' && e.phase === 'done')).toBe(true)
    expect(events.some((e) => e.type === 'run.finished')).toBe(true)
    // 同一轮做完：没有任何被补发的用户消息。
    expect(counters.userSteps).toBe(0)
    expect(history.some((m) => m.role === 'user')).toBe(false)

    /*
     * 收纳之后重建的那份请求里，定位符仍在规范的 `resources` 键上。
     *
     * 不要改成在整条信封里找这个 id 的子串：`summary` 里印着同一个 id，
     * 而收纳把 `summary` 原样留下，子串断言在定位符被丢掉时照样通过。
     */
    const sent = (seen[0] as ChatRequest).messages
    const condensed = sent
      .filter((m) => m.role === 'tool')
      .map((m) => JSON.parse(String(m.content)) as { resources?: string[]; result_omitted?: true })
    expect(condensed.flatMap((c) => c.resources ?? [])).toEqual([id])
    expect(condensed.some((c) => c.result_omitted === true)).toBe(true)

    // 模型接着读回原文，拿到的是存盘那一份里的命中。
    const result = replayToolContent(h, runId, callId)
    const envelope = JSON.parse(result) as { status: string; result?: { hits: Hit[] } }
    expect(envelope.status).toBe('success')
    expect((envelope.result?.hits ?? []).length).toBeGreaterThan(0)
  })
})

describe('存盘失败：地址不发、执行事实不变', () => {
  test('land 抛错时 step 里没有 resources，delivery.unsaved 在，回放同形', async () => {
    const h = harness()
    // 正文库不可用：`ContentStore.put` 抛错，主库事务随之回滚。
    h.content.close()

    const { runId, callId, live } = await runDesktopAct(h, 大表)
    const envelope = JSON.parse(live) as {
      status: string
      executed: boolean
      resources?: string[]
      result?: { dispatch: string; observation: { delivery: { unsaved?: string } } }
    }

    expect(envelope.status).toBe('success')
    expect(envelope.executed).toBe(true)
    expect(envelope.resources).toBeUndefined()
    expect(envelope.result?.dispatch).toBe('submitted')
    expect(envelope.result?.observation.delivery.unsaved).toBeTruthy()

    const payload = listSteps(h.store, runId).find((s) => s.toolCallId === callId)
      ?.payload as unknown as {
      outcome: { resources?: unknown[]; data: { observation: { delivery: { unsaved?: string } } } }
    }
    expect(payload.outcome.resources).toBeUndefined()
    expect(payload.outcome.data.observation.delivery.unsaved).toBeTruthy()

    // 账本里没有留下指向不存在正文的行。
    expect(
      h.store.db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM intermediate_resources').get()
        ?.n,
    ).toBe(0)
    expect(replayToolContent(h, runId, callId)).toBe(live)
  })
})
