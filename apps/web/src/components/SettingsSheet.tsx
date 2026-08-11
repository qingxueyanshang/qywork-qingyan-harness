import { createResource, createSignal, For, Match, Show, Switch } from 'solid-js'
import {
  type ConfigPayload,
  loadServerConfig,
  loadTeamRaw,
  type RedactedConfig,
  type RedactedProfile,
  saveServerConfig,
  saveTeamRaw,
  setPairOpen,
  setSettingsOpen,
  workspace,
} from '../lib/store/index.ts'
import { IconX } from './Icons.tsx'
import { PluginsPanel } from './PluginsPanel.tsx'
import { SchedulesPanel } from './SchedulesPanel.tsx'

type Tab = 'system' | 'models' | 'schedules' | 'team' | 'plugins' | 'mobile'

/**
 * 设置。
 *
 * ## 为什么是一个入口四个选项卡，而不是四个侧边栏项
 *
 * 侧边栏是**导航**——它回答「我要去哪」。设置是**低频的、改完就走**的操作，
 * 把它平铺进导航会让四个几乎不用的入口常驻在最显眼的位置。参照物（Codex）
 * 的侧边栏项全是高频去处，没有一个是配置。
 *
 * ## 配置只有一个来源
 *
 * 模型档案读写的是 `~/.qywork/config.json` 本身，Team 读写的是工作区的
 * `.qy/team.json` 本身。界面是这两个文件的编辑器，不另存任何副本——
 * 原先 `TeamPanel` 拒绝做写入的理由是「配置有两个来源迟早分叉」，
 * 那个担心成立，但结论错了：分叉来自「界面自己存一份」，不来自「有界面」。
 *
 * ## 明文 key 不回传
 *
 * 服务端只回 `hasApiKey` 布尔。保存时没带 `apiKey` 的档案沿用服务端已有的那份，
 * 所以「打开设置改个 baseUrl 再保存」不会把 key 洗掉——这类破坏在保存那一刻
 * 毫无反馈，要等下一次调模型才炸。
 */
export default function SettingsSheet() {
  const [tab, setTab] = createSignal<Tab>('system')

  return (
    <>
      {/* 关闭遮罩是对话框的**兄弟节点**，沿用 PairSheet 的写法：
          套成父节点就得靠 stopPropagation 才不误触发，而那正是 a11y 规则在拦的形状。 */}
      <button
        class="backdrop-close"
        type="button"
        aria-label="关闭"
        onClick={() => setSettingsOpen(false)}
      />
      <div class="sheet-backdrop pass-through">
        <div class="sheet settings-sheet" role="dialog" aria-modal="true" aria-label="设置">
          <header class="sheet-head">
            <div class="side-tabs">
              <For
                each={
                  [
                    ['system', '系统'],
                    ['models', '模型'],
                    ['schedules', '定时'],
                    ['team', '协作'],
                    ['plugins', '插件'],
                    ['mobile', '手机接入'],
                  ] as [Tab, string][]
                }
              >
                {([id, label]) => (
                  <button
                    class="side-tab"
                    classList={{ active: tab() === id }}
                    type="button"
                    onClick={() => setTab(id)}
                  >
                    {label}
                  </button>
                )}
              </For>
            </div>
            <button
              class="icon-btn"
              type="button"
              aria-label="关闭设置"
              onClick={() => setSettingsOpen(false)}
            >
              <IconX size={15} />
            </button>
          </header>

          <div class="sheet-body">
            <Switch>
              <Match when={tab() === 'system'}>
                <SystemTab />
              </Match>
              <Match when={tab() === 'models'}>
                <ModelsTab />
              </Match>
              <Match when={tab() === 'team'}>
                <TeamTab />
              </Match>
              <Match when={tab() === 'schedules'}>
                <SchedulesPanel />
              </Match>
              <Match when={tab() === 'plugins'}>
                <PluginsPanel />
              </Match>
              <Match when={tab() === 'mobile'}>
                <MobileTab />
              </Match>
            </Switch>
          </div>
        </div>
      </div>
    </>
  )
}

// ───────────────────────── 保存状态 ─────────────────────────

/**
 * 三个组件共用的保存反馈。
 *
 * 「保存中 / 成功 / 失败并附原因」缺一不可。只有成功提示的话，422（配置不合格、
 * 服务端拒绝落盘）会表现成「点了没反应」——而那正是这次返工要消灭的东西。
 */
