import { createEffect, createResource, createSignal, For, onCleanup, Show } from 'solid-js'
import { client, pairOpen, setPairOpen } from '../lib/store/index.ts'
import { IconShield, IconX } from './Icons.tsx'

interface Candidate {
  name: string
  address: string
  url: string
  qr: string
}
interface PairingInfo {
  url: string
  token: string
  expiresAt: number
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
 */
export default function PairSheet() {
  const [info, { refetch }] = createResource(
    () => (pairOpen() ? 1 : null),
    () => client.api<PairingInfo>('/api/pairing'),
  )
  const [picked, setPicked] = createSignal(0)
  const [busy, setBusy] = createSignal(false)

  // Esc 关闭。之前只有点遮罩一条路——一个只能用鼠标关掉的模态框，
  // 对键盘用户就是个死胡同。
  createEffect(() => {
    if (!pairOpen()) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setPairOpen(false)
      }
    }
    window.addEventListener('keydown', onKey)
    onCleanup(() => window.removeEventListener('keydown', onKey))
  })

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
    <Show when={pairOpen()}>
      {/* 关闭遮罩是**对话框的兄弟节点**，不是父节点。
          把对话框套进 button 里是无效 HTML（button 里不能有交互内容），
          而且要靠 stopPropagation 才不会误触发——那正是 a11y 规则在拦的写法。
          兄弟结构下点击根本不会传到遮罩，也就不需要 stopPropagation。 */}
      <button
        class="backdrop-close"
        type="button"
        aria-label="关闭"
        onClick={() => setPairOpen(false)}
      />
      <div class="sheet-backdrop pass-through">
        <div class="sheet pair-sheet" role="dialog" aria-modal="true" aria-label="手机接入">
          <div class="sheet-head">
            <IconShield size={16} />
            <span>手机接入</span>
            <button
              class="icon-btn"
              type="button"
              aria-label="关闭"
              style={{ 'margin-left': 'auto' }}
              onClick={() => setPairOpen(false)}
            >
              <IconX size={15} />
            </button>
          </div>

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

                <Show
                  when={d().lanEnabled}
                  fallback={<p class="pair-hint">开启后才能用手机扫码</p>}
                >
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
        </div>
      </div>
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
