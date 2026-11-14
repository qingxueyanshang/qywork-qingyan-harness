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
  setCloudName,
} from '../../lib/store/cloud.ts'
import {
  ensureModelCatalog,
  explainApiError,
  holdOverlay,
  modelCatalog,
  openLinkInPanel,
  setAccountOpen,
} from '../../lib/store/index.ts'
import { IconBell, IconHome, IconLogOut, IconX } from '../Icons.tsx'
import PairPanel from '../PairPanel.tsx'
import { config, configBusy, ensureConfig, replaceConfig } from '../settings/configStore.ts'
import { DefaultToggle, withoutActive, withoutMediaDefault } from '../settings/DefaultToggle.tsx'
import { LoadState, Skeleton } from '../settings/LoadState.tsx'
import { referenceLimits } from '../settings/pulled.ts'
import { ActivityGrid } from './ActivityGrid.tsx'
import { AccountAvatar, squareAvatar } from './Avatar.tsx'
import { durationRange, formatCredits, formatRatio, formatUnitPrice } from './format.ts'
import { LoginForm } from './LoginForm.tsx'
import { NameEdit } from './NameEdit.tsx'
import RechargeDialog from './RechargeDialog.tsx'

/** 使用记录每页条数，与服务端 `/api/cloud/requests` 相同：返回不足一页即没有更早的记录。 */
const PAGE = 50

/** 读取失败后自动重新读取的间隔。 */
const RETRY_MS = 3000

type SignedIn = Extract<CloudState, { state: 'signed_in' }>

const close = () => setAccountOpen(false)

/**
 * 账号弹窗：已登录时显示账号（头像、可修改的用户名、邮箱）、充值入口、统计、Token 活动与使用记录，数据全部取自云端；未登录时显示登录表单。
 * 两种状态各为固定尺寸（B9），内容在弹窗内滚动。未登录时是窄的登录框（`.signin`）：尺寸只在登录成功、
 * 内容整体换成账号页时改变一次，此时登录表单的按钮已不存在，不会移动用户正在瞄准的目标。
 */
