import { createSignal, onCleanup, onMount } from 'solid-js'
import { cloudState, redeemCode } from '../../lib/store/cloud.ts'
import { explainApiError } from '../../lib/store/index.ts'
import { IconX } from '../Icons.tsx'
import { formatCredits } from './format.ts'

/**
 * 兑换码窗口，打开在账号窗口之上。兑换成功后清空输入框，结果行显示得到的积分，余额随账号状态更新；
 * 失败时结果行显示云端给出的原因。尺寸固定（B9）：结果行留有固定高度，有无内容时窗口不变形。
 */
export default function RedeemDialog(props: { onClose: () => void }) {
  let dialog!: HTMLDialogElement
  const [code, setCode] = createSignal('')
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<{ ok: boolean; text: string } | null>(null)

  onMount(() => dialog.showModal())
  onCleanup(() => dialog.close())

  const redeem = async () => {
    const text = code().trim()
    if (!text || busy()) return
    setBusy(true)
    setResult(null)
    try {
      const credits = await redeemCode(text)
      setCode('')
      setResult({ ok: true, text: `已兑换 ${formatCredits(credits)} 积分` })
    } catch (e) {
      setResult({ ok: false, text: explainApiError(e, '兑换失败') })
    } finally {
      setBusy(false)
    }
  }

  const balance = () => {
    const s = cloudState()
    return s?.state === 'signed_in' && s.credits !== null ? formatCredits(s.credits) : '—'
  }

  return (
    <dialog
      ref={dialog}
      class="redeem-dialog"
      aria-label="兑换码"
      onCancel={(e) => {
        e.preventDefault()
        props.onClose()
      }}
      onKeyDown={(e) => {
        // Escape 只关闭本窗口，不关闭下层的账号窗口。
        if (e.key === 'Escape') e.stopPropagation()
      }}
    >
      <header class="redeem-head">
        <h2 class="redeem-title">兑换码</h2>
        <span class="redeem-balance">余额 {balance()} 积分</span>
        <button
          class="icon-btn redeem-close"
          type="button"
          aria-label="关闭"
          onClick={() => props.onClose()}
        >
          <IconX size={15} />
        </button>
      </header>
      <form
        class="redeem-form"
        onSubmit={(e) => {
          e.preventDefault()
          void redeem()
        }}
      >
        <input
          class="redeem-input"
          type="text"
          aria-label="兑换码"
          autocomplete="off"
          spellcheck={false}
          value={code()}
          onInput={(e) => setCode(e.currentTarget.value)}
        />
        <output
          class="redeem-result"
          classList={{ error: result()?.ok === false, done: result()?.ok === true }}
        >
          {result()?.text ?? ''}
        </output>
        <button type="submit" class="btn-primary redeem-submit" disabled={busy() || !code().trim()}>
          兑换
        </button>
      </form>
    </dialog>
  )
}
