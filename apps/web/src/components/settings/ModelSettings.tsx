import { createResource, createSignal, For, Show } from 'solid-js'
import {
  loadModels,
  type ProbeResult,
  probeModel,
  type RedactedConfig,
  type RedactedProvider,
} from '../../lib/store/index.ts'
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
import { Field, Row } from './Row.tsx'

const PROVIDER_KINDS = ['anthropic', 'openai_compatible', 'openai_responses'] as const

/**
 * 模型配置：**接口一层，模型一层**。
 *
 * ## 为什么是两层
 *
 * 上一版是扁平档案，一条档案一个模型，于是同一家的三个模型要把同一把 key 和
 * 同一个 baseUrl 各抄三份。改一次端点得改三处，漏一处的表现是「有的模型好使
 * 有的不好使」，而界面上三条卡片长得一模一样，看不出哪条漏了。
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
  const [catalog] = createResource(loadModels)

  /** 正在编辑哪个接口。null = 跟随 active。 */
  const [picked, setPicked] = createSignal<string | null>(null)
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
    const base = config()
    const prev = base?.providers[name]
    if (!base || !prev) return
    void replaceConfig({ ...base, providers: { ...base.providers, [name]: { ...prev, ...p } } })
  }

  const addProvider = () => {
    const base = config()
    if (!base) return
    let name = '新接口'
    let i = 2
    while (name in base.providers) name = `新接口 ${i++}`
    setPicked(name)
    void replaceConfig({
      ...base,
      providers: {
        ...base.providers,
        [name]: { kind: 'openai_compatible', hasApiKey: false, models: {} },
      },
    })
  }

  const removeProvider = (name: string) => {
    const base = config()
    if (!base) return
    // **删掉即不可恢复**：明文 key 从不回传前端，界面上没有任何一条路能把它拿回来。
    // 即时生效之后误点会立刻落盘，所以这道确认不是可选的。
    const warn = base.providers[name]?.hasApiKey
      ? `

它的 API Key 会一并删除，且无法找回。`
      : ''
    if (!confirm(`删除接口「${name}」？${warn}`)) return
    const { [name]: _drop, ...rest } = base.providers
    setPicked(null)
    // 删掉的正好是当前接口时要顺手改 active，否则保存会被服务端顶回来，
    // 而报错说的是「active 指向不存在的接口」——用户不会把它和刚才那次删除联系起来。
    const active =
      base.active.provider === name ? (firstModelRef(rest) ?? base.active) : base.active
    void replaceConfig({ ...base, providers: rest, active })
  }

  /** 接口改名：键就是名字，所以这是「删旧建新」，顺带把指向它的 active 一起挪。 */
  const renameProvider = (from: string, to: string) => {
    const base = config()
    const p = base?.providers[from]
    if (!base || !p || !to || to === from || to in base.providers) return
    const { [from]: _drop, ...rest } = base.providers
    setPicked(to)
    void replaceConfig({
      ...base,
      providers: { ...rest, [to]: p },
      ...(base.active.provider === from ? { active: { ...base.active, provider: to } } : {}),
    })
  }

  const addModel = (provider: string, id: string) => {
    const base = config()
    const p = base?.providers[provider]
    if (!base || !p || !id || id in p.models) return
    void replaceConfig({
      ...base,
      providers: { ...base.providers, [provider]: { ...p, models: { ...p.models, [id]: {} } } },
      // 这个接口本来一个模型都没有 = 它还没法用。挂上第一个就顺手切过去，
      // 省掉一次「加完了怎么还没生效」。
      ...(Object.keys(p.models).length === 0 ? { active: { provider, model: id } } : {}),
    })
  }

  const removeModel = (provider: string, id: string) => {
    const base = config()
    const p = base?.providers[provider]
    if (!base || !p) return
    const { [id]: _drop, ...models } = p.models
    const next: RedactedConfig = {
      ...base,
      providers: { ...base.providers, [provider]: { ...p, models } },
    }
    // 删掉的正好是当前生效的那一格，就近换一个，别留一个指向空处的 active。
    if (base.active.provider === provider && base.active.model === id) {
      const fallback = Object.keys(models)[0]
      next.active = fallback
        ? { provider, model: fallback }
        : (firstModelRef(next.providers) ?? base.active)
    }
    void replaceConfig(next)
  }

  /**
   * 从内置库挑一个模型，把这个接口的协议和端点一次填好。
   *
   * **它只是填表，不是第二套状态。** 落盘的仍然是 kind / baseUrl / apiKeyEnv
   * 那几个字段，每一格照常可改——中转站以 OpenAI 协议调 Claude 是常见配置，
   * 锁死协议会把这条路堵掉。存一个 `vendor` 才是第二本账：用户改了端点之后
   * 它还写着原厂，两边立刻开始漂移。
   *
   * key 一个字都不碰：换模型不该把已经配好的凭证洗掉。
   */
  const applyCatalogModel = (provider: string, modelId: string) => {
    const base = config()
    const p = base?.providers[provider]
    const model = catalog()?.models.find((m) => m.id === modelId)
    if (!base || !p || !model) return
    const vendor = catalog()?.vendors.find((v) => v.id === model.vendor)
    void replaceConfig({
      ...base,
      providers: {
        ...base.providers,
        [provider]: {
          ...p,
          kind: model.provider,
          ...(vendor?.defaultBaseUrl ? { baseUrl: vendor.defaultBaseUrl } : {}),
          ...(vendor?.apiKeyEnv ? { apiKeyEnv: vendor.apiKeyEnv } : {}),
          models: { ...p.models, [model.id]: p.models[model.id] ?? {} },
        },
      },
      ...(Object.keys(p.models).length === 0 ? { active: { provider, model: model.id } } : {}),
    })
  }

  const runProbe = async (provider: string, model: string, mode: 'reachability' | 'full') => {
    setProbing(model)
    try {
      const r = await probeModel(provider, model, mode)
      setProbes((prev) => ({ ...prev, [model]: r }))
      // 探到的能力**写回配置**走既有的整份 PUT，不新开写入路径。
      // 只在真探出东西时写：空结论会盖掉目录里正确的保守值。
      if (mode === 'full' && Object.keys(r.capabilities).length > 0) {
        const base = config()
        const p = base?.providers[provider]
        if (base && p) {
          void replaceConfig({
            ...base,
            providers: {
              ...base.providers,
              [provider]: {
                ...p,
                models: {
                  ...p.models,
                  [model]: { ...p.models[model], capabilities: r.capabilities },
                },
              },
            },
          })
        }
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
                    classList={{ active: current() === n, live: c().active.provider === n }}
                    type="button"
                    onClick={() => setPicked(n)}
                  >
                    {n}
                  </button>
                )}
              </For>
              <button class="tab-chip add" type="button" onClick={addProvider}>
                添加接口
              </button>
            </div>
          </section>

          <Show when={current()}>
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
                        onClick={() => removeProvider(name())}
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
                          <For each={PROVIDER_KINDS}>{(k) => <option value={k}>{k}</option>}</For>
                        </select>
                      </Row>

                      <Field label="Base URL">
                        <input
                          type="text"
                          placeholder="留空用官方默认"
                          value={p().baseUrl ?? ''}
                          onBlur={(e) => patchProvider(name(), { baseUrl: e.currentTarget.value })}
                        />
                      </Field>

                      <Field label="API Key 环境变量名" hint="环境变量优先于下面的明文">
                        <input
                          type="text"
                          placeholder="如 DEEPSEEK_API_KEY"
                          value={p().apiKeyEnv ?? ''}
                          onBlur={(e) =>
                            patchProvider(name(), { apiKeyEnv: e.currentTarget.value })
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
                          const live = () =>
                            c().active.provider === name() && c().active.model === id
                          const result = () => probes()[id]
                          return (
                            <div class="model-row" classList={{ active: live() }}>
                              <div class="model-row-main">
                                <button
                                  class="model-pick"
                                  type="button"
                                  disabled={live()}
                                  onClick={() =>
                                    void replaceConfig({
                                      ...c(),
                                      active: { provider: name(), model: id },
                                    })
                                  }
                                >
                                  {live() ? '当前' : '设为当前'}
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
                        <select
                          value=""
                          disabled={!catalog()}
                          onChange={(e) => {
                            applyCatalogModel(name(), e.currentTarget.value)
                            // 选完复位：这个下拉是个动作，不是当前值。
                            e.currentTarget.value = ''
                          }}
                        >
                          <option value="">{catalog() ? '从内置库选…' : '读取中…'}</option>
                          <For each={catalog()?.vendors ?? []}>
                            {(v) => (
                              <optgroup label={v.displayName}>
                                <For
                                  each={(catalog()?.models ?? []).filter((m) => m.vendor === v.id)}
                                >
                                  {(m) => (
                                    <option value={m.id}>
                                      {m.label}
                                      {m.provider === v.defaultKind ? '' : ` · ${m.provider}`}
                                    </option>
                                  )}
                                </For>
                              </optgroup>
                            )}
                          </For>
                        </select>
                      </div>
                    </div>
                  </section>
                </>
              )
            }}
          </Show>

          <ConfigStatus />
        </>
      )}
    </Show>
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
        const untested = () => new Set(o().untested)
        return (
          <div class="probe-line" classList={{ bad: !o().reachable }}>
            <Show when={o().reachable} fallback={<span>端点不通，先确认 key、模型名和地址</span>}>
              <span>通</span>
              <span>
                思考：
                {untested().has('thinking') ? '未探测（本协议不发该字段）' : (o().thinking ?? '—')}
              </span>
              <span>省略字段时自己思考：{o().thinksByDefault ? '是' : '否'}</span>
              <Show when={!untested().has('effort')}>
                <span>effort：{o().effortLevels.join(' / ') || '不支持'}</span>
              </Show>
            </Show>
            <For each={o().probes.filter((s) => !s.ok && !s.skipped)}>
              {(s) => (
                <span class="probe-fail">
                  {s.name}：{s.detail}
                </span>
              )}
            </For>
          </div>
        )
      }}
    </Show>
  )
}
