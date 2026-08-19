import type { EffortLevel } from '@qywork/core'
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  activeModel,
  loadModels,
  type ModelCatalog,
  type ModelOption,
  setEffort,
  setModel,
  state,
} from '../lib/store/index.ts'
import { IconChevron } from './Icons.tsx'

/**
 * 模型选择器 + 思考强度。
 *
 * 模型是**会话级**属性：同一个工作区里一个会话用重模型改代码、另一个用轻模型
 * 快速问答是常态，所以入口放在输入区而不是全局设置里。
 *
 * **列的是「接口 × 模型」，不是内置目录。** 凭证和端点挂在接口上，所以「切模型」
 * 实质是「切接口 + 切模型」；只列模型的话，配了三个接口的人没有任何一处能切接口，
 * 而选中一个没挂在任何接口下的模型，请求会按当前接口发出去——端点、key、价目表
 * 全是另一家的，且不报错。往接口下加模型在设置页。
 *
 * **两个 chip 的作用域不一样，别按「都是会话级」理解。** 思考强度写的是
 * 配置里「接口 × 模型」那一格（`setEffort`），换句话说它是这个模型的档位，
 * 所有会话共用。挨着模型放是因为它是模型的旋钮，改一个常常要跟着改另一个；
 * 作用域的差别由 chip 的 `title` 说出来，不能只写在这里。
 *
 * 列表按需拉取——不是每个会话都会点开它。
 */

/** 目录全局只拉一次，两个 chip 共用。并发调用共用同一个在途请求。 */
const [catalog, setCatalog] = createSignal<ModelCatalog | null>(null)
const [catalogError, setCatalogError] = createSignal<string | null>(null)
let inflight: Promise<void> | null = null

