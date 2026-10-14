/** 覆盖 ParamPicker 的搜索、键盘选择、紧凑展示与试听生命周期。 */
import { afterAll, afterEach, beforeAll, expect, spyOn, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { createSignal } from 'solid-js'
import { delegateEvents, render } from 'solid-js/web'

let ParamPicker: typeof import('./ParamPicker.tsx').ParamPicker
beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  ;({ ParamPicker } = await import('./ParamPicker.tsx'))
  // 同一进程先运行画布用例时模块已缓存，需要在这一份 document 上注册委托事件。
  delegateEvents(['click', 'input', 'keydown'])
})
afterAll(() => GlobalRegistrator.unregister())
let dispose: (() => void) | undefined
afterEach(() => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
})

function mount() {
  const picked: string[] = []
  const [selected, setSelected] = createSignal('a')
  const param = {
    name: 'voice',
    label: '音色',
    type: 'string' as const,
    valueDescriptions: { a: '女声 · 温柔', b: '男声 · 英文' },
    valueSamples: {
      a: { url: 'https://example.test/a.wav' },
      b: { url: 'https://example.test/b.wav' },
    },
  }
  const choices = [
    ['a', '音色甲'],
    ['b', '音色乙'],
  ].map(([of, text]) => ({
    of,
    text: text!,
    checked: () => selected() === of,
    pick: () => {
      picked.push(of!)
      setSelected(of!)
    },
  }))
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <ParamPicker param={param} choices={choices} />, host)
  const trigger = host.querySelector<HTMLButtonElement>('.canvas-param-trigger')!
  const audio = host.querySelector('audio')!
  return { picked, trigger, audio }
}

test('按特点搜索，键盘定位选项；试听或搜索不更改选中值', () => {
  const { picked, trigger } = mount()
  expect(trigger.dataset.tip).toBe('女声 · 温柔')
  expect(document.querySelector('.canvas-param-dropdown [title]')).toBeNull()
  expect(document.querySelector('.canvas-param-description')).toBeNull()
  trigger.click()
  const input = document.querySelector<HTMLInputElement>('input[type="search"]')!
  input.value = '英文'
  input.dispatchEvent(new Event('input', { bubbles: true }))
  const options = document.querySelectorAll<HTMLButtonElement>('[data-param-option]')
  expect(options).toHaveLength(1)
  expect(options[0]?.textContent).toContain('音色乙')
  expect(options[0]?.dataset.tip).toBe('男声 · 英文\nb')
  expect(document.querySelector('.canvas-param-picker [title]')).toBeNull()
  expect(document.querySelector('.canvas-param-id')).toBeNull()
  expect(document.querySelector('.canvas-param-option .canvas-param-description')).toBeNull()
  expect(picked).toEqual([])
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
  expect(document.activeElement).toBe(options[0]!)
  options[0]!.click()
  expect(picked).toEqual(['b'])
  expect(trigger.textContent).toBe('音色乙')
  expect(document.querySelector('.canvas-param-picker')).toBeNull()
})

test('当前音色的试听独立于展开操作，使用全局悬浮提示', async () => {
  const { picked, trigger, audio } = mount()
  const play = spyOn(audio, 'play').mockResolvedValue(undefined)
  const preview = document.querySelector<HTMLButtonElement>(
    '.canvas-param-dropdown-current .canvas-param-preview',
  )!
  expect(preview.dataset.tip).toBe('官方样音')
  preview.click()
  await Promise.resolve()
  expect(play).toHaveBeenCalledTimes(1)
  expect(document.querySelector('.canvas-param-picker')).toBeNull()
  expect(picked).toEqual([])
  expect(preview.getAttribute('aria-label')).toBe('停止试听 音色甲')
  trigger.click()
  expect(document.querySelector('.canvas-param-picker')).not.toBeNull()
  expect(play).toHaveBeenCalledTimes(1)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(audio.getAttribute('src')).toBeNull()
})

test('切换试听停止上一个样音，不选中音色；旧播放失败不会覆盖新播放，Esc 停止并恢复焦点', async () => {
  const { picked, trigger, audio } = mount()
  let failFirst!: (reason: Error) => void
  const play = spyOn(audio, 'play')
    .mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          failFirst = reject
        }),
    )
    .mockResolvedValue(undefined)
  const pause = spyOn(audio, 'pause').mockImplementation(() => {})
  trigger.click()
  document
    .querySelector<HTMLButtonElement>('.canvas-param-picker button[aria-label="试听 音色甲"]')!
    .click()
  expect(audio.src).toBe('https://example.test/a.wav')
  document
    .querySelector<HTMLButtonElement>('.canvas-param-picker button[aria-label="试听 音色乙"]')!
    .click()
  expect(audio.src).toBe('https://example.test/b.wav')
  failFirst(new Error('被新试听中止'))
  await Promise.resolve()
  expect(picked).toEqual([])
  expect(document.querySelector('.canvas-param-error')).toBeNull()
  expect(play).toHaveBeenCalledTimes(2)
  expect(pause).toHaveBeenCalledTimes(2)
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  expect(document.querySelector('.canvas-param-picker')).toBeNull()
  expect(audio.getAttribute('src')).toBeNull()
  expect(document.activeElement).toBe(trigger)
  expect(pause).toHaveBeenCalledTimes(3)
})

test('样音失败可重试；卸载中止试听，不留下后台播放', async () => {
  const { trigger, audio } = mount()
  spyOn(audio, 'play').mockRejectedValueOnce(new Error('不可访问')).mockResolvedValue(undefined)
  const pause = spyOn(audio, 'pause').mockImplementation(() => {})
  trigger.click()
  document
    .querySelector<HTMLButtonElement>('.canvas-param-picker button[aria-label="试听 音色甲"]')!
    .click()
  await Promise.resolve()
  expect(document.querySelector('.canvas-param-picker .canvas-param-error')?.textContent).toBe(
    '试听暂不可用，请重试',
  )
  document
    .querySelector<HTMLButtonElement>('.canvas-param-picker button[aria-label="试听 音色甲"]')!
    .click()
  await Promise.resolve()
  expect(document.querySelector('.canvas-param-error')).toBeNull()
  dispose?.()
  dispose = undefined
  expect(audio.getAttribute('src')).toBeNull()
  expect(pause.mock.calls.length).toBeGreaterThanOrEqual(4)
})
