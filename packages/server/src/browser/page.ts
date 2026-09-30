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
 *    元素矩形是它自己文档里的值，必须逐层叠加帧在父文档中的偏移；偏移在动作准备里
 *    现取，观察时量到的那一份在父页滚动后不成立。焦点与文本插入由该帧的渲染进程处理，
 *    发到顶层会话会落在别处。
 * 4. **动作只发 CDP 的 Input 事件。** 不调系统鼠标键盘，不置前窗口。
 */

import {
  type BrowserActInput,
  type BrowserActReceipt,
  type BrowserElement,
  type BrowserKeyPhase,
  type BrowserObservation,
  type BrowserOptionsPage,
  type BrowserPathStep,
  type BrowserPoint,
  type BrowserSelectOption,
  type BrowserWaitReceipt,
  type BrowserWaitState,
  charKeys,
  checkDuration,
  checkHeldKeys,
  checkKeyPhases,
  checkPath,
} from '@qywork/agent'
import { log } from '@qywork/core'
import { type CdpClient, CdpError } from './cdp.ts'
import {
  aimAt,
  EVENT_TIMEOUT_MS,
  Execution,
  Keyboard,
  leftMs,
  mouseEvent,
  type Point,
  runKeyPhases,
  settleInput,
  within,
} from './input.ts'

/** 一次观察最多返回多少个元素。超出时按 offset 翻页，不静默截断。 */
const MAX_ELEMENTS = 120
/**
 * 选项样例与填写回执里值的字符上限。
 *
 * 元素表的名称与值不用它：查询要按原值匹配，完整原值随观察存盘，长度由投递层控制。
 */
const MAX_TEXT = 200
/** 动作回执的目标标签、遮挡元素与选项样例的名称上限。 */
const MAX_LABEL = 60
/** 单个 select 一次返回的选项上限。 */
const MAX_SELECT_OPTIONS = 30
/** 一份普通观察里所有 select 的选项摘要合计上限。 */
const MAX_OBSERVATION_OPTIONS = 100
/** 选不中时错误里带几个选项样例。 */
const SELECT_SAMPLE = 5
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

/**
 * 跨站帧附上子会话之前的等待上限与重查间隔。
 *
 * 建页只等主文档 load 完成，跨站 iframe 的导航在那之后才提交；实测这一段在空闲机器上
 * 也只有几十毫秒的余量，观察撞进去就得到一张没有帧内元素的表。等满仍未就位的帧按
 * `framesPending` 报出，不静默少算。
 *
 * 2 秒的依据（2026-09-16 实测，回环三层跨站页与公网含跨站 iframe 的页各十轮）：不限速时
 * 跨站帧在首次观察的头几轮重查里就绪；给帧加 1.5 秒时延后，首次观察报 `framesPending`，
 * 第二次观察（约 1 秒后）拿到帧内元素。**不要往上调**：这段上限是每一次撞上未就位帧的
 * 观察都要等的固定开销，而等不到的帧多等一秒仍然等不到，`framesPending` 已经把它说清楚。
 */
const FRAME_ATTACH_INTERVAL_MS = 100
const FRAME_ATTACH_TOTAL_MS = 2_000

/** 尚未提交导航的帧承载的地址。 */
const BLANK_URL = 'about:blank'

/** 调用方没有给截止时间时，一次观察的总预算。 */
const OBSERVE_BUDGET_MS = 30_000
/** 单条采集命令的上限。剩余预算更少时按剩余预算发，不再给满额度。 */
const COLLECT_TIMEOUT_MS = 15_000
/** 单次截图的上限。 */
const SHOT_TIMEOUT_MS = 20_000

/**
 * 一次坐标动作的准备预算：身份核对、滚入可视区、重新量取与命中复核合用。
 *
 * 布局持续变化时按它退出，不在同一个动作里反复滚动重量。
 */
const PREPARE_BUDGET_MS = 10_000
/** 准备阶段单条命令的上限。剩余预算更少时按剩余预算发。 */
const PREPARE_TIMEOUT_MS = 5_000
/** 帧链最多走几层。超过即判定失败，不继续向上找。 */
const MAX_FRAME_DEPTH = 8

/** `type` 一次最多输入多少个 Unicode 码点。整段预检通过才发第一个事件。 */
const MAX_TYPE_UNITS = 2_000
/** 拖动按下之后最多为每一段终点推进几次滚动。 */
const MAX_DRAG_SCROLLS = 2
/** 有时长的拖动段里相邻两次移动的间隔，约一帧。 */
const DRAG_STEP_MS = 16

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 元素引用已经指不到原来那个节点。调用方必须重新观察，不能改写编号重试。 */
export class BrowserStaleRefError extends CdpError {}
/** 命中点落在别的元素上。页面结构变了或被浮层盖住，同样要求重新观察。 */
export class BrowserAmbiguousRefError extends CdpError {}
/** 预算内没能采到一份前后一致的快照。调用方保留已经发出的动作回执，不重做动作。 */
export class BrowserObserveTimeoutError extends CdpError {}

/**
 * 一个元素编号背后的定位信息。
 *
 * **不存帧偏移**：偏移随父页滚动变化，观察时量到的那一份在动作时可能已经不成立。
 * 坐标一律在动作准备里现取，见 `prepareAction`。
 */
