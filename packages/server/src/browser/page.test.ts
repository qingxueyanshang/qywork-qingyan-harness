/**
 * 受控页面上的观察与动作判定。
 *
 * 覆盖范围：`page.ts` 全部（AX 树与 DOM 快照的合并、可操作元素筛选、翻页、
 * 文档令牌与身份指纹的失效判定、动作前的按需滚动与实时坐标、命中失败的分类说明、
 * select 的选项摘要与继续读取、十种动作的发送形状与多事件动作的执行回执、上传、下载触发、
 * 采集前后的一致性判定与观察预算、跨站帧未就位时的等待与 `framesPending`）。
 *
 * 对端是一个按几何模型应答的假调试端点：文档有视口与滚动量，节点有文档坐标里的矩形，
 * 命中测试按矩形与列表顺序取最后一个（绘制顺序），`scrollIntoView` 改滚动量并逐层
 * 传到父文档。**矩形只给参与命中测试的节点与遮罩**：这个模型不做包含关系判定，
 * 给祖先容器矩形会让它盖住自己的子节点。
 *
 * 被测的是**客户端发出了什么、在什么条件下拒绝**。真浏览器上的渲染、重名按钮与
 * 真实 Shadow DOM 由端到端脚本覆盖，那些验的是渲染引擎认不认。
 */

import { afterEach, expect, test } from 'bun:test'
import type { BrowserActInput, BrowserObservation } from '@qywork/agent'
import type { ServerWebSocket } from 'bun'
import { CdpClient } from './cdp.ts'
import {
  actOnPage,
  BrowserAmbiguousRefError,
  BrowserObserveTimeoutError,
  BrowserStaleRefError,
  clickForDownload,
  type ObservationRecord,
  observePage,
  type PageHandle,
  readSelectOptions,
  uploadToPage,
  waitOnPage,
} from './page.ts'

interface Command {
  id: number
  method: string
  sessionId?: string
  params?: Record<string, unknown>
}

/** 文档坐标里的矩形。视口坐标 = 它减去所在文档的滚动量。 */
interface Box {
  x: number
  y: number
  width: number
  height: number
}

interface OptionModel {
  label: string
  value: string
  /** option 自己的 label 属性；缺省时按正文取 label。 */
  text?: string
  disabled?: boolean
  selected?: boolean
  /** 所在 optgroup 被禁用。 */
  groupDisabled?: boolean
}

interface NodeModel {
  backendNodeId: number
  tag: string
  attrs: Record<string, string>
  /** 没有矩形的节点不参与命中测试，也不占位置（隐藏控件就是这样）。 */
  box?: Box
  disabled?: boolean
  readOnly?: boolean
  /** 控件当前值。fill 写它，type 的按键与文本插入追加到它上面。 */
  value?: string
  /** 写入之后页面把值改成这个：模拟受控组件不接受这次输入。 */
  rewriteTo?: string
  /** 固定定位：矩形不随滚动移动，scrollIntoView 也移不动它。 */
  fixed?: boolean
  /**
   * 页内复核函数在这个节点上抛异常。
   *
   * 文本节点就是这一类：它没有 `getBoundingClientRect`。`returnByValue` 下页内异常
   * 不进 `result.value`，回包给的是 `exceptionDetails`。
   */
  inspectThrows?: boolean
  options?: OptionModel[]
}

interface AxModel {
  backendDOMNodeId: number
  role: string
  name: string
  value?: string
  ignored?: boolean
  props?: { name: string; value: unknown }[]
}

/** 一个文档：主文档、一个跨站子帧，或一个同进程子帧。 */
interface DocModel {
  sessionId: string
  /**
   * 帧编号：跨站子帧是它子会话的 targetId，同进程子帧是 CDP 的 frameId。主文档没有。
   */
  frame?: string
  /**
   * 父文档的会话。同进程子帧与父文档同会话，这一项与 `sessionId` 相同——
   * 它不另起子会话，因此也不发 `Target.attachedToTarget`。
   */
  parent?: string
  /** 父文档里承载这个帧的那个节点。 */
  owner?: number
  viewport: { width: number; height: number }
  scrollY: number
  nodes: NodeModel[]
  ax: AxModel[]
  /** 头 N 次 `Accessibility.getFullAXTree` 回空树——模拟 AX 懒计算还没就绪。 */
  axDelayCalls: number
  /** 这个文档滚不动：模拟根元素 overflow 被裁掉。 */
  noScroll?: boolean
  /** 这份文档的地址。观察按它判一帧的导航提交没有。 */
  url?: string
  /** 跨站帧的导航还没提交：这一帧此刻是主进程里的 about:blank 占位帧，没有子会话。 */
  uncommitted?: boolean
  /**
   * 这一帧不发 `Page.frameStartedLoading`。
   *
   * 两种真实情形都是这个形状：页面把它推迟着（`loading="lazy"` 还没触发），
   * 或者导航早在附上会话之前就开始了，事件已经发完。它与正在导航的帧在 DOM
   * 快照里同形，分别只在这条事件上。
   */
  noLoadEvent?: boolean
  /** 这一帧的 `Target.attachedToTarget` 推迟这么久才发。缺省时用模型上那一份。 */
  attachDelayMs?: number
  /** 当前焦点节点。`DOM.focus` 改它，按键与文本插入落到它身上。 */
  activeElement?: number
}

interface PageModel {
  token: string
  url: string
  title: string
  /** `docs[0]` 是主文档。 */
  docs: DocModel[]
  /** 已经不在文档里的节点，`DOM.resolveNode` 对它们报错。 */
  gone: Set<number>
  /** 父文档里找不到这个帧的 owner：模拟 iframe 已被移除。 */
  ownerGone: Set<string>
  /** 答完这条命令就换文档令牌，模拟采集中途发生导航。 */
  flipTokenAfter?: string
  /** 每次 `scrollIntoView` 之后调一次，用来在滚动时改页面。 */
  onScroll?: () => void
  /** 第几条 `Input.*` 命令回错误。计数从 1 起，缺席表示都正常答。 */
  failInputAt?: number
  /**
   * 第几条 `Input.*` 命令不答并断开连接。计数从 1 起。
   *
   * 这一条已经入网、页面可能已经收下，只是回包永远不来——它与 `failInputAt` 的
   * 协议错误回包是两种终态，一个 `unknown` 一个 `partial`。
   */
  dropInputAt?: number
  /** 每条 `Input.*` 命令答完调一次，参数是它是第几条。用来在动作中途插事。 */
  onInput?: (nth: number) => void
  /** `Target.attachedToTarget` 推迟这么久才发，模拟跨站帧的导航晚于主文档提交。 */
  attachDelayMs?: number
  /** 子会话的 `Accessibility.enable` 推迟这么久才回，模拟开域还没完成。 */
  childInitDelayMs?: number
  /** 附上会话那一刻主文档的 `document.readyState`。缺省是加载已经完成。 */
  readyState?: string
}

const MAIN = 's1'

function mainDoc(): DocModel {
  return {
    sessionId: MAIN,
    viewport: { width: 800, height: 600 },
    scrollY: 0,
    nodes: [],
    ax: [],
    axDelayCalls: 0,
  }
}

/**
 * 一份文档的 DOM 快照。同进程子帧按 `pierce` 的形状嵌在它的 iframe 节点下，
 * 并在那个节点上带 `frameId`——AX 树按这个编号取。
 *
 * 跨站子帧的 iframe 节点同样带 `frameId`，但没有 `contentDocument`：它由自己的
 * 渲染进程承载，`pierce` 带不回来。导航还没提交的那一段例外——那时它是本进程里的
 * `about:blank` 占位帧，`contentDocument` 在、地址是 `about:blank`。
 */
function domTree(docs: DocModel[], doc: DocModel): Record<string, unknown> {
  return {
    backendNodeId: 1,
    nodeName: '#document',
    nodeType: 9,
    documentURL: doc.url ?? 'http://127.0.0.1:1/page',
    children: doc.nodes.map((n) => {
      const owned = docs.find((d) => d.owner === n.backendNodeId)
      const sameProcess = owned?.sessionId === doc.sessionId
      const blank = owned !== undefined && !sameProcess && owned.uncommitted === true
      return {
        backendNodeId: n.backendNodeId,
        nodeName: n.tag.toUpperCase(),
        nodeType: 1,
        attributes: Object.entries(n.attrs).flat(),
        children: [],
        ...(owned ? { frameId: owned.frame } : {}),
        ...(sameProcess && owned ? { contentDocument: domTree(docs, owned) } : {}),
        ...(blank
          ? {
              contentDocument: {
                backendNodeId: 1,
                nodeName: '#document',
                nodeType: 9,
                documentURL: 'about:blank',
                children: [],
              },
            }
          : {}),
      }
    }),
  }
}

function labelOf(node: NodeModel): string {
  return node.attrs['aria-label'] ?? node.attrs.id ?? node.tag
}

/** Chromium 的 color 输入框认的几个颜色名。取样即可，不需要整张 CSS 颜色表。 */
const COLOR_WORDS: Record<string, string> = { red: '#ff0000', blue: '#0000ff' }

/**
 * 按输入类型规范化一个值。空串表示这个类型不接受这个写法，与浏览器一致。
 *
 * `range` 对越界值是钳到边界而不是拒绝，所以它规范化之后与原值不等——调用方据此判约束。
 * `color` 是另一种：它对任何写法都给得出一个颜色，合法性因此判不了，由写入前的格式判据挡。
 */
function normalizeValue(attrs: Record<string, string>, type: string, value: string): string {
  if (value === '') return ''
  const dropZeroSeconds = (s: string) => s.replace(/:00$/, '')
  // 日期要回读一次：2026-02-30 会被解析成 3 月 2 日，只看解析成不成功判不出它非法。
  const realDate = (day: string) => {
    const at = Date.parse(`${day}T00:00:00Z`)
    return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === day
  }
  switch (type) {
    case 'date':
      return /^\d{4}-\d{2}-\d{2}$/.test(value) && realDate(value) ? value : ''
    case 'month':
      return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? value : ''
    case 'week':
      return /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/.test(value) ? value : ''
    case 'time':
      return /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value) ? dropZeroSeconds(value) : ''
    case 'datetime-local':
      return /^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/.test(value)
        ? dropZeroSeconds(value)
        : ''
    case 'number':
      return /^-?\d+(\.\d+)?$/.test(value) ? value : ''
    case 'range': {
      if (!/^-?\d+(\.\d+)?$/.test(value)) return ''
      const min = Number(attrs.min ?? 0)
      const max = Number(attrs.max ?? 100)
      return String(Math.min(max, Math.max(min, Number(value))))
    }
    case 'color':
      // 与 Chromium 一致：认不出的写法不回空串，而是换成一个具体颜色。
      // 按「规范化结果非空」判的话 red 会被当成合法输入，写进去的是另一个值。
      if (/^#[0-9a-fA-F]{6}$/.test(value)) return value.toLowerCase()
      return (COLOR_WORDS[value] ?? '#000000') as string
    default:
      return value
  }
}

/** min / max / step 约束。ISO 日期与时间按字符串比较就是按时间先后比较。 */
function outOfRange(attrs: Record<string, string>, type: string, value: string): boolean {
  if (value === '') return false
  const { min, max, step } = attrs
  if (min === undefined && max === undefined && step === undefined) return false
  if (type === 'number' || type === 'range') {
    const n = Number(value)
    if (min !== undefined && n < Number(min)) return true
    if (max !== undefined && n > Number(max)) return true
    if (step === undefined) return false
    return (n - Number(min ?? 0)) % Number(step) !== 0
  }
  return (min !== undefined && value < min) || (max !== undefined && value > max)
}

