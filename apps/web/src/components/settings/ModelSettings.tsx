import { PROVIDER_KINDS, type ProviderKind } from '@qywork/core'
import { createSignal, For, Show } from 'solid-js'
import {
  ensureModelCatalog,
  modelCatalog,
  modelCatalogError,
  modelCatalogLoading,
  type ProbeResult,
  probeModel,
  type RedactedConfig,
  type RedactedProvider,
} from '../../lib/store/index.ts'
import { ConfirmDialog } from '../ConfirmDialog.tsx'
import { IconX } from '../Icons.tsx'
import { ConfigStatus } from './ConfigStatus.tsx'
import {
  config,
  configBusy,
  configError,
  ensureConfig,
  reloadConfig,
  replaceConfig,
} from './configStore.ts'
import { LoadState } from './LoadState.tsx'
import { ModelLibrary } from './ModelLibrary.tsx'
import { PageHead } from './Page.tsx'
import { Field, Row } from './Row.tsx'

/**
 * 下拉里显示的短名。**底层值不动**——它直指端点（`/v1/chat/completions`），
 * 而官方的 `completions` 是另一个已弃用的补全接口，短名只在界面上用。
 *
 * 词表本身在 `@qywork/core`：配置、协议、界面三方都要说它，抄一份到这里
 * 就会漂（模型库那个思考下拉漂过一次，多出过一个不存在的值）。
 */
const KIND_LABEL: Record<ProviderKind, string> = {
  anthropic_messages: 'anthropic_messages',
  openai_chat_completions: 'openai_chat',
  openai_responses: 'openai_responses',
}

/**
 * 模型库的键：模型 id + 协议。服务端 `runtime/config.ts` 的 `catalogKey` 是真源，
 * 这里抄一份是因为界面只依赖 `@qywork/core`，够不着 runtime。**两处必须一致。**
 * 分隔符是 `|`：模型 id 含斜杠但不含它。
 */
function catalogKey(model: string, kind: string): string {
  return `${model}|${kind}`
}

/**
 * 模型配置：**接口一层，模型一层**。
 *
 * ## 为什么是两层
 *
 * 扁平档案（一条档案一个模型）的话，同一家的三个模型要把同一把 key 和同一个
 * baseUrl 各抄三份。改一次端点得改三处，漏一处的表现是「有的模型好使有的不好使」，
 * 而界面上三条卡片长得一模一样，看不出哪条漏了。
 *
 * ## 协议只在这一页选
 *
 * 协议（`kind`）是**接口**的属性：同一个模型经中转站以 OpenAI 协议调 Claude 是
 * 常见配置。所以模型列表里一个协议字样都不出现——摆进去就是让用户在两条
 * 「看起来一样的模型」之间选，而他手里没有判据。
 *
 * ## 明文 key 不回传
 *
 * 服务端只回 `hasApiKey` 布尔。保存时没带 `apiKey` 的接口沿用服务端已有的那份，
 * 所以「打开设置改个 baseUrl 再保存」不会把 key 洗掉——这类破坏在保存那一刻
 * 毫无反馈，要等下一次调模型才炸。
 *
 * ## 探测只认落盘配置
 *
 * 按钮打的是服务端的 `/api/probe`，它按**已保存的**接口取 key。刚敲进输入框
 * 还没失焦的值探不到——那是对的：让端点接收临时明文 key 等于多开一条 key 上行
 * 路径，而这一页每一格失焦即落盘，等待时间是零。
 */
