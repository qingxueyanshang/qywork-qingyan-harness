import {
  defaultMediaKind,
  MEDIA_KIND_OUTPUT,
  type MediaKind,
  type MediaOutput,
  matchesToolCallCheck,
  PROVIDER_KINDS,
  type ProviderKind,
  type ToolCallCheck,
} from '@qywork/core'
import { createSignal, For, Show } from 'solid-js'
import { sessionSignal } from '../../lib/session.ts'
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
import { IconTrash } from '../Icons.tsx'
import { ConfigStatus } from './ConfigStatus.tsx'
import {
  config,
  configBusy,
  configError,
  ensureConfig,
  reloadConfig,
  replaceConfig,
  reportConfigWriteError,
} from './configStore.ts'
import { LoadState } from './LoadState.tsx'
import { MEDIA_KIND_LABEL, ModelLibrary } from './ModelLibrary.tsx'
import { Field, Row } from './Row.tsx'

/**
 * 下拉框中显示的短名。底层值保持不变：它对应端点 `/v1/chat/completions`，
 * 而官方的 `completions` 是另一个已弃用的补全接口；短名只用于界面显示。
 *
 * 词表定义在 `@qywork/core`，由配置、协议、界面三方共用。不要在此处复制一份：
 * 副本与原表不一致时，下拉框中会出现端点不支持的值。
 */
const KIND_LABEL: Record<ProviderKind, string> = {
  anthropic_messages: 'anthropic_messages',
  openai_chat_completions: 'openai_chat',
  openai_responses: 'openai_responses',
}

const probeKey = (provider: string, model: string) => JSON.stringify([provider, model])

/** 生成模型行上的类别名。同一列中既有对话模型的「默认」，也有各类生成模型的「默认」，缺少类别名时无法区分各自的用途。 */
const OUTPUT_LABEL: Record<MediaOutput, string> = { image: '图像', video: '视频', audio: '音频' }

/**
 * 模型配置分为接口与模型两层。
 *
 * 采用两层的原因：扁平档案（每条档案对应一个模型）要求同一厂商的每个模型各保存一份 key 与
 * baseUrl，修改端点时须逐条修改，遗漏一条即导致部分模型不可用，
 * 且各条档案在界面上外观相同，无法看出遗漏的是哪一条。
 *
 * 对话协议由接口配置；生成模型各自保存接入方式，选项来自目录的原生协议及兼容映射。
 * 两者共用接口地址与密钥。
 *
 * 明文 key 不回传：服务端只返回 `hasApiKey` 布尔值。保存时未携带 `apiKey` 的接口沿用服务端已有的
 * key，因此只修改 baseUrl 并保存不会清除 key。key 被误清除时保存操作不报错，
 * 直到下一次调用模型才失败。
 *
 * 探测只使用已落盘的配置：按钮请求服务端的 `/api/probe`，它从已保存的接口读取 key。输入框中
 * 尚未失焦的值不参与探测。不要让端点接收临时的明文 key：那会新增一条 key 的上行路径，
 * 而本页每个字段失焦即落盘，无需等待。
 */
