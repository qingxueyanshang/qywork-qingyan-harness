import type { EffortLevel } from '@qywork/core'
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  activeModel,
  loadModels,
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
 * **两个 chip 的作用域不一样，别按「都是会话级」理解。** 思考强度写的是
 * 配置里「接口 × 模型」那一格（`setEffort`），换句话说它是这个模型的档位，
 * 所有会话共用。挨着模型放是因为它是模型的旋钮，改一个常常要跟着改另一个；
 * 作用域的差别由 chip 的 `title` 说出来，不能只写在这里。
 *
 * 列表按需拉取——不是每个会话都会点开它。
 */

/** 目录全局只拉一次，两个 chip 共用。并发调用共用同一个在途请求。 */
const [catalog, setCatalog] = createSignal<ModelOption[]>([])
const [catalogError, setCatalogError] = createSignal<string | null>(null)
let inflight: Promise<void> | null = null

function ensureCatalog(): Promise<void> {
  if (catalog().length > 0) return Promise.resolve()
  inflight ??= loadModels()
    .then((c) => {
      setCatalog(c.models)
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

  return (
    <div class="model-picker">
      <button
        class="mode-chip"
        type="button"
        disabled={locked() || !state.activeConversation}
        title={locked() ? '执行中不能切换模型' : '切换模型'}
        onClick={toggle}
      >
        <span class="truncate">{activeModel() ?? '选择模型'}</span>
        <IconChevron size={11} dir={open() ? 'up' : 'down'} />
      </button>

      <Show when={open()}>
        <div class="model-menu" role="listbox">
          <Show when={catalogError()}>
            <div class="model-menu-error">{catalogError()}</div>
          </Show>
          <For each={catalog()}>
            {(m) => (
              <button
                class="model-item"
                classList={{ active: m.id === activeModel() }}
                type="button"
                role="option"
                aria-selected={m.id === activeModel()}
                onClick={() => {
                  setModel(m.id)
                  setOpen(false)
                }}
              >
                <span class="model-name truncate">{m.label}</span>
                {/* 人民币标价的标出来。不标的话「¥21 / 百万」会被读成 $21，
                    而 Kimi 和 GPT-5.6 Sol 的数字恰好在同一个量级，看不出差别。 */}
                <Show when={m.currency === 'CNY'}>
                  <span class="model-tag">¥</span>
                </Show>
                {/* 自建端点的模型标出来：它没有内置的计价与能力信息，
                    用量和费用只能按 provider 回报的算。 */}
                <Show when={!m.known}>
                  <span class="model-tag">自定义</span>
                </Show>
              </button>
            )}
          </For>
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
 * 而且**同一个模型换条协议档位也不一样**——服务端按「这个模型实际走哪个档案」
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
  const row = () => catalog().find((m) => m.id === activeModel())
  const levels = () => row()?.effortLevels ?? []
  const selected = () => row()?.effort ?? null

  /**
   * 选一档：先落盘，成功了再改目录里那一行。
   *
   * 顺序反过来的话，写盘失败时界面显示的是一个从未落盘的档，而下一轮实际发出去
   * 的还是旧值——那种不一致用户没有任何办法看出来。
   */
  const pick = async (lv: EffortLevel | null) => {
    await setEffort(lv)
    const id = activeModel()
    setCatalog((list) => list.map((m) => (m.id === id ? { ...m, effort: lv } : m)))
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
          title={
            state.running ? '执行中不能改思考强度' : '思考强度：改的是这个模型的档位，所有会话通用'
          }
          onClick={toggle}
        >
          <span class="truncate">{selected() ?? '思考'}</span>
          <IconChevron size={11} dir={open() ? 'up' : 'down'} />
        </button>

        <Show when={open()}>
          <div class="model-menu" role="listbox">
            {/* 「不指定」这一项不能省：`setEffort(null)` 本来就把配置里那一格删掉，
                没有这个入口的话，档位选过一次就再也回不到默认。 */}
            <button
              class="model-item"
              classList={{ active: selected() === null }}
              type="button"
              role="option"
              aria-selected={selected() === null}
              onClick={() => {
                void pick(null)
                setOpen(false)
              }}
            >
              <span class="model-name truncate">不指定</span>
            </button>
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
