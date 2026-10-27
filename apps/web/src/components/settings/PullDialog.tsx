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
  withBase,
} from './pulled.ts'

const TAB_LABEL: Record<'chat' | MediaOutput, string> = {
  chat: '对话',
  image: '图像',
  video: '视频',
  audio: '音频',
}

/**
 * 拉取接口上的型号，勾选后添加。打开即读取；读取成功时先按结果刷新已添加型号的规格、价格与已下架标记。
 * 未收录的型号可选对应型号：对话型号可选模型库中的内置型号与生成目录，所选型号决定该型号所在的页签与添加时的类别；
 * 生成型号只可选同类别的生成目录。
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
  const media = () => modelCatalog()?.mediaLibrary ?? []
  const models = () =>
    (result()?.models ?? []).map((m) => withBase(m, bases()[m.id], media(), owner()?.baseUrl))
  const tabs = () =>
    (['chat', ...MEDIA_OUTPUTS] as const).filter((o) => models().some((m) => m.output === o))
  // 最后一个型号改选其他类别的对应型号后，该页签不再存在，显示第一个页签。
  const current = () => (tabs().includes(tab()) ? tab() : (tabs()[0] ?? 'chat'))
  const rows = () => models().filter((m) => m.output === current())
  /**
   * 对应型号的可选项，按拉取结果中的类别确定，改选后移到其他页签的型号仍可改回。
   * 对话型号：模型库中的内置型号按模型库的厂商顺序排列，其后是生成目录。对话是未识别型号的归类，可改为生成类别。
   * 生成型号：同类别的生成目录。生成类别取自计费清单的接口类型或生成目录的名称识别。
   * 用户添加的条目不列出：配置校验只接受内置型号，选择后保存被拒绝。
   */
  const baseIds = (id: string) => {
    const output = result()?.models.find((m) => m.id === id)?.output ?? 'chat'
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
        setBases(
          Object.fromEntries(
            r.models.flatMap((m) => (m.output !== 'chat' && m.base ? [[m.id, m.base]] : [])),
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
              return (
                <div class="pull-row" classList={{ off: done() }}>
                  <label class="pull-pick">
                    <input
                      type="checkbox"
                      checked={done() || picked().has(m.id)}
                      disabled={done()}
                      onChange={(e) => toggle(m.id, e.currentTarget.checked)}
                    />
                    <span class="pull-id" title={m.id}>
                      {m.id}
                    </span>
                  </label>
                  {/* 各列的单元格始终存在：行按共用的列宽对齐，空单元格保留该列的位置。
                      对应型号只在未添加时出现，与「已添加」不会同时出现，共用最后一列。 */}
                  <span class="pull-cell">{durationSummary(m)}</span>
                  <span class="pull-cell">{referenceSummary(m)}</span>
                  <span class="pull-cell">{priceSummary(m)}</span>
                  <Show
                    when={!m.known && !done()}
                    fallback={<span class="pull-cell">{done() ? '已添加' : ''}</span>}
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
                      <For each={baseIds(m.id)}>{(id) => <option value={id}>{id}</option>}</For>
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
          添加
        </button>
      </div>
    </dialog>
  )
}
