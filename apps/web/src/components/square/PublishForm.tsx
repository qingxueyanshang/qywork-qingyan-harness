import type { SquarePublishSource } from '@qywork/core'
import {
  SQUARE_GITHUB_KINDS,
  SQUARE_KIND_LABEL,
  SQUARE_KINDS,
  type SquareGithubKind,
  type SquareKind,
} from '@qywork/core'
import { createResource, createSignal, For, type JSX, Match, Show, Switch } from 'solid-js'
import { createStore } from 'solid-js/store'
import { client } from '../../lib/store/client.ts'
import { explainApiError } from '../../lib/store/index.ts'
import { publishSquare, submitSquareGithub } from '../../lib/store/square.ts'
import { captureVideoFrame } from '../canvas/frame.ts'

interface Option {
  value: string
  label: string
}

const paths = (r: { matches: { path: string; kind: string }[] }): Option[] =>
  r.matches.filter((m) => m.kind === 'file').map((m) => ({ value: m.path, label: m.path }))

/** 各类型可发布的本机内容；为 null 的类型不需要选择（提示词填写正文，皮肤取当前的皮肤）。 */
const SOURCES: Record<SquareKind, (() => Promise<Option[]>) | null> = {
  prompt: null,
  skin: null,
  work: async () => {
    const [media, decks] = await Promise.all([
      client.api<{ matches: { path: string; kind: string }[] }>(
        '/api/files/find?q=&kinds=image,video',
      ),
      client.api<{ matches: { path: string; kind: string }[] }>('/api/files/find?q=&office=pptx'),
    ])
    return [...paths(media), ...paths(decks)]
  },
  canvas: async () =>
    paths(await client.api('/api/files/find?q=.canvas.json')).filter((o) =>
      o.value.endsWith('.canvas.json'),
    ),
  plugin: async () =>
    (await client.api<{ plugins: { id: string; name: string }[] }>('/api/plugins')).plugins.map(
      (p) => ({ value: p.id, label: p.name }),
    ),
  skill: async () =>
    (
      await client.api<{ skills: { name: string; dir: string; scope: string }[] }>('/api/skills')
    ).skills
      .filter((s) => s.scope === 'project' || s.scope === 'global')
      .map((s) => ({ value: s.dir, label: s.name })),
  mcp: async () =>
    (
      await client.api<{ configured: { name: string; pendingCommand?: string }[] }>('/api/mcp')
    ).configured
      .filter((s) => s.pendingCommand === undefined)
      .map((s) => ({ value: s.name, label: s.name })),
  pet: async () =>
    (await client.api<{ pets: { id: string; pack: { name: string } }[] }>('/api/pets')).pets.map(
      (p) => ({ value: p.id, label: p.pack.name }),
    ),
}

const VIDEO = /\.(mp4|webm)$/i

/** 由表单得出发布的来源；选择缺失时为 null。 */
function sourceOf(
  kind: SquareKind,
  f: { picked: string; text: string; prompt: string },
): SquarePublishSource | null {
  if (kind === 'prompt') return f.text.trim() ? { kind, text: f.text } : null
  if (kind === 'skin') return { kind }
  if (!f.picked) return null
  if (kind === 'work')
    return { kind, path: f.picked, ...(f.prompt.trim() ? { prompt: f.prompt } : {}) }
  if (kind === 'canvas') return { kind, path: f.picked }
  if (kind === 'skill') return { kind, dir: f.picked }
  if (kind === 'mcp') return { kind, name: f.picked }
  return { kind, id: f.picked }
}

/**
 * 发布表单：类型、标题、简介与要发布的本机内容。`itemId` 给出时发布该条目的新版本，类型固定为 `kind`。
 * 视频作品的封面在本界面截取首帧。
 */
