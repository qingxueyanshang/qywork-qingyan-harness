import { createSignal, For, Show } from 'solid-js'
import {
  type CatalogEntry,
  explainApiError,
  type LibraryModel,
  type LibraryVendor,
} from '../../lib/store/index.ts'
import { IconX } from '../Icons.tsx'

/**
 * 模型库 —— **一张模型参数表**。
 *
 * ## 它和接口没有关系
 *
 * 库回答的是「这个模型本身是什么样」：窗口多大、最大能输出多少、多少钱、
 * 吃哪几档思考。接口回答的是「用谁的端点、哪把 key」。两者唯一的接点是接口下
 * 那一行模型 id——参数照着 id 从这张表里查。
 *
 * 所以这里**没有**「添加到接口」「新建接口」这类动作。往接口下挂模型在接口那一块。
 *
 * ## 为什么能改
 *
 * 内置值是源码里的一份 seed，其中七家的窗口和价格是抄来的、没有逐条实测
 * （`ai/src/catalog.ts` 里写明了）。厂商调一次价，目录就开始说谎，而说谎的出口
 * 只有账单上那个数。改过的条目标 `user`，可以还原回内置值。
 *
 * 目录里根本没有的模型也能自己加一条——那是「未收录模型计价按 0 算、
 * 用量报 $0」唯一的出口。
 */
export function ModelLibrary(props: {
  vendors: LibraryVendor[]
  loading: boolean
  /** 取不回来时的原因。不写的话这一节只是空着，看起来像「内置库里什么都没有」。 */
  error: unknown
  /** 写一条参数。传 null = 删掉这条覆盖，还原成内置值。 */
  onSave: (id: string, entry: CatalogEntry | null) => void
}) {
  /** 正在改哪一条。null = 都没在改。同一时刻只展开一条：两条一起改会撑得很高。 */
  const [editing, setEditing] = createSignal<string | null>(null)
  /** 正在往哪个厂商底下加。 */
  const [adding, setAdding] = createSignal<string | null>(null)

  return (
    <section class="settings-block lib">
      <div class="settings-block-head">
        <h3>模型库</h3>
      </div>
      <Show when={props.error}>
        {(e) => <div class="lib-hint">{explainApiError(e(), '读不到内置模型库')}</div>}
      </Show>
      <Show when={!props.loading && !props.error} fallback={<div class="lib-hint">读取中…</div>}>
        <div class="lib-list">
          <For each={props.vendors}>
            {(v) => (
              <div class="lib-vendor">
                <div class="lib-vendor-head">
                  <span class="lib-vendor-name">{v.displayName}</span>
                  <button
                    class="btn-ghost sm"
                    type="button"
                    onClick={() => {
                      setEditing(null)
                      setAdding(adding() === v.id ? null : v.id)
                    }}
                  >
                    添加模型
                  </button>
                </div>

                <Show when={adding() === v.id}>
                  <ModelForm
                    idEditable
                    vendor={v.id}
                    onCancel={() => setAdding(null)}
                    onSave={(id, entry) => {
                      props.onSave(id, entry)
                      setAdding(null)
                    }}
                  />
                </Show>

                <For each={v.models}>
                  {(m) => (
                    <>
                      <div class="lib-model">
                        <span class="lib-model-name">{m.label}</span>
                        <code class="lib-model-id">{m.id}</code>
                        <span class="lib-spec">窗口 {compact(m.contextWindow)}</span>
                        <span class="lib-spec">出 {compact(m.maxOutputTokens)}</span>
                        <span class="lib-spec">
                          {price(m.input, m.currency)} / {price(m.output, m.currency)}
                        </span>
                        {/* 空的就不画：一个空着的档位标签会被读成「不会思考」，
                            而它的意思是「这条协议上调不了档位」。 */}
                        <Show when={m.effortLevels.length > 0}>
                          <span class="lib-spec">{m.effortLevels.join('/')}</span>
                        </Show>
                        <Show when={m.source === 'user'}>
                          <span class="lib-spec edited">已改</span>
                        </Show>
                        {/* 价目有偏离的必须把「上面那个是标准价」说出来。只画一个数字，
                            用户对着账单会发现对不上，而差价是两倍。这是能力边界，
                            不折叠、不降对比度。 */}
                        <For each={m.priceNotes ?? []}>
                          {(note) => <span class="lib-pricenote">{note}</span>}
                        </For>
                        <button
                          class="btn-ghost sm"
                          type="button"
                          onClick={() => {
                            setAdding(null)
                            setEditing(editing() === m.id ? null : m.id)
                          }}
                        >
                          修改
                        </button>
                        {/* 还原只对改过的那些有意义。内置条目没有可还原的东西，
                            画一个灰按钮只会让人去点它。 */}
                        <Show when={m.source === 'user'}>
                          <button
                            class="icon-btn"
                            type="button"
                            aria-label={`还原 ${m.id} 的内置参数`}
                            title="还原成内置值"
                            onClick={() => {
                              props.onSave(m.id, null)
                              setEditing(null)
                            }}
                          >
                            <IconX size={12} />
                          </button>
                        </Show>
                      </div>

                      <Show when={editing() === m.id}>
                        <ModelForm
                          model={m}
                          vendor={v.id}
                          onCancel={() => setEditing(null)}
                          onSave={(id, entry) => {
                            props.onSave(id, entry)
                            setEditing(null)
                          }}
                        />
                      </Show>
                    </>
                  )}
                </For>
              </div>
            )}
          </For>
        </div>
      </Show>
    </section>
  )
}

