import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import {
  client,
  createPlugin,
  installPlugin,
  isDesktopShell,
  pickWorkspace,
  uninstallPlugin,
} from '../lib/store/index.ts'
import { IconX } from './Icons.tsx'
import { LoadState } from './settings/LoadState.tsx'
import { EmptyBox, EntryCard, PageHead, PathLine, Section } from './settings/Page.tsx'

interface PluginTool {
  name: string
  description: string
}
interface PluginEntry {
  id: string
  name: string
  version: string
  permissions: string[]
  tools: PluginTool[]
  process: 'declarative' | 'running' | 'unknown'
  sandboxed?: boolean
  netGuarded?: boolean
  note?: string
}
interface PluginsPayload {
  dir: string
  plugins: PluginEntry[]
  failures: { dir: string; reason: string }[]
}

/**
 * 插件。
 *
 * ## 不分层
 *
 * 只有 `~/.qywork/plugins/` 一个目录。插件贡献的是工具、预览器、供应商——
 * 那些是这个 agent 的能力，不是某个仓库的内容。分层的代价是同一个插件在两个
 * 仓库里各存一份、各自升级。「这个项目要不要加载它」是开关，不是第二份拷贝。
 *
 * ## 为什么不叫「插件市场」
 *
 * 这个项目没有中心 registry，也不该现造一个。一个叫「市场」而里面没有任何
 * 可安装内容的页面，就是把这次删掉的空壳换个名字再造一遍。所以这里只做
 * **已安装**——它有真实数据源，而「市场」没有。
 *
 * ## 与 `qy plugins` 同源
 *
 * 走的是同一个 `loadExtensions`，所以命令行与界面对「装了什么、隔离到什么程度」
 * 不会给出两种答案。两套读法迟早分叉，而分叉的那一刻没有人会发现。
 *
 * ## 失败的也要列
 *
 * 装失败的插件恰恰是最需要被看到的：只列成功的，会让「我明明放进去了怎么没有」
 * 完全无从查起。
 *
 * ## MCP 不在这一页
 *
 * 它自己有一页。之前挂在这里是因为当时没有 MCP 接口，只有 `/api/plugins` 顺带
 * 回的一个名字数组——那不是设计，是将就。
 */
/** 插件目录的最后一段。绝对路径当标题会把整张卡撑成两行，而原因才是要看的。 */
function dirName(dir: string): string {
  return dir.split(/[\\/]/).pop() ?? dir
}