class FakePage {
  server: Bun.Server<undefined>
  received: Command[] = []
  /** 收到的 `Input.*` 命令条数。失败注入与中途插事都按它计数。 */
  inputs = 0
  model: PageModel = {
    token: 'doc-1',
    url: 'http://fixture/page',
    title: '夹具页',
    docs: [mainDoc()],
    gone: new Set(),
    ownerGone: new Set(),
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
          if (cmd.method.startsWith('Input.') && self.model.dropInputAt === self.inputs + 1) {
            self.inputs += 1
            ws.close()
            return
          }
          // 子帧以子会话形式附加：承载它的那个会话开了自动附加之后才发得出这些事件。
          // 嵌套的跨站帧挂在它父帧的子会话下，所以这里按 `parent` 匹配，不是只认页会话。
          // 有导航在飞的帧由浏览器报出来；页面推迟着的帧一条事件都没有。
          if (cmd.method === 'Page.enable') {
            for (const doc of self.model.docs) {
              if (doc.parent !== cmd.sessionId) continue
              if (!doc.uncommitted || doc.noLoadEvent) continue
              ws.send(
                JSON.stringify({
                  method: 'Page.frameStartedLoading',
                  sessionId: cmd.sessionId,
                  params: { frameId: doc.frame },
                }),
              )
            }
          }
          if (cmd.method === 'Target.setAutoAttach') {
            const attach = (doc: DocModel) => {
              // 导航提交之后才换成独立目标，占位帧同时消失。
              delete doc.uncommitted
              ws.send(
                JSON.stringify({
                  method: 'Target.attachedToTarget',
                  sessionId: doc.parent,
                  params: {
                    sessionId: doc.sessionId,
                    targetInfo: { targetId: doc.frame, type: 'iframe' },
                  },
                }),
              )
            }
            for (const doc of self.model.docs) {
              if (!doc.parent || doc.parent === doc.sessionId) continue
              if (doc.parent !== cmd.sessionId) continue
              const late = doc.attachDelayMs ?? self.model.attachDelayMs
              if (late) setTimeout(() => attach(doc), late)
              else attach(doc)
            }
          }
          const out = self.answer(cmd)
          if (self.model.flipTokenAfter === cmd.method) {
            delete self.model.flipTokenAfter
            self.model.token = 'doc-2'
          }
          const reply = () =>
            ws.send(
              JSON.stringify(
                'error' in out
                  ? { id: cmd.id, error: { code: -32000, message: String(out.error) } }
                  : { id: cmd.id, result: out },
              ),
            )
          // 子会话开域的回包迟到：登记与开完之间的那一段，这个会话答不出 AX 树。
          const slow =
            self.model.childInitDelayMs !== undefined &&
            cmd.method === 'Accessibility.enable' &&
            cmd.sessionId !== MAIN
          if (slow) setTimeout(reply, self.model.childInitDelayMs)
          else reply()
          if (cmd.method.startsWith('Input.')) self.model.onInput?.(self.inputs)
        },
      },
    })
  }

  /**
   * 一个会话的帧树。
   *
   * 已经提交的跨站帧不在里面：它换了渲染进程，父会话的帧树看不到它。尚未提交的
   * 跨站帧还在本进程里，`url` 为空表示它还没提交过任何文档。
   */
  frameTree(doc: DocModel): Record<string, unknown> {
    const kids = this.model.docs.filter(
      (c) => c !== doc && doc.nodes.some((n) => n.backendNodeId === c.owner),
    )
    return {
      frame: {
        id: doc.frame ?? 'frame-main',
        url: doc.uncommitted ? '' : (doc.url ?? 'http://127.0.0.1:1/page'),
      },
      childFrames: kids
        .filter((c) => c.sessionId === doc.sessionId || c.uncommitted)
        .map((c) => this.frameTree(c)),
    }
  }

  docOf(sessionId: string | undefined): DocModel {
    return (
      this.model.docs.find((d) => d.sessionId === sessionId) ?? (this.model.docs[0] as DocModel)
    )
  }

  nodeOf(backendNodeId: number): { doc: DocModel; node: NodeModel } | null {
    for (const doc of this.model.docs) {
      const node = doc.nodes.find((n) => n.backendNodeId === backendNodeId)
      if (node) return { doc, node }
    }
    return null
  }

  /** 节点此刻在它自己文档视口里的矩形。固定定位的不随滚动移动。 */
  rectOf(doc: DocModel, node: NodeModel): Box | null {
    if (!node.box) return null
    return node.fixed ? { ...node.box } : { ...node.box, y: node.box.y - doc.scrollY }
  }

  /** 命中测试：按列表顺序取最后一个盖住这个点的节点。 */
  hitAt(doc: DocModel, x: number, y: number): NodeModel | null {
    let hit: NodeModel | null = null
    for (const node of doc.nodes) {
      const r = this.rectOf(doc, node)
      if (!r) continue
      if (x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height) hit = node
    }
    return hit
  }

  /** 最少必要滚动，逐层传到父文档——与 scrollIntoView 对跨站帧的行为一致。 */
  scrollIntoView(doc: DocModel, node: NodeModel): void {
    const r = this.rectOf(doc, node)
    if (r && !doc.noScroll && !node.fixed) {
      if (r.y < 0) doc.scrollY += r.y
      else if (r.y + r.height > doc.viewport.height) {
        doc.scrollY += r.y + r.height - doc.viewport.height
      }
    }
    if (doc.parent !== undefined && doc.owner !== undefined) {
      const owner = this.nodeOf(doc.owner)
      if (owner) this.scrollIntoView(owner.doc, owner.node)
    }
    this.model.onScroll?.()
  }

  inspect(doc: DocModel, node: NodeModel): Record<string, unknown> {
    const identity = [
      node.tag,
      node.attrs.id ?? '',
      node.attrs.name ?? '',
      node.attrs.type ?? '',
    ].join('|')
    if (this.model.gone.has(node.backendNodeId)) return { connected: false, identity }
    const r = this.rectOf(doc, node) ?? { x: 0, y: 0, width: 0, height: 0 }
    const x = r.x + r.width / 2
    const y = r.y + r.height / 2
    const inView = x >= 0 && y >= 0 && x <= doc.viewport.width && y <= doc.viewport.height
    const hit = inView ? this.hitAt(doc, x, y) : null
    return {
      connected: true,
      identity,
      x,
      y,
      width: r.width,
      height: r.height,
      inView,
      sameTree: hit === node,
      hit: hit ? hit.tag : null,
      hitLabel: hit ? labelOf(hit) : '',
      disabled: node.disabled === true,
      label: labelOf(node),
    }
  }

  framePoint(doc: DocModel, owner: NodeModel, x: number, y: number): Record<string, unknown> {
    const r = this.rectOf(doc, owner) ?? { x: 0, y: 0, width: 0, height: 0 }
    const px = r.x + x
    const py = r.y + y
    const inView = px >= 0 && py >= 0 && px <= doc.viewport.width && py <= doc.viewport.height
    const hit = inView ? this.hitAt(doc, px, py) : null
    return {
      x: px,
      y: py,
      width: r.width,
      height: r.height,
      inView,
      sameTree: hit === owner,
      hit: hit ? hit.tag : null,
      hitLabel: hit ? labelOf(hit) : '',
    }
  }

  options(node: NodeModel, start: number, limit: number): Record<string, unknown> {
    if (node.tag !== 'select') return { ok: false }
    const all = node.options ?? []
    const items: Record<string, unknown>[] = []
    for (let i = start; i < all.length && items.length < limit; i++) {
      const o = all[i] as OptionModel
      items.push({
        label: o.text ?? o.label,
        value: o.value,
        ...(o.disabled || o.groupDisabled ? { disabled: true } : {}),
        ...(o.selected ? { selected: true } : {}),
      })
    }
    return { ok: true, total: all.length, items }
  }

  select(node: NodeModel, value: string): Record<string, unknown> {
    if (node.tag !== 'select') return { ok: false, reason: 'not_select' }
    const all = node.options ?? []
    let index = all.findIndex((o) => o.value === value)
    if (index < 0) index = all.findIndex((o) => (o.text ?? o.label) === value)
    if (index < 0) {
      return {
        ok: false,
        reason: 'no_option',
        total: all.length,
        sample: all.slice(0, 5).map((o) => o.text ?? o.label),
      }
    }
    const one = all[index] as OptionModel
    if (one.disabled || one.groupDisabled) {
      return { ok: false, reason: 'option_disabled', label: one.text ?? one.label }
    }
    for (const o of all) delete o.selected
    one.selected = true
    return { ok: true, value: one.value }
  }

  /** 把一段文本追加到当前焦点控件上。按键与文本插入都落到这里。 */
  insert(doc: DocModel, text: string): void {
    const node = doc.nodes.find((n) => n.backendNodeId === doc.activeElement)
    if (!node) return
    node.value = (node.value ?? '') + text
  }

  typingTarget(doc: DocModel, node: NodeModel): Record<string, unknown> {
    return {
      connected: !this.model.gone.has(node.backendNodeId),
      identity: [node.tag, node.attrs.id ?? '', node.attrs.name ?? '', node.attrs.type ?? ''].join(
        '|',
      ),
      focused: doc.activeElement === node.backendNodeId,
    }
  }

  /**
   * 覆盖输入。按 `FILL_FN` 的判定顺序应答：写前拒绝 → 类型预检 → 写入回读。
   *
   * 预检不通过时 `value` 一个字都不动，这正是「非法值不破坏原值」要验的形状。
   */
  fill(node: NodeModel, value: string): Record<string, unknown> {
    if (node.disabled === true) return { ok: false, reason: 'disabled' }
    if (node.readOnly === true) return { ok: false, reason: 'readonly' }
    const tag = node.tag
    if (tag !== 'input' && tag !== 'textarea') return { ok: false, reason: 'not_fillable' }
    const type = tag === 'textarea' ? 'textarea' : (node.attrs.type ?? 'text')
    if (value === '' && (type === 'range' || type === 'color')) {
      return { ok: false, reason: 'no_empty', type }
    }
    if (type === 'color' && !/^#[0-9a-fA-F]{6}$/.test(value)) {
      return { ok: false, reason: 'bad_format', type }
    }
    const normalized = normalizeValue(node.attrs, type, value)
    if (value !== '' && normalized === '') return { ok: false, reason: 'bad_format', type }
    if (type === 'range' && normalized !== value) {
      return { ok: false, reason: 'clamped', type, value: normalized }
    }
    if (outOfRange(node.attrs, type, normalized)) {
      const limits: Record<string, string> = {}
      for (const attr of ['min', 'max', 'step']) {
        const one = node.attrs[attr]
        if (one !== undefined) limits[attr] = one
      }
      return { ok: false, reason: 'constraint', type, limits }
    }
    node.value = node.rewriteTo ?? normalized
    const after = node.value
    if (after !== normalized) {
      return { ok: false, reason: 'rejected', type, value: after, wanted: normalized }
    }
    return { ok: true, type, value: after, normalized: after !== value }
  }

  answer(cmd: Command): Record<string, unknown> {
    const m = this.model
    const doc = this.docOf(cmd.sessionId)
    if (cmd.method.startsWith('Input.')) {
      this.inputs += 1
      if (m.failInputAt === this.inputs) return { error: '输入事件被拒' }
    }
    switch (cmd.method) {
      case 'DOM.focus': {
        const found = this.nodeOf(Number(cmd.params?.backendNodeId))
        if (!found) return { error: 'Node not found' }
        found.doc.activeElement = found.node.backendNodeId
        return {}
      }
      case 'Input.insertText':
        this.insert(doc, String(cmd.params?.text ?? ''))
        return {}
      case 'Input.dispatchKeyEvent':
        if (cmd.params?.type === 'keyDown' && typeof cmd.params.text === 'string') {
          this.insert(doc, cmd.params.text)
        }
        return {}
      case 'Target.getTargets':
        return { targetInfos: [{ targetId: 't1', type: 'page' }] }
      case 'Target.attachToTarget':
        return { sessionId: MAIN }
      case 'DOM.getDocument':
        return { root: domTree(m.docs, doc) }
      case 'Page.getFrameTree':
        return { frameTree: this.frameTree(doc) }
      case 'Accessibility.getFullAXTree': {
        // 不带 frameId 只覆盖本会话的根帧；同进程子帧要按它自己的编号取。
        const frameId = cmd.params?.frameId
        const scope = frameId === undefined ? doc : (m.docs.find((d) => d.frame === frameId) ?? doc)
        // 导航还没提交的帧此刻承载的是空白文档，它的 AX 树里没有目标页的节点。
        if (scope.uncommitted) return { nodes: [] }
        if (scope.axDelayCalls > 0) {
          scope.axDelayCalls -= 1
          return { nodes: [] }
        }
        return {
          nodes: scope.ax.map((n) => ({
            backendDOMNodeId: n.backendDOMNodeId,
            role: { value: n.role },
            name: { value: n.name },
            ...(n.value !== undefined ? { value: { value: n.value } } : {}),
            ...(n.props
              ? { properties: n.props.map((p) => ({ ...p, value: { value: p.value } })) }
              : {}),
            ...(n.ignored ? { ignored: true } : {}),
          })),
        }
      }
      case 'DOM.getFrameOwner': {
        const frameId = String(cmd.params?.frameId ?? '')
        const child = m.docs.find((d) => d.frame === frameId)
        if (!child || child.parent !== cmd.sessionId || m.ownerGone.has(frameId)) {
          return { error: 'No frame owner here' }
        }
        return { backendNodeId: child.owner }
      }
      case 'DOM.resolveNode': {
        const backend = Number(cmd.params?.backendNodeId)
        if (m.gone.has(backend)) return { error: 'Node not found' }
        return { object: { objectId: `obj-${backend}` } }
      }
      case 'Runtime.callFunctionOn': {
        const backend = Number(String(cmd.params?.objectId ?? '').replace('obj-', ''))
        const found = this.nodeOf(backend)
        if (!found) return { error: 'Node not found' }
        // 页内函数按名字分派：每个都是具名函数声明，改名字要同时改这里。
        const decl = String(cmd.params?.functionDeclaration ?? '')
        const args = (cmd.params?.arguments ?? []) as { value: unknown }[]
        if (decl.includes('qyScrollIntoView')) {
          this.scrollIntoView(found.doc, found.node)
          return { result: { value: true } }
        }
        if (decl.includes('qyFramePoint')) {
          return {
            result: {
              value: this.framePoint(
                found.doc,
                found.node,
                Number(args[0]?.value ?? 0),
                Number(args[1]?.value ?? 0),
              ),
            },
          }
        }
        if (decl.includes('qyOptions')) {
          return {
            result: {
              value: this.options(
                found.node,
                Number(args[0]?.value ?? 0),
                Number(args[1]?.value ?? 0),
              ),
            },
          }
        }
        if (decl.includes('qySelect(')) {
          return { result: { value: this.select(found.node, String(args[0]?.value ?? '')) } }
        }
        if (decl.includes('qyFill')) {
          return { result: { value: this.fill(found.node, String(args[0]?.value ?? '')) } }
        }
        if (decl.includes('qyTypingTarget')) {
          return { result: { value: this.typingTarget(found.doc, found.node) } }
        }
        if (found.node.inspectThrows === true) {
          return {
            result: {},
            exceptionDetails: {
              text: 'Uncaught',
              exception: { description: 'TypeError: el.getBoundingClientRect is not a function' },
            },
          }
        }
        return { result: { value: this.inspect(found.doc, found.node) } }
      }
      case 'Runtime.evaluate': {
        const expr = String(cmd.params?.expression ?? '')
        if (expr === 'document.readyState') return { result: { value: m.readyState ?? 'complete' } }
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

  /** 发给页内函数的调用，按具名函数分。 */
  called(fn: string): Command[] {
    return this.received.filter(
      (c) =>
        c.method === 'Runtime.callFunctionOn' &&
        String(c.params?.functionDeclaration ?? '').includes(fn),
    )
  }

  mouse(): { type: string; x: number; y: number }[] {
    return this.sent('Input.dispatchMouseEvent').map((c) => ({
      type: String(c.params?.type),
      x: Number(c.params?.x),
      y: Number(c.params?.y),
    }))
  }

  /** 鼠标事件的完整形状：按键与按下位决定页面收到的是点击、右键还是拖动。 */
  mouseDetail(): Record<string, unknown>[] {
    return this.sent('Input.dispatchMouseEvent').map((c) => ({
      type: c.params?.type,
      x: c.params?.x,
      y: c.params?.y,
      button: c.params?.button,
      buttons: c.params?.buttons,
      ...(c.params?.clickCount === undefined ? {} : { clickCount: c.params.clickCount }),
    }))
  }

  /** 按键事件的完整形状：修饰位与文本决定页面收到的是字符还是快捷键。 */
  keyEvents(): Record<string, unknown>[] {
    return this.sent('Input.dispatchKeyEvent').map((c) => ({
      type: c.params?.type,
      key: c.params?.key,
      code: c.params?.code,
      modifiers: c.params?.modifiers ?? 0,
      ...(c.params?.text === undefined ? {} : { text: c.params.text }),
    }))
  }

  /** 一个节点此刻的值。输入动作的页面效果按它核对。 */
  valueOf(backendNodeId: number): string {
    return this.nodeOf(backendNodeId)?.node.value ?? ''
  }

  stop(): void {
    this.server.stop(true)
  }
}

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const fn of cleanups.splice(0).reverse()) fn()
})

