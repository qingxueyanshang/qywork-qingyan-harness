/**
 * 受控页面上的观察与动作。
 *
 * 四条不变量：
 *
 * 1. **ref 只属于一次观察。** 编号绑定 tab、帧、文档令牌与节点身份指纹；导航会更换文档，
 *    重新观察会更换编号，旧编号一律拒绝。动作前重新解析节点并核对身份，不将失效编号
 *    重新定位到另一个同名按钮。
 * 2. **语义来自 AX 树与节点属性，不是整页 HTML。** 每一步将整页 HTML 传入模型既无法容纳
 *    也无法准确读取；元素表提供角色、名称、类型、状态与正文摘要，超出上限时如实报告截断。
 * 3. **指向元素的鼠标与键盘输入发送到元素所在的会话。** 鼠标使用该会话本地根的坐标，
 *    避免滚动后依赖顶层合成器尚未更新的跨进程命中信息；回执仍用顶层坐标。帧偏移在
 *    动作准备阶段实时获取，并逐层核对父文档遮挡。滚轮按页面落点分发，不绕过覆盖落点的元素。
 * 4. **动作只发送 CDP 的 Input 事件。** 不调用系统鼠标键盘，不将窗口置于前台。
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
 * 选项样例与填写回执中的值的字符上限。
 *
 * 元素表的名称与值不使用该上限：查询须按原值匹配，完整原值随观察落盘，长度由投递层控制。
 */
const MAX_TEXT = 200
/** 动作回执的目标标签、遮挡元素与选项样例的名称上限。 */
const MAX_LABEL = 60
/** 单个 select 一次返回的选项上限。 */
const MAX_SELECT_OPTIONS = 30
/** 一份普通观察中所有 select 的选项摘要合计上限。 */
const MAX_OBSERVATION_OPTIONS = 100
/** 无法选中时错误信息中附带的选项样例数。 */
const SELECT_SAMPLE = 5
/** 截图的字节上限。超过时降低质量重新截取一次，仍超过则不返回图像。 */
const MAX_SHOT_BYTES = 1_500_000
/** 单个跨站子帧的观察上限。子帧无响应时，主文档仍须能完成观察。 */
const FRAME_TIMEOUT_MS = 5_000

/**
 * 主文档 AX 树重新获取的间隔与总上限。
 *
 * Chromium 的无障碍树是延迟计算的：页面刚 `on_page_load` 完成时它可能仍为空，
 * 而新建页面时只等待首个文档加载、不等待 AX 树就绪。若不重新获取，静态表单在 create 之后
 * 立即 observe 会返回 0 个元素，模型只能改为自行编写脚本。跨站子帧不使用该重试：
 * 它已有 `FRAME_TIMEOUT_MS` 与跳过机制。
 */
const AX_RETRY_INTERVAL_MS = 150
const AX_RETRY_TOTAL_MS = 1_500

/**
 * 跨站帧附加子会话之前的等待上限与重新查询间隔。
 *
 * 新建页面时只等待主文档 load 完成，跨站 iframe 的导航在此之后才提交；实测这段时间在空闲机器上
 * 也只有几十毫秒的余量，观察发生在此期间会得到一张没有帧内元素的表。等待超时仍未就位的帧按
 * `framesPending` 报告，不静默少计。
 *
 * 2 秒的依据（2026-09-16 实测，回环三层跨站页与公网含跨站 iframe 的页各十轮）：不限速时
 * 跨站帧在首次观察的前几轮重新查询中就绪；为帧增加 1.5 秒延迟后，首次观察报告 `framesPending`，
 * 第二次观察（约 1 秒后）取得帧内元素。**不要调高**：该上限是每次遇到未就位帧的
 * 观察都须等待的固定开销，超时未就位的帧多等待一秒仍无法就位，`framesPending` 已经说明该情况。
 */
const FRAME_ATTACH_INTERVAL_MS = 100
const FRAME_ATTACH_TOTAL_MS = 2_000

/** 尚未提交导航的帧承载的地址。 */
const BLANK_URL = 'about:blank'

/** 调用方未指定截止时间时，一次观察的总预算。 */
const OBSERVE_BUDGET_MS = 30_000
/** 单条采集命令的上限。剩余预算更少时按剩余预算发送，不再分配完整额度。 */
const COLLECT_TIMEOUT_MS = 15_000
/** 单次截图的上限。 */
const SHOT_TIMEOUT_MS = 20_000

/**
 * 一次坐标动作的准备预算：身份核对、滚入可视区、重新测量与命中复核共用。
 *
 * 布局持续变化时按该预算退出，不在同一个动作中反复滚动并重新测量。
 */
const PREPARE_BUDGET_MS = 10_000
/** 准备阶段单条命令的上限。剩余预算更少时按剩余预算发送。 */
const PREPARE_TIMEOUT_MS = 5_000
/** 帧链最多遍历的层数。超过即判定失败，不继续向上查找。 */
const MAX_FRAME_DEPTH = 8

/** `type` 一次最多输入的 Unicode 码点数。整段预检通过后才发送第一个事件。 */
const MAX_TYPE_UNITS = 2_000
/** 拖动按下之后每一段终点最多推进的滚动次数。 */
const MAX_DRAG_SCROLLS = 2
/** 有时长的拖动段中相邻两次移动的间隔，约一帧。 */
const DRAG_STEP_MS = 16

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 元素引用已不再指向原节点。调用方必须重新观察，不能改写编号重试。 */
export class BrowserStaleRefError extends CdpError {}
/** 命中点位于其他元素上。页面结构已改变或被浮层遮挡，同样要求重新观察。 */
export class BrowserAmbiguousRefError extends CdpError {}
/** 预算内未能采集到前后一致的快照。调用方保留已经发出的动作回执，不重新执行动作。 */
export class BrowserObserveTimeoutError extends CdpError {}

/**
 * 元素编号对应的定位信息。
 *
 * **不存储帧偏移**：偏移随父页滚动变化，观察时测得的值在动作时可能已不成立。
 * 坐标一律在动作准备阶段实时获取，见 `prepareAction`。
 */
