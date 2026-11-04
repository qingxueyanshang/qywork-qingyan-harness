import type { CloudRechargeOrder, CloudRechargeStatus } from '@qywork/core'
import { createSignal, For, Match, onCleanup, onMount, Show, Switch } from 'solid-js'
import { renderSVG } from 'uqr'
import {
  cloudState,
  createRecharge,
  fetchRechargeStatus,
  refreshCloudState,
} from '../../lib/store/cloud.ts'
import { explainApiError } from '../../lib/store/index.ts'
import { IconCheck, IconX } from '../Icons.tsx'
import { formatCredits } from './format.ts'

/** 单笔金额的范围（元），与云端相同；超出时云端拒绝并返回原因。 */
const MIN_YUAN = 1
const MAX_YUAN = 10_000
const PRESETS = [10, 30, 50, 100, 200, 500] as const

/** 付款码的 data URL：二维码周围留 2 格空白，扫码时更容易识别。 */
function qrImage(codeUrl: string): string {
  return `data:image/svg+xml;utf8,${encodeURIComponent(renderSVG(codeUrl, { border: 2 }))}`
}

/** 剩余有效期，`分:秒`。 */
function countdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * 充值窗口，打开在账号窗口之上，1 元充值 1 积分。分两步：选择金额（预设金额或自定义），生成付款码后显示二维码、
 * 金额与剩余有效期，按 `pollMs` 的间隔读取订单状态；到账后重新读取账号状态（余额随之更新），过期后可重新生成。
 * 两步共用同一个固定尺寸（B9）。
 */
export default function RechargeDialog(props: { onClose: () => void; pollMs?: number }) {
  let dialog!: HTMLDialogElement
  const [picked, setPicked] = createSignal<number | null>(50)
  const [custom, setCustom] = createSignal('')
  const [order, setOrder] = createSignal<CloudRechargeOrder | null>(null)
  const [status, setStatus] = createSignal<CloudRechargeStatus | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const [now, setNow] = createSignal(Date.now())
  let timer: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const clock = setInterval(() => setNow(Date.now()), 1000)

  onMount(() => dialog.showModal())
  onCleanup(() => {
    disposed = true
    clearTimeout(timer)
    clearInterval(clock)
    dialog.close()
  })

  const yuan = (): number | null => {
    const p = picked()
    if (p !== null) return p
    const n = /^\d+$/.test(custom().trim()) ? Number(custom().trim()) : Number.NaN
    return n >= MIN_YUAN && n <= MAX_YUAN ? n : null
  }

  /**
   * 读取订单状态，待支付时排定下一次；到账与过期是终态，不再读取。
   * 读取失败时显示原因并继续读取：失败多为网络中断，恢复后状态即可更新。
   * 每次读取前核对订单号：重新生成或更换金额后，上一笔订单的读取结果不再写入。
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

  const pay = async (amount: number) => {
    setBusy(true)
    setError(null)
    clearTimeout(timer)
    try {
      const created = await createRecharge(amount)
      setOrder(created)
      setStatus('pending')
      setNow(Date.now())
      poll(created.orderNo)
    } catch (err) {
      setError(explainApiError(err, '无法生成付款码'))
    } finally {
      setBusy(false)
    }
  }

  const back = () => {
    clearTimeout(timer)
    setOrder(null)
    setStatus(null)
    setError(null)
  }

  const balance = () => {
    const s = cloudState()
    return s?.state === 'signed_in' && s.credits !== null ? formatCredits(s.credits) : '—'
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
      <header class="recharge-head">
        <h2 class="recharge-title">充值</h2>
        <span class="recharge-balance">余额 {balance()} 积分</span>
        <button
          class="icon-btn recharge-close"
          type="button"
          aria-label="关闭"
          onClick={() => props.onClose()}
        >
          <IconX size={15} />
        </button>
      </header>

      <Show
        when={order()}
        fallback={
          <form
            class="recharge-step"
            onSubmit={(e) => {
              e.preventDefault()
              const amount = yuan()
              if (amount !== null && !busy()) void pay(amount)
            }}
          >
            <div class="recharge-presets">
              <For each={PRESETS}>
                {(p) => (
                  <button
                    type="button"
                    class="recharge-preset"
                    classList={{ active: picked() === p }}
                    aria-pressed={picked() === p}
                    onClick={() => {
                      setPicked(p)
                      setCustom('')
                    }}
                  >
                    <span class="recharge-preset-yuan">¥{p}</span>
                    <span class="recharge-preset-credits">{p} 积分</span>
                  </button>
                )}
              </For>
            </div>
            <label class="recharge-custom" classList={{ active: picked() === null }}>
              <input
                type="number"
                inputmode="numeric"
                aria-label="其他金额（元）"
                placeholder="其他金额"
                min={MIN_YUAN}
                max={MAX_YUAN}
                step={1}
                value={custom()}
                onFocus={() => setPicked(null)}
                onInput={(e) => {
                  setPicked(null)
                  setCustom(e.currentTarget.value)
                }}
              />
              <span>元</span>
            </label>
            <output class="recharge-error">{error() ?? ''}</output>
            <button
              type="submit"
              class="btn-primary recharge-submit"
              disabled={busy() || yuan() === null}
            >
              {yuan() === null ? '微信支付' : `微信支付 ¥${yuan()}`}
            </button>
          </form>
        }
      >
        {(o) => (
          <div class="recharge-step">
            <div
              class="recharge-qr"
              classList={{ done: status() === 'expired', paid: status() === 'paid' }}
            >
              <Switch>
                <Match when={status() === 'paid'}>
                  <span class="recharge-paid-mark">
                    <IconCheck size={28} stroke={2.4} />
                  </span>
                </Match>
                <Match when={true}>
                  <img src={qrImage(o().codeUrl)} alt="付款码" />
                  <Show when={status() === 'expired'}>
                    <span class="recharge-qr-mask">已过期</span>
                  </Show>
                </Match>
              </Switch>
            </div>
            <div class="recharge-amount">¥{o().amount.toFixed(2)}</div>
            <output
              class="recharge-line"
              classList={{ error: error() !== null, paid: !error() && status() === 'paid' }}
            >
              <Switch>
                <Match when={error()}>{(m) => m()}</Match>
                <Match when={status() === 'paid'}>已到账 {o().amount} 积分</Match>
                <Match when={status() === 'expired'}>付款码已过期</Match>
                <Match when={true}>
                  微信扫码支付 · 到账 {o().amount} 积分 ·{' '}
                  {countdown(Date.parse(o().expiresAt) - now())}
                </Match>
              </Switch>
            </output>
            <div class="recharge-actions">
              <Switch>
                <Match when={status() === 'paid'}>
                  <button type="button" class="btn-ghost" onClick={back}>
                    继续充值
                  </button>
                  <button type="button" class="btn-primary" onClick={() => props.onClose()}>
                    完成
                  </button>
                </Match>
                <Match when={status() === 'expired'}>
                  <button type="button" class="btn-ghost" onClick={back}>
                    更换金额
                  </button>
                  <button
                    type="button"
                    class="btn-primary"
                    disabled={busy()}
                    onClick={() => void pay(o().amount)}
                  >
                    重新生成
                  </button>
                </Match>
                <Match when={true}>
                  <button type="button" class="btn-ghost" onClick={back}>
                    更换金额
                  </button>
                </Match>
              </Switch>
            </div>
          </div>
        )}
      </Show>
    </dialog>
  )
}