/** 一个带按钮、输入框、下拉、正文与隐藏上传框的页面。按钮中心落在 (40,20)。 */
function fixtureModel(page: FakePage): void {
  const doc = page.model.docs[0] as DocModel
  doc.nodes = [
    {
      backendNodeId: 10,
      tag: 'button',
      attrs: { id: 'go' },
      box: { x: 0, y: 0, width: 80, height: 40 },
    },
    {
      backendNodeId: 11,
      tag: 'input',
      attrs: { id: 'box', type: 'text', name: 'q' },
      box: { x: 0, y: 60, width: 200, height: 30 },
    },
    {
      backendNodeId: 12,
      tag: 'select',
      attrs: { id: 'pick' },
      box: { x: 0, y: 100, width: 120, height: 30 },
      options: [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b', selected: true },
      ],
    },
    {
      backendNodeId: 13,
      tag: 'span',
      attrs: { id: 'out' },
      box: { x: 0, y: 140, width: 200, height: 20 },
    },
    { backendNodeId: 14, tag: 'div', attrs: { id: 'wrap' } },
    // 隐藏的文件输入：没有矩形，不可命中，上传照样要能走。
    { backendNodeId: 15, tag: 'input', attrs: { id: 'file', type: 'file' } },
  ]
  doc.ax = [
    { backendDOMNodeId: 10, role: 'button', name: '提交' },
    { backendDOMNodeId: 11, role: 'textbox', name: '关键词', value: '' },
    { backendDOMNodeId: 12, role: 'combobox', name: '选择' },
    { backendDOMNodeId: 13, role: 'StaticText', name: '结果：42' },
    { backendDOMNodeId: 14, role: 'generic', name: '' },
    { backendDOMNodeId: 15, role: 'button', name: '选择文件' },
  ]
}

/** 在页面底部加一个视口外的按钮。 */
function addBottomButton(page: FakePage, id = 'bottom'): void {
  const doc = page.model.docs[0] as DocModel
  doc.nodes.push({
    backendNodeId: 70,
    tag: 'button',
    attrs: { id },
    box: { x: 0, y: 2000, width: 100, height: 40 },
  })
  doc.ax.push({ backendDOMNodeId: 70, role: 'button', name: '表单底部' })
}

/** 主文档里放一个跨站 iframe，帧内有一个按钮。 */
function addFrame(page: FakePage, y = 400): void {
  const doc = page.model.docs[0] as DocModel
  doc.nodes.push({
    backendNodeId: 50,
    tag: 'iframe',
    attrs: { id: 'ad', src: 'http://other.test/ad' },
    box: { x: 100, y, width: 400, height: 300 },
  })
  page.model.docs.push({
    sessionId: 'sf1',
    frame: 'frame-a',
    parent: MAIN,
    owner: 50,
    viewport: { width: 400, height: 300 },
    scrollY: 0,
    nodes: [
      {
        backendNodeId: 60,
        tag: 'button',
        attrs: { id: 'inner' },
        box: { x: 10, y: 20, width: 100, height: 30 },
      },
    ],
    ax: [{ backendDOMNodeId: 60, role: 'button', name: '帧内按钮' }],
    axDelayCalls: 0,
  })
}

/**
 * 在 `addFrame` 那个跨站子帧里再放一个跨站 iframe，第三层帧内有一个按钮。
 *
 * 第三层的 iframe 元素只在第二层那个会话的文档里看得见：`pierce` 穿不过渲染进程边界，
 * 主文档快照里没有它。
 */
function addNestedFrame(page: FakePage): void {
  const mid = page.model.docs.find((d) => d.sessionId === 'sf1') as DocModel
  mid.nodes.push({
    backendNodeId: 61,
    tag: 'iframe',
    attrs: { id: 'deep', src: 'http://third.test/inner' },
    box: { x: 10, y: 60, width: 300, height: 200 },
  })
  page.model.docs.push({
    sessionId: 'sf2',
    frame: 'frame-b',
    parent: 'sf1',
    owner: 61,
    viewport: { width: 300, height: 200 },
    scrollY: 0,
    nodes: [
      {
        backendNodeId: 62,
        tag: 'button',
        attrs: { id: 'deep-btn' },
        box: { x: 5, y: 10, width: 100, height: 30 },
      },
    ],
    ax: [{ backendDOMNodeId: 62, role: 'button', name: '第三层按钮' }],
    axDelayCalls: 0,
  })
}

/**
 * 主文档里放一个同进程 iframe，帧内有一个按钮和一段正文。
 *
 * 与 `addFrame` 的差别只有一处：它不另起子会话，`DOM.getDocument` 的 `pierce` 直接
 * 把它的文档带回来。同源 / 同站 iframe 走的就是这条路。
 */
function addSameFrame(page: FakePage, y = 200): void {
  const doc = page.model.docs[0] as DocModel
  doc.nodes.push({
    backendNodeId: 40,
    tag: 'iframe',
    attrs: { id: 'same', src: '/inner' },
    box: { x: 50, y, width: 400, height: 200 },
  })
  page.model.docs.push({
    sessionId: MAIN,
    frame: 'FRAME5AME',
    parent: MAIN,
    owner: 40,
    viewport: { width: 400, height: 200 },
    scrollY: 0,
    nodes: [
      {
        backendNodeId: 41,
        tag: 'button',
        attrs: { id: 'inner-btn' },
        box: { x: 20, y: 30, width: 120, height: 40 },
      },
      {
        backendNodeId: 42,
        tag: 'span',
        attrs: { id: 'inner-out' },
        box: { x: 20, y: 90, width: 120, height: 20 },
      },
    ],
    ax: [
      { backendDOMNodeId: 41, role: 'button', name: '框架内按钮' },
      { backendDOMNodeId: 42, role: 'StaticText', name: '框架内正文' },
    ],
    axDelayCalls: 0,
  })
}

/** 盖住整页的浮层：固定定位，排在最后，命中测试按绘制顺序取它。 */
function addMask(page: FakePage, label: string): void {
  const doc = page.model.docs[0] as DocModel
  doc.nodes.push({
    backendNodeId: 90,
    tag: 'div',
    attrs: { id: 'mask', 'aria-label': label },
    box: { x: 0, y: 0, width: 800, height: 600 },
    fixed: true,
  })
}

function manyOptions(count: number): OptionModel[] {
  return Array.from({ length: count }, (_, i) => ({ label: `选项 ${i}`, value: `v${i}` }))
}

async function connect(page: FakePage): Promise<PageHandle> {
  const client = await CdpClient.connect(page.server.port ?? 0)
  cleanups.push(() => client.close())
  const { sessionId } = await client.attachByMarker('marker-1')
  return { client, sessionId, tabId: 'bt_1' }
}

