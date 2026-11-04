/**
 * 覆盖 `lib/store/appearance/pet.ts`（心情推导、未查看结果、气泡、显示的消息与偏好）、`PetSprite.tsx`、
 * `PetWindow.tsx`、`PetBox.tsx`、`pet-view.ts` 与 `pet-default.ts`（默认宠物包须通过 core 的校验）。
 *
 * 测试 DOM 在本文件内注册，结束后注销，理由同 `settings/LoadState.test.tsx`。
 * 账本以桩代替：会话行与轮次列表由 `fetch` 返回，键为会话 id。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

type RunRow = { status: string; createdAt: number; finishedAt: number | null }

/** 会话 id → 会话行、最近一条消息与轮次。未登记的会话返回 404。 */
const ledger = new Map<
  string,
  {
    title: string
    parent?: boolean
    latest?: { content: string; origin: 'subagent' | null }
    runs: RunRow[]
  }
>()

function serveLedger(): void {
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input), 'http://localhost')
    const m = /^\/api\/conversations\/([^/]+)(\/runs|\/history)?$/.exec(url.pathname)
    const row = m ? ledger.get(decodeURIComponent(m[1] as string)) : undefined
    if (!m || !row) return new Response('{}', { status: 404 })
    if (m[2] === '/runs') return new Response(JSON.stringify({ runs: row.runs, childRuns: [] }))
    if (m[2] === '/history') {
      const messages = row.latest
        ? [{ id: 'm1', role: 'user', attachments: [], createdAt: 0, ...row.latest }]
        : []
      return new Response(JSON.stringify({ messages, runs: [], steps: [], todos: [] }))
    }
    return new Response(
      JSON.stringify({
        conversation: {
          id: m[1],
          title: row.title,
          parentConversationId: row.parent ? 'cv_p' : null,
        },
        workspace: { id: 'ws_x', rootPath: 'C:/x', name: 'x' },
      }),
    )
  }) as unknown as typeof fetch
}

const flush = () => new Promise((r) => setTimeout(r, 10))