function useSaveState() {
  const [saving, setSaving] = createSignal(false)
  const [result, setResult] = createSignal<{ ok: boolean; message: string } | null>(null)
  const run = async (fn: () => Promise<unknown>, okMessage: string) => {
    setSaving(true)
    setResult(null)
    try {
      await fn()
      setResult({ ok: true, message: okMessage })
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : String(e) })
    } finally {
      setSaving(false)
    }
  }
  return { saving, result, run }
}

function SaveRow(props: {
  saving: boolean
  result: { ok: boolean; message: string } | null
  onSave: () => void
  disabled?: boolean
}) {
  return (
    <div class="settings-save">
      <button
        class="btn-primary"
        type="button"
        disabled={props.saving || props.disabled}
        onClick={props.onSave}
      >
        {props.saving ? '保存中' : '保存'}
      </button>
      <Show when={props.result}>
        {(r) => (
          <span class="save-msg" classList={{ bad: !r().ok }}>
            {r().message}
          </span>
        )}
      </Show>
    </div>
  )
}

// ───────────────────────── 系统 ─────────────────────────

function SystemTab() {
  const [payload, { refetch }] = createResource<ConfigPayload>(loadServerConfig)
  const [draft, setDraft] = createSignal<RedactedConfig | null>(null)
  const save = useSaveState()

  const cfg = () => draft() ?? payload()?.config ?? null
  const patch = (p: Partial<RedactedConfig>) => {
    const base = cfg()
    if (base) setDraft({ ...base, ...p })
  }

  return (
    <Show when={cfg()} fallback={<div class="settings-loading">读取配置…</div>}>
      {(c) => (
        <div class="settings-form">
          <label class="field">
            <span class="field-label">权限模式</span>
            <select
              value={c().mode ?? 'auto'}
              onChange={(e) => patch({ mode: e.currentTarget.value as 'auto' | 'full' })}
            >
              <option value="auto">auto —— 由硬边界 + 静态规则 + 分类器裁决</option>
              <option value="full">full —— 全放行（放弃全部裁决）</option>
            </select>
            {/* 说清 full 不等于「什么都不管」：三条硬边界它也生效。
                写成「完全放开」会让人以为凭证也会进子进程。 */}
            <span class="field-hint">
              full 仍保留三条硬边界：凭证不进子进程、输出里的凭证明文屏蔽、禁止写 .qy/
            </span>
          </label>

          <label class="field">
            <span class="field-label">默认思考强度</span>
            <select
              value={c().effort ?? 'high'}
              onChange={(e) =>
                patch({ effort: e.currentTarget.value as NonNullable<RedactedConfig['effort']> })
              }
            >
              <For each={['low', 'medium', 'high', 'xhigh', 'max']}>
                {(v) => <option value={v}>{v}</option>}
              </For>
            </select>
          </label>

          <label class="field">
            <span class="field-label">工作区之外额外可读写的目录</span>
            <textarea
              rows={3}
              placeholder="一行一个绝对路径"
              value={(c().additionalDirectories ?? []).join('\n')}
              onInput={(e) =>
                patch({
                  additionalDirectories: e.currentTarget.value
                    .split('\n')
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
            />
            {/* 相对路径的基准是启动 qy 时所在的目录，换个地方启动含义就变，
                所以配置层只接受绝对路径。这里提前说，免得保存时才被 422 顶回来。 */}
            <span class="field-hint">只接受绝对路径。full 模式不豁免这条边界。</span>
          </label>

          <div class="field">
            <span class="field-label">配置文件</span>
            <code class="field-path">{payload()?.path}</code>
          </div>

          <Show when={workspace()}>
            {(w) => (
              <div class="field">
                <span class="field-label">当前工作区</span>
                <code class="field-path">{w().root}</code>
                {/* 会话按工作区分表。用户在两个客户端看到两份会话时，
                    唯一能自己诊断出来的线索就是这一行。 */}
                <span class="field-hint">会话按工作区分开存放，换工作区会看到另一份列表。</span>
              </div>
            )}
          </Show>

          <Show when={payload()?.notices?.length}>
            <ul class="settings-notices">
              <For each={payload()!.notices}>{(n) => <li>{n}</li>}</For>
            </ul>
          </Show>

          <SaveRow
            saving={save.saving()}
            result={save.result()}
            onSave={() =>
              void save.run(async () => {
                await saveServerConfig(c())
                setDraft(null)
                await refetch()
              }, '已保存')
            }
          />
        </div>
      )}
    </Show>
  )
}

// ───────────────────────── 模型 ─────────────────────────

const PROVIDER_KINDS = ['anthropic', 'openai_compatible', 'openai_responses'] as const

function ModelsTab() {
  const [payload, { refetch }] = createResource<ConfigPayload>(loadServerConfig)
  const [draft, setDraft] = createSignal<RedactedConfig | null>(null)
  const save = useSaveState()

  const cfg = () => draft() ?? payload()?.config ?? null
  const names = () => Object.keys(cfg()?.profiles ?? {})

  const patchProfile = (name: string, p: Partial<RedactedProfile>) => {
    const base = cfg()
    if (!base) return
    setDraft({
      ...base,
      profiles: { ...base.profiles, [name]: { ...base.profiles[name]!, ...p } },
    })
  }

  const addProfile = () => {
    const base = cfg()
    if (!base) return
    let name = '新档案'
    let i = 2
    while (name in base.profiles) name = `新档案 ${i++}`
    setDraft({
      ...base,
      profiles: {
        ...base.profiles,
        [name]: { kind: 'openai_compatible', model: '', hasApiKey: false },
      },
    })
  }

  const removeProfile = (name: string) => {
    const base = cfg()
    if (!base) return
    const { [name]: _drop, ...rest } = base.profiles
    // 删掉的正好是当前档案时要顺手改 active，否则保存会被 diagnoseConfig 顶回来，
    // 而报错文案说的是「active 指向不存在的档案」——用户不会把它和刚才那次删除联系起来。
    const active = base.active === name ? (Object.keys(rest)[0] ?? '') : base.active
    setDraft({ ...base, profiles: rest, active })
  }

  return (
    <Show when={cfg()} fallback={<div class="settings-loading">读取配置…</div>}>
      {(c) => (
        <div class="settings-form">
          <label class="field">
            <span class="field-label">当前档案</span>
            <select
              value={c().active}
              onChange={(e) => setDraft({ ...c(), active: e.currentTarget.value })}
            >
              <For each={names()}>{(n) => <option value={n}>{n}</option>}</For>
            </select>
          </label>

          <For each={names()}>
            {(name) => {
              const p = () => c().profiles[name]!
              return (
                <div class="profile-card" classList={{ active: c().active === name }}>
                  <div class="profile-head">
                    <span class="profile-name">{name}</span>
                    <button
                      class="icon-btn"
                      type="button"
                      aria-label={`删除档案 ${name}`}
                      onClick={() => removeProfile(name)}
                    >
                      <IconX size={13} />
                    </button>
                  </div>

                  <label class="field">
                    <span class="field-label">协议</span>
                    <select
                      value={p().kind}
                      onChange={(e) => patchProfile(name, { kind: e.currentTarget.value })}
                    >
                      <For each={PROVIDER_KINDS}>{(k) => <option value={k}>{k}</option>}</For>
                    </select>
                    {/* 这条必须写在界面上：经中转站以 OpenAI 协议调 Claude 是常见配置，
                        按模型名猜厂商会把请求路由到错误的协议上。 */}
                    <span class="field-hint">按端点实际说的协议选，不要按模型名猜厂商。</span>
                  </label>

                  <label class="field">
                    <span class="field-label">模型 ID</span>
                    <input
                      type="text"
                      value={p().model}
                      onInput={(e) => patchProfile(name, { model: e.currentTarget.value })}
                    />
                  </label>

                  <label class="field">
                    <span class="field-label">Base URL</span>
                    <input
                      type="text"
                      placeholder="留空用官方默认"
                      value={p().baseUrl ?? ''}
                      onInput={(e) => patchProfile(name, { baseUrl: e.currentTarget.value })}
                    />
                  </label>

                  <label class="field">
                    <span class="field-label">API Key 环境变量名</span>
                    <input
                      type="text"
                      placeholder="如 DEEPSEEK_API_KEY"
                      value={p().apiKeyEnv ?? ''}
                      onInput={(e) => patchProfile(name, { apiKeyEnv: e.currentTarget.value })}
                    />
                    <span class="field-hint">环境变量优先于明文 key。</span>
                  </label>

                  <label class="field">
                    <span class="field-label">API Key</span>
                    <input
                      type="password"
                      placeholder={p().hasApiKey ? '已设置（留空则保持不变）' : '未设置'}
                      onInput={(e) =>
                        patchProfile(name, {
                          ...(e.currentTarget.value
                            ? { apiKey: e.currentTarget.value, hasApiKey: true }
                            : {}),
                        } as Partial<RedactedProfile>)
                      }
                    />
                    {/* 明文 key 从不回传前端，所以这里永远是空的。
                        不写这句的话，「已设置」的档案打开看到空框，用户会以为 key 丢了。 */}
                    <span class="field-hint">
                      服务端不回传明文 key。留空 = 保持原值；要清除请填一个空格再删掉。
                    </span>
                  </label>

                  <label class="field">
                    <span class="field-label">最大输出 token</span>
                    <input
                      type="number"
                      value={p().maxOutputTokens ?? ''}
                      onInput={(e) => {
                        // 清空 = **删掉这个键**，不是写 undefined。
                        // 写 undefined 会让 JSON 里留下 `"maxOutputTokens": null`，
                        // 而配置层对「没配」和「配成 null」的处理是两回事。
                        const v = e.currentTarget.value
                        const base = cfg()
                        if (!base) return
                        const { maxOutputTokens: _drop, ...rest } = base.profiles[name]!
                        setDraft({
                          ...base,
                          profiles: {
                            ...base.profiles,
                            [name]: v ? { ...rest, maxOutputTokens: Number(v) } : rest,
                          },
                        })
                      }}
                    />
                  </label>
                </div>
              )
            }}
          </For>

          <button class="btn-ghost" type="button" onClick={addProfile}>
            添加档案
          </button>

          <Show when={payload()?.problems?.length}>
            <ul class="settings-notices bad">
              <For each={payload()!.problems}>{(n) => <li>{n}</li>}</For>
            </ul>
          </Show>

          <SaveRow
            saving={save.saving()}
            result={save.result()}
            onSave={() =>
              void save.run(async () => {
                await saveServerConfig(c())
                setDraft(null)
                await refetch()
              }, '已保存，本进程已切到新配置')
            }
          />
        </div>
      )}
    </Show>
  )
}

// ───────────────────────── 协作 ─────────────────────────

function TeamTab() {
  const [file, { refetch }] = createResource(loadTeamRaw)
  const [draft, setDraft] = createSignal<string | null>(null)
  const save = useSaveState()

  const text = () => draft() ?? file()?.raw ?? ''

  const TEMPLATE = `{
  "backends": {},
  "roles": [],
  "plan": []
}
`

  return (
    <Show when={file()} fallback={<div class="settings-loading">读取 team.json…</div>}>
      {(f) => (
        <div class="settings-form">
          <div class="field">
            <span class="field-label">配置文件</span>
            <code class="field-path">{f().path}</code>
            {/* 编排图是**跟着仓库走**的：它属于这个项目怎么分工，不属于这台机器。
                所以它在工作区里，不在 ~/.qywork 里。 */}
            <span class="field-hint">编排配置跟着工作区走，会随仓库一起提交。</span>
          </div>

          <label class="field">
            <span class="field-label">team.json</span>
            <textarea
              class="code-area"
              rows={16}
              spellcheck={false}
              value={text()}
              onInput={(e) => setDraft(e.currentTarget.value)}
            />
          </label>

          <Show when={!f().exists && !draft()}>
            <button class="btn-ghost" type="button" onClick={() => setDraft(TEMPLATE)}>
              插入空模板
            </button>
          </Show>

          <SaveRow
            saving={save.saving()}
            result={save.result()}
            disabled={!text().trim()}
            onSave={() =>
              void save.run(async () => {
                // 先本地解析一次再发：同样的错误让服务端回 422 也行，
                // 但本地解析能立刻指出出错的位置，往返一次只会得到一句话。
                JSON.parse(text())
                await saveTeamRaw(text())
                setDraft(null)
                await refetch()
              }, '已保存')
            }
          />
        </div>
      )}
    </Show>
  )
}

// ───────────────────────── 手机接入 ─────────────────────────

function MobileTab() {
  return (
    <div class="settings-form">
      <p class="field-hint">
        手机与桌面端连的是同一个服务、同一套协议。开启后局域网内任何设备都能触达这个工作区，
        所以令牌是强制的。
      </p>
      <button
        class="btn-primary"
        type="button"
        onClick={() => {
          setSettingsOpen(false)
          setPairOpen(true)
        }}
      >
        生成配对二维码
      </button>
    </div>
  )
}
