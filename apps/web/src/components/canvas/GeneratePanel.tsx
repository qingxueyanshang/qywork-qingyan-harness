/**
 * 生成面板：选中一张生成卡时贴在它下方，按屏幕尺寸画、不随缩放。外观与结构同会话输入框：
 * 顶部素材格、正文（`@` 引用是内嵌标签）、底栏（模型 · 模式 · 每个参数一个按钮 · @ · 本次花费 · 发送键）。
 *
 * 尺寸只有两档固定值（B9）；提示词在失焦与发送时提交，发送是「先提交再运行」同一次请求。
 * 编辑中的提示词不被重读覆盖：编辑框有焦点时不按画布回体重建。
 */

import {
  type CanvasGenerateNode,
  type CanvasNodeState,
  type CanvasOp,
  type CanvasView,
  canvasMediaOf,
  displayNameOf,
  formatMoney,
  inputsOf,
  isInlineAudio,
  isInlineImage,
  isInlineVideo,
  type MediaInputRole,
  type MediaOutput,
  modeOf,
} from '@qywork/core'
import { createEffect, createSignal, For, Match, on, onCleanup, Show, Switch } from 'solid-js'
import {
  type CanvasQuote,
  client,
  ensureModelCatalog,
  type MediaModelOption,
  type MediaParamOption,
  modelCatalog,
  openSettings,
  quoteCard,
} from '../../lib/store/index.ts'
import { AnchoredMenu } from '../AnchoredMenu.tsx'
import { IconChevron, IconExpand, IconPlus, IconSend, IconX } from '../Icons.tsx'
import { Bitmap, decodeImage, paint } from './Bitmap.tsx'
import { dismissOnOutside } from './dismiss.ts'
import { promptOfEditor, promptParts } from './prompt.ts'
import { SourcePicker } from './SourcePicker.tsx'

type Mode = 'reference' | 'first_last'

type Menu =
  | { kind: 'model' | 'mode'; anchor: HTMLElement }
  | { kind: 'param'; anchor: HTMLElement; param: string }
  | { kind: 'pick'; anchor: HTMLElement; role?: MediaInputRole }

export const ROLE_LABEL: Record<MediaInputRole, string> = {
  reference: '参考',
  first_frame: '首帧',
  last_frame: '尾帧',
  video: '视频',
  audio: '音频',
}
const PLACEHOLDER: Record<MediaOutput, string> = {
  image: '描述画面，输入 @ 引用素材',
  video: '描述画面变化，输入 @ 引用素材',
  audio: '输入要朗读的文字',
}
/** 带单位的参数：时长按秒，张数按张。-1 秒表示由模型定。 */
const DURATION = new Set(['duration', 'seconds'])
const UNIT: Record<string, string> = { duration: '秒', seconds: '秒', n: '张' }
/** 整数参数的取值个数不超过这么多时逐项列出，否则用加减按钮。 */
const MAX_LISTED = 12

/** 参数取值的界面用词：布尔值写开关，接口表示自动选择的取值写「自动」，其余原样。 */
export function valueText(v: unknown): string {
  if (v === true || v === 'true') return '开'
  if (v === false || v === 'false') return '关'
  if (v === 'adaptive' || v === 'auto') return '自动'
  return String(v)
}

/** 一个参数取值的读法：没有取值或由模型定写「自动」，有单位的带单位。 */
export function paramText(p: MediaParamOption, v: unknown): string {
  if (v === undefined || (DURATION.has(p.name) && Number(v) < 0)) return '自动'
  const unit = UNIT[p.name]
  return unit ? `${v} ${unit}` : valueText(v)
}

/** 底栏按钮上的字：只写取值，取值本身看不出是哪个参数时（自动、开关）补上参数名。 */
export function chipText(p: MediaParamOption, v: unknown): string {
  const text = paramText(p, v)
  if (text === '自动') return `自动${p.label}`
  if (typeof v === 'boolean') return `${p.label}${text}`
  return text
}