export function PublishForm(props: {
  itemId?: string
  kind?: SquareKind
  onDone: (message: string) => void
}): JSX.Element {
  const [form, setForm] = createStore({
    kind: props.kind ?? ('prompt' as SquareKind),
    title: '',
    summary: '',
    picked: '',
    text: '',
    prompt: '',
    /** 内容的来源：本机，或 GitHub 仓库（只限 `SQUARE_GITHUB_KINDS`）。 */
    origin: 'local' as 'local' | 'github',
    url: '',
    ref: '',
    path: '',
  })
  const fromGithub = () =>
    form.origin === 'github' && (SQUARE_GITHUB_KINDS as readonly string[]).includes(form.kind)

  /** 收录 GitHub 仓库：仓库与标签必填。 */
  const submitGithub = async () => {
    if (!form.url.trim() || !form.ref.trim()) {
      setError('请填写仓库与标签')
      return
    }
    setBusy(true)
    setError('')
    try {
      await submitSquareGithub({
        kind: form.kind as SquareGithubKind,
        url: form.url.trim(),
        ref: form.ref.trim(),
        ...(form.path.trim() ? { path: form.path.trim() } : {}),
        title: form.title,
        summary: form.summary,
      })
      props.onDone('已提交，待审核')
    } catch (err) {
      setError(explainApiError(err, '收录失败'))
    } finally {
      setBusy(false)
    }
  }
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal('')
  const [options] = createResource(
    () => form.kind,
    (kind) => SOURCES[kind]?.() ?? Promise.resolve([] as Option[]),
  )

  const submit = async (e: Event) => {
    e.preventDefault()
    if (fromGithub()) return submitGithub()
    const source = sourceOf(form.kind, form)
    if (!source) {
      setError('请选择要发布的内容')
      return
    }
    setBusy(true)
    setError('')
    try {
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
      props.onDone('已提交，待审核')
    } catch (err) {
      setError(explainApiError(err, '发布失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form class="square-publish" onSubmit={(e) => void submit(e)}>
      <label>
        类型
        <select
          value={form.kind}
          disabled={props.itemId !== undefined}
          onChange={(e) => setForm({ kind: e.currentTarget.value as SquareKind, picked: '' })}
        >
          <For each={SQUARE_KINDS}>{(k) => <option value={k}>{SQUARE_KIND_LABEL[k]}</option>}</For>
        </select>
      </label>
      <label>
        标题
        <input
          maxLength={60}
          value={form.title}
          onInput={(e) => setForm('title', e.currentTarget.value)}
        />
      </label>
      <label>
        简介
        <textarea
          maxLength={500}
          rows={3}
          value={form.summary}
          onInput={(e) => setForm('summary', e.currentTarget.value)}
        />
      </label>
      <Show
        when={
          props.itemId === undefined &&
          (SQUARE_GITHUB_KINDS as readonly string[]).includes(form.kind)
        }
      >
        <label>
          来源
          <select
            value={form.origin}
            onChange={(e) => setForm('origin', e.currentTarget.value as 'local' | 'github')}
          >
            <option value="local">本机</option>
            <option value="github">GitHub 仓库</option>
          </select>
        </label>
      </Show>
      <Switch>
        <Match when={fromGithub()}>
          <label>
            仓库
            <input value={form.url} onInput={(e) => setForm('url', e.currentTarget.value)} />
          </label>
          <label>
            标签或分支
            <input value={form.ref} onInput={(e) => setForm('ref', e.currentTarget.value)} />
          </label>
          <label>
            子目录
            <input value={form.path} onInput={(e) => setForm('path', e.currentTarget.value)} />
          </label>
        </Match>
        <Match when={form.kind === 'prompt'}>
          <label>
            正文
            <textarea
              rows={8}
              value={form.text}
              onInput={(e) => setForm('text', e.currentTarget.value)}
            />
          </label>
        </Match>
        <Match when={SOURCES[form.kind]}>
          <label>
            内容
            <select value={form.picked} onChange={(e) => setForm('picked', e.currentTarget.value)}>
              <option value="" />
              <For each={options() ?? []}>{(o) => <option value={o.value}>{o.label}</option>}</For>
            </select>
          </label>
        </Match>
      </Switch>
      <Show when={form.kind === 'work'}>
        <label>
          提示词
          <textarea
            rows={4}
            value={form.prompt}
            onInput={(e) => setForm('prompt', e.currentTarget.value)}
          />
        </label>
      </Show>
      <Show when={error()}>{(m) => <p class="square-error">{m()}</p>}</Show>
      <div class="square-publish-actions">
        <button type="submit" class="btn-primary" disabled={busy()}>
          发布
        </button>
      </div>
    </form>
  )
}