describe('宠物状态推导', () => {
  test('变闲后按最新一轮记录结果：完成、出错、被中断不记、启动前被拒记为出错', async () => {
    const store = await import('../../lib/store/index.ts')
    serveLedger()
    const now = Date.now()
    ledger.set('cv_done', {
      title: '写报告',
      runs: [{ status: 'done', createdAt: now, finishedAt: now }],
    })
    ledger.set('cv_fail', {
      title: '生成视频',
      runs: [{ status: 'failed', createdAt: now, finishedAt: now }],
    })
    ledger.set('cv_stop', {
      title: '整理',
      runs: [{ status: 'interrupted', createdAt: now, finishedAt: now }],
    })
    // 只有很久以前的一轮：本次在启动前即被拒绝。
    ledger.set('cv_reject', {
      title: '未配置',
      runs: [{ status: 'done', createdAt: now - 3_600_000, finishedAt: now - 3_600_000 }],
    })
    store.setState({ activeConversation: 'cv_elsewhere', busyConversations: [] })
    const stop = store.observePet()
    try {
      expect(store.petMood()).toBe('idle')
      store.setState('busyConversations', ['cv_done', 'cv_fail', 'cv_stop', 'cv_reject'])
      await flush()
      expect(store.petMood()).toBe('working')
      expect(store.petBadge()).toBe('4')

      store.setState('busyConversations', [])
      await flush()
      const outcomes = Object.fromEntries(
        store.petResults().map((r) => [r.conversationId, r.outcome]),
      )
      expect(outcomes).toEqual({ cv_done: 'done', cv_fail: 'failed', cv_reject: 'failed' })
      expect(store.petMood()).toBe('failed')
      expect(store.petBubble()).not.toBeNull()
      expect(store.petEntries().map((e) => e.status)).toContain('done')
    } finally {
      stop()
    }
  })

  test('连接前已在运行、观察期间结束的轮次按其结果记录', async () => {
    const store = await import('../../lib/store/index.ts')
    serveLedger()
    const started = Date.now() - 600_000
    ledger.set('cv_long', { title: '长任务', runs: [] })
    store.setState({ activeConversation: 'cv_elsewhere', busyConversations: ['cv_long'] })
    const stop = store.observePet()
    try {
      await flush()
      ledger.set('cv_long', {
        title: '长任务',
        runs: [{ status: 'done', createdAt: started, finishedAt: Date.now() }],
      })
      store.setState('busyConversations', [])
      await flush()
      expect(store.petResults().find((r) => r.conversationId === 'cv_long')?.outcome).toBe('done')
    } finally {
      stop()
    }
  })

  test('列表与气泡显示最近一条由用户本人发送的消息；回执不替换；没有消息时显示会话标题', async () => {
    const store = await import('../../lib/store/index.ts')
    serveLedger()
    const now = Date.now()
    const done = [{ status: 'done', createdAt: now, finishedAt: now }]
    ledger.set('cv_follow', {
      title: '第一次的提问',
      latest: { content: '第二次的提问\n补充说明', origin: null },
      runs: done,
    })
    ledger.set('cv_receipt', {
      title: '派发任务',
      latest: { content: '子 agent 的回执', origin: 'subagent' },
      runs: done,
    })
    ledger.set('cv_plain', { title: '只有标题', runs: done })
    store.setState({ activeConversation: 'cv_elsewhere', busyConversations: [] })
    const stop = store.observePet()
    try {
      store.setState('busyConversations', ['cv_follow', 'cv_receipt', 'cv_plain'])
      await flush()
      const running = Object.fromEntries(store.petEntries().map((e) => [e.conversationId, e.title]))
      expect(running).toMatchObject({
        cv_follow: '第二次的提问',
        cv_receipt: '派发任务',
        cv_plain: '只有标题',
      })
      store.setState('busyConversations', [])
      await flush()
      expect(store.petResults().find((r) => r.conversationId === 'cv_follow')?.title).toBe(
        '第二次的提问',
      )
    } finally {
      stop()
    }
  })

  test('当前会话运行中加入队列的消息进入会话流后，列表改为显示它；会话始终处于运行中', async () => {
    const store = await import('../../lib/store/index.ts')
    serveLedger()
    ledger.set('cv_queue', {
      title: '第一次的提问',
      latest: { content: '那你直接帮我配置好', origin: null },
      runs: [],
    })
    store.setState({ activeConversation: 'cv_queue', busyConversations: [] })
    store.openView('cv_queue')
    const stop = store.observePet()
    try {
      store.setState('busyConversations', ['cv_queue'])
      await flush()
      expect(store.petEntries()[0]?.title).toBe('那你直接帮我配置好')
      store.setState('views', 'cv_queue', 'transcript', (items) => [
        ...items,
        { id: 'm_next', kind: 'user' as const, text: '切换权限了' },
      ])
      await flush()
      expect(store.state.busyConversations).toEqual(['cv_queue'])
      expect(store.petEntries()[0]?.title).toBe('切换权限了')
    } finally {
      stop()
    }
  })

  test('子会话不计入运行中，也不记录结果', async () => {
    const store = await import('../../lib/store/index.ts')
    serveLedger()
    const now = Date.now()
    ledger.set('cv_child', {
      title: '子任务',
      parent: true,
      runs: [{ status: 'done', createdAt: now, finishedAt: now }],
    })
    store.setState({ busyConversations: ['cv_child'] })
    const stop = store.observePet()
    try {
      await flush()
      expect(store.petEntries().some((e) => e.conversationId === 'cv_child')).toBe(false)
      store.setState('busyConversations', [])
      await flush()
      expect(store.petResults().some((r) => r.conversationId === 'cv_child')).toBe(false)
    } finally {
      stop()
    }
  })

  test('操作电脑优先于其他状态；打开会话即移除其结果', async () => {
    const store = await import('../../lib/store/index.ts')
    serveLedger()
    store.setState('desktopTargets', [{ conversationId: 'cv_x', app: '微信', foreground: true }])
    expect(store.petMood()).toBe('desktop')
    store.setState('desktopTargets', [])
    const before = store.petResults().length
    expect(before).toBeGreaterThan(0)
    const id = store.petResults()[0]?.conversationId as string
    // 窗口可见且处于前台时，当前会话的结果视为已查看。
    const hasFocus = document.hasFocus.bind(document)
    document.hasFocus = () => true
    store.setState({ activeConversation: id })
    const stop = store.observePet()
    try {
      expect(store.petResults().some((r) => r.conversationId === id)).toBe(false)
      expect(store.petResults().length).toBe(before - 1)
    } finally {
      stop()
      document.hasFocus = hasFocus
    }
  })

  test('偏好保存在本机', async () => {
    const store = await import('../../lib/store/index.ts')
    store.setPetPrefs({ place: 'hidden' })
    expect(JSON.parse(localStorage.getItem('qywork.pet') ?? '{}')).toEqual({
      place: 'hidden',
      pack: null,
    })
    store.setPetPrefs({ place: 'desktop' })
    expect(store.petPrefs().place).toBe('desktop')
  })

  test('对话中的 apply 切换宠物包并读取；宠物被删除时切回内置宠物', async () => {
    const store = await import('../../lib/store/index.ts')
    const { setPetApply, setPetsChange } = await import('../../lib/store/connection.ts')
    const one = { frames: ['a.png'], fps: 1 }
    const entry = {
      id: 'pet-cat',
      pack: {
        name: '猫',
        size: 64,
        states: { desktop: one, failed: one, working: one, done: one, idle: one },
      },
      updatedAt: 5,
    }
    globalThis.fetch = (async () => new Response(JSON.stringify(entry))) as unknown as typeof fetch
    store.setState('connection', 'ready')
    const stop = store.observePet()
    try {
      setPetApply({ id: 'pet-cat', seq: 1 })
      await flush()
      expect(store.petPrefs().pack).toBe('pet-cat')
      expect(store.petPack()?.pack.name).toBe('猫')
      expect(store.petFrameUrl(entry, 'a.png')).toContain(
        '/api/pets/pet-cat/files/a.png?v=5&token=',
      )
      setPetsChange({ id: 'pet-cat', removed: true, seq: 1 })
      await flush()
      expect(store.petPrefs().pack).toBeNull()
      expect(store.petPack()).toBeNull()
    } finally {
      stop()
    }
  })
})