export default function AccountDialog(props: { retryMs?: number }) {
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
              {(signed) => <AccountView signed={signed()} retryMs={props.retryMs ?? RETRY_MS} />}
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

function AccountView(props: { signed: SignedIn; retryMs: number }) {
  const [usage, { refetch: refetchUsage }] = createResource(fetchCloudUsage)
  const [models, { refetch: refetchModels }] = createResource(fetchCloudModels)
  const requests = createRequestPages()
  ensureConfig()
  void ensureModelCatalog()
  // 三项读取经同一个云端服务，失败原因相同：只显示一处原因与一个重试，读取失败的各节不显示。
  // 已有记录时续页的失败不计入：它显示在使用记录表的下方。
  const requestsFailed = () => (requests.rows().length === 0 ? requests.error() : null)
  const failure = () => usage.error ?? models.error ?? requestsFailed()
  const retrying = () => usage.loading || models.loading || requests.loading()
  // 读取失败时账号状态同样未取得（余额未知、充值入口不显示），重试时一并重新读取。
  const retry = () => {
    if (retrying()) return
    void refreshCloudState().catch(() => {})
    if (usage.error) void refetchUsage()
    if (models.error) void refetchModels()
    if (requestsFailed()) void requests.more()
  }
  // 读取失败后每隔 `retryMs` 自动重新读取，直到成功或窗口关闭：到云端的新建连接会在数十秒的时段内
  // 连续被断开，时段结束后读取即可成功，不需要用户操作。
  createEffect(() => {
    if (!failure() || retrying()) return
    const timer = setTimeout(retry, props.retryMs)
    onCleanup(() => clearTimeout(timer))
  })
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

  const rename = async (name: string) => {
    setBusy(true)
    setError(null)
    try {
      await setCloudName(name)
    } catch (e) {
      setError(explainApiError(e, '无法修改用户名'))
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
          <AccountAvatar
            label={props.signed.name || props.signed.email}
            avatar={props.signed.avatar}
          />
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            aria-label="更换头像"
            hidden
            disabled={busy()}
            onChange={(e) => void pickAvatar(e.currentTarget)}
          />
        </label>
        <div class="account-id">
          <NameEdit name={props.signed.name} onSave={(name) => void rename(name)} />
          <span class="account-email">{props.signed.email}</span>
        </div>
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

        <Show when={failure()}>{(e) => <LoadState error={e()} onRetry={retry} />}</Show>

        <Show
          when={loaded(usage)}
          fallback={
            <Show when={!usage.error}>
              <Skeleton lines={6} />
            </Show>
          }
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

        <Show when={!models.error}>
          <h3 class="account-section">
            对话<span class="account-unit">积分 / 百万 token</span>
          </h3>
          <Show when={loaded(models)} fallback={<Skeleton lines={4} />}>
            {(all) => <ModelTable provider={props.signed.provider} models={all()} />}
          </Show>
        </Show>

        <Show when={!requestsFailed()}>
          <h3 class="account-section">使用记录</h3>
          <RequestTable provider={props.signed.provider} pages={requests} />
        </Show>
      </div>
    </>
  )
}

/**
 * 云端型号在界面上的名称：取模型目录（`modelCatalog`）中该接口下的显示名称，与输入框的模型选择相同；
 * 目录中没有时（尚未同步到本机配置、或已下架）为型号本身。
 */
function modelName(provider: string, id: string): string {
  const catalog = modelCatalog()
  return (
    catalog?.providers.find((p) => p.name === provider)?.models.find((m) => m.id === id)?.label ??
    catalog?.media.find((m) => m.provider === provider && m.id === id)?.label ??
    id
  )
}

/**
 * 生成模型的参数摘要：时长范围与参考素材上限，写法与拉取模型对话框相同，如「5–30秒 · 图≤30、视频≤10、音频≤10」。
 * 取自模型目录中该型号的规格；目录中没有该型号或没有可列出的参数时为「—」。
 */
function mediaParams(provider: string, id: string): string {
  const m = modelCatalog()?.media.find((x) => x.provider === provider && x.id === id)
  if (!m) return '—'
  return [durationRange(m.params), referenceLimits(m)].filter(Boolean).join(' · ') || '—'
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

/** 计量单位的名称：「30 秒」「2 张」「0.12 万字符」。 */
const METER_UNIT: Record<MediaUnit, string> = {
  image: '张',
  second: '秒',
  request: '次',
  '10k_chars': '万字符',
}

/** 生成任务的计量：数量、单位，按分辨率计价时带档位。 */
function meterText(m: NonNullable<CloudRequest['mediaMeter']>): string {
  const units = Number.isInteger(m.units) ? String(m.units) : String(Number(m.units.toFixed(4)))
  return `${units} ${METER_UNIT[m.unit]}${m.resolution ? ` · ${m.resolution}` : ''}`
}

/** 生成型号的单价：一个数，或逐档「档位 单价」。 */
function unitPriceText(p: UnitPrice): string {
  if (typeof p === 'number') return formatUnitPrice(p)
  return Object.entries(p)
    .map(([tier, credits]) => `${tier} ${formatUnitPrice(credits)}`)
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
                    <th>模型</th>
                    <th>参数</th>
                    <th>计费单位</th>
                    <th class="num">单价</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  <For each={props.models.filter((m) => m.output === output)}>
                    {(m) => (
                      <tr>
                        <td>{modelName(props.provider, m.id)}</td>
                        <td>{mediaParams(props.provider, m.id)}</td>
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

function ModelTable(props: { provider: string; models: readonly CloudModel[] }) {
  // 默认值与模型设置页写入同一处（配置的默认对话模型）；云端接口不在模型设置页列出，两处不会同时显示同一型号。
  const isDefault = (id: string) =>
    config()?.active?.provider === props.provider && config()?.active?.model === id
  const listed = (id: string) => Boolean(config()?.providers[props.provider]?.models[id])
  const list = () => props.models.flatMap((m) => (m.output === 'chat' ? [m] : []))
  const media = () => props.models.flatMap((m) => (m.output === 'chat' ? [] : [m]))
  return (
    <>
      <section class="lib-card">
        <div class="lib-scroll">
          <table class="lib-table account-table">
            <thead>
              <tr>
                <th>模型</th>
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
                    <td>{modelName(props.provider, m.id)}</td>
                    {/* 按单价计价的型号没有官方价，单价列即最终单价。 */}
                    <td class="num">{m.official ? formatRatio(m.ratio) : '—'}</td>
                    <td class="num">{m.price ? formatUnitPrice(m.price.input) : '—'}</td>
                    <td class="num">{m.price ? formatUnitPrice(m.price.output) : '—'}</td>
                    <td class="num">{m.price ? formatUnitPrice(m.price.cacheRead) : '—'}</td>
                    <td class="num">{m.price ? formatUnitPrice(m.price.cacheWrite) : '—'}</td>
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
}

/** 云端记录的显示时区：与云端网页的账号页相同，不随电脑的时区设置变化。 */
const BEIJING = 'Asia/Shanghai'
const beijingYear = (d: Date) => d.toLocaleString('en-US', { timeZone: BEIJING, year: 'numeric' })

/** 北京时间，写到分钟；跨年的记录带年份。 */
function when(iso: string): string {
  const d = new Date(iso)
  const sameYear = beijingYear(d) === beijingYear(new Date())
  return d.toLocaleString('zh-CN', {
    timeZone: BEIJING,
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

/**
 * 使用记录的分页读取，按时间倒序；创建时读取第一页。
 * `error` 保留到下一次读取完成：重试期间原因仍显示，与 `createResource` 的 `error` 相同。
 */
function createRequestPages() {
  const [rows, setRows] = createSignal<CloudRequest[]>([])
  const [done, setDone] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [error, setError] = createSignal<unknown>(null)

  const more = async () => {
    setLoading(true)
    try {
      const page = await fetchCloudRequests(rows().at(-1)?.startedAt ?? null)
      setRows((prev) => [...prev, ...page])
      if (page.length < PAGE) setDone(true)
      setError(null)
    } catch (e) {
      setError(e)
    } finally {
      setLoading(false)
    }
  }
  void more()
  return { rows, done, loading, error, more }
}

/** 逐条请求记录。「输入」含缓存命中与缓存写入，与「用量」页同一口径。 */
function RequestTable(props: { provider: string; pages: ReturnType<typeof createRequestPages> }) {
  const { rows, done, loading, error, more } = props.pages

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
                  <th>模型</th>
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
                      <td>{r.modelId === null ? '—' : modelName(props.provider, r.modelId)}</td>
                      {/* 生成任务没有 token，三列合为一格显示计量。 */}
                      <Show
                        when={r.mediaMeter}
                        fallback={
                          <>
                            <td class="num">
                              {compact(r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens)}
                            </td>
                            <td class="num">{compact(r.outputTokens)}</td>
                            <td class="num">{compact(r.cacheReadTokens)}</td>
                          </>
                        }
                      >
                        {(m) => <td colSpan={3}>{meterText(m())}</td>}
                      </Show>
                      <td class="num">
                        {formatCredits(r.credits)}
                        <For each={priceTerms(r)}>
                          {(t) => <span class="account-term">{t}</span>}
                        </For>
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
      <Show when={rows().length > 0 && error()}>
        {(e) => <LoadState error={e()} onRetry={() => void more()} busy={loading()} />}
      </Show>
      <Show when={!done() && !error() && rows().length > 0}>
        <button
          type="button"
          class="history-button account-more"
          disabled={loading()}
          onClick={more}
        >
          加载更早记录
        </button>
      </Show>
    </>
  )
}