interface RefRecord {
  backendNodeId: number
  /** 元素所在的 CDP 会话：主文档与同进程 iframe 是页会话，跨站 iframe 是它的子会话。 */
  sessionId: string
  frame?: string
  /**
   * 同进程帧链：从元素所在文档向外，每一跳是承载它的 iframe 元素在父文档里的节点号。
   *
   * 缺席即元素直接在会话的根文档里。这一层记的是结构不是几何——盒子在动作准备里现取。
   */
  owners?: number[]
  /** 是否为控件。文字也可承载指针动作，但不能因此成为输入框或选择框。 */
  actionable: boolean
  /** 元素为 `标签|id|name|type`，文本为 `#text|原文`。动作前重算，不符即失效。 */
  identity: string
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
 *
 * `label` 与 `hitLabel` 都按 `MAX_LABEL` 截。页面自报的 `aria-label` 长度无界，
 * 不在这里截的话它会经由动作回执进 message。
 *
 * 给了 `px` / `py` 时量的是元素矩形左上角起的那一点，否则是中心；`inBox` 说这一点在不在
 * 此刻的矩形里——元素尺寸在观察之后可能变过。
 */
export const INSPECT_FN = `function qyInspect(px, py) {
  const el = this
  const text = el.nodeType === 3
  const tag = (el.tagName || '').toLowerCase()
  const identity = text ? '#text|' + el.nodeValue : [tag, el.id || '', el.getAttribute ? el.getAttribute('name') || '' : '', el.getAttribute ? el.getAttribute('type') || '' : ''].join('|')
  if (!el.isConnected) return { connected: false, identity }
  const range = text ? el.ownerDocument.createRange() : null
  if (range) range.selectNodeContents(el)
  const r = (range || el).getBoundingClientRect()
  const rects = range ? Array.from(range.getClientRects()).filter(r => r.width > 0 && r.height > 0) : [r]
  const view = el.ownerDocument.defaultView
  // 文本可跨行。选一个实际文字片段，不用父容器或多行外接矩形的中心。
  const fragment = rects.find(r => r.right > 0 && r.bottom > 0 && r.left < view.innerWidth && r.top < view.innerHeight) || rects[0] || r
  const offset = typeof px === 'number' && typeof py === 'number'
  const x = offset ? r.x + px : fragment.x + fragment.width / 2
  const y = offset ? r.y + py : fragment.y + fragment.height / 2
  const inBox = text ? rects.some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) : !offset || (px >= 0 && py >= 0 && px <= r.width && py <= r.height)
  // 可视区判定用元素自己文档的视口。这一层通过只说明它在本文档内可见，
  // 跨站 iframe 还要逐层核对父文档，见 framePoint。
  const inView = x >= 0 && y >= 0 && x <= view.innerWidth && y <= view.innerHeight
  // 命中测试要在元素自己的根里做：文档级的 elementFromPoint 对 shadow 内容返回的是
  // 宿主元素，而 contains 不穿透 shadow 边界，按文档级结果判会把每一次影子内点击
  // 都判成被覆盖。
  const root = el.getRootNode()
  const scope = typeof root.elementFromPoint === 'function' ? root : el.ownerDocument
  const hit = inView ? scope.elementFromPoint(x, y) : null
  let sameTree = false
  if (hit) sameTree = text ? inBox && hit === el.parentElement : hit === el || el.contains(hit) || hit.contains(el)
  return {
    connected: true,
    identity,
    x,
    y,
    width: r.width,
    height: r.height,
    inBox,
    inView,
    sameTree,
    hit: hit ? (hit.tagName || '').toLowerCase() : null,
    hitLabel: hit ? (((hit.getAttribute && hit.getAttribute('aria-label')) || (hit.innerText || '').trim() || '').slice(0, ${MAX_LABEL})) : '',
    disabled: text ? !!el.parentElement?.closest(':disabled, [aria-disabled="true"], [inert]') : el.disabled === true,
    label: ((text ? el.nodeValue.trim() : (el.getAttribute && el.getAttribute('aria-label')) || (el.innerText || '').trim() || '').slice(0, ${MAX_LABEL})) || tag,
  }
}`

/**
 * 把子帧里的一个点换算到父文档，并在父文档里复核这个点打在本帧上。
 *
 * 加的是内容盒左上角，不是边框盒：iframe 的内容从内边距内侧开始，按边框盒算会整体
 * 偏掉一个边框宽度。父层遮罩盖住 iframe 时 `sameTree` 为假，那一层就是遮挡点。
 */
const FRAME_POINT_FN = `function qyFramePoint(x, y) {
  const el = this
  const r = el.getBoundingClientRect()
  const view = el.ownerDocument.defaultView
  const cs = view.getComputedStyle(el)
  const px = r.x + (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.paddingLeft) || 0) + x
  const py = r.y + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.paddingTop) || 0) + y
  const inView = px >= 0 && py >= 0 && px <= view.innerWidth && py <= view.innerHeight
  const hit = inView ? el.ownerDocument.elementFromPoint(px, py) : null
  let sameTree = false
  if (hit) sameTree = hit === el || el.contains(hit) || hit.contains(el)
  return {
    x: px,
    y: py,
    width: r.width,
    height: r.height,
    inView,
    sameTree,
    hit: hit ? (hit.tagName || '').toLowerCase() : null,
    hitLabel: hit ? (((hit.getAttribute && hit.getAttribute('aria-label')) || (hit.innerText || '').trim() || '').slice(0, ${MAX_LABEL})) : '',
  }
}`

/**
 * 读一段选项。`total` 是此刻的总数，调用方据此判断还有没有后续。
 *
 * 取 `el.options` 而不是子元素：它把 optgroup 里的选项一并铺平，顺序与用户看到的
 * 一致。禁用状态并入 optgroup——optgroup 禁用时它下面的选项一律不可选。
 */
const OPTIONS_FN = `function qyOptions(start, limit) {
  const el = this
  if (el.tagName !== 'SELECT') return { ok: false }
  const all = el.options
  const items = []
  for (let i = start; i < all.length && items.length < limit; i++) {
    const o = all[i]
    const group = o.parentElement && o.parentElement.tagName === 'OPTGROUP' ? o.parentElement : null
    const disabled = o.disabled === true || (group ? group.disabled === true : false)
    const item = { label: (o.label || o.text || '').trim().slice(0, ${MAX_TEXT}), value: String(o.value).slice(0, ${MAX_TEXT}) }
    if (disabled) item.disabled = true
    if (o.selected === true) item.selected = true
    items.push(item)
  }
  return { ok: true, total: all.length, items }
}`

/**
 * 选择框设值并派发事件。直接改 value 不派发的话，网站的监听器收不到这次变化。
 *
 * 选不中时只回原因、总数与有界样例。**不要改成回完整选项表**：一个上千项的
 * `select` 会把整份工具输出撑掉，继续读取走 `optionsFor`。
 */
const SELECT_FN = `function qySelect(value) {
  const el = this
  if (el.tagName !== 'SELECT') return { ok: false, reason: 'not_select' }
  const all = el.options
  let index = -1
  for (let i = 0; i < all.length; i++) {
    if (all[i].value === value) { index = i; break }
  }
  if (index < 0) {
    for (let i = 0; i < all.length; i++) {
      if ((all[i].label || all[i].text || '').trim() === value) { index = i; break }
    }
  }
  if (index < 0) {
    const sample = []
    for (let i = 0; i < all.length && sample.length < ${SELECT_SAMPLE}; i++) {
      sample.push((all[i].label || all[i].text || '').trim().slice(0, ${MAX_LABEL}))
    }
    return { ok: false, reason: 'no_option', total: all.length, sample }
  }
  const opt = all[index]
  const group = opt.parentElement && opt.parentElement.tagName === 'OPTGROUP' ? opt.parentElement : null
  if (opt.disabled === true || (group && group.disabled === true)) {
    return { ok: false, reason: 'option_disabled', label: (opt.label || opt.text || '').trim().slice(0, ${MAX_LABEL}) }
  }
  el.selectedIndex = index
  el.dispatchEvent(new Event('input', { bubbles: true }))
  el.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, value: el.value }
}`

/**
 * 覆盖输入一个控件的值。
 *
 * 三段：写前拒绝（禁用、只读、类型不能清空）→ 在同类型的临时控件上预检格式与约束 →
 * 对目标用原生 setter 写入、派发 input/change、回读实际值。
 *
 * **预检必须在临时控件上做。** 直接往目标上试一次再看结果的话，非法值已经把原值冲掉了。
 * 写入用 `HTMLInputElement.prototype` 上的原生 setter：受控组件把 `value` 换成了自己的
 * 访问器，直接赋值它收不到这次变化，框架状态与页面显示会从此不一致。
 * `range` 对越界值是静默钳到边界，不报错，所以它的「规范化后不等于原值」按约束不满足处理。
 */
const FILL_FN = `function qyFill(value) {
  const el = this
  const tag = (el.tagName || '').toLowerCase()
  if (el.disabled === true) return { ok: false, reason: 'disabled' }
  if (el.readOnly === true) return { ok: false, reason: 'readonly' }
  const cut = (s) => String(s).slice(0, ${MAX_TEXT})
  const fire = () => {
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  if (tag !== 'input' && tag !== 'textarea') {
    if (el.isContentEditable !== true) return { ok: false, reason: 'not_fillable' }
    el.focus()
    el.textContent = value
    fire()
    const after = el.textContent === null ? '' : el.textContent
    if (after !== value) return { ok: false, reason: 'rejected', value: cut(after) }
    return { ok: true, type: 'contenteditable', value: cut(after), normalized: false }
  }
  const type = tag === 'textarea' ? 'textarea' : String(el.type || 'text').toLowerCase()
  if (value === '' && (type === 'range' || type === 'color')) {
    return { ok: false, reason: 'no_empty', type: type }
  }
  let normalized = value
  if (tag === 'input') {
    const probe = el.ownerDocument.createElement('input')
    probe.type = type
    if (probe.type !== type) return { ok: false, reason: 'bad_type', type: type }
    for (const attr of ['min', 'max', 'step']) {
      if (el.hasAttribute(attr)) probe.setAttribute(attr, el.getAttribute(attr))
    }
    // color 只接受 #rrggbb。认不出的写法它换成一个具体颜色而不是空串，
    // 按「规范化结果非空」判会把 red 当成合法输入，写进去的是另一个值。
    if (type === 'color' && !/^#[0-9a-fA-F]{6}$/.test(value)) {
      return { ok: false, reason: 'bad_format', type: type }
    }
    probe.value = value
    normalized = probe.value
    if (value !== '' && normalized === '') return { ok: false, reason: 'bad_format', type: type }
    if (type === 'range' && normalized !== value) {
      return { ok: false, reason: 'clamped', type: type, value: cut(normalized) }
    }
    const v = probe.validity
    if (v && (v.rangeUnderflow || v.rangeOverflow || v.stepMismatch)) {
      const limits = {}
      for (const attr of ['min', 'max', 'step']) {
        if (el.hasAttribute(attr)) limits[attr] = cut(el.getAttribute(attr))
      }
      return { ok: false, reason: 'constraint', type: type, limits: limits }
    }
  }
  const proto = tag === 'textarea' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
  el.focus()
  setter.call(el, value)
  fire()
  const after = String(el.value)
  if (after !== normalized) {
    return { ok: false, reason: 'rejected', type: type, value: cut(after), wanted: cut(normalized) }
  }
  return { ok: true, type: type, value: cut(after), normalized: after !== value }
}`

/**
 * 逐字输入前的复核：节点还在、还是同一个、焦点还在它身上。
 *
 * 每个码点发一次。少了这一层，节点被替换或焦点转移之后，后面的字符会进另一个控件，
 * 而那一段输入的去向在回执里看不出来。
 */
const TYPING_GUARD_FN = `function qyTypingTarget() {
  const el = this
  const tag = (el.tagName || '').toLowerCase()
  const identity = [tag, el.id || '', el.getAttribute ? el.getAttribute('name') || '' : '', el.getAttribute ? el.getAttribute('type') || '' : ''].join('|')
  const root = el.getRootNode()
  const active = root && root.activeElement ? root.activeElement : el.ownerDocument.activeElement
  return { connected: el.isConnected === true, identity, focused: active === el }
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
  /** iframe 元素上是它承载的那一帧的编号；文档节点上是这份文档所属的帧。 */
  frameId?: string
  /** 文档节点此刻的地址。导航尚未提交时为 `about:blank`。 */
  documentURL?: string
}

/** 一个元素节点在 DOM 快照里的标签与属性。 */
type DomInfo = { tag: string; attrs: Record<string, string>; text?: string }

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
 * 它自己的可访问名通常是空的，进表只是一行没有用途的空条目。`canvas` 的交互全在它自己的
 * 像素里，AX 树给它 `Canvas` 角色，只有按标签收进来，指针动作才有落点可指。
 */
const ACTIONABLE_TAGS = new Set([
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
  'option',
  'canvas',
])

/** 只提供正文的角色。它们让模型读得到页面结果，不必回传整页 HTML。 */
const TEXT_ROLES = new Set(['StaticText', 'heading', 'paragraph', 'cell', 'columnheader'])

export interface PageHandle {
  client: CdpClient
  /** 页会话。所有鼠标事件与截图都发到这里。 */
  sessionId: string
  tabId: string
}

/**
 * 现读主文档的令牌、地址与标题。
 *
 * 跨文档判定与采集一致性判定都按它现取，不用观察表里记的那一份：那份记的是上一次
 * 采集的页面，与此刻的文档不一定是同一个。
 */
export async function readDocument(
  page: PageHandle,
  timeoutMs?: number,
): Promise<{ token: string; url: string; title: string }> {
  const head = await page.client.send<{
    result: { value: { token: string; url: string; title: string } }
  }>(
    'Runtime.evaluate',
    { expression: DOC_TOKEN, returnByValue: true },
    { sessionId: page.sessionId, ...(timeoutMs === undefined ? {} : { timeoutMs }) },
  )
  return head.result.value
}

/**
 * 观察一页。
 *
 * 主文档与它的跨站子帧各取一次 DOM 快照和 AX 树；子帧元素的矩形叠加该帧在顶层文档
 * 中的偏移之后才是可发事件的坐标。
 *
 * **采集前后各核一次主文档令牌与地址**：期间换了文档或地址，这份结果里混着两个页面的
 * 元素，整份丢掉在剩余预算内重采，不登记「旧令牌配新元素」的观察。预算耗尽抛
 * `BrowserObserveTimeoutError`。采集一致不等于 DOM 与业务状态从此不再变化。
 *
 * **观察只读，不滚动页面**：要滚动的是动作，见 `prepareAction`。返回的 select 另带一份
 * 当前选项摘要，合计有上限，未列全的用 `readSelectOptions` 继续读。
 */
export async function observePage(
  page: PageHandle,
  opts: {
    frame?: string
    screenshot?: boolean
    offset?: number
    query?: string
    deadline?: number
  },
): Promise<{ observation: BrowserObservation; record: ObservationRecord }> {
  const { client, sessionId, tabId } = page
  const deadline = opts.deadline ?? Date.now() + OBSERVE_BUDGET_MS
  for (;;) {
    if (leftMs(deadline) <= 0) {
      throw new BrowserObserveTimeoutError('没有在预算内采到一份前后一致的观察，请重新观察')
    }
    const before = await readDocument(page, within(deadline, COLLECT_TIMEOUT_MS).timeoutMs)
    const collected = await collectAll(client, sessionId, opts, deadline)
    const pending = collected.pending
    const query = opts.query
    const all = query
      ? collected.items.filter((i) => matchesQuery(i.element, query))
      : collected.items
    const offset = opts.offset ?? 0
    const shown = all.slice(offset, offset + MAX_ELEMENTS)
    await attachOptions(client, shown, deadline)
    await attachSizes(client, shown, deadline)
    const image = opts.screenshot ? await capture(client, sessionId, deadline) : null
    const after = await readDocument(page, within(deadline, COLLECT_TIMEOUT_MS).timeoutMs)
    if (after.token !== before.token || after.url !== before.url) continue

    const refs = new Map<string, RefRecord>()
    for (const item of shown) refs.set(item.element.ref, item.ref)
    const record: ObservationRecord = {
      observationId: `ob_${after.token}_${offset}_${Date.now().toString(36)}`,
      tabId,
      docToken: after.token,
      refs,
    }
    return {
      observation: {
        tabId,
        url: after.url,
        title: after.title,
        observationId: record.observationId,
        elements: shown.map((i) => i.element),
        truncated: offset + shown.length < all.length,
        ...(pending.length > 0 ? { framesPending: pending } : {}),
        ...(image ? { image } : {}),
      },
      record,
    }
  }
}

/**
 * 一份文档快照里还没法采的帧。主文档与每个跨站子会话的文档各过一遍，见 `scanFrames`。
 *
 * 三个条件同时成立才算：`src` 指着一个地址、这一帧没有已就绪的子会话、承载的文档
 * 还是 `about:blank`，且它还在往就位走（`settling`，见 `CdpClient.settlingFrames`）。
 * 跨站 iframe 在导航提交前由主进程承载一个空白占位帧，提交之后才换成独立目标并附上
 * 子会话——这段窗口里它在 DOM 里看得见、采集却什么都拿不到。
 *
 * **`settling` 这一条不能省。** 页面自己推迟的帧（`loading="lazy"` 尚未触发）在快照里
 * 与正在导航的帧完全同形：都是一个 `about:blank` 空文档，按形状判分不开。少了这一条，
 * 一页上每个延迟加载的帧每次观察都被算成未就位，观察白等满 `FRAME_ATTACH_TOTAL_MS`，
 * 而它们等到天亮也不会提交。实测：css-tricks 的 flexbox 指南里 18 个 `loading="lazy"`
 * 的 codepen 嵌入帧就是这样，每次观察固定多花 2 秒，`framesPending` 每次都报同一批。
 *
 * **不要改用 `Page.getFrameTree` 核对帧在不在**：页会话的帧树里只有本进程的帧，
 * 已经提交的跨站帧不在其中，按它核会把正常的帧判成缺失。
 */
function pendingFrames(root: DomNode, ready: Set<string>, settling: ReadonlySet<string>): string[] {
  const out: string[] = []
  const walk = (node: DomNode): void => {
    if (node.nodeName.toLowerCase() === 'iframe') {
      const frame = node.frameId
      // 取不到帧编号的帧本来就不进元素表，见 splitDocs。
      if (frame !== undefined && !ready.has(frame) && settling.has(frame)) {
        const flat = node.attributes ?? []
        let src = ''
        for (let i = 0; i + 1 < flat.length; i += 2) {
          if (flat[i] === 'src') src = flat[i + 1] as string
        }
        const inner = node.contentDocument
        const blank = inner === undefined || inner.documentURL === BLANK_URL
        if (src !== '' && src !== BLANK_URL && blank) out.push(frame)
      }
    }
    for (const child of node.children ?? []) walk(child)
    for (const shadow of node.shadowRoots ?? []) walk(shadow)
    if (node.contentDocument) walk(node.contentDocument)
  }
  walk(root)
  return out
}

/** 一个会话的一次 DOM 快照。`pierce` 穿透影子根与同进程 iframe。 */
async function snapshot(
  client: CdpClient,
  sessionId: string,
  deadline: number,
  capMs: number,
): Promise<DomNode> {
  const dom = await client.send<{ root: DomNode }>(
    'DOM.getDocument',
    { depth: -1, pierce: true },
    { sessionId, ...within(deadline, capMs) },
  )
  return dom.root
}

/**
 * 扫一遍还没法采的帧：主文档与每个已就位的跨站子会话各取一次快照，各自判自己文档里的 iframe。
 *
 * **只看主文档快照判不到嵌套的那一层。** `pierce` 穿不过渲染进程边界，跨站子帧的文档
 * 不在主文档快照里；嵌套在它里面那个尚未提交的帧因此既不会被等，也不会进 `framesPending`，
 * 观察静默少掉整层元素。子会话答不出快照时跳过它这一轮——一个不答的帧不该拖住整页观察。
 *
 * 快照一并回给调用方复用：采集与这次判定用同一份，不为同一个会话取两遍。
 */
async function scanFrames(
  client: CdpClient,
  sessionId: string,
  deadline: number,
): Promise<{ shots: Map<string, DomNode>; pending: string[] }> {
  const children = client.childSessionsOf(sessionId)
  const ready = new Set(children.map((c) => c.targetId))
  const shots = new Map<string, DomNode>()
  const settling = client.settlingFrames(sessionId)
  const root = await snapshot(client, sessionId, deadline, COLLECT_TIMEOUT_MS)
  shots.set(sessionId, root)
  const pending = pendingFrames(root, ready, settling)
  for (const child of children) {
    const doc = await snapshot(client, child.sessionId, deadline, FRAME_TIMEOUT_MS).catch(
      (err: unknown) => {
        log.warn('browser', `子帧快照跳过：${err instanceof Error ? err.message : String(err)}`)
        return null
      },
    )
    if (!doc) continue
    shots.set(child.sessionId, doc)
    pending.push(...pendingFrames(doc, ready, settling))
  }
  return { shots, pending }
}

/**
 * 主文档与在范围内的子帧各采一次，合成一张元素表。
 *
 * 未就位的跨站帧先等，等不到就连同编号一起报出来（`pending`），不当作这一页没有这一帧。
 */
async function collectAll(
  client: CdpClient,
  sessionId: string,
  opts: { frame?: string },
  deadline: number,
): Promise<{ items: { element: BrowserElement; ref: RefRecord }[]; pending: string[] }> {
  // 指定了帧就只等那一帧：别的帧没就位不该拖住「只看这个 iframe」。
  const inScope = (frames: string[]) =>
    opts.frame ? frames.filter((f) => f === opts.frame) : frames
  // 点名的跨站帧已经就位时这一次不扫：那几份快照这次用不上，取它们只消耗预算。
  const onReadyFrame =
    opts.frame !== undefined &&
    client.childSessionsOf(sessionId).some((c) => c.targetId === opts.frame)
  let scan = { shots: new Map<string, DomNode>(), pending: [] as string[] }
  if (!onReadyFrame) {
    scan = await scanFrames(client, sessionId, deadline)
    // 重查共用这一份预算，不为每一层帧各给满额度。
    const until = Math.min(deadline, Date.now() + FRAME_ATTACH_TOTAL_MS)
    while (inScope(scan.pending).length > 0 && leftMs(until) > 0) {
      await sleep(Math.min(FRAME_ATTACH_INTERVAL_MS, leftMs(until)))
      scan = await scanFrames(client, sessionId, deadline)
    }
  }
  const pending = inScope(scan.pending)

  const sessions: { sessionId: string; frame?: string }[] = [{ sessionId }]
  for (const child of client.childSessionsOf(sessionId)) {
    sessions.push({ sessionId: child.sessionId, frame: child.targetId })
  }
  // 指定的是某个跨站帧时只问它那一个会话；同进程帧的编号看不出属于哪个会话，全问一遍。
  const named = opts.frame ? sessions.find((s) => s.frame === opts.frame) : undefined
  const scope = named ? [named] : sessions

  const all: { element: BrowserElement; ref: RefRecord }[] = []
  for (const s of scope) {
    const shot = scan.shots.get(s.sessionId)
    if (s.frame === undefined) {
      all.push(...(await collectSession(client, s, deadline, COLLECT_TIMEOUT_MS, shot)))
      continue
    }
    // 跨站子帧由它自己的渲染进程应答，正在加载或已经消失时会一直不回。
    // 一个帧不答不该让整页观察不出来——跳过它，主文档照常给出元素表。
    try {
      all.push(...(await collectSession(client, s, deadline, FRAME_TIMEOUT_MS, shot)))
    } catch (err) {
      log.warn('browser', `子帧观察跳过：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // 指定了帧就只留那一帧的元素——否则「只看这个 iframe」返回的仍是整页。
  const items = opts.frame ? all.filter((i) => i.element.frame === opts.frame) : all
  return { items, pending }
}