export function ModelSettings() {
  ensureConfig()
  void ensureModelCatalog()

  /** 正在编辑哪个接口。null = 跟随 active。 */
  const [picked, setPicked] = createSignal<string | null>(null)
  /**
   * 模型库和接口**共用下面那一整块内容区**，由上面那排 tab 切换。
   *
   * 不做成左右两栏：一分栏，接口那侧的 Base URL、Key、模型列表全被挤成一条缝。
   * 而这两块本来也不需要同时看——配接口时看接口，查参数时看库。
   */
  const [showLibrary, setShowLibrary] = createSignal(false)
  /** 每个模型最近一次探测的结果，键是模型 id。**不落盘**——它描述的是「刚才那一下」。 */
  const [probes, setProbes] = createSignal<Record<string, ProbeResult | { error: string }>>({})
  const [probing, setProbing] = createSignal<string | null>(null)

  const names = () => Object.keys(config()?.providers ?? {})
  const current = () => {
    const c = config()
    if (!c) return null
    const name = picked() ?? c.active.provider
    return name in c.providers ? name : (names()[0] ?? null)
  }

  const patchProvider = (name: string, p: Partial<RedactedProvider>) => {
    void replaceConfig((cur) => {
      const prev = cur.providers[name]
      if (!prev) return null
      return { ...cur, providers: { ...cur.providers, [name]: { ...prev, ...p } } }
    })
  }

  const addProvider = () => {
    const base = config()
    if (!base) return
    let name = '新接口'
    let i = 2
    while (name in base.providers) name = `新接口 ${i++}`
    setPicked(name)
    void replaceConfig((cur) => ({
      ...cur,
      providers: {
        ...cur.providers,
        [name]: { kind: 'openai_chat_completions', hasApiKey: false, models: {} },
      },
    }))
  }

  // **删掉即不可恢复**：明文 key 从不回传前端，界面上没有任何一条路能把它拿回来。
  // 即时生效之后误点会立刻落盘，所以这道确认不是可选的。
  const [doomed, setDoomed] = createSignal<string | null>(null)

  const removeProvider = (name: string) => {
    setDoomed(null)
    setPicked(null)
    void replaceConfig((cur) => {
      const { [name]: _drop, ...rest } = cur.providers
      // 删掉的正好是当前接口时要顺手改 active，否则保存会被服务端顶回来，
      // 而报错说的是「active 指向不存在的接口」——用户不会把它和刚才那次删除联系起来。
      const active = cur.active.provider === name ? (firstModelRef(rest) ?? cur.active) : cur.active
      return { ...cur, providers: rest, active }
    })
  }

  /** 接口改名：键就是名字，所以这是「删旧建新」，顺带把指向它的 active 一起挪。 */
  const renameProvider = (from: string, to: string) => {
    const base = config()
    const p = base?.providers[from]
    if (!base || !p || !to || to === from || to in base.providers) return
    setPicked(to)
    void replaceConfig((cur) => {
      const moved = cur.providers[from]
      if (!moved || to in cur.providers) return null
      const { [from]: _drop, ...rest } = cur.providers
      return {
        ...cur,
        providers: { ...rest, [to]: moved },
        ...(cur.active.provider === from ? { active: { ...cur.active, provider: to } } : {}),
      }
    })
  }

  /**
   * 往这个接口下挂一个模型。**只写模型 id。**
   *
   * 参数不在这里写——它们照着 id 从模型库查（`lookupModel` + 库里的覆盖）。
   * 在这里再存一份窗口和价格，就是同一件事记两本账。
   */
  const addModel = (provider: string, id: string) => {
    const base = config()
    const p = base?.providers[provider]
    if (!base || !p || !id || id in p.models) return
    void replaceConfig((cur) => {
      const owner = cur.providers[provider]
      if (!owner || id in owner.models) return null
      return {
        ...cur,
        providers: {
          ...cur.providers,
          [provider]: { ...owner, models: { ...owner.models, [id]: {} } },
        },
        // 这个接口本来一个模型都没有 = 它还没法用。挂上第一个就顺手切过去，
        // 省掉一次「加完了怎么还没生效」。
        ...(Object.keys(owner.models).length === 0 ? { active: { provider, model: id } } : {}),
      }
    })
  }

  const removeModel = (provider: string, id: string) => {
    void replaceConfig((cur) => {
      const owner = cur.providers[provider]
      if (!owner) return null
      const { [id]: _drop, ...models } = owner.models
      const next: RedactedConfig = {
        ...cur,
        providers: { ...cur.providers, [provider]: { ...owner, models } },
      }
      // 删掉的正好是默认那一格，就近换一个，别留一个指向空处的 active。
      if (cur.active.provider === provider && cur.active.model === id) {
        const fallback = Object.keys(models)[0]
        next.active = fallback
          ? { provider, model: fallback }
          : (firstModelRef(next.providers) ?? cur.active)
      }
      return next
    })
  }

  const runProbe = async (provider: string, model: string, mode: 'reachability' | 'full') => {
    setProbing(model)
    try {
      const r = await probeModel(provider, model, mode)
      setProbes((prev) => ({ ...prev, [model]: r }))
      // 探到的能力**写进模型库**，走既有的整份 PUT，不新开写入路径。
      // 协议这一维从当前接口取：探的就是「这条链路」的行为。
      // 只在真探出东西时写：空结论会盖掉目录里正确的保守值。
      if (mode === 'full' && Object.keys(r.capabilities).length > 0) {
        void replaceConfig((cur) => {
          const owner = cur.providers[provider]
          if (!owner) return null
          const key = catalogKey(model, owner.kind)
          return {
            ...cur,
            catalog: { ...cur.catalog, [key]: { ...cur.catalog?.[key], ...r.capabilities } },
          }
        })
      }
    } catch (e) {
      setProbes((prev) => ({
        ...prev,
        [model]: { error: e instanceof Error ? e.message : String(e) },
      }))
    } finally {
      setProbing(null)
    }
  }

  return (
    <>
      <PageHead title="模型" />
      <Show
        when={config()}
        fallback={<LoadState error={configError()} onRetry={() => void reloadConfig()} />}
      >
        {(c) => (
          <>
            <section class="settings-block">
              <div class="tab-strip">
                <For each={names()}>
                  {(n) => (
                    <button
                      class="tab-chip"
                      classList={{
                        active: !showLibrary() && current() === n,
                        live: c().active.provider === n,
                      }}
                      type="button"
                      onClick={() => {
                        setShowLibrary(false)
                        setPicked(n)
                      }}
                    >
                      {n}
                    </button>
                  )}
                </For>
                <button
                  class="tab-chip add"
                  type="button"
                  onClick={() => {
                    setShowLibrary(false)
                    addProvider()
                  }}
                >
                  添加接口
                </button>
                {/* 模型库和接口不是一类东西（一个是模型参数，一个是端点与凭证），
                      所以隔开放在这一排的末尾，而不是混在接口中间。 */}
                <button
                  class="tab-chip lib"
                  classList={{ active: showLibrary() }}
                  type="button"
                  onClick={() => setShowLibrary(true)}
                >
                  模型库
                </button>
              </div>
            </section>

            <Show when={!showLibrary() && current()}>
              {(name) => {
                const p = () => c().providers[name()]!
                const models = () => Object.keys(p().models)
                return (
                  <>
                    <section class="settings-block">
                      <div class="settings-block-head">
                        <h3>{name()}</h3>
                        <button
                          class="icon-btn"
                          type="button"
                          aria-label={`删除接口 ${name()}`}
                          onClick={() => setDoomed(name())}
                        >
                          <IconX size={13} />
                        </button>
                      </div>

                      <div class="setting-rows">
                        <Row label="名称">
                          <input
                            type="text"
                            value={name()}
                            onBlur={(e) => renameProvider(name(), e.currentTarget.value.trim())}
                          />
                        </Row>

                        <Row label="协议">
                          <select
                            value={p().kind}
                            onChange={(e) => patchProvider(name(), { kind: e.currentTarget.value })}
                          >
                            <For each={PROVIDER_KINDS}>
                              {(k) => <option value={k}>{KIND_LABEL[k]}</option>}
                            </For>
                          </select>
                        </Row>

                        <Field label="Base URL">
                          <input
                            type="text"
                            placeholder="留空用官方默认"
                            value={p().baseUrl ?? ''}
                            onBlur={(e) =>
                              patchProvider(name(), { baseUrl: e.currentTarget.value })
                            }
                          />
                        </Field>

                        <Field label="API Key">
                          <input
                            type="password"
                            placeholder={p().hasApiKey ? '已设置（留空则保持不变）' : '未设置'}
                            onBlur={(e) => {
                              // 留空 = 保持原值，所以空串不发——发了会被当成「清除 key」。
                              if (e.currentTarget.value) {
                                patchProvider(name(), {
                                  apiKey: e.currentTarget.value,
                                  hasApiKey: true,
                                })
                                e.currentTarget.value = ''
                              }
                            }}
                          />
                        </Field>
                      </div>
                    </section>

                    <section class="settings-block">
                      <div class="settings-block-head">
                        <h3>模型</h3>
                      </div>

                      <div class="model-list">
                        <For each={models()}>
                          {(id) => {
                            const isDefault = () =>
                              c().active.provider === name() && c().active.model === id
                            const result = () => probes()[id]
                            return (
                              <div class="model-row" classList={{ active: isDefault() }}>
                                <div class="model-row-main">
                                  {/* 「默认」= 新会话开在哪一格。已开的会话各自记着自己那一对，
                                    改这里不会把它们挪走。 */}
                                  <button
                                    class="model-pick"
                                    type="button"
                                    disabled={isDefault()}
                                    onClick={() =>
                                      void replaceConfig((cur) => ({
                                        ...cur,
                                        active: { provider: name(), model: id },
                                      }))
                                    }
                                  >
                                    {isDefault() ? '默认' : '设为默认'}
                                  </button>
                                  <span class="model-id">{id}</span>
                                  <button
                                    class="btn-ghost sm"
                                    type="button"
                                    disabled={probing() !== null || configBusy()}
                                    onClick={() => void runProbe(name(), id, 'reachability')}
                                  >
                                    {probing() === id ? '探测中…' : '测连接'}
                                  </button>
                                  <button
                                    class="btn-ghost sm"
                                    type="button"
                                    disabled={probing() !== null || configBusy()}
                                    onClick={() => void runProbe(name(), id, 'full')}
                                  >
                                    校准思考
                                  </button>
                                  <button
                                    class="icon-btn"
                                    type="button"
                                    aria-label={`删除模型 ${id}`}
                                    onClick={() => removeModel(name(), id)}
                                  >
                                    <IconX size={12} />
                                  </button>
                                </div>

                                <Show when={result()}>{(r) => <ProbeSummary result={r()} />}</Show>
                              </div>
                            )
                          }}
                        </For>

                        <div class="model-row add">
                          <input
                            type="text"
                            placeholder="模型 ID，回车添加"
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter') return
                              addModel(name(), e.currentTarget.value.trim())
                              e.currentTarget.value = ''
                            }}
                          />
                        </div>
                      </div>
                    </section>
                  </>
                )
              }}
            </Show>

            {/* 上面那排 tab 已经写着「模型库」，这里不再来一个同名标题。 */}
            <Show when={showLibrary()}>
              <ModelLibrary
                vendors={modelCatalog()?.library ?? []}
                loading={modelCatalogLoading()}
                error={modelCatalogError()}
              />
            </Show>

            <ConfigStatus />

            <ConfirmDialog
              open={doomed() !== null}
              title={`删除接口「${doomed()}」`}
              message={
                c().providers[doomed() ?? '']?.hasApiKey
                  ? '它的 API Key 一并删除，删了拿不回来。'
                  : '删了拿不回来。'
              }
              confirmLabel="删除"
              danger
              onConfirm={() => removeProvider(doomed()!)}
              onCancel={() => setDoomed(null)}
            />
          </>
        )}
      </Show>
    </>
  )
}

