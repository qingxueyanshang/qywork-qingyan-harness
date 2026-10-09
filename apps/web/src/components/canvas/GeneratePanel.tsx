/**
 * 生成面板：选中生成卡时显示在其下方，按屏幕尺寸渲染，不随缩放变化。外观与结构同会话输入框：
 * 顶部素材栏、正文（`@` 引用是内嵌标签）、底栏（模型 · 模式 · 参数 · @ · 本次花费 · 发送键）。
 *
 * 尺寸只有两档固定值（B9）；提示词在失焦与发送时提交，发送在同一次请求中先提交提示词再运行。
 * 面板中的菜单均在按钮上方弹出、左缘与按钮对齐，同会话输入框。
 * 编辑中的提示词不被重新读取覆盖：编辑框有焦点时不按服务端返回的画布重建。
 */

import {
  ART_SIZE_PARAM,
  activeMediaParams,
  blankBox,
  type CanvasGenerateNode,
  type CanvasNodeState,
  type CanvasOp,
  type CanvasView,
  canvasMediaOf,
  displayNameOf,
  fitBox,
  formatMoney,
  type GenerateOutput,
  inputsOf,
  isInlineAudio,
  isInlineImage,
  isInlineVideo,
  type MediaInputRole,
  mediaOperationFor,
  mediaParamValues,
  modeOf,
  ratioOf,
  resolveMediaParam,
} from '@qywork/core'
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Match,
  on,
  onCleanup,
  Show,
  Switch,
} from 'solid-js'
import { readSession, sessionSignal, writeSession } from '../../lib/session.ts'
import {
  type CanvasQuote,
  client,
  ensureModelCatalog,
  type MediaModelOption,
  type MediaParamOption,
  modelCatalog,
  openSettings,
  quoteCard,
  workspace,
} from '../../lib/store/index.ts'
import { AnchoredMenu } from '../AnchoredMenu.tsx'
import {
  IconCheck,
  IconChevron,
  IconExpand,
  IconPlus,
  IconSend,
  IconStop,
  IconX,
} from '../Icons.tsx'
import { Bitmap, decodeImage, paint } from './Bitmap.tsx'
import { dismissOnOutside } from './dismiss.ts'
import { promptOfEditor, promptParts } from './prompt.ts'
import { SourcePicker } from './SourcePicker.tsx'

type Mode = 'reference' | 'first_last'

type Menu =
  | { kind: 'model' | 'mode' | 'params'; anchor: HTMLElement }
  | { kind: 'pick'; anchor: HTMLElement; role?: MediaInputRole }

export const ROLE_LABEL: Record<MediaInputRole, string> = {
  reference: '参考',
  first_frame: '首帧',
  last_frame: '尾帧',
  video: '视频',
  audio: '音频',
}
const PLACEHOLDER: Record<GenerateOutput, string> = {
  image: '描述画面，输入 @ 引用素材',
  video: '描述画面变化，输入 @ 引用素材',
  audio: '输入要朗读的文字',
  art: '描述页面或场景，输入 @ 引用参考图',
}
/** 带单位的参数：时长按秒，张数按张。 */
const UNIT: Record<string, string> = {
  duration: '秒',
  durationSeconds: '秒',
  seconds: '秒',
  n: '张',
}
/** 整数参数的取值个数不超过此值时逐项列出，否则使用加减按钮。 */
const MAX_LISTED = 12
/** 分段按钮不超过此数量时排成一行，否则每行 4 个。 */
const ONE_ROW = 10

type SizeShape = NonNullable<MediaParamOption['shapes']>[number]

/** 卡片模型菜单中的一项：生成模型，或 art 卡的对话模型。 */
type CardModel = Pick<
  MediaModelOption,
  'provider' | 'id' | 'label' | 'operations' | 'isDefault' | 'params'
>

/** 参数取值的界面文字：布尔值显示为开、关，接口中表示自动选择的取值显示为「自动」，其余原样显示。 */
export function valueText(v: unknown): string {
  if (v === true || v === 'true') return '开'
  if (v === false || v === 'false') return '关'
  if (v === 'adaptive' || v === 'auto') return '自动'
  if (typeof v === 'string' && /^(png|jpeg|webp|mp4|mov)$/.test(v)) return v.toUpperCase()
  return String(v)
}

/** 参数取值的显示文字：没有取值或由模型决定时显示「自动」，有单位的参数附带单位。 */
export function paramText(p: MediaParamOption, v: unknown): string {
  if (v === undefined || v === p.auto) return '自动'
  const unit = UNIT[p.name]
  return unit ? `${v} ${unit}` : cellText(p, v)
}

/** 选项上的文字：只显示取值，单位由所在节的标题说明。 */
export function cellText(p: MediaParamOption, v: unknown): string {
  if (v === undefined || v === p.auto) return '自动'
  return p.valueLabels?.[String(v)] ?? valueText(v)
}

/** 未覆盖接口默认值时的选项文案；不把固定默认值写成自动识别。 */
function defaultText(p: MediaParamOption): string {
  return p.default === undefined ? '默认' : `默认（${cellText(p, p.default)}）`
}

/** 尺寸取值在对照表中对应的项；不在表中（模型填写的其他尺寸）时返回 `undefined`。 */
export function shapeAt(p: MediaParamOption, v: unknown): SizeShape | undefined {
  return p.shapes?.find((s) => s.value === v)
}