export function PluginsPanel() {
  const [data, { refetch }] = createResource(() => client.api<PluginsPayload>('/api/plugins'))
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [okMsg, setOkMsg] = createSignal<string | null>(null)
  const [manual, setManual] = createSignal('')
  /** 新建表单。null = 没在建。 */
  const [draft, setDraft] = createSignal<{ id: string; name: string; description: string } | null>(
    null,
  )
  /** 导入框开着没有。分开一个状态是因为两条路各自有各自的取消。 */
  const [importing, setImporting] = createSignal(false)

  const act = async (key: string, fn: () => Promise<unknown>, ok: (r: never) => string) => {
    setBusy(key)
    setError(null)
    setOkMsg(null)
    try {
      const r = (await fn()) as never
      setOkMsg(ok(r))
      // 装完 / 卸完立刻重拉：列表不刷新的话用户会以为没生效，然后再点一次。
      await refetch()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const install = (path: string) =>
    act(
      'install',
      () => installPlugin(path),
      (r: { id: string }) =>
        // 说清「装好了但还没生效」：插件在服务启动时加载，不是热插拔。
        // 不写这句的话，装完发现工具列表没变，会被当成安装失败。
        `已装入 ${r.id}。插件在服务启动时加载，重启后生效。`,
    )

  const browse = async () => {
    if (!isDesktopShell()) return
    try {
      const picked = await pickWorkspace()
      if (picked) await install(picked)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 这一段的两个动作。**区头和空态框共用同一份**——两处各写一遍的话迟早只改一处，
   * 而空的时候用户看到的恰恰是空态框里那一份。
   */
  const Actions = () => (
    <>
      <button
        class="btn-ghost sm"
        type="button"
        disabled={busy() !== null}
        onClick={() => {
          setDraft(null)
          setError(null)
          setOkMsg(null)
          setImporting(true)
        }}
      >
        导入
      </button>
      <button
        class="btn-ghost sm"
        type="button"
        disabled={busy() !== null}
        onClick={() => {
          setImporting(false)
          setError(null)
          setOkMsg(null)
          setDraft({ id: '', name: '', description: '' })
        }}
      >
        新建
      </button>
    </>
  )

  const create = (d: { id: string; name: string; description: string }) =>
    act(
      'new',
      () => createPlugin(d),
      (r: { id: string }) => {
        setDraft(null)
        // 和安装同一条边界：插件在服务启动时加载，不是热插拔。
        return `已建好 ${r.id}。改完代码重启后生效。`
      },
    )

  return (
    <>
      {/* 页头在 `Show` 外面：起插件子进程要几秒，这几秒里这一页也该有名字。 */}
      <PageHead
        title="插件"
        desc="插件为模型贡献工具。只有全局一份，装一次对所有项目生效，重启后加载。"
      />
      {/* `loaded()` 而不是 `data()`：装/卸插件之后要重取，重取期间留住上一份；
          出错时给 undefined，由 `LoadState` 说明原因并给一条重试的路——
          写成 `data()` 的话它会先抛，`fallback` 永远轮不到。 */}
      <Show
        when={loaded(data)}
        fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
      >
        {(d) => (
          <>
            <Section title="已安装" actions={<Actions />}>
              <Show
                when={d().plugins.length > 0}
                fallback={<EmptyBox label="还没有装插件" actions={<Actions />} />}
              >
                <div class="entry-list">
                  <For each={d().plugins}>
                    {(p) => (
                      <EntryCard
                        name={p.id}
                        desc={`${p.name} · ${p.version} · ${p.tools.length} 个工具 · 权限 ${
                          p.permissions.length ? p.permissions.join('、') : '（无）'
                        }`}
                        actions={
                          <button
                            class="icon-btn"
                            type="button"
                            aria-label={`卸载 ${p.id}`}
                            data-tip="卸载"
                            disabled={busy() === p.id}
                            onClick={() =>
                              void act(
                                p.id,
                                () => uninstallPlugin(p.id),
                                () => `已卸载 ${p.id}，重启后生效。`,
                              )
                            }
                          >
                            <IconX size={13} />
                          </button>
                        }
                      >
                        {/* 隔离状态分三种，不能合并显示。
                          「纯声明式插件没有进程」和「有进程但没隔离」是完全不同的事，
                          显示成同一个「无」会让人以为出了安全问题。 */}
                        <div class="entry-extra">
                          <Show when={p.process === 'declarative'}>
                            <span>纯声明式插件，没有代码进程</span>
                          </Show>
                          <Show when={p.process === 'unknown'}>
                            <span>进程未启动，隔离状态未知</span>
                          </Show>
                          <Show when={p.process === 'running'}>
                            <span class="iso-flag" classList={{ off: !p.sandboxed }}>
                              沙箱 {p.sandboxed ? '有' : '无'}
                            </span>
                            <span class="iso-flag" classList={{ off: !p.netGuarded }}>
                              出网闸 {p.netGuarded ? '有' : '无'}
                            </span>
                            <Show when={p.note}>{(n) => <span>{n()}</span>}</Show>
                          </Show>
                        </div>
                        <Show when={p.tools.length}>
                          <div class="entry-extra">
                            <For each={p.tools}>{(t) => <code>{t.name}</code>}</For>
                          </div>
                        </Show>
                      </EntryCard>
                    )}
                  </For>
                </div>
              </Show>
            </Section>

            <Show when={d().failures.length > 0}>
              <Section title="没装上">
                <div class="entry-list">
                  <For each={d().failures}>
                    {(f) => (
                      <div class="entry-card failed">
                        <div class="entry-row">
                          <div class="entry-main">
                            <div class="entry-title">
                              <span class="entry-name">{dirName(f.dir)}</span>
                            </div>
                          </div>
                        </div>
                        <div class="entry-extra bad">{f.reason}</div>
                      </div>
                    )}
                  </For>
                </div>
              </Section>
            </Show>

            <Show when={draft()}>
              {(f) => (
                <Section title="新建插件">
                  <div class="setting-rows">
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">标识</span>
                        <span class="setting-row-hint">
                          工具名按它拼前缀，反向域名风格，只能用字母数字和 . _ -
                        </span>
                      </div>
                      <input
                        type="text"
                        value={f().id}
                        placeholder="如 demo.lines"
                        onInput={(e) => setDraft({ ...f(), id: e.currentTarget.value })}
                      />
                    </div>
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">名称</span>
                      </div>
                      <input
                        type="text"
                        value={f().name}
                        placeholder="如 行数统计"
                        onInput={(e) => setDraft({ ...f(), name: e.currentTarget.value })}
                      />
                    </div>
                    <div class="setting-row stack">
                      <div class="setting-row-text">
                        <span class="setting-row-label">说明</span>
                      </div>
                      <input
                        type="text"
                        value={f().description}
                        placeholder="数一个文件有多少行"
                        onInput={(e) => setDraft({ ...f(), description: e.currentTarget.value })}
                      />
                    </div>
                  </div>
                  <div class="row-actions">
                    <button
                      class="btn-primary"
                      type="button"
                      disabled={busy() !== null || !f().id.trim()}
                      onClick={() => void create(f())}
                    >
                      创建
                    </button>
                    <button class="btn-ghost" type="button" onClick={() => setDraft(null)}>
                      取消
                    </button>
                  </div>
                  <span class="field-hint">
                    会落一份能跑起来的骨架（清单 + 一个 echo 工具），改完重启生效。
                  </span>
                </Section>
              )}
            </Show>

            {/* 导入。
              只接受**本机已存在的目录**：没有 registry，所以没有「从市场安装」；
              也刻意不做 git clone 任意 URL——那等于从网上取一段代码，下次加载就跑它。 */}
            <Show when={importing()}>
              <Section title="导入插件目录">
                <div class="field">
                  <input
                    type="text"
                    placeholder="插件目录的绝对路径"
                    value={manual()}
                    onInput={(e) => setManual(e.currentTarget.value)}
                  />
                  <span class="field-hint">
                    目录里要有 <code>qywork.plugin.json</code>；清单不合法会被拒绝，不会装进去一半。
                  </span>
                </div>
                <div class="row-actions">
                  <Show when={isDesktopShell()}>
                    <button
                      class="btn-ghost"
                      type="button"
                      disabled={busy() !== null}
                      onClick={() => void browse()}
                    >
                      选择目录…
                    </button>
                  </Show>
                  <button
                    class="btn-primary"
                    type="button"
                    disabled={!manual().trim() || busy() !== null}
                    onClick={() => void install(manual().trim())}
                  >
                    导入
                  </button>
                  <button class="btn-ghost" type="button" onClick={() => setImporting(false)}>
                    取消
                  </button>
                </div>
              </Section>
            </Show>

            <Section>
              <PathLine path={d().dir} />
            </Section>

            {/* 结果落在页面上，不挂在某一个表单里——建完之后表单就关了，
              挂在里面的话那句「已建好」跟着一起消失。
              `error()` / `okMsg()` 必须排在这串 `&&` 的最后：`Show` 把 `when` 的
              求值结果原样交给子函数，布尔 `true` 渲染出来是一个空框。 */}
            <Show when={error()}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>
            <Show when={okMsg()}>{(m) => <p class="settings-notices">{m()}</p>}</Show>
          </>
        )}
      </Show>
    </>
  )
}