/** 接口表里第一个挂了模型的那一格。删光当前接口时用来找个落脚点。 */
function firstModelRef(
  providers: Record<string, RedactedProvider>,
): { provider: string; model: string } | null {
  for (const [provider, p] of Object.entries(providers)) {
    const model = Object.keys(p.models)[0]
    if (model) return { provider, model }
  }
  return null
}

/**
 * 一次探测的结论。
 *
 * **「没探测」和「不支持」分开显示。** 合并成一个「否」就是把没验过的事写成结论——
 * 而用户会据此去查一个根本没坏的东西。失败的那几步给出原文，结论错了要能查。
 */
function ProbeSummary(props: { result: ProbeResult | { error: string } }) {
  return (
    <Show
      when={'outcome' in props.result ? props.result : null}
      fallback={<div class="probe-line bad">{(props.result as { error: string }).error}</div>}
    >
      {(r) => {
        const o = () => r().outcome
        /**
         * 思考那一格只说**用户能拿它做什么**：有哪几档可选，或者为什么一档都没有。
         *
         * 不显示 `thinksByDefault`（给输出预算留空间的标志位）：它是内部实现，
         * 用户看到也做不了任何事，而它占的正是「这个模型到底能不能调思考」
         * 该占的位置。
         */
        const effort = () => {
          const levels = o().effortLevels
          if (levels.length > 0) return `思考档位　${levels.join(' / ')}`
          if (o().untested.includes('effort')) return '这条链路发不出思考档位'
          return '无思考档位'
        }
        return (
          <div class="probe-line" classList={{ bad: !o().reachable }}>
            {/* 不通时只报状态，成因由下面那几条探针原文给。
                在这里再写一句「先检查 key 和地址」是枚举操作路径，而且它说的
                永远比原文含糊。 */}
            <Show when={o().reachable} fallback={<span>连接失败</span>}>
              <span>连接正常</span>
              <span>{effort()}</span>
            </Show>
            {/* 失败那几步给原文：结论错了要能查，只给一句「不支持」查不出任何东西。 */}
            <For each={o().probes.filter((s) => !s.ok && !s.skipped)}>
              {(s) => <span class="probe-fail">{s.detail}</span>}
            </For>
          </div>
        )
      }}
    </Show>
  )
}
