/**
 * 内置浏览器页，用于桌面外壳以外的客户端：工具栏与远程画面（`RemoteView`）。页面在电脑上，由宿主持有。
 *
 * 与桌面外壳的 `BrowserPanel` 使用同一套工具栏：后退、前进、刷新与地址栏，地址按宿主的规则解析（网址或本地文件路径）。
 * 地址与标题是服务端清单（`browser.tabs`）的投影，前端不写入。历史状态不在清单中，后退与前进按钮不禁用。
 * 触屏客户端另有键盘按钮：系统键盘只在输入框获得焦点时弹出，点击网页中的输入框不会使本页的输入框获得焦点。
 * 组件卸载不关闭页面，关闭只由页签的 × 触发。
 */

import { createSignal, Show } from 'solid-js'
import { BLANK_PAGE } from '../../lib/browser.ts'
import { browserTab, navigateRemotePage } from '../../lib/store/index.ts'
import { IconChevron, IconKeyboard, IconRefresh } from '../Icons.tsx'
import RemoteView from './RemoteView.tsx'

/** 地址栏显示的地址，规则同 `BrowserPanel` 的 `shown`。 */
function shown(url: string): string {
  if (url === BLANK_PAGE) return ''
  if (!url.startsWith('file:')) return url
  return url.replace(/(?:%[89a-f][0-9a-f])+|%20/gi, (run) => {
    try {
      return decodeURIComponent(run)
    } catch {
      return run
    }
  })
}

const coarse = () => window.matchMedia?.('(pointer: coarse)').matches === true

export default function RemoteBrowserPanel(props: { id: string }) {
  const tab = () => browserTab(props.id)
  const [draft, setDraft] = createSignal<string | null>(null)
  const [error, setError] = createSignal('')
  const address = () => draft() ?? shown(tab()?.url ?? '')
  let keyboard: HTMLInputElement | null = null

  const run = (action: 'back' | 'forward' | 'reload' | 'goto', url?: string) => {
    setError('')
    return navigateRemotePage(props.id, action, url).catch((e: unknown) => {
      setError(e instanceof Error ? e.message : String(e))
      throw e
    })
  }

  const go = () => {
    const next = address().trim()
    if (!next) return
    run('goto', next).then(
      () => setDraft((d) => (d?.trim() === next ? null : d)),
      () => {},
    )
  }

  return (
    <div class="web-panel">
      <form
        class="web-bar"
        onSubmit={(e) => {
          e.preventDefault()
          go()
        }}
      >
        <button
          class="icon-btn"
          type="button"
          aria-label="后退"
          onClick={() => void run('back').catch(() => {})}
        >
          <IconChevron size={14} dir="left" />
        </button>
        <button
          class="icon-btn"
          type="button"
          aria-label="前进"
          onClick={() => void run('forward').catch(() => {})}
        >
          <IconChevron size={14} dir="right" />
        </button>
        <button
          class="icon-btn"
          type="button"
          aria-label="刷新"
          onClick={() => void run('reload').catch(() => {})}
        >
          <IconRefresh size={14} />
        </button>
        <input
          class="web-url"
          type="text"
          spellcheck={false}
          placeholder="网址或本地文件路径"
          value={address()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          onBlur={() => setDraft(null)}
        />
        <Show when={coarse()}>
          <button
            class="icon-btn"
            type="button"
            aria-label="键盘"
            onClick={() => keyboard?.focus({ preventScroll: true })}
          >
            <IconKeyboard size={14} />
          </button>
        </Show>
      </form>
      <RemoteView
        tabId={props.id}
        onInput={(el) => {
          keyboard = el
        }}
      />
      <Show when={error()}>{(e) => <p class="web-error">{e()}</p>}</Show>
    </div>
  )
}
