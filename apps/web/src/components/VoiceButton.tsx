import { createSignal, onCleanup, Show } from 'solid-js'
import { type SpeechRecognitionLike, speechRecognitionCtor } from '../lib/store/index.ts'
import { IconMic } from './Icons.tsx'

/**
 * 语音输入。
 *
 * 不经过服务端，与模型无关：使用浏览器内置的 `SpeechRecognition`，识别结果直接是文字，
 * 拼接到草稿即可。后端没有 STT 链路，不要在后端查找。
 *
 * 无法取得 API 时不渲染。Tauri 的 WebView2 不一定提供该 API；特性检测不通过时整个按钮不显示，
 * 而不是渲染一个点击无响应的麦克风按钮：用户会反复点击而得不到任何反馈。
 *
 * 中间结果同样写入草稿。`interimResults` 已开启，说话过程中即可看到文字。基线是开始录音时的草稿，
 * 已定稿的部分追加在其后；不记录基线时，每段中间结果都会覆盖用户已输入的文字。
 */
export function VoiceButton(props: {
  draft: string
  onText: (next: string) => void
  /** 向提交方提供停止函数：发送时冻结当前草稿，不再接收此后到达的识别结果。 */
  bindSubmitStop?: (stop: () => void) => void
}) {
  const Ctor = speechRecognitionCtor()
  const [recording, setRecording] = createSignal(false)
  const [failure, setFailure] = createSignal('')
  let rec: SpeechRecognitionLike | null = null
  let base = ''
  let settled = ''
  let acceptsResults = false

  onCleanup(() => {
    acceptsResults = false
    rec?.abort()
    rec = null
  })

  /*
   * 提交与按钮停止的语义不同：按钮停止需要接收最后一段定稿；提交已按当前草稿发出，
   * 此后到达的 onresult 不得重新填充已清空的输入框。`abort()` 同时立即释放
   * 麦克风，避免 continuous 模式继续占用设备。
   */
  const stopForSubmit = () => {
    const active = rec
    if (!active) return
    acceptsResults = false
    rec = null
    setRecording(false)
    try {
      active.abort()
    } catch {
      // 识别实例已自行结束时 abort 可能抛出异常，不得因此阻止发送。
    }
  }
  props.bindSubmitStop?.(stopForSubmit)

  const start = () => {
    if (!Ctor) return
    setFailure('')
    const r = new Ctor()
    r.lang = 'zh-CN'
    r.interimResults = true
    r.continuous = true
    base = props.draft
    settled = ''
    acceptsResults = true
    r.onresult = (e) => {
      if (!acceptsResults || rec !== r) return
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
      if (rec !== r) return
      // 每一种失败都必须显示。
      //
      // 最难察觉的情况不是权限被拒，而是 API 存在但识别服务不可用：
      // WebView2 基于 Chromium，可以构造 `SpeechRecognition`，
      // 但只有官方 Chrome 带有语音服务的凭据。此时 start() 不抛出异常，
      // 稍后返回 `network` / `service-not-allowed` 错误并触发 onend，
      // 按钮高亮后随即恢复，没有任何输出。
      setFailure(errorLabel(e.error))
      acceptsResults = false
      setRecording(false)
    }
    r.onend = () => {
      // 旧实例在提交后才触发 onend 时，不得清除此后新建的实例。
      if (rec !== r) return
      acceptsResults = false
      setRecording(false)
      rec = null
    }
    rec = r
    try {
      r.start()
      setRecording(true)
    } catch {
      // 正在录音时再次调用 start() 会抛出异常，按无操作处理。
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
          data-tip={failure() || (recording() ? '停止' : '语音输入')}
          onClick={() => (recording() ? rec?.stop() : start())}
        >
          <IconMic size={15} />
        </button>
        {/* 失败原因显示在按钮旁边，不放入全局提示条：它只与该按钮有关，
            而全局提示会遮挡用户正在输入的文字。 */}
        <Show when={failure()}>
          <span class="voice-error">{failure()}</span>
        </Show>
      </span>
    </Show>
  )
}

/** 错误码到提示文字的映射，提示说明用户可采取的操作。未知错误码原样显示，不笼统写成「识别失败」。 */
function errorLabel(code: string): string {
  const map: Record<string, string> = {
    'not-allowed': '麦克风权限被拒绝，请在系统设置中开启',
    'service-not-allowed': '当前 WebView 无可用的语音服务',
    network: '无法连接语音服务，当前 WebView 可能不含识别后端',
    'no-speech': '未检测到语音输入',
    'audio-capture': '未找到麦克风',
    aborted: '',
  }
  return map[code] ?? `语音识别失败：${code}`
}
