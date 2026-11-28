import {
  GRADIENT_ANGLE,
  SQUARE_KIND_LABEL,
  type SquareKind,
  type SquarePublishSource,
} from '@qywork/core'
import {
  createResource,
  createSignal,
  For,
  type JSX,
  Match,
  onCleanup,
  onMount,
  Show,
  Switch,
} from 'solid-js'
import { createStore } from 'solid-js/store'
import { frameFileUrl, scaledFileUrl } from '../../lib/client.ts'
import { createFileSearch } from '../../lib/file-search.ts'
import { loaded } from '../../lib/resource.ts'
import { client } from '../../lib/store/client.ts'
import { explainApiError, paintedPersonalization } from '../../lib/store/index.ts'
import { publishSquare } from '../../lib/store/square.ts'
import { captureVideoFrame } from '../canvas/frame.ts'
import { IconCheck, IconFile, IconSearch, IconX } from '../Icons.tsx'
import { Skeleton } from '../settings/LoadState.tsx'
import { EmptyBox } from '../settings/Page.tsx'
import { KIND_VIEW } from './kinds.tsx'

/** 可选的一项本机内容：`value` 为发布来源中的标识，`detail` 为名称下方的次要信息。 */
interface Option {
  value: string
  label: string
  detail?: string
}

/** 文件按文件名列出，所在目录作为次要信息。 */
function fileOption(path: string): Option {
  const i = path.lastIndexOf('/')
  return { value: path, label: path.slice(i + 1), ...(i > 0 ? { detail: path.slice(0, i) } : {}) }
}

const SCOPE_LABEL: Record<string, string> = { project: '项目', global: '全局' }

/**
 * 各类型的内容区：名称与本机可发布的条目。`source` 为 null 的类型另有内容区：作品按名称搜索文件
 * （`createFileSearch`），皮肤为当前的皮肤。
 * 作品不要改回一次列出全部文件：服务端的查找有条数上限，按目录逐层遍历，工作区文件多时深层目录中的文件不在结果中。
 */
const FORMS: Record<SquareKind, { label: string; source: (() => Promise<Option[]>) | null }> = {
  work: { label: '文件', source: null },
  canvas: {
    label: '画布',
    source: async () =>
      (
        await client.api<{ matches: { path: string; kind: string }[] }>(
          '/api/files/find?q=.canvas.json',
        )
      ).matches
        .filter((m) => m.kind === 'file' && m.path.endsWith('.canvas.json'))
        .map((m) => fileOption(m.path)),
  },
  plugin: {
    label: '插件',
    source: async () =>
      (
        await client.api<{ plugins: { id: string; name: string; version: string }[] }>(
          '/api/plugins',
        )
      ).plugins.map((p) => ({ value: p.id, label: p.name, detail: p.version })),
  },
  skill: {
    label: '技能',
    source: async () =>
      (
        await client.api<{ skills: { name: string; dir: string; scope: string }[] }>('/api/skills')
      ).skills
        .filter((s) => s.scope === 'project' || s.scope === 'global')
        .map((s) => ({ value: s.dir, label: s.name, detail: SCOPE_LABEL[s.scope] ?? s.scope })),
  },
  mcp: {
    label: 'MCP 服务',
    source: async () =>
      (
        await client.api<{ configured: { name: string; pendingCommand?: string }[] }>('/api/mcp')
      ).configured
        .filter((s) => s.pendingCommand === undefined)
        .map((s) => ({ value: s.name, label: s.name })),
  },
  pet: {
    label: '宠物',
    source: async () =>
      (await client.api<{ pets: { id: string; pack: { name: string } }[] }>('/api/pets')).pets.map(
        (p) => ({ value: p.id, label: p.pack.name }),
      ),
  },
  skin: { label: '皮肤', source: null },
}

const VIDEO = /\.(mp4|webm)$/i

/** 作品文件的缩略图：图片按显示宽度取缩小的位图，视频取首帧，演示文稿为文件图标。 */
function FileThumb(props: { path: string; width: number }) {
  const url = () => client.fileUrl(props.path, '')
  return (
    <Switch fallback={<img src={scaledFileUrl(url(), props.width)} alt="" loading="lazy" />}>
      <Match when={props.path.endsWith('.pptx')}>
        <IconFile size={20} />
      </Match>
      <Match when={VIDEO.test(props.path)}>
        <video src={frameFileUrl(url(), 0)} muted preload="metadata" />
      </Match>
    </Switch>
  )
}

/**
 * 当前皮肤的缩略界面：背景（图片、渐变或纯色）之上是顶栏与侧栏（外框色）、会话区（内容色）与一个强调色按钮。
 * 外框色、内容色与强调色取界面正在使用的变量：当前皮肤已作用于这些变量，不透明度小于 1 时它们是半透明色。
 */