describe('宠物组件', () => {
  test('默认宠物包通过校验；单帧状态加动作，多帧状态换帧', async () => {
    const { parsePetPack } = await import('@qywork/core')
    const { DEFAULT_PET, defaultPetFrame } = await import('./pet-default.ts')
    expect(parsePetPack(DEFAULT_PET).ok).toBe(true)
    expect(defaultPetFrame('done.svg')).toStartWith('data:image/svg+xml')

    const { render } = await import('solid-js/web')
    const { createSignal } = await import('solid-js')
    const { PetSprite } = await import('./PetSprite.tsx')
    const [mood, setMood] = createSignal<'done' | 'working'>('done')
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(
      () => <PetSprite pack={DEFAULT_PET} state={mood()} frameUrl={(n) => `/f/${n}`} />,
      host,
    )
    try {
      const img = () => host.querySelector('img') as HTMLImageElement
      expect(img().getAttribute('src')).toBe('/f/done.svg')
      expect(img().classList.contains('pet-motion-done')).toBe(true)
      setMood('working')
      expect(img().getAttribute('src')).toBe('/f/working-1.svg')
      expect(img().classList.contains('pet-motion-working')).toBe(false)
      await new Promise((r) => setTimeout(r, 400))
      expect(img().getAttribute('src')).toBe('/f/working-2.svg')
    } finally {
      dispose()
      host.remove()
    }
  })

  /**
   * 外壳以注入的 `__TAURI_INTERNALS__` 模拟，只在用例期间存在，理由同 `WindowControls.test.tsx`。
   * `emit` 向页面注册的监听派发事件；`calls` 记录页面发出的全部调用。
   */
  function mockShell() {
    const calls: { cmd: string; args?: Record<string, unknown> }[] = []
    const callbacks = new Map<number, (payload: unknown) => void>()
    const listeners = new Map<string, number>()
    let next = 1
    const g = globalThis as Record<string, unknown>
    g.__TAURI_INTERNALS__ = {
      transformCallback: (cb: (payload: unknown) => void) => {
        callbacks.set(next, cb)
        return next++
      },
      invoke: async (cmd: string, args?: Record<string, unknown>) => {
        calls.push({ cmd, ...(args ? { args } : {}) })
        if (cmd === 'plugin:event|listen') listeners.set(String(args?.event), Number(args?.handler))
        return null
      },
    }
    const emit = (event: string, payload: unknown) =>
      callbacks.get(listeners.get(event) as number)?.({ payload })
    const emitted = (event: string) =>
      calls
        .filter((c) => c.cmd === 'plugin:event|emit_to' && c.args?.event === event)
        .map((c) => c.args)
    return { calls, emit, emitted, restore: () => delete g.__TAURI_INTERNALS__ }
  }

  async function petState(entries: unknown[], extra: Record<string, unknown> = {}) {
    const { DEFAULT_PET } = await import('./pet-default.ts')
    const frames = Object.fromEntries(
      Object.values(DEFAULT_PET.states).flatMap((a) => a.frames.map((f) => [f, `/f/${f}`])),
    )
    return {
      mood: 'working',
      badge: '2',
      bubble: null,
      entries,
      pack: DEFAULT_PET,
      frames,
      dark: true,
      accent: null,
      ...extra,
    }
  }

  async function until(check: () => boolean, ms = 2000): Promise<void> {
    const end = Date.now() + ms
    while (!check()) {
      if (Date.now() > end) throw new Error('等待超时')
      await new Promise((r) => setTimeout(r, 10))
    }
  }

  const running = [{ conversationId: 'cv_run', title: '运行中的任务', status: 'running' }]

  test('宠物窗口：按推送的状态显示（含个性化强调色），只按宠物包请求一次尺寸，单击交给任务框窗口，移动后上报宠物左下角', async () => {
    const { render } = await import('solid-js/web')
    const { PetWindow } = await import('./PetWindow.tsx')
    const shell = mockShell()
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => <PetWindow />, host)
    try {
      await flush()
      expect(shell.emitted('pet://ready')).toHaveLength(1)
      shell.emit('pet://state', await petState(running))
      await flush()
      const resizes = () => shell.calls.filter((c) => c.cmd === 'pet_window_resize')
      expect(resizes().map((c) => c.args)).toEqual([{ width: 92, height: 92 }])
      expect(host.querySelector('.petw-badge')?.textContent).toBe('2')
      expect(document.documentElement.getAttribute('data-theme')).toBe('dark')

      // 个性化的强调色写在根元素上（角标取它）；为 null 时移除，恢复主题的强调色。
      shell.emit(
        'pet://state',
        await petState(running, { accent: { color: 'rgba(168, 85, 247, 1)', fg: '#ffffff' } }),
      )
      await flush()
      const rootStyle = document.documentElement.style
      expect(rootStyle.getPropertyValue('--accent')).toBe('rgba(168, 85, 247, 1)')
      expect(rootStyle.getPropertyValue('--accent-fg')).toBe('#ffffff')
      shell.emit('pet://state', await petState(running))
      await flush()
      expect(rootStyle.getPropertyValue('--accent')).toBe('')

      // 单击只通知任务框窗口，宠物窗口不改变尺寸。
      const pet = host.querySelector('.petw-pet') as HTMLElement
      pet.dispatchEvent(
        new PointerEvent('pointerdown', { bubbles: true, button: 0, screenX: 5, screenY: 5 }),
      )
      pet.dispatchEvent(
        new PointerEvent('pointerup', { bubbles: true, button: 0, screenX: 5, screenY: 5 }),
      )
      await flush()
      expect(shell.emitted('pet://box-toggle')).toEqual([
        {
          target: { kind: 'WebviewWindow', label: 'pet-box' },
          event: 'pet://box-toggle',
          payload: null,
        },
      ])
      expect(resizes()).toHaveLength(1)

      shell.emit('pet://window-moved', { x: 640, y: 500 })
      expect(shell.emitted('pet://moved').at(-1)?.payload).toEqual({ left: 640, bottom: 592 })
    } finally {
      shell.restore()
      dispose()
      host.remove()
    }
  })

  test('任务框窗口：展开时先设置尺寸再显示内容，收起时先清空并缩小，从气泡改为列表时先缩小、等待空白画面再展开；停止与打开会话交给主窗口与外壳', async () => {
    const { render } = await import('solid-js/web')
    const { PetBox } = await import('./PetBox.tsx')
    const shell = mockShell()
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => <PetBox />, host)
    const placeCalls = () => shell.calls.filter((c) => c.cmd === 'pet_box_place').map((c) => c.args)
    try {
      await flush()
      expect(shell.emitted('pet://ready')).toHaveLength(1)
      const bubble = { conversationId: 'cv_done', title: '写好的报告', outcome: 'done' }
      shell.emit('pet://state', await petState([...running], { bubble }))
      await until(() => !!host.querySelector('.petw-bubble'))
      expect(placeCalls()).toEqual([{ width: 244, height: 34 }])
      expect(host.querySelector('.petw-bubble')?.textContent).toContain('写好的报告')

      // 单击宠物：气泡改为列表。先清空并缩小，空白画面之后再按一行的高度展开。
      shell.emit('pet://box-toggle', null)
      await flush()
      expect(host.querySelector('.petw-bubble')).toBeNull()
      expect(placeCalls().at(-1)).toEqual({ width: 0, height: 0 })
      await until(() => !!host.querySelector('.petw-menu'))
      expect(placeCalls().slice(1)).toEqual([
        { width: 0, height: 0 },
        { width: 244, height: 40 },
      ])

      // 内容相同的推送不重建行：重建会使按下与抬起落在不同的节点上，点击丢失。
      // 主窗口每次推送的都是新对象（经 IPC 序列化），因此传副本。
      const row = host.querySelector('.petw-row-main')
      shell.emit('pet://state', await petState(structuredClone(running), { bubble }))
      await flush()
      expect(host.querySelector('.petw-row-main')).toBe(row)

      // 打开期间新增条目时高度随之增加，不在框内滚动。
      const two = [
        ...running,
        { conversationId: 'cv_run2', title: '第二个任务', status: 'running' },
      ]
      shell.emit('pet://state', await petState(two, { bubble }))
      await until(() => placeCalls().length === 5 && !!host.querySelector('.petw-menu'))
      expect(host.querySelectorAll('.petw-row-main')).toHaveLength(2)
      expect(placeCalls().slice(3)).toEqual([
        { width: 0, height: 0 },
        { width: 244, height: 70 },
      ])

      ;(host.querySelector('.petw-stop') as HTMLButtonElement).click()
      ;(host.querySelector('.petw-row-main') as HTMLButtonElement).click()
      await flush()
      expect(shell.calls).toContainEqual({
        cmd: 'plugin:event|emit_to',
        args: {
          target: { kind: 'WebviewWindow', label: 'main' },
          event: 'pet://action',
          payload: { type: 'stop', id: 'cv_run' },
        },
      })
      expect(shell.calls).toContainEqual({
        cmd: 'pet_open_main',
        args: { conversationId: 'cv_run' },
      })
      // 打开会话后列表关闭，回到气泡：同样先缩小再展开。
      await until(() => !!host.querySelector('.petw-bubble'))
      expect(placeCalls().slice(5)).toEqual([
        { width: 0, height: 0 },
        { width: 244, height: 34 },
      ])

      // 没有气泡与条目时收起；没有条目时单击不展开，改为只唤起主窗口（不带会话）。
      shell.emit('pet://state', await petState([]))
      await until(() => !host.querySelector('.petw-bubble'))
      expect(placeCalls().at(-1)).toEqual({ width: 0, height: 0 })
      const count = placeCalls().length
      shell.emit('pet://box-toggle', null)
      await new Promise((r) => setTimeout(r, 150))
      expect(placeCalls()).toHaveLength(count)
      expect(host.querySelector('.petw-menu')).toBeNull()
      expect(shell.calls.at(-1)).toEqual({ cmd: 'pet_open_main', args: {} })
    } finally {
      shell.restore()
      dispose()
      host.remove()
    }
  })
})
