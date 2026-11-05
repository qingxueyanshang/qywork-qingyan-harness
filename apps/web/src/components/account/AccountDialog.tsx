import {
  type CloudModel,
  type CloudRequest,
  type CloudState,
  MEDIA_OUTPUTS,
  type MediaOutput,
  type MediaUnit,
  type UnitPrice,
} from '@qywork/core'
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
  announcements,
  announcementsUnread,
  openAnnouncements,
} from '../../lib/store/announcements.ts'
import {
  cloudLogout,
  cloudState,
  fetchCloudModels,
  fetchCloudRequests,
  fetchCloudUsage,
  refreshCloudState,
  setCloudAvatar,
} from '../../lib/store/cloud.ts'
import {
  explainApiError,
  holdOverlay,
  openLinkInPanel,
  setAccountOpen,
} from '../../lib/store/index.ts'
import { IconBell, IconHome, IconLogOut, IconX } from '../Icons.tsx'
import PairPanel from '../PairPanel.tsx'
import { config, configBusy, ensureConfig, replaceConfig } from '../settings/configStore.ts'
import { DefaultToggle, withoutActive, withoutMediaDefault } from '../settings/DefaultToggle.tsx'
import { LoadState, Skeleton } from '../settings/LoadState.tsx'
import { ActivityGrid } from './ActivityGrid.tsx'
import { AccountAvatar, squareAvatar } from './Avatar.tsx'
import { formatCredits, formatRatio } from './format.ts'
import { LoginForm } from './LoginForm.tsx'
import RechargeDialog from './RechargeDialog.tsx'

/** 使用记录每页条数，与服务端 `/api/cloud/requests` 相同：返回不足一页即没有更早的记录。 */
const PAGE = 50

type SignedIn = Extract<CloudState, { state: 'signed_in' }>

const close = () => setAccountOpen(false)

/**
 * 账号弹窗：已登录时显示账号、充值入口、统计、Token 活动与使用记录，数据全部取自云端；未登录时显示登录表单。
 * 两种状态各为固定尺寸（B9），内容在弹窗内滚动。未登录时是窄的登录框（`.signin`）：尺寸只在登录成功、
 * 内容整体换成账号页时改变一次，此时登录表单的按钮已不存在，不会移动用户正在瞄准的目标。
 */
