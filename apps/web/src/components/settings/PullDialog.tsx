import { MEDIA_OUTPUTS, type MediaOutput } from '@qywork/core'
import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import { modelCatalog, type PullResult, pullModels } from '../../lib/store/index.ts'
import { config, replaceConfig } from './configStore.ts'
import {
  addPulled,
  type ClassifiedModel,
  durationSummary,
  priceSummary,
  referenceSummary,
  refreshPulled,
  withBase,
  withCategory,
} from './pulled.ts'

type Category = 'chat' | MediaOutput

const CATEGORIES: readonly Category[] = ['chat', ...MEDIA_OUTPUTS]

const TAB_LABEL: Record<Category | 'unknown', string> = {
  chat: '对话',
  image: '图像',
  video: '视频',
  audio: '音频',
  unknown: '未知',
}

/**
 * 拉取接口上的型号，勾选后添加。打开即读取；读取成功时先按结果刷新已添加型号的规格、价格与已下架标记。
 * 未收录的型号可选对应型号：对话型号可选模型库中的内置型号与生成目录，所选型号决定该型号所在的页签与添加时的类别；
 * 生成型号只可选同类别的生成目录。未知型号须先选类别，选定后移到该类别的页签，再按该类别添加。
 *
 * 窗口尺寸固定（CLAUDE.md B9）：读取完成、切换页签时型号数量变化，列表在框内滚动，按钮位置不变。
 */
