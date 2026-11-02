import { createSignal, Show } from 'solid-js'
import { cloudSignIn, cloudState, signedOutReason } from '../../lib/store/cloud.ts'

/**
 * 邮箱密码的登录与注册表单。账号弹窗与首次启动的登录页共用。
 * 两种方式字段相同，切换时表单高度不变（B9）；失败原因显示在按钮下方的固定高度行中。
 */
export function LoginForm() {
  const [mode, setMode] = createSignal<'login' | 'register'>('login')
  const [email, setEmail] = createSignal('')
  const [password, setPassword] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const submit = async (e: SubmitEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await cloudSignIn(mode(), email().trim(), password())
      setPassword('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const pick = (next: 'login' | 'register') => {
    setMode(next)
    setError(null)
  }

  return (
    <form class="account-form" onSubmit={submit}>
      <div class="seg account-form-mode" role="tablist">
        <button
          type="button"
          class="seg-item"
          classList={{ active: mode() === 'login' }}
          role="tab"
          aria-selected={mode() === 'login'}
          onClick={() => pick('login')}
        >
          登录
        </button>
        <button
          type="button"
          class="seg-item"
          classList={{ active: mode() === 'register' }}
          role="tab"
          aria-selected={mode() === 'register'}
          onClick={() => pick('register')}
        >
          注册
        </button>
      </div>
      <label class="account-field">
        <span class="account-label">邮箱</span>
        <input
          class="account-input"
          type="email"
          autocomplete="email"
          required
          value={email()}
          onInput={(e) => setEmail(e.currentTarget.value)}
        />
      </label>
      <label class="account-field">
        <span class="account-label">密码</span>
        <input
          class="account-input"
          type="password"
          autocomplete={mode() === 'login' ? 'current-password' : 'new-password'}
          required
          value={password()}
          onInput={(e) => setPassword(e.currentTarget.value)}
        />
      </label>
      <button type="submit" class="btn-primary account-submit" disabled={busy()}>
        {mode() === 'login' ? '登录' : '注册'}
      </button>
      <p class="account-form-error" role="alert">
        <Show when={error() ?? signedOutReason(cloudState())}>{(m) => m()}</Show>
      </p>
    </form>
  )
}
