/**
 * 覆盖右侧面板放大时的输入区停靠交互。
 *
 * CSS 负责“藏到哪、怎么浮出来”，这里锁状态边界：空输入默认收起、悬浮展开并延迟
 * 收回；草稿属于用户未提交的数据，鼠标离开也不能替他藏起来。
 *
 * 另锁主按钮的一条判据：忙态含在跑的子 agent，那时它仍是停止。
 * 补全菜单以输入框定位，运行位置行的显隐不改变定位基准，选择候选不提交表单。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
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

async function mountComposer(maximized = true, empty: () => boolean = () => true) {
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
  const dispose = render(() => <Composer empty={empty()} />, host as unknown as HTMLElement)
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

test('技能候选重新打开与安装事件后重新读取，过期请求不能覆盖新结果', async () => {
  const { dispose, host, textarea } = await mountComposer(false)
  const store = await import('../lib/store/index.ts')
  const api = store.client.api
  let installed = false
  let resolveStale: ((value: unknown) => void) | undefined
  let requests = 0
  store.client.api = async <T,>(path: string, init?: RequestInit) => {
    if (path !== '/api/skills') return api.call(store.client, path, init) as Promise<T>
    requests++
    if (requests === 1)
      return new Promise<unknown>((done) => {
        resolveStale = done
      }) as Promise<T>
    return {
      dirs: [],
      skills: installed
        ? [
            {
              name: 'demo',
              description: 'demo skill',
              scope: 'project',
              dir: '/workspace/.agents/skills/demo',
              shadowedBy: null,
            },
          ]
        : [],
    } as T
  }
  try {
    input(textarea, '#')
    await new Promise((done) => setTimeout(done, 0))
    input(textarea, '')
    installed = true
    input(textarea, '#')
    await new Promise((done) => setTimeout(done, 0))
    expect(host.textContent).toContain('demo')
    resolveStale?.({ dirs: [], skills: [] })
    await new Promise((done) => setTimeout(done, 0))
    expect(host.textContent).toContain('demo')
    installed = false
    store.invalidateExtensions()
    await new Promise((done) => setTimeout(done, 0))
    expect(host.querySelector('[role="listbox"]')?.textContent).not.toContain('demo')
    expect(requests).toBe(3)
  } finally {
    store.client.api = api
    dispose()
  }
})

test('补全菜单的定位基准不受运行位置行影响，选择候选不提交', async () => {
  const { createSignal } = await import('solid-js')
  const [empty, setEmpty] = createSignal(true)
  const { dispose, host, textarea } = await mountComposer(false, empty)
  const style = document.createElement('style')
  style.textContent = readFileSync(new URL('../styles/app/composer.css', import.meta.url), 'utf8')
  document.head.append(style)
  try {
    const form = host.querySelector('form')!
    let submitted = false
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submitted = true
    })
    for (const isEmpty of [true, false, true]) {
      setEmpty(isEmpty)
      input(textarea, '/')
      const menu = host.querySelector<HTMLElement>('[role="listbox"]')!
      expect(menu).not.toBeNull()
      expect(host.querySelector('.run-context') !== null).toBe(isEmpty)
      expect(window.getComputedStyle(menu).position).toBe('absolute')
      let anchor = menu.parentElement
      while (anchor) {
        const position = window.getComputedStyle(anchor).position
        if (position && position !== 'static') break
        anchor = anchor.parentElement
      }
      expect(anchor).toBe(form)
      const goal = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="option"]')).find(
        (option) => option.querySelector('code')?.textContent === '/goal',
      )!
      expect(goal.type).toBe('button')
      click(goal)
      expect(textarea.value).toBe('/goal ')
      expect(submitted).toBe(false)
    }
  } finally {
    style.remove()
    dispose()
  }
})

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

/**
 * 主按钮的判据是忙态，而忙态含在跑的子 agent。这一轮收尾之后仍有格在跑时，
 * 那枚按钮必须还是停止——否则界面上没有第二个地方停得掉它们。
 */
describe('只有子 agent 在跑时主按钮仍是停止', () => {
  test('收尾条已在流尾、输入为空，按钮是停止', async () => {
    const store = await import('../lib/store/index.ts')
    store.setState({
      activeConversation: 'cv_subagent_only',
      busyConversations: ['cv_subagent_only'],
      lastRunId: 'rn_1',
      followUps: [{ id: 'q_1', content: '顺带看看日志', steer: false }],
    })
    store.openView('cv_subagent_only')
    store.setState('views', 'cv_subagent_only', 'transcript', [
      {
        id: 'run_rn_1',
        kind: 'run',
        text: '',
        run: {
          runId: 'rn_1',
          stopReason: 'completed',
          usage: null,
          startedAt: 1,
          endedAt: 2,
          errorMessage: null,
        },
      },
    ] as never)

    const { dispose, host } = await mountComposer(false)
    try {
      expect(store.runClosed()).toBe(true)
      expect(store.isRunning()).toBe(true)
      expect(host.querySelector('.send-btn')?.getAttribute('aria-label')).toBe('停止')
      // 队列卡上那枚按钮与 `sendMessage` 读同一个判据：没有 run 在跑就是「发送」，
      // 两处分开写的话，卡上写着「加入队列」而服务端当场起了一轮。
      expect(host.querySelector('.followup-act')?.textContent).toBe('发送')
    } finally {
      dispose()
      store.dropView('cv_subagent_only')
      store.setState({
        activeConversation: null,
        busyConversations: [],
        lastRunId: null,
        followUps: [],
      })
    }
  })
})
