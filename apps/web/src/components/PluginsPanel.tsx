import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import {
  askInChat,
  client,
  installPlugin,
  isDesktopShell,
  pickWorkspace,
  uninstallPlugin,
} from '../lib/store/index.ts'
import { IconX } from './Icons.tsx'
import { LoadState } from './settings/LoadState.tsx'
import { EmptyBox, EntryCard, Section } from './settings/Page.tsx'

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

/** 「新增」递给模型的话头。不自动发送——用户可以改了再发。 */
const NEW_PLUGIN =
  '我们一起来做一个插件吧。先说明插件在 qywork 里怎么加载、跑在哪、能拿到什么权限，目录里要有哪些文件；然后问我这个插件要提供什么工具。'

export function PluginsPanel() {
  const [data, { refetch }] = createResource(() => client.api<PluginsPayload>('/api/plugins'))
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [okMsg, setOkMsg] = createSignal<string | null>(null)
  /** 新建表单。null = 没在建。 */

  /** 导入框开着没有。分开一个状态是因为两条路各自有各自的取消。 */

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

  /** 选一个本机上已经存在的插件目录，选完就装。 */
  const browse = async () => {
    if (!isDesktopShell()) return
    setError(null)
    setOkMsg(null)
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
      {/* 导入只有桌面外壳有：网页里没有系统文件选择器，
          留一个点了没反应的按钮比不给更糟（B5）。 */}
      <Show when={isDesktopShell()}>
        <button
          class="btn-ghost sm"
          type="button"
          disabled={busy() !== null}
          onClick={() => void browse()}
        >
          导入
        </button>
      </Show>
      <button class="btn-ghost sm" type="button" onClick={() => askInChat(NEW_PLUGIN)}>
        新增
      </button>
    </>
  )

  return (
    <>
      {/* `loaded()` 而不是 `data()`：装/卸插件之后要重取，重取期间留住上一份；
          出错时给 undefined，由 `LoadState` 说明原因并给一条重试的路——
          写成 `data()` 的话它会先抛，`fallback` 永远轮不到。 */}
      <Show
        when={loaded(data)}
        fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
      >
        {(d) => (
          <>
            <Section title="已安装" path={d().dir} actions={<Actions />}>
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