/** 一个节点现在指着的媒体：文件节点是它的路径，生成节点是当前那一版（还在远端时没有）。 */
export function mediaOf(
  view: CanvasView,
  nodeId: string,
): { kind: MediaOutput | null; path: string | null } {
  const node = view.doc.nodes.find((n) => n.id === nodeId)
  if (!node) return { kind: null, path: null }
  if (node.type === 'file') return { kind: canvasMediaOf(node), path: node.path }
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
              <Bitmap src={client.fileUrl(path())} width={48 * window.devicePixelRatio} />
            </Show>
          }
        >
          <Bitmap kind="video" src={client.fileUrl(path())} width={48 * window.devicePixelRatio} />
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
  /** 把工作区文件或本机文件放上画布（在这张卡附近），回新节点的 id；没放成回 `null`。 */
  place: (source: { path: string } | { file: File }) => Promise<string | null>
}) {
  void ensureModelCatalog()
  let editor!: HTMLDivElement
  const [draft, setDraft] = createSignal(props.node.prompt)
  const [menu, setMenu] = createSignal<Menu | null>(null)
  const [emptyMode, setEmptyMode] = createSignal<Mode>('reference')
  const [price, setPrice] = createSignal<CanvasQuote | null>(null)
  dismissOnOutside(menu, () => setMenu(null))
  /** `@` 弹出选择时光标所在的位置；选中后在这里插入标签。 */
  let caret: Range | null = null

  const edges = () => inputsOf(props.view.doc, props.node.id)
  const mode = (): Mode =>
    props.node.output !== 'video'
      ? 'reference'
      : edges().length
        ? modeOf(props.view.doc, props.node.id)
        : emptyMode()
  const running = () => props.state?.state === 'running'

  const models = (): MediaModelOption[] =>
    (modelCatalog()?.media ?? []).filter((m) => m.output === props.node.output)
  const model = (): MediaModelOption | undefined =>
    props.node.provider && props.node.model
      ? models().find((m) => m.provider === props.node.provider && m.id === props.node.model)
      : (models().find((m) => m.isDefault) ?? models()[0])
  const params = (): MediaParamOption[] => model()?.params ?? []
  const paramValue = (p: MediaParamOption) => props.node.params[p.name] ?? p.default
  const menuParam = () => {
    const m = menu()
    return m?.kind === 'param' ? params().find((p) => p.name === m.param) : undefined
  }
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

  // 画布回体换了提示词、而编辑框没有焦点时，按回体重建；有焦点时编辑框是真源。
  createEffect(
    on(
      () => props.node.prompt,
      (prompt) => {
        if (document.activeElement === editor) return
        render(prompt)
        setDraft(prompt)
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
      void decodeImage(client.fileUrl(media.path), 32 * window.devicePixelRatio).then(
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
    if (d === props.node.prompt) return true
    return props.apply([{ op: 'update', id: props.node.id, prompt: d }])
  }

  const send = () => {
    const d = draft()
    props.run(d === props.node.prompt ? [] : [{ op: 'update', id: props.node.id, prompt: d }])
  }

  /** 选素材时要连成的用途；`@` 打开的没有。 */
  const roleOf = (m: Menu | null) => (m?.kind === 'pick' ? m.role : undefined)

  /** 选素材的清单：首尾帧模式只列已连上的两帧（首尾帧不能与参考素材同时给）。 */
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
      // `@`：首尾帧模式下只列那两帧，其余模式列能作为输入的素材。
      if (mode() === 'first_last') return connected.has(n.id)
      return accepts(kind)
    })
  }
  const accepts = (kind: MediaOutput) =>
    props.node.output === 'image' ? kind === 'image' : props.node.output === 'video'
  /** 首尾帧只收图片；出图卡只收图片；视频卡收图片、视频、音频。 */
  const imagesOnly = () => {
    const role = roleOf(menu())
    return role === 'first_frame' || role === 'last_frame' || props.node.output === 'image'
  }
  const acceptsPath = (path: string) => {
    if (isInlineImage(path)) return true
    return !imagesOnly() && (isInlineVideo(path) || isInlineAudio(path))
  }
  const uploadAccept = () => (imagesOnly() ? 'image/*' : 'image/*,video/*,audio/*')
  const roleFor = (kind: MediaOutput): MediaInputRole =>
    kind === 'image' ? 'reference' : kind === 'video' ? 'video' : 'audio'

  const pick = (sourceId: string, m = menu()) => {
    setMenu(null)
    const wanted = roleOf(m)
    if (wanted) {
      const kind = mediaOf(props.view, sourceId).kind
      const role = wanted === 'reference' && kind ? roleFor(kind) : wanted
      void props.apply([{ op: 'connect', from: sourceId, to: props.node.id, role }])
      return
    }
    // `@`：在光标处插入标签，立刻提交提示词——未连线的素材由服务端在同一批里补线。
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

  /** 编辑框的监听挂在元素上：可编辑元素本身就收焦点与按键，不另加角色。 */
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

  /** 放上画布再选中：工作区文件与上传的文件都先成为画布节点；已在画布上的工作区文件直接用那个节点。 */
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

  /** 设一个参数；`undefined` 表示去掉，交给接口的缺省值。 */
  const setParam = (p: MediaParamOption, value: string | number | boolean | undefined) => {
    const next = { ...props.node.params }
    if (value === undefined || value === '') delete next[p.name]
    else next[p.name] = value
    void props.apply([{ op: 'update', id: props.node.id, params: next }])
  }

  /** 一个参数菜单里的逐项取值；整数范围太大时回 `null`，改用加减按钮。 */
  const choicesOf = (p: MediaParamOption): (string | number | boolean | undefined)[] | null => {
    // 没有缺省值的参数多一项「自动」：去掉取值，交给接口。
    const unset = p.default === undefined ? [undefined] : []
    if (p.type === 'enum') return [...unset, ...(p.values ?? [])]
    if (p.type === 'boolean') return [true, false]
    if (p.type === 'string') return [...unset, ...(p.presets ?? [])]
    if (p.type === 'integer' && p.min !== undefined && p.max !== undefined) {
      if (p.max - p.min + 1 > MAX_LISTED) return null
      return Array.from({ length: p.max - p.min + 1 }, (_, i) => (p.min as number) + i)
    }
    return null
  }
  const step = (p: MediaParamOption, delta: number) => {
    const now = Number(paramValue(p) ?? p.min ?? 0)
    const next = Math.min(p.max ?? Number.POSITIVE_INFINITY, Math.max(p.min ?? 0, now + delta))
    setParam(p, next)
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

  // 本次花费：模型、参数、输入数量变了就重问一次；推不出时不显示。
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
        if (!m) {
          setPrice(null)
          return
        }
        const timer = setTimeout(() => {
          const roles = edges().map((e) => e.role)
          void quoteCard({
            output: props.node.output,
            provider: m.provider,
            model: m.id,
            params: props.node.params,
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
            <IconPlus size={18} stroke={1.8} />
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
                  <IconPlus size={18} stroke={1.8} />
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

      <Show when={props.state?.state === 'failed' && props.node.versions.length > 0}>
        <div class="canvas-panel-error">
          {props.state?.state === 'failed' ? props.state.message : ''}
        </div>
      </Show>

      <div class="canvas-bar">
        <button
          class="mode-chip model"
          type="button"
          onClick={(e) => setMenu({ kind: 'model', anchor: e.currentTarget })}
        >
          <span class="truncate">{model()?.label ?? '未配置模型'}</span>
          <IconChevron size={10} />
        </button>
        <Show when={props.node.output === 'video' && modes().length > 1}>
          <button
            class="mode-chip"
            type="button"
            onClick={(e) => setMenu({ kind: 'mode', anchor: e.currentTarget })}
          >
            {mode() === 'first_last' ? '首尾帧' : '参考'}
            <IconChevron size={10} />
          </button>
        </Show>
        <For each={params()}>
          {(p) => (
            <button
              class="mode-chip"
              type="button"
              onClick={(e) => setMenu({ kind: 'param', anchor: e.currentTarget, param: p.name })}
            >
              <span class="truncate">{chipText(p, paramValue(p))}</span>
              <IconChevron size={10} />
            </button>
          )}
        </For>
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
        <button
          class="send-btn"
          type="button"
          aria-label="生成"
          disabled={!draft().trim() || running() || !model()}
          onClick={send}
        >
          <IconSend size={15} />
        </button>
      </div>

      <Show when={menu()}>
        {(m) => (
          <Switch>
            <Match when={m().kind === 'pick'}>
              <AnchoredMenu class="canvas-pick" anchor={m().anchor}>
                <SourcePicker
                  nodes={pickable()}
                  files={roleOf(m()) !== undefined || mode() !== 'first_last'}
                  accepts={acceptsPath}
                  accept={uploadAccept()}
                  thumb={(id) => <Thumb view={props.view} nodeId={id} />}
                  onNode={(id) => pick(id)}
                  onFile={(path) => void place([{ path }])}
                  onUpload={(files) => void place(files.map((file) => ({ file })))}
                />
              </AnchoredMenu>
            </Match>
            <Match when={m().kind === 'param' && menuParam()}>
              {(p) => (
                <AnchoredMenu class="canvas-menu canvas-param-menu" anchor={m().anchor}>
                  <Show
                    when={choicesOf(p())}
                    fallback={
                      <div class="canvas-stepper">
                        <button type="button" aria-label="减少" onClick={() => step(p(), -1)}>
                          −
                        </button>
                        <span>{paramText(p(), paramValue(p()))}</span>
                        <button type="button" aria-label="增加" onClick={() => step(p(), 1)}>
                          +
                        </button>
                      </div>
                    }
                  >
                    {(choices) => (
                      <For each={choices()}>
                        {(v) => (
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={paramValue(p()) === v}
                            onClick={() => {
                              setMenu(null)
                              setParam(p(), v)
                            }}
                          >
                            {paramText(p(), v)}
                          </button>
                        )}
                      </For>
                    )}
                  </Show>
                  <Show when={p().type === 'string'}>
                    <input
                      class="canvas-menu-custom"
                      type="text"
                      spellcheck={false}
                      placeholder="自定义"
                      value={
                        typeof paramValue(p()) === 'string' &&
                        !(p().presets ?? []).includes(paramValue(p()) as string)
                          ? String(paramValue(p()))
                          : ''
                      }
                      onKeyDown={(e) => {
                        if (e.key !== 'Enter') return
                        setMenu(null)
                        setParam(p(), e.currentTarget.value.trim() || undefined)
                      }}
                    />
                  </Show>
                </AnchoredMenu>
              )}
            </Match>
            <Match when={m().kind === 'model' || m().kind === 'mode'}>
              <AnchoredMenu class="canvas-menu" anchor={m().anchor}>
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
                            { op: 'update', id: props.node.id, provider: o.provider, model: o.id },
                          ])
                        }}
                      >
                        {o.label}
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
                        {o === 'first_last' ? '首尾帧' : '参考'}
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