function SkinPreview() {
  const p = () => paintedPersonalization()
  const backdrop = (): JSX.CSSProperties => {
    const bg = p()?.personalization.background
    if (bg?.kind === 'gradient') {
      return {
        background: `linear-gradient(${GRADIENT_ANGLE[bg.direction]}deg, ${bg.from}, ${bg.to})`,
      }
    }
    return { background: bg?.kind === 'color' && bg.color ? bg.color : 'var(--bg-app)' }
  }
  return (
    <div class="square-skin" style={backdrop()}>
      <Show when={p()?.imageUrl}>{(src) => <img class="square-skin-bg" src={src()} alt="" />}</Show>
      <div class="square-skin-top" />
      <div class="square-skin-side">
        <span class="square-skin-line" />
        <span class="square-skin-line short" />
        <span class="square-skin-line" />
      </div>
      <div class="square-skin-main">
        <span class="square-skin-line" />
        <span class="square-skin-line short" />
        <span class="square-skin-accent" />
      </div>
    </div>
  )
}

/** 由表单得出发布的来源；内容缺失时为 null。 */
function sourceOf(
  kind: SquareKind,
  f: { picked: string; prompt: string },
): SquarePublishSource | null {
  if (kind === 'skin') return { kind }
  if (!f.picked) return null
  if (kind === 'work')
    return { kind, path: f.picked, ...(f.prompt.trim() ? { prompt: f.prompt } : {}) }
  if (kind === 'canvas') return { kind, path: f.picked }
  if (kind === 'skill') return { kind, dir: f.picked }
  if (kind === 'mcp') return { kind, name: f.picked }
  return { kind, id: f.picked }
}

/** 类型名称以字母开头时与前面的汉字之间留一个空格（「发布 MCP」）。 */
const titleOf = (kind: SquareKind) => {
  const label = SQUARE_KIND_LABEL[kind]
  return /^[A-Za-z]/.test(label) ? `发布 ${label}` : `发布${label}`
}

/**
 * 发布窗口，打开在创作广场之上，类型取创作广场当前的类型。上方是条目在创作广场中的样子，标题与简介在其中填写；
 * 下方是该类型的内容：本机的插件、技能等逐项列出供选择，作品按名称搜索文件并可附提示词，皮肤为当前的皮肤。
 * `itemId` 给出时发布该条目的新版本。视频作品的封面在本界面截取首帧。
 * 尺寸固定（B9）：各类型的内容区高度不同，超出时在窗口内滚动。
 */
