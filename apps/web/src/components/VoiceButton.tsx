import { createSignal, onCleanup, Show } from 'solid-js'
import { type SpeechRecognitionLike, speechRecognitionCtor } from '../lib/store/index.ts'
import { IconMic } from './Icons.tsx'

/**
 * 语音输入。
 *
 * ## 不经过服务端，也和大模型无关
 *
 * 用的是浏览器内置的 `SpeechRecognition`，识别结果直接是文字，拼进草稿就完了。
 * **后端没有任何 STT 通路**，别去那边找。
 *
 * ## 拿不到 API 就不渲染
 *
 * Tauri 的 WebView2 未必带这套 API。**特性检测不通过时整个按钮不出现**，
 * 而不是渲染一个点了没反应的麦克风——后者比没有这个功能更糟，用户会反复去点
 * 并以为是自己不会用。
 *
 * ## 中途结果也写进草稿
 *
 * `interimResults` 开着，说到一半就能看到字。**基线是开始录音那一刻的草稿**，
 * 已定稿的部分累加在它后面——不这么记的话，每来一段中途结果都会把用户
 * 原来打的字覆盖掉。
 */
export function VoiceButton(props: { draft: string; onText: (next: string) => void }) {
  const Ctor = speechRecognitionCtor()
  const [recording, setRecording] = createSignal(false)
  const [failure, setFailure] = createSignal('')
  let rec: SpeechRecognitionLike | null = null
  let base = ''
  let settled = ''

  onCleanup(() => rec?.abort())

  const start = () => {
    if (!Ctor) return
    setFailure('')
    const r = new Ctor()
    r.lang = 'zh-CN'
    r.interimResults = true
    r.continuous = true
    base = props.draft
    settled = ''
    r.onresult = (e) => {
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i]
        if (!result) continue
        const text = result[0]?.transcript ?? ''
        if (result.isFinal) settled += text
        else interim += text
      }
      props.onText(base + settled + interim)
    }
    r.onerror = (e) => {
      // **每一种失败都要说出来。**
      //
      // 这里最危险的不是权限被拒，而是「API 在、但识别服务不可用」：
      // WebView2 是 Chromium 内核，`SpeechRecognition` 构造得出来，
      // 但官方 Chrome 才带着语音服务的凭据。那种情况下 start() 不抛异常，
      // 只是稍后回一个 `network` / `service-not-allowed` 错误然后 onend——
      // 用户看到的就是「点了、亮了一下、什么都没有」。
      setFailure(errorLabel(e.error))
      setRecording(false)
    }
    r.onend = () => {
      setRecording(false)
      rec = null
    }
    rec = r
    try {
      r.start()
      setRecording(true)
    } catch {
      // 已经在录时再调 start() 会抛，按无操作处理。
      rec = null
    }
  }

  return (
    <Show when={Ctor}>
      <span class="voice-wrap">
        <button
          class="icon-btn"
          classList={{ recording: recording(), bad: !!failure() }}
          type="button"
          aria-pressed={recording()}
          aria-label={failure() || (recording() ? '停止语音输入' : '语音输入')}
          title={failure() || (recording() ? '停止' : '语音输入')}
          onClick={() => (recording() ? rec?.stop() : start())}
        >
          <IconMic size={15} />
        </button>
        {/* 失败原因显示在按钮旁边，不塞进全局提示条：它只和这一个按钮有关，
            而全局提示会盖住用户正在打的字。 */}
        <Show when={failure()}>
          <span class="voice-error">{failure()}</span>
        </Show>
      </span>
    </Show>
  )
}

/** 错误码 → 用户能据以行动的一句话。看不懂的原样带出来，不糊成「识别失败」。 */
function errorLabel(code: string): string {
  const map: Record<string, string> = {
    'not-allowed': '麦克风权限被拒绝，去系统设置里放开',
    'service-not-allowed': '这个 WebView 没有可用的语音服务',
    network: '语音服务连不上（这个 WebView 可能不带识别后端）',
    'no-speech': '没听到声音',
    'audio-capture': '找不到麦克风',
    aborted: '',
  }
  return map[code] ?? `语音识别失败：${code}`
}
