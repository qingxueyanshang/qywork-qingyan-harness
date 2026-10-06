import { createResource, createSignal, For, Show } from 'solid-js'
import { loaded } from '../lib/resource.ts'
import { sessionSignal } from '../lib/session.ts'
import { client, explainApiError } from '../lib/store/index.ts'

interface Candidate {
  name: string
  address: string
  url: string
  qr: string
}
interface PairingInfo {
  url: string
  token: string
  deviceName: string
  qr: string
  lanEnabled: boolean
  candidates: Candidate[]
}

/**
 * 手机接入。
 *
 * 默认服务只绑定 127.0.0.1；打开开关后才追加 0.0.0.0 监听。该开关必须显式开启：
 * 一启动就把工作区暴露在整个 Wi-Fi 网络中不是合理的默认行为，即使有令牌。
 *
 * 候选地址全部列出并各配一个二维码：在安装了 VPN / Hyper-V / Docker 的机器上
 * 自动判断没有可靠结果（实测会选中 VPN 隧道或虚拟交换机），扫码无法连通时必须能一键更换地址。
 *
 * 它是「通用」页中的一节（配对改变的是本应用的访问方式，不是 agent 的能力模块），
 * 小标题由该页提供，此处只输出内容。
 */
export default function PairPanel() {
  // 「通用」页打开即渲染，本次请求随之发出。不加「打开后才请求」的条件：
  // `/api/pairing` 只读取本机网卡与令牌，与同一页上的配置、能力两次请求开销相当。
  const [info, { refetch }] = createResource(() => client.api<PairingInfo>('/api/pairing'))
  const [picked, setPicked] = sessionSignal('qywork.settings.pair.picked', 0)
  const [busy, setBusy] = createSignal(false)

  const toggleLan = async (enabled: boolean) => {
    setBusy(true)
    try {
      await client.api('/api/pairing/lan', {
        method: 'POST',
        body: JSON.stringify({ enabled }),
      })
      await refetch()
    } finally {
      setBusy(false)
    }
  }

  // 使用 `loaded()` 而不是 `info()`：后者出错时会 `throw`，未被捕获时整块区域停留在加载状态。
  return (
    <Show
      when={loaded(info)}
      fallback={
        <Show when={info.error} fallback={<div class="preview-loading" />}>
          {(e) => <p class="pair-hint">{explainApiError(e(), '无法读取接入信息')}</p>}
        </Show>
      }
    >
      {(d) => (
        <div class="pair-body">
          <label class="pair-toggle">
            <input
              type="checkbox"
              checked={d().lanEnabled}
              disabled={busy()}
              onChange={(e) => void toggleLan(e.currentTarget.checked)}
            />
            <span>允许同一网络的设备接入</span>
          </label>

          <Show when={d().lanEnabled} fallback={<p class="pair-hint">开启后可使用手机扫码</p>}>
            <Qr text={d().candidates[picked()]?.qr ?? d().qr} />

            <Show when={d().candidates.length > 1}>
              <div class="pair-addrs">
                <For each={d().candidates}>
                  {(c, i) => (
                    <button
                      class="pair-addr"
                      classList={{ active: picked() === i() }}
                      type="button"
                      onClick={() => setPicked(i())}
                    >
                      <code>{c.address}</code>
                      <span class="truncate">{c.name}</span>
                    </button>
                  )}
                </For>
              </div>
            </Show>

            <p class="pair-hint">若扫描无法接通，请更换其他地址</p>
          </Show>
        </div>
      )}
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
  // 更换地址时 `loaded()` 返回上一张二维码，二维码区域尺寸不变。
  return (
    <div class="pair-qr">
      <Show when={loaded(svg)} fallback={<div class="preview-loading" />}>
        {(s) => <div innerHTML={s()} />}
      </Show>
    </div>
  )
}
