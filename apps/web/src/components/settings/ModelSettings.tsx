import {
  defaultMediaKind,
  MEDIA_KIND_OUTPUT,
  type MediaOutput,
  matchesToolCallCheck,
  PROVIDER_KINDS,
  type ProviderKind,
  type ToolCallCheck,
} from '@qywork/core'
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
import { ModelLibrary } from './ModelLibrary.tsx'
import { Field, Row } from './Row.tsx'

/**
 * 下拉里显示的短名。**底层值不动**——它直指端点（`/v1/chat/completions`），
 * 而官方的 `completions` 是另一个已弃用的补全接口，短名只在界面上用。
 *
 * 词表本身在 `@qywork/core`：配置、协议、界面三方都要说它，抄一份到这里就会漂，
 * 漂出来的形状是下拉里多一个端点不认的值。
 */
const KIND_LABEL: Record<ProviderKind, string> = {
  anthropic_messages: 'anthropic_messages',
  openai_chat_completions: 'openai_chat',
  openai_responses: 'openai_responses',
}

const probeKey = (provider: string, model: string) => JSON.stringify([provider, model])

/** 生成模型行上的类别词。同一列里有对话的「默认」与各类生成的「默认」，不写类别就分不清哪个管哪件事。 */
const OUTPUT_LABEL: Record<MediaOutput, string> = { image: '图像', video: '视频', audio: '音频' }

/**
 * 模型配置：**接口一层，模型一层**。
 *
 * **为什么是两层。** 扁平档案（一条档案一个模型）的话，同一家的三个模型要把同一把 key 和同一个
 * baseUrl 各抄三份。改一次端点得改三处，漏一处的表现是「有的模型可用有的不可用」，
 * 而界面上三条卡片长得一模一样，看不出哪条漏了。
 *
 * **协议只在这一页选。** 协议（`kind`）是**接口**的属性：同一个模型经中转站以 OpenAI 协议调 Claude
 * 是常见配置。所以模型列表里一个协议字样都不出现——摆进去就是让用户在两条「看起来一样的模型」之
 * 间选，而他手里没有判据。
 *
 * **明文 key 不回传。** 服务端只回 `hasApiKey` 布尔。保存时没带 `apiKey` 的接口沿用服务端已有的那
 * 份，所以「打开设置改个 baseUrl 再保存」不会把 key 洗掉——这类破坏在保存那一刻毫无反馈，要等下
 * 一次调模型才失败。
 *
 * **探测只认落盘配置。** 按钮打的是服务端的 `/api/probe`，它按**已保存的**接口取 key。刚敲进输入框
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
      const next: RedactedConfig = { ...cur, providers: rest }
      // 删掉的正好是当前默认接口时要同时改 active，否则保存会被服务端顶回来，
      // 而报错说的是「active 指向不存在的接口」，与刚才那次删除对不上号。
      // 没有别的可挑就没有默认——删光最后一个接口是合法的「回到没配」。
      if (cur.active?.provider === name) {
        const fallback = firstModelRef(rest)
        if (fallback) next.active = fallback
        else delete next.active
      }
      return withMediaDefaults(next, (ref) => ref.provider === name)
    })
  }

  /** 接口改名：键就是名字，所以这是「删旧建新」，同时把指向它的 active 一起挪。 */
  const renameProvider = (from: string, to: string) => {
    const base = config()
    const p = base?.providers[from]
    if (!base || !p || !to || to === from || to in base.providers) return
    setPicked(to)
    void replaceConfig((cur) => {
      const moved = cur.providers[from]
      if (!moved || to in cur.providers) return null
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
    })
  }

  /**
   * 往这个接口下挂一个模型。**只写模型 id。**
   *
   * 参数不在这里写——它们照着 id 从模型库查（`lookupModel` + 库里的覆盖）。
   * 在这里再存一份窗口和价格，就是同一件事记两本账。
   *
   * id 在生成目录里就挂成生成模型，协议按接口地址给默认值（`defaultMediaKind`），之后以落盘的为准；
   * 这一类还没有默认模型时它成为默认。目录里没有的 id 照旧当对话模型。
   */
  const addModel = (provider: string, id: string) => {
    const base = config()
    const p = base?.providers[provider]
    if (!base || !p || !id) return
    // 已存在该 id：此前静默返回会使回车后毫无反馈、看似失效，应明确报出。
    if (id in p.models || id in (p.media ?? {})) {
      reportConfigWriteError(`模型 ${id} 已存在于接口 ${provider} 下`)
      return
    }
    const generator = modelCatalog()?.mediaLibrary.find((m) => m.id === id)
    if (generator) {
      void replaceConfig((cur) => {
        const owner = cur.providers[provider]
        if (!owner || id in owner.models || id in (owner.media ?? {})) return null
        const kind = defaultMediaKind(generator.output, owner.baseUrl)
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
        // 这个接口本来一个模型都没有 = 它还没法用。挂上第一个就切过去，
        // 省掉一次「加完了怎么还没生效」。
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
      // 删掉的正好是默认那一格，就近换一个，别留一个指向空处的 active。
      // 这个接口空了、别处也没有模型，就没有默认——删光最后一个模型是合法的「回到没配」。
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
              {/* 模型库和接口不是同一类（一个是模型参数，一个是端点与凭证），
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
                        <IconTrash size={13} />
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
                          onBlur={(e) => patchProvider(name(), { baseUrl: e.currentTarget.value })}
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
                                {/* 结论跟在模型 id 右边，同一行。放到行下面的话，
                                      每探一次这一行就长高一截，下面几行整体往下跳。 */}
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
                                  onClick={() =>
                                    void replaceConfig((cur) => ({
                                      ...cur,
                                      mediaDefaults: {
                                        ...cur.mediaDefaults,
                                        [output]: { provider: name(), model: id },
                                      },
                                    }))
                                  }
                                >
                                  {isDefault() ? '默认' : '设为默认'}
                                </button>
                                <span class="model-id">{id}</span>
                                <span class="model-output">{OUTPUT_LABEL[output]}</span>
                                {/* 没有「检测」：探测一次就是真生成一次、真扣一次费。 */}
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

          {/* 上面那排 tab 已经写着「模型库」，这里不再来一个同名标题。 */}
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
  )
}

/** 接口表里第一个挂了模型的那一格。删光当前接口时用它选下一个可用接口。 */
/**
 * 删掉生成模型或接口之后改默认生成模型：`gone` 命中的那一类换成同类的第一个，同类一个不剩就删掉那一类的键，
 * 全删空了整个字段不带。保存时这一份是权威，留一个指向已删模型的默认，保存会被 422 挡回来。
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
 * 而用户会据此去查一处没坏的配置。失败的那几步给出原文，结论错了要能查。
 */
export function ProbeSummary(props: { result: ProbeResult | { error: string } }) {
  /**
   * 一行说完，长了截断，完整内容进 `title`。
   *
   * 不换行也不折成多行：这一格坐在模型那一行里，一变高下面几行整体往下跳，
   * 而按钮就在同一行上（CLAUDE.md B9）。
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
          ? `${text().text}\n${props.result.outcome.effortSource === 'probe' ? '参数接受不代表独立强度已确认，接口可能将多个值映射到同一档。\n' : ''}${props.result.outcome.probes.map((p) => `${p.name}：${p.detail}`).join('\n')}`
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
