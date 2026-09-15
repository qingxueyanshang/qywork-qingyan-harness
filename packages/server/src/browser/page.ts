/**
 * 受控页面上的观察与动作。
 *
 * 四条不变量：
 *
 * 1. **ref 只属于一次观察。** 编号绑定 tab、帧、文档令牌与节点身份指纹；导航换文档、
 *    重新观察换编号，旧编号一律拒绝。动作前重新解析节点并核对身份，不把一个失效编号
 *    重新定位成另一个同名按钮。
 * 2. **语义来自 AX 树与节点属性，不是整页 HTML。** 每一步把整页 HTML 塞进模型既装不下
 *    也读不准；元素表给角色、名称、类型、状态与正文摘要，超出上限时如实报截断。
 * 3. **鼠标坐标一律在顶层文档的坐标系里，键盘落在元素自己的会话上。** 跨站 iframe 的
 *    元素矩形是它自己文档里的值，必须叠加帧在父文档中的偏移；而焦点与文本插入由该帧
 *    的渲染进程处理，发到顶层会话会落在别处。
 * 4. **动作只发 CDP 的 Input 事件。** 不调系统鼠标键盘，不置前窗口。
 */

import type {
  BrowserActInput,
  BrowserActResult,
  BrowserElement,
  BrowserObservation,
  BrowserWaitResult,
} from '@qywork/agent'
import { log } from '@qywork/core'
import { type CdpClient, CdpError, keySpec, PRESS_KEYS } from './cdp.ts'

/** 一次观察最多返回多少个元素。超出时按 offset 翻页，不静默截断。 */
const MAX_ELEMENTS = 120
/** 元素名称与正文摘要的字符上限。 */
const MAX_TEXT = 200
/** 截图的字节上限。超过就降质量重拍一次，仍超过则不给图。 */
const MAX_SHOT_BYTES = 1_500_000
/** 单个跨站子帧的观察上限。它不答的时候主文档照样要能观察出来。 */
const FRAME_TIMEOUT_MS = 5_000

/**
 * 主文档 AX 树重取的间隔与总上限。
 *
 * Chromium 的无障碍树是懒计算的：页面刚 `on_page_load` 完成时它可能仍为空，
 * 而建页只等首个文档加载、不等 AX 树就绪。不重取的话，一个静态表单在 create 之后
 * 立刻 observe 会返回 0 个元素，模型只能退化成自己写脚本。跨站子帧不套这个重试——
 * 它已有 `FRAME_TIMEOUT_MS` 与跳过。
 */
const AX_RETRY_INTERVAL_MS = 150
const AX_RETRY_TOTAL_MS = 1_500

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 元素引用已经指不到原来那个节点。调用方必须重新观察，不能改写编号重试。 */
export class BrowserStaleRefError extends CdpError {}
/** 命中点落在别的元素上。页面结构变了或被浮层盖住，同样要求重新观察。 */
export class BrowserAmbiguousRefError extends CdpError {}

interface RefRecord {
  backendNodeId: number
  /** 元素所在的 CDP 会话：主文档是页会话，跨站 iframe 是它的子会话。 */
  sessionId: string
  frame?: string
  /** `标签|id|name|type`。动作前页内重算一遍，对不上即判失效。 */
  identity: string
  /** 该帧在顶层文档中的偏移，主文档为 0。 */
  offsetX: number
  offsetY: number
}

export interface ObservationRecord {
  observationId: string
  tabId: string
  /** 文档令牌。导航换文档即换值，据此判断整份观察是否已经失效。 */
  docToken: string
  refs: Map<string, RefRecord>
}

/** 页内建立文档令牌。不可写不可配置，同源脚本改不掉；新文档没有它，因此导航即换值。 */
const DOC_TOKEN = `(() => {
  if (!window.__qyworkDoc) {
    Object.defineProperty(window, '__qyworkDoc', {
      value: 'd' + Math.random().toString(36).slice(2) + Date.now().toString(36),
      writable: false,
      configurable: false,
    })
  }
  return { token: window.__qyworkDoc, url: location.href, title: document.title }
})()`