/**
 * 一份文档的采集范围。
 *
 * `frame` 是帧编号：跨站帧取它子会话的 targetId，同进程帧取 CDP 的 frameId，
 * 主文档缺席。`owners` 见 `RefRecord.owners`。
 */
type FrameScope = { sessionId: string; frame?: string; owners?: number[] }

/** 编号在筛完之后才发，所以候选里只有除 `ref` 之外的那些字段。 */
interface Candidate {
  actionable: boolean
  element: Omit<BrowserElement, 'ref'>
  ref: RefRecord
}

/**
 * 把一次 `pierce` 快照按文档拆开。
 *
 * **同进程 iframe 必须单独成一份。** `pierce` 把它的 `contentDocument` 一并带回来，
 * 而 `Accessibility.getFullAXTree` 不带 `frameId` 时只覆盖会话的根帧：混在一起的话，
 * 帧内节点对不上任何 AX 行，整个同源 iframe 的内容都产不出候选。
 * 影子根里的内容属于宿主所在的文档，跟着宿主走。跨站 iframe 没有 `contentDocument`，
 * 它由自己的子会话采集。
 */
function splitDocs(
  root: DomNode,
  session: { sessionId: string; frame?: string },
): { scope: FrameScope; nodes: Map<number, DomInfo> }[] {
  const out: { scope: FrameScope; nodes: Map<number, DomInfo> }[] = []
  const walk = (node: DomNode, scope: FrameScope, nodes: Map<number, DomInfo>): void => {
    if (node.nodeType === 1) {
      const attrs: Record<string, string> = {}
      const flat = node.attributes ?? []
      for (let i = 0; i + 1 < flat.length; i += 2) attrs[flat[i] as string] = flat[i + 1] as string
      nodes.set(node.backendNodeId, { tag: node.nodeName.toLowerCase(), attrs })
    } else if (node.nodeType === 3) {
      nodes.set(node.backendNodeId, { tag: '#text', attrs: {}, text: node.nodeValue ?? '' })
    }
    for (const child of node.children ?? []) walk(child, scope, nodes)
    for (const shadow of node.shadowRoots ?? []) walk(shadow, scope, nodes)
    for (const pseudo of node.pseudoElements ?? []) walk(pseudo, scope, nodes)
    const inner = node.contentDocument
    if (!inner) return
    const frame = node.frameId ?? inner.frameId
    // 取不到帧编号就取不到这一帧的 AX 树；层数超过上限时坐标也换算不到顶层。
    // 两种情况下这一帧不进元素表，主文档照常给出它自己的。
    if (frame === undefined) return
    if ((scope.owners?.length ?? 0) >= MAX_FRAME_DEPTH) return
    const subScope: FrameScope = {
      sessionId: scope.sessionId,
      frame,
      owners: [node.backendNodeId, ...(scope.owners ?? [])],
    }
    const subNodes = new Map<number, DomInfo>()
    out.push({ scope: subScope, nodes: subNodes })
    walk(inner, subScope, subNodes)
  }
  const rootScope: FrameScope = {
    sessionId: session.sessionId,
    ...(session.frame === undefined ? {} : { frame: session.frame }),
  }
  const rootNodes = new Map<number, DomInfo>()
  out.push({ scope: rootScope, nodes: rootNodes })
  walk(root, rootScope, rootNodes)
  return out
}

