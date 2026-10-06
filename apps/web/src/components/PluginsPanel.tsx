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
import { IconTrash } from './Icons.tsx'
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
 * **不分层。** 只有 `~/.qywork/plugins/` 一个目录。插件提供的是工具、预览器、供应商，
 * 属于本 agent 的能力，不属于某个仓库的内容。分层的代价是同一个插件在两个
 * 仓库中各存一份、各自升级。「本项目是否加载它」是开关，不是第二份副本。
 *
 * **不称为「插件市场」。** 本项目没有中心 registry，也不应临时建立。名为「市场」却没有
 * 任何可安装内容的页面，只是换名重建的空壳。因此此处只做 **已安装**：它有真实
 * 数据源，而「市场」没有。
 *
 * **与 `qy plugins` 同源。** 两者使用同一个 `loadExtensions`，因此命令行与界面对「安装了什么、隔离到什
 * 么程度」不会给出两种答案。两套读取逻辑终将分叉，且分叉发生时无法察觉。
 *
 * **失败的插件也要列出。** 安装失败的插件最需要被看到：只列出成功的插件时，「已放入目录却未出现」将无从排查。
 *
 * **MCP 不在本页。** MCP 有独立的页面。不要因为 `/api/plugins` 同时返回了一个名称数组就把 MCP 放回
 * 本页。
 */
/** 插件目录路径的最后一段。用绝对路径作标题会把整张卡片撑成两行，而需要查看的是失败原因。 */
function dirName(dir: string): string {
  return dir.split(/[\\/]/).pop() ?? dir
}

/** 「新增」时交给模型的初始指令。不自动发送：用户可以修改后再发送。 */
const NEW_PLUGIN =
  '新建一个插件。请先说明插件在 qywork 中如何加载、运行在何处、可获得哪些权限，以及目录需包含哪些文件；然后询问该插件要提供哪些工具。'

export function PluginsPanel() {
  const [data, { refetch }] = createResource(() => client.api<PluginsPayload>('/api/plugins'))
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [okMsg, setOkMsg] = createSignal<string | null>(null)
  const act = async (key: string, fn: () => Promise<unknown>, ok: (r: never) => string) => {
    setBusy(key)
    setError(null)
    setOkMsg(null)
    try {
      const r = (await fn()) as never
      setOkMsg(ok(r))
      // 安装或卸载后立即重新获取：列表不刷新时界面上相当于未生效，用户会再次点击。
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
        // 说明「已安装但尚未生效」：插件在服务启动时加载，不支持热插拔。
        // 不写这句时，安装后发现工具列表未变化，会被当作安装失败。
        `已安装 ${r.id}。插件在服务启动时加载，重启后生效。`,
    )

  /** 选择本机上已存在的插件目录，选择后立即安装。 */
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
   * 本区域的两个操作。**区域标题与空状态框共用同一份定义**：两处分别实现时终将只修改其中一处，
   * 而列表为空时用户看到的是空状态框中的那一份。
   */
  const Actions = () => (
    <>
      {/* 导入只在桌面外壳中提供：网页中没有系统文件选择器，
          保留一个点击无响应的按钮比不提供更差（B5）。 */}
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
      {/* 使用 `loaded()` 而不是 `data()`：安装或卸载插件后需要重新获取，重新获取期间保留上一份数据；
          出错时返回 undefined，由 `LoadState` 说明原因并提供重试入口。
          写成 `data()` 时它会先抛出错误，`fallback` 永远不会显示。 */}
      <Show
        when={loaded(data)}
        fallback={<LoadState error={data.error} onRetry={() => void refetch()} />}
      >
        {(d) => (
          <>
            <Section title="已安装" path={d().dir} actions={<Actions />}>
              <Show
                when={d().plugins.length > 0}
                fallback={<EmptyBox label="尚未安装插件" actions={<Actions />} />}
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
                            <IconTrash size={13} />
                          </button>
                        }
                      >
                        {/* 隔离状态分三种，不能合并显示。
                          「纯声明式插件没有进程」与「有进程但未隔离」完全不同，
                          显示为同一个「无」会把前者误读为安全问题。 */}
                        <div class="entry-extra">
                          <Show when={p.process === 'declarative'}>
                            <span>纯声明式插件，无代码进程</span>
                          </Show>
                          <Show when={p.process === 'unknown'}>
                            <span>进程未启动，隔离状态未知</span>
                          </Show>
                          <Show when={p.process === 'running'}>
                            <span class="iso-flag" classList={{ off: !p.sandboxed }}>
                              沙箱 {p.sandboxed ? '有' : '无'}
                            </span>
                            <span class="iso-flag" classList={{ off: !p.netGuarded }}>
                              网络访问限制 {p.netGuarded ? '有' : '无'}
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
              <Section title="安装失败">
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

            {/* 结果显示在页面上，不放在某个表单中：创建完成后表单即关闭，
              放在表单中的「已创建」提示会随之消失。
              `when` 中以 `&&` 组合条件时，`error()` / `okMsg()` 必须排在最后：`Show` 把 `when` 的
              求值结果原样传给子函数，布尔值 `true` 会渲染为一个空框。 */}
            <Show when={error()}>{(e) => <p class="settings-notices bad">{e()}</p>}</Show>
            <Show when={okMsg()}>{(m) => <p class="settings-notices">{m()}</p>}</Show>
          </>
        )}
      </Show>
    </>
  )
}
