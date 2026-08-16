import { createResource, createSignal, For, Show } from 'solid-js'
import { client } from '../lib/store/index.ts'

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
 * 默认服务只绑 127.0.0.1；开关打开才追加 0.0.0.0 监听。这个开关必须是显式的——
 * 一启动就把工作区暴露在整个 Wi-Fi 上不是合理默认，即使有令牌。
 *
 * 候选地址全部列出并各配一个二维码：自动判断在装了 VPN / Hyper-V / Docker 的
 * 机器上没有可靠解（实测会选中 VPN 隧道或虚拟交换机），扫不通要能一键换一个。
 *
 * 它是「通用」页里的一节（配对改的是这个应用怎么被访问，不是 agent 的能力模块），
 * 小标题由那一页给，这里只出内容。
 */
export default function PairPanel() {
  // 「通用」一打开就渲染，这一趟请求跟着发。不加「开着才拉」的门闩：
  // `/api/pairing` 只读本机网卡与令牌，和同一页上的配置、能力两趟请求同量级。
  const [info, { refetch }] = createResource(() => client.api<PairingInfo>('/api/pairing'))
  const [picked, setPicked] = createSignal(0)
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

  return (
    <Show when={info()} fallback={<div class="preview-loading" />}>
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

          <Show when={d().lanEnabled} fallback={<p class="pair-hint">开启后才能用手机扫码</p>}>
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

            <p class="pair-hint">扫不通就换一个地址</p>
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
      // 编码器动态引入：约 28 kB，只有真的要出码时才值得下载。
      const { default: QRCode } = await import('qrcode')
      // 生成 SVG 而不是 canvas：矢量在任何 DPI 下都清晰，
      // 而手机摄像头对着高分屏拍模糊的二维码是扫码失败的常见原因。
      return QRCode.toString(text, {
        type: 'svg',
        errorCorrectionLevel: 'M',
        margin: 1,
        width: 220,
      }).catch(() => '')
    },
  )
  return (
    <div class="pair-qr">
      <Show when={svg()} fallback={<div class="preview-loading" />}>
        <div innerHTML={svg()!} />
      </Show>
    </div>
  )
}
