/**
 * 覆盖 `ConversationRow.tsx` 的删除路径，以及 `Sidebar.tsx` 中承接它的提示区域
 * （`.side-error`）。两种失败语义必须显示在同一处，因此连同侧栏一起挂载测试。
 *
 * 原始失败形状：会话已删除、空间未回收，而界面上没有任何提示。服务端分别返回这两件事
 * （`{ ok: true, reclaimError }`），前端也必须分别处理：会话行照常消失，该提示显示在既有的提示区域中，
 * 不显示为「删除失败」：用户看到删除失败会再点击一次，第二次收到的是 404。
 *
 * 测试 DOM 在本文件内注册，结束后注销，理由同 `LoadState.test.tsx`。
 *
 * **注册后必须重新调用 `delegateEvents(['click'])`。** Solid 把 `onClick` 编译为事件委托：监听器注册在
 * `document` 上，由编译产物在模块求值时调用一次 `delegateEvents` 完成注册，并把已注册的事件名记录在该
 * `document` 对象上。`App.tsx` 静态导入了 `Sidebar.tsx` → `ConversationRow.tsx`，因此这两个
 * 模块已在 `App.test.tsx` 的 `document` 上求值；该 `document` 被其 `afterAll` 注销之后，
 * 此处 `register()` 创建的是新的 `document`，而模块已缓存，`delegateEvents` 不会再次执行，新文档上没有任何
 * click 监听器，`.click()` 均无响应。重新调用是为了修复测试隔离，不是放宽判据。
 * 经由 `lazy()` 加载的组件（`SidePanel.tsx`、设置页）不受此影响，它们在各自的测试中才首次求值。
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

/** 挂载侧栏需要一份项目清单；删除请求按调用方提供的应答返回。 */
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

/** 依次执行「⋯ → 删除 → 确认」。 */
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
  test('会话已删除但空间未回收：行照常消失，提示显示在侧栏既有的提示区域中', async () => {
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
    // 会话已删除：该提示不是「删除失败」，再点击一次只会得到 404。
    expect(host.querySelectorAll('.conv-row').length).toBe(0)
  })

  test('删除本身失败：同一提示区域显示原文，会话行保留', async () => {
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

  test('回收也成功时不显示任何提示', async () => {
    const host = await mountSidebar(() => ({ ok: true }))
    await confirmDelete(host)

    await waitFor(
      () => host.querySelectorAll('.conv-row').length === 0,
      () => host.textContent ?? '',
    )
    expect(host.querySelector('.side-error')).toBeNull()
  })
})
