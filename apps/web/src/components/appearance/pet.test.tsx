/**
 * 覆盖 `lib/store/appearance/pet.ts`（心情推导、未查看结果、气泡与偏好）、`PetSprite.tsx`、`PetDock.tsx`
 * 与 `pet-default.ts`（默认宠物包须通过 core 的校验）。
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

/** 会话 id → 会话行与轮次。未登记的会话返回 404。 */
const ledger = new Map<string, { title: string; parent?: boolean; runs: RunRow[] }>()

function serveLedger(): void {
  globalThis.fetch = (async (input: string) => {
    const url = new URL(String(input), 'http://localhost')
    const m = /^\/api\/conversations\/([^/]+)(\/runs)?$/.exec(url.pathname)
    const row = m ? ledger.get(decodeURIComponent(m[1] as string)) : undefined
    if (!m || !row) return new Response('{}', { status: 404 })
    if (m[2]) return new Response(JSON.stringify({ runs: row.runs, childRuns: [] }))
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
    store.setPetPrefs({ place: 'app' })
    expect(store.petPrefs().place).toBe('app')
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

  test('列表显示运行中与结果，运行中的可停止', async () => {
    const store = await import('../../lib/store/index.ts')
    const { render } = await import('solid-js/web')
    const { DEFAULT_PET, defaultPetFrame } = await import('./pet-default.ts')
    const { PetDock } = await import('./PetDock.tsx')
    const sent: unknown[] = []
    const send = store.client.send.bind(store.client)
    store.client.send = (cmd) => {
      sent.push(cmd)
    }
    serveLedger()
    ledger.set('cv_run', { title: '运行中的任务', runs: [] })
    store.setState({ busyConversations: ['cv_run'] })
    const host = document.createElement('div')
    document.body.append(host)
    const dispose = render(() => <PetDock pack={DEFAULT_PET} frameUrl={defaultPetFrame} />, host)
    try {
      ;(host.querySelector('.pet-button') as HTMLButtonElement).click()
      await flush()
      const rows = [...document.querySelectorAll('.pet-row')]
      expect(rows.length).toBeGreaterThan(0)
      ;(document.querySelector('.pet-row-stop') as HTMLButtonElement).click()
      expect(sent).toContainEqual({ type: 'conversation.interrupt', conversationId: 'cv_run' })
    } finally {
      store.client.send = send
      store.setState({ busyConversations: [] })
      dispose()
      host.remove()
    }
  })
})
