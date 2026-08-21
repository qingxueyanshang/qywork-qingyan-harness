import { createSignal, For, Show } from 'solid-js'
import {
  type CatalogEntry,
  explainApiError,
  type LibraryModel,
  type LibraryVendor,
} from '../../lib/store/index.ts'

/**
 * 模型库 —— **一张模型参数表**。
 *
 * ## 它和接口没有关系
 *
 * 库回答「这个模型本身是什么样」：窗口多大、最大能输出多少、多少钱、吃哪几档思考。
 * 接口回答「用谁的端点、哪把 key」。两者唯一的接点是接口下那一行模型 id——
 * 参数照着 id 从这张表里查。所以这里没有「添加到接口」「新建接口」这类动作。
 *
 * ## 一个厂商一张卡，卡里一张自己的表
 *
 * 参数排成一行小标签时，两条模型的同一项不在同一个横坐标上，眼睛得逐条读，
 * 比不出来。所以每家的模型排成表：每项钉在一列上，扫一眼就是一列数字。
 * 数字列右对齐并用等宽数字（`tabular-nums`）——不对齐的话 `$0.2` 和 `$12.5`
 * 的小数点错位，量级差看着像不差。
 *
 * **各家不合成一张大表。** 合起来之后厂商名只能做成一个跨列的行，那一行右边是
 * 一大片空白；而顶部那份表头离下面几家隔着几十行，滚下去就对不上列了。
 * 表头跟着各自的模块走，滚到哪一家，哪一家的列名就在眼前。
 *
 * ## 高度交给外层
 *
 * 这一节**不设自己的 max-height**。上一版给列表加了 `max-height: 60vh` 又用
 * flex 竖排，于是每个厂商块被 flex 压缩、内容被裁掉——界面上是「每家只剩一行，
 * 后面几家整个是空的」。设置面板本来就有一条滚动轴，这里再加一条就是两条。
 *
 * ## 为什么能改
 *
 * 内置值是源码里的一份 seed，其中几家的窗口和价格没有逐条实测
 * （`ai/src/catalog.ts` 里写明了）。厂商调一次价，目录就开始说谎，而说谎的出口
 * 只有账单上那个数。改过的条目标出来，可以还原回内置值。
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
  /** 正在改哪一条模型。同一时刻只展开一条：两条一起改会把表撑得很高。 */
  const [editing, setEditing] = createSignal<string | null>(null)
  /** 正在往哪个厂商底下加。与 `editing` 互斥，同上。 */
  const [adding, setAdding] = createSignal<string | null>(null)

  const openEdit = (id: string) => {
    setAdding(null)
    setEditing(editing() === id ? null : id)
  }
  const openAdd = (vendor: string) => {
    setEditing(null)
    setAdding(adding() === vendor ? null : vendor)
  }
  const save = (id: string, entry: CatalogEntry | null) => {
    props.onSave(id, entry)
    setEditing(null)
    setAdding(null)
  }

  return (
    <Show
      when={!props.loading && !props.error}
      fallback={
        <div class="lib-state">
          {props.error ? explainApiError(props.error, '读不到内置模型库') : '读取中…'}
        </div>
      }
    >
      {/* 一个厂商一张卡，各自带表头。
          不合成一张大表：合起来之后厂商名只能做成一个跨列的行，那一行右边是
          一大片空白，而顶部那份表头离下面几家隔着几十行，滚下去就对不上列了。 */}
      <div class="lib">
        <For each={props.vendors}>
          {(v) => (
            <section class="lib-card">
              {/* 窄窗口下表格自己横向滚，不把整页撑宽。 */}
              <div class="lib-scroll">
                <table class="lib-table">
                  {/* **只有一行标题。** 厂商名就坐在「模型」那一列的表头位置——
                      它标的正是这一列的内容，再单开一条灰色的厂商栏就是同一件事
                      写两遍，上下各占一行。 */}
                  <thead>
                    <tr>
                      <th class="vendor">{v.displayName}</th>
                      <th class="num">上下文窗口</th>
                      <th class="num">最大输出</th>
                      <th class="num">输入</th>
                      <th class="num">输出</th>
                      <th class="num">缓存命中</th>
                      <th class="num">缓存写入</th>
                      <th>思考</th>
                      <th>缓存路由</th>
                      <th class="act">
                        <button class="btn-ghost sm" type="button" onClick={() => openAdd(v.id)}>
                          添加模型
                        </button>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    <Show when={adding() === v.id}>
                      <tr class="lib-form-row">
                        <td colSpan={9}>
                          <ModelForm
                            idEditable
                            vendor={v.id}
                            onCancel={() => setAdding(null)}
                            onSave={save}
                          />
                        </td>
                      </tr>
                    </Show>
                    <For each={v.models}>
                      {(m) => (
                        <>
                          <tr>
                            <td>
                              <div class="lib-name">
                                {m.label}
                                {/* 改过的标出来——「还原」只对它们出现，不标的话
                                    没法解释为什么这一行比别行多一个按钮。 */}
                                <Show when={m.source === 'user'}>
                                  <span class="lib-tag">已改</span>
                                </Show>
                              </div>
                              <code class="lib-id">{m.id}</code>
                            </td>
                            <td class="num">{compact(m.contextWindow)}</td>
                            <td class="num">{compact(m.maxOutputTokens)}</td>
                            <td class="num">{price(m.input, m.currency)}</td>
                            <td class="num">{price(m.output, m.currency)}</td>
                            <td class="num">{price(m.cacheRead, m.currency)}</td>
                            <td class="num">{price(m.cacheWrite, m.currency)}</td>
                            {/* 空的写破折号，不留白：留白读起来像「这一格没加载出来」。 */}
                            {/* 档位与「会不会思考」是一件事的两半：只画档位的话，
                                一个 thinking=none 的模型看起来和没探过的一样。 */}
                            <td class="lv">
                              {m.thinking === 'none'
                                ? '不发'
                                : (m.effortLevels.join('/') || '默认') +
                                  (m.thinksByDefault ? ' · 默认开' : '')}
                            </td>
                            {/* 中转站按分片存隐式缓存，不发亲和键就是每次随机落一个。
                                这一格答的是「这条模型在这条接口上发不发」。 */}
                            <td class="lv">
                              {m.cacheRouting === 'prompt_cache_key' ? '亲和键' : '不发'}
                            </td>
                            <td class="act">
                              <button
                                class="btn-ghost sm"
                                type="button"
                                onClick={() => openEdit(m.id)}
                              >
                                修改
                              </button>
                              <Show when={m.source === 'user'}>
                                <button
                                  class="btn-ghost sm"
                                  type="button"
                                  onClick={() => save(m.id, null)}
                                >
                                  还原
                                </button>
                              </Show>
                            </td>
                          </tr>

                          {/* 分时段折扣、长上下文换档：上面那个价是标准价，这句必须显示。
                              只画一个数字的话，用户对着账单会发现对不上，而差价是两倍。 */}
                          <Show when={m.priceNotes?.length}>
                            <tr class="lib-note">
                              <td colSpan={9}>{m.priceNotes?.join('；')}</td>
                            </tr>
                          </Show>

                          <Show when={editing() === m.id}>
                            <tr class="lib-form-row">
                              <td colSpan={9}>
                                <ModelForm
                                  model={m}
                                  vendor={v.id}
                                  onCancel={() => setEditing(null)}
                                  onSave={save}
                                />
                              </td>
                            </tr>
                          </Show>
                        </>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </For>
      </div>
    </Show>
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
  let hitRef: HTMLInputElement | undefined
  let writeRef: HTMLInputElement | undefined
  let curRef: HTMLSelectElement | undefined
  let thinkRef: HTMLSelectElement | undefined
  let defaultThinkRef: HTMLInputElement | undefined
  let echoRef: HTMLSelectElement | undefined
  let cacheRoutingRef: HTMLSelectElement | undefined

  /** 留空 = 照内置值。0 在窗口、上限、单价上都不是有意义的值，一律当没填。 */
  const num = (el: HTMLInputElement | undefined) => {
    const v = el?.value.trim()
    if (!v) return undefined
    const n = Number(v)
    return Number.isFinite(n) && n > 0 ? n : undefined
  }

  /** 缓存两档的 0 是真值（DeepSeek 写入不收费），只有留空才算没填。 */
  const zeroOk = (el: HTMLInputElement | undefined) => {
    const v = el?.value.trim()
    if (!v) return undefined
    const n = Number(v)
    return Number.isFinite(n) && n >= 0 ? n : undefined
  }

  const submit = () => {
    const id = (props.idEditable ? idRef?.value.trim() : props.model?.id) ?? ''
    if (!id) return
    const name = nameRef?.value.trim()
    const ctx = num(ctxRef)
    const out = num(outRef)
    const inPrice = num(inPriceRef)
    const outPrice = num(outPriceRef)
    // 缓存两档允许填 0：DeepSeek 的写入就是不收费，那是个真值不是空值。
    const hit = zeroOk(hitRef)
    const write = zeroOk(writeRef)
    // 空格子整个不写进去。`exactOptionalPropertyTypes` 开着，
    // 写 `x: undefined` 和不写这个键不是一回事，而落盘的是后者。
    props.onSave(id, {
      ...(name ? { displayName: name } : {}),
      ...(props.vendor ? { vendor: props.vendor } : {}),
      ...(ctx !== undefined ? { contextWindow: ctx } : {}),
      ...(out !== undefined ? { maxOutputTokens: out } : {}),
      ...(inPrice !== undefined ? { input: inPrice } : {}),
      ...(outPrice !== undefined ? { output: outPrice } : {}),
      ...(hit !== undefined ? { cacheRead: hit } : {}),
      ...(write !== undefined ? { cacheWrite: write } : {}),
      // 思考两项：`thinking` 空串 = 没改过，照内置值；勾选框有明确的两态，
      // 只在与内置值不同时才写进覆盖，否则一条没动过的记录也会被标成 user。
      ...(thinkRef?.value ? { thinking: thinkRef.value } : {}),
      ...(echoRef?.value ? { reasoningEcho: echoRef.value } : {}),
      ...(cacheRoutingRef?.value ? { cacheRouting: cacheRoutingRef.value } : {}),
      ...(defaultThinkRef && defaultThinkRef.checked !== props.model?.thinksByDefault
        ? { thinksByDefault: defaultThinkRef.checked }
        : {}),
      currency: curRef?.value === 'CNY' ? 'CNY' : 'USD',
    })
  }

  return (
    <div class="lib-form">
      <Show when={props.idEditable}>
        <label class="lib-field wide">
          <span>模型 ID</span>
          <input ref={idRef} type="text" placeholder="调用时用的那个名字" />
        </label>
      </Show>
      <label class="lib-field wide">
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
      {/* 思考两项。`qy probe --save` 写的就是这里，探完在这一格看得见、改得动。 */}
      <label class="lib-field">
        <span>思考怎么发</span>
        <select ref={thinkRef}>
          <option value="">照内置值（{props.model?.thinking ?? '未知'}）</option>
          <option value="none">不发</option>
          <option value="reasoning_effort">reasoning_effort</option>
          <option value="deepseek_thinking">deepseek_thinking</option>
          <option value="anthropic_effort">anthropic_effort</option>
        </select>
      </label>
      <label class="lib-field lib-check">
        <input
          ref={defaultThinkRef}
          type="checkbox"
          checked={props.model?.thinksByDefault ?? false}
        />
        <span>不选档时也思考</span>
      </label>
      {/* 回传推理原文。中转站把 DeepSeek 挂在自定义模型名下时内置目录认不出它，
          这一格是唯一出口——不填的话第二轮工具调用会被对方拒掉。 */}
      <label class="lib-field">
        <span>回传推理原文</span>
        <select ref={echoRef}>
          <option value="">照内置值（{props.model?.reasoningEcho ?? '未知'}）</option>
          <option value="none">不回传</option>
          <option value="reasoning_text">reasoning_text</option>
        </select>
      </label>
      {/* 缓存路由。中转站多上游轮询时不发这个键，前缀再稳也可能恒不命中；
          而自建端点对未知字段的容忍度没验过，所以两态都要能选。 */}
      <label class="lib-field">
        <span>缓存路由</span>
        <select ref={cacheRoutingRef}>
          <option value="">照内置值（{props.model?.cacheRouting ?? '未知'}）</option>
          <option value="prompt_cache_key">发 prompt_cache_key</option>
          <option value="none">不发</option>
        </select>
      </label>
      <label class="lib-field">
        <span>输入价</span>
        <input
          ref={inPriceRef}
          type="number"
          min="0"
          step="0.001"
          value={props.model?.input ?? ''}
        />
      </label>
      <label class="lib-field">
        <span>输出价</span>
        <input
          ref={outPriceRef}
          type="number"
          min="0"
          step="0.001"
          value={props.model?.output ?? ''}
        />
      </label>
      <label class="lib-field">
        <span>缓存命中</span>
        <input
          ref={hitRef}
          type="number"
          min="0"
          step="0.001"
          value={props.model?.cacheRead ?? ''}
        />
      </label>
      <label class="lib-field">
        <span>缓存写入</span>
        <input
          ref={writeRef}
          type="number"
          min="0"
          step="0.001"
          value={props.model?.cacheWrite ?? ''}
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
