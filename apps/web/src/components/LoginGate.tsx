import { createSignal, Match, Show, Switch } from 'solid-js'
import { type CloudState, signedOutReason } from '../lib/store/cloud.ts'
import { ensureModelCatalog, modelCatalog, modelCatalogError } from '../lib/store/settings.ts'
import { openSettings } from '../lib/store/ui.ts'
import { PendingCode, useCloudAccount } from './settings/AccountSection.tsx'

/**
 * 首次启动的登录页：配置了云端服务、未登录、且没有任何接口时显示，与 Codex、Claude Code 相同。
 * 「使用自己的 API key」关闭本页并打开模型设置；登录完成后内置模型写入配置，本页随之消失。
 */
export function LoginGate() {
  const account = useCloudAccount()
  const [dismissed, setDismissed] = createSignal(false)
  void ensureModelCatalog()
  const s = account.state
  const noProviders = () =>
    modelCatalog() !== null && !modelCatalogError() && modelCatalog()?.providers.length === 0
  const visible = () =>
    !dismissed() && noProviders() && (s()?.state === 'signed_out' || s()?.state === 'pending')

  return (
    <Show when={visible()}>
      <div class="login-gate">
        <div class="login-gate-card">
          <h1>qywork</h1>
          <Switch>
            <Match
              when={s()?.state === 'pending' && (s() as Extract<CloudState, { state: 'pending' }>)}
            >
              {(pending) => (
                <div class="login-gate-code">
                  <PendingCode pending={pending()} busy={account.busy()} onOpen={account.login} />
                </div>
              )}
            </Match>
            <Match when={s()?.state === 'signed_out'}>
              <Show when={signedOutReason(s() as CloudState)}>
                {(reason) => <p class="pair-hint">{reason()}</p>}
              </Show>
              <button
                type="button"
                class="btn-primary"
                disabled={account.busy()}
                onClick={account.login}
              >
                登录
              </button>
            </Match>
          </Switch>
          <Show when={account.error()}>{(m) => <p class="pair-hint">{m()}</p>}</Show>
          <button
            type="button"
            class="btn-ghost sm"
            onClick={() => {
              setDismissed(true)
              openSettings('models')
            }}
          >
            使用自己的 API key
          </button>
        </div>
      </div>
    </Show>
  )
}
