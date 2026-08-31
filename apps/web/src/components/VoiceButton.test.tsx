import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

import type { SpeechRecognitionLike } from '../lib/store/index.ts'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterAll(async () => {
  delete (globalThis as { SpeechRecognition?: unknown }).SpeechRecognition
  await GlobalRegistrator.unregister()
})

type ResultEvent = Parameters<NonNullable<SpeechRecognitionLike['onresult']>>[0]

function click(button: HTMLButtonElement) {
  const event = new MouseEvent('click', { bubbles: true })
  const delegated = (button as unknown as { $$click?: (event: MouseEvent) => void }).$$click
  if (delegated) {
    delegated.call(button, event)
    return
  }
  button.dispatchEvent(event)
}

class RecognitionStub implements SpeechRecognitionLike {
  static latest: RecognitionStub | null = null

  lang = ''
  interimResults = false
  continuous = false
  starts = 0
  stops = 0
  aborts = 0
  onresult: SpeechRecognitionLike['onresult'] = null
  onerror: SpeechRecognitionLike['onerror'] = null
  onend: SpeechRecognitionLike['onend'] = null

  constructor() {
    RecognitionStub.latest = this
  }

  start() {
    this.starts++
  }

  stop() {
    this.stops++
  }

  abort() {
    this.aborts++
  }
}

async function mount() {
  // 其他 DOM 测试会注册/注销自己的 happy-dom 全局；显式重设描述符，避免沿用旧 window
  // 上的转发属性后赋值落空。
  Object.defineProperty(globalThis, 'SpeechRecognition', {
    configurable: true,
    writable: true,
    value: RecognitionStub,
  })
  const { render } = await import('solid-js/web')
  const { VoiceButton } = await import('./VoiceButton.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  let text = ''
  let submitStop = () => {}
  const dispose = render(
    () => (
      <VoiceButton
        draft=""
        onText={(next) => {
          text = next
        }}
        bindSubmitStop={(stop) => {
          submitStop = stop
        }}
      />
    ),
    host as unknown as HTMLElement,
  )
  const button = host.querySelector('button') as HTMLButtonElement
  click(button)
  const recognition = RecognitionStub.latest
  if (!recognition) throw new Error('语音识别实例没有创建')
  return {
    button,
    dispose: () => {
      dispose()
      host.remove()
    },
    recognition,
    submitStop,
    text: () => text,
  }
}

function result(transcript: string): ResultEvent {
  return {
    resultIndex: 0,
    results: Object.assign([{ isFinal: false, 0: { transcript } }], { length: 1 }),
  }
}

describe('语音输入的停止边界', () => {
  test('点麦克风停止时走 stop，保留浏览器随后送达的最终识别结果', async () => {
    const { button, dispose, recognition } = await mount()

    click(button)

    expect(recognition.stops).toBe(1)
    expect(recognition.aborts).toBe(0)
    dispose()
  })

  test('提交时立即 abort，且迟到的识别结果不把已清空草稿重新填回去', async () => {
    const { button, dispose, recognition, submitStop, text } = await mount()
    const lateResult = recognition.onresult

    submitStop()
    lateResult?.(result('迟到的半句话'))

    expect(recognition.aborts).toBe(1)
    expect(recognition.stops).toBe(0)
    expect(button.getAttribute('aria-pressed')).toBe('false')
    expect(text()).toBe('')
    dispose()
  })
})
