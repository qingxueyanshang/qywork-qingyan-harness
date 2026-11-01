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
  | { state: 'online'; deviceUrl: string }
  | { state: 'offline'; message: string }
  | { state: 'outdated' }
  | { state: 'revoked' }

export interface RemoteInfo {
  /** 已登录云端账号；未登录时没有远程访问的路径，本节不出现。 */
  available: boolean
  enabled: boolean
  tunnel: TunnelStatus | null
}

/** 连接中与重连期间读取状态的间隔。 */
const POLL_MS = 2000

const onlineUrl = (t: TunnelStatus | null) => (t?.state === 'online' ? t.deviceUrl : null)
const offlineMessage = (t: TunnelStatus | null) => (t?.state === 'offline' ? t.message : null)

/**
 * 手机接入：经云端远程访问本机。
 *
 * 二维码是 console 中本设备的地址，不含令牌：手机扫码后登录同一账号才能打开本设备。
 * 它是「通用」页中的一节（改变的是本应用的访问方式，不是 agent 的能力模块），整节由本组件输出，
 * 未登录时不出现。
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

  // 使用 `loaded()` 而不是 `info()`：后者出错时会 `throw`，获取期间会挂起设置内容区的 Suspense。
  return (
    <Show when={loaded(info)?.available || info.error}>
      <section class="settings-block">
        <h3 class="settings-block-head">手机接入</h3>
        <Show
          when={loaded(info)}
          fallback={<p class="pair-hint">{explainApiError(info.error, '无法读取接入信息')}</p>}
        >
          {(d) => (
            <div class="pair-body">
              <label class="pair-toggle">
                <input
                  type="checkbox"
                  checked={d().enabled}
                  disabled={busy()}
                  onChange={(e) => void toggle(e.currentTarget)}
                />
                <span>允许远程访问</span>
              </label>
              <Show when={toggleError()}>{(m) => <p class="pair-hint">{m()}</p>}</Show>
              <Switch>
                <Match when={onlineUrl(d().tunnel)}>{(url) => <Qr text={url()} />}</Match>
                <Match when={d().tunnel?.state === 'connecting'}>
                  <div class="preview-loading" />
                </Match>
                <Match when={offlineMessage(d().tunnel)}>
                  {(m) => <p class="pair-hint">{m()}</p>}
                </Match>
                <Match when={d().tunnel?.state === 'outdated'}>
                  <p class="pair-hint">需要更新应用</p>
                </Match>
              </Switch>
            </div>
          )}
        </Show>
      </section>
    </Show>
  )
}

function Qr(props: { text: string }) {
  const [svg] = createResource(
    () => props.text,
    async (text) => {
      // 编码器动态导入：约 28 kB，只在需要生成二维码时下载。
      const { default: QRCode } = await import('qrcode')
      // 生成 SVG 而不是 canvas：矢量图在任何 DPI 下都清晰，
      // 而高分屏上模糊的二维码是手机摄像头扫码失败的常见原因。
      return QRCode.toString(text, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 220,
      }).catch(() => '')
    },
  )
  // 使用 `loaded()`，不要改为 `svg()`：后者在获取数据期间会进入设置内容区的 Suspense，
  // 整页内容被移出 DOM，滚动容器高度归零，重新挂载后 `scrollTop` 停在 0。
  return (
    <div class="pair-qr">
      <Show when={loaded(svg)} fallback={<div class="preview-loading" />}>
        {(s) => <div innerHTML={s()} />}
      </Show>
    </div>
  )
}