/** `setup` 在连接之前改模型：子帧的附加事件在页会话开自动附加时一次性发出。 */
async function newPage(
  setup?: (fake: FakePage) => void,
): Promise<{ fake: FakePage; handle: PageHandle }> {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  fixtureModel(fake)
  setup?.(fake)
  const handle = await connect(fake)
  return { fake, handle }
}

const observe = (handle: PageHandle, opts: Parameters<typeof observePage>[1] = {}) =>
  observePage(handle, opts)

/** 在当前观察上做一次动作。tab 与观察编号对这一批用例都是同一份，不逐条重写。 */
const act = (
  handle: PageHandle,
  record: ObservationRecord,
  input: Omit<BrowserActInput, 'tabId' | 'observationId'>,
) => actOnPage(handle, record, { tabId: 'bt_1', observationId: record.observationId, ...input })

/** 加一个表单控件并给它一行 AX，返回它的可访问名。 */
function addField(
  fake: FakePage,
  backendNodeId: number,
  tag: string,
  attrs: Record<string, string>,
  extra: Partial<NodeModel> = {},
): string {
  const doc = fake.model.docs[0] as DocModel
  const name = `字段 ${backendNodeId}`
  doc.nodes.push({
    backendNodeId,
    tag,
    attrs,
    box: { x: 0, y: 200, width: 120, height: 24 },
    ...extra,
  })
  doc.ax.push({ backendDOMNodeId: backendNodeId, role: 'textbox', name })
  return name
}

/** 按可访问名取观察里的编号。 */
function refOf(observation: BrowserObservation, name: string): string {
  return observation.elements.find((e) => e.name === name)?.ref ?? ''
}

test('观察把 AX 语义与节点属性合成一张元素表，无角色的容器不进表', async () => {
  const { fake, handle } = await newPage()

  const { observation } = await observe(handle)
  expect(observation.url).toBe('http://fixture/page')
  expect(observation.title).toBe('夹具页')
  const byName = new Map(observation.elements.map((e) => [e.name, e]))
  expect(byName.get('提交')?.tag).toBe('button')
  expect(byName.get('关键词')?.inputType).toBe('text')
  expect(byName.get('结果：42')?.role).toBe('StaticText')
  // 无角色无名字的容器不占编号——它对模型没有任何可做的事。
  expect(observation.elements.some((e) => e.tag === 'div')).toBe(false)
  expect(observation.truncated).toBe(false)
  // 观察只读：一条滚动命令都不发。
  expect(fake.called('qyScrollIntoView')).toHaveLength(0)
})

test('正文节点上的动作在解析引用时就拒，一条输入事件都不发', async () => {
  const { fake, handle } = await newPage()
  // 文本节点在真实页面上没有 getBoundingClientRect：页内复核函数在它身上抛异常。
  const doc = fake.model.docs[0] as DocModel
  const text = doc.nodes.find((n) => n.backendNodeId === 13) as NodeModel
  text.inspectThrows = true
  const { record, observation } = await observe(handle)
  const ref = refOf(observation, '结果：42')
  expect(ref).not.toBe('')

  for (const action of ['click', 'dblclick', 'rightclick', 'hover', 'type', 'fill'] as const) {
    const err = String(
      await act(handle, record, { action, ref, text: 'x' }).catch((e: Error) => e.message),
    )
    expect(err).toContain(ref)
    expect(err).toContain('不是可操作的节点')
    // 内部异常原文对调用方没有下一步，不许出现在失败说明里。
    expect(err).not.toContain('TypeError')
  }
  expect(fake.sent('Input.dispatchMouseEvent')).toHaveLength(0)
  expect(fake.sent('Input.dispatchKeyEvent')).toHaveLength(0)
  expect(fake.called('qyInspect')).toHaveLength(0)
})

test('页内复核抛异常时给出可判定的失败，不把内部异常原文透出去', async () => {
  const { fake, handle } = await newPage()
  const doc = fake.model.docs[0] as DocModel
  const button = doc.nodes.find((n) => n.backendNodeId === 10) as NodeModel
  const { record, observation } = await observe(handle)
  const ref = refOf(observation, '提交')
  button.inspectThrows = true

  const err = String(
    await act(handle, record, { action: 'click', ref }).catch((e: Error) => e.message),
  )
  expect(err).toContain(`元素 ${ref} 无法在页内定位`)
  expect(err).not.toContain('TypeError')
  expect(fake.sent('Input.dispatchMouseEvent')).toHaveLength(0)
})

test('AX 的展开与选中按实际布尔输出，没有这一项就不写', async () => {
  const { fake, handle } = await newPage()
  const doc = fake.model.docs[0] as DocModel
  doc.ax = [
    {
      backendDOMNodeId: 10,
      role: 'button',
      name: '提交',
      props: [
        { name: 'expanded', value: true },
        { name: 'selected', value: false },
      ],
    },
    { backendDOMNodeId: 11, role: 'textbox', name: '关键词' },
  ]

  const { observation } = await observe(handle)
  const go = observation.elements.find((e) => e.name === '提交')
  expect(go?.expanded).toBe(true)
  expect(go?.selected).toBe(false)
  const box = observation.elements.find((e) => e.name === '关键词')
  expect(box).not.toHaveProperty('expanded')
  expect(box).not.toHaveProperty('selected')
})

test('AX 树首拍为空但 DOM 有可交互元素时，重取后拿到元素，不返回 0', async () => {
  const { fake, handle } = await newPage()
  // 头两次 getFullAXTree 回空树，第三次才给真树——模拟 AX 懒计算刚加载时还没就绪。
  ;(fake.model.docs[0] as DocModel).axDelayCalls = 2

  const { observation } = await observe(handle)
  // 静态表单不得因为首拍空树就返回 0 元素。
  expect(observation.elements.length).toBeGreaterThan(0)
  expect(observation.elements.some((e) => e.name === '提交')).toBe(true)
  // 重取过：第一拍加两次重试。
  expect(fake.sent('Accessibility.getFullAXTree').length).toBeGreaterThanOrEqual(3)
})

test('AX 树始终为空时从 DOM 快照兜底出可交互元素，语义降级但不为 0', async () => {
  const { fake, handle } = await newPage()
  // 超过重取上限都拿不到 AX 树。
  ;(fake.model.docs[0] as DocModel).axDelayCalls = 1000

  const { observation } = await observe(handle)
  // DOM 兜底只收真实可交互标签：button / input / select，span 与 div 不进表。
  const tags = observation.elements.map((e) => e.tag).sort()
  expect(tags).toEqual(['button', 'input', 'input', 'select'])
  expect(observation.elements.some((e) => e.tag === 'div' || e.tag === 'span')).toBe(false)
})

test('真的没有可交互元素的页仍返回 0，不重取也不造假元素', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  const doc = fake.model.docs[0] as DocModel
  // 只有一段正文，一个可交互元素都没有。
  doc.nodes = [{ backendNodeId: 20, tag: 'p', attrs: { id: 'note' } }]
  doc.ax = [{ backendDOMNodeId: 20, role: 'paragraph', name: '说明' }]
  const handle = await connect(fake)

  const { observation } = await observe(handle)
  // 正文进表，可交互元素 0——这是事实，不是缺陷。
  expect(observation.elements.every((e) => e.role !== 'button')).toBe(true)
  // 没有可交互元素就不进重取：只取一次 AX 树。
  expect(fake.sent('Accessibility.getFullAXTree')).toHaveLength(1)
})

test('元素超过上限时如实报截断，offset 取得到后面的', async () => {
  const fake = new FakePage()
  cleanups.push(() => fake.stop())
  const doc = fake.model.docs[0] as DocModel
  doc.nodes = Array.from({ length: 130 }, (_, i) => ({
    backendNodeId: 100 + i,
    tag: 'button',
    attrs: { id: `b${i}` },
  }))
  doc.ax = doc.nodes.map((n, i) => ({
    backendDOMNodeId: n.backendNodeId,
    role: 'button',
    name: `按钮 ${i}`,
  }))
  const handle = await connect(fake)

  const first = await observe(handle)
  expect(first.observation.elements).toHaveLength(120)
  expect(first.observation.truncated).toBe(true)
  const rest = await observe(handle, { offset: 120 })
  expect(rest.observation.elements).toHaveLength(10)
  expect(rest.observation.truncated).toBe(false)
  expect(rest.observation.elements[0]?.name).toBe('按钮 120')
})

test('点击视口外的元素先滚到可见处，再按滚动后的实时坐标发事件', async () => {
  const { fake, handle } = await newPage()
  addBottomButton(fake)
  const { record, observation } = await observe(handle)
  const bottom = observation.elements.find((e) => e.name === '表单底部')
  expect(bottom).toBeDefined()

  const r = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: bottom?.ref ?? '',
  })
  // 最少必要滚动：元素底边贴住视口下沿，不是居中。
  expect((fake.model.docs[0] as DocModel).scrollY).toBe(1440)
  expect(fake.called('qyScrollIntoView')).toHaveLength(1)
  expect(r.point).toEqual({ x: 50, y: 580 })
  expect(fake.mouse()).toEqual([
    { type: 'mouseMoved', x: 50, y: 580 },
    { type: 'mousePressed', x: 50, y: 580 },
    { type: 'mouseReleased', x: 50, y: 580 },
  ])
})

test('滚不动的视口外元素报可视区外，不报被遮，也不发事件', async () => {
  const { fake, handle } = await newPage()
  addBottomButton(fake)
  ;(fake.model.docs[0] as DocModel).noScroll = true
  const { record, observation } = await observe(handle)
  const bottom = observation.elements.find((e) => e.name === '表单底部')

  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: bottom?.ref ?? '',
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserAmbiguousRefError)
  expect(String((err as Error).message)).toContain('可视区外')
  expect(fake.mouse()).toHaveLength(0)
})

test('滚动触发节点替换时判失效，要求重新观察，不照旧点下去', async () => {
  const { fake, handle } = await newPage()
  addBottomButton(fake)
  const { record, observation } = await observe(handle)
  const bottom = observation.elements.find((e) => e.name === '表单底部')
  // 滚动之后页面把这个位置换成了另一个节点。
  fake.model.onScroll = () => {
    const node = fake.nodeOf(70)
    if (node) node.node.attrs = { id: 'other' }
  }

  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: bottom?.ref ?? '',
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserStaleRefError)
  expect(String((err as Error).message)).toContain('滚动后')
  expect(fake.mouse()).toHaveLength(0)
})

test('被浮层盖住时报出遮挡元素的标签与名称，一条鼠标事件都不发', async () => {
  const { fake, handle } = await newPage()
  addMask(fake, '接受 Cookie')
  const { record, observation } = await observe(handle)
  const go = observation.elements.find((e) => e.name === '提交')

  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: go?.ref ?? '',
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserAmbiguousRefError)
  expect(String((err as Error).message)).toContain('div（接受 Cookie）')
  expect(fake.mouse()).toHaveLength(0)
})

test('零尺寸与禁用各自成句，不一律叫被遮', async () => {
  const { fake, handle } = await newPage()
  const doc = fake.model.docs[0] as DocModel
  doc.nodes.push({
    backendNodeId: 80,
    tag: 'button',
    attrs: { id: 'zero' },
    box: { x: 0, y: 200, width: 0, height: 0 },
  })
  doc.ax.push({ backendDOMNodeId: 80, role: 'button', name: '零尺寸' })
  const one = doc.nodes.find((n) => n.backendNodeId === 10)
  if (one) one.disabled = true
  const { record, observation } = await observe(handle)

  const zero = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: observation.elements.find((e) => e.name === '零尺寸')?.ref ?? '',
  }).catch((e: Error) => e.message)
  expect(String(zero)).toContain('尺寸为 0')

  const off = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: observation.elements.find((e) => e.name === '提交')?.ref ?? '',
  }).catch((e: Error) => e.message)
  expect(String(off)).toContain('当前不可用')
  expect(fake.mouse()).toHaveLength(0)
})

