import { MEDIA_OUTPUTS, type MediaOutput } from '@qywork/core'
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import { modelCatalog, type PullResult, pullModels } from '../../lib/store/index.ts'
import { config, replaceConfig } from './configStore.ts'
import {
  addPulled,
  durationSummary,
  priceSummary,
  referenceSummary,
  refreshPulled,
} from './pulled.ts'

const TAB_LABEL: Record<'chat' | MediaOutput, string> = {
  chat: '对话',
  image: '图像',
  video: '视频',
  audio: '音频',
}

/**
 * 拉取接口上的型号，勾选后添加。打开即读取；读取成功时先按结果刷新已添加型号的规格、价格与已下架标记。
 *
 * 窗口尺寸固定（CLAUDE.md B9）：读取完成、切换页签时型号数量变化，列表在框内滚动，按钮位置不变。
 */
export function PullDialog(props: { provider: string; onClose: () => void }) {
  let dialog!: HTMLDialogElement
  const [result, setResult] = createSignal<PullResult>()
  const [error, setError] = createSignal<string | null>(null)
  const [tab, setTab] = createSignal<'chat' | MediaOutput>('chat')
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set())
  const [bases, setBases] = createSignal<Record<string, string>>({})
  let open = true

  const owner = () => config()?.providers[props.provider]
  const added = (id: string) => {
    const p = owner()
    return !!p && (id in p.models || id in (p.media ?? {}))
  }
  const tabs = () =>
    (['chat', ...MEDIA_OUTPUTS] as const).filter((o) =>
      result()?.models.some((m) => m.output === o),
    )
  const rows = () => result()?.models.filter((m) => m.output === tab()) ?? []
  /** 对应型号的可选项：模型库中的内置型号，按模型库的厂商顺序排列。 */
  const libraryIds = () =>
    (modelCatalog()?.library ?? []).flatMap((v) => (v.id ? v.models.map((m) => m.id) : []))

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
    const picks = (result()?.models ?? [])
      .filter((m) => picked().has(m.id))
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
              classList={{ active: tab() === o }}
              type="button"
              onClick={() => setTab(o)}
            >
              {TAB_LABEL[o]} {result()?.models.filter((m) => m.output === o).length}
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
                <p class="np-error pull-full" role="alert">
                  {message()}
                </p>
              )}
            </Show>
          }
        >
          <For each={rows()}>
            {(m) => {
              const done = () => added(m.id)
              const blocked = m.output !== 'chat' && m.unsupported
              return (
                <div class="pull-row" classList={{ off: done() || !!blocked }}>
                  <label class="pull-pick">
                    <input
                      type="checkbox"
                      checked={done() || picked().has(m.id)}
                      disabled={done() || !!blocked}
                      onChange={(e) => toggle(m.id, e.currentTarget.checked)}
                    />
                    <span class="pull-id" title={m.id}>
                      {m.id}
                    </span>
                  </label>
                  {/* 各列的单元格始终存在：行按共用的列宽对齐，空单元格保留该列的位置。
                      对应型号只在未添加时出现，与「已添加」「不支持」不会同时出现，共用最后一列。 */}
                  <span class="pull-cell">{durationSummary(m)}</span>
                  <span class="pull-cell">{referenceSummary(m)}</span>
                  <span class="pull-cell">{priceSummary(m)}</span>
                  <Show
                    when={m.output === 'chat' && !m.known && !done()}
                    fallback={
                      <span class="pull-cell" title={!done() && blocked ? blocked : undefined}>
                        {done() ? '已添加' : blocked ? '不支持' : ''}
                      </span>
                    }
                  >
                    <select
                      class="pull-base"
                      aria-label={`对应型号 ${m.id}`}
                      value={bases()[m.id] ?? ''}
                      onChange={(e) => {
                        const value = e.currentTarget.value
                        setBases((prev) => ({ ...prev, [m.id]: value }))
                      }}
                    >
                      {/* 占位项只在未选择时显示在框内，不出现在展开的列表中。 */}
                      <option value="" disabled hidden>
                        对应型号
                      </option>
                      <For each={libraryIds()}>{(id) => <option value={id}>{id}</option>}</For>
                    </select>
                  </Show>
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
          {picked().size ? `添加 ${picked().size} 个` : '添加'}
        </button>
      </div>
    </dialog>
  )
}