export default function AccountDialog() {
  holdOverlay(() => true)
  void refreshCloudState().catch(() => {})

  createEffect(() => {
    // 上层有打开的窗口（公告、充值，均为模态 `<dialog>`）时，Escape 由该窗口的 cancel 事件关闭，本窗口保留。
    // 不能依靠上层窗口在 keydown 中阻止冒泡：焦点所在的按钮被禁用后焦点落到 body，keydown 不经过上层窗口。
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) {
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
        <div
          class="account-dialog"
          classList={{ signin: cloudState()?.state === 'signed_out' }}
          role="dialog"
          aria-modal="true"
          aria-label="账号"
        >
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
  const [recharging, setRecharging] = createSignal(false)

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

  const pickAvatar = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    setBusy(true)
    setError(null)
    try {
      await setCloudAvatar(await squareAvatar(file))
    } catch (e) {
      setError(explainApiError(e, '无法更换头像'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <header class="account-head">
        <label class="account-avatar-edit" data-tip="更换头像">
          <AccountAvatar email={props.signed.email} avatar={props.signed.avatar} />
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label="更换头像"
            hidden
            disabled={busy()}
            onChange={(e) => void pickAvatar(e.currentTarget)}
          />
        </label>
        <span class="account-email">{props.signed.email}</span>
        <div class="account-actions">
          {/* 公告窗口打开在本窗口之上；最新一条未读时带圆点，侧栏的账号入口同时带圆点。 */}
          <Show when={announcements().length > 0}>
            <button
              type="button"
              class="icon-btn account-bell"
              aria-label="公告"
              aria-haspopup="dialog"
              data-tip="公告"
              onClick={openAnnouncements}
            >
              <IconBell size={16} stroke={1.8} />
              <Show when={announcementsUnread()}>
                <span class="account-bell-dot" role="img" aria-label="有新公告" />
              </Show>
            </button>
          </Show>
          {/* 官网在右侧面板打开，同时关闭本窗口，否则窗口遮住面板。 */}
          <button
            type="button"
            class="icon-btn"
            aria-label="打开官网"
            data-tip="打开官网"
            onClick={() => {
              openLinkInPanel(`${props.signed.origin}/`)
              close()
            }}
          >
            <IconHome size={16} stroke={1.8} />
          </button>
          <button
            type="button"
            class="icon-btn"
            aria-label="退出登录"
            data-tip="退出登录"
            disabled={busy()}
            onClick={logout}
          >
            <IconLogOut size={16} stroke={1.8} />
          </button>
        </div>
        {/* 云端未开通充值时不显示（B5）。 */}
        <Show when={props.signed.recharge}>
          <button
            type="button"
            class="btn-primary account-recharge"
            aria-haspopup="dialog"
            onClick={() => setRecharging(true)}
          >
            充值
          </button>
        </Show>
      </header>
      <Show when={recharging()}>
        <RechargeDialog onClose={() => setRecharging(false)} />
      </Show>
      {/* 头部在滚动区外：滚动条从头部下方开始，不经过关闭按钮。 */}
      <div class="account-scroll">
        <Show when={error()}>{(m) => <p class="account-error">{m()}</p>}</Show>

        <Show
          when={loaded(usage)}
          fallback={<LoadState error={usage.error} onRetry={refetch} lines={6} />}
        >
          {(u) => (
            <>
              <dl class="account-stats">
                <div>
                  <dt>积分余额</dt>
                  <dd>
                    {props.signed.credits === null ? '—' : formatCredits(props.signed.credits)}
                  </dd>
                </div>
                <div>
                  <dt>累计消耗积分</dt>
                  <dd>{formatCredits(u().credits)}</dd>
                </div>
                <div>
                  <dt>累计 Token</dt>
                  <dd>
                    {compact(
                      u().inputTokens +
                        u().outputTokens +
                        u().cacheReadTokens +
                        u().cacheWriteTokens,
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

        <PairPanel />

        <h3 class="account-section">
          对话<span class="account-unit">积分 / 百万 token</span>
        </h3>
        <ModelTable provider={props.signed.provider} />

        <h3 class="account-section">使用记录</h3>
        <RequestTable />
      </div>
    </>
  )
}

/** 云端当前提供的型号、倍率与单价，每次打开弹窗时读取。 */
/** 生成型号的类别标题与计费单位的名称。 */
const MEDIA_SECTION: Record<MediaOutput, string> = { image: '图像', video: '视频', audio: '音频' }
const UNIT_LABEL: Record<MediaUnit, string> = {
  image: '每张',
  second: '每秒',
  request: '每次',
  '10k_chars': '每万字符',
}

/** 生成型号的单价：一个数，或逐档「档位 单价」。 */
function unitPriceText(p: UnitPrice): string {
  if (typeof p === 'number') return formatCredits(p)
  return Object.entries(p)
    .map(([tier, credits]) => `${tier} ${formatCredits(credits)}`)
    .join(' · ')
}

/**
 * 云端生成型号，按类别各一张表。「设为默认」写入该类别的默认生成模型，与模型设置页写入同一处。
 * 没有生成型号的类别不显示。
 */
function MediaTables(props: {
  provider: string
  models: readonly Extract<CloudModel, { output: MediaOutput }>[]
}) {
  const isDefault = (output: MediaOutput, id: string) => {
    const ref = config()?.mediaDefaults?.[output]
    return ref?.provider === props.provider && ref.model === id
  }
  const listed = (id: string) => Boolean(config()?.providers[props.provider]?.media?.[id])
  return (
    <For each={MEDIA_OUTPUTS.filter((o) => props.models.some((m) => m.output === o))}>
      {(output) => (
        <>
          <h3 class="account-section">
            {MEDIA_SECTION[output]}
            <span class="account-unit">积分</span>
          </h3>
          <section class="lib-card">
            <div class="lib-scroll">
              <table class="lib-table account-table">
                <thead>
                  <tr>
                    <th>型号</th>
                    <th>计费单位</th>
                    <th class="num">单价</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <For each={props.models.filter((m) => m.output === output)}>
                    {(m) => (
                      <tr>
                        <td>
                          <code class="lib-id">{m.id}</code>
                        </td>
                        <td>{UNIT_LABEL[m.unit]}</td>
                        <td class="num">{unitPriceText(m.unitPrice)}</td>
                        <td class="account-default">
                          <DefaultToggle
                            on={isDefault(output, m.id)}
                            disabled={!listed(m.id) || configBusy()}
                            onSet={() =>
                              void replaceConfig((cur) => ({
                                ...cur,
                                mediaDefaults: {
                                  ...cur.mediaDefaults,
                                  [output]: { provider: props.provider, model: m.id },
                                },
                              }))
                            }
                            onUnset={() =>
                              void replaceConfig((cur) => withoutMediaDefault(cur, output))
                            }
                          />
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </For>
  )
}

function ModelTable(props: { provider: string }) {
  const [models, { refetch }] = createResource(fetchCloudModels)
  ensureConfig()
  // 默认值与模型设置页写入同一处（配置的默认对话模型）；云端接口不在模型设置页列出，两处不会同时显示同一型号。
  const isDefault = (id: string) =>
    config()?.active?.provider === props.provider && config()?.active?.model === id
  const listed = (id: string) => Boolean(config()?.providers[props.provider]?.models[id])
  return (
    <Show
      when={loaded(models)}
      fallback={<LoadState error={models.error} onRetry={refetch} lines={4} />}
    >
      {(all) => {
        const list = () => all().flatMap((m) => (m.output === 'chat' ? [m] : []))
        const media = () => all().flatMap((m) => (m.output === 'chat' ? [] : [m]))
        return (
          <>
            <section class="lib-card">
              <div class="lib-scroll">
                <table class="lib-table account-table">
                  <thead>
                    <tr>
                      <th>型号</th>
                      <th class="num">倍率（官方价）</th>
                      <th class="num">输入</th>
                      <th class="num">输出</th>
                      <th class="num">缓存读取</th>
                      <th class="num">缓存写入</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    <For each={list()}>
                      {(m) => (
                        <tr>
                          <td>
                            <code class="lib-id">{m.id}</code>
                          </td>
                          {/* 按单价计价的型号没有官方价，单价列即最终单价。 */}
                          <td class="num">{m.official ? formatRatio(m.ratio) : '—'}</td>
                          <td class="num">{m.price ? formatCredits(m.price.input) : '—'}</td>
                          <td class="num">{m.price ? formatCredits(m.price.output) : '—'}</td>
                          <td class="num">{m.price ? formatCredits(m.price.cacheRead) : '—'}</td>
                          <td class="num">{m.price ? formatCredits(m.price.cacheWrite) : '—'}</td>
                          <td class="account-default">
                            <DefaultToggle
                              on={isDefault(m.id)}
                              disabled={!listed(m.id) || configBusy()}
                              onSet={() =>
                                void replaceConfig((cur) => ({
                                  ...cur,
                                  active: { provider: props.provider, model: m.id },
                                }))
                              }
                              onUnset={() => void replaceConfig(withoutActive)}
                            />
                          </td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </div>
            </section>
            <MediaTables provider={props.provider} models={media()} />
          </>
        )
      }}
    </Show>
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

/** 本次请求偏离基础档的计价条件，由云端结算时与扣费同一次判定写入。 */
function priceTerms(r: CloudRequest): string[] {
  return [
    ...(r.longContext ? ['长上下文'] : []),
    ...(r.offPeak ? ['空闲时段'] : []),
    ...(r.cacheWrite1hTokens > 0 ? ['1 小时缓存'] : []),
  ]
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
      <Show when={rows().length === 0 && loading()}>
        <Skeleton lines={4} />
      </Show>
      <Show when={rows().length > 0}>
        <section class="lib-card">
          <div class="lib-scroll">
            <table class="lib-table account-table">
              <thead>
                <tr>
                  <th>时间</th>
                  <th>型号</th>
                  <th class="num">输入</th>
                  <th class="num">输出</th>
                  <th class="num">缓存读取</th>
                  <th class="num">积分</th>
                  <th>结果</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows()}>
                  {(r) => (
                    <tr>
                      <td>{when(r.startedAt)}</td>
                      <td>
                        <code class="lib-id">{r.modelId}</code>
                      </td>
                      <td class="num">
                        {compact(r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens)}
                      </td>
                      <td class="num">{compact(r.outputTokens)}</td>
                      <td class="num">{compact(r.cacheReadTokens)}</td>
                      <td class="num">
                        <For each={priceTerms(r)}>
                          {(t) => <span class="account-term">{t}</span>}
                        </For>
                        {formatCredits(r.credits)}
                      </td>
                      <td classList={{ 'account-failed': r.failure !== null }}>
                        {r.failure ?? '完成'}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        </section>
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