/**
 * 一个会话里的全部文档。DOM 快照一次取回，AX 树按帧各取一次，按 backendNodeId 对上。
 *
 * `root` 是调用方已经取过的这一会话的快照，给了就不再重取。
 *
 * 同进程帧不套 AX 重取：它与根文档共用这一次 DOM 快照与本阶段预算，重取一遍等于
 * 把每个 iframe 的等待叠加到同一份预算上。这一帧的 AX 还没建起来时它不进元素表，
 * 重新观察即取得。
 */
async function collectSession(
  client: CdpClient,
  session: { sessionId: string; frame?: string },
  deadline: number,
  capMs: number,
  root?: DomNode,
): Promise<{ element: BrowserElement; ref: RefRecord }[]> {
  const { sessionId } = session
  const limit = () => within(deadline, capMs)
  // pierce 穿透 shadow root 与同进程 iframe；跨站 iframe 另走它自己的会话。
  const doc =
    root ??
    (
      await client.send<{ root: DomNode }>(
        'DOM.getDocument',
        { depth: -1, pierce: true },
        { sessionId, ...limit() },
      )
    ).root
  const docs = splitDocs(doc, session)

  const fetchAx = async (frameId?: string) =>
    (
      await client.send<{ nodes: AxNode[] }>(
        'Accessibility.getFullAXTree',
        frameId === undefined ? {} : { frameId },
        { sessionId, ...limit() },
      )
    ).nodes

  const out: { element: BrowserElement; ref: RefRecord }[] = []
  for (const doc of docs) {
    const sub = doc.scope.owners !== undefined
    if (sub) {
      const nodes = await fetchAx(doc.scope.frame).catch((err: unknown) => {
        log.warn('browser', `同进程帧观察跳过：${err instanceof Error ? err.message : String(err)}`)
        return null
      })
      if (nodes) out.push(...dedupeAndNumber(axCandidates(nodes, doc.nodes, doc.scope), doc.scope))
      continue
    }
    let candidates = axCandidates(await fetchAx(), doc.nodes, doc.scope)
    /*
     * AX 树懒计算：主文档刚加载完可能仍为空，静态表单因此也返回 0 候选。
     * DOM 里有可交互元素却 0 候选时，短间隔重取 AX 树，非空即用；到上限仍空就从
     * DOM 快照直接产元素表（语义降级但不为 0）。子帧不套——它自带超时与跳过。
     * 重取也吃总预算：本阶段上限与剩余预算取小，到期就用手上的结果。
     */
    if (session.frame === undefined && candidates.length === 0 && domHasActionable(doc.nodes)) {
      const until = Math.min(deadline, Date.now() + AX_RETRY_TOTAL_MS)
      while (candidates.length === 0 && leftMs(until) > 0) {
        await sleep(Math.min(AX_RETRY_INTERVAL_MS, leftMs(until)))
        candidates = axCandidates(await fetchAx(), doc.nodes, doc.scope)
      }
      if (candidates.length === 0) candidates = domCandidates(doc.nodes, doc.scope)
    }
    out.push(...dedupeAndNumber(candidates, doc.scope))
  }
  return out
}

/** 从 AX 树建候选：AX 给角色 / 名称 / 状态，DOM 给标签与属性。 */
function axCandidates(
  nodes: AxNode[],
  byBackend: Map<number, DomInfo>,
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
        name,
        tag,
        ...(attrs.type ? { inputType: attrs.type } : {}),
        ...(value !== undefined ? { value: String(value) } : {}),
        ...(props.get('checked') !== undefined ? { checked: props.get('checked') === 'true' } : {}),
        // expanded / selected 缺席即这个角色没有这一项，补 false 会把「没有这一项」
        // 说成「收起」「未选中」。
        ...boolProp(props, 'expanded'),
        ...boolProp(props, 'selected'),
        ...(props.get('disabled') === true ? { disabled: true } : {}),
        ...(frame.frame ? { frame: frame.frame } : {}),
      },
      ref: {
        backendNodeId,
        sessionId: frame.sessionId,
        ...(frame.frame ? { frame: frame.frame } : {}),
        ...(frame.owners ? { owners: frame.owners } : {}),
        actionable,
        identity:
          domInfo?.text !== undefined
            ? `#text|${domInfo.text}`
            : [tag, attrs.id ?? '', attrs.name ?? '', attrs.type ?? ''].join('|'),
      },
    })
  }
  return candidates
}

/**
 * 按 AX 的实际布尔取一项状态。
 *
 * 缺席、或值不是布尔时不写这一项：`expanded` 只在可展开的角色上存在，
 * 补一个 false 等于说它是收起的。
 */
function boolProp(
  props: Map<string, unknown>,
  name: 'expanded' | 'selected',
): Record<string, boolean> {
  const raw = props.get(name)
  if (raw === true || raw === 'true') return { [name]: true }
  if (raw === false || raw === 'false') return { [name]: false }
  return {}
}

