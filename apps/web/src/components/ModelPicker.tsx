import type { EffortLevel } from '@qywork/core'
import { createSignal, For, onCleanup, onMount, Show } from 'solid-js'
import {
  activeModel,
  activeModelRow,
  ensureModelCatalog,
  isRunning,
  modelCatalog,
  modelCatalogError,
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
 * **一个 chip，二级面板开在旁边。** 两件事装在一个入口里：推理等级是模型的旋钮，档位面本身也逐模型
 * 不同，分成两个并排 chip 时用户要在两个下拉之间来回对照。
 *
 * 二级面板开在一级旁边，不替换掉它：替换会让这一层的高度跟着列表长度变，
 * 刚点过的那一行就跑位了（B9）。
 */

/** 二级面板开着哪一张。 */
type Sub = 'model' | 'effort'

export function ModelPicker() {
  const [open, setOpen] = createSignal(false)
  const [sub, setSub] = createSignal<Sub | null>(null)

  /**
   * 挂载就拉目录，**不等到点开**。
   *
   * chip 上要显示当前档位，而档位只有目录里有。懒到点开才拉的话，chip 先按
   * 「没有档位」画出来，点一下才补上——控件在被点的瞬间变形，比首帧就完整糟得多。
   */
  onMount(() => void ensureModelCatalog())

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
   * 那棵子树摘掉了，`e.target` 成了游离节点，`closest` 逐层向上找不到
   * `.model-picker`，因此每次在面板里选一下都被判成「点到了外面」。
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
   * 不同（Claude 五档、DeepSeek 三档、Qwen 三档），而用户随时会切模型。
   */
  const levels = () => activeModelRow()?.effortLevels ?? []
  const selected = () => activeModelRow()?.effort ?? null

  const isLive = (provider: string, id: string) => {
    const ref = activeModel()
    return ref?.provider === provider && ref.model === id
  }

  /**
   * 选一档：只落盘，不在这里改目录。
   *
   * 目录由 `saveServerConfig` 落盘成功后统一重算，**这里再补一笔就是第二本账**：
   * 写盘失败时界面会显示一个从未落盘的档，而下一轮实际发出去的还是旧值。
   */
  const pickEffort = async (lv: EffortLevel | null) => {
    const ref = activeModel()
    if (!ref) return
    await setEffort(ref.provider, ref.model, lv)
  }

  return (
    <div class="model-picker">
      {/* 切换期间禁用：run 已经带着旧模型发出去了，中途换不会改变本轮。 */}
      <button
        class="mode-chip"
        type="button"
        disabled={isRunning() || !state.activeConversation}
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

          {/* 没有可调档位时整个入口不存在。“不支持”不是一种可选思考状态。 */}
          <Show when={levels().length > 0}>
            <button
              class="model-entry"
              classList={{ open: sub() === 'effort' }}
              type="button"
              aria-expanded={sub() === 'effort'}
              data-tip="改的是这个模型的档位，所有会话通用"
              onClick={() => flip('effort')}
            >
              <span class="model-entry-label">推理等级</span>
              {/* 未选择不是一个档位：请求省略字段，沿用厂商默认。 */}
              <span class="model-entry-value truncate">{selected() ?? '未选择'}</span>
              <IconChevron size={11} dir="right" />
            </button>
          </Show>

          <Show when={sub() === 'model'}>
            <div class="model-sub" role="listbox">
              <Show when={modelCatalogError()}>
                <div class="model-menu-error">{modelCatalogError()}</div>
              </Show>
              <For each={modelCatalog()?.providers ?? []}>
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
              <Show when={modelCatalog()?.providers.every((p) => p.models.length === 0)}>
                <div class="model-menu-error">先在设置 → 模型里给接口挂一个模型</div>
              </Show>
            </div>
          </Show>

          <Show when={sub() === 'effort'}>
            <div class="model-sub" role="listbox">
              <button
                class="model-item"
                classList={{ active: selected() === null }}
                type="button"
                role="option"
                aria-selected={selected() === null}
                onClick={() => {
                  void pickEffort(null)
                  setSub(null)
                }}
              >
                <span class="model-name truncate">未选择（模型默认）</span>
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