function ensureCatalog(): Promise<void> {
  if (catalog()) return Promise.resolve()
  inflight ??= loadModels()
    .then((c) => {
      setCatalog(c)
      setCatalogError(null)
    })
    .catch((e: unknown) => {
      // 拉不到就说拉不到。留一个空列表会让用户以为「没有别的模型可选」。
      setCatalogError(e instanceof Error ? e.message : '模型列表加载失败')
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/**
 * 当前这一对在目录里对应哪一行。
 *
 * 会话的 `provider` 是空串时（迁移 24 之前建的会话）按模型 id 找：先当前默认接口，
 * 再第一个声明了它的接口——**与服务端 `resolveModel` 的裸串入口同一条规则**。
 * 两处答案不一致的话，界面上的档位面属于 A 接口，而请求发给了 B。
 */
function activeRow(): ModelOption | null {
  const c = catalog()
  const ref = activeModel()
  if (!c || !ref) return null
  const owners = c.providers.filter((p) => p.models.some((m) => m.id === ref.model))
  const owner = ref.provider
    ? c.providers.find((p) => p.name === ref.provider)
    : (owners.find((p) => p.name === c.active.provider) ?? owners[0])
  return owner?.models.find((m) => m.id === ref.model) ?? null
}

export function ModelPicker() {
  const [open, setOpen] = createSignal(false)

  const toggle = async () => {
    if (open()) {
      setOpen(false)
      return
    }
    setOpen(true)
    await ensureCatalog()
  }

  const onDocClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('.model-picker')) setOpen(false)
  }
  document.addEventListener('click', onDocClick)
  onCleanup(() => document.removeEventListener('click', onDocClick))

  // 切换期间禁用：run 已经带着旧模型发出去了，中途换不会改变本轮。
  const locked = () => state.running
  const isLive = (provider: string, id: string) => {
    const ref = activeModel()
    return ref?.provider === provider && ref.model === id
  }

  return (
    <div class="model-picker">
      <button
        class="mode-chip"
        type="button"
        disabled={locked() || !state.activeConversation}
        data-tip="切换模型"
        onClick={toggle}
      >
        <span class="truncate">{activeModel()?.model ?? '选择模型'}</span>
        <IconChevron size={11} dir={open() ? 'up' : 'down'} />
      </button>

      <Show when={open()}>
        <div class="model-menu" role="listbox">
          <Show when={catalogError()}>
            <div class="model-menu-error">{catalogError()}</div>
          </Show>
          <For each={catalog()?.providers ?? []}>
            {(p) => (
              <>
                {/* 接口名就是分组名。它是用户自己起的，比协议名有用得多。 */}
                <div class="model-group-name">{p.name}</div>
                <For each={p.models}>
                  {(m) => (
                    <button
                      class="model-item"
                      classList={{ active: isLive(p.name, m.id) }}
                      type="button"
                      role="option"
                      aria-selected={isLive(p.name, m.id)}
                      onClick={() => {
                        setModel(p.name, m.id)
                        setOpen(false)
                      }}
                    >
                      <span class="model-name truncate">{m.label}</span>
                      {/* 人民币标价的标出来。不标的话「¥21 / 百万」会被读成 $21，
                          而 Kimi 和 GPT-5.6 Sol 的数字恰好在同一个量级，看不出差别。 */}
                      <Show when={m.currency === 'CNY'}>
                        <span class="model-tag">¥</span>
                      </Show>
                      {/* 内置目录里没有的标出来：它没有计价与能力信息，
                          用量和费用只能按 provider 回报的算。 */}
                      <Show when={!m.known}>
                        <span class="model-tag">自定义</span>
                      </Show>
                    </button>
                  )}
                </For>
              </>
            )}
          </For>
          {/* 一个模型都没配 = 这个选择器无事可做。说清出口，别留一个空框。 */}
          <Show when={catalog() && catalog()?.providers.every((p) => p.models.length === 0)}>
            <div class="model-menu-error">先在设置 → 模型里给接口挂一个模型</div>
          </Show>
        </div>
      </Show>
    </div>
  )
}

/**
 * 思考强度。
 *
 * **档位来自服务端算好的 `effortLevels`，不是那张五档全量表。**
 *
 * 各家的档位本来就不一样（Gemini 三档、Kimi 三档、DeepSeek 两档、Claude 五档），
 * 而且**同一个模型换条协议档位也不一样**——服务端按「这个模型实际走哪个接口」
 * 查过目录才报出来。空数组 = 这条链路上调不了，chip 整个不显示，
 * 而不是显示一个选了没反应的下拉。
 */
export function EffortPicker() {
  const [open, setOpen] = createSignal(false)

  // 挂载就拉目录，**不等到点击**。
  //
  // 反面版本就在这条注释的历史里：懒到点开才拉，于是 chip 先画出来、
  // 点一下拉到目录、发现当前模型一档都不吃、当场消失——「我点思考，思考就丢了」。
  // 一个控件在被点的瞬间消失，比它从来没出现过糟得多。
  onMount(() => void ensureCatalog())

  /**
   * 档位面与当前选定档**取自目录里同一行**。
   *
   * 分两处取必然出现「档位面是 A 模型的、选定值是 B 模型的」——两者都逐模型
   * 不同（Claude 五档、DeepSeek 两档、Qwen 一档没有），而用户随时会切模型。
   */
  const levels = () => activeRow()?.effortLevels ?? []
  const selected = () => activeRow()?.effort ?? null

  /**
   * 选一档：先落盘，成功了再改目录里那一行。
   *
   * 顺序反过来的话，写盘失败时界面显示的是一个从未落盘的档，而下一轮实际发出去
   * 的还是旧值——那种不一致用户没有任何办法看出来。
   */
  const pick = async (lv: EffortLevel) => {
    const ref = activeModel()
    if (!ref) return
    await setEffort(ref.provider, ref.model, lv)
    setCatalog((c) =>
      c
        ? {
            ...c,
            providers: c.providers.map((p) =>
              p.name === ref.provider
                ? {
                    ...p,
                    models: p.models.map((m) => (m.id === ref.model ? { ...m, effort: lv } : m)),
                  }
                : p,
            ),
          }
        : c,
    )
  }

  const toggle = () => setOpen((v) => !v)

  const onDocClick = (e: MouseEvent) => {
    if (!(e.target as HTMLElement).closest('.effort-picker')) setOpen(false)
  }
  document.addEventListener('click', onDocClick)
  onCleanup(() => document.removeEventListener('click', onDocClick))

  return (
    <Show when={levels().length > 0}>
      <div class="model-picker effort-picker">
        <button
          class="mode-chip"
          type="button"
          disabled={state.running || !state.activeConversation}
          data-tip="思考强度：改的是这个模型的档位，所有会话通用"
          onClick={toggle}
        >
          <span class="truncate">{selected() ?? '思考'}</span>
          <IconChevron size={11} dir={open() ? 'up' : 'down'} />
        </button>

        <Show when={open()}>
          <div class="model-menu" role="listbox">
            <For each={levels()}>
              {(lv) => (
                <button
                  class="model-item"
                  classList={{ active: lv === selected() }}
                  type="button"
                  role="option"
                  aria-selected={lv === selected()}
                  onClick={() => {
                    void pick(lv)
                    setOpen(false)
                  }}
                >
                  <span class="model-name truncate">{lv}</span>
                </button>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  )
}