test('点击命中时按元素中心发下压与抬起两条事件', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)
  const go = observation.elements.find((e) => e.name === '提交')

  const r = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: go?.ref ?? '',
  })
  expect(r.point).toEqual({ x: 40, y: 20 })
  expect(fake.mouse().map((e) => e.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased'])
  // 已经可见的元素不滚动。
  expect((fake.model.docs[0] as DocModel).scrollY).toBe(0)
})

test('同进程 iframe 的内容进元素表，带帧编号，动作按帧位置发事件', async () => {
  const { fake, handle } = await newPage(addSameFrame)
  const { record, observation } = await observe(handle)

  const inner = observation.elements.find((e) => e.name === '框架内按钮')
  expect(inner?.frame).toBe('FRAME5AME')
  expect(inner?.ref.startsWith('f')).toBe(true)
  // 帧内正文同样要进表：模型靠它读得到框架里的结果。
  expect(observation.elements.some((e) => e.name === '框架内正文')).toBe(true)
  // 主文档的元素照常在同一张表里，编号不带帧前缀。
  expect(observation.elements.find((e) => e.name === '提交')?.frame).toBeUndefined()
  // 这一帧的 AX 树按帧编号取；不带编号的那一次只覆盖根帧。
  const axCalls = fake.sent('Accessibility.getFullAXTree')
  expect(axCalls.some((c) => c.params?.frameId === 'FRAME5AME')).toBe(true)

  // 观察之后父页自己滚了 100：帧的位置现取，不用观察时量到的那一份。
  ;(fake.model.docs[0] as DocModel).scrollY = 100
  const r = await act(handle, record, { action: 'click', ref: inner?.ref ?? '' })
  // 帧内中心 (80,50) + 此刻的 iframe 位置 (50,100)。
  expect(r.point).toEqual({ x: 130, y: 150 })
  expect(fake.mouse()[1]).toEqual({ type: 'mousePressed', x: 130, y: 150 })
})

test('observe 指定同进程帧只回该帧的元素', async () => {
  const { handle } = await newPage(addSameFrame)
  const { observation } = await observe(handle, { frame: 'FRAME5AME' })

  expect(observation.elements.map((e) => e.name)).toEqual(['框架内按钮', '框架内正文'])
  expect(observation.elements.every((e) => e.frame === 'FRAME5AME')).toBe(true)
})

test('父层浮层盖住同进程 iframe 时按遮挡拒绝，一条鼠标事件都不发', async () => {
  const { fake, handle } = await newPage((f) => {
    addSameFrame(f)
    addMask(f, '父层遮罩')
  })
  const { record, observation } = await observe(handle)
  const inner = observation.elements.find((e) => e.name === '框架内按钮')

  const err = await act(handle, record, { action: 'click', ref: inner?.ref ?? '' }).catch(
    (e: Error) => e,
  )
  expect(err).toBeInstanceOf(BrowserAmbiguousRefError)
  expect(String((err as Error).message)).toContain('所在的 iframe')
  expect(fake.mouse()).toHaveLength(0)
})

test('同进程 iframe 已被移除时判定位失败，不把事件发到文档左上角', async () => {
  const { fake, handle } = await newPage(addSameFrame)
  const { record, observation } = await observe(handle)
  const inner = observation.elements.find((e) => e.name === '框架内按钮')

  fake.model.gone.add(40)
  const err = await act(handle, record, { action: 'click', ref: inner?.ref ?? '' }).catch(
    (e: Error) => e,
  )
  expect(err).toBeInstanceOf(BrowserStaleRefError)
  expect(String((err as Error).message)).toContain('iframe')
  expect(fake.mouse()).toHaveLength(0)
})

test('跨站帧的附加事件晚于观察到达时等它就位，帧内元素照样进表', async () => {
  const { fake, handle } = await newPage((f) => {
    addFrame(f)
    // 建页只等主文档 load：这一帧此刻还是本进程里的 about:blank 占位帧。
    ;(f.model.docs[1] as DocModel).uncommitted = true
    f.model.attachDelayMs = 300
  })
  const { observation } = await observe(handle)
  expect(observation.elements.map((e) => e.name)).toContain('帧内按钮')
  expect(observation.elements.find((e) => e.name === '帧内按钮')?.frame).toBe('frame-a')
  expect(observation.framesPending).toBeUndefined()
  // 等的是这一帧就位，不是定长睡眠：主文档快照按间隔重取到它出现为止。
  expect(fake.sent('DOM.getDocument').length).toBeGreaterThan(1)
})

test('子会话开域还没完成时观察等它开完，不把空帧当作没有元素', async () => {
  const { handle } = await newPage((f) => {
    addFrame(f)
    f.model.childInitDelayMs = 300
  })
  const { observation } = await observe(handle)
  expect(observation.elements.map((e) => e.name)).toContain('帧内按钮')
  expect(observation.framesPending).toBeUndefined()
})

test('等满仍未就位的跨站帧按 framesPending 报出，不静默少元素', async () => {
  const { handle } = await newPage((f) => {
    addFrame(f)
    ;(f.model.docs[1] as DocModel).uncommitted = true
    // 超过观察给这一步的预算：这一帧这次采不到。
    f.model.attachDelayMs = 60_000
  })
  const { observation } = await observe(handle)
  expect(observation.elements.map((e) => e.name)).not.toContain('帧内按钮')
  expect(observation.framesPending).toEqual(['frame-a'])
})

test('跨站帧里那一层还没提交时同样要等，第三层元素照样进表', async () => {
  const { handle } = await newPage((f) => {
    addFrame(f)
    addNestedFrame(f)
    const deep = f.model.docs[2] as DocModel
    // 第二层已经就位，第三层还是它文档里的 about:blank 占位帧。
    deep.uncommitted = true
    deep.attachDelayMs = 300
  })
  const { observation } = await observe(handle)
  expect(observation.elements.map((e) => e.name)).toContain('第三层按钮')
  expect(observation.elements.find((e) => e.name === '第三层按钮')?.frame).toBe('frame-b')
  expect(observation.framesPending).toBeUndefined()
})

test('等满仍未就位的第三层帧按 framesPending 报出，不静默少掉整层', async () => {
  const { handle } = await newPage((f) => {
    addFrame(f)
    addNestedFrame(f)
    const deep = f.model.docs[2] as DocModel
    deep.uncommitted = true
    // 超过观察给这一步的预算：这一帧这次采不到。
    deep.attachDelayMs = 60_000
  })
  const { observation } = await observe(handle)
  expect(observation.elements.map((e) => e.name)).toContain('帧内按钮')
  expect(observation.elements.map((e) => e.name)).not.toContain('第三层按钮')
  expect(observation.framesPending).toEqual(['frame-b'])
})

test('页面推迟加载的 iframe 不算未就位，观察不为它等待', async () => {
  const { fake, handle } = await newPage((f) => {
    addFrame(f)
    const frame = f.model.docs[1] as DocModel
    // `loading="lazy"` 还没触发：帧在 DOM 里，没有导航在飞，等多久都不会有内容。
    frame.uncommitted = true
    frame.noLoadEvent = true
    frame.attachDelayMs = 60_000
  })
  const started = Date.now()
  const { observation } = await observe(handle)
  expect(observation.elements.map((e) => e.name)).toContain('提交')
  expect(observation.elements.map((e) => e.name)).not.toContain('帧内按钮')
  expect(observation.framesPending).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(500)
  expect(fake.sent('DOM.getDocument')).toHaveLength(1)
})

test('附上会话时文档还在加载，帧树里尚无文档的帧照样等', async () => {
  const { handle } = await newPage((f) => {
    addFrame(f)
    const frame = f.model.docs[1] as DocModel
    // 导航在附上会话之前就开始了，那条事件已经发完；帧树里它还没有文档。
    frame.uncommitted = true
    frame.noLoadEvent = true
    frame.attachDelayMs = 300
    f.model.readyState = 'loading'
  })
  const { observation } = await observe(handle)
  expect(observation.elements.map((e) => e.name)).toContain('帧内按钮')
  expect(observation.framesPending).toBeUndefined()
})

test('同进程 iframe 已经提交时不算未就位，观察不为它等待', async () => {
  const { fake, handle } = await newPage(addSameFrame)
  const started = Date.now()
  const { observation } = await observe(handle)
  expect(observation.elements.map((e) => e.name)).toContain('框架内按钮')
  expect(observation.framesPending).toBeUndefined()
  expect(Date.now() - started).toBeLessThan(500)
  expect(fake.sent('DOM.getDocument')).toHaveLength(1)
})

test('父页滚过之后，跨站 iframe 里的元素按现取的帧位置发事件', async () => {
  const { fake, handle } = await newPage(addFrame)
  const { record, observation } = await observe(handle)
  const inner = observation.elements.find((e) => e.name === '帧内按钮')
  expect(inner?.frame).toBe('frame-a')

  // 观察之后父页自己滚了 200：观察时记下的帧偏移从此指向另一个位置。
  ;(fake.model.docs[0] as DocModel).scrollY = 200
  const r = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: inner?.ref ?? '',
  })
  // 帧内中心 (60,35) + 此刻的帧位置 (100,200)。用观察时的偏移会得到 y=435。
  expect(r.point).toEqual({ x: 160, y: 235 })
  expect(fake.mouse()[1]).toEqual({ type: 'mousePressed', x: 160, y: 235 })
})

test('iframe 整体在可视区外时把父页一起滚上来，再按现取的位置发事件', async () => {
  const { fake, handle } = await newPage((f) => {
    addFrame(f, 800)
  })
  const { record, observation } = await observe(handle)
  const inner = observation.elements.find((e) => e.name === '帧内按钮')

  const r = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: inner?.ref ?? '',
  })
  // 帧内已经可见，滚动是为了把承载它的 iframe 带进父页可视区。
  expect((fake.model.docs[0] as DocModel).scrollY).toBe(500)
  expect(r.point).toEqual({ x: 160, y: 335 })
})

test('父层浮层盖住 iframe 时按遮挡拒绝，不把事件打到浮层上', async () => {
  const { fake, handle } = await newPage((f) => {
    addFrame(f)
    addMask(f, '登录提示')
  })
  const { record, observation } = await observe(handle)
  const inner = observation.elements.find((e) => e.name === '帧内按钮')

  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: inner?.ref ?? '',
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserAmbiguousRefError)
  expect(String((err as Error).message)).toContain('所在的 iframe')
  expect(String((err as Error).message)).toContain('div（登录提示）')
  expect(fake.mouse()).toHaveLength(0)
})

test('帧的 owner 查不到时报定位失败，不按偏移 0 点到页面左上角', async () => {
  const { fake, handle } = await newPage(addFrame)
  const { record, observation } = await observe(handle)
  const inner = observation.elements.find((e) => e.name === '帧内按钮')

  fake.model.ownerGone.add('frame-a')
  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: inner?.ref ?? '',
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserStaleRefError)
  expect(String((err as Error).message)).toContain('iframe')
  expect(fake.mouse()).toHaveLength(0)
})

test('换过文档之后整份观察失效，不重新定位到同名元素', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)
  const go = observation.elements.find((e) => e.name === '提交')

  fake.model.token = 'doc-2'
  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: go?.ref ?? '',
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserStaleRefError)
  expect(String((err as Error).message)).toContain('重新观察')
})

test('换过文档之后不带元素的 press 同样被拒，一条按键事件都不发', async () => {
  const { fake, handle } = await newPage()
  const { record } = await observe(handle)

  fake.model.token = 'doc-2'
  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'press',
    key: 'Enter',
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserStaleRefError)
  expect(fake.sent('Input.dispatchKeyEvent')).toHaveLength(0)
})

test('换过文档之后不带元素的 scroll 同样被拒，一条鼠标事件都不发', async () => {
  const { fake, handle } = await newPage()
  const { record } = await observe(handle)

  fake.model.token = 'doc-2'
  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'scroll',
    deltaY: 200,
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserStaleRefError)
  expect(fake.mouse()).toHaveLength(0)
})

