/**
 * 覆盖右侧面板放大时的输入区停靠交互。
 *
 * CSS 负责「隐藏位置与浮出方式」，本文件锁定状态边界：空输入默认收起、悬浮时展开并延迟
 * 收起；草稿属于用户未提交的数据，鼠标离开时也不得替用户隐藏。
 *
 * 另锁定主按钮的一条判据：忙态包含运行中的子 agent，此时主按钮仍是停止。
 * 补全菜单以输入框定位，运行位置行的显隐不改变定位基准，选择候选不提交表单。
 * 草稿、待发送附件与异步上传按会话隔离，切回与刷新后均恢复所属会话的内容。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})
afterEach(async () => {
  const store = await import('../lib/store/index.ts')
  const { flushSession } = await import('../lib/session.ts')
  store.setPanelMaximized(false)
  store.setState('context', null)
  // 草稿在挂载之间保留（刷新恢复），每条用例从空输入框开始。
  flushSession()
  sessionStorage.clear()
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
  if (!store.state.activeConversation) store.setState('activeConversation', 'cv_composer')
  // ModelPicker 挂载时会获取一次目录；本测试只测试停靠交互，不应依赖本地服务是否启动。
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

test('切换会话与项目时草稿各自保留，发送只清空当前会话', async () => {
  const store = await import('../lib/store/index.ts')
  const conversationsBefore = [...store.state.conversations]
  store.setState({
    activeConversation: 'cv_draft_a',
    busyConversations: [],
    followUps: [],
    conversations: ['cv_draft_a', 'cv_draft_b'].map((id) => ({
      id,
      provider: 'test',
      model: 'test-model',
    })) as never,
  })
  const { dispose, host, textarea } = await mountComposer(false)
  const beforeSend = store.client.send
  const commands: unknown[] = []
  store.client.send = (command) => commands.push(command)
  try {
    input(textarea, '会话 A 的草稿')
    store.setState('activeConversation', 'cv_draft_b')
    expect(textarea.value).toBe('')
    input(textarea, '会话 B 的草稿')
    store.setState('activeConversation', 'cv_draft_a')
    expect(textarea.value).toBe('会话 A 的草稿')
    store.setState('activeConversation', null)
    expect(textarea.value).toBe('')
    store.setState('activeConversation', 'cv_draft_b')
    expect(textarea.value).toBe('会话 B 的草稿')
    click(host.querySelector('.send-btn') as HTMLButtonElement)
    expect(commands).toContainEqual(
      expect.objectContaining({
        type: 'message.send',
        conversationId: 'cv_draft_b',
        content: '会话 B 的草稿',
      }),
    )
    expect(textarea.value).toBe('')
    store.setState('activeConversation', 'cv_draft_a')
    expect(textarea.value).toBe('会话 A 的草稿')
  } finally {
    store.client.send = beforeSend
    dispose()
    store.setState({
      activeConversation: null,
      busyConversations: [],
      followUps: [],
      conversations: conversationsBefore,
    })
  }
})

test('附件上传期间切换会话，完成后只加入原会话草稿', async () => {
  const store = await import('../lib/store/index.ts')
  store.setState('activeConversation', 'cv_upload_a')
  const { dispose, host, textarea } = await mountComposer(false)
  const beforeApi = store.client.api
  let finish!: (value: unknown) => void
  let requestPath = ''
  store.client.api = async <T,>(path: string) => {
    requestPath = path
    return (await new Promise<unknown>((resolve) => {
      finish = resolve
    })) as T
  }
  try {
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { files: [new File(['attachment'], 'a.txt', { type: 'text/plain' })] },
    })
    textarea.dispatchEvent(paste)
    expect(requestPath).toContain('cv_upload_a')
    expect(host.textContent).toContain('上传中 1')
    store.setState('activeConversation', 'cv_upload_b')
    expect(host.textContent).not.toContain('上传中 1')
    finish({
      attachment: { type: 'file', name: 'a.txt', mime: 'text/plain', size: 10, path: 'C:/a.txt' },
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(host.querySelector('[aria-label="移除 a.txt"]')).toBeNull()
    store.setState('activeConversation', 'cv_upload_a')
    expect(host.querySelector('[aria-label="移除 a.txt"]')).not.toBeNull()
    expect(host.textContent).not.toContain('上传中')
  } finally {
    store.client.api = beforeApi
    dispose()
    store.setState('activeConversation', null)
  }
})

test('重新打开技能候选或收到安装事件后重新读取，过期请求不得覆盖新结果', async () => {
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

describe('放大面板中的输入区', () => {
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

  test('空输入默认收起，悬浮时立即展开，离开后延迟收起', async () => {
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

  test('点击触发条后聚焦；已有草稿时鼠标离开仍保持展开', async () => {
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

  /** 原始失败形状：整页刷新后未发送的草稿与附件丢失。刷新以 `flushSession` 后重新挂载模拟。 */
  test('未发送的草稿与附件在刷新后恢复', async () => {
    const { flushSession } = await import('../lib/session.ts')
    const store = await import('../lib/store/index.ts')
    store.setState('activeConversation', 'cv_refresh_draft')
    const first = await mountComposer(false)
    const beforeApi = store.client.api
    store.client.api = async <T,>() =>
      ({
        attachment: { type: 'file', name: 'a.txt', mime: 'text/plain', size: 1, path: 'C:/a.txt' },
      }) as T
    input(first.textarea, '刷新前的草稿')
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', {
      value: { files: [new File(['a'], 'a.txt', { type: 'text/plain' })] },
    })
    first.textarea.dispatchEvent(paste)
    await new Promise((resolve) => setTimeout(resolve, 0))
    store.client.api = beforeApi
    first.dispose()
    flushSession()
    const second = await mountComposer(false)
    try {
      expect(second.textarea.value).toBe('刷新前的草稿')
      expect(second.host.querySelector('[aria-label="移除 a.txt"]')).not.toBeNull()
      store.setState('activeConversation', 'cv_refresh_other')
      expect(second.textarea.value).toBe('')
      expect(second.host.querySelector('[aria-label="移除 a.txt"]')).toBeNull()
      store.setState('activeConversation', 'cv_refresh_draft')
      expect(second.textarea.value).toBe('刷新前的草稿')
      expect(second.host.querySelector('[aria-label="移除 a.txt"]')).not.toBeNull()
    } finally {
      second.dispose()
      store.setState('activeConversation', null)
    }
  })

  test('普通输入区不预先启用悬浮状态；放大后首帧直接收起，再启用过渡', async () => {
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
 * 主按钮的判据是忙态，而忙态包含运行中的子 agent。本轮收尾之后仍有子 agent 在运行时，
 * 该按钮必须仍是停止，否则界面上没有其他入口能停止它们。
 */
describe('仅子 agent 运行中时主按钮仍是停止', () => {
  test('收尾条已位于会话流末尾且输入为空时，按钮是停止', async () => {
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
      // 队列卡片上的按钮与 `sendMessage` 使用同一判据：没有运行中的 run 时显示「发送」；
      // 两处分别判定时，卡片上显示「加入队列」而服务端已立即启动一轮。
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
