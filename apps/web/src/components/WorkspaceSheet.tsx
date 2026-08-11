import { createResource, createSignal, For, Show } from 'solid-js'
import {
  isDesktopShell,
  type KnownWorkspace,
  loadKnownWorkspaces,
  pickWorkspace,
  state,
  switchWorkspace,
  workspace,
} from '../lib/store/index.ts'
import { IconFolder, IconX } from './Icons.tsx'

/**
 * 工作区切换。
 *
 * ## 为什么是「换掉整个 sidecar」而不是「一个进程服务多个根」
 *
 * 工作区不只是用来分表的 id，它是 `workspaceRoot`：工具的路径约束、文件树、
 * git 状态、权限硬边界全部以它为根。改成会话属性会同时牵动权限、git 监听、
 * 文件监听三条链路（ROADMAP §34.1）。重启一个进程便宜得多，也不会留下
 * 「这个请求属于哪个根」这种到处都要传的隐式上下文。
 *
 * ## 代价必须提前说
 *
 * 重启会打断正在跑的那一轮。按钮上写清楚，而不是让用户按下去之后才发现。
 *
 * ## Web 端不提供这个功能，并且说明为什么
 *
 * 浏览器和手机连的是一个已经起好的服务，它没有、也不该有重启宿主进程的能力。
 * 给一个点了没反应的按钮，比没有按钮更坏。
 */
export default function WorkspaceSheet(props: { onClose: () => void }) {
  const [known] = createResource(loadKnownWorkspaces)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const desktop = isDesktopShell()

  const go = async (path: string) => {
    if (path === workspace()?.root) return
    setBusy(true)
    setError(null)
    try {
      // 成功之后窗口会被重建，所以这之后不接任何成功提示——它来不及显示。
      await switchWorkspace(path)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const browse = async () => {
    setError(null)
    try {
      const picked = await pickWorkspace()
      if (picked) await go(picked)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <>
      <button class="backdrop-close" type="button" aria-label="关闭" onClick={props.onClose} />
      <div class="sheet-backdrop pass-through">
        <div class="sheet" role="dialog" aria-modal="true" aria-label="工作区">
          <div class="sheet-head">
            <IconFolder size={16} />
            <span>工作区</span>
            <button class="icon-btn" type="button" aria-label="关闭" onClick={props.onClose}>
              <IconX size={15} />
            </button>
          </div>

          <div class="sheet-body">
            <div class="field">
              <span class="field-label">当前</span>
              <code class="field-path">{workspace()?.root ?? '未连接'}</code>
            </div>

            <Show
              when={desktop}
              fallback={
                <div class="field-hint">
                  切换工作区要重启本机的 qy 服务，只有桌面端做得到。
                  在浏览器或手机上打开时，工作区由启动服务时的 <code>--cwd</code> 决定。
                </div>
              }
            >
              <div class="field-hint">
                切换会重启 qy 服务
                {state.running ? '，并打断当前正在执行的这一轮' : '；当前没有正在执行的任务'}。
                会话按工作区分开存放，切过去看到的是另一份列表。
              </div>

              <Show when={error()}>{(e) => <div class="settings-notices bad">{e()}</div>}</Show>

              <Show when={(known()?.workspaces.length ?? 0) > 0}>
                <div class="field-label">最近打开</div>
                <ul class="ws-list">
                  <For each={known()!.workspaces}>
                    {(w: KnownWorkspace) => (
                      <li>
                        <button
                          class="ws-item"
                          classList={{ current: w.rootPath === workspace()?.root }}
                          type="button"
                          disabled={busy() || w.rootPath === workspace()?.root}
                          onClick={() => void go(w.rootPath)}
                        >
                          <IconFolder size={14} />
                          <span class="ws-name truncate">{w.name}</span>
                          <span class="ws-path truncate">{w.rootPath}</span>
                        </button>
                      </li>
                    )}
                  </For>
                </ul>
              </Show>

              <button
                class="btn-primary"
                type="button"
                disabled={busy()}
                onClick={() => void browse()}
              >
                {busy() ? '切换中…' : '打开其他目录…'}
              </button>
            </Show>
          </div>
        </div>
      </div>
    </>
  )
}
