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
 * 模型是**会话级**属性：同一个工作区中一个会话使用重型模型修改代码、另一个使用轻型模型
 * 快速问答是常见用法，因此入口放在输入区而不是全局设置中。
 *
 * **列出的是「接口 × 模型」，不是内置目录。** 凭证和端点属于接口，因此「切换模型」
 * 实质是「切换接口 + 切换模型」；只列出模型时，配置了三个接口的用户没有任何位置可以切换接口，
 * 而选中一个不属于任何接口的模型时，请求会按当前接口发出：端点、key、价目表
 * 均属于另一家服务商，且不报错。为接口添加模型在设置页进行。
 *
 * **两者作用域不同，不要按「都是会话级」理解。** 推理等级写入配置中
 * 「接口 × 模型」对应的字段（`setEffort`），是该模型的档位，所有会话共用。
 * 这一差别必须由该行的 `data-tip` 说明，不能只写在注释中。
 *
 * **一个 chip，二级面板在旁边展开。** 两项设置共用一个入口：推理等级是模型的参数，档位选项本身也因模型
 * 而异，拆成两个并排 chip 时用户需要在两个下拉框之间来回对照。
 *
 * 二级面板在一级面板旁边展开，不替换一级面板：替换会使该层高度随列表长度变化，
 * 刚点击过的行位置会移动（B9）。
 */

/** 当前展开的二级面板。 */
type Sub = 'model' | 'effort'

export function ModelPicker() {
  const [open, setOpen] = createSignal(false)
  const [sub, setSub] = createSignal<Sub | null>(null)

  /**
   * 挂载时即获取目录，**不等到点开**。
   *
   * chip 上需要显示当前档位，而档位只存在于目录中。若延迟到点开时才获取，chip 会先按
   * 「没有档位」渲染，点击后才补全：控件在被点击的瞬间改变形状，明显差于首帧即完整。
   */
  onMount(() => void ensureModelCatalog())

  const close = () => {
    setOpen(false)
    setSub(null)
  }
  const toggle = () => (open() ? close() : setOpen(true))
  const flip = (s: Sub) => setSub((cur) => (cur === s ? null : s))

  /**
   * 点击外部时收起。
   *
   * **必须监听 `pointerdown`，不能监听 `click`。** Solid 的 `onClick` 委托在
   * document 上，且先于此处注册：此回调执行时，选中项引发的重新渲染已经把
   * 该子树移除，`e.target` 成为游离节点，`closest` 逐层向上无法找到
   * `.model-picker`，因此每次在面板中选择都被判定为「点击了外部」。
   * `pointerdown` 在任何状态变更之前触发，取得的是仍在文档中的节点。
   */
  const onOutside = (e: PointerEvent) => {
    if (!(e.target as HTMLElement).closest('.model-picker')) close()
  }
  document.addEventListener('pointerdown', onOutside)
  onCleanup(() => document.removeEventListener('pointerdown', onOutside))

  /**
   * 档位选项与当前选定档位**取自目录中的同一行**。
   *
   * 分两处取值必然出现「档位选项属于 A 模型、选定值属于 B 模型」：两者都因模型
   * 而异（Claude 五档、DeepSeek 三档、Qwen 三档），而用户随时可能切换模型。
   */
  const levels = () => activeModelRow()?.effortLevels ?? []
  const selected = () => activeModelRow()?.effort ?? null
  // 使用 `||` 而不是 `??`：未配置模型的会话 model 为空串，空串应显示为「选择模型」而不是空白。
  const label = () => activeModelRow()?.label || activeModel()?.model || '选择模型'

  const isLive = (provider: string, id: string) => {
    const ref = activeModel()
    return ref?.provider === provider && ref.model === id
  }

  /**
   * 选择档位：只落盘，不在此处修改目录。
   *
   * 目录由 `saveServerConfig` 落盘成功后统一重新计算，**在此处再写一次会形成第二本账**：
   * 写盘失败时界面会显示一个从未落盘的档位，而下一轮实际发送的仍是旧值。
   */
  const pickEffort = async (lv: EffortLevel) => {
    const ref = activeModel()
    if (!ref) return
    await setEffort(ref.provider, ref.model, lv)
  }

  return (
    <div class="model-picker">
      {/* 运行期间禁用切换：run 已使用旧模型发出，中途切换不会改变本轮。 */}
      <button
        class="mode-chip"
        type="button"
        disabled={isRunning() || !state.activeConversation}
        aria-expanded={open()}
        data-tip="模型与推理等级"
        onClick={toggle}
      >
        <span class="truncate">{label()}</span>
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
            <span class="model-entry-value truncate">{label()}</span>
            <IconChevron size={11} dir="right" />
          </button>

          {/* 没有可调档位时不显示整个入口。「不支持」不是一种可选的推理状态。 */}
          <Show when={levels().length > 0}>
            <button
              class="model-entry"
              classList={{ open: sub() === 'effort' }}
              type="button"
              aria-expanded={sub() === 'effort'}
              data-tip="修改的是该模型的档位，所有会话通用"
              onClick={() => flip('effort')}
            >
              <span class="model-entry-label">推理等级</span>
              {/* 旧配置可能尚未写入档位，但下拉框中只提供真实强度。 */}
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
                    {/* 接口名即分组名。它由用户自行命名，比协议名更有辨识度。 */}
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
                          {/* 标出以人民币计价的模型。不标注时「¥21 / 百万」会被读作 $21，
                              而 Kimi 与 GPT-5.6 Sol 的数值恰好处于同一量级，无法区分。 */}
                          <Show when={m.currency === 'CNY'}>
                            <span class="model-tag">¥</span>
                          </Show>
                          {/* 标出内置目录中没有的模型：它没有计价与能力信息，
                              用量和费用只能按 provider 返回的数据计算。 */}
                          <Show when={!m.known}>
                            <span class="model-tag">自定义</span>
                          </Show>
                        </button>
                      )}
                    </For>
                  </>
                )}
              </For>
              {/* 未配置任何模型时选择器没有可选项。此处说明配置位置，不显示空框。 */}
              <Show when={modelCatalog()?.providers.every((p) => p.models.length === 0)}>
                <div class="model-menu-error">尚未配置模型，请在设置的「模型」中为接口添加模型</div>
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