export function PullDialog(props: { provider: string; onClose: () => void }) {
  let dialog!: HTMLDialogElement
  const [result, setResult] = createSignal<PullResult>()
  const [error, setError] = createSignal<string | null>(null)
  const [tab, setTab] = createSignal<Category | 'unknown'>('chat')
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set())
  const [bases, setBases] = createSignal<Record<string, string>>({})
  const [categories, setCategories] = createSignal<Record<string, Category>>({})
  let open = true

  const owner = () => config()?.providers[props.provider]
  const added = (id: string) => {
    const p = owner()
    return !!p && (id in p.models || id in (p.media ?? {}))
  }
  const media = () => modelCatalog()?.mediaLibrary ?? []
  const classified = (id: string) => {
    const m = result()?.models.find((x) => x.id === id)
    return m && withCategory(m, categories()[id], owner()?.baseUrl)
  }
  const models = () =>
    (result()?.models ?? []).map((m) =>
      withBase(classified(m.id) ?? m, bases()[m.id], media(), owner()?.baseUrl),
    )
  const tabs = () =>
    ([...CATEGORIES, 'unknown'] as const).filter((o) => models().some((m) => m.output === o))
  // 最后一个型号改选其他类别的对应型号后，该页签不再存在，显示第一个页签。
  const current = () => (tabs().includes(tab()) ? tab() : (tabs()[0] ?? 'chat'))
  const rows = () => models().filter((m) => m.output === current())
  /**
   * 对应型号的可选项，按拉取结果中的类别（未知型号按选定的类别）确定，改选后移到其他页签的型号仍可改回。
   * 对话型号：模型库中的内置型号按模型库的厂商顺序排列，其后是生成目录，可改为生成类别。
   * 生成型号：同类别的生成目录。生成类别取自计费清单的接口类型或生成目录的名称识别。
   * 用户添加的条目不列出：配置校验只接受内置型号，选择后保存被拒绝。
   */
  const baseIds = (id: string) => {
    const output = classified(id)?.output ?? 'chat'
    if (output === 'unknown') return []
    if (output !== 'chat') return media().flatMap((m) => (m.output === output ? [m.id] : []))
    return [
      ...(modelCatalog()?.library ?? []).flatMap((v) =>
        v.models.flatMap((m) => (m.builtin ? [m.id] : [])),
      ),
      ...media().map((m) => m.id),
    ]
  }

  const toggle = (id: string, on: boolean) =>
    setPicked((prev) => {
      const next = new Set(prev)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  // 保存在窗口关闭后才执行：编辑函数中不能读取 props，接口名在操作时取出。
  const submit = () => {
    const provider = props.provider
    const picks = models()
      .filter((m): m is ClassifiedModel => m.output !== 'unknown' && picked().has(m.id))
      .map((model) => ({ model, ...(bases()[model.id] ? { base: bases()[model.id]! } : {}) }))
    void replaceConfig((cur) => addPulled(cur, provider, picks))
    props.onClose()
  }

  onMount(() => {
    dialog.showModal()
    const provider = props.provider
    void pullModels(provider).then(
      (r) => {
        if (!open) return
        setBases(
          Object.fromEntries(
            r.models.flatMap((m) =>
              m.output !== 'chat' && m.output !== 'unknown' && m.base ? [[m.id, m.base]] : [],
            ),
          ),
        )
        setResult(r)
        setTab(tabs()[0] ?? 'chat')
        void replaceConfig((cur) => refreshPulled(cur, provider, r))
      },
      (e) => {
        if (open) setError(e instanceof Error ? e.message : String(e))
      },
    )
  })
  onCleanup(() => {
    open = false
    dialog.close()
  })

  return (
    <dialog
      ref={dialog}
      class="pull-dialog"
      aria-label="拉取模型"
      onCancel={(e) => {
        e.preventDefault()
        props.onClose()
      }}
      onKeyDown={(e) => {
        // Escape 只关闭本窗口，不把后面的设置窗口一起关闭。
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <h2 class="confirm-title">拉取模型 · {props.provider}</h2>
      <div class="lib-tabs pull-tabs">
        <For each={tabs()}>
          {(o) => (
            <button
              class="lib-tab"
              classList={{ active: current() === o }}
              type="button"
              onClick={() => setTab(o)}
            >
              {TAB_LABEL[o]} {models().filter((m) => m.output === o).length}
            </button>
          )}
        </For>
      </div>
      <section class="pull-list" aria-busy={!result() && !error()}>
        <Show
          when={result()}
          fallback={
            <Show when={error()} fallback={<p class="pull-state pull-full">读取中…</p>}>
              {(message) => (
                <p class="pull-error pull-full" role="alert">
                  {message()}
                </p>
              )}
            </Show>
          }
        >
          <For each={rows()}>
            {(m) => {
              const done = () => added(m.id)
              return (
                <div class="pull-row" classList={{ off: done() }}>
                  <label class="pull-pick">
                    <input
                      type="checkbox"
                      checked={done() || picked().has(m.id)}
                      disabled={done() || m.output === 'unknown'}
                      onChange={(e) => toggle(m.id, e.currentTarget.checked)}
                    />
                    <span class="pull-id" title={m.id}>
                      {m.id}
                    </span>
                  </label>
                  {/* 各列的单元格始终存在：行按共用的列宽对齐，空单元格保留该列的位置。
                      类别、对应型号只在未添加时出现，与「已添加」不会同时出现，共用最后一列。 */}
                  <span class="pull-cell">{durationSummary(m)}</span>
                  <span class="pull-cell">{referenceSummary(m)}</span>
                  <span class="pull-cell">{priceSummary(m)}</span>
                  <Switch fallback={<span class="pull-cell" />}>
                    <Match when={done()}>
                      <span class="pull-cell">已添加</span>
                    </Match>
                    <Match when={m.output === 'unknown'}>
                      <select
                        class="pull-base"
                        aria-label={`类别 ${m.id}`}
                        value=""
                        onChange={(e) => {
                          const value = e.currentTarget.value as Category
                          setCategories((prev) => ({ ...prev, [m.id]: value }))
                        }}
                      >
                        {/* 占位项只在未选择时显示在框内，不出现在展开的列表中。 */}
                        <option value="" disabled hidden>
                          类别
                        </option>
                        <For each={CATEGORIES}>
                          {(o) => <option value={o}>{TAB_LABEL[o]}</option>}
                        </For>
                      </select>
                    </Match>
                    <Match when={m.output !== 'unknown' && !m.known}>
                      <select
                        class="pull-base"
                        aria-label={`对应型号 ${m.id}`}
                        value={bases()[m.id] ?? ''}
                        onChange={(e) => {
                          const value = e.currentTarget.value
                          setBases((prev) => ({ ...prev, [m.id]: value }))
                        }}
                      >
                        <option value="" disabled hidden>
                          对应型号
                        </option>
                        <For each={baseIds(m.id)}>{(id) => <option value={id}>{id}</option>}</For>
                      </select>
                    </Match>
                  </Switch>
                </div>
              )
            }}
          </For>
        </Show>
      </section>
      <div class="confirm-actions">
        <button class="btn-ghost" type="button" onClick={props.onClose}>
          取消
        </button>
        <button class="btn-primary" type="button" disabled={picked().size === 0} onClick={submit}>
          添加
        </button>
      </div>
    </dialog>
  )
}