interface RefRecord {
  backendNodeId: number
  /** 元素所在的 CDP 会话：主文档与同进程 iframe 是页会话，跨站 iframe 是它的子会话。 */
  sessionId: string
  frame?: string
  /**
   * 同进程帧链：从元素所在文档向外，每一层是承载它的 iframe 元素在父文档中的节点号。
   *
   * 缺省表示元素直接位于会话的根文档中。该字段记录结构而不是几何：盒模型在动作准备阶段实时获取。
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
  /** 文档令牌。导航更换文档时该值随之改变，据此判断整份观察是否已经失效。 */
  docToken: string
  refs: Map<string, RefRecord>
}

/** 在页内建立文档令牌。不可写且不可配置，同源脚本无法修改；新文档没有该值，因此导航即更换令牌。 */
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
 * 页内复核：节点是否仍连接、身份是否一致、矩形位置，以及命中点落在哪个元素上。
 *
 * 一次往返回答全部问题。分成多次时，两次之间页面可能已经变化，
 * 「复核通过」描述的就不是最终发送事件时的状态。
 *
 * `label` 与 `hitLabel` 均按 `MAX_LABEL` 截断。页面自报的 `aria-label` 长度无界，
 * 若不在此处截断，它会经由动作回执进入 message。
 *
 * 指定 `px` / `py` 时测量的是自元素矩形左上角偏移的点，否则测量中心；`inBox` 表示该点是否位于
 * 当前矩形内：元素尺寸在观察之后可能已经改变。
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
  // 文本可跨行。选取一个实际文字片段，不使用父容器或多行外接矩形的中心。
  const fragment = rects.find(r => r.right > 0 && r.bottom > 0 && r.left < view.innerWidth && r.top < view.innerHeight) || rects[0] || r
  const offset = typeof px === 'number' && typeof py === 'number'
  const x = offset ? r.x + px : fragment.x + fragment.width / 2
  const y = offset ? r.y + py : fragment.y + fragment.height / 2
  const inBox = text ? rects.some(r => x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) : !offset || (px >= 0 && py >= 0 && px <= r.width && py <= r.height)
  // 可视区判定使用元素所在文档的视口。该判定通过只说明它在本文档内可见，
  // 跨站 iframe 还须逐层核对父文档，见 framePoint。
  const inView = x >= 0 && y >= 0 && x <= view.innerWidth && y <= view.innerHeight
  // 命中测试须在元素自身的根节点中执行：文档级的 elementFromPoint 对 shadow 内容返回的是
  // 宿主元素，而 contains 不穿透 shadow 边界，按文档级结果判定会将每一次 shadow 内的点击
  // 都判定为被覆盖。
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
 * 将子帧中的一个点换算到父文档，并在父文档中复核该点命中本帧。
 *
 * 加上的是内容盒左上角，不是边框盒：iframe 的内容从内边距内侧开始，按边框盒计算会整体
 * 偏移一个边框宽度。父层遮罩覆盖 iframe 时 `sameTree` 为假，该层即为遮挡点。
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
 * 读取一段选项。`total` 是当前的总数，调用方据此判断是否还有后续。
 *
 * 取 `el.options` 而不是子元素：它将 optgroup 中的选项一并展开，顺序与用户看到的
 * 一致。禁用状态合并 optgroup 的状态：optgroup 禁用时其下的选项一律不可选。
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
 * 为选择框设值并派发事件。只修改 value 而不派发事件时，网站的监听器无法收到本次变化。
 *
 * 无法选中时只返回原因、总数与有界样例。**不要改成返回完整选项表**：上千项的
 * `select` 会占满整份工具输出，继续读取使用 `optionsFor`。
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
 * 三个阶段：写前拒绝（禁用、只读、类型不能清空）→ 在同类型的临时控件上预检格式与约束 →
 * 对目标使用原生 setter 写入、派发 input/change、回读实际值。
 *
 * **预检必须在临时控件上执行。** 直接在目标上试写再检查结果时，非法值已经覆盖了原值。
 * 写入使用 `HTMLInputElement.prototype` 上的原生 setter：受控组件将 `value` 替换为自己的
 * 访问器，直接赋值时它无法收到本次变化，框架状态与页面显示此后不一致。
 * `range` 将越界值静默钳制到边界且不报错，因此它的「规范化后不等于原值」按约束不满足处理。
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
    // color 只接受 #rrggbb。无法识别的写法会被替换为一个具体颜色而不是空串，
    // 按「规范化结果非空」判定会将 red 当作合法输入，写入的是另一个值。
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
 * 逐字输入前的复核：节点仍存在、身份未变、焦点仍在该节点上。
 *
 * 每个码点发送前执行一次。缺少该复核时，节点被替换或焦点转移之后，后续字符会输入到另一个控件，
 * 而这段输入的去向在回执中无法体现。
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
  /** iframe 元素上是其承载的帧的编号；文档节点上是该文档所属的帧。 */
  frameId?: string
  /** 文档节点当前的地址。导航尚未提交时为 `about:blank`。 */
  documentURL?: string
}

/** 元素节点在 DOM 快照中的标签与属性。 */
type DomInfo = { tag: string; attrs: Record<string, string>; text?: string }

interface AxNode {
  ignored?: boolean
  role?: { value?: string }
  name?: { value?: string }
  value?: { value?: string }
  properties?: { name: string; value?: { value?: unknown } }[]
  backendDOMNodeId?: number
}

/** 被视为可操作元素的 AX 角色。 */
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
 * 同样按可操作处理的标签。缺少 AX 角色的自定义控件由该集合识别。
 *
 * **不含 `label`**：点击它等于点击其关联的控件，而该控件已经单独列为一行；
 * 它自身的可访问名通常为空，列入表中只会多出一条无用的空条目。`canvas` 的交互全部位于自身的
 * 像素中，AX 树赋予它 `Canvas` 角色，只有按标签收录，指针动作才有可指定的落点。
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

/** 只提供正文的角色。模型据此读取页面结果，无需回传整页 HTML。 */
const TEXT_ROLES = new Set(['StaticText', 'heading', 'paragraph', 'cell', 'columnheader'])