/**
 * 底栏按钮上的文字：只显示取值，取值本身无法表明是哪个参数时（自动、开关）附加参数名。
 * 带对照表的尺寸显示宽高比与档位；取值不在表中时原样显示。
 */
export function chipText(p: MediaParamOption, v: unknown): string {
  if (p.shapes) {
    const at = shapeAt(p, v)
    return at ? [at.ratio ?? '自动宽高比', at.tier].filter(Boolean).join(' · ') : String(v)
  }
  const text = paramText(p, v)
  if (text === '自动') return `自动${p.label}`
  if (p.name === 'quality') return `${p.label}${text}`
  if (typeof v === 'boolean') return `${p.label}${text}`
  return text
}

/** 参数按钮上的文字：各参数取值用「 · 」连接，开关只在打开时列入。 */
export function paramsText(
  params: readonly MediaParamOption[],
  current: (p: MediaParamOption) => unknown,
): string {
  return params
    .filter((p) => !p.advanced)
    .filter((p) => p.type !== 'boolean' || current(p) === true || current(p) === 'true')
    .map((p) => chipText(p, current(p)))
    .join(' · ')
}

/** 比例（`16:9`）或像素尺寸（`1536x1024`）绘制成的框：长边 14px，短边按比例计算且不小于 5px。其余取值返回 `null`。 */
export function shapeOf(v: unknown): { w: number; h: number } | null {
  const m = typeof v === 'string' ? /^(\d+)\s*[:x*×]\s*(\d+)$/.exec(v) : null
  const a = Number(m?.[1])
  const b = Number(m?.[2])
  if (!a || !b) return null
  const scale = 14 / Math.max(a, b)
  return { w: Math.max(5, Math.round(a * scale)), h: Math.max(5, Math.round(b * scale)) }
}

/** 宽高比选项上方的图形：比例取值绘制同比例的框，自动绘制带角标的方框。 */
function RatioIcon(props: { of: unknown }) {
  return (
    <Show
      when={shapeOf(props.of)}
      fallback={
        <svg class="canvas-shape-auto" viewBox="0 0 16 16" aria-hidden="true">
          <rect x="2" y="2" width="12" height="12" rx="2.5" />
          <path d="M5 7.5V5h2.5M11 8.5V11H8.5" />
        </svg>
      }
    >
      {(box) => (
        <i class="canvas-shape" style={{ width: `${box().w}px`, height: `${box().h}px` }} />
      )}
    </Show>
  )
}

/** 参数面板的一节：一个参数，或由尺寸对照表拆分出的宽高比、分辨率之一。 */
interface Section {
  kind: 'param' | 'ratio' | 'tier'
  p: MediaParamOption
}

/** 分段按钮的一项。`checked` 是读取函数：面板打开期间参数会变化。 */
interface Cell {
  text: string
  of: unknown
  checked: () => boolean
  pick: () => void
}

/** 对照表中出现的宽高比（`undefined` 表示自动）与档位，按表内顺序排列。 */
const ratiosOf = (p: MediaParamOption) => [...new Set((p.shapes ?? []).map((s) => s.ratio))]
const tiersOf = (p: MediaParamOption) =>
  [...new Set((p.shapes ?? []).map((s) => s.tier))].filter((t): t is string => t !== undefined)

/** 带对照表的参数拆分为宽高比、分辨率两节；只有一个可选项的节不列出。 */
function sectionsOf(params: readonly MediaParamOption[]): Section[] {
  return params.flatMap((p): Section[] => {
    if (!p.shapes) return [{ kind: 'param', p }]
    const out: Section[] = []
    if (ratiosOf(p).length > 1) out.push({ kind: 'ratio', p })
    if (tiersOf(p).length > 1) out.push({ kind: 'tier', p })
    return out
  })
}

/** 节点当前指向的媒体：文件节点为其路径，生成节点为当前版本（仍在远端时为空）。 */
export function mediaOf(
  view: CanvasView,
  nodeId: string,
): { kind: GenerateOutput | null; path: string | null } {
  const node = view.doc.nodes.find((n) => n.id === nodeId)
  if (!node) return { kind: null, path: null }
  if (node.type === 'file') return { kind: canvasMediaOf(node), path: node.path }
  if (node.type === 'timeline') return { kind: null, path: null }
  const current = node.versions.find((v) => v.id === node.current)
  const path = current && !current.path.endsWith('.task.json') ? current.path : null
  return { kind: node.output, path }
}

function Thumb(props: { view: CanvasView; nodeId: string }) {
  const media = () => mediaOf(props.view, props.nodeId)
  return (
    <Show when={media().path}>
      {(path) => (
        <Show
          when={media().kind === 'video'}
          fallback={
            <Show when={media().kind === 'image'}>
              <Bitmap
                src={client.fileUrl(path())}
                width={40 * window.devicePixelRatio}
                height={40 * window.devicePixelRatio}
              />
            </Show>
          }
        >
          <Bitmap
            kind="video"
            src={client.fileUrl(path())}
            width={40 * window.devicePixelRatio}
            height={40 * window.devicePixelRatio}
          />
        </Show>
      )}
    </Show>
  )
}

