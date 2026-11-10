import {
  createEffect,
  createResource,
  createSignal,
  Match,
  onCleanup,
  Show,
  Switch,
} from 'solid-js'
import { loaded } from '../lib/resource.ts'
import { client, explainApiError } from '../lib/store/index.ts'

type TunnelStatus =
  | { state: 'connecting' }
  | { state: 'online' }
  | { state: 'offline'; message: string }
  | { state: 'outdated' }
  | { state: 'revoked' }
  | { state: 'replaced' }

export interface RemoteInfo {
  /** 已登录云端账号；未登录时没有远程访问的路径，本节不出现。 */
  available: boolean
  enabled: boolean
  tunnel: TunnelStatus | null
}

/** 连接中与重连期间读取状态的间隔。 */
const POLL_MS = 2000

const offlineMessage = (t: TunnelStatus | null) => (t?.state === 'offline' ? t.message : null)

/** 开关左侧的状态：圆点加一句话，过长时截断，完整内容见悬停提示。 */
function Status(props: { tone: 'success' | 'muted' | 'danger' | 'warning'; text: string }) {
  return (
    <span class={`pair-status pair-status-${props.tone}`} data-tip={props.text}>
      {props.text}
    </span>
  )
}

/**
 * 远程访问：开启后，在任何设备上登录同一账号的云端网页即可打开并使用本机，无需另行配对。
 * 它是账号窗口中的一节（远程访问依赖账号），整节由本组件输出，未登录时不出现。
 */
export default function PairPanel() {
  const [info, { refetch, mutate }] = createResource(() => client.api<RemoteInfo>('/api/pairing'))
  const [busy, setBusy] = createSignal(false)
  const [toggleError, setToggleError] = createSignal<string | null>(null)

  createEffect(() => {
    const state = loaded(info)?.tunnel?.state
    if (state !== 'connecting' && state !== 'offline') return
    const timer = setInterval(() => void refetch(), POLL_MS)
    onCleanup(() => clearInterval(timer))
  })

  /**
   * 失败时重新读取并把勾选框改回实际状态：勾选框已随点击改变，而读取的值未变时 Solid 不会重设该属性。
   */
  const toggle = async (input: HTMLInputElement) => {
    const enabled = input.checked
    setBusy(true)
    setToggleError(null)
    try {
      mutate(
        await client.api<RemoteInfo>('/api/pairing/remote', {
          method: 'POST',
          body: JSON.stringify({ enabled }),
        }),
      )
    } catch (e) {
      setToggleError(explainApiError(e, enabled ? '无法开启远程访问' : '无法关闭远程访问'))
      await refetch()
      input.checked = loaded(info)?.enabled ?? !enabled
    } finally {
      setBusy(false)
    }
  }

  /** 被另一个进程替换后重新连接；对方若仍在线，被替换的是对方。 */
  const reconnect = async (e: MouseEvent) => {
    // 按钮位于 label 内：不阻止默认行为时，点击会同时切换开关。
    e.preventDefault()
    setBusy(true)
    setToggleError(null)
    try {
      mutate(await client.api<RemoteInfo>('/api/pairing/reconnect', { method: 'POST' }))
    } catch (err) {
      setToggleError(explainApiError(err, '无法重新连接'))
    } finally {
      setBusy(false)
    }
  }

  // 使用 `loaded()` 而不是 `info()`：后者出错时会 `throw`，获取期间会挂起设置内容区的 Suspense。
  return (
    <Show when={loaded(info)?.available || info.error}>
      <section class="pair-section">
        <h3 class="account-section">远程访问</h3>
        <Show
          when={loaded(info)}
          fallback={<p class="pair-hint">{explainApiError(info.error, '无法读取接入信息')}</p>}
        >
          {(d) => (
            // 状态与开关同在一行：开关切换不改变本节高度，下方各节不随之移动。
            <label class="pair-toggle">
              <span class="pair-label">允许从云端网页使用这台电脑</span>
              <Switch>
                <Match when={toggleError()}>{(m) => <Status tone="danger" text={m()} />}</Match>
                <Match when={d().tunnel?.state === 'online'}>
                  <Status tone="success" text="已连接" />
                </Match>
                <Match when={d().tunnel?.state === 'connecting'}>
                  <Status tone="muted" text="连接中" />
                </Match>
                <Match when={offlineMessage(d().tunnel)}>
                  {(m) => <Status tone="danger" text={m()} />}
                </Match>
                <Match when={d().tunnel?.state === 'outdated'}>
                  <Status tone="warning" text="需要更新应用" />
                </Match>
                <Match when={d().tunnel?.state === 'replaced'}>
                  <Status tone="warning" text="已由另一个 qywork 进程接管" />
                  <button
                    type="button"
                    class="btn-ghost sm"
                    disabled={busy()}
                    onClick={(e) => void reconnect(e)}
                  >
                    重新连接
                  </button>
                </Match>
              </Switch>
              <input
                class="switch"
                type="checkbox"
                role="switch"
                aria-checked={d().enabled}
                checked={d().enabled}
                disabled={busy()}
                onChange={(e) => void toggle(e.currentTarget)}
              />
            </label>
          )}
        </Show>
      </section>
    </Show>
  )
}
