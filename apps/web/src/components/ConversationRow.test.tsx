/**
 * 覆盖 `ConversationRow.tsx` 的删除路径，以及 `Sidebar.tsx` 里承接它的那一格
 * （`.side-error`）——两条失败语义必须落在同一处，所以连着侧栏一起挂起来测。
 *
 * 原始失败形状是：会话删掉了、空间没收回来，而界面上一个字都没有。服务端把这两件事分开回
 * （`{ ok: true, reclaimError }`），前端也必须分开：会话行照常消失，那一句挂在既有的提示格上，
 * 不冒充「删除失败」——用户看到删除失败会再点一次，第二次收到的是 404。
 *
 * **DOM 在这里装，用完卸掉**，理由同 `LoadState.test.tsx`。
 *
 * **装完必须重新 `delegateEvents(['click'])`。** Solid 把 `onClick` 编译成事件委托：监听器挂在
 * `document` 上，由编译产物在模块求值时调一次 `delegateEvents` 装上，并把已装的事件名记在那个
 * `document` 自己身上。`App.tsx` 静态 import 了 `Sidebar.tsx` → `ConversationRow.tsx`，所以这两个
 * 模块在 `App.test.tsx` 那一份 `document` 上就求过值了；那份 `document` 被它的 `afterAll` 卸掉之后，
 * 这里 `register()` 出来的是新的一份，而模块已缓存、`delegateEvents` 不会再跑——新文档上没有任何
 * click 监听器，`.click()` 一律石沉大海。补这一句是修隔离，不是放宽判据。
 * 走 `lazy()` 的组件（`SidePanel.tsx`、设置页）碰不到这条，它们在各自的测试里才第一次求值。
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Conversation } from '@qywork/core'

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
  const { delegateEvents } = await import('solid-js/web')
  delegateEvents(['click'])
})

let dispose: (() => void) | undefined
let restoreApi: (() => void) | undefined

const CONVERSATION: Conversation = {
  id: 'cv_1' as Conversation['id'],
  workspaceId: 'ws_1' as Conversation['workspaceId'],
  title: '删掉这一条',
  provider: 'fake',
  model: 'deepseek-v4-flash',
  compactionManifest: null,
  cacheGeneration: 0,
  source: null,
  sourceRef: null,
  externalSession: null,
  parentConversationId: null,
  createdAt: 1,
  updatedAt: 2,
}

beforeEach(async () => {
  const store = await import('../lib/store/index.ts')
  store.setState({ connection: 'ready', conversations: [CONVERSATION], activeConversation: null })
  store.setWorkspace({ id: 'ws_1', root: 'C:\\work', name: 'work' })
})

afterEach(async () => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  restoreApi?.()
  restoreApi = undefined
  const store = await import('../lib/store/index.ts')
  store.setWorkspace(null)
  store.setState({ conversations: [], activeConversation: null })
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function waitFor(done: () => boolean, detail: () => string) {
  for (let i = 0; i < 200; i += 1) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`界面没有在时限内更新：${detail()}`)
}

/** 侧栏挂起来要一份项目清单；删除那一条按调用方给的应答回。 */
async function mountSidebar(onDelete: () => unknown) {
  const store = await import('../lib/store/index.ts')
  const original = store.client.api
  ;(
    store.client as unknown as { api: (path: string, init?: RequestInit) => Promise<unknown> }
  ).api = async (path: string, init?: RequestInit) => {
    if (path === '/api/workspaces') {
      return {
        workspaces: [
          {
            id: 'ws_1',
            rootPath: 'C:\\work',
            name: 'work',
            lastOpenedAt: 1,
            conversations: 1,
          },
        ],
      }
    }
    if (path.startsWith('/api/conversations/cv_1') && init?.method === 'DELETE') return onDelete()
    throw new Error(`没有桩这条：${path}`)
  }
  restoreApi = () => {
    ;(store.client as unknown as { api: typeof original }).api = original
  }

  const { render } = await import('solid-js/web')
  const { Sidebar } = await import('./Sidebar.tsx')
  const host = document.createElement('div')
  document.body.append(host)
  dispose = render(() => <Sidebar />, host as unknown as HTMLElement)
  await waitFor(
    () => host.querySelector('.conv-row') !== null,
    () => host.textContent ?? '',
  )
  return host
}

/** 走完「⋯ → 删除 → 确认」。 */
async function confirmDelete(host: HTMLElement) {
  host.querySelector<HTMLButtonElement>('.conv-more')?.click()
  await waitFor(
    () => host.querySelector('.conv-menu-item.danger') !== null,
    () => '菜单没展开',
  )
  host.querySelector<HTMLButtonElement>('.conv-menu-item.danger')?.click()
  await waitFor(
    () => host.querySelector('.confirm-actions .btn-primary') !== null,
    () => '确认框没出来',
  )
  host.querySelector<HTMLButtonElement>('.confirm-actions .btn-primary')?.click()
}

describe('删除会话的两种失败语义', () => {
  test('删掉了但空间没收回来：行照常消失，那一句落在侧栏既有的提示格上', async () => {
    const host = await mountSidebar(() => ({
      ok: true,
      reclaimError: '正文回收失败：database is locked',
    }))
    await confirmDelete(host)

    await waitFor(
      () => host.querySelector('.side-error') !== null,
      () => host.textContent ?? '',
    )
    expect(host.querySelector('.side-error')?.textContent).toBe('正文回收失败：database is locked')
    // 会话确实删掉了——这一句不是「删除失败」，再点一次只会拿到 404。
    expect(host.querySelectorAll('.conv-row').length).toBe(0)
  })

  test('删除本身失败：同一格给出原文，会话行还在', async () => {
    const host = await mountSidebar(() => {
      throw new Error('404 /api/conversations/cv_1')
    })
    await confirmDelete(host)

    await waitFor(
      () => host.querySelector('.side-error') !== null,
      () => host.textContent ?? '',
    )
    expect(host.querySelector('.side-error')?.textContent).toBe('404 /api/conversations/cv_1')
    expect(host.querySelectorAll('.conv-row').length).toBe(1)
  })

  test('回收也成功时不留任何提示', async () => {
    const host = await mountSidebar(() => ({ ok: true }))
    await confirmDelete(host)

    await waitFor(
      () => host.querySelectorAll('.conv-row').length === 0,
      () => host.textContent ?? '',
    )
    expect(host.querySelector('.side-error')).toBeNull()
  })
})