/**
 * 页内复核：节点还连着吗、身份还是那一个吗、矩形在哪、命中点打在谁身上。
 *
 * 一次往返答完全部问题。分成几次的代价是它们之间页面可能又变了，
 * 那样「复核通过」说的就不是最终发事件时的状态。
 */
const INSPECT_FN = `function () {
  const el = this
  const tag = (el.tagName || '').toLowerCase()
  const identity = [tag, el.id || '', el.getAttribute ? el.getAttribute('name') || '' : '', el.getAttribute ? el.getAttribute('type') || '' : ''].join('|')
  if (!el.isConnected) return { connected: false, identity }
  const r = el.getBoundingClientRect()
  const x = r.x + r.width / 2
  const y = r.y + r.height / 2
  // 命中测试要在元素自己的根里做：文档级的 elementFromPoint 对 shadow 内容返回的是
  // 宿主元素，而 contains 不穿透 shadow 边界，按文档级结果判会把每一次影子内点击
  // 都判成被覆盖。
  const root = el.getRootNode()
  const scope = typeof root.elementFromPoint === 'function' ? root : el.ownerDocument
  const hit = scope.elementFromPoint(x, y)
  let sameTree = false
  if (hit) sameTree = hit === el || el.contains(hit) || hit.contains(el)
  return {
    connected: true,
    identity,
    x,
    y,
    width: r.width,
    height: r.height,
    sameTree,
    hit: hit ? (hit.tagName || '').toLowerCase() : null,
    disabled: el.disabled === true,
    label: (el.getAttribute && el.getAttribute('aria-label')) || (el.innerText || '').trim().slice(0, 60) || tag,
  }
}`

/** 选择框设值并派发事件。直接改 value 不派发的话，网站的监听器收不到这次变化。 */
const SELECT_FN = `function (value) {
  const el = this
  if (el.tagName !== 'SELECT') return { ok: false, reason: 'not_select' }
  const options = Array.from(el.options).map((o) => o.value)
  const labels = Array.from(el.options).map((o) => (o.label || o.text || '').trim())
  let index = options.indexOf(value)
  if (index < 0) index = labels.indexOf(value)
  if (index < 0) return { ok: false, reason: 'no_option', options, labels }
  el.selectedIndex = index
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, value: el.value }
}`

/** 把现有内容选中，让随后的 insertText 顶替而不是追加。只动选区，不改 value。 */
const SELECT_ALL_FN = `function () {
  const el = this
  if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
    el.setSelectionRange(0, el.value.length)
    return { ok: true, had: el.value.length }
  }
  if (el.isContentEditable) {
    const range = el.ownerDocument.createRange()
    range.selectNodeContents(el)
    const sel = el.ownerDocument.defaultView.getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
    return { ok: true, had: (el.innerText || '').length }
  }
  return { ok: false, had: 0 }
}`

interface DomNode {
  backendNodeId: number
  nodeName: string
  nodeType: number
  nodeValue?: string
  attributes?: string[]
  children?: DomNode[]
  shadowRoots?: DomNode[]
  contentDocument?: DomNode
  pseudoElements?: DomNode[]
}

interface AxNode {
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: string }
  properties?: { name: string; value?: { value?: unknown } }[]
  backendDOMNodeId?: number
}

/** 会被当成可操作元素的 AX 角色。 */
const ACTIONABLE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
])

/**
 * 同样按可操作处理的标签。AX 角色缺失的自定义控件靠它兜住。
 *
 * **不含 `label`**：点它等于点它关联的控件，而那个控件已经单列了一行；
 * 它自己的可访问名通常是空的，进表只是一行没有用途的空条目。
 */
const ACTIONABLE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'summary', 'option'])

/** 只提供正文的角色。它们让模型读得到页面结果，不必回传整页 HTML。 */
const TEXT_ROLES = new Set(['StaticText', 'heading', 'paragraph', 'cell', 'columnheader'])

export interface PageHandle {
  client: CdpClient
  /** 页会话。所有鼠标事件与截图都发到这里。 */
  sessionId: string
  tabId: string
}

/**
 * 观察一页。
 *
 * 主文档与它的跨站子帧各取一次 DOM 快照和 AX 树；子帧元素的矩形叠加该帧在顶层文档
 * 中的偏移之后才是可发事件的坐标。
 */