export function ModelSettings() {
  ensureConfig()
  void ensureModelCatalog()

  /** 正在编辑的接口。null 表示跟随 active。 */
  const [picked, setPicked] = sessionSignal<string | null>('qywork.settings.models.picked', null)
  /**
   * 模型库与接口共用下方的内容区，由上方的 tab 切换。
   *
   * 不要改成左右两栏：分栏后接口一侧的 Base URL、Key 与模型列表宽度过窄。
   * 两者也无需同时查看：配置接口时查看接口，查询参数时查看模型库。
   */
  const [showLibrary, setShowLibrary] = sessionSignal('qywork.settings.models.library', false)
  /** 最近一次探测结果按接口与模型区分，不落盘。 */
  const [probes, setProbes] = createSignal<Record<string, ProbeResult | { error: string }>>({})
  const [probing, setProbing] = createSignal<string | null>(null)

  const names = () => Object.keys(config()?.providers ?? {})
  const current = () => {
    const c = config()
    if (!c) return null
    const name = picked() ?? c.active?.provider ?? ''
    return name in c.providers ? name : (names()[0] ?? null)
  }

  const patchProvider = (name: string, p: Partial<RedactedProvider>) => {
    setProbes({})
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
    void replaceConfig((cur) => {
      if (name in cur.providers) throw new Error(`接口名称「${name}」已存在`)
      return {
        ...cur,
        providers: {
          ...cur.providers,
          [name]: { kind: 'openai_chat_completions', hasApiKey: false, models: {} },
        },
      }
    })
  }

  // 删除不可恢复：明文 key 不回传前端，界面无法取回它。
  // 设置即时生效，误点会立即落盘，因此必须保留确认框。
  const [doomed, setDoomed] = createSignal<string | null>(null)

  const removeProvider = (name: string) => {
    setDoomed(null)
    setPicked(null)
    void replaceConfig((cur) => {
      const { [name]: _drop, ...rest } = cur.providers
      const next: RedactedConfig = { ...cur, providers: rest }
      // 删除的是当前默认接口时须同时修改 active，否则服务端拒绝保存，
      // 且报错「active 指向不存在的接口」与删除操作无法对应。
      // 没有其他接口可选时不设默认值：删除最后一个接口即恢复为未配置，这是合法状态。
      if (cur.active?.provider === name) {
        const fallback = firstModelRef(rest)
        if (fallback) next.active = fallback
        else delete next.active
      }
      return withMediaDefaults(next, (ref) => ref.provider === name)
    })
  }

  /** 接口改名时同步默认引用，并将改名关系交给服务端回填原密钥。 */
  const renameProvider = (from: string, to: string) => {
    const base = config()
    const p = base?.providers[from]
    if (!base || !p || to === from) return false
    if (!to || to in base.providers) {
      reportConfigWriteError(!to ? '接口名称不能为空' : `接口名称「${to}」已存在`)
      return false
    }
    setPicked(to)
    void replaceConfig(
      (cur) => {
        const moved = cur.providers[from]
        if (!moved) throw new Error(`接口「${from}」已不存在`)
        if (to in cur.providers) throw new Error(`接口名称「${to}」已存在`)
        const { [from]: _drop, ...rest } = cur.providers
        const next: RedactedConfig = {
          ...cur,
          providers: { ...rest, [to]: moved },
          ...(cur.active?.provider === from ? { active: { ...cur.active, provider: to } } : {}),
        }
        if (cur.mediaDefaults) {
          next.mediaDefaults = Object.fromEntries(
            Object.entries(cur.mediaDefaults).map(([output, ref]) => [
              output,
              ref.provider === from ? { ...ref, provider: to } : ref,
            ]),
          )
        }
        return next
      },
      { from, to },
    )
    return true
  }

  /**
   * 向接口添加一个模型，只写入模型 id。
   *
   * 参数不在此处写入，而是按 id 从模型库查询（`lookupModel` 加模型库中的覆盖项）。
   * 在此处另存窗口与价格会形成第二份记录。
   *
   * id 位于生成目录中时添加为生成模型，默认使用目录协议，此后以保存的接入方式为准；
   * 该类别尚无默认模型时，它成为默认模型。目录中不存在的 id 添加为对话模型。
   */
  const addModel = (provider: string, id: string) => {
    const base = config()
    const p = base?.providers[provider]
    if (!base || !p || !id) return
    // id 已存在时必须报错：静默返回会使回车后没有任何反馈。
    if (id in p.models || id in (p.media ?? {})) {
      reportConfigWriteError(`模型 ${id} 已存在于接口 ${provider} 下`)
      return
    }
    const generator = modelCatalog()?.mediaLibrary.find((m) => m.id === id)
    if (generator) {
      void replaceConfig((cur) => {
        const owner = cur.providers[provider]
        if (!owner || id in owner.models || id in (owner.media ?? {})) return null
        const kind = defaultMediaKind(generator.output, owner.baseUrl, generator.kind)
        return {
          ...cur,
          providers: {
            ...cur.providers,
            [provider]: { ...owner, media: { ...owner.media, [id]: { kind } } },
          },
          ...(cur.mediaDefaults?.[generator.output]
            ? {}
            : {
                mediaDefaults: {
                  ...cur.mediaDefaults,
                  [generator.output]: { provider, model: id },
                },
              }),
        }
      })
      return
    }
    void replaceConfig((cur) => {
      const owner = cur.providers[provider]
      if (!owner || id in owner.models) return null
      return {
        ...cur,
        providers: {
          ...cur.providers,
          [provider]: { ...owner, models: { ...owner.models, [id]: {} } },
        },
        // 接口没有模型时不可用。添加第一个模型时将默认模型切换到它，
        // 使添加立即生效。
        ...(Object.keys(owner.models).length === 0 ? { active: { provider, model: id } } : {}),
      }
    })
  }

  const removeMediaModel = (provider: string, id: string) => {
    void replaceConfig((cur) => {
      const owner = cur.providers[provider]
      if (!owner?.media) return null
      const { [id]: _drop, ...media } = owner.media
      const next: RedactedConfig = {
        ...cur,
        providers: { ...cur.providers, [provider]: { ...owner, media } },
      }
      return withMediaDefaults(next, (ref) => ref.provider === provider && ref.model === id)
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
      // 删除的是默认模型时，依次改用本接口与其他接口的第一个模型，不保留指向已删除模型的 active。
      // 所有接口均无模型时不设默认值：删除最后一个模型即恢复为未配置，这是合法状态。
      if (cur.active?.provider === provider && cur.active.model === id) {
        const fallback = Object.keys(models)[0]
        const nextActive = fallback ? { provider, model: fallback } : firstModelRef(next.providers)
        if (nextActive) next.active = nextActive
        else delete next.active
      }
      return next
    })
  }

  const runProbe = async (provider: string, model: string) => {
    const key = probeKey(provider, model)
    const started = config()?.providers[provider]
    const catalogEntry = config()?.catalog?.[`${model}|${started?.kind}`]
    setProbing(key)
    try {
      const r = await probeModel(provider, model)
      const current = config()?.providers[provider]
      if (
        current?.kind !== started?.kind ||
        current?.baseUrl !== started?.baseUrl ||
        JSON.stringify(config()?.catalog?.[`${model}|${current?.kind}`]) !==
          JSON.stringify(catalogEntry)
      )
        return
      setProbes((prev) => ({ ...prev, [key]: r }))
      // 探测只校准当前接口是否透传控制面，不改写全局模型能力。
      if (Object.keys(r.transport).length > 0) {
        void replaceConfig((cur) => {
          const owner = cur.providers[provider]
          if (
            !owner ||
            owner.kind !== started?.kind ||
            owner.baseUrl !== started?.baseUrl ||
            JSON.stringify(cur.catalog?.[`${model}|${owner.kind}`]) !== JSON.stringify(catalogEntry)
          )
            return null
          const entry = owner.models[model]
          if (!entry) return null
          return {
            ...cur,
            providers: {
              ...cur.providers,
              [provider]: {
                ...owner,
                models: {
                  ...owner.models,
                  [model]: { ...entry, transport: { ...entry.transport, ...r.transport } },
                },
              },
            },
          }
        })
      }
    } catch (e) {
      setProbes((prev) => ({
        ...prev,
        [key]: { error: e instanceof Error ? e.message : String(e) },
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
                    classList={{
                      active: !showLibrary() && current() === n,
                      live: c().active?.provider === n,
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
              {/* 模型库与接口的内容类别不同（前者是模型参数，后者是端点与凭证），
                      因此单独放在该行末尾，不与接口混排。 */}
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
              const defaultUrls = () =>
                models().map(
                  (id) =>
                    modelCatalog()
                      ?.providers.find((provider) => provider.name === name())
                      ?.models.find((model) => model.id === id)?.defaultBaseUrl,
                )
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
                        <IconTrash size={13} />
                      </button>
                    </div>

                    <div class="setting-rows">
                      <Row label="名称">
                        <input
                          type="text"
                          value={name()}
                          onBlur={(e) => {
                            const from = name()
                            if (!renameProvider(from, e.currentTarget.value.trim()))
                              e.currentTarget.value = from
                          }}
                        />
                      </Row>

                      <Row label="对话协议">
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
                          placeholder={baseUrlPlaceholder(defaultUrls())}
                          value={p().baseUrl ?? ''}
                          onBlur={(e) => patchProvider(name(), { baseUrl: e.currentTarget.value })}
                        />
                      </Field>

                      <Field label="API Key">
                        <input
                          type="password"
                          placeholder={p().hasApiKey ? '已设置（留空则保持不变）' : '未设置'}
                          onBlur={(e) => {
                            // 留空表示保持原值，因此不发送空串：空串会被视为清除 key。
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
                            c().active?.provider === name() && c().active?.model === id
                          const result = () => probes()[probeKey(name(), id)]
                          const schema = () =>
                            modelCatalog()
                              ?.providers.find((v) => v.name === name())
                              ?.models.find((m) => m.id === id)?.chatToolSchema
                          const check = () => p().models[id]?.transport?.toolCalls
                          return (
                            <div class="model-row" classList={{ active: isDefault() }}>
                              <div class="model-row-main">
                                {/* 「默认」指新会话使用的接口与模型。已有会话各自保存接口与模型，
                                    修改此处不影响它们。 */}
                                <button
                                  class="model-pick"
                                  type="button"
                                  disabled={isDefault()}
                                  onClick={() => {
                                    const provider = name()
                                    void replaceConfig((cur) => ({
                                      ...cur,
                                      active: { provider, model: id },
                                    }))
                                  }}
                                >
                                  {isDefault() ? '默认' : '设为默认'}
                                </button>
                                <span class="model-id">{id}</span>
                                {/* 探测结论与模型 id 位于同一行。放在行下方时，
                                      每次探测都会增加行高，下方各行随之下移。 */}
                                <Show when={result()}>{(r) => <ProbeSummary result={r()} />}</Show>
                                <Show when={!result() && check()}>
                                  {(record) => (
                                    <ToolCheckSummary
                                      check={record() as ToolCallCheck}
                                      current={Boolean(
                                        schema() &&
                                          matchesToolCallCheck(record() as ToolCallCheck, {
                                            kind: p().kind as ProviderKind,
                                            model: id,
                                            baseUrl: p().baseUrl ?? '',
                                            schema: schema()!,
                                          }),
                                      )}
                                    />
                                  )}
                                </Show>
                                <button
                                  class="btn-ghost sm"
                                  type="button"
                                  disabled={probing() !== null || configBusy()}
                                  onClick={() => void runProbe(name(), id)}
                                >
                                  {probing() === probeKey(name(), id) ? '检测中…' : '检测'}
                                </button>
                                <button
                                  class="icon-btn"
                                  type="button"
                                  aria-label={`删除模型 ${id}`}
                                  onClick={() => removeModel(name(), id)}
                                >
                                  <IconTrash size={12} />
                                </button>
                              </div>
                            </div>
                          )
                        }}
                      </For>

                      <For each={Object.entries(p().media ?? {})}>
                        {([id, m]) => {
                          const output = MEDIA_KIND_OUTPUT[m.kind]
                          const kinds = () => {
                            const spec = modelCatalog()?.mediaLibrary.find(
                              (entry) => entry.id === id,
                            )
                            return spec ? spec.kinds : [m.kind]
                          }
                          const isDefault = () => {
                            const ref = c().mediaDefaults?.[output]
                            return ref?.provider === name() && ref.model === id
                          }
                          return (
                            <div class="model-row" classList={{ active: isDefault() }}>
                              <div class="model-row-main">
                                <button
                                  class="model-pick"
                                  type="button"
                                  disabled={isDefault()}
                                  onClick={() => {
                                    const provider = name()
                                    void replaceConfig((cur) => ({
                                      ...cur,
                                      mediaDefaults: {
                                        ...cur.mediaDefaults,
                                        [output]: { provider, model: id },
                                      },
                                    }))
                                  }}
                                >
                                  {isDefault() ? '默认' : '设为默认'}
                                </button>
                                <span class="model-id">{id}</span>
                                <span class="model-output">{OUTPUT_LABEL[output]}</span>
                                <label class="model-access">
                                  接入方式
                                  <select
                                    aria-label={`接入方式 ${id}`}
                                    value={m.kind}
                                    disabled={configBusy() || kinds().length < 2}
                                    onChange={(e) => {
                                      const provider = name()
                                      const kind = e.currentTarget.value as MediaKind
                                      void replaceConfig((cur) => {
                                        const owner = cur.providers[provider]
                                        if (!owner?.media?.[id]) return null
                                        return {
                                          ...cur,
                                          providers: {
                                            ...cur.providers,
                                            [provider]: {
                                              ...owner,
                                              media: {
                                                ...owner.media,
                                                [id]: { ...owner.media[id], kind },
                                              },
                                            },
                                          },
                                        }
                                      })
                                    }}
                                  >
                                    <For each={kinds()}>
                                      {(kind) => (
                                        <option value={kind}>{MEDIA_KIND_LABEL[kind]}</option>
                                      )}
                                    </For>
                                  </select>
                                </label>
                                {/* 生成模型不提供「检测」：每次探测都会实际执行一次生成并计费。 */}
                                <button
                                  class="icon-btn"
                                  type="button"
                                  aria-label={`删除模型 ${id}`}
                                  onClick={() => removeMediaModel(name(), id)}
                                >
                                  <IconTrash size={12} />
                                </button>
                              </div>
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

          {/* 上方 tab 已显示「模型库」，此处不再添加同名标题。 */}
          <Show when={showLibrary()}>
            <ModelLibrary
              vendors={modelCatalog()?.library ?? []}
              media={modelCatalog()?.mediaLibrary ?? []}
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
                ? 'API Key 将一并删除，删除后无法恢复。'
                : '删除后无法恢复。'
            }
            confirmLabel="删除"
            danger
            onConfirm={() => removeProvider(doomed()!)}
            onCancel={() => setDoomed(null)}
          />
        </>
      )}
    </Show>
  )
}

export function baseUrlPlaceholder(urls: readonly (string | undefined)[]): string {
  if (!urls.length || urls.some((url) => !url)) return '请填写接口地址'
  const unique = [...new Set(urls)]
  return unique.length === 1 ? `留空使用 ${unique[0]}` : '留空按各模型使用官方地址'
}

/**
 * 删除生成模型或接口后更新默认生成模型：`gone` 命中的类别以同类的第一个模型作为默认值，同类没有模型时删除该类别的键，
 * 所有类别均被删除时省略整个字段。保存时以这份配置为准，保留指向已删除模型的默认值会使保存被 422 拒绝。
 */
function withMediaDefaults(
  next: RedactedConfig,
  gone: (ref: { provider: string; model: string }) => boolean,
): RedactedConfig {
  if (!next.mediaDefaults) return next
  const defaults: Partial<Record<MediaOutput, { provider: string; model: string }>> = {}
  for (const [output, ref] of Object.entries(next.mediaDefaults) as [
    MediaOutput,
    { provider: string; model: string },
  ][]) {
    if (!gone(ref)) {
      defaults[output] = ref
      continue
    }
    const fallback = firstMediaRef(next.providers, output)
    if (fallback) defaults[output] = fallback
  }
  const { mediaDefaults: _drop, ...rest } = next
  return Object.keys(defaults).length ? { ...rest, mediaDefaults: defaults } : rest
}

function firstMediaRef(
  providers: Record<string, RedactedProvider>,
  output: MediaOutput,
): { provider: string; model: string } | null {
  for (const [provider, p] of Object.entries(providers)) {
    for (const [model, m] of Object.entries(p.media ?? {})) {
      if (MEDIA_KIND_OUTPUT[m.kind] === output) return { provider, model }
    }
  }
  return null
}

/** 接口表中第一个已添加的模型。删除当前默认接口或默认模型后，用它选择新的默认值。 */
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
 * 「未检测」与「不支持」分开显示：合并为一个「否」会把未验证的项写成结论，
 * 使用户去排查一处正常的配置。失败的步骤附带原文，以便核查结论。
 */
export function ProbeSummary(props: { result: ProbeResult | { error: string } }) {
  /**
   * 单行显示，超长时截断，完整内容放入 `data-tip`。
   *
   * 不要换行：该字段位于模型行内，行高变化会使下方各行下移，
   * 同一行的按钮位置也随之改变（CLAUDE.md B9）。
   */
  const text = () => {
    const r = props.result
    if (!('outcome' in r)) return { text: r.error, bad: true }
    const o = r.outcome
    if (!o.reachable) {
      const why = o.probes.filter((s) => !s.ok && !s.skipped).map((s) => s.detail)
      return { text: ['连接失败', ...why].join('　'), bad: true }
    }
    // 思考观察与参数校验独立，均不推断模型内部的强度差异。
    const thinking = o.thinkingObserved ? '已观察到思考' : '未观察到思考'
    const levels = o.effortLevels
    const effort = o.inconclusive.includes('effort')
      ? '档位参数未确认'
      : o.untested.includes('effort')
        ? '思考档位未检测'
        : levels.length > 0
          ? `${o.effortSource === 'catalog' ? '模型库' : '接口接受'}：${levels.join(' / ')}`
          : '无可调档位'
    const tools =
      o.toolCalls?.status === 'passed'
        ? '工具调用通过'
        : o.toolCalls?.status === 'failed'
          ? '工具调用失败'
          : '工具调用未确认'
    return {
      text: `连接正常　${tools}　${thinking}　${effort}`,
      bad: o.toolCalls?.status === 'failed',
    }
  }
  return (
    <span
      class="probe-line"
      classList={{ bad: text().bad }}
      data-tip={
        'outcome' in props.result
          ? `${text().text}\n${props.result.outcome.effortSource === 'probe' ? '接口接受参数不代表各档位强度确有差异，接口可能将多个值映射到同一档位。\n' : ''}${props.result.outcome.probes.map((p) => `${p.name}：${p.detail}`).join('\n')}`
          : text().text
      }
    >
      {text().text}
    </span>
  )
}

function ToolCheckSummary(props: { check: ToolCallCheck; current: boolean }) {
  return (
    <span
      class="probe-line"
      classList={{ bad: props.current && props.check.status === 'failed' }}
      data-tip={`检测时间：${new Date(props.check.checkedAt).toLocaleString()}。仅对应检测时的接口和模型配置。`}
    >
      {!props.current
        ? '配置已更新，可重新检测'
        : props.check.status === 'passed'
          ? '工具调用通过'
          : props.check.status === 'failed'
            ? '工具调用失败'
            : '工具调用未确认'}
    </span>
  )
}
