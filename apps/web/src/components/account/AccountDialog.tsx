import type { CloudRequest, CloudState } from '@qywork/core'
import {
  createEffect,
  createResource,
  createSignal,
  For,
  Match,
  onCleanup,
  Show,
  Switch,
} from 'solid-js'
import { loaded } from '../../lib/resource.ts'
import { compact } from '../../lib/step-view.ts'
import {
  cloudLogout,
  cloudState,
  fetchCloudRequests,
  fetchCloudUsage,
  refreshCloudState,
} from '../../lib/store/cloud.ts'
import { explainApiError, holdOverlay, setAccountOpen } from '../../lib/store/index.ts'
import { IconX } from '../Icons.tsx'
import { LoadState } from '../settings/LoadState.tsx'
import { ActivityGrid } from './ActivityGrid.tsx'
import { formatCredits } from './format.ts'
import { LoginForm } from './LoginForm.tsx'

/** 使用记录每页条数，与服务端 `/api/cloud/requests` 相同：返回不足一页即没有更早的记录。 */
const PAGE = 50

type SignedIn = Extract<CloudState, { state: 'signed_in' }>

const close = () => setAccountOpen(false)

/**
 * 账号弹窗：已登录时显示账号、统计、Token 活动与使用记录，数据全部取自云端；未登录时显示登录表单。
 * 与设置弹窗同为固定尺寸（B9），内容在弹窗内滚动。
 */
export default function AccountDialog() {
  holdOverlay(() => true)
  void refreshCloudState().catch(() => {})

  createEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

  return (
    <>
      <button class="backdrop-close" type="button" aria-label="关闭账号" onClick={close} />
      <div class="sheet-backdrop pass-through">
        <div class="account-dialog" role="dialog" aria-modal="true" aria-label="账号">
          <button class="icon-btn account-close" type="button" aria-label="关闭" onClick={close}>
            <IconX size={15} />
          </button>
          <Switch>
            <Match when={cloudState()?.state === 'signed_in' && (cloudState() as SignedIn)}>
              {(signed) => <AccountView signed={signed()} />}
            </Match>
            <Match when={cloudState()?.state === 'signed_out'}>
              <div class="account-signin">
                <LoginForm />
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </>
  )
}

function AccountView(props: { signed: SignedIn }) {
  const [usage, { refetch }] = createResource(fetchCloudUsage)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)

  const logout = async () => {
    setBusy(true)
    setError(null)
    try {
      await cloudLogout()
    } catch (e) {
      setError(explainApiError(e, '退出失败'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="account-scroll">
      <header class="account-head">
        <span class="account-avatar" aria-hidden="true">
          {(props.signed.email[0] ?? '?').toUpperCase()}
        </span>
        <span class="account-email">{props.signed.email}</span>
        <button type="button" class="btn-ghost sm" disabled={busy()} onClick={logout}>
          退出登录
        </button>
      </header>
      <Show when={error()}>{(m) => <p class="account-error">{m()}</p>}</Show>

      <Show when={loaded(usage)} fallback={<LoadState error={usage.error} onRetry={refetch} />}>
        {(u) => (
          <>
            <dl class="account-stats">
              <div>
                <dt>积分余额</dt>
                <dd>{props.signed.credits === null ? '—' : formatCredits(props.signed.credits)}</dd>
              </div>
              <div>
                <dt>累计消耗积分</dt>
                <dd>{formatCredits(u().credits)}</dd>
              </div>
              <div>
                <dt>累计 Token</dt>
                <dd>
                  {compact(
                    u().inputTokens + u().outputTokens + u().cacheReadTokens + u().cacheWriteTokens,
                  )}
                </dd>
              </div>
              <div>
                <dt>请求次数</dt>
                <dd>{u().requests.toLocaleString()}</dd>
              </div>
            </dl>

            <h3 class="account-section">Token 活动</h3>
            <ActivityGrid days={u().days} />
          </>
        )}
      </Show>

      <h3 class="account-section">使用记录</h3>
      <RequestTable />
    </div>
  )
}

/** 时间写到分钟；跨年的记录带年份。 */
function when(iso: string): string {
  const d = new Date(iso)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  return d.toLocaleString('zh-CN', {
    ...(sameYear ? {} : { year: 'numeric' }),
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/** 逐条请求记录，按时间倒序分页读取。「输入」含缓存命中与缓存写入，与「用量」页同一口径。 */
function RequestTable() {
  const [rows, setRows] = createSignal<CloudRequest[]>([])
  const [done, setDone] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<unknown>(null)

  const more = async () => {
    setLoading(true)
    setError(null)
    try {
      const page = await fetchCloudRequests(rows().at(-1)?.startedAt ?? null)
      setRows((prev) => [...prev, ...page])
      if (page.length < PAGE) setDone(true)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }
  void more()

  return (
    <>
      <Show when={rows().length > 0}>
        <div class="usage-scroll">
          <table class="usage-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>型号</th>
                <th class="num">输入</th>
                <th class="num">输出</th>
                <th class="num">命中</th>
                <th class="num">积分</th>
                <th>结果</th>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(r) => (
                  <tr>
                    <td>{when(r.startedAt)}</td>
                    <td>{r.modelId}</td>
                    <td class="num">
                      {compact(r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens)}
                    </td>
                    <td class="num">{compact(r.outputTokens)}</td>
                    <td class="num">{compact(r.cacheReadTokens)}</td>
                    <td class="num">{formatCredits(r.credits)}</td>
                    <td classList={{ 'account-failed': r.failure !== null }}>
                      {r.failure ?? '完成'}
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      </Show>
      <Show when={error()}>{(e) => <LoadState error={e()} onRetry={() => void more()} />}</Show>
      <Show when={!done() && !error() && rows().length > 0}>
        <button type="button" class="btn-ghost sm account-more" disabled={loading()} onClick={more}>
          加载更早的记录
        </button>
      </Show>
    </>
  )
}