export async function observePage(
  page: PageHandle,
  opts: { frame?: string; screenshot?: boolean; offset?: number },
): Promise<{ observation: BrowserObservation; record: ObservationRecord }> {
  const { client, sessionId, tabId } = page
  const head = await client.send<{
    result: { value: { token: string; url: string; title: string } }
  }>('Runtime.evaluate', { expression: DOC_TOKEN, returnByValue: true }, { sessionId })
  const doc = head.result.value

  const frames: { sessionId: string; frame?: string; offsetX: number; offsetY: number }[] = [
    { sessionId, offsetX: 0, offsetY: 0 },
  ]
  for (const child of client.childSessionsOf(sessionId)) {
    if (opts.frame && child.targetId !== opts.frame) continue
    const offset = await frameOffset(client, sessionId, child.targetId)
    frames.push({
      sessionId: child.sessionId,
      frame: child.targetId,
      offsetX: offset.x,
      offsetY: offset.y,
    })
  }
  // 指定了帧就只看那一个，主文档不掺进来——否则「只看这个 iframe」返回的仍是整页。
  const scope = opts.frame ? frames.filter((f) => f.frame === opts.frame) : frames

  const all: { element: BrowserElement; ref: RefRecord }[] = []
  for (const f of scope) {
    if (!f.frame) {
      all.push(...(await collectFrame(client, f)))
      continue
    }
    // 跨站子帧由它自己的渲染进程应答，正在加载或已经消失时会一直不回。
    // 一个帧不答不该让整页观察不出来——跳过它，主文档照常给出元素表。
    try {
      all.push(...(await collectFrame(client, f, FRAME_TIMEOUT_MS)))
    } catch (err) {
      log.warn('browser', `子帧观察跳过：${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const offset = opts.offset ?? 0
  const page_ = all.slice(offset, offset + MAX_ELEMENTS)
  const refs = new Map<string, RefRecord>()
  for (const item of page_) refs.set(item.element.ref, item.ref)

  const record: ObservationRecord = {
    observationId: `ob_${doc.token}_${offset}_${Date.now().toString(36)}`,
    tabId,
    docToken: doc.token,
    refs,
  }

  const image = opts.screenshot ? await capture(client, sessionId) : null

  return {
    observation: {
      tabId,
      url: doc.url,
      title: doc.title,
      observationId: record.observationId,
      elements: page_.map((i) => i.element),
      truncated: offset + page_.length < all.length,
      ...(image ? { image } : {}),
    },
    record,
  }
}

type FrameScope = { sessionId: string; frame?: string; offsetX: number; offsetY: number }

/** 编号在筛完之后才发，所以候选里只有除 `ref` 之外的那些字段。 */
interface Candidate {
  actionable: boolean
  element: Omit<BrowserElement, 'ref'>
  ref: RefRecord
}

/** 一帧里的元素。DOM 快照给标签与属性，AX 树给角色、名称与状态，按 backendNodeId 对上。 */
async function collectFrame(
  client: CdpClient,
  frame: FrameScope,
  timeoutMs?: number,
): Promise<{ element: BrowserElement; ref: RefRecord }[]> {
  const { sessionId } = frame
  const limit = timeoutMs === undefined ? {} : { timeoutMs }
  // pierce 穿透 shadow root 与同进程 iframe；跨站 iframe 另走它自己的会话。
  const dom = await client.send<{ root: DomNode }>(
    'DOM.getDocument',
    { depth: -1, pierce: true },
    { sessionId, ...limit },
  )
  const byBackend = new Map<number, { tag: string; attrs: Record<string, string> }>()
  flatten(dom.root, byBackend)

  const fetchAx = async () =>
    (
      await client.send<{ nodes: AxNode[] }>(
        'Accessibility.getFullAXTree',
        {},
        { sessionId, ...limit },
      )
    ).nodes

  let candidates = axCandidates(await fetchAx(), byBackend, frame)

  /*
   * AX 树懒计算：主文档刚加载完可能仍为空，静态表单因此也返回 0 候选。
   * DOM 里有可交互元素却 0 候选时，短间隔重取 AX 树，非空即用；到上限仍空就从
   * DOM 快照直接产元素表（语义降级但不为 0）。子帧不套——它自带超时与跳过。
   */
  if (!frame.frame && candidates.length === 0 && domHasActionable(byBackend)) {
    const deadline = Date.now() + AX_RETRY_TOTAL_MS
    while (candidates.length === 0 && Date.now() < deadline) {
      await sleep(AX_RETRY_INTERVAL_MS)
      candidates = axCandidates(await fetchAx(), byBackend, frame)
    }
    if (candidates.length === 0) candidates = domCandidates(byBackend, frame)
  }

  return dedupeAndNumber(candidates, frame)
}

/** 从 AX 树建候选：AX 给角色 / 名称 / 状态，DOM 给标签与属性。 */
function axCandidates(
  nodes: AxNode[],
  byBackend: Map<number, { tag: string; attrs: Record<string, string> }>,
  frame: FrameScope,
): Candidate[] {
  const candidates: Candidate[] = []
  for (const node of nodes) {
    if (node.ignored) continue
    const backendNodeId = node.backendDOMNodeId
    if (backendNodeId === undefined) continue
    const domInfo = byBackend.get(backendNodeId)
    const role = node.role?.value ?? ''
    const tag = domInfo?.tag ?? ''
    const name = (node.name?.value ?? '').trim()
    const actionable = ACTIONABLE_ROLES.has(role) || ACTIONABLE_TAGS.has(tag)
    const textual = TEXT_ROLES.has(role) && name !== ''
    if (!actionable && !textual) continue

    const props = new Map((node.properties ?? []).map((p) => [p.name, p.value?.value] as const))
    const attrs = domInfo?.attrs ?? {}
    const value = node.value?.value ?? attrs.value
    candidates.push({
      actionable,
      element: {
        role: role || tag,
        name: name.slice(0, MAX_TEXT),
        tag,
        ...(attrs.type ? { inputType: attrs.type } : {}),
        ...(value !== undefined ? { value: String(value).slice(0, MAX_TEXT) } : {}),
        ...(props.get('checked') !== undefined ? { checked: props.get('checked') === 'true' } : {}),
        ...(props.get('disabled') === true ? { disabled: true } : {}),
        ...(frame.frame ? { frame: frame.frame } : {}),
      },
      ref: {
        backendNodeId,
        sessionId: frame.sessionId,
        ...(frame.frame ? { frame: frame.frame } : {}),
        identity: [tag, attrs.id ?? '', attrs.name ?? '', attrs.type ?? ''].join('|'),
        offsetX: frame.offsetX,
        offsetY: frame.offsetY,
      },
    })
  }
  return candidates
}

/** DOM 快照中是否存在可交互元素。AX 树没建起来时靠它判断该不该重取。 */
function domHasActionable(
  byBackend: Map<number, { tag: string; attrs: Record<string, string> }>,
): boolean {
  for (const { tag, attrs } of byBackend.values()) {
    if (tag === 'input' && attrs.type === 'hidden') continue
    if (ACTIONABLE_TAGS.has(tag)) return true
    if (attrs.role && ACTIONABLE_ROLES.has(attrs.role)) return true
  }
  return false
}

/**
 * AX 树迟迟不建时的兜底：直接从 DOM 快照产可交互元素。
 *
 * 语义降级——名称只能取 `aria-label` / `placeholder` / `name` 这类属性，拿不到
 * AX 计算出的可访问名。**不造假元素**：只收真实的可交互标签，隐藏 input 不收。
 */
function domCandidates(
  byBackend: Map<number, { tag: string; attrs: Record<string, string> }>,
  frame: FrameScope,
): Candidate[] {
  const out: Candidate[] = []
  for (const [backendNodeId, { tag, attrs }] of byBackend) {
    if (tag === 'input' && attrs.type === 'hidden') continue
    const role = attrs.role ?? ''
    if (!ACTIONABLE_TAGS.has(tag) && !(role !== '' && ACTIONABLE_ROLES.has(role))) continue
    const name = (
      attrs['aria-label'] ??
      attrs.placeholder ??
      attrs.name ??
      attrs.title ??
      ''
    ).trim()
    out.push({
      actionable: true,
      element: {
        role: role || tag,
        name: name.slice(0, MAX_TEXT),
        tag,
        ...(attrs.type ? { inputType: attrs.type } : {}),
        ...(attrs.value !== undefined ? { value: attrs.value.slice(0, MAX_TEXT) } : {}),
        ...(frame.frame ? { frame: frame.frame } : {}),
      },
      ref: {
        backendNodeId,
        sessionId: frame.sessionId,
        ...(frame.frame ? { frame: frame.frame } : {}),
        identity: [tag, attrs.id ?? '', attrs.name ?? '', attrs.type ?? ''].join('|'),
        offsetX: frame.offsetX,
        offsetY: frame.offsetY,
      },
    })
  }
  return out
}

/** 候选去重、发编号。 */
function dedupeAndNumber(
  candidates: Candidate[],
  frame: FrameScope,
): { element: BrowserElement; ref: RefRecord }[] {
  /*
   * 正文节点里与某个可操作元素同名的那些不进表。
   *
   * 按钮的可访问名来自它内部的文本节点，两者在 AX 树里各占一行；都留下来的话，
   * 一个五控件的表单会给出十几个编号，其中一半点了等于点另一半。
   * 两趟判定而不是一趟：同名的可操作元素可能排在正文节点后面。
   */
  const actionableNames = new Set(
    candidates.filter((c) => c.actionable && c.element.name).map((c) => c.element.name),
  )
  const out: { element: BrowserElement; ref: RefRecord }[] = []
  let seq = 0
  for (const c of candidates) {
    if (!c.actionable && actionableNames.has(c.element.name)) continue
    if (!c.actionable && !c.element.name) continue
    seq += 1
    const ref = frame.frame ? `f${frame.frame.slice(0, 4)}e${seq}` : `e${seq}`
    out.push({ element: { ref, ...c.element }, ref: c.ref })
  }
  return out
}

function flatten(
  node: DomNode,
  out: Map<number, { tag: string; attrs: Record<string, string> }>,
): void {
  if (node.nodeType === 1) {
    const attrs: Record<string, string> = {}
    const flat = node.attributes ?? []
    for (let i = 0; i + 1 < flat.length; i += 2) attrs[flat[i] as string] = flat[i + 1] as string
    out.set(node.backendNodeId, { tag: node.nodeName.toLowerCase(), attrs })
  }
  for (const child of node.children ?? []) flatten(child, out)
  for (const shadow of node.shadowRoots ?? []) flatten(shadow, out)
  for (const pseudo of node.pseudoElements ?? []) flatten(pseudo, out)
  if (node.contentDocument) flatten(node.contentDocument, out)
}

/** 跨站 iframe 在父文档中的位置。子帧里的矩形要叠上它才是可发事件的坐标。 */
async function frameOffset(
  client: CdpClient,
  pageSession: string,
  frameId: string,
): Promise<{ x: number; y: number }> {
  try {
    const owner = await client.send<{ backendNodeId: number }>(
      'DOM.getFrameOwner',
      { frameId },
      { sessionId: pageSession },
    )
    const box = await client.send<{ model: { content: number[] } }>(
      'DOM.getBoxModel',
      { backendNodeId: owner.backendNodeId },
      { sessionId: pageSession },
    )
    return { x: box.model.content[0] ?? 0, y: box.model.content[1] ?? 0 }
  } catch {
    // 帧已经不在父文档里了。偏移取 0，随后的身份复核会把这个 ref 判成失效。
    return { x: 0, y: 0 }
  }
}

async function capture(
  client: CdpClient,
  sessionId: string,
): Promise<{ data: string; mime: string } | null> {
  for (const quality of [60, 35]) {
    const shot = await client.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality },
      { sessionId, timeoutMs: 20_000 },
    )
    if (shot.data.length * 0.75 <= MAX_SHOT_BYTES) {
      return { data: shot.data, mime: 'image/jpeg' }
    }
  }
  return null
}

interface Inspection {
  connected: boolean
  identity: string
  x?: number
  y?: number
  width?: number
  height?: number
  sameTree?: boolean
  hit?: string | null
  disabled?: boolean
  label?: string
}

/**
 * 把一个 ref 解析成可操作的节点。
 *
 * 文档令牌、节点连接状态、身份指纹三项全过才算命中；任一不符按失效返回，
 * 要求重新观察。**不做「按名字再找一个」的重定位**——那会把点击落在另一个同名按钮上。
 */
async function resolveRef(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
): Promise<{ entry: RefRecord; objectId: string; inspect: Inspection }> {
  const { client, sessionId } = page
  const head = await client.send<{ result: { value: { token: string } } }>(
    'Runtime.evaluate',
    { expression: DOC_TOKEN, returnByValue: true },
    { sessionId },
  )
  if (head.result.value.token !== record.docToken) {
    throw new BrowserStaleRefError('页面已经换过文档，这次观察的元素编号全部失效，请重新观察')
  }
  const entry = record.refs.get(ref)
  if (!entry) throw new BrowserStaleRefError(`这次观察里没有元素 ${ref}，请重新观察`)

  const resolved = await client
    .send<{ object: { objectId?: string } }>(
      'DOM.resolveNode',
      { backendNodeId: entry.backendNodeId },
      { sessionId: entry.sessionId },
    )
    .catch(() => null)
  const objectId = resolved?.object.objectId
  if (!objectId) throw new BrowserStaleRefError(`元素 ${ref} 已经不在页面上，请重新观察`)

  const inspected = await client.send<{ result: { value: Inspection } }>(
    'Runtime.callFunctionOn',
    { objectId, functionDeclaration: INSPECT_FN, returnByValue: true },
    { sessionId: entry.sessionId },
  )
  const inspect = inspected.result.value
  if (!inspect.connected) {
    throw new BrowserStaleRefError(`元素 ${ref} 已从文档中移除，请重新观察`)
  }
  if (inspect.identity !== entry.identity) {
    throw new BrowserStaleRefError(`元素 ${ref} 指向的已经是另一个节点，请重新观察`)
  }
  return { entry, objectId, inspect }
}

/** 在已观察的元素上做一次有限动作。 */
export async function actOnPage(
  page: PageHandle,
  record: ObservationRecord,
  input: BrowserActInput,
): Promise<BrowserActResult> {
  const { client, sessionId } = page

  if (input.action === 'scroll' && !input.ref) {
    const y = input.deltaY ?? 400
    await client.send(
      'Input.dispatchMouseEvent',
      { type: 'mouseWheel', x: 10, y: 10, deltaX: 0, deltaY: y, button: 'none' },
      { sessionId },
    )
    return {}
  }
  if (input.action === 'press' && !input.ref) {
    await pressOn(page, sessionId, input.key)
    return {}
  }
  if (!input.ref) throw new CdpError(`${input.action} 需要元素引用`)

  const { entry, objectId, inspect } = await resolveRef(page, record, input.ref)
  const point = {
    x: (inspect.x ?? 0) + entry.offsetX,
    y: (inspect.y ?? 0) + entry.offsetY,
  }

  switch (input.action) {
    case 'click': {
      if (inspect.disabled) throw new CdpError(`元素 ${input.ref} 当前不可用`)
      if (inspect.sameTree !== true) {
        throw new BrowserAmbiguousRefError(
          `元素 ${input.ref} 的命中点落在 ${inspect.hit ?? '空白'} 上，页面可能已变化，请重新观察`,
        )
      }
      await clickPoint(client, sessionId, point)
      return { element: inspect.label ?? input.ref, point }
    }
    case 'fill': {
      await client.send(
        'DOM.focus',
        { backendNodeId: entry.backendNodeId },
        { sessionId: entry.sessionId },
      )
      await client.send(
        'Runtime.callFunctionOn',
        { objectId, functionDeclaration: SELECT_ALL_FN, returnByValue: true },
        { sessionId: entry.sessionId },
      )
      // 文本插入发到元素自己的会话：焦点由该帧的渲染进程持有，发到顶层会落在别处。
      await client.send(
        'Input.insertText',
        { text: input.text ?? '' },
        { sessionId: entry.sessionId },
      )
      return { element: inspect.label ?? input.ref }
    }
    case 'select': {
      const r = await client.send<{
        result: { value: { ok: boolean; reason?: string; options?: string[] } }
      }>(
        'Runtime.callFunctionOn',
        {
          objectId,
          functionDeclaration: SELECT_FN,
          arguments: [{ value: input.text ?? '' }],
          returnByValue: true,
        },
        { sessionId: entry.sessionId },
      )
      const value = r.result.value
      if (!value.ok) {
        throw new CdpError(
          value.reason === 'no_option'
            ? `没有这个选项：${input.text}（可选：${(value.options ?? []).join('、')}）`
            : `元素 ${input.ref} 不是选择框`,
        )
      }
      return { element: inspect.label ?? input.ref }
    }
    case 'scroll': {
      await client.send(
        'Input.dispatchMouseEvent',
        {
          type: 'mouseWheel',
          x: point.x,
          y: point.y,
          deltaX: 0,
          deltaY: input.deltaY ?? 400,
          button: 'none',
        },
        { sessionId },
      )
      return { element: inspect.label ?? input.ref, point }
    }
    case 'press': {
      await client.send(
        'DOM.focus',
        { backendNodeId: entry.backendNodeId },
        { sessionId: entry.sessionId },
      )
      await pressOn(page, entry.sessionId, input.key)
      return { element: inspect.label ?? input.ref }
    }
  }
}

async function pressOn(
  page: PageHandle,
  sessionId: string,
  key: string | undefined,
): Promise<void> {
  const spec = keySpec(key ?? '')
  if (!spec) throw new CdpError(`不支持的按键：${key}（可用：${PRESS_KEYS.join('、')}）`)
  await page.client.pressKey(sessionId, spec)
}

async function clickPoint(
  client: CdpClient,
  sessionId: string,
  point: { x: number; y: number },
): Promise<void> {
  for (const type of ['mousePressed', 'mouseReleased'] as const) {
    await client.send(
      'Input.dispatchMouseEvent',
      { type, x: point.x, y: point.y, button: 'left', clickCount: 1 },
      { sessionId },
    )
  }
}

/** 等一个选择器出现。页内等待器只观察并返回，不点击、不提交。 */
export async function waitOnPage(
  page: PageHandle,
  selector: string,
  timeoutMs: number,
): Promise<BrowserWaitResult> {
  const { client, sessionId } = page
  const waiterId = await client.startWaiter(sessionId, selector, timeoutMs)
  try {
    const got = (await client.awaitWaiter(sessionId, waiterId, timeoutMs + 5_000)) as {
      found?: boolean
      reason?: string
    }
    return {
      found: got.found === true,
      ...(got.reason ? { reason: got.reason } : {}),
    }
  } finally {
    await client.disposeWaiter(sessionId, waiterId).catch(() => {})
  }
}

/** 把本机文件交给一个文件输入元素。路径必须已经过工作区裁决。 */
export async function uploadToPage(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
  paths: string[],
): Promise<{ files: string[] }> {
  const { entry } = await resolveRef(page, record, ref)
  await page.client.send(
    'DOM.setFileInputFiles',
    { files: paths, backendNodeId: entry.backendNodeId },
    { sessionId: entry.sessionId },
  )
  return { files: paths }
}

/**
 * 点一个元素触发下载。
 *
 * **只用 Input 事件触发**：无用户手势的第 2 次下载会撞上 WebView2 的「下载多个文件」
 * 权限提示，提示先于下载钩子、钩子收不到事件，而 Tauri 与 wry 都不暴露这个事件。
 * 不要改成 `location.href` 跳转或 `a.click()`。
 */
export async function clickForDownload(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
): Promise<BrowserActResult> {
  const { entry, inspect } = await resolveRef(page, record, ref)
  if (inspect.sameTree !== true) {
    throw new BrowserAmbiguousRefError(`元素 ${ref} 的命中点落在别处，请重新观察`)
  }
  const point = { x: (inspect.x ?? 0) + entry.offsetX, y: (inspect.y ?? 0) + entry.offsetY }
  await clickPoint(page.client, page.sessionId, point)
  return { element: inspect.label ?? ref, point }
}