/**
 * 改一条参数，或加一条。
 *
 * **留空 = 照内置值**，不是 0。所以空格子一律不写进覆盖里——写了 0 的话，
 * 窗口会变成 0、价格会变成免费，而这两个数没有任何地方会报错。
 */
function ModelForm(props: {
  model?: LibraryModel
  vendor: string
  /** 加新条目时 id 可编辑；改已有条目时 id 就是主键，不许改。 */
  idEditable?: boolean
  onCancel: () => void
  onSave: (id: string, entry: CatalogEntry) => void
}) {
  let idRef: HTMLInputElement | undefined
  let nameRef: HTMLInputElement | undefined
  let ctxRef: HTMLInputElement | undefined
  let outRef: HTMLInputElement | undefined
  let inPriceRef: HTMLInputElement | undefined
  let outPriceRef: HTMLInputElement | undefined
  let curRef: HTMLSelectElement | undefined

  const num = (el: HTMLInputElement | undefined) => {
    const v = el?.value.trim()
    if (!v) return undefined
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }

  const submit = () => {
    const id = (props.idEditable ? idRef?.value.trim() : props.model?.id) ?? ''
    if (!id) return
    const name = nameRef?.value.trim()
    const ctx = num(ctxRef)
    const out = num(outRef)
    const inPrice = num(inPriceRef)
    const outPrice = num(outPriceRef)
    // 空格子整个不写进去。`exactOptionalPropertyTypes` 开着，
    // 写 `x: undefined` 和不写这个键不是一回事，而落盘的是后者。
    props.onSave(id, {
      ...(name ? { displayName: name } : {}),
      ...(props.vendor ? { vendor: props.vendor } : {}),
      ...(ctx !== undefined ? { contextWindow: ctx } : {}),
      ...(out !== undefined ? { maxOutputTokens: out } : {}),
      ...(inPrice !== undefined ? { input: inPrice } : {}),
      ...(outPrice !== undefined ? { output: outPrice } : {}),
      currency: curRef?.value === 'CNY' ? 'CNY' : 'USD',
    })
  }

  return (
    <div class="lib-form">
      <Show when={props.idEditable}>
        <label class="lib-field">
          <span>模型 ID</span>
          <input ref={idRef} type="text" placeholder="调用时用的那个名字" />
        </label>
      </Show>
      <label class="lib-field">
        <span>显示名</span>
        <input ref={nameRef} type="text" value={props.model?.label ?? ''} />
      </label>
      <label class="lib-field">
        <span>上下文窗口</span>
        <input ref={ctxRef} type="number" min="1" value={props.model?.contextWindow ?? ''} />
      </label>
      <label class="lib-field">
        <span>最大输出</span>
        <input ref={outRef} type="number" min="1" value={props.model?.maxOutputTokens ?? ''} />
      </label>
      <label class="lib-field">
        <span>输入价 / 百万</span>
        <input
          ref={inPriceRef}
          type="number"
          min="0"
          step="0.001"
          value={props.model?.input ?? ''}
        />
      </label>
      <label class="lib-field">
        <span>输出价 / 百万</span>
        <input
          ref={outPriceRef}
          type="number"
          min="0"
          step="0.001"
          value={props.model?.output ?? ''}
        />
      </label>
      <label class="lib-field">
        <span>币种</span>
        <select ref={curRef}>
          <option value="USD" selected={props.model?.currency !== 'CNY'}>
            USD
          </option>
          <option value="CNY" selected={props.model?.currency === 'CNY'}>
            CNY
          </option>
        </select>
      </label>
      <div class="lib-form-actions">
        <button class="btn-ghost sm" type="button" onClick={props.onCancel}>
          取消
        </button>
        <button class="btn-primary sm" type="button" onClick={submit}>
          保存
        </button>
      </div>
    </div>
  )
}

/** 100 万 → 1M。窗口和上限都是量级信息，完整数字反而要人数零。 */
function compact(n: number): string {
  if (n >= 1_000_000) return `${Math.round(n / 100_000) / 10}M`
  if (n >= 1000) return `${Math.round(n / 1000)}K`
  return String(n)
}

/** 每百万 token 的单价。币种是数据的一部分——¥6 当成 $6 差七倍。 */
function price(n: number, currency: 'USD' | 'CNY'): string {
  return `${currency === 'CNY' ? '¥' : '$'}${n}`
}