export interface PageHandle {
  client: CdpClient
  /** 顶层页会话。截图请求发送到该会话；输入发送到目标所在的会话。 */
  sessionId: string
  tabId: string
}

/**
 * 实时读取主文档的令牌、地址与标题。
 *
 * 跨文档判定与采集一致性判定均使用实时读取的值，不使用观察表中记录的值：后者对应上一次
 * 采集的页面，与当前文档不一定相同。
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
 * 观察一个页面。
 *
 * 主文档与其跨站子帧各获取一次 DOM 快照和 AX 树；子帧元素的矩形叠加该帧在顶层文档
 * 中的偏移之后，才是可用于发送事件的坐标。
 *
 * **采集前后各核对一次主文档令牌与地址**：期间文档或地址发生变化时，结果中混有两个页面的
 * 元素，整份丢弃并在剩余预算内重新采集，不登记「旧令牌配新元素」的观察。预算耗尽时抛出
 * `BrowserObserveTimeoutError`。采集一致不代表 DOM 与业务状态此后不再变化。
 *
 * **观察只读，不滚动页面**：滚动由动作执行，见 `prepareAction`。返回的 select 另带一份
 * 当前选项摘要，合计有上限，未列全的使用 `readSelectOptions` 继续读取。
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
      throw new BrowserObserveTimeoutError('未能在预算内采集到前后一致的观察，请重新观察')
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
 * 一份文档快照中尚无法采集的帧。主文档与每个跨站子会话的文档各检查一次，见 `scanFrames`。
 *
 * 以下条件同时成立才计入：`src` 指向一个地址、该帧没有已就绪的子会话、承载的文档
 * 仍是 `about:blank`，且它仍在就位过程中（`settling`，见 `CdpClient.settlingFrames`）。
 * 跨站 iframe 在导航提交前由主进程承载一个空白占位帧，提交之后才切换为独立目标并附加
 * 子会话：在此期间它在 DOM 中可见，采集却无法取得任何内容。
 *
 * **`settling` 条件不能省略。** 页面推迟加载的帧（`loading="lazy"` 尚未触发）在快照中
 * 与正在导航的帧形式完全相同：都是 `about:blank` 空文档，按结构无法区分。缺少该条件时，
 * 页面上每个延迟加载的帧在每次观察中都被计为未就位，观察无效等待满 `FRAME_ATTACH_TOTAL_MS`，
 * 而这些帧始终不会提交。实测：css-tricks 的 flexbox 指南中 18 个 `loading="lazy"`
 * 的 codepen 嵌入帧即属此类，每次观察固定多耗时 2 秒，`framesPending` 每次都报告同一批帧。
 *
 * **不要改用 `Page.getFrameTree` 核对帧是否存在**：页会话的帧树中只有本进程的帧，
 * 已经提交的跨站帧不在其中，据此核对会将正常的帧判定为缺失。
 */