/** DOM 快照中是否存在可交互元素。AX 树没建起来时靠它判断该不该重取。 */
function domHasActionable(byBackend: Map<number, DomInfo>): boolean {
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
function domCandidates(byBackend: Map<number, DomInfo>, frame: FrameScope): Candidate[] {
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
        name,
        tag,
        ...(attrs.type ? { inputType: attrs.type } : {}),
        ...(attrs.value !== undefined ? { value: attrs.value } : {}),
        ...(frame.frame ? { frame: frame.frame } : {}),
      },
      ref: {
        backendNodeId,
        sessionId: frame.sessionId,
        ...(frame.frame ? { frame: frame.frame } : {}),
        ...(frame.owners ? { owners: frame.owners } : {}),
        actionable: true,
        identity: [tag, attrs.id ?? '', attrs.name ?? '', attrs.type ?? ''].join('|'),
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

/**
 * 给这一页要返回的 select 补一份当前选项摘要。
 *
 * 只给实际返回的那些 select 采：没进这一页元素表的 select 采了也传不出去。
 * 合计上限用尽之后仍读一次总数（limit 取 0），让调用方知道要用 `optionsFor` 继续读
 * ——摘要缺席与「这个 select 没有选项」必须能分开。单个 select 读失败时整项不写，
 * 不写成空选项表。
 */
async function attachOptions(
  client: CdpClient,
  shown: { element: BrowserElement; ref: RefRecord }[],
  deadline: number,
): Promise<void> {
  let used = 0
  for (const item of shown) {
    if (item.element.tag !== 'select') continue
    if (leftMs(deadline) <= 0) return
    const limit = Math.max(0, Math.min(MAX_SELECT_OPTIONS, MAX_OBSERVATION_OPTIONS - used))
    const subject = `元素 ${item.element.ref}`
    const read = await readOptionsOf(client, item.ref, 0, limit, deadline, subject).catch((err) => {
      log.warn('browser', `选项摘要跳过：${err instanceof Error ? err.message : String(err)}`)
      return null
    })
    if (!read) continue
    used += read.items.length
    item.element = {
      ...item.element,
      ...(read.items.length > 0 ? { options: read.items } : {}),
      optionsTotal: read.total,
      ...(read.items.length < read.total ? { optionsTruncated: true } : {}),
    }
  }
}

/**
 * 给这一页要返回的 canvas 补上此刻的 CSS 像素尺寸，即指针动作 `point` 的取值范围。
 *
 * 只给 canvas：它的落点只能靠坐标区分，别的元素点中心就够。量不出（`display: none`）时
 * 整项不写，不写成 0。
 */
async function attachSizes(
  client: CdpClient,
  shown: { element: BrowserElement; ref: RefRecord }[],
  deadline: number,
): Promise<void> {
  for (const item of shown) {
    if (item.element.tag !== 'canvas') continue
    if (leftMs(deadline) <= 0) return
    const box = await client
      .send<{ model: { width: number; height: number } }>(
        'DOM.getBoxModel',
        { backendNodeId: item.ref.backendNodeId },
        { sessionId: item.ref.sessionId, ...within(deadline, COLLECT_TIMEOUT_MS) },
      )
      .catch(() => null)
    if (!box) continue
    item.element = {
      ...item.element,
      size: { width: Math.round(box.model.width), height: Math.round(box.model.height) },
    }
  }
}

/** 按引用记录解析出节点再读一段选项。`limit` 为 0 时只取总数。 */
async function readOptionsOf(
  client: CdpClient,
  entry: RefRecord,
  offset: number,
  limit: number,
  deadline: number,
  subject: string,
): Promise<{ items: BrowserSelectOption[]; total: number }> {
  const resolved = await client.send<{ object: { objectId?: string } }>(
    'DOM.resolveNode',
    { backendNodeId: entry.backendNodeId },
    { sessionId: entry.sessionId, ...within(deadline, COLLECT_TIMEOUT_MS) },
  )
  const objectId = resolved.object.objectId
  if (!objectId) throw new BrowserStaleRefError(`${subject} 已经不在页面上，请重新观察`)
  const r = await client.send<{
    result: { value: { ok: boolean; total?: number; items?: BrowserSelectOption[] } }
  }>(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: OPTIONS_FN,
      arguments: [{ value: offset }, { value: limit }],
      returnByValue: true,
    },
    { sessionId: entry.sessionId, ...within(deadline, COLLECT_TIMEOUT_MS) },
  )
  if (!r.result.value.ok) throw new CdpError(`${subject} 不是选择框`)
  return { items: r.result.value.items ?? [], total: r.result.value.total ?? 0 }
}

/**
 * 读一个 select 的一页选项。
 *
 * 按旧观察定位、实时读取：不采新观察、不发新编号、不滚动页面。选项在两次读取之间
 * 增删时页与页拼不成一份快照，调用方按 `total` 重读。
 */
export async function readSelectOptions(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
  offset: number,
): Promise<BrowserOptionsPage> {
  await assertDoc(page, record)
  // 深度读取与一次观察共用同一份预算，不让每个 select 各拿一份满额度。
  const deadline = Date.now() + OBSERVE_BUDGET_MS
  const { entry } = await resolveRef(page, record, ref, deadline)
  const read = await readOptionsOf(
    page.client,
    entry,
    offset,
    MAX_SELECT_OPTIONS,
    deadline,
    `元素 ${ref}`,
  )
  const next = offset + read.items.length
  return {
    tabId: page.tabId,
    observationId: record.observationId,
    ref,
    items: read.items,
    total: read.total,
    offset,
    ...(next < read.total ? { nextOffset: next } : {}),
  }
}

async function capture(
  client: CdpClient,
  sessionId: string,
  deadline: number,
): Promise<{ data: string; mime: string } | null> {
  for (const quality of [60, 35]) {
    if (leftMs(deadline) <= 0) return null
    const shot = await client.send<{ data: string }>(
      'Page.captureScreenshot',
      { format: 'jpeg', quality },
      { sessionId, ...within(deadline, SHOT_TIMEOUT_MS) },
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
  /** 指定的落点在元素此刻的矩形内。没指定落点时恒为真。 */
  inBox?: boolean
  /** 落点在本文档视口内。跨站 iframe 还要逐层核父文档。 */
  inView?: boolean
  sameTree?: boolean
  hit?: string | null
  /** 命中到的那个元素的名称摘要，取 `aria-label` 或可取得文本，有界。 */
  hitLabel?: string
  disabled?: boolean
  /** 目标自己的名称摘要，取 `aria-label`、可取得文本或标签名，有界。动作回执的 `element` 取它。 */
  label?: string
}

/** 一层帧的换算结果：点已经在父文档坐标系里，命中字段说的是这一层。 */
interface FramePoint {
  x: number
  y: number
  width?: number
  height?: number
  inView?: boolean
  sameTree?: boolean
  hit?: string | null
  hitLabel?: string
}

/** 名称、正文摘要、当前值任一包含查询串即命中，不分大小写。角色与标签不参与：它们不是页面上的字。 */
function matchesQuery(element: BrowserElement, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [element.name, element.text, element.value].some(
    (field) => typeof field === 'string' && field.toLowerCase().includes(needle),
  )
}

/**
 * 核对这次观察仍是当前文档。
 *
 * 每条动作路径的第一步都是它，**不放在 `resolveRef` 里**：不带 ref 的 press 与 scroll
 * 不解析节点，放在那里它们就带着一份跨文档的旧观察打到新页面上。
 */
async function assertDoc(page: PageHandle, record: ObservationRecord): Promise<void> {
  const doc = await readDocument(page)
  if (doc.token !== record.docToken) {
    throw new BrowserStaleRefError('页面已经换过文档，这次观察的元素编号全部失效，请重新观察')
  }
}

/**
 * 把一个 ref 解析成可操作的节点。
 *
 * 节点连接状态与身份指纹都过才算命中；任一不符按失效返回，要求重新观察。
 * **不做「按名字再找一个」的重定位**——那会把点击落在另一个同名按钮上。
 * 文档令牌由调用方先过 `assertDoc`。
 */
async function resolveRef(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
  deadline = Date.now() + PREPARE_BUDGET_MS,
  point?: BrowserPoint,
  pointer = false,
): Promise<{ entry: RefRecord; objectId: string; inspect: Inspection }> {
  const { client } = page
  const entry = record.refs.get(ref)
  if (!entry) throw new BrowserStaleRefError(`这次观察里没有元素 ${ref}，请重新观察`)
  if (!entry.actionable && !pointer) {
    throw new CdpError(`元素 ${ref} 是正文，不支持控件操作；可使用指针动作点击文字`)
  }

  const resolved = await client
    .send<{ object: { objectId?: string } }>(
      'DOM.resolveNode',
      { backendNodeId: entry.backendNodeId },
      { sessionId: entry.sessionId, ...within(deadline, PREPARE_TIMEOUT_MS) },
    )
    .catch(() => null)
  const objectId = resolved?.object.objectId
  if (!objectId) throw new BrowserStaleRefError(`元素 ${ref} 已经不在页面上，请重新观察`)

  const inspect = await inspectNode(client, entry.sessionId, objectId, ref, deadline, point)
  assertSameNode(ref, entry, inspect, '')
  return { entry, objectId, inspect }
}

/**
 * 页内复核一次：矩形、可视区、命中点与身份指纹都取此刻的值。给了 `point` 时量那一点，
 * 否则量中心。
 *
 * 页内抛异常时 `returnByValue` 下的 `result.value` 是 `undefined`，**必须在这里结掉**：
 * 直接返回的话，下一步解引用它会以一句内部异常原文结束，而那句话对调用方没有下一步。
 */
async function inspectNode(
  client: CdpClient,
  sessionId: string,
  objectId: string,
  ref: string,
  deadline: number,
  point?: BrowserPoint,
): Promise<Inspection> {
  const inspected = await client.send<{
    result: { value?: Inspection }
    exceptionDetails?: unknown
  }>(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: INSPECT_FN,
      ...(point ? { arguments: [{ value: point.x }, { value: point.y }] } : {}),
      returnByValue: true,
    },
    { sessionId, ...within(deadline, PREPARE_TIMEOUT_MS) },
  )
  const view = inspected.result.value
  if (inspected.exceptionDetails !== undefined || typeof view !== 'object' || view === null) {
    throw new BrowserStaleRefError(`元素 ${ref} 无法在页内定位，请重新观察`)
  }
  return view
}

/** 节点还是不是原来那一个。`when` 说明这次复核发生在哪一步。 */
function assertSameNode(ref: string, entry: RefRecord, inspect: Inspection, when: string): void {
  if (!inspect.connected) {
    throw new BrowserStaleRefError(`元素 ${ref} ${when}已从文档中移除，请重新观察`)
  }
  if (inspect.identity !== entry.identity) {
    throw new BrowserStaleRefError(`元素 ${ref} ${when}指向的已经是另一个节点，请重新观察`)
  }
}

/**
 * 坐标动作的准备：核身份 → 按需滚入可视区 → 重新量取矩形与整条帧链 → 在实际输入
 * 坐标系里复核命中 → 交给调用方发事件。
 *
 * **坐标一律现取**，不用观察时记下的帧偏移：父页滚过之后那份偏移指的是另一个位置。
 * 查不到父帧的 owner 或盒子就判定位失败，不补零——补零会把事件发到页面左上角。
 * 滚动只发一次并重量一次，布局持续变化时按准备预算退出。
 *
 * `scroll` 为假只重新量取，不动页面（观察与读选项按它调用）；`hit` 为假不做
 * 可命中裁决，只要坐标（滚动到元素上这类动作按落点发事件即可）。`deadline` 缺省时
 * 自带一份准备预算，多事件动作传自己的绝对期限进来，不另起一份时钟。`point` 是元素内的
 * 落点，缺省取中心。
 */
async function prepareAction(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
  opts: { scroll: boolean; hit: boolean; deadline?: number; point?: BrowserPoint },
): Promise<{ entry: RefRecord; objectId: string; inspect: Inspection; point: Point }> {
  const deadline = opts.deadline ?? Date.now() + PREPARE_BUDGET_MS
  const { client } = page
  const { entry, objectId, inspect } = await resolveRef(
    page,
    record,
    ref,
    deadline,
    opts.point,
    true,
  )
  let view = inspect
  if (opts.scroll && (await scrollIntoView(client, entry, objectId, view, deadline))) {
    view = await inspectNode(client, entry.sessionId, objectId, ref, deadline, opts.point)
    assertSameNode(ref, entry, view, '滚动后')
  }
  if (opts.point && view.inBox === false) throw outsideBox(ref, opts.point, view)
  if (opts.hit && view.disabled === true) throw new CdpError(`元素 ${ref} 当前不可用`)
  if (opts.hit) assertHittable(`元素 ${ref}`, view)
  const point = await toInputPoint(page, entry, view, ref, deadline, opts.hit)
  return { entry, objectId, inspect: view, point }
}

/** 落点不在元素此刻的矩形里。给出此刻的尺寸，调用方据此换一个点。 */
function outsideBox(ref: string, point: BrowserPoint, view: Inspection): CdpError {
  const w = Math.round(view.width ?? 0)
  const h = Math.round(view.height ?? 0)
  return new CdpError(
    `元素 ${ref} 上的点 (${point.x}, ${point.y}) 超出元素范围，它此刻宽 ${w}、高 ${h}`,
  )
}

/**
 * 需要时把元素滚进可视区，返回是否真的发了滚动命令。
 *
 * 跨站 iframe 里的元素一律滚一次：帧内可见不代表这个帧在父页的可视区内，而把父页带上
 * 通过 CDP 滚动原节点，文本节点和元素共用这一条路径，不改点父容器。
 */
async function scrollIntoView(
  client: CdpClient,
  entry: RefRecord,
  objectId: string,
  view: Inspection,
  deadline: number,
): Promise<boolean> {
  if (entry.frame === undefined && view.inView === true && view.sameTree === true) return false
  await client.send(
    'DOM.scrollIntoViewIfNeeded',
    { objectId },
    { sessionId: entry.sessionId, ...within(deadline, PREPARE_TIMEOUT_MS) },
  )
  return true
}

/**
 * 把元素在自己文档里的中心点换算成页会话的输入坐标。
 *
 * 主文档的点不用换算。有帧的逐层向上：同进程帧的一跳按登记的 iframe 节点在同一个会话里
 * 现取盒子，跨站帧的一跳跨会话找承载它的文档。每换算一层就在那一层复核命中，
 * 父层遮罩因此拦得住。任一层查不到就抛失效，不继续用一个半成品坐标。
 */
async function toInputPoint(
  page: PageHandle,
  entry: RefRecord,
  view: Inspection,
  ref: string,
  deadline: number,
  requireHit: boolean,
): Promise<Point> {
  let point: Point = { x: view.x ?? 0, y: view.y ?? 0 }
  for (const owner of entry.owners ?? []) {
    if (leftMs(deadline) <= 0) {
      throw new BrowserAmbiguousRefError(`元素 ${ref} 的坐标没能在动作期限内量定，请重新观察`)
    }
    const mapped = await ownerHop(page.client, entry.sessionId, owner, point, ref, deadline)
    if (requireHit) assertHittable(`元素 ${ref} 所在的 iframe`, mapped)
    point = { x: mapped.x, y: mapped.y }
  }
  // 跨站帧的起点是元素所在子会话对应的那一帧；同进程帧的换算上面已经走完。
  let frame = page.client
    .childSessionsOf(page.sessionId)
    .find((c) => c.sessionId === entry.sessionId)?.targetId
  for (let depth = 0; frame; depth += 1) {
    if (depth >= MAX_FRAME_DEPTH) {
      throw new BrowserStaleRefError(`元素 ${ref} 的帧层数超过上限，无法定位，请重新观察`)
    }
    if (leftMs(deadline) <= 0) {
      throw new BrowserAmbiguousRefError(`元素 ${ref} 的坐标没能在动作期限内量定，请重新观察`)
    }
    const hop = await frameHop(page, frame, point, ref, deadline)
    if (requireHit) assertHittable(`元素 ${ref} 所在的 iframe`, hop.mapped)
    point = { x: hop.mapped.x, y: hop.mapped.y }
    frame = hop.parentFrame
  }
  return point
}

/**
 * 走一层同进程帧：承载它的 iframe 元素与它在同一个会话里，按登记的节点号取回来换算。
 *
 * 节点已经不在时判定位失败，不补零——补零会把事件发到文档左上角。
 */
async function ownerHop(
  client: CdpClient,
  sessionId: string,
  backendNodeId: number,
  point: Point,
  ref: string,
  deadline: number,
): Promise<FramePoint> {
  const resolved = await client
    .send<{ object: { objectId?: string } }>(
      'DOM.resolveNode',
      { backendNodeId },
      { sessionId, ...within(deadline, PREPARE_TIMEOUT_MS) },
    )
    .catch(() => null)
  const objectId = resolved?.object.objectId
  if (!objectId) {
    throw new BrowserStaleRefError(`元素 ${ref} 所在的 iframe 已经不在页面上，请重新观察`)
  }
  const mapped = await client.send<{ result: { value: FramePoint } }>(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: FRAME_POINT_FN,
      arguments: [{ value: point.x }, { value: point.y }],
      returnByValue: true,
    },
    { sessionId, ...within(deadline, PREPARE_TIMEOUT_MS) },
  )
  return mapped.result.value
}

/**
 * 走一层跨站帧：找到承载这一帧的文档，把点换算过去。
 *
 * 父文档按试探定位：`DOM.getFrameOwner` 只在这一帧的父会话里答得出来，页会话先试，
 * 不中再试其余子会话——嵌套的跨站 iframe 的父文档也是一个子会话。
 */
async function frameHop(
  page: PageHandle,
  frame: string,
  point: Point,
  ref: string,
  deadline: number,
): Promise<{ mapped: FramePoint; parentFrame: string | undefined }> {
  const { client } = page
  const children = client.childSessionsOf(page.sessionId)
  const candidates: { sessionId: string; frame?: string }[] = [
    { sessionId: page.sessionId },
    ...children
      .filter((c) => c.targetId !== frame)
      .map((c) => ({ sessionId: c.sessionId, frame: c.targetId })),
  ]
  for (const candidate of candidates) {
    const owner = await client
      .send<{ backendNodeId: number }>(
        'DOM.getFrameOwner',
        { frameId: frame },
        { sessionId: candidate.sessionId, ...within(deadline, PREPARE_TIMEOUT_MS) },
      )
      .catch(() => null)
    if (!owner) continue
    const resolved = await client
      .send<{ object: { objectId?: string } }>(
        'DOM.resolveNode',
        { backendNodeId: owner.backendNodeId },
        { sessionId: candidate.sessionId, ...within(deadline, PREPARE_TIMEOUT_MS) },
      )
      .catch(() => null)
    const objectId = resolved?.object.objectId
    if (!objectId) break
    const mapped = await client.send<{ result: { value: FramePoint } }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: FRAME_POINT_FN,
        arguments: [{ value: point.x }, { value: point.y }],
        returnByValue: true,
      },
      { sessionId: candidate.sessionId, ...within(deadline, PREPARE_TIMEOUT_MS) },
    )
    return { mapped: mapped.result.value, parentFrame: candidate.frame }
  }
  throw new BrowserStaleRefError(`元素 ${ref} 所在的 iframe 已经不在页面上，请重新观察`)
}