export function GeneratePanel(props: {
  view: CanvasView
  node: CanvasGenerateNode
  state: CanvasNodeState | undefined
  left: number
  top: number
  width: number
  tall: boolean
  onTall: (tall: boolean) => void
  apply: (ops: CanvasOp[]) => Promise<boolean>
  run: (ops: CanvasOp[]) => void
  /** 停止该卡片的生成。Promise 兑现时停止请求已返回。 */
  cancel: () => Promise<void>
  /** 把工作区文件或本机文件添加到画布（位于该卡片附近），返回新节点的 id；添加失败时返回 `null`。 */
  place: (source: { path: string } | { file: File }) => Promise<string | null>
}) {
  void ensureModelCatalog()
  let editor!: HTMLDivElement
  /*
   * 每个面板实例只属于一张卡片（外层按卡片 id 重建）。提示词在失焦时提交，而取消选中时先卸载面板，
   * 失焦发生在卸载之后，此时 `props.node` 已不可读；因此卡片 id、已提交的提示词与提交函数在挂载时保存。
   */
  const nodeId = props.node.id
  const apply = props.apply
  let saved = props.node.prompt
  /** 本卡片记录的键前缀：未提交的提示词草稿与空卡的输入模式刷新后恢复。 */
  const key = `qywork.canvas.card:${workspace()?.id ?? ''}:${props.view.path}:${nodeId}`
  /**
   * 未提交的草稿与其所依据的提示词。依据的提示词已被修改时（模型或另一端编辑）丢弃草稿：
   * 恢复后失焦即提交，会覆盖那次修改。
   */
  const kept = readSession<{ base: string; text: string }>(`${key}.draft`)
  const [draft, setDraft] = createSignal(kept?.base === saved ? kept.text : saved)
  const [menu, setMenu] = createSignal<Menu | null>(null)
  const [emptyMode, setEmptyMode] = sessionSignal<Mode>(`${key}.mode`, 'reference')
  createEffect(() => {
    const text = draft()
    writeSession(`${key}.draft`, text === saved ? undefined : { base: saved, text })
  })
  const [price, setPrice] = createSignal<CanvasQuote | null>(null)
  dismissOnOutside(menu, () => setMenu(null))
  /** `@` 打开选择框时光标所在的位置；选中后在此处插入标签。 */
  let caret: Range | null = null

  const edges = () => inputsOf(props.view.doc, props.node.id)
  const mode = (): Mode =>
    props.node.output !== 'video'
      ? 'reference'
      : edges().length
        ? modeOf(props.view.doc, props.node.id)
        : emptyMode()
  const running = () => props.state?.state === 'running'
  /** 停止请求尚未返回：停止键禁用，避免重复撤销。 */
  const [stopping, setStopping] = createSignal(false)

  /**
   * 卡片可选的模型。art 卡使用对话模型：列出配置中的全部接口 × 模型，缺省为当前默认模型，参数只有尺寸。
   * 经 memo 计算：菜单按对象判定当前项，每次读取都新建对象时判定不成立。
   */
  const models = createMemo((): CardModel[] => {
    const catalog = modelCatalog()
    if (props.node.output !== 'art') {
      return (catalog?.media ?? []).filter((m) => m.output === props.node.output)
    }
    return (catalog?.providers ?? []).flatMap((p) =>
      p.models.map((m) => ({
        provider: p.name,
        id: m.id,
        label: m.label,
        operations: [],
        isDefault: catalog?.active?.provider === p.name && catalog.active.model === m.id,
        params: [ART_SIZE_PARAM],
      })),
    )
  })
  const model = (): CardModel | undefined =>
    props.node.provider && props.node.model
      ? models().find((m) => m.provider === props.node.provider && m.id === props.node.model)
      : (models().find((m) => m.isDefault) ?? models()[0])
  const modelParams = createMemo(() => model()?.params ?? [])
  // 参数可见性与实际发送值都按目录和输入模式解析。
  const operation = () =>
    mediaOperationFor(
      props.node.output,
      edges().map((e) => e.role),
    )
  const activeParams = createMemo(() =>
    activeMediaParams(
      modelParams(),
      operation(),
      props.node.params,
      edges().filter((e) => e.role === 'reference').length,
    ),
  )
  const resolvedParams = createMemo(() => {
    const specs = modelParams()
    const values = mediaParamValues(specs, activeParams())
    return specs.map((p) =>
      resolveMediaParam(
        p,
        operation(),
        values,
        edges().filter((e) => e.role === 'reference').length,
      ),
    )
  })
  const params = createMemo(() => resolvedParams().filter((p) => p.available !== false))
  // 节的标识只随模型目录变化；保存参数与重新读取画布时保留控件、焦点和滚动锚点。
  const sectionDefinitions = createMemo(() => sectionsOf(modelParams()))
  const sections = createMemo(() =>
    sectionDefinitions().filter((s) => {
      const p = params().find((p) => p.name === s.p.name)
      if (!p) return false
      if (s.kind === 'ratio') return ratiosOf(p).length > 1
      if (s.kind === 'tier') return tiersOf(p).length > 1
      return true
    }),
  )
  const videoControls = createMemo(() => {
    const basic = sections().filter((s) => !s.p.advanced)
    const duration = basic.find((s) => s.kind === 'param' && UNIT[s.p.name] === '秒')
    const audio = basic.find((s) => s.p.name === 'audio' || s.p.name === 'generate_audio')
    return duration && audio ? [duration, audio] : []
  })
  const paramValue = (p: MediaParamOption) => activeParams()[p.name] ?? p.default
  /** 再次点击同一按钮时收起。 */
  const toggle = (kind: 'model' | 'mode' | 'params', anchor: HTMLElement) =>
    setMenu(menu()?.kind === kind ? null : { kind, anchor })
  const chevron = (kind: Menu['kind']) => (menu()?.kind === kind ? 'up' : 'down')
  /** 模型支持的输入模式。 */
  const modes = (): Mode[] => {
    const ops = model()?.operations ?? []
    const out: Mode[] = []
    if (
      ops.some((o) => o === 'reference_to_video' || o === 'text_to_video' || o === 'video_to_video')
    )
      out.push('reference')
    if (ops.some((o) => o === 'image_to_video' || o === 'first_last_frame')) out.push('first_last')
    return out
  }

  /*
   * 画布每次重新读取后重建编辑框（素材标签的名称随节点更新）。编辑框有焦点时以编辑框内容为准；
   * 没有焦点时，返回的提示词变化则按它重建，未变化则保留当前草稿。不要改为一律按返回的提示词重建：
   * 刷新后恢复的草稿尚未提交、编辑框也没有焦点，下一次重新读取会清除它。
   */
  createEffect(
    on(
      () => props.node.prompt,
      (prompt) => {
        const changed = prompt !== saved
        saved = prompt
        if (document.activeElement === editor) return
        const text = changed ? prompt : draft()
        render(text)
        setDraft(text)
      },
    ),
  )

  function chip(id: string): HTMLElement {
    const el = document.createElement('span')
    el.className = 'canvas-chip'
    el.contentEditable = 'false'
    el.dataset.node = id
    const node = props.view.doc.nodes.find((n) => n.id === id)
    const media = mediaOf(props.view, id)
    if (media.kind === 'image' && media.path) {
      const thumb = document.createElement('canvas')
      thumb.className = 'canvas-bitmap'
      const side = 32 * window.devicePixelRatio
      void decodeImage(client.fileUrl(media.path), { w: side, h: side }).then(
        (bitmap) => paint(thumb, bitmap),
        () => thumb.remove(),
      )
      el.append(thumb)
    }
    el.append(node ? displayNameOf(node) : id)
    return el
  }

  function render(prompt: string) {
    editor.replaceChildren(
      ...promptParts(prompt).map((part) =>
        'text' in part ? document.createTextNode(part.text) : chip(part.id),
      ),
    )
  }

  const commit = async (): Promise<boolean> => {
    const d = draft()
    if (d === saved) return true
    const before = saved
    saved = d
    const ok = await apply([{ op: 'update', id: nodeId, prompt: d }])
    if (!ok) saved = before
    return ok
  }

  const send = () => {
    const d = draft()
    props.run(d === props.node.prompt ? [] : [{ op: 'update', id: props.node.id, prompt: d }])
  }

  /** 选择素材后建立连接所用的用途；由 `@` 打开时没有用途。 */
  const roleOf = (m: Menu | null) => (m?.kind === 'pick' ? m.role : undefined)

  /** 可选素材列表：首尾帧模式只列出已连接的两帧（首尾帧不能与参考素材同时提供）。 */
  const pickable = () => {
    const role = roleOf(menu())
    const connected = new Set(edges().map((e) => e.from))
    return props.view.doc.nodes.filter((n) => {
      if (n.id === props.node.id) return false
      const kind = mediaOf(props.view, n.id).kind
      if (!kind) return false
      if (role === 'first_frame' || role === 'last_frame')
        return kind === 'image' && !connected.has(n.id)
      if (role) return !connected.has(n.id) && accepts(kind)
      // `@`：首尾帧模式下只列出这两帧，其余模式列出可作为输入的素材。
      if (mode() === 'first_last') return connected.has(n.id)
      return accepts(kind)
    })
  }
  const accepts = (kind: GenerateOutput) =>
    props.node.output === 'image' || props.node.output === 'art'
      ? kind === 'image'
      : props.node.output === 'video' && kind !== 'art'
  /** 首尾帧只接受图片；图像生成卡与 Art 卡只接受图片；视频生成卡接受图片、视频、音频。 */
  const imagesOnly = () => {
    const role = roleOf(menu())
    return (
      role === 'first_frame' ||
      role === 'last_frame' ||
      props.node.output === 'image' ||
      props.node.output === 'art'
    )
  }
  const acceptsPath = (path: string) => {
    if (isInlineImage(path)) return true
    return !imagesOnly() && (isInlineVideo(path) || isInlineAudio(path))
  }
  const uploadAccept = () => (imagesOnly() ? 'image/*' : 'image/*,video/*,audio/*')
  const roleFor = (kind: GenerateOutput): MediaInputRole =>
    kind === 'video' ? 'video' : kind === 'audio' ? 'audio' : 'reference'

  const pick = (sourceId: string, m = menu()) => {
    setMenu(null)
    const wanted = roleOf(m)
    if (wanted) {
      const kind = mediaOf(props.view, sourceId).kind
      const role = wanted === 'reference' && kind ? roleFor(kind) : wanted
      void props.apply([{ op: 'connect', from: sourceId, to: props.node.id, role }])
      return
    }
    // `@`：在光标处插入标签并立即提交提示词；未连线的素材由服务端在同一批操作中补充连线。
    const el = chip(sourceId)
    const range = caret
    if (range && editor.contains(range.startContainer)) {
      range.deleteContents()
      range.insertNode(document.createTextNode(' '))
      range.insertNode(el)
    } else {
      editor.append(el, document.createTextNode(' '))
    }
    caret = null
    setDraft(promptOfEditor(editor))
    void commit()
  }

  const openPicker = (anchor: HTMLElement, role?: MediaInputRole) => {
    const sel = window.getSelection()
    caret =
      sel?.rangeCount && editor.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : null
    setMenu({ kind: 'pick', anchor, ...(role ? { role } : {}) })
  }

  /** 编辑框的监听器注册在元素上：可编辑元素本身接收焦点与按键，不另设 ARIA 角色。 */
  function listen(el: HTMLDivElement) {
    el.addEventListener('input', () => setDraft(promptOfEditor(el)))
    el.addEventListener('blur', () => {
      if (menu()?.kind !== 'pick') void commit()
    })
    el.addEventListener('keydown', (e) => {
      if (e.key === '@' && props.node.output !== 'audio') {
        e.preventDefault()
        openPicker(el)
      }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && draft().trim() && !running()) {
        e.preventDefault()
        send()
      }
    })
    el.addEventListener('paste', (e) => {
      e.preventDefault()
      document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '')
    })
  }

  /** 先添加到画布再选中：工作区文件与上传的文件均先成为画布节点；已在画布上的工作区文件直接使用该节点。 */
  const place = async (sources: ({ path: string } | { file: File })[]) => {
    const m = menu()
    setMenu(null)
    for (const source of sources) {
      const existing =
        'path' in source
          ? props.view.doc.nodes.find((n) => n.type === 'file' && n.path === source.path)
          : undefined
      const id = existing?.id ?? (await props.place(source))
      if (id) pick(id, m)
    }
  }

  /** 设置一个参数；`undefined` 表示删除该参数，使用接口的缺省值。 */
  const setParam = (p: MediaParamOption, value: string | number | boolean | undefined) => {
    const next = { ...props.node.params }
    if (value === undefined || value === '' || value === p.default) delete next[p.name]
    else next[p.name] = value
    void props.apply([
      { op: 'update', id: props.node.id, params: next, ...previewBox(ratioOf(p, value)) },
    ])
  }

  /**
   * 尚无结果的卡片：选择宽高比时框按所选比例改变形状（短边不变），重新选择「自动」时恢复缺省比例；
   * 有结果后框按结果的实际尺寸确定（由服务端写入磁盘时决定），此处不修改。非宽高比参数返回空对象。
   */
  const previewBox = (ratio: string | null): { w?: number; h?: number } => {
    if (ratio === null || props.node.versions.length > 0) return {}
    const [a, b] = ratio.split(':').map(Number) as [number, number]
    const target = ratio === 'auto' ? blankBox(props.node.output) : { w: a, h: b }
    const box = fitBox(props.node, target)
    return box.w === props.node.w && box.h === props.node.h ? {} : box
  }

  /** 参数菜单中的逐项取值；整数范围过大时返回 `null`，改用加减按钮。 */
  const choicesOf = (p: MediaParamOption): (string | number | boolean | undefined)[] | null => {
    // 没有缺省值的参数增加一项「自动」：删除取值，由接口决定。
    const unset = p.default === undefined ? [undefined] : []
    if (p.values) return [...unset, ...p.values]
    if (p.type === 'enum') return [...unset, ...(p.values ?? [])]
    if (p.type === 'boolean') return [true, false]
    if (p.type === 'string') return p.presets ? [...unset, ...p.presets] : null
    if (p.type === 'integer' && p.min !== undefined && p.max !== undefined) {
      const auto = p.auto === undefined ? [] : [p.auto]
      if (p.max - p.min + 1 + auto.length > MAX_LISTED) return null
      return [
        ...auto,
        ...Array.from({ length: p.max - p.min + 1 }, (_, i) => (p.min as number) + i),
      ]
    }
    return null
  }

  /** 一节中的选项；大范围整数返回 `null`，改用加减按钮。 */
  const cellsOf = (s: Section): Cell[] | null => {
    const p = s.p
    const at = () => shapeAt(p, paramValue(p))
    if (s.kind === 'ratio') {
      return ratiosOf(p).map((ratio) => ({
        text: ratio ?? '自动',
        of: ratio,
        checked: () => at() !== undefined && at()?.ratio === ratio,
        pick: () => pickRatio(p, ratio),
      }))
    }
    if (s.kind === 'tier') {
      return tiersOf(p).map((tier) => ({
        text: tier,
        of: tier,
        checked: () => at()?.tier === tier,
        pick: () => pickTier(p, tier),
      }))
    }
    return (
      choicesOf(p)?.map((v) => ({
        text: cellText(p, v),
        of: v,
        checked: () => paramValue(p) === v,
        pick: () => setParam(p, v),
      })) ?? null
    )
  }
  /** 宽高比节，以及取值为比例的参数（视频的宽高比），在选项上绘制图形。 */
  const drawn = (s: Section) =>
    s.kind === 'ratio' || (s.kind === 'param' && (choicesOf(s.p) ?? []).some((v) => shapeOf(v)))

  /** 切换宽高比：保留当前档位；当前档位没有该宽高比时取表中第一个匹配项。 */
  const pickRatio = (p: MediaParamOption, ratio: string | undefined) => {
    const table = p.shapes ?? []
    const tier = shapeAt(p, paramValue(p))?.tier
    const hit =
      table.find((s) => s.ratio === ratio && s.tier === tier) ??
      table.find((s) => s.ratio === ratio)
    if (hit) setParam(p, hit.value)
  }
  /** 切换档位：保留当前宽高比；当前为「自动」且接口不接受档位简写时取 1:1。 */
  const pickTier = (p: MediaParamOption, tier: string) => {
    const table = p.shapes ?? []
    const ratio = shapeAt(p, paramValue(p))?.ratio
    const hit =
      table.find((s) => s.tier === tier && s.ratio === ratio) ??
      table.find((s) => s.tier === tier && s.ratio === '1:1') ??
      table.find((s) => s.tier === tier)
    if (hit) setParam(p, hit.value)
  }

  /** 加减：到达下限后再减一次为「自动」（有 `auto` 时），从「自动」增加一次回到下限。 */
  const step = (p: MediaParamOption, delta: number) => {
    const v = paramValue(p)
    const min = p.min ?? 0
    if (v === undefined || v === p.auto) {
      if (delta > 0) setParam(p, min)
      return
    }
    const next = Number(v) + delta
    if (next < min) {
      if (p.auto !== undefined) setParam(p, p.auto)
      return
    }
    setParam(p, Math.min(p.max ?? Number.POSITIVE_INFINITY, next))
  }

  const paramSection = (definition: Section) => {
    const s: Section = {
      kind: definition.kind,
      get p() {
        return resolvedParams().find((p) => p.name === definition.p.name) ?? definition.p
      },
    }
    return (
      <section class="canvas-params-section" classList={{ 'canvas-param-optional': s.p.advanced }}>
        <div class="canvas-params-title">
          <span>{s.kind === 'ratio' ? '宽高比' : s.kind === 'tier' ? '分辨率' : s.p.label}</span>
        </div>
        <Show
          when={cellsOf(s)}
          fallback={
            <Show
              when={s.p.type === 'string'}
              fallback={
                <div class="canvas-seg canvas-stepper">
                  <Show when={!s.p.advanced}>
                    <button type="button" aria-label="减少" onClick={() => step(s.p, -1)}>
                      −
                    </button>
                  </Show>
                  <input
                    type="number"
                    aria-label={s.p.label}
                    min={s.p.auto === undefined ? s.p.min : Math.min(s.p.min ?? s.p.auto, s.p.auto)}
                    max={s.p.max}
                    step={s.p.type === 'integer' ? 1 : 'any'}
                    placeholder={
                      s.p.name === 'seed' ? '随机' : s.p.advanced ? defaultText(s.p) : '自动'
                    }
                    value={
                      s.p.advanced
                        ? String(activeParams()[s.p.name] ?? '')
                        : paramValue(s.p) === s.p.auto
                          ? ''
                          : String(paramValue(s.p) ?? '')
                    }
                    onChange={(e) => {
                      const value = e.currentTarget.value.trim()
                      if (value === '') return setParam(s.p, undefined)
                      const parsed = Number(value)
                      const numeric = s.p.type === 'integer' ? Math.trunc(parsed) : parsed
                      setParam(
                        s.p,
                        numeric === s.p.auto
                          ? numeric
                          : Math.max(
                              s.p.min ?? Number.NEGATIVE_INFINITY,
                              Math.min(s.p.max ?? Number.POSITIVE_INFINITY, numeric),
                            ),
                      )
                    }}
                  />
                  <Show when={UNIT[s.p.name]}>
                    <span>{UNIT[s.p.name]}</span>
                  </Show>
                  <Show when={!s.p.advanced}>
                    <button type="button" aria-label="增加" onClick={() => step(s.p, 1)}>
                      +
                    </button>
                  </Show>
                </div>
              }
            >
              <textarea
                class="canvas-param-text"
                aria-label={s.p.label}
                maxLength={s.p.maxLength}
                placeholder="可选"
                value={String(activeParams()[s.p.name] ?? '')}
                onChange={(e) => setParam(s.p, e.currentTarget.value)}
              />
            </Show>
          }
        >
          {(cells) => (
            <Show
              when={s.p.advanced}
              fallback={
                <div
                  class="canvas-seg"
                  classList={{ drawn: drawn(s) }}
                  style={{ '--cols': String(cells().length <= ONE_ROW ? cells().length : 4) }}
                >
                  <For each={cells().map((c) => c.of)}>
                    {(value) => {
                      const cell = () => cells().find((c) => c.of === value)
                      return (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={cell()?.checked() ?? false}
                          onClick={() => cell()?.pick()}
                        >
                          <Show when={drawn(s)}>
                            <RatioIcon of={value} />
                          </Show>
                          <span class="truncate">{cell()?.text}</span>
                        </button>
                      )
                    }}
                  </For>
                </div>
              }
            >
              <select
                class="canvas-param-select"
                aria-label={s.p.label}
                value={
                  activeParams()[s.p.name] === undefined || activeParams()[s.p.name] === s.p.default
                    ? ''
                    : JSON.stringify(activeParams()[s.p.name])
                }
                onChange={(e) =>
                  setParam(
                    s.p,
                    e.currentTarget.value === '' ? undefined : JSON.parse(e.currentTarget.value),
                  )
                }
              >
                <option value="">{defaultText(s.p)}</option>
                <For
                  each={cells()
                    .filter((c) => c.of !== undefined && c.of !== s.p.default)
                    .map((c) => c.of)}
                >
                  {(value) => <option value={JSON.stringify(value)}>{cellText(s.p, value)}</option>}
                </For>
              </select>
            </Show>
          )}
        </Show>
      </section>
    )
  }

  const setMode = (next: Mode) => {
    setMenu(null)
    if (edges().length) void props.apply([{ op: 'set_mode', id: props.node.id, mode: next }])
    else setEmptyMode(next)
  }

  const swapFrames = () => {
    const ops: CanvasOp[] = edges()
      .filter((e) => e.role === 'first_frame' || e.role === 'last_frame')
      .map((e) => ({
        op: 'update',
        id: e.id,
        role: e.role === 'first_frame' ? 'last_frame' : 'first_frame',
      }))
    if (ops.length) void props.apply(ops)
  }

  // 本次花费：模型、参数或输入数量变化时重新查询；无法推算时不显示。
  let quoteSeq = 0
  createEffect(
    on(
      () =>
        JSON.stringify([
          model()?.provider,
          model()?.id,
          props.node.params,
          edges().map((e) => e.role),
        ]),
      () => {
        const m = model()
        const mine = ++quoteSeq
        const output = props.node.output
        // art 按 token 计价，发送前无法估算。
        if (!m || output === 'art') {
          setPrice(null)
          return
        }
        const timer = setTimeout(() => {
          const roles = edges().map((e) => e.role)
          void quoteCard({
            output,
            provider: m.provider,
            model: m.id,
            params: activeParams(),
            inputs: {
              images: roles.filter((r) => r !== 'video' && r !== 'audio').length,
              videos: roles.filter((r) => r === 'video').length,
            },
          }).then(
            (q) => mine === quoteSeq && setPrice(q),
            () => mine === quoteSeq && setPrice(null),
          )
        }, 300)
        onCleanup(() => clearTimeout(timer))
      },
    ),
  )

  const inputTile = (edgeId: string, sourceId: string, role: MediaInputRole) => (
    <div class="canvas-input">
      <Thumb view={props.view} nodeId={sourceId} />
      <i>{ROLE_LABEL[role]}</i>
      <button
        class="canvas-input-remove"
        type="button"
        aria-label="断开"
        onClick={() => void props.apply([{ op: 'remove', id: edgeId }])}
      >
        <IconX size={10} />
      </button>
    </div>
  )

  const frameSlot = (role: 'first_frame' | 'last_frame') => {
    const edge = () => edges().find((e) => e.role === role)
    return (
      <Show
        when={edge()}
        fallback={
          <button
            class="canvas-input"
            type="button"
            aria-label={ROLE_LABEL[role]}
            onClick={(e) => openPicker(e.currentTarget, role)}
          >
            <IconPlus size={16} stroke={1.8} />
            <span class="cap">{ROLE_LABEL[role]}</span>
          </button>
        }
      >
        {(e) => inputTile(e().id, e().from, role)}
      </Show>
    )
  }

  return (
    <div
      class="canvas-panel"
      classList={{ tall: props.tall }}
      style={{ left: `${props.left}px`, top: `${props.top}px`, width: `${props.width}px` }}
    >
      <button
        class="icon-btn canvas-panel-expand"
        type="button"
        aria-label={props.tall ? '收起' : '展开'}
        onClick={() => props.onTall(!props.tall)}
      >
        <IconExpand size={14} collapse={props.tall} />
      </button>

      <Show when={props.node.output !== 'audio'}>
        <div class="canvas-inputs">
          <Show
            when={mode() === 'first_last'}
            fallback={
              <>
                <For each={edges()}>{(e) => inputTile(e.id, e.from, e.role)}</For>
                <button
                  class="canvas-input"
                  type="button"
                  aria-label="添加素材"
                  onClick={(e) => openPicker(e.currentTarget, 'reference')}
                >
                  <IconPlus size={16} stroke={1.8} />
                </button>
              </>
            }
          >
            {frameSlot('first_frame')}
            <button
              class="canvas-swap icon-btn"
              type="button"
              aria-label="互换首尾帧"
              onClick={swapFrames}
            >
              ⇄
            </button>
            {frameSlot('last_frame')}
          </Show>
        </div>
      </Show>

      <div
        class="canvas-prompt"
        contentEditable
        spellcheck={false}
        data-placeholder={PLACEHOLDER[props.node.output]}
        ref={(el) => {
          editor = el
          render(props.node.prompt)
          listen(el)
        }}
      />

      <div class="canvas-bar">
        <button
          class="mode-chip model"
          type="button"
          onClick={(e) => toggle('model', e.currentTarget)}
        >
          <span class="truncate">{model()?.label ?? '未配置模型'}</span>
          <IconChevron size={10} dir={chevron('model')} />
        </button>
        <Show when={props.node.output === 'video' && modes().length > 1}>
          <button class="mode-chip" type="button" onClick={(e) => toggle('mode', e.currentTarget)}>
            {mode() === 'first_last' ? '首尾帧' : '参考'}
            <IconChevron size={10} dir={chevron('mode')} />
          </button>
        </Show>
        <Show when={params().length}>
          <button
            class="mode-chip params"
            type="button"
            onClick={(e) => toggle('params', e.currentTarget)}
          >
            <span class="truncate">{paramsText(params(), paramValue)}</span>
            <IconChevron size={10} dir={chevron('params')} />
          </button>
        </Show>
        <Show when={props.node.output !== 'audio'}>
          <button
            class="mode-chip"
            type="button"
            aria-label="引用素材"
            onClick={(e) => openPicker(e.currentTarget)}
          >
            @
          </button>
        </Show>
        <span class="spacer" />
        <Show when={price()}>
          {(q) => <span class="canvas-price">{formatMoney(q().cost, q().currency as never)}</span>}
        </Show>
        {/* 生成中发送键替换为停止键，同会话输入框。 */}
        <Show
          when={running()}
          fallback={
            <button
              class="send-btn"
              classList={{ 'has-content': !!draft().trim() }}
              type="button"
              aria-label="生成"
              disabled={!draft().trim() || !model()}
              onClick={send}
            >
              <IconSend size={16} />
            </button>
          }
        >
          <button
            class="send-btn"
            type="button"
            aria-label="停止"
            disabled={stopping()}
            onClick={() => {
              setStopping(true)
              void props.cancel().finally(() => setStopping(false))
            }}
          >
            <IconStop size={16} />
          </button>
        </Show>
      </div>

      <Show when={menu()}>
        {(m) => (
          <Switch>
            <Match when={m().kind === 'pick'}>
              <AnchoredMenu class="canvas-pick" anchor={m().anchor} placement="above-start">
                <SourcePicker
                  nodes={pickable()}
                  files={roleOf(m()) !== undefined || mode() !== 'first_last'}
                  kinds={imagesOnly() ? ['image'] : ['image', 'video', 'audio']}
                  accepts={acceptsPath}
                  accept={uploadAccept()}
                  thumb={(id) => <Thumb view={props.view} nodeId={id} />}
                  onNode={(id) => pick(id)}
                  onFile={(path) => void place([{ path }])}
                  onUpload={(files) => void place(files.map((file) => ({ file })))}
                />
              </AnchoredMenu>
            </Match>
            <Match when={m().kind === 'params'}>
              <AnchoredMenu
                class="canvas-params-panel"
                anchor={m().anchor}
                placement="above-start"
                lockHeight
              >
                <For each={sections().filter((s) => !s.p.advanced && !videoControls().includes(s))}>
                  {paramSection}
                </For>
                <Show when={videoControls().length}>
                  <div class="canvas-params-row">
                    <For each={videoControls()}>{paramSection}</For>
                  </div>
                </Show>
                <Show when={sections().some((s) => s.p.advanced)}>
                  <details class="canvas-params-advanced">
                    <summary>更多设置</summary>
                    <For each={sections().filter((s) => s.p.advanced)}>{paramSection}</For>
                  </details>
                </Show>
              </AnchoredMenu>
            </Match>
            <Match when={m().kind === 'model' || m().kind === 'mode'}>
              <AnchoredMenu class="canvas-bar-menu" anchor={m().anchor} placement="above-start">
                <Show when={m().kind === 'model' && !models().length}>
                  <button
                    type="button"
                    onClick={() => {
                      setMenu(null)
                      openSettings('models')
                    }}
                  >
                    打开模型库
                  </button>
                </Show>
                <Show when={m().kind === 'model'}>
                  <For each={models()}>
                    {(o) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={o === model()}
                        onClick={() => {
                          setMenu(null)
                          void props.apply([
                            ...(!props.node.model && model()
                              ? [
                                  {
                                    op: 'update' as const,
                                    id: props.node.id,
                                    provider: model()!.provider,
                                    model: model()!.id,
                                    params: props.node.params,
                                  },
                                ]
                              : []),
                            {
                              op: 'update',
                              id: props.node.id,
                              provider: o.provider,
                              model: o.id,
                            },
                          ])
                        }}
                      >
                        <span class="truncate">{o.label}</span>
                        <Show when={o === model()}>
                          <IconCheck size={14} />
                        </Show>
                      </button>
                    )}
                  </For>
                </Show>
                <Show when={m().kind === 'mode'}>
                  <For each={modes()}>
                    {(o) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={o === mode()}
                        onClick={() => setMode(o)}
                      >
                        <span class="truncate">{o === 'first_last' ? '首尾帧' : '参考'}</span>
                        <Show when={o === mode()}>
                          <IconCheck size={14} />
                        </Show>
                      </button>
                    )}
                  </For>
                </Show>
              </AnchoredMenu>
            </Match>
          </Switch>
        )}
      </Show>
    </div>
  )
}
