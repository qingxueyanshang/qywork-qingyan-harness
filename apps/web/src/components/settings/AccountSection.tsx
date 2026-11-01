import { formatMoney } from '@qywork/core'
import { createSignal, type JSX, Match, onCleanup, Show, Switch } from 'solid-js'
import {
  type CloudState,
  cloudLogout,
  fetchCloudState,
  signedOutReason,
  startCloudLogin,
} from '../../lib/store/cloud.ts'
import { reloadModelCatalog } from '../../lib/store/settings.ts'
import { isDesktopShell } from '../../lib/store/shell.ts'
import { Row } from './Row.tsx'

/** 登录进行中时读取状态的间隔。 */
const POLL_MS = 2000

type Pending = Extract<CloudState, { state: 'pending' }>
type SignedIn = Extract<CloudState, { state: 'signed_in' }>

/**
 * 云端账号状态：首次读取、登录进行中时按间隔读取、各操作后以服务端返回为准。
 * 登录完成后内置模型写入了配置，模型列表随之刷新。账号区块与首次启动的登录页共用。
 */
export function useCloudAccount() {
  const [state, setState] = createSignal<CloudState | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const apply = (next: CloudState) => {
    const was = state()?.state
    setState(next)
    if (next.state === 'signed_in' && was !== undefined && was !== 'signed_in') {
      void reloadModelCatalog()
    }
  }
  const run = async (work: () => Promise<CloudState>) => {
    setBusy(true)
    setError(null)
    try {
      apply(await work())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  void run(fetchCloudState)
  const timer = setInterval(() => {
    if (state()?.state === 'pending') void fetchCloudState().then(apply, () => {})
  }, POLL_MS)
  onCleanup(() => clearInterval(timer))

  return {
    state,
    busy,
    error,
    login: () => run(startCloudLogin),
    logout: () => run(cloudLogout),
  }
}

/**
 * 登录码与打开方式。桌面外壳中「在浏览器中打开」再次请求登录：进行中的登录返回同一个登录码，
 * 服务端以系统浏览器打开确认页（应用内的面板浏览器不保留登录状态）。其他情况下显示确认页地址。
 */
export function PendingCode(props: { pending: Pending; busy: boolean; onOpen: () => void }) {
  return (
    <>
      <code>{props.pending.userCode}</code>
      <Show when={isDesktopShell()} fallback={<code>{props.pending.verificationUri}</code>}>
        <button type="button" class="btn-ghost sm" disabled={props.busy} onClick={props.onOpen}>
          在浏览器中打开
        </button>
      </Show>
    </>
  )
}

/** 「通用」页的账号区块。未配置云端服务时（`unavailable`）整个区块不出现。 */
export function AccountSection(): JSX.Element {
  const account = useCloudAccount()
  const s = account.state
  return (
    <Show when={s() && s()?.state !== 'unavailable'}>
      <section class="settings-block">
        <h3 class="settings-block-head">账号</h3>
        <div class="setting-rows">
          <Switch>
            <Match when={s()?.state === 'signed_in' && (s() as SignedIn)}>
              {(signed) => (
                <>
                  <Row label="账号">
                    <span>{signed().email}</span>
                  </Row>
                  <Row label="积分余额">
                    <span>
                      {signed().credits === null
                        ? '—'
                        : formatMoney(signed().credits as number, 'CREDIT')}
                    </span>
                  </Row>
                  <Row label="退出登录">
                    <button
                      type="button"
                      class="btn-ghost sm"
                      disabled={account.busy()}
                      onClick={account.logout}
                    >
                      退出
                    </button>
                  </Row>
                </>
              )}
            </Match>
            <Match when={s()?.state === 'pending' && (s() as Pending)}>
              {(pending) => (
                <Row label="登录码">
                  <PendingCode pending={pending()} busy={account.busy()} onOpen={account.login} />
                  <button
                    type="button"
                    class="btn-ghost sm"
                    disabled={account.busy()}
                    onClick={account.logout}
                  >
                    取消
                  </button>
                </Row>
              )}
            </Match>
            <Match when={s()?.state === 'signed_out'}>
              <Row
                label="登录"
                {...(signedOutReason(s() as CloudState)
                  ? { hint: signedOutReason(s() as CloudState) as string }
                  : {})}
              >
                <button
                  type="button"
                  class="btn-primary"
                  disabled={account.busy()}
                  onClick={account.login}
                >
                  登录
                </button>
              </Row>
            </Match>
          </Switch>
          <Show when={account.error()}>{(m) => <p class="pair-hint">{m()}</p>}</Show>
        </div>
      </section>
    </Show>
  )
}