/**
 * 命中裁决。视口外、零尺寸、被遮各自成句，不一律叫被遮——三者的下一步不一样。
 *
 * 在动作准备的最后一步调用：滚动已经做过，这时仍命中别的元素才是遮挡。
 */
function assertHittable(subject: string, view: Inspection | FramePoint): void {
  if (view.width === 0 || view.height === 0) {
    throw new BrowserAmbiguousRefError(`${subject} 当前尺寸为 0，无法在它上面发事件，请重新观察`)
  }
  if (view.inView !== true) {
    throw new BrowserAmbiguousRefError(`${subject} 滚动后仍在可视区外，请重新观察`)
  }
  if (view.sameTree !== true) {
    const hit = view.hit ? `${view.hit}${view.hitLabel ? `（${view.hitLabel}）` : ''}` : '空白'
    throw new BrowserAmbiguousRefError(`${subject} 的命中点落在 ${hit} 上，请重新观察`)
  }
}

/**
 * 在已观察的元素上做一次有限动作，返回动作回执。
 *
 * 动作之后的观察由协调器补，这里不采。
 *
 * **发出第一个事件之前的失败一律抛错**：参数不合、引用失效、命中不成立都属于没有动过
 * 页面。已经发出事件之后不再抛错，改为在回执的 `execution` 里如实给出已确认的单元数
 * ——那时页面可能已经变了，抛异常会让调用方按「没执行」重放。
 */