test('采集中途换了文档就整份丢掉重采，不登记旧令牌配新元素的观察', async () => {
  const { fake, handle } = await newPage()
  // 第一趟采完 AX 树之后换文档：采集前读到 doc-1，采集后读到 doc-2。
  fake.model.flipTokenAfter = 'Accessibility.getFullAXTree'

  const { record, observation } = await observe(handle)
  // 重采过一趟，登记的是换文档之后那一份。
  expect(fake.sent('DOM.getDocument')).toHaveLength(2)
  expect(record.docToken).toBe('doc-2')
  expect(observation.observationId).toContain('doc-2')
})

test('预算已经耗尽时不发采集命令，报可判定的失败', async () => {
  const { fake, handle } = await newPage()
  const before = fake.sent('DOM.getDocument').length

  const err = await observePage(handle, { deadline: Date.now() - 1 }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserObserveTimeoutError)
  expect(fake.sent('DOM.getDocument')).toHaveLength(before)
})

test('同一个编号指到另一个节点时判失效，不照旧点下去', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)
  const go = observation.elements.find((e) => e.name === '提交')

  // backendNodeId 被复用到了另一个节点：标签与 id 都变了。
  const node = fake.nodeOf(10)
  if (node) {
    node.node.tag = 'a'
    node.node.attrs = { id: 'other' }
  }
  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: go?.ref ?? '',
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserStaleRefError)
  expect(fake.mouse()).toHaveLength(0)
})

test('节点已从文档移除时报失效', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)
  const go = observation.elements.find((e) => e.name === '提交')

  fake.model.gone.add(10)
  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'click',
    ref: go?.ref ?? '',
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserStaleRefError)
})

test('fill 在控件上覆盖写入，不借按键也不借鼠标', async () => {
  const { fake, handle } = await newPage()
  const box = fake.nodeOf(11)
  if (box) box.node.value = '旧值'
  const { record, observation } = await observe(handle)

  const r = await act(handle, record, {
    action: 'fill',
    ref: refOf(observation, '关键词'),
    text: '批一',
  })
  expect(r.element).toBe('box')
  expect(fake.valueOf(11)).toBe('批一')
  expect(fake.called('qyFill')[0]?.params?.arguments).toEqual([{ value: '批一' }])
  // 覆盖输入不发按键、不发鼠标、不滚动页面。
  expect(fake.sent('Input.dispatchKeyEvent')).toHaveLength(0)
  expect(fake.mouse()).toHaveLength(0)
  expect(fake.called('qyScrollIntoView')).toHaveLength(0)
})

test('press 认不出的写法一条事件都不发', async () => {
  const { fake, handle } = await newPage()
  const { record } = await observe(handle)

  for (const key of ['Ctrl+Ctrl+A', 'Ctrl+', 'Hyper+A', 'F13', '']) {
    const err = await act(handle, record, { action: 'press', key }).catch((e: Error) => e.message)
    expect(String(err)).toContain('不支持的按键')
  }
  expect(fake.sent('Input.dispatchKeyEvent')).toHaveLength(0)

  await act(handle, record, { action: 'press', key: 'Enter' })
  expect(fake.sent('Input.dispatchKeyEvent').map((c) => c.params?.type)).toEqual([
    'keyDown',
    'keyUp',
  ])
})

test('scroll 不给元素时作用在整页上', async () => {
  const { fake, handle } = await newPage()
  const { record } = await observe(handle)

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

test('scroll 落在元素上时用实时坐标，但不为它滚动页面', async () => {
  const { fake, handle } = await newPage()
  addBottomButton(fake)
  const { record, observation } = await observe(handle)
  const bottom = observation.elements.find((e) => e.name === '表单底部')

  await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'scroll',
    ref: bottom?.ref ?? '',
    deltaY: 120,
  })
  expect(fake.called('qyScrollIntoView')).toHaveLength(0)
  expect(fake.sent('Input.dispatchMouseEvent')[0]?.params?.type).toBe('mouseWheel')
})

test('等待只观察，结束后清掉页内等待器', async () => {
  const { fake, handle } = await newPage()

  fake.waiterResult = { found: false, reason: 'timeout', id: 7 }
  expect(await waitOnPage(handle, '#late', 500)).toEqual({ found: false, reason: 'timeout' })
  const evaluated = fake.sent('Runtime.evaluate').map((c) => String(c.params?.expression))
  expect(evaluated.some((e) => e.includes('__qyworkWait('))).toBe(true)
  expect(evaluated.some((e) => e.includes('__qyworkDispose('))).toBe(true)
  // 等待期间不发任何输入事件。
  expect(fake.mouse()).toHaveLength(0)
  expect(fake.sent('Input.dispatchKeyEvent')).toHaveLength(0)
})

test('上传把路径原样交给隐藏的文件输入元素，不要求它可见', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)
  const file = observation.elements.find((e) => e.name === '选择文件')

  const r = await uploadToPage(handle, record, file?.ref ?? '', ['C:/ws/a.txt'])
  expect(r.files).toEqual(['C:/ws/a.txt'])
  const sent = fake.sent('DOM.setFileInputFiles')[0]
  expect(sent?.params?.files).toEqual(['C:/ws/a.txt'])
  expect(sent?.params?.backendNodeId).toBe(15)
  // 隐藏控件不滚动、不做命中裁决。
  expect(fake.called('qyScrollIntoView')).toHaveLength(0)
})

test('下载点击与普通点击同一套定位与说明', async () => {
  const { fake, handle } = await newPage()
  addBottomButton(fake, 'dl')
  const { record, observation } = await observe(handle)
  const bottom = observation.elements.find((e) => e.name === '表单底部')

  const r = await clickForDownload(handle, record, bottom?.ref ?? '')
  expect(r.point).toEqual({ x: 50, y: 580 })
  expect(fake.called('qyScrollIntoView')).toHaveLength(1)

  addMask(fake, '接受 Cookie')
  const err = await clickForDownload(handle, record, bottom?.ref ?? '').catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserAmbiguousRefError)
  expect(String((err as Error).message)).toContain('div（接受 Cookie）')
})

test('select 的选项摘要按当前 DOM 给，超过上限时如实报截断', async () => {
  const { fake, handle } = await newPage()
  const pick = fake.nodeOf(12)
  const options = manyOptions(42)
  // label 属性与正文不同、optgroup 整组禁用、当前选中项都要如实反映。
  options[0] = { label: '正文', text: '标签属性', value: 'v0' }
  options[1] = { label: '选项 1', value: 'v1', groupDisabled: true }
  options[2] = { label: '选项 2', value: 'v2', selected: true }
  if (pick) pick.node.options = options
  const { observation } = await observe(handle)

  const el = observation.elements.find((e) => e.tag === 'select')
  expect(el?.optionsTotal).toBe(42)
  expect(el?.optionsTruncated).toBe(true)
  expect(el?.options).toHaveLength(30)
  expect(el?.options?.[0]).toEqual({ label: '标签属性', value: 'v0' })
  expect(el?.options?.[1]).toEqual({ label: '选项 1', value: 'v1', disabled: true })
  expect(el?.options?.[2]).toEqual({ label: '选项 2', value: 'v2', selected: true })
})

test('一份观察里的选项摘要有合计上限，超出的仍给出总数与截断标记', async () => {
  const { fake, handle } = await newPage()
  const doc = fake.model.docs[0] as DocModel
  for (const i of [1, 2, 3]) {
    doc.nodes.push({
      backendNodeId: 30 + i,
      tag: 'select',
      attrs: { id: `s${i}` },
      box: { x: 0, y: 300 + i * 20, width: 100, height: 20 },
      options: manyOptions(40),
    })
    doc.ax.push({ backendDOMNodeId: 30 + i, role: 'combobox', name: `下拉 ${i}` })
  }
  const pick = fake.nodeOf(12)
  if (pick) pick.node.options = manyOptions(40)
  const { observation } = await observe(handle)

  const counts = observation.elements
    .filter((e) => e.tag === 'select')
    .map((e) => e.options?.length ?? 0)
  expect(counts).toEqual([30, 30, 30, 10])
  expect(counts.reduce((a, b) => a + b, 0)).toBe(100)
  for (const el of observation.elements.filter((e) => e.tag === 'select')) {
    expect(el.optionsTotal).toBe(40)
    expect(el.optionsTruncated).toBe(true)
  }
})

test('optionsFor 按旧观察读后续选项，不发新编号也不移动页面', async () => {
  const { fake, handle } = await newPage()
  const pick = fake.nodeOf(12)
  if (pick) pick.node.options = manyOptions(42)
  const { record, observation } = await observe(handle)
  const el = observation.elements.find((e) => e.tag === 'select')
  const scrollBefore = (fake.model.docs[0] as DocModel).scrollY

  const first = await readSelectOptions(handle, record, el?.ref ?? '', 0)
  expect(first.total).toBe(42)
  expect(first.items).toHaveLength(30)
  expect(first.offset).toBe(0)
  expect(first.nextOffset).toBe(30)
  expect(first.observationId).toBe(record.observationId)
  expect(first.tabId).toBe('bt_1')

  const rest = await readSelectOptions(handle, record, el?.ref ?? '', 30)
  expect(rest.items).toHaveLength(12)
  expect(rest.items[11]?.value).toBe('v41')
  expect(rest.nextOffset).toBeUndefined()
  // 读选项不滚页面，也不重新采集元素表。
  expect((fake.model.docs[0] as DocModel).scrollY).toBe(scrollBefore)
  expect(fake.called('qyScrollIntoView')).toHaveLength(0)
  expect(fake.sent('DOM.getDocument')).toHaveLength(1)
})

test('optionsFor 的引用失效时要求重新观察', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)
  const el = observation.elements.find((e) => e.tag === 'select')

  const missing = await readSelectOptions(handle, record, 'e999', 0).catch((e: Error) => e)
  expect(missing).toBeInstanceOf(BrowserStaleRefError)

  fake.model.token = 'doc-2'
  const stale = await readSelectOptions(handle, record, el?.ref ?? '', 0).catch((e: Error) => e)
  expect(stale).toBeInstanceOf(BrowserStaleRefError)
  expect(String((stale as Error).message)).toContain('重新观察')
})

test('optionsFor 指向的不是选择框时明确报错', async () => {
  const { handle } = await newPage()
  const { record, observation } = await observe(handle)
  const go = observation.elements.find((e) => e.name === '提交')

  const err = await readSelectOptions(handle, record, go?.ref ?? '', 0).catch((e: Error) => e)
  expect(String((err as Error).message)).toContain('不是选择框')
})

test('select 选不中时只给总数、有界样例与继续读取的出口，不回完整列表', async () => {
  const { fake, handle } = await newPage()
  const pick = fake.nodeOf(12)
  if (pick) pick.node.options = manyOptions(42)
  const { record, observation } = await observe(handle)
  const el = observation.elements.find((e) => e.tag === 'select')

  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'select',
    ref: el?.ref ?? '',
    text: '不存在',
  }).catch((e: Error) => e.message)
  const message = String(err)
  expect(message).toContain('共 42 项')
  expect(message).toContain('选项 0')
  expect(message).toContain('optionsFor')
  // 有界：末尾那些选项不在错误里。
  expect(message).not.toContain('选项 41')
  expect(message.length).toBeLessThan(200)
})

test('select 选中被禁用的选项时明确拒绝，不报成没有这个选项', async () => {
  const { fake, handle } = await newPage()
  const pick = fake.nodeOf(12)
  if (pick) {
    pick.node.options = [
      { label: '可选', value: 'a' },
      { label: '停售', value: 'b', groupDisabled: true },
    ]
  }
  const { record, observation } = await observe(handle)
  const el = observation.elements.find((e) => e.tag === 'select')

  const err = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'select',
    ref: el?.ref ?? '',
    text: 'b',
  }).catch((e: Error) => e.message)
  expect(String(err)).toContain('不可选')

  const ok = await actOnPage(handle, record, {
    tabId: 'bt_1',
    observationId: record.observationId,
    action: 'select',
    ref: el?.ref ?? '',
    text: '可选',
  })
  expect(ok.element).toBe('pick')
})

