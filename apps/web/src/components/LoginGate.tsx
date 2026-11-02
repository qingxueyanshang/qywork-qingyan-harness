import { createSignal, Show } from 'solid-js'
import { cloudState } from '../lib/store/cloud.ts'
import { ensureModelCatalog, modelCatalog, modelCatalogError } from '../lib/store/settings.ts'
import { openSettings } from '../lib/store/ui.ts'
import { LoginForm } from './account/LoginForm.tsx'

/**
 * 首次启动的登录页：配置了云端服务、未登录、且没有任何接口时显示，与 Codex、Claude Code 相同。
 * 「使用自己的 API key」关闭本页并打开模型设置；登录完成后内置模型写入配置，本页随之消失。
 */
export function LoginGate() {
  const [dismissed, setDismissed] = createSignal(false)
  void ensureModelCatalog()
  const noProviders = () =>
    modelCatalog() !== null && !modelCatalogError() && modelCatalog()?.providers.length === 0
  const visible = () => !dismissed() && noProviders() && cloudState()?.state === 'signed_out'

  return (
    <Show when={visible()}>
      <div class="login-gate">
        <div class="login-gate-card">
          <h1>qywork</h1>
          <LoginForm />
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