export async function actOnPage(
  page: PageHandle,
  record: ObservationRecord,
  input: BrowserActInput,
): Promise<BrowserActReceipt> {
  const { client, sessionId } = page
  await assertDoc(page, record)

  if (input.action === 'press') return pressOnPage(page, record, input.ref, input.phases ?? [])
  if (input.action === 'scroll') return scrollOnPage(page, record, input)
  if (!input.ref) throw new CdpError(`${input.action} 需要元素引用`)
  const ref = input.ref

  switch (input.action) {
    case 'click':
    case 'rightclick':
      return clickOnPage(page, record, ref, input, input.action === 'click' ? 'left' : 'right')
    case 'hover': {
      const { inspect, point } = await prepareAction(page, record, ref, {
        scroll: true,
        hit: true,
        ...(input.point ? { point: input.point } : {}),
      })
      // 只移动，不按下。悬停层什么时候出现由页面决定，动作之后的观察采到什么就是什么。
      await aimAt(client, sessionId, point, 0)
      return { element: inspect.label ?? ref, point }
    }
    case 'dblclick':
      return doubleClickOnPage(page, record, ref, input)
    case 'drag':
      return dragOnPage(page, record, ref, input)
    case 'type':
      return typeOnPage(page, record, ref, input.text ?? '')
    case 'fill':
      return fillOnPage(page, record, ref, input.text ?? '')
    case 'select': {
      const { entry, objectId, inspect } = await resolveRef(page, record, ref)
      const r = await client.send<{
        result: {
          value: {
            ok: boolean
            reason?: string
            total?: number
            sample?: string[]
            label?: string
          }
        }
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
      if (!value.ok) throw selectFailure(ref, input.text ?? '', value)
      return { element: inspect.label ?? ref }
    }
  }
}

/**
 * 滚轮。给了 ref 时在元素的落点上滚，否则在页面左上角附近滚；两个方向都没给时向下 400。
 *
 * 落点不做可命中裁决：滚轮事件打在被遮住的位置上一样滚得动。
 */
async function scrollOnPage(
  page: PageHandle,
  record: ObservationRecord,
  input: BrowserActInput,
): Promise<BrowserActReceipt> {
  const { client, sessionId } = page
  const deltaX = input.deltaX ?? 0
  const deltaY = input.deltaY ?? (input.deltaX === undefined ? 400 : 0)
  const target = input.ref
    ? await prepareAction(page, record, input.ref, {
        scroll: false,
        hit: false,
        ...(input.point ? { point: input.point } : {}),
      })
    : null
  const at = target?.point ?? { x: 10, y: 10 }
  await client.send(
    'Input.dispatchMouseEvent',
    { type: 'mouseWheel', x: at.x, y: at.y, deltaX, deltaY, button: 'none' },
    { sessionId },
  )
  if (!target || !input.ref) return {}
  return { element: target.inspect.label ?? input.ref, point: target.point }
}

/**
 * 选不中时的失败说明。
 *
 * 带总数与有界样例，并给出继续读取的出口；**不回完整选项表**，长列表会把整份工具
 * 输出撑掉。
 */
function selectFailure(
  ref: string,
  wanted: string,
  value: { reason?: string; total?: number; sample?: string[]; label?: string },
): CdpError {
  if (value.reason === 'no_option') {
    const sample = (value.sample ?? []).join('、')
    return new CdpError(
      `没有这个选项：${wanted}（共 ${value.total ?? 0} 项` +
        (sample ? `，前几项：${sample}` : '') +
        `；用 optionsFor 按 ${ref} 读取全部选项）`,
    )
  }
  if (value.reason === 'option_disabled') {
    return new CdpError(`选项 ${value.label ?? wanted} 当前不可选`)
  }
  return new CdpError(`元素 ${ref} 不是选择框`)
}

/**
 * 按一段按键计划。给了 ref 时先把焦点放到它上面，按键发到它所在的会话；否则发到页会话，
 * 落在文档此刻的焦点上，不涉及系统前台窗口。
 *
 * 阶段之间核一次文档令牌：换了文档就停，计划的其余部分不落到新页面上。焦点不核——
 * Tab 这类按键本来就会移动焦点。成功、失败、取消都走同一条收尾。
 */
async function pressOnPage(
  page: PageHandle,
  record: ObservationRecord,
  ref: string | undefined,
  phases: BrowserKeyPhase[],
): Promise<BrowserActReceipt> {
  const problem = checkKeyPhases(phases)
  if (problem) throw new CdpError(problem)
  const { client } = page
  const run = new Execution()
  let sessionId = page.sessionId
  let element: string | undefined
  if (ref) {
    const { entry, inspect } = await resolveRef(page, record, ref, run.deadline)
    await client.send(
      'DOM.focus',
      { backendNodeId: entry.backendNodeId },
      { sessionId: entry.sessionId, ...within(run.deadline, PREPARE_TIMEOUT_MS) },
    )
    sessionId = entry.sessionId
    element = inspect.label ?? ref
  }
  const keyboard = new Keyboard(client, sessionId)
  if (await runKeyPhases(keyboard, phases, run, () => documentMoved(page, record, run.deadline))) {
    run.finish()
  }
  await settleInput(client, [sessionId], run)
  return { ...(element === undefined ? {} : { element }), execution: run.receipt() }
}

/** 这份观察的文档还是不是当前文档。换了、或读不到时返回停止原因。 */
async function documentMoved(
  page: PageHandle,
  record: ObservationRecord,
  deadline: number,
): Promise<string | null> {
  const doc = await readDocument(page, within(deadline, PREPARE_TIMEOUT_MS).timeoutMs).catch(
    () => null,
  )
  if (!doc) return '读不到当前文档'
  return doc.token === record.docToken ? null : '页面已经换过文档'
}

/** 指针动作期间按着的键。与预检同一张表，发第一个事件之前判。 */
function heldKeysOf(keys: string[] | undefined): string[] {
  const held = keys ?? []
  const problem = checkHeldKeys(held, 'keys')
  if (problem) throw new CdpError(problem)
  return held
}

/** 指针动作共用的可选参数。 */
type PointerOptions = { point?: BrowserPoint; keys?: string[]; holdMs?: number }

/**
 * 单次点击，可按住一段时间、可同时按着键。右键只换 `button`，定位、滚动与命中说明与左键
 * 同一套。按下与抬起各是一个单元；按住期间被停下时由收尾补 `mouseReleased`。
 */
async function clickOnPage(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
  opts: PointerOptions,
  button: 'left' | 'right',
): Promise<BrowserActReceipt> {
  const keys = heldKeysOf(opts.keys)
  const hold = opts.holdMs ?? 0
  const bad = checkDuration(hold, 'holdMs')
  if (bad) throw new CdpError(bad)
  const { client, sessionId } = page
  const run = new Execution()
  const { inspect, point } = await prepareAction(page, record, ref, {
    scroll: true,
    hit: true,
    deadline: run.deadline,
    ...(opts.point ? { point: opts.point } : {}),
  })
  const keyboard = new Keyboard(client, sessionId)
  const send = (type: 'mousePressed' | 'mouseReleased', buttons: number) =>
    run.run(client, () =>
      mouseEvent(
        client,
        sessionId,
        type,
        point,
        { button, buttons, clickCount: 1, modifiers: keyboard.modifiers },
        run.deadline,
      ),
    )
  const sequence = async (): Promise<boolean> => {
    if (!(await run.run(client, () => keyboard.to(keys, run.deadline)))) return false
    const aimed = await run.run(client, () =>
      aimAt(client, sessionId, point, keyboard.modifiers, run.deadline),
    )
    if (!aimed || !(await send('mousePressed', button === 'right' ? 2 : 1))) return false
    run.unit()
    if (!(await run.hold(client, hold)) || !(await send('mouseReleased', 0))) return false
    run.unit()
    return run.run(client, () => keyboard.to([], run.deadline))
  }
  if (await sequence()) run.finish()
  await settleInput(client, [sessionId], run)
  return { element: inspect.label ?? ref, point, execution: run.receipt() }
}

/**
 * 双击：两轮按下抬起，`clickCount` 依次 1 与 2。
 *
 * 第二轮的 `clickCount: 2` 是浏览器判定 `dblclick` 的依据，两轮都发 `clickCount: 1`
 * 得到的是两次单击。
 */
async function doubleClickOnPage(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
  opts: PointerOptions,
): Promise<BrowserActReceipt> {
  const keys = heldKeysOf(opts.keys)
  const { client, sessionId } = page
  const run = new Execution()
  const { inspect, point } = await prepareAction(page, record, ref, {
    scroll: true,
    hit: true,
    deadline: run.deadline,
    ...(opts.point ? { point: opts.point } : {}),
  })
  const keyboard = new Keyboard(client, sessionId)
  const sequence = async (): Promise<boolean> => {
    if (!(await run.run(client, () => keyboard.to(keys, run.deadline)))) return false
    const aimed = await run.run(client, () =>
      aimAt(client, sessionId, point, keyboard.modifiers, run.deadline),
    )
    if (!aimed) return false
    for (const clickCount of [1, 2]) {
      const sent = await run.run(client, async () => {
        const extra = { button: 'left', clickCount, modifiers: keyboard.modifiers }
        await mouseEvent(
          client,
          sessionId,
          'mousePressed',
          point,
          { ...extra, buttons: 1 },
          run.deadline,
        )
        await mouseEvent(
          client,
          sessionId,
          'mouseReleased',
          point,
          { ...extra, buttons: 0 },
          run.deadline,
        )
      })
      if (!sent) return false
      run.unit()
    }
    return run.run(client, () => keyboard.to([], run.deadline))
  }
  if (await sequence()) run.finish()
  await settleInput(client, [sessionId], run)
  return { element: inspect.label ?? ref, point, execution: run.receipt() }
}

/** `type` 的一个单元：产生一个字符要按下的键，或一个走文本插入的码点。 */
type TypeUnit = { keys: string[] } | { text: string }

/**
 * 归一并切成可发的单元。
 *
 * 整段检完才发第一个事件：发到一半再发现超长的话，前半段已经进了页面，而输入事件
 * 撤不回来。CRLF 与单独的 CR 归一为换行，换行按 Enter 发——单行控件可能因此提交。
 * 布局表里的字符走按键，其余码点走 `Input.insertText`：不给中文造虚拟键码，
 * 也不承诺 IME composition 与完整的 keydown/keyup 链。
 */
function planType(text: string): TypeUnit[] {
  const units: TypeUnit[] = []
  for (const ch of text.replace(/\r\n?/g, '\n')) {
    if (ch === '\n') {
      units.push({ keys: ['Enter'] })
      continue
    }
    if (ch === '\t') {
      units.push({ keys: ['Tab'] })
      continue
    }
    const code = ch.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      const hex = code.toString(16).toUpperCase().padStart(4, '0')
      throw new CdpError(`不能输入控制字符 U+${hex}`)
    }
    const keys = charKeys(ch)
    units.push(keys ? { keys } : { text: ch })
  }
  if (units.length > MAX_TYPE_UNITS) {
    throw new CdpError(`一次最多输入 ${MAX_TYPE_UNITS} 个字符，这次给了 ${units.length} 个`)
  }
  return units
}

/** 目标还在、还是同一个、焦点还在它身上。任一项不成立即停止输入。 */
async function onTypingTarget(
  client: CdpClient,
  entry: RefRecord,
  objectId: string,
  deadline: number,
): Promise<boolean> {
  const read = await client
    .send<{ result: { value: { connected: boolean; identity: string; focused: boolean } } }>(
      'Runtime.callFunctionOn',
      { objectId, functionDeclaration: TYPING_GUARD_FN, returnByValue: true },
      { sessionId: entry.sessionId, ...within(deadline, PREPARE_TIMEOUT_MS) },
    )
    .catch(() => null)
  if (!read) return false
  const view = read.result.value
  return view.connected && view.identity === entry.identity && view.focused
}

/**
 * 逐字输入：聚焦目标后在当前选区输入，**不全选也不清空**，覆盖输入是 `fill` 的事。
 *
 * 每个码点发送前复核目标，节点被替换、移除或焦点转移时立刻停止，不继续发往另一个控件。
 * 默认不加人为延时：需要等异步候选层的应用分段 type 之后自己 wait。按键与 `press` 走
 * 同一个 `Keyboard`：一个码点是一次按下集合再全部抬起。
 */
async function typeOnPage(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
  text: string,
): Promise<BrowserActReceipt> {
  const units = planType(text)
  const { client } = page
  const run = new Execution()
  const { entry, objectId, inspect } = await resolveRef(page, record, ref, run.deadline)
  await client.send(
    'DOM.focus',
    { backendNodeId: entry.backendNodeId },
    { sessionId: entry.sessionId, ...within(run.deadline, PREPARE_TIMEOUT_MS) },
  )
  const keyboard = new Keyboard(client, entry.sessionId)
  const sequence = async (): Promise<boolean> => {
    for (const unit of units) {
      if (!run.open(client)) return false
      if (!(await onTypingTarget(client, entry, objectId, run.deadline))) {
        run.stop('输入目标已被替换、移除或失去焦点')
        return false
      }
      const sent = await run.run(client, async () => {
        if ('text' in unit) {
          // 文本插入发到元素自己的会话：焦点由该帧的渲染进程持有，发到顶层会落在别处。
          await client.send(
            'Input.insertText',
            { text: unit.text },
            { sessionId: entry.sessionId, ...within(run.deadline, EVENT_TIMEOUT_MS) },
          )
          return
        }
        await keyboard.to(unit.keys, run.deadline)
        await keyboard.to([], run.deadline)
      })
      if (!sent) return false
      run.unit()
    }
    return true
  }
  if (await sequence()) run.finish()
  await settleInput(client, [entry.sessionId], run)
  return { element: inspect.label ?? ref, execution: run.receipt() }
}