/** 一对可拖动的条目：卡片中心 (50,220)，目标槽中心 (250,280)。 */
function addDragPair(fake: FakePage, slotY = 260): void {
  const doc = fake.model.docs[0] as DocModel
  doc.nodes.push(
    {
      backendNodeId: 40,
      tag: 'li',
      attrs: { id: 'card' },
      box: { x: 0, y: 200, width: 100, height: 40 },
    },
    {
      backendNodeId: 41,
      tag: 'li',
      attrs: { id: 'slot' },
      box: { x: 200, y: slotY, width: 100, height: 40 },
    },
  )
  doc.ax.push(
    { backendDOMNodeId: 40, role: 'option', name: '卡片' },
    { backendDOMNodeId: 41, role: 'option', name: '目标槽' },
  )
}

test('hover 只发一条 mouseMoved，不按下也不抬起', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)

  const r = await act(handle, record, { action: 'hover', ref: refOf(observation, '提交') })
  expect(r.point).toEqual({ x: 40, y: 20 })
  expect(fake.mouseDetail()).toEqual([
    { type: 'mouseMoved', x: 40, y: 20, button: 'none', buttons: 0 },
  ])
  // 单事件动作不带执行回执。
  expect(r.execution).toBeUndefined()
})

test('hover 的视口外元素同样先滚到可见处再按实时坐标发', async () => {
  const { fake, handle } = await newPage()
  addBottomButton(fake)
  const { record, observation } = await observe(handle)

  const r = await act(handle, record, { action: 'hover', ref: refOf(observation, '表单底部') })
  expect(fake.called('qyScrollIntoView')).toHaveLength(1)
  expect(r.point).toEqual({ x: 50, y: 580 })
})

test('rightclick 用右键发按下抬起，定位与左键同一套', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)

  await act(handle, record, { action: 'rightclick', ref: refOf(observation, '提交') })
  expect(fake.mouseDetail()).toEqual([
    { type: 'mouseMoved', x: 40, y: 20, button: 'none', buttons: 0 },
    { type: 'mousePressed', x: 40, y: 20, button: 'right', buttons: 2, clickCount: 1 },
    { type: 'mouseReleased', x: 40, y: 20, button: 'right', buttons: 0, clickCount: 1 },
  ])
})

test('dblclick 发两轮按下抬起，clickCount 依次 1 与 2', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)

  const r = await act(handle, record, { action: 'dblclick', ref: refOf(observation, '提交') })
  expect(fake.mouseDetail()).toEqual([
    { type: 'mouseMoved', x: 40, y: 20, button: 'none', buttons: 0 },
    { type: 'mousePressed', x: 40, y: 20, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseReleased', x: 40, y: 20, button: 'left', buttons: 0, clickCount: 1 },
    { type: 'mousePressed', x: 40, y: 20, button: 'left', buttons: 1, clickCount: 2 },
    { type: 'mouseReleased', x: 40, y: 20, button: 'left', buttons: 0, clickCount: 2 },
  ])
  expect(r.execution).toEqual({ state: 'completed', confirmedUnits: 2 })
})

test('dblclick 第二轮注入失败时回 partial，并把按下的键补抬起', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)
  // 第 1 条是按下之前的移动，第 4 条才是第二轮的按下：它被拒之后页面上只发生了第一轮。
  fake.model.failInputAt = 4

  const r = await act(handle, record, { action: 'dblclick', ref: refOf(observation, '提交') })
  expect(r.execution).toEqual({ state: 'partial', confirmedUnits: 1 })
  // 按下已经登记，收尾补一条抬起，页面不留按住状态。
  expect(fake.mouseDetail().at(-1)).toEqual({
    type: 'mouseReleased',
    x: 40,
    y: 20,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
})

test('组合键按修饰键、主键、逆序抬起的顺序发，modifiers 与当时按下集合一致', async () => {
  const { fake, handle } = await newPage()
  const { record } = await observe(handle)

  await act(handle, record, { action: 'press', key: 'Ctrl+A' })
  // Ctrl+A 说的是 Ctrl 加 A 键：不补 Shift，页面看到的 key 是 a。含 Ctrl 时主键不附文本。
  expect(fake.keyEvents()).toEqual([
    { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', modifiers: 2 },
    { type: 'rawKeyDown', key: 'a', code: 'KeyA', modifiers: 2 },
    { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 },
    { type: 'keyUp', key: 'Control', code: 'ControlLeft', modifiers: 0 },
  ])
})

test('Shift+Tab 与 Ctrl+Shift+Enter 的修饰位按当时按下集合算', async () => {
  const { fake, handle } = await newPage()
  const { record } = await observe(handle)

  await act(handle, record, { action: 'press', key: 'Shift+Tab' })
  expect(fake.keyEvents()).toEqual([
    { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8 },
    { type: 'rawKeyDown', key: 'Tab', code: 'Tab', modifiers: 8 },
    { type: 'keyUp', key: 'Tab', code: 'Tab', modifiers: 8 },
    { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 0 },
  ])

  const { fake: two, handle: handleTwo } = await newPage()
  const second = await observe(handleTwo)
  await act(handleTwo, second.record, { action: 'press', key: 'Ctrl+Shift+Enter' })
  expect(two.keyEvents().map((e) => [e.key, e.modifiers])).toEqual([
    ['Control', 2],
    ['Shift', 10],
    ['Enter', 10],
    ['Enter', 10],
    ['Shift', 2],
    ['Control', 0],
  ])
})

test('加号写 Plus，大写字母与标点按 Shift 发，键码取物理键', async () => {
  const { fake, handle } = await newPage()
  const { record } = await observe(handle)

  await act(handle, record, { action: 'press', key: 'Ctrl+Plus' })
  expect(fake.keyEvents().map((e) => [e.key, e.code, e.modifiers])).toEqual([
    ['Control', 'ControlLeft', 2],
    ['Shift', 'ShiftLeft', 10],
    ['+', 'Equal', 10],
    ['+', 'Equal', 10],
    ['Shift', 'ShiftLeft', 2],
    ['Control', 'ControlLeft', 0],
  ])

  const { fake: two, handle: handleTwo } = await newPage()
  const second = await observe(handleTwo)
  await act(handleTwo, second.record, { action: 'press', key: 'A' })
  // 不带其他修饰键时大写字母补 Shift，页面才收到 A；虚拟键码是物理 A 键的 65。
  expect(two.keyEvents()).toEqual([
    { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8 },
    { type: 'keyDown', key: 'A', code: 'KeyA', modifiers: 8, text: 'A' },
    { type: 'keyUp', key: 'A', code: 'KeyA', modifiers: 8 },
    { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', modifiers: 0 },
  ])
  expect(two.sent('Input.dispatchKeyEvent')[1]?.params?.windowsVirtualKeyCode).toBe(65)
})

test('type 在当前内容后逐字输入，不全选也不清空', async () => {
  const { fake, handle } = await newPage()
  const box = fake.nodeOf(11)
  if (box) box.node.value = '旧'
  const { record, observation } = await observe(handle)

  const r = await act(handle, record, {
    action: 'type',
    ref: refOf(observation, '关键词'),
    text: 'ab',
  })
  expect(fake.keyEvents()).toEqual([
    { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 0, text: 'a' },
    { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 0 },
    { type: 'keyDown', key: 'b', code: 'KeyB', modifiers: 0, text: 'b' },
    { type: 'keyUp', key: 'b', code: 'KeyB', modifiers: 0 },
  ])
  // 原有内容还在：覆盖是 fill 的事。
  expect(fake.valueOf(11)).toBe('旧ab')
  expect(r.execution).toEqual({ state: 'completed', confirmedUnits: 2 })
})

test('布局表外的码点走文本插入，一个码点一条，emoji 不被拆开', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)

  const r = await act(handle, record, {
    action: 'type',
    ref: refOf(observation, '关键词'),
    text: '中a🙂',
  })
  expect(fake.sent('Input.insertText').map((c) => c.params?.text)).toEqual(['中', '🙂'])
  expect(fake.keyEvents().map((e) => e.key)).toEqual(['a', 'a'])
  expect(fake.valueOf(11)).toBe('中a🙂')
  expect(r.execution).toEqual({ state: 'completed', confirmedUnits: 3 })
})

test('type 的换行按 Enter 发，CRLF 先归一', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)

  await act(handle, record, { action: 'type', ref: refOf(observation, '关键词'), text: 'a\r\nb' })
  expect(fake.keyEvents().map((e) => e.key)).toEqual(['a', 'a', 'Enter', 'Enter', 'b', 'b'])
})

test('type 超过码点上限或含控制字符时预检拒绝，一条事件都不发', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)
  const ref = refOf(observation, '关键词')

  const long = await act(handle, record, {
    action: 'type',
    ref,
    text: 'a'.repeat(2001),
  }).catch((e: Error) => e.message)
  expect(String(long)).toContain('2000')

  const bad = await act(handle, record, { action: 'type', ref, text: 'a\u0000b' }).catch(
    (e: Error) => e.message,
  )
  expect(String(bad)).toContain('U+0000')
  expect(fake.inputs).toBe(0)
})

test('type 中途目标被换掉就停下，回执是已确认的前缀', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)
  // 第 2 条输入事件是第一个字符的抬起：这之后把目标换成另一个节点。
  fake.model.onInput = (nth) => {
    if (nth !== 2) return
    const found = fake.nodeOf(11)
    if (found) found.node.attrs = { ...found.node.attrs, id: 'other' }
  }

  const r = await act(handle, record, {
    action: 'type',
    ref: refOf(observation, '关键词'),
    text: 'abc',
  })
  expect(r.execution).toEqual({ state: 'partial', confirmedUnits: 1 })
  // 页面上确实只进了一个字符，回执与它一致。
  expect(fake.valueOf(11)).toBe('a')
})

test('type 第 N 个单元被拒时回 partial，页面效果与回执一致', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)
  // 第 3 条输入事件是第二个字符的按下。
  fake.model.failInputAt = 3

  const r = await act(handle, record, {
    action: 'type',
    ref: refOf(observation, '关键词'),
    text: 'abc',
  })
  expect(r.execution).toEqual({ state: 'partial', confirmedUnits: 1 })
  expect(fake.valueOf(11)).toBe('a')
})

test('输入事件入网之后连接断了回 unknown，不缩成已确认的前缀', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)
  // 第 3 条输入事件是第二个字符的按下：它发出去了，回包永远不来。
  fake.model.dropInputAt = 3

  const r = await act(handle, record, {
    action: 'type',
    ref: refOf(observation, '关键词'),
    text: 'abc',
  })
  expect(r.execution).toEqual({ state: 'unknown', confirmedUnits: 1 })
})

test('type 中途取消之后不再发业务事件，回执不报完成', async () => {
  const { fake, handle } = await newPage()
  const { record, observation } = await observe(handle)
  fake.model.onInput = (nth) => {
    if (nth === 2) void handle.client.cancel('测试取消')
  }

  const r = await act(handle, record, {
    action: 'type',
    ref: refOf(observation, '关键词'),
    text: 'abcdef',
  })
  expect(r.execution?.state).not.toBe('completed')
  // 取消之后一条业务按键都不再发出去。
  expect(fake.keyEvents()).toHaveLength(2)
  expect(fake.valueOf(11)).toBe('a')
})

test('fill 的日期：合法值写进去，非法值预检拒绝且原值不动，空串是清空', async () => {
  const { fake, handle } = await newPage()
  addField(fake, 20, 'input', { id: 'day', type: 'date' }, { value: '2026-01-01' })
  const { record, observation } = await observe(handle)
  const ref = refOf(observation, '字段 20')

  await act(handle, record, { action: 'fill', ref, text: '2026-03-01' })
  expect(fake.valueOf(20)).toBe('2026-03-01')

  const err = await act(handle, record, { action: 'fill', ref, text: '2026-02-30' }).catch(
    (e: Error) => e.message,
  )
  expect(String(err)).toContain('date 类型接受的格式')
  expect(fake.valueOf(20)).toBe('2026-03-01')

  await act(handle, record, { action: 'fill', ref, text: '' })
  expect(fake.valueOf(20)).toBe('')
})

