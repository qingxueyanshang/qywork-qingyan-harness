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
 * 模型与推理等级。
 *
 * 模型是**会话级**属性：同一个工作区里一个会话用重模型改代码、另一个用轻模型
 * 快速问答是常态，所以入口放在输入区而不是全局设置里。
 *
 * **列的是「接口 × 模型」，不是内置目录。** 凭证和端点挂在接口上，所以「切模型」
 * 实质是「切接口 + 切模型」；只列模型的话，配了三个接口的人没有任何一处能切接口，
 * 而选中一个没挂在任何接口下的模型，请求会按当前接口发出去——端点、key、价目表
 * 全是另一家的，且不报错。往接口下加模型在设置页。
 *
 * **两者作用域不同，别按「都是会话级」理解。** 推理等级写的是配置里
 * 「接口 × 模型」那一格（`setEffort`），是这个模型的档位，所有会话共用。
 * 差别由那一行的 `data-tip` 说出来，不能只写在这里。
 *
 * ## 一个 chip，二级面板开在旁边
 *
 * 两件事装在一个入口里：推理等级是模型的旋钮，档位面本身也逐模型不同，
 * 分成两个并排 chip 时用户要在两个下拉之间来回对照。
 *
 * 二级面板开在一级旁边，不替换掉它：替换会让这一层的高度跟着列表长度变，
 * 刚点过的那一行就跑位了（B9）。
 */

/** 目录全局只拉一次。并发调用共用同一个在途请求。 */
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

/** 二级面板开着哪一张。 */
type Sub = 'model' | 'effort'

export function ModelPicker() {
  const [open, setOpen] = createSignal(false)
  const [sub, setSub] = createSignal<Sub | null>(null)

  /**
   * 挂载就拉目录，**不等到点开**。
   *
   * chip 上要显示当前档位，而档位只有目录里有。懒到点开才拉的话，chip 先按
   * 「没有档位」画出来，点一下才补上——一个控件在被点的瞬间变形，比它一开始
   * 就是完整的糟得多。
   */
  onMount(() => void ensureCatalog())

  const close = () => {
    setOpen(false)
    setSub(null)
  }
  const toggle = () => (open() ? close() : setOpen(true))
  const flip = (s: Sub) => setSub((cur) => (cur === s ? null : s))

  /**
   * 点到外面就收起。
   *
   * **必须挂 `pointerdown`，不能挂 `click`。** Solid 的 `onClick` 是委托到
   * document 上的，且比这里先注册：等这个回调跑到时，选中项引发的重渲染已经把
   * 那棵子树摘掉了，`e.target` 成了游离节点，`closest` 一路向上找不到
   * `.model-picker`，于是每次在面板里选一下都被判成「点到了外面」。
   * `pointerdown` 在任何状态变更之前触发，拿到的是还挂在文档里的那个节点。
   */
  const onOutside = (e: PointerEvent) => {
    if (!(e.target as HTMLElement).closest('.model-picker')) close()
  }
  document.addEventListener('pointerdown', onOutside)
  onCleanup(() => document.removeEventListener('pointerdown', onOutside))

  /**
   * 档位面与当前选定档**取自目录里同一行**。
   *
   * 分两处取必然出现「档位面是 A 模型的、选定值是 B 模型的」——两者都逐模型
   * 不同（Claude 五档、DeepSeek 两档、Qwen 一档没有），而用户随时会切模型。
   */
  const levels = () => activeRow()?.effortLevels ?? []
  const selected = () => activeRow()?.effort ?? null

  const isLive = (provider: string, id: string) => {
    const ref = activeModel()
    return ref?.provider === provider && ref.model === id
  }

  /**
   * 选一档：先落盘，成功了再改目录里那一行。
   *
   * 顺序反过来的话，写盘失败时界面显示的是一个从未落盘的档，而下一轮实际发出去
   * 的还是旧值——那种不一致用户没有任何办法看出来。
   */
  const pickEffort = async (lv: EffortLevel) => {
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

  return (
    <div class="model-picker">
      {/* 切换期间禁用：run 已经带着旧模型发出去了，中途换不会改变本轮。 */}
      <button
        class="mode-chip"
        type="button"
        disabled={state.running || !state.activeConversation}
        aria-expanded={open()}
        data-tip="模型与推理等级"
        onClick={toggle}
      >
        <span class="truncate">{activeModel()?.model ?? '选择模型'}</span>
        <Show when={selected()}>{(lv) => <span class="model-chip-effort">{lv()}</span>}</Show>
        <IconChevron size={11} dir={open() ? 'up' : 'down'} />
      </button>

      <Show when={open()}>
        <div class="model-menu">
          <button
            class="model-entry"
            classList={{ open: sub() === 'model' }}
            type="button"
            aria-expanded={sub() === 'model'}
            onClick={() => flip('model')}
          >
            <span class="model-entry-label">模型</span>
            <span class="model-entry-value truncate">{activeModel()?.model ?? '选择模型'}</span>
            <IconChevron size={11} dir="right" />
          </button>

          {/* **这一行常在，一档都调不了时禁用。** 按有没有档位决定显不显示的话，
              在上面那一行换个模型就会让这一格当场出现或消失，一级面板跟着缩一格
              （B9）——而换模型正是这个面板最常做的事。 */}
          <button
            class="model-entry"
            classList={{ open: sub() === 'effort' }}
            type="button"
            disabled={levels().length === 0}
            aria-expanded={sub() === 'effort'}
            data-tip="改的是这个模型的档位，所有会话通用"
            onClick={() => flip('effort')}
          >
            <span class="model-entry-label">推理等级</span>
            {/* 没选过档时发不出思考字段，跑的是厂商默认——这一格空着会被
                读成还没加载出来。 */}
            <span class="model-entry-value truncate">
              {levels().length === 0 ? '不支持' : (selected() ?? '默认')}
            </span>
            <IconChevron size={11} dir="right" />
          </button>

          <Show when={sub() === 'model'}>
            <div class="model-sub" role="listbox">
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
                            setSub(null)
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

          <Show when={sub() === 'effort'}>
            <div class="model-sub" role="listbox">
              <For each={levels()}>
                {(lv) => (
                  <button
                    class="model-item"
                    classList={{ active: lv === selected() }}
                    type="button"
                    role="option"
                    aria-selected={lv === selected()}
                    onClick={() => {
                      void pickEffort(lv)
                      setSub(null)
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
    </div>
  )
}