export function PublishDialog(props: {
  kind: SquareKind
  itemId?: string
  onDone: () => void
  onClose: () => void
}): JSX.Element {
  let dialog!: HTMLDialogElement
  const spec = FORMS[props.kind]
  const view = KIND_VIEW[props.kind]
  const [form, setForm] = createStore({ title: '', summary: '', picked: '', prompt: '' })
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [options] = createResource(() => spec.source?.() ?? Promise.resolve([] as Option[]))

  const media = createFileSearch(() => ({ kinds: ['image', 'video'] }))
  const decks = createFileSearch(() => ({ office: 'pptx' }))
  const searchWork = (text: string) => {
    media.search(text)
    decks.search(text)
  }

  onMount(() => {
    dialog.showModal()
    if (props.kind === 'work') searchWork('')
  })
  onCleanup(() => dialog.close())

  const send = async () => {
    if (!form.title.trim()) throw new Error('请填写标题')
    const source = sourceOf(props.kind, form)
    if (!source) throw new Error(`请选择${spec.label}`)
    const cover =
      source.kind === 'work' && VIDEO.test(source.path)
        ? await captureVideoFrame(client.fileUrl(source.path, Date.now()), 0)
        : undefined
    await publishSquare(
      {
        title: form.title,
        summary: form.summary,
        source,
        ...(props.itemId ? { itemId: props.itemId } : {}),
      },
      cover,
    )
  }

  const submit = async (e: Event) => {
    e.preventDefault()
    if (busy()) return
    setBusy(true)
    setError('')
    try {
      await send()
      props.onDone()
    } catch (err) {
      setError(explainApiError(err, '发布失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <dialog
      ref={dialog}
      class="square-publish-dialog"
      aria-label={props.itemId ? '发布新版本' : titleOf(props.kind)}
      onCancel={(e) => {
        e.preventDefault()
        if (!busy()) props.onClose()
      }}
      onKeyDown={(e) => {
        // Escape 只关闭本窗口，不关闭下层的创作广场。
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <header class="square-publish-head">
        <h2 class="square-publish-title">{props.itemId ? '发布新版本' : titleOf(props.kind)}</h2>
        <button
          class="icon-btn square-publish-close"
          type="button"
          aria-label="关闭"
          onClick={() => props.onClose()}
        >
          <IconX size={15} />
        </button>
      </header>
      <form class="square-publish" onSubmit={(e) => void submit(e)}>
        <div class="square-publish-body">
          <div class="square-listing">
            <div class="square-listing-thumb">
              <Switch
                fallback={
                  <view.icon size={22} {...(view.iconClass ? { class: view.iconClass } : {})} />
                }
              >
                <Match when={props.kind === 'skin' && paintedPersonalization()?.imageUrl}>
                  {(src) => <img src={src()} alt="" />}
                </Match>
                <Match when={props.kind === 'work' && form.picked}>
                  {(path) => <FileThumb path={path()} width={112} />}
                </Match>
              </Switch>
            </div>
            <div class="square-listing-text">
              <input
                class="square-listing-name"
                aria-label="标题"
                placeholder="标题"
                maxLength={60}
                value={form.title}
                onInput={(e) => setForm('title', e.currentTarget.value)}
              />
              <textarea
                class="square-listing-desc"
                aria-label="简介"
                placeholder="简介"
                maxLength={500}
                rows={2}
                value={form.summary}
                onInput={(e) => setForm('summary', e.currentTarget.value)}
              />
            </div>
          </div>

          <section class="square-block">
            <h3 class="square-block-title">{spec.label}</h3>
            <Switch
              fallback={
                <Choices
                  kind={props.kind}
                  options={loaded(options)}
                  error={options.error}
                  empty={`暂无${spec.label}`}
                  picked={form.picked}
                  onPick={(v) => setForm('picked', v)}
                />
              }
            >
              <Match when={props.kind === 'skin'}>
                <SkinPreview />
              </Match>
              <Match when={props.kind === 'work'}>
                <label class="square-search square-publish-search">
                  <IconSearch size={14} />
                  <input
                    type="search"
                    aria-label="搜索文件"
                    placeholder="搜索文件"
                    spellcheck={false}
                    onInput={(e) => {
                      setForm('picked', '')
                      searchWork(e.currentTarget.value)
                    }}
                  />
                </label>
                <div class="square-thumbs" role="listbox" aria-label="文件">
                  <For each={[...media.hits(), ...decks.hits()]}>
                    {(path) => (
                      <button
                        type="button"
                        role="option"
                        class="square-thumb"
                        classList={{ selected: form.picked === path }}
                        aria-selected={form.picked === path}
                        onClick={() => setForm('picked', path)}
                      >
                        <span class="square-thumb-img">
                          <FileThumb path={path} width={240} />
                        </span>
                        <span class="square-thumb-name">{fileOption(path).label}</span>
                      </button>
                    )}
                  </For>
                </div>
              </Match>
            </Switch>
          </section>

          <Show when={props.kind === 'work'}>
            <section class="square-block">
              <h3 class="square-block-title">提示词</h3>
              <textarea
                class="square-editor"
                aria-label="提示词"
                rows={4}
                value={form.prompt}
                onInput={(e) => setForm('prompt', e.currentTarget.value)}
              />
            </section>
          </Show>
        </div>
        <footer class="square-publish-foot">
          <p class="square-publish-error">{error()}</p>
          <button type="button" class="btn-ghost" onClick={() => props.onClose()}>
            取消
          </button>
          <button type="submit" class="btn-primary" disabled={busy()}>
            发布
          </button>
        </footer>
      </form>
    </dialog>
  )
}

/**
 * 本机内容的选择卡片：单选，选中的一张以强调色描边并带勾选标记。
 * `options` 为 undefined 时为读取中，`error` 为读取失败的原因。
 */
function Choices(props: {
  kind: SquareKind
  options: Option[] | undefined
  error?: unknown
  empty: string
  picked: string
  onPick: (value: string) => void
}) {
  const view = KIND_VIEW[props.kind]
  return (
    <Show
      when={props.options}
      fallback={
        props.error ? (
          <p class="square-error">{explainApiError(props.error, '读取失败')}</p>
        ) : (
          <Skeleton lines={2} />
        )
      }
    >
      {(list) => (
        <Show when={list().length > 0} fallback={<EmptyBox label={props.empty} />}>
          <div class="square-choices" role="listbox" aria-label={FORMS[props.kind].label}>
            <For each={list()}>
              {(o) => (
                <button
                  type="button"
                  role="option"
                  class="square-choice"
                  classList={{ selected: props.picked === o.value }}
                  aria-selected={props.picked === o.value}
                  onClick={() => props.onPick(o.value)}
                >
                  <span class="square-icon">
                    <view.icon size={16} {...(view.iconClass ? { class: view.iconClass } : {})} />
                  </span>
                  <span class="square-row-text">
                    <span class="square-name">{o.label}</span>
                    <Show when={o.detail}>{(d) => <span class="square-desc">{d()}</span>}</Show>
                  </span>
                  <Show when={props.picked === o.value}>
                    <IconCheck size={16} class="square-choice-check" />
                  </Show>
                </button>
              )}
            </For>
          </div>
        </Show>
      )}
    </Show>
  )
}