test('fill 的 datetime-local 按类型规范化，回执带写进去的值与它经过规范化', async () => {
  const { fake, handle } = await newPage()
  addField(fake, 21, 'input', { id: 'when', type: 'datetime-local' })
  const { record, observation } = await observe(handle)

  const receipt = await act(handle, record, {
    action: 'fill',
    ref: refOf(observation, '字段 21'),
    text: '2026-03-01T09:30:00',
  })
  expect(fake.valueOf(21)).toBe('2026-03-01T09:30')
  expect(receipt).toMatchObject({ value: '2026-03-01T09:30', normalized: true })

  const same = await act(handle, record, {
    action: 'fill',
    ref: refOf(observation, '字段 21'),
    text: '2026-03-01T09:30',
  })
  expect(same).toMatchObject({ value: '2026-03-01T09:30', normalized: false })
})

test('fill 的 color 只认 #rrggbb，颜色名在写入前拒绝且原值不动', async () => {
  const { fake, handle } = await newPage()
  addField(fake, 25, 'input', { id: 'hue', type: 'color' }, { value: '#112233' })
  const { record, observation } = await observe(handle)
  const ref = refOf(observation, '字段 25')

  // 页面对 red 给得出 #ff0000：按「规范化结果非空」判会放行，写进去的是另一个值。
  const err = await act(handle, record, { action: 'fill', ref, text: 'red' }).catch(
    (e: Error) => e.message,
  )
  expect(String(err)).toContain('不是 color 类型接受的格式')
  expect(fake.valueOf(25)).toBe('#112233')

  const receipt = await act(handle, record, { action: 'fill', ref, text: '#00FF00' })
  expect(fake.valueOf(25)).toBe('#00ff00')
  expect(receipt).toMatchObject({ value: '#00ff00', normalized: true })
})

test('fill 的 number 越界按约束拒绝，清空照常放行', async () => {
  const { fake, handle } = await newPage()
  addField(fake, 22, 'input', { id: 'n', type: 'number', min: '1', max: '10' }, { value: '5' })
  const { record, observation } = await observe(handle)
  const ref = refOf(observation, '字段 22')

  const err = await act(handle, record, { action: 'fill', ref, text: '99' }).catch(
    (e: Error) => e.message,
  )
  expect(String(err)).toContain('min=1、max=10')
  expect(fake.valueOf(22)).toBe('5')

  await act(handle, record, { action: 'fill', ref, text: '' })
  expect(fake.valueOf(22)).toBe('')
})

test('number 约束不满足时报控件上的 min / max / step，不报被拒的那个值', async () => {
  const { fake, handle } = await newPage()
  addField(
    fake,
    26,
    'input',
    { id: 'step', type: 'number', min: '0', max: '100', step: '5' },
    { value: '10' },
  )
  const { record, observation } = await observe(handle)
  const ref = refOf(observation, '字段 26')

  const err = String(
    await act(handle, record, { action: 'fill', ref, text: '12' }).catch((e: Error) => e.message),
  )
  expect(err).toContain('min=0、max=100、step=5')
  // number 不钳制，规范化之后仍是 12：把它当成「能接受的值」给出来等于让调用方原样重试。
  expect(err).not.toContain('能接受的是 12')
  expect(err).not.toContain('能写入的是 12')
  expect(fake.valueOf(26)).toBe('10')

  await act(handle, record, { action: 'fill', ref, text: '15' })
  expect(fake.valueOf(26)).toBe('15')
})

test('fill 的 range 越界按约束拒绝，不接受静默钳到边界；它也不能清空', async () => {
  const { fake, handle } = await newPage()
  addField(fake, 23, 'input', { id: 'vol', type: 'range', min: '0', max: '100' }, { value: '30' })
  const { record, observation } = await observe(handle)
  const ref = refOf(observation, '字段 23')

  const over = await act(handle, record, { action: 'fill', ref, text: '500' }).catch(
    (e: Error) => e.message,
  )
  expect(String(over)).toContain('100')
  expect(fake.valueOf(23)).toBe('30')

  const empty = await act(handle, record, { action: 'fill', ref, text: '' }).catch(
    (e: Error) => e.message,
  )
  expect(String(empty)).toContain('没有空值')
  expect(fake.valueOf(23)).toBe('30')

  await act(handle, record, { action: 'fill', ref, text: '80' })
  expect(fake.valueOf(23)).toBe('80')
})

test('fill 在只读与禁用控件上写入前就拒绝', async () => {
  const { fake, handle } = await newPage()
  addField(fake, 24, 'input', { id: 'ro', type: 'text' }, { value: '锁住', readOnly: true })
  addField(fake, 25, 'input', { id: 'off', type: 'text' }, { value: '停用', disabled: true })
  const { record, observation } = await observe(handle)

  const readOnly = await act(handle, record, {
    action: 'fill',
    ref: refOf(observation, '字段 24'),
    text: '新值',
  }).catch((e: Error) => e.message)
  expect(String(readOnly)).toContain('只读')
  expect(fake.valueOf(24)).toBe('锁住')

  const disabled = await act(handle, record, {
    action: 'fill',
    ref: refOf(observation, '字段 25'),
    text: '新值',
  }).catch((e: Error) => e.message)
  expect(String(disabled)).toContain('不可用')
  expect(fake.valueOf(25)).toBe('停用')
})

test('fill 之后页面把值改回去时如实说写入已经发出，不报成功', async () => {
  const { fake, handle } = await newPage()
  addField(fake, 26, 'input', { id: 'ctrl', type: 'text' }, { rewriteTo: '框架值' })
  const { record, observation } = await observe(handle)

  const err = await act(handle, record, {
    action: 'fill',
    ref: refOf(observation, '字段 26'),
    text: '想写的',
  }).catch((e: Error) => e.message)
  expect(String(err)).toContain('写入已经发到页面上')
  expect(String(err)).toContain('框架值')
  expect(fake.valueOf(26)).toBe('框架值')
})

test('drag 按下后每条移动带 buttons 1，最后抬起清为 0', async () => {
  const { fake, handle } = await newPage(addDragPair)
  const { record, observation } = await observe(handle)

  const r = await act(handle, record, {
    action: 'drag',
    ref: refOf(observation, '卡片'),
    toRef: refOf(observation, '目标槽'),
  })
  expect(fake.mouseDetail()).toEqual([
    // 按下之前先把指针移到起点，这一条不计入执行回执的单元数。
    { type: 'mouseMoved', x: 50, y: 220, button: 'none', buttons: 0 },
    { type: 'mousePressed', x: 50, y: 220, button: 'left', buttons: 1, clickCount: 1 },
    { type: 'mouseMoved', x: 150, y: 250, button: 'left', buttons: 1 },
    { type: 'mouseMoved', x: 250, y: 280, button: 'left', buttons: 1 },
    { type: 'mouseReleased', x: 250, y: 280, button: 'left', buttons: 0, clickCount: 1 },
  ])
  expect(r.point).toEqual({ x: 50, y: 220 })
  expect(r.execution).toEqual({ state: 'completed', confirmedUnits: 4 })
})

test('终点在视口外时先滚终点再滚起点，坐标一律按滚完之后现取', async () => {
  const { fake, handle } = await newPage((f) => {
    addDragPair(f, 2000)
  })
  const { record, observation } = await observe(handle)

  await act(handle, record, {
    action: 'drag',
    ref: refOf(observation, '卡片'),
    toRef: refOf(observation, '目标槽'),
  })
  // 起点用的是两次滚动之后的位置，不是观察时那一份。
  expect(fake.mouseDetail()[0]).toEqual({
    type: 'mouseMoved',
    x: 50,
    y: 20,
    button: 'none',
    buttons: 0,
  })
  expect(fake.mouseDetail()[1]).toEqual({
    type: 'mousePressed',
    x: 50,
    y: 20,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  })
  // 终点仍在视口外，按下状态里推进一次滚动之后重新量取。
  expect(fake.mouseDetail().at(-1)).toEqual({
    type: 'mouseReleased',
    x: 250,
    y: 580,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  })
  expect((fake.model.docs[0] as DocModel).scrollY).toBe(1440)
})

test('drag 按下之后取消，鼠标被补一次抬起，回执不报完成', async () => {
  const { fake, handle } = await newPage(addDragPair)
  const { record, observation } = await observe(handle)
  // 第 1 条是按下之前的移动，第 2 条才是按下：取消要落在按下之后。
  fake.model.onInput = (nth) => {
    if (nth === 2) void handle.client.cancel('测试取消')
  }

  const r = await act(handle, record, {
    action: 'drag',
    ref: refOf(observation, '卡片'),
    toRef: refOf(observation, '目标槽'),
  })
  expect(r.execution?.state).not.toBe('completed')
  const released = fake.mouseDetail().filter((e) => e.type === 'mouseReleased')
  expect(released).toHaveLength(1)
  expect(released[0]).toMatchObject({ x: 50, y: 220, buttons: 0 })
})

test('按下之前一律先把指针移到落点，且那一条不计入执行回执的单元数', async () => {
  const first = (fake: FakePage) => fake.mouseDetail()[0]
  const aim = { type: 'mouseMoved', button: 'none', buttons: 0 }

  const click = await newPage()
  {
    const { record, observation } = await observe(click.handle)
    await act(click.handle, record, { action: 'click', ref: refOf(observation, '提交') })
    expect(first(click.fake)).toEqual({ ...aim, x: 40, y: 20 })
  }

  const right = await newPage()
  {
    const { record, observation } = await observe(right.handle)
    await act(right.handle, record, { action: 'rightclick', ref: refOf(observation, '提交') })
    expect(first(right.fake)).toEqual({ ...aim, x: 40, y: 20 })
  }

  const dbl = await newPage()
  {
    const { record, observation } = await observe(dbl.handle)
    const r = await act(dbl.handle, record, { action: 'dblclick', ref: refOf(observation, '提交') })
    expect(first(dbl.fake)).toEqual({ ...aim, x: 40, y: 20 })
    // 单元数仍是按下抬起的轮数：移动是定位不是业务事件。
    expect(r.execution).toEqual({ state: 'completed', confirmedUnits: 2 })
  }

  const drag = await newPage(addDragPair)
  {
    const { record, observation } = await observe(drag.handle)
    const r = await act(drag.handle, record, {
      action: 'drag',
      ref: refOf(observation, '卡片'),
      toRef: refOf(observation, '目标槽'),
    })
    expect(first(drag.fake)).toEqual({ ...aim, x: 50, y: 220 })
    expect(r.execution).toEqual({ state: 'completed', confirmedUnits: 4 })
  }

  const download = await newPage()
  {
    const { record, observation } = await observe(download.handle)
    await clickForDownload(download.handle, record, refOf(observation, '提交'))
    expect(first(download.fake)).toEqual({ ...aim, x: 40, y: 20 })
  }
})

test('drag 缺终点或两端相同时在发事件之前拒绝', async () => {
  const { fake, handle } = await newPage(addDragPair)
  const { record, observation } = await observe(handle)
  const ref = refOf(observation, '卡片')

  const missing = await act(handle, record, { action: 'drag', ref }).catch((e: Error) => e.message)
  expect(String(missing)).toContain('toRef')

  const same = await act(handle, record, { action: 'drag', ref, toRef: ref }).catch(
    (e: Error) => e.message,
  )
  expect(String(same)).toContain('同一个元素')
  expect(fake.mouse()).toHaveLength(0)
})

test('drag 的起点被遮住时不按下鼠标', async () => {
  const { fake, handle } = await newPage((f) => {
    addDragPair(f)
    addMask(f, '登录提示')
  })
  const { record, observation } = await observe(handle)

  const err = await act(handle, record, {
    action: 'drag',
    ref: refOf(observation, '卡片'),
    toRef: refOf(observation, '目标槽'),
  }).catch((e: Error) => e)
  expect(err).toBeInstanceOf(BrowserAmbiguousRefError)
  expect(fake.mouse()).toHaveLength(0)
})
