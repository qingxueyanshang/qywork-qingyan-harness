/**
 * 覆盖右侧面板放大时的输入区停靠交互。
 *
 * CSS 负责“藏到哪、怎么浮出来”，这里锁状态边界：空输入默认收起、悬浮展开并延迟
 * 收回；草稿属于用户未提交的数据，鼠标离开也不能替他藏起来。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterEach(async () => {
  const store = await import('../lib/store/index.ts')
  store.setPanelMaximized(false)
  store.setState('context', null)
  document.body.replaceChildren()
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function mountComposer(maximized = true) {
  const { render } = await import('solid-js/web')
  const { Composer } = await import('./Composer.tsx')
  const store = await import('../lib/store/index.ts')
  store.setPanelMaximized(maximized)
  // ModelPicker 挂载时会取一次目录；本测试只测停靠交互，不应依赖本地服务是否启动。
  const originalApi = store.client.api
  store.client.api = async <T,>(path: string, init?: RequestInit) => {
    if (path === '/api/models') return { providers: [], library: [] } as T
    return originalApi.call(store.client, path, init) as Promise<T>
  }
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <Composer />, host as unknown as HTMLElement)
  const wrap = host.querySelector('.composer-wrap') as HTMLDivElement
  const reveal = host.querySelector('.composer-reveal') as HTMLButtonElement
  const textarea = host.querySelector('.composer-input') as HTMLTextAreaElement
  return {
    dispose: () => {
      dispose()
      store.client.api = originalApi
    },
    host,
    reveal,
    textarea,
    wrap,
  }
}

function pointer(target: Element, type: 'pointerenter' | 'pointerleave') {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true }))
}

function click(button: HTMLButtonElement) {
  const event = new MouseEvent('click', { bubbles: true })
  const delegated = (button as unknown as { $$click?: (event: MouseEvent) => void }).$$click
  if (delegated) {
    delegated.call(button, event)
    return
  }
  button.dispatchEvent(event)
}

function input(textarea: HTMLTextAreaElement, value: string) {
  textarea.value = value
  const delegated = (
    textarea as unknown as {
      $$input?: (event: Pick<InputEvent, 'currentTarget'>) => void
    }
  ).$$input
  if (delegated) {
    delegated.call(textarea, { currentTarget: textarea })
    return
  }
  textarea.dispatchEvent(new InputEvent('input', { bubbles: true, data: value }))
}

describe('放大面板里的输入区', () => {
  test('上下文详情不显示计量来源字段', async () => {
    const { dispose, host } = await mountComposer(false)
    try {
      const store = await import('../lib/store/index.ts')
      store.setState('context', {
        tokens: 32_000,
        limit: 200_000,
        percent: 16,
        compactAt: 160_000,
        breakdown: {
          systemPrompt: 1000,
          systemTools: 1000,
          mcpTools: 0,
          memory: 0,
          skills: 0,
          workspaceState: 0,
          historyMessages: 30_000,
          summary: 0,
          executionRecords: 0,
          intermediateContent: 0,
        },
        omitted: { historyOriginal: 0, intermediateOriginal: 0 },
      })
      click(host.querySelector('.ctx-meter') as HTMLButtonElement)

      const dialog = host.querySelector('[aria-label="上下文占用明细"]')
      expect(dialog).not.toBeNull()
      expect(dialog?.textContent).not.toContain('真值投影')
      expect(dialog?.textContent).not.toContain('真值校准')
      expect(dialog?.textContent).not.toContain('实际统计')
      expect(dialog?.textContent).not.toContain('估算统计')
      expect(dialog?.querySelector('.ctx-source')).toBeNull()
    } finally {
      dispose()
    }
  })

  test('空输入默认收起，悬浮立即展开，离开后延迟收回', async () => {
    const { dispose, reveal, wrap } = await mountComposer()
    try {
      expect(wrap.classList.contains('panel-dock-open')).toBe(false)
      expect(reveal.getAttribute('aria-expanded')).toBe('false')

      pointer(wrap, 'pointerenter')
      expect(wrap.classList.contains('panel-dock-open')).toBe(true)
      expect(reveal.getAttribute('aria-expanded')).toBe('true')

      pointer(wrap, 'pointerleave')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(wrap.classList.contains('panel-dock-open')).toBe(false)
    } finally {
      dispose()
    }
  })

  test('点击触发条聚焦；已有草稿时离开也保持展开', async () => {
    const { dispose, reveal, textarea, wrap } = await mountComposer()
    try {
      const nativeFocus = textarea.focus.bind(textarea)
      let focusCalls = 0
      textarea.focus = (options?: FocusOptions) => {
        focusCalls += 1
        nativeFocus(options)
      }
      click(reveal)
      expect(focusCalls).toBe(1)
      expect(wrap.classList.contains('panel-dock-open')).toBe(true)

      input(textarea, '还没发送的草稿')
      textarea.blur()
      pointer(wrap, 'pointerleave')
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(wrap.classList.contains('panel-dock-open')).toBe(true)
      expect(reveal.getAttribute('aria-expanded')).toBe('true')
    } finally {
      dispose()
    }
  })

  test('普通输入区不预热悬浮状态；放大首帧直接收起再启用过渡', async () => {
    const { dispose, reveal, wrap } = await mountComposer(false)
    try {
      pointer(wrap, 'pointerenter')
      expect(wrap.classList.contains('panel-dock-open')).toBe(false)
      expect(reveal.getAttribute('aria-expanded')).toBe('false')

      const store = await import('../lib/store/index.ts')
      store.setPanelMaximized(true)
      expect(wrap.classList.contains('panel-dock-open')).toBe(false)
      expect(wrap.classList.contains('panel-dock-ready')).toBe(false)

      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(wrap.classList.contains('panel-dock-ready')).toBe(true)
    } finally {
      dispose()
    }
  })
})