/** `FILL_FN` 的回包。`ok` 为假时 `reason` 决定给调用方哪一句说明。 */
interface FillOutcome {
  ok: boolean
  reason?: string
  type?: string
  /** 实际读回的值，或预检规范化之后的值。 */
  value?: string
  /** 预检认可的值。回读与它不一致即页面把这次写入改掉了。 */
  wanted?: string
  normalized?: boolean
  /** 控件上写着的 `min` / `max` / `step`，只在约束不满足时给。 */
  limits?: { min?: string; max?: string; step?: string }
}

/**
 * 覆盖输入。预检不通过时原值一个字都没动，回读不一致时如实说页面已经改过。
 *
 * 不发键盘事件：受控组件要的是 `input` / `change`，而日期、颜色这类控件没有可逐字
 * 输入的键序列。逐字交互走 `type`。
 */
async function fillOnPage(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
  text: string,
): Promise<BrowserActReceipt> {
  const { client } = page
  const { entry, objectId, inspect } = await resolveRef(page, record, ref)
  const r = await client.send<{ result: { value: FillOutcome } }>(
    'Runtime.callFunctionOn',
    {
      objectId,
      functionDeclaration: FILL_FN,
      arguments: [{ value: text }],
      returnByValue: true,
    },
    { sessionId: entry.sessionId },
  )
  const outcome = r.result.value
  if (!outcome.ok) throw fillFailure(ref, text, outcome)
  // 回执带写入后的实际值与它是否经过规范化：日期截秒、时间补零这类改写在页面上看得见，
  // 不给出来的话，调用方只能再观察一次才知道控件里现在是什么。
  return {
    element: inspect.label ?? ref,
    ...(outcome.value === undefined ? {} : { value: outcome.value }),
    ...(outcome.normalized === undefined ? {} : { normalized: outcome.normalized }),
  }
}

/** 写入失败的说明。格式不合、超出取值范围、约束不满足、页面不接受各自成句，下一步不一样。 */
function fillFailure(ref: string, wanted: string, outcome: FillOutcome): CdpError {
  const type = outcome.type ?? ''
  switch (outcome.reason) {
    case 'disabled':
      return new CdpError(`元素 ${ref} 当前不可用，没有写入`)
    case 'readonly':
      return new CdpError(`元素 ${ref} 是只读的，没有写入`)
    case 'not_fillable':
      return new CdpError(`元素 ${ref} 不是可输入的控件`)
    case 'no_empty':
      return new CdpError(`${type} 类型没有空值，清不掉；给一个合法值`)
    case 'bad_type':
      return new CdpError(`认不出的输入类型 ${type}`)
    case 'bad_format':
      return new CdpError(`${wanted} 不是 ${type} 类型接受的格式，原值没有改动`)
    case 'clamped':
      return new CdpError(
        `${wanted} 超出 ${type} 的取值范围，能写入的是 ${outcome.value ?? ''}，原值没有改动`,
      )
    case 'constraint':
      // 报控件上写着的限制，不报「能接受的是」：number 不钳制，那一栏会与被拒的值同数。
      return new CdpError(
        `${wanted} 不满足 ${type} 的约束${limitsText(outcome.limits)}，原值没有改动`,
      )
    case 'rejected':
      return new CdpError(
        `写入已经发到页面上，但值随即变成了 ${outcome.value ?? ''}（写的是 ${outcome.wanted ?? wanted}），这次输入没有被接受`,
      )
    default:
      return new CdpError(`元素 ${ref} 写入失败`)
  }
}

/** 控件上写着的限制。一项都没有时给空串，不写一对空括号。 */
function limitsText(limits: FillOutcome['limits']): string {
  const parts = Object.entries(limits ?? {}).map(([name, value]) => `${name}=${value}`)
  return parts.length === 0 ? '' : `（${parts.join('、')}）`
}

/**
 * 按下状态里量取一段的终点。
 *
 * 终点仍在可视区外时在按下状态内有界推进滚动并重新量取；跨文档、节点丢失、落点超出
 * 元素或坐标量不定就返回 `null`，由调用方收尾。**不反复回头滚起点**：它已经按下，
 * 再滚它只会把按下的位置甩开。
 */
async function dragTarget(
  page: PageHandle,
  end: { entry: RefRecord; objectId: string },
  ref: string,
  run: Execution,
  point: BrowserPoint | undefined,
): Promise<Point | null> {
  const { client } = page
  for (let pass = 0; pass <= MAX_DRAG_SCROLLS; pass++) {
    if (!run.open(client)) return null
    const view = await inspectNode(
      client,
      end.entry.sessionId,
      end.objectId,
      ref,
      run.deadline,
      point,
    ).catch(() => null)
    if (!view || !view.connected || view.identity !== end.entry.identity) return null
    if (view.inBox === false) return null
    if (view.inView === true) {
      return toInputPoint(page, end.entry, view, ref, run.deadline, false).catch(() => null)
    }
    if (pass === MAX_DRAG_SCROLLS) return null
    await client
      .send(
        'DOM.scrollIntoViewIfNeeded',
        { objectId: end.objectId },
        { sessionId: end.entry.sessionId, ...within(run.deadline, PREPARE_TIMEOUT_MS) },
      )
      .catch(() => null)
  }
  return null
}

/**
 * 拖动：在起点按下，沿路径逐段移动，在最后一段的终点抬起。起点与各段终点都取自同一份
 * 观察，同一个元素上的两个不同点可以互为起终点。
 *
 * 先只读核全部端点，再完成必要滚动，最后在同一个坐标系里重新量取并复核起点可命中——
 * **不得用第一次滚动前的起点坐标**，后一次滚动会让它指向另一个位置。按下之后每条移动
 * 带 `buttons: 1`，最后 `mouseReleased` 清为 0。一段是一个单元：段内按时长约每帧移动一次，
 * 时长为 0 时只发中点与终点。
 *
 * 只承诺指针事件驱动的拖动，不承诺 HTML5 DataTransfer 原生拖放链。
 */
async function dragOnPage(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
  opts: PointerOptions & { path?: BrowserPathStep[] },
): Promise<BrowserActReceipt> {
  const path = opts.path ?? []
  const problem = checkPath(path)
  if (problem) throw new CdpError(problem)
  const keys = heldKeysOf(opts.keys)
  const { client, sessionId } = page
  const run = new Execution()
  const deadline = run.deadline
  // 先只读核全部端点：任一端已经不在了就不必滚动页面，更不该按下鼠标。
  await resolveRef(page, record, ref, deadline, opts.point, true)
  const ends: { entry: RefRecord; objectId: string; inspect: Inspection }[] = []
  for (const step of path)
    ends.push(await resolveRef(page, record, step.ref, deadline, step.point, true))
  // 先滚第一段的终点、后量起点：滚终点会把起点带到别的位置，先量到的那一份从此不成立。
  const first = ends[0]
  if (first) await scrollIntoView(client, first.entry, first.objectId, first.inspect, deadline)
  const start = await prepareAction(page, record, ref, {
    scroll: true,
    hit: true,
    deadline,
    ...(opts.point ? { point: opts.point } : {}),
  })
  const keyboard = new Keyboard(client, sessionId)
  const send = (
    type: 'mousePressed' | 'mouseReleased' | 'mouseMoved',
    point: Point,
    buttons: number,
  ) =>
    run.run(client, () =>
      mouseEvent(
        client,
        sessionId,
        type,
        point,
        {
          button: 'left',
          buttons,
          modifiers: keyboard.modifiers,
          ...(type === 'mouseMoved' ? {} : { clickCount: 1 }),
        },
        deadline,
      ),
    )
  let at = start.point
  const sequence = async (): Promise<boolean> => {
    if (!(await run.run(client, () => keyboard.to(keys, deadline)))) return false
    const aimed = await run.run(client, () =>
      aimAt(client, sessionId, at, keyboard.modifiers, deadline),
    )
    if (!aimed || !(await send('mousePressed', at, 1))) return false
    for (const [i, step] of path.entries()) {
      const end = ends[i]
      const to = end ? await dragTarget(page, end, step.ref, run, step.point) : null
      if (!to) {
        run.stop(`第 ${i + 1} 段的终点 ${step.ref} 已经量不到`)
        return false
      }
      const ms = step.durationMs ?? 0
      const steps = Math.max(2, Math.round(ms / DRAG_STEP_MS))
      for (let k = 1; k <= steps; k++) {
        if (!(await run.hold(client, ms / steps))) return false
        const point = {
          x: at.x + ((to.x - at.x) * k) / steps,
          y: at.y + ((to.y - at.y) * k) / steps,
        }
        if (!(await send('mouseMoved', point, 1))) return false
      }
      at = to
      run.unit()
    }
    if (!(await send('mouseReleased', at, 0))) return false
    return run.run(client, () => keyboard.to([], deadline))
  }
  if (await sequence()) run.finish()
  await settleInput(client, [sessionId], run)
  return { element: start.inspect.label ?? ref, point: start.point, execution: run.receipt() }
}

/** 等主文档里一个选择器达到指定状态。页内等待器只观察并返回，不点击、不提交。 */
export async function waitOnPage(
  page: PageHandle,
  spec: { selector: string; state: BrowserWaitState; expected?: string },
  timeoutMs: number,
): Promise<BrowserWaitReceipt> {
  const { client, sessionId } = page
  const waiterId = await client.startWaiter(sessionId, spec, timeoutMs)
  try {
    const got = (await client.awaitWaiter(sessionId, waiterId, timeoutMs + 5_000)) as {
      met?: boolean
      reason?: string
    }
    return {
      met: got.met === true,
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
  await assertDoc(page, record)
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
): Promise<BrowserActReceipt> {
  await assertDoc(page, record)
  // 与普通点击同一条路径：定位、滚动、命中说明与收尾都一致，两处不给两套解释。
  const receipt = await clickOnPage(page, record, ref, {}, 'left')
  const execution = receipt.execution
  if (execution && execution.state !== 'completed') {
    throw new CdpError(`触发下载的点击没有做完：${execution.reason ?? execution.state}`)
  }
  return receipt
}
