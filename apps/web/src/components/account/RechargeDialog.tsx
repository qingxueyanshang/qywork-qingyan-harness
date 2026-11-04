import type { CloudRechargeOrder, CloudRechargeStatus } from '@qywork/core'
import { createSignal, onCleanup, onMount, Show } from 'solid-js'
import { renderSVG } from 'uqr'
import { createRecharge, fetchRechargeStatus, refreshCloudState } from '../../lib/store/cloud.ts'
import { explainApiError } from '../../lib/store/index.ts'

/** 单笔金额的范围（元），与云端相同；超出时云端拒绝并返回原因。 */
const MIN_YUAN = 1
const MAX_YUAN = 10_000

/** 付款码的 data URL：二维码周围留 2 格空白，扫码时更容易识别。 */
function qrImage(codeUrl: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(codeUrl, { border: 2 }))}`
}

/**
 * 充值窗口，打开在账号窗口之上：输入金额生成微信付款码，按 `pollMs` 的间隔读取订单状态，
 * 到账后重新读取账号状态（余额随之更新），过期后可重新生成。尺寸固定（B9），付款码区域在生成前留空。
 * 1 元充值 1 积分。
 */
export default function RechargeDialog(props: { onClose: () => void; pollMs?: number }) {
  let dialog!: HTMLDialogElement
  const [amount, setAmount] = createSignal('')
  const [order, setOrder] = createSignal<CloudRechargeOrder | null>(null)
  const [status, setStatus] = createSignal<CloudRechargeStatus | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false

  onMount(() => dialog.showModal())
  onCleanup(() => {
    disposed = true
    clearTimeout(timer)
    dialog.close()
  })

  /**
   * 读取订单状态，待支付时排定下一次；到账与过期是终态，不再读取。
   * 读取失败时显示原因并继续读取：失败多为网络中断，恢复后状态即可更新。
   * 每次读取前核对订单号：重新生成付款码后，上一笔订单的读取结果不再写入。
   */
  const poll = (no: string) => {
    if (disposed) return
    timer = setTimeout(async () => {
      if (disposed || order()?.orderNo !== no) return
      try {
        const next = await fetchRechargeStatus(no)
        if (order()?.orderNo !== no) return
        setError(null)
        setStatus(next)
        if (next === 'paid') {
          void refreshCloudState().catch(() => {})
          return
        }
        if (next === 'expired') return
      } catch (e) {
        if (order()?.orderNo !== no) return
        setError(explainApiError(e, '无法读取支付状态'))
      }
      poll(no)
    }, props.pollMs ?? 2000)
  }

  const submit = async (e: SubmitEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    clearTimeout(timer)
    try {
      const created = await createRecharge(Number(amount()))
      setOrder(created)
      setStatus('pending')
      poll(created.orderNo)
    } catch (err) {
      setError(explainApiError(err, '无法生成付款码'))
    } finally {
      setBusy(false)
    }
  }

  const line = (): string => {
    const o = order()
    if (!o) return ''
    if (status() === 'paid') return `已到账 ${o.amount} 积分`
    if (status() === 'expired') return '付款码已过期'
    return `微信扫码支付 ${o.amount} 元，到账 ${o.amount} 积分`
  }

  return (
    <dialog
      ref={dialog}
      class="recharge-dialog"
      aria-label="充值"
      onCancel={(e) => {
        e.preventDefault()
        props.onClose()
      }}
      onKeyDown={(e) => {
        // Escape 只关闭本窗口，不把后面的账号窗口一起关闭。
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <h2 class="confirm-title">充值</h2>
      <form class="recharge-form" onSubmit={submit}>
        <label class="recharge-field">
          <input
            class="account-input"
            type="number"
            inputmode="numeric"
            aria-label="金额（元）"
            min={MIN_YUAN}
            max={MAX_YUAN}
            step={1}
            required
            value={amount()}
            onInput={(e) => setAmount(e.currentTarget.value)}
          />
          <span class="recharge-unit">元</span>
        </label>
        <button type="submit" class="btn-primary" disabled={busy()}>
          生成付款码
        </button>
      </form>
      <div class="recharge-qr" classList={{ done: status() === 'paid' || status() === 'expired' }}>
        <Show when={order()}>{(o) => <img src={qrImage(o().codeUrl)} alt="付款码" />}</Show>
      </div>
      <output
        class="recharge-line"
        classList={{ error: error() !== null, paid: !error() && status() === 'paid' }}
      >
        {error() ?? line()}
      </output>
      <div class="confirm-actions">
        <button class="btn-ghost" type="button" onClick={() => props.onClose()}>
          关闭
        </button>
      </div>
    </dialog>
  )
}