function pendingFrames(root: DomNode, ready: Set<string>, settling: ReadonlySet<string>): string[] {
  const out: string[] = []
  const walk = (node: DomNode): void => {
    if (node.nodeName.toLowerCase() === 'iframe') {
      const frame = node.frameId
      // 无法取得帧编号的帧不列入元素表，见 splitDocs。
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

/** 一个会话的一次 DOM 快照。`pierce` 穿透 shadow root 与同进程 iframe。 */
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
 * 扫描尚无法采集的帧：主文档与每个已就位的跨站子会话各获取一次快照，各自判定所在文档中的 iframe。
 *
 * **只检查主文档快照无法发现嵌套的帧。** `pierce` 无法穿越渲染进程边界，跨站子帧的文档
 * 不在主文档快照中；嵌套在其中的尚未提交的帧因此既不会被等待，也不会列入 `framesPending`，
 * 观察会静默缺少整层元素。子会话无法返回快照时本轮跳过该会话：一个无响应的帧不应阻塞整页观察。
 *
 * 快照一并返回给调用方复用：采集与本次判定使用同一份快照，不为同一个会话获取两次。
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
 * 主文档与范围内的子帧各采集一次，合成一张元素表。
 *
 * 未就位的跨站帧先等待，等待超时则连同编号一起报告（`pending`），不视为该页面没有该帧。
 */
async function collectAll(
  client: CdpClient,
  sessionId: string,
  opts: { frame?: string },
  deadline: number,
): Promise<{ items: { element: BrowserElement; ref: RefRecord }[]; pending: string[] }> {
  // 指定帧时只等待该帧：其他帧未就位不应阻塞「只看这个 iframe」的观察。
  const inScope = (frames: string[]) =>
    opts.frame ? frames.filter((f) => f === opts.frame) : frames
  // 指定的跨站帧已经就位时本次不扫描：这些快照本次不会使用，获取它们只消耗预算。
  const onReadyFrame =
    opts.frame !== undefined &&
    client.childSessionsOf(sessionId).some((c) => c.targetId === opts.frame)
  let scan = { shots: new Map<string, DomNode>(), pending: [] as string[] }
  if (!onReadyFrame) {
    scan = await scanFrames(client, sessionId, deadline)
    // 重新查询共用同一份预算，不为每一层帧各分配完整额度。
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
  // 指定跨站帧时只查询其所在会话；同进程帧的编号无法表明所属会话，因此查询全部会话。
  const named = opts.frame ? sessions.find((s) => s.frame === opts.frame) : undefined
  const scope = named ? [named] : sessions

  const all: { element: BrowserElement; ref: RefRecord }[] = []
  for (const s of scope) {
    const shot = scan.shots.get(s.sessionId)
    if (s.frame === undefined) {
      all.push(...(await collectSession(client, s, deadline, COLLECT_TIMEOUT_MS, shot)))
      continue
    }
    // 跨站子帧由其自身的渲染进程应答，正在加载或已经消失时不会应答。
    // 单个帧无响应不应导致整页观察失败：跳过该帧，主文档照常返回元素表。
    try {
      all.push(...(await collectSession(client, s, deadline, FRAME_TIMEOUT_MS, shot)))
    } catch (err) {
      log.warn('browser', `子帧观察跳过：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  // 指定帧时只保留该帧的元素，否则「只看这个 iframe」返回的仍是整页。
  const items = opts.frame ? all.filter((i) => i.element.frame === opts.frame) : all
  return { items, pending }
}

/**
 * 一份文档的采集范围。
 *
 * `frame` 是帧编号：跨站帧取其子会话的 targetId，同进程帧取 CDP 的 frameId，
 * 主文档缺省。`owners` 见 `RefRecord.owners`。
 */
type FrameScope = { sessionId: string; frame?: string; owners?: number[] }

/** 编号在筛选完成之后才发放，因此候选中只有 `ref` 之外的字段。 */
interface Candidate {
  actionable: boolean
  element: Omit<BrowserElement, 'ref'>
  ref: RefRecord
}

/**
 * 将一次 `pierce` 快照按文档拆分。
 *
 * **同进程 iframe 必须单独拆分为一份。** `pierce` 将它的 `contentDocument` 一并取回，
 * 而 `Accessibility.getFullAXTree` 不带 `frameId` 时只覆盖会话的根帧：两者合并时，
 * 帧内节点无法匹配任何 AX 行，整个同源 iframe 的内容都无法生成候选。
 * shadow root 中的内容属于宿主所在的文档，随宿主归类。跨站 iframe 没有 `contentDocument`，
 * 由其自身的子会话采集。
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
    // 无法取得帧编号时就无法取得该帧的 AX 树；层数超过上限时坐标也无法换算到顶层。
    // 两种情况下该帧均不列入元素表，主文档照常返回自身的元素。
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
 * 一个会话中的全部文档。DOM 快照一次取回，AX 树按帧各获取一次，按 backendNodeId 匹配。
 *
 * `root` 是调用方已经获取的该会话快照，提供时不再重新获取。
 *
 * 同进程帧不使用 AX 重新获取：它与根文档共用本次 DOM 快照与本阶段预算，重新获取等于
 * 将每个 iframe 的等待叠加到同一份预算上。该帧的 AX 尚未建立时它不列入元素表，
 * 重新观察即可取得。
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
  // pierce 穿透 shadow root 与同进程 iframe；跨站 iframe 经由其自身的会话采集。
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
     * AX 树是延迟计算的：主文档刚加载完成时可能仍为空，静态表单因此也会返回 0 个候选。
     * DOM 中有可交互元素而候选为 0 时，按短间隔重新获取 AX 树，非空即使用；到达上限仍为空时从
     * DOM 快照直接生成元素表（语义降级但不为 0）。子帧不使用该重试：它自带超时与跳过机制。
     * 重新获取同样消耗总预算：取本阶段上限与剩余预算中的较小值，到期即使用已有结果。
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

/** 从 AX 树生成候选：AX 提供角色 / 名称 / 状态，DOM 提供标签与属性。 */
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
        // expanded / selected 缺省表示该角色没有此项，补 false 会将「没有此项」
        // 表述为「收起」「未选中」。
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
 * 按 AX 的实际布尔值取一项状态。
 *
 * 缺省或值不是布尔值时不写该项：`expanded` 只在可展开的角色上存在，
 * 补 false 等于声明它处于收起状态。
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

/** DOM 快照中是否存在可交互元素。AX 树尚未建立时据此判断是否重新获取。 */
function domHasActionable(byBackend: Map<number, DomInfo>): boolean {
  for (const { tag, attrs } of byBackend.values()) {
    if (tag === 'input' && attrs.type === 'hidden') continue
    if (ACTIONABLE_TAGS.has(tag)) return true
    if (attrs.role && ACTIONABLE_ROLES.has(attrs.role)) return true
  }
  return false
}

/**
 * AX 树长时间未建立时的回退：直接从 DOM 快照生成可交互元素。
 *
 * 语义降级：名称只能取 `aria-label` / `placeholder` / `name` 等属性，无法取得
 * AX 计算出的可访问名。**不生成虚假元素**：只收录真实的可交互标签，不收录隐藏 input。
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

/** 候选去重并发放编号。 */
function dedupeAndNumber(
  candidates: Candidate[],
  frame: FrameScope,
): { element: BrowserElement; ref: RefRecord }[] {
  /*
   * 与某个可操作元素同名的正文节点不列入表中。
   *
   * 按钮的可访问名来自其内部的文本节点，两者在 AX 树中各占一行；全部保留时，
   * 五个控件的表单会产生十几个编号，其中一半与另一半指向相同的操作。
   * 判定分两遍执行：同名的可操作元素可能排在正文节点之后。
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
 * 为本页要返回的 select 补充一份当前选项摘要。
 *
 * 只为实际返回的 select 采集：未列入本页元素表的 select 即使采集也无法返回。
 * 合计上限用尽之后仍读取一次总数（limit 取 0），使调用方知道需要使用 `optionsFor` 继续读取；
 * 摘要缺省与「该 select 没有选项」必须能够区分。单个 select 读取失败时不写该项，
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
 * 为本页要返回的 canvas 补充当前的 CSS 像素尺寸，即指针动作 `point` 的取值范围。
 *
 * 只处理 canvas：它的落点只能按坐标区分，其他元素点击中心即可。无法测量（`display: none`）时
 * 不写该项，不写成 0。
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

/** 按引用记录解析出节点后读取一段选项。`limit` 为 0 时只获取总数。 */
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
 * 读取一个 select 的一页选项。
 *
 * 按旧观察定位、实时读取：不采集新观察、不发放新编号、不滚动页面。选项在两次读取之间
 * 增删时各页无法拼合为一份快照，调用方按 `total` 重新读取。
 */
export async function readSelectOptions(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
  offset: number,
): Promise<BrowserOptionsPage> {
  await assertDoc(page, record)
  // 深度读取与一次观察共用同一份预算，不为每个 select 各分配完整额度。
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
  /** 指定的落点位于元素当前的矩形内。未指定落点时恒为真。 */
  inBox?: boolean
  /** 落点位于本文档视口内。跨站 iframe 还须逐层核对父文档。 */
  inView?: boolean
  sameTree?: boolean
  hit?: string | null
  /** 命中元素的名称摘要，取 `aria-label` 或可取得文本，有界。 */
  hitLabel?: string
  disabled?: boolean
  /** 目标自身的名称摘要，取 `aria-label`、可取得文本或标签名，有界。动作回执的 `element` 取该值。 */
  label?: string
}

/** 一层帧的换算结果：点已位于父文档坐标系中，命中字段描述的是该层。 */
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

/** 名称、正文摘要、当前值任一包含查询串即命中，不分大小写。角色与标签不参与匹配：它们不是页面上显示的文字。 */
function matchesQuery(element: BrowserElement, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return [element.name, element.text, element.value].some(
    (field) => typeof field === 'string' && field.toLowerCase().includes(needle),
  )
}

/**
 * 核对本次观察对应的仍是当前文档。
 *
 * 每条动作路径的第一步都调用它，**不放在 `resolveRef` 中**：不带 ref 的 press 与 scroll
 * 不解析节点，放在该处时它们会按一份跨文档的旧观察作用于新页面。
 */
async function assertDoc(page: PageHandle, record: ObservationRecord): Promise<void> {
  const doc = await readDocument(page)
  if (doc.token !== record.docToken) {
    throw new BrowserStaleRefError('页面已更换文档，本次观察的元素编号全部失效，请重新观察')
  }
}

/**
 * 将一个 ref 解析为可操作的节点。
 *
 * 节点连接状态与身份指纹均通过才算命中；任一不符按失效返回，要求重新观察。
 * **不做「按名称再查找一个」的重新定位**：那会使点击作用于另一个同名按钮。
 * 文档令牌由调用方先经 `assertDoc` 核对。
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
  if (!entry) throw new BrowserStaleRefError(`本次观察中没有元素 ${ref}，请重新观察`)
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
 * 页内复核一次：矩形、可视区、命中点与身份指纹均取当前值。指定 `point` 时测量该点，
 * 否则测量中心。
 *
 * 页内抛出异常时 `returnByValue` 下的 `result.value` 是 `undefined`，**必须在此处处理**：
 * 直接返回时，下一步解引用它会以一句内部异常原文结束，而该原文不能指导调用方的下一步操作。
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

/** 核对节点是否仍是原节点。`when` 说明本次复核发生在哪一步。 */
function assertSameNode(ref: string, entry: RefRecord, inspect: Inspection, when: string): void {
  if (!inspect.connected) {
    throw new BrowserStaleRefError(`元素 ${ref} ${when}已从文档中移除，请重新观察`)
  }
  if (inspect.identity !== entry.identity) {
    throw new BrowserStaleRefError(`元素 ${ref} ${when}已指向另一个节点，请重新观察`)
  }
}

/**
 * 坐标动作的准备：核对身份 → 按需滚入可视区 → 重新测量矩形与整条帧链 → 在实际输入
 * 坐标系中复核命中 → 交给调用方发送事件。
 *
 * **坐标一律实时获取**，不使用观察时记录的帧偏移：父页滚动之后该偏移指向另一个位置。
 * 未找到父帧的 owner 或盒模型时判定定位失败，不补零：补零会将事件发送到页面左上角。
 * 滚动只发送一次并重新测量一次，布局持续变化时按准备预算退出。
 *
 * `scroll` 为假时只重新测量，不改变页面（观察与读取选项以此方式调用）；`hit` 为假时不做
 * 可命中裁决，只返回坐标（滚动到元素上等动作按落点发送事件即可）。`deadline` 缺省时
 * 使用一份独立的准备预算，多事件动作传入自身的绝对期限，不另设计时。`point` 是元素内的
 * 落点，缺省取中心。
 */
async function prepareAction(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
  opts: { scroll: boolean; hit: boolean; deadline?: number; point?: BrowserPoint },
): Promise<{
  entry: RefRecord
  objectId: string
  inspect: Inspection
  point: Point
  inputPoint: Point
}> {
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
  const points = await pointerPoints(page, entry, view, ref, deadline, opts.hit)
  return { entry, objectId, inspect: view, ...points }
}

/** 落点不在元素当前的矩形内。返回当前尺寸，调用方据此改用其他落点。 */
function outsideBox(ref: string, point: BrowserPoint, view: Inspection): CdpError {
  const w = Math.round(view.width ?? 0)
  const h = Math.round(view.height ?? 0)
  return new CdpError(
    `元素 ${ref} 上的点 (${point.x}, ${point.y}) 超出元素范围，元素当前宽 ${w}、高 ${h}`,
  )
}

/**
 * 需要时将元素滚入可视区，返回是否实际发送了滚动命令。
 *
 * 跨站 iframe 中的元素一律滚动一次：帧内可见不代表该帧位于父页的可视区内。
 * 通过 CDP 滚动原节点及父页，文本节点和元素共用这一条路径。
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
 * 同一次定位同时生成目标会话的输入坐标与顶层页面的回执坐标。
 *
 * 主文档的点无需换算。位于帧中的点逐层向上换算：同进程帧的一层按登记的 iframe 节点在同一个会话中
 * 实时获取盒模型，跨站帧的一层跨会话查找承载它的文档。每换算一层即在该层复核命中，
 * 因此能够拦截父层遮罩。任一层未找到即抛出失效，不继续使用未换算完成的坐标。
 */
async function pointerPoints(
  page: PageHandle,
  entry: RefRecord,
  view: Inspection,
  ref: string,
  deadline: number,
  requireHit: boolean,
): Promise<{ point: Point; inputPoint: Point }> {
  let point: Point = { x: view.x ?? 0, y: view.y ?? 0 }
  for (const owner of entry.owners ?? []) {
    if (leftMs(deadline) <= 0) {
      throw new BrowserAmbiguousRefError(`元素 ${ref} 的坐标未能在动作期限内确定，请重新观察`)
    }
    const mapped = await ownerHop(page.client, entry.sessionId, owner, point, ref, deadline)
    if (requireHit) assertHittable(`元素 ${ref} 所在的 iframe`, mapped)
    point = { x: mapped.x, y: mapped.y }
  }
  const inputPoint = point
  point = await toPagePoint(page, entry.sessionId, point, ref, deadline, requireHit)
  return { point, inputPoint }
}

/** 将一个会话本地根的坐标投影到顶层；父页遮挡必须在发送到子会话之前校验。 */
async function toPagePoint(
  page: PageHandle,
  sessionId: string,
  point: Point,
  ref: string,
  deadline: number,
  requireHit: boolean,
): Promise<Point> {
  let frame = page.client
    .childSessionsOf(page.sessionId)
    .find((c) => c.sessionId === sessionId)?.targetId
  if (sessionId !== page.sessionId && !frame) {
    throw new BrowserStaleRefError(`元素 ${ref} 所在的 iframe 已经不在页面上，请重新观察`)
  }
  for (let depth = 0; frame; depth += 1) {
    if (depth >= MAX_FRAME_DEPTH) {
      throw new BrowserStaleRefError(`元素 ${ref} 的帧层数超过上限，无法定位，请重新观察`)
    }
    if (leftMs(deadline) <= 0) {
      throw new BrowserAmbiguousRefError(`元素 ${ref} 的坐标未能在动作期限内确定，请重新观察`)
    }
    const hop = await frameHop(page, frame, point, ref, deadline)
    if (requireHit) assertHittable(`元素 ${ref} 所在的 iframe`, hop.mapped)
    point = { x: hop.mapped.x, y: hop.mapped.y }
    frame = hop.parentFrame
  }
  return point
}

/**
 * 换算一层同进程帧：承载它的 iframe 元素与它位于同一个会话中，按登记的节点号取回后换算。
 *
 * 节点已不存在时判定定位失败，不补零：补零会将事件发送到文档左上角。
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
 * 换算一层跨站帧：找到承载该帧的文档，将点换算到该文档。
 *
 * 父文档按试探定位：`DOM.getFrameOwner` 只在该帧的父会话中能够应答，先尝试页会话，
 * 未命中再尝试其余子会话：嵌套的跨站 iframe 的父文档也是一个子会话。
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
 * 命中裁决。视口外、零尺寸、被遮挡分别说明，不一律报告为被遮挡：三者的后续操作不同。
 *
 * 在动作准备的最后一步调用：滚动已经完成，此时仍命中其他元素才属于遮挡。
 */
function assertHittable(subject: string, view: Inspection | FramePoint): void {
  if (view.width === 0 || view.height === 0) {
    throw new BrowserAmbiguousRefError(`${subject} 当前尺寸为 0，无法在其上发送事件，请重新观察`)
  }
  if (view.inView !== true) {
    throw new BrowserAmbiguousRefError(`${subject} 滚动后仍在可视区外，请重新观察`)
  }
  if (view.sameTree !== true) {
    const hit = view.hit ? `${view.hit}${view.hitLabel ? `（${view.hitLabel}）` : ''}` : '空白'
    throw new BrowserAmbiguousRefError(`${subject} 的命中点位于 ${hit} 上，请重新观察`)
  }
}

/**
 * 在已观察的元素上执行一次有限动作，返回动作回执。
 *
 * 动作之后的观察由协调器补充，此处不采集。
 *
 * **发出第一个事件之前的失败一律抛出错误**：参数不合法、引用失效、命中不成立均属于尚未改变
 * 页面。已经发出事件之后不再抛出错误，改为在回执的 `execution` 中如实给出已确认的单元数：
 * 此时页面可能已经变化，抛出异常会使调用方按「未执行」重放。
 */
export async function actOnPage(
  page: PageHandle,
  record: ObservationRecord,
  input: BrowserActInput,
): Promise<BrowserActReceipt> {
  const { client } = page
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
      const { entry, inspect, point, inputPoint } = await prepareAction(page, record, ref, {
        scroll: true,
        hit: true,
        ...(input.point ? { point: input.point } : {}),
      })
      // 只移动，不按下。悬停层的出现时机由页面决定，动作之后的观察如实反映采集到的内容。
      await aimAt(client, entry.sessionId, inputPoint, 0)
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
 * 滚轮。指定 ref 时在元素的落点上滚动，否则在页面左上角附近滚动；两个方向都未指定时向下 400。
 *
 * 落点不做可命中裁决：滚轮事件作用于被遮挡的位置时同样能够滚动。
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
 * 无法选中时的失败说明。
 *
 * 带总数与有界样例，并给出继续读取的方式；**不返回完整选项表**，长列表会占满整份工具
 * 输出。
 */
function selectFailure(
  ref: string,
  wanted: string,
  value: { reason?: string; total?: number; sample?: string[]; label?: string },
): CdpError {
  if (value.reason === 'no_option') {
    const sample = (value.sample ?? []).join('、')
    return new CdpError(
      `不存在该选项：${wanted}（共 ${value.total ?? 0} 项` +
        (sample ? `，前几项：${sample}` : '') +
        `；使用 optionsFor 按 ${ref} 读取全部选项）`,
    )
  }
  if (value.reason === 'option_disabled') {
    return new CdpError(`选项 ${value.label ?? wanted} 当前不可选`)
  }
  return new CdpError(`元素 ${ref} 不是选择框`)
}

/**
 * 执行一段按键计划。指定 ref 时先将焦点移到该元素，按键发送到其所在的会话；否则发送到页会话，
 * 作用于文档当前的焦点，不涉及系统前台窗口。
 *
 * 阶段之间核对一次文档令牌：文档更换即停止，计划的其余部分不作用于新页面。不核对焦点：
 * Tab 等按键本身会移动焦点。成功、失败、取消都经由同一条收尾路径。
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

/** 核对本次观察的文档是否仍是当前文档。已更换或无法读取时返回停止原因。 */
async function documentMoved(
  page: PageHandle,
  record: ObservationRecord,
  deadline: number,
): Promise<string | null> {
  const doc = await readDocument(page, within(deadline, PREPARE_TIMEOUT_MS).timeoutMs).catch(
    () => null,
  )
  if (!doc) return '无法读取当前文档'
  return doc.token === record.docToken ? null : '页面已更换文档'
}

/** 指针动作期间按住的键。与预检使用同一张表，在发送第一个事件之前判定。 */
function heldKeysOf(keys: string[] | undefined): string[] {
  const held = keys ?? []
  const problem = checkHeldKeys(held, 'keys')
  if (problem) throw new CdpError(problem)
  return held
}

/** 指针动作共用的可选参数。 */
type PointerOptions = { point?: BrowserPoint; keys?: string[]; holdMs?: number }

/**
 * 单次点击，可按住一段时间，可同时按住键。右键只更换 `button`，定位、滚动与命中说明与左键
 * 相同。按下与抬起各为一个单元；按住期间被停止时由收尾补发 `mouseReleased`。
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
  const { client } = page
  const run = new Execution()
  const { entry, inspect, point, inputPoint } = await prepareAction(page, record, ref, {
    scroll: true,
    hit: true,
    deadline: run.deadline,
    ...(opts.point ? { point: opts.point } : {}),
  })
  const { sessionId } = entry
  const keyboard = new Keyboard(client, sessionId)
  const send = (type: 'mousePressed' | 'mouseReleased', buttons: number) =>
    run.run(client, () =>
      mouseEvent(
        client,
        sessionId,
        type,
        inputPoint,
        { button, buttons, clickCount: 1, modifiers: keyboard.modifiers },
        run.deadline,
      ),
    )
  const sequence = async (): Promise<boolean> => {
    if (!(await run.run(client, () => keyboard.to(keys, run.deadline)))) return false
    const aimed = await run.run(client, () =>
      aimAt(client, sessionId, inputPoint, keyboard.modifiers, run.deadline),
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
 * 双击：两轮按下与抬起，`clickCount` 依次为 1 与 2。
 *
 * 第二轮的 `clickCount: 2` 是浏览器判定 `dblclick` 的依据，两轮都发送 `clickCount: 1`
 * 得到的是两次单击。
 */
async function doubleClickOnPage(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
  opts: PointerOptions,
): Promise<BrowserActReceipt> {
  const keys = heldKeysOf(opts.keys)
  const { client } = page
  const run = new Execution()
  const { entry, inspect, point, inputPoint } = await prepareAction(page, record, ref, {
    scroll: true,
    hit: true,
    deadline: run.deadline,
    ...(opts.point ? { point: opts.point } : {}),
  })
  const { sessionId } = entry
  const keyboard = new Keyboard(client, sessionId)
  const sequence = async (): Promise<boolean> => {
    if (!(await run.run(client, () => keyboard.to(keys, run.deadline)))) return false
    const aimed = await run.run(client, () =>
      aimAt(client, sessionId, inputPoint, keyboard.modifiers, run.deadline),
    )
    if (!aimed) return false
    for (const clickCount of [1, 2]) {
      const sent = await run.run(client, async () => {
        const extra = { button: 'left', clickCount, modifiers: keyboard.modifiers }
        await mouseEvent(
          client,
          sessionId,
          'mousePressed',
          inputPoint,
          { ...extra, buttons: 1 },
          run.deadline,
        )
        await mouseEvent(
          client,
          sessionId,
          'mouseReleased',
          inputPoint,
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

/** `type` 的一个单元：产生一个字符需要按下的键，或一个经由文本插入的码点。 */
type TypeUnit = { keys: string[] } | { text: string }

/**
 * 归一化并切分为可发送的单元。
 *
 * 整段检查完成后才发送第一个事件：发送到一半时才发现超长，前半段已经输入页面，而输入事件
 * 无法撤回。CRLF 与单独的 CR 归一化为换行，换行按 Enter 发送，单行控件可能因此提交。
 * 布局表中的字符使用按键，其余码点使用 `Input.insertText`：不为中文生成虚拟键码，
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
    throw new CdpError(`一次最多输入 ${MAX_TYPE_UNITS} 个字符，本次为 ${units.length} 个`)
  }
  return units
}

/** 目标仍存在、身份未变、焦点仍在该目标上。任一项不成立即停止输入。 */
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
 * 逐字输入：聚焦目标后在当前选区输入，**不全选也不清空**，覆盖输入由 `fill` 负责。
 *
 * 每个码点发送前复核目标，节点被替换、移除或焦点转移时立即停止，不继续发往另一个控件。
 * 默认不加人为延时：需要等待异步候选层的应用应分段 type，并在每段之后自行 wait。按键与 `press` 使用
 * 同一个 `Keyboard`：一个码点对应一次按下集合，随后全部抬起。
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
          // 文本插入发送到元素所在的会话：焦点由该帧的渲染进程持有，发送到顶层会作用于其他位置。
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

/** `FILL_FN` 的返回值。`ok` 为假时 `reason` 决定返回给调用方的说明。 */
interface FillOutcome {
  ok: boolean
  reason?: string
  type?: string
  /** 实际回读的值，或预检规范化之后的值。 */
  value?: string
  /** 预检认可的值。回读值与它不一致表示页面修改了本次写入。 */
  wanted?: string
  normalized?: boolean
  /** 控件上设置的 `min` / `max` / `step`，只在约束不满足时提供。 */
  limits?: { min?: string; max?: string; step?: string }
}

/**
 * 覆盖输入。预检不通过时原值保持不变，回读不一致时如实说明页面已修改该值。
 *
 * 不发送键盘事件：受控组件需要的是 `input` / `change`，而日期、颜色等控件没有可逐字
 * 输入的键序列。逐字交互使用 `type`。
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
  // 回执带写入后的实际值及其是否经过规范化：日期截秒、时间补零等改写在页面上可见，
  // 若不返回，调用方只能再观察一次才能得知控件的当前值。
  return {
    element: inspect.label ?? ref,
    ...(outcome.value === undefined ? {} : { value: outcome.value }),
    ...(outcome.normalized === undefined ? {} : { normalized: outcome.normalized }),
  }
}

/** 写入失败的说明。格式不合法、超出取值范围、约束不满足、页面不接受分别说明，后续操作各不相同。 */
function fillFailure(ref: string, wanted: string, outcome: FillOutcome): CdpError {
  const type = outcome.type ?? ''
  switch (outcome.reason) {
    case 'disabled':
      return new CdpError(`元素 ${ref} 当前不可用，未写入`)
    case 'readonly':
      return new CdpError(`元素 ${ref} 为只读，未写入`)
    case 'not_fillable':
      return new CdpError(`元素 ${ref} 不是可输入的控件`)
    case 'no_empty':
      return new CdpError(`${type} 类型没有空值，无法清空；请提供合法值`)
    case 'bad_type':
      return new CdpError(`无法识别的输入类型 ${type}`)
    case 'bad_format':
      return new CdpError(`${wanted} 不是 ${type} 类型接受的格式，原值未改动`)
    case 'clamped':
      return new CdpError(
        `${wanted} 超出 ${type} 的取值范围，可写入的值为 ${outcome.value ?? ''}，原值未改动`,
      )
    case 'constraint':
      // 报告控件上设置的限制，不报告「可写入的值」：number 不钳制，该值会与被拒绝的值相同。
      return new CdpError(
        `${wanted} 不满足 ${type} 的约束${limitsText(outcome.limits)}，原值未改动`,
      )
    case 'rejected':
      return new CdpError(
        `写入已发送到页面，但值随即变为 ${outcome.value ?? ''}（写入的是 ${outcome.wanted ?? wanted}），本次输入未被接受`,
      )
    default:
      return new CdpError(`元素 ${ref} 写入失败`)
  }
}

/** 控件上设置的限制。没有任何一项时返回空串，不写空括号。 */
function limitsText(limits: FillOutcome['limits']): string {
  const parts = Object.entries(limits ?? {}).map(([name, value]) => `${name}=${value}`)
  return parts.length === 0 ? '' : `（${parts.join('、')}）`
}

/**
 * 在按下状态中测量一段的终点。
 *
 * 终点仍在可视区外时在按下状态内有界推进滚动并重新测量；跨文档、节点丢失、落点超出
 * 元素或坐标无法确定时返回 `null`，由调用方收尾。**不反复滚动起点**：起点已经按下，
 * 再滚动它只会使按下的位置偏离。
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
      return pointerPoints(page, end.entry, view, ref, run.deadline, false)
        .then((points) => points.point)
        .catch(() => null)
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
 * 先以只读方式核对全部端点，再完成必要滚动，最后在同一个坐标系中重新测量并复核起点可命中：
 * **不得使用第一次滚动前的起点坐标**，后一次滚动会使它指向另一个位置。按下之后每条移动
 * 带 `buttons: 1`，最后 `mouseReleased` 清为 0。每段为一个单元：段内按时长约每帧移动一次，
 * 时长为 0 时只发送中点与终点。
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
  const { client } = page
  const run = new Execution()
  const deadline = run.deadline
  // 先以只读方式核对全部端点：任一端点已不存在时无需滚动页面，更不应按下鼠标。
  await resolveRef(page, record, ref, deadline, opts.point, true)
  const ends: { entry: RefRecord; objectId: string; inspect: Inspection }[] = []
  for (const step of path)
    ends.push(await resolveRef(page, record, step.ref, deadline, step.point, true))
  // 先滚动第一段的终点，再测量起点：滚动终点会使起点移到其他位置，先测得的起点坐标随之失效。
  const first = ends[0]
  if (first) await scrollIntoView(client, first.entry, first.objectId, first.inspect, deadline)
  const start = await prepareAction(page, record, ref, {
    scroll: true,
    hit: true,
    deadline,
    ...(opts.point ? { point: opts.point } : {}),
  })
  // 从按下到抬起属于同一输入会话，取消时也由该会话释放。
  const { sessionId } = start.entry
  let origin = { x: start.point.x - start.inputPoint.x, y: start.point.y - start.inputPoint.y }
  const localPoint = (point: Point): Point => ({ x: point.x - origin.x, y: point.y - origin.y })
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
        localPoint(point),
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
      aimAt(client, sessionId, localPoint(at), keyboard.modifiers, deadline),
    )
    if (!aimed || !(await send('mousePressed', at, 1))) return false
    for (const [i, step] of path.entries()) {
      const end = ends[i]
      const to = end ? await dragTarget(page, end, step.ref, run, step.point) : null
      if (!to) {
        run.stop(`第 ${i + 1} 段的终点 ${step.ref} 已无法测量`)
        return false
      }
      // 终点的滚动可能移动起点所在 iframe；每段都重算输入会话原点，不缓存观察时的偏移。
      const currentOrigin = await toPagePoint(
        page,
        sessionId,
        { x: 0, y: 0 },
        ref,
        deadline,
        false,
      ).catch(() => null)
      if (!currentOrigin) {
        run.stop('拖动所在的 iframe 已无法测量')
        return false
      }
      origin = currentOrigin
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

/** 等待主文档中的一个选择器达到指定状态。页内等待器只观察并返回，不点击、不提交。 */
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

/** 将本机文件交给一个文件输入元素。路径必须已经过工作区裁决。 */
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
 * 点击一个元素触发下载。
 *
 * **只使用 Input 事件触发**：无用户手势的第 2 次下载会触发 WebView2 的「下载多个文件」
 * 权限提示，该提示先于下载钩子出现，钩子无法收到事件，而 Tauri 与 wry 都不暴露该事件。
 * 不要改成 `location.href` 跳转或 `a.click()`。
 */
export async function clickForDownload(
  page: PageHandle,
  record: ObservationRecord,
  ref: string,
): Promise<BrowserActReceipt> {
  await assertDoc(page, record)
  // 与普通点击使用同一条路径：定位、滚动、命中说明与收尾均一致，两处不产生两套说明。
  const receipt = await clickOnPage(page, record, ref, {}, 'left')
  const execution = receipt.execution
  if (execution && execution.state !== 'completed') {
    throw new CdpError(`触发下载的点击未完成：${execution.reason ?? execution.state}`)
  }
  return receipt
}
