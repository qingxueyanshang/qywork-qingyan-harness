/**
 * 右侧面板的概要页。
 *
 * 覆盖范围（B6）：`OverviewPanel.tsx`；`store/events/session.ts` 对 `commands.changed` 的折叠；
 * `store/actions.ts` 的 `stopBackgroundCommand`；概要页读取的 `/api/conversations/:id/board`。
 */
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})

let restore: (() => void) | undefined
afterEach(async () => {
  // 先关闭页签再还原接口：关闭页签同步到服务端，还原后的接口会向不存在的服务发出请求。
  const store = await import('../lib/store/index.ts')
  for (const t of store.panelTabs()) store.closePanelTab(t.id)
  restore?.()
  restore = undefined
  document.body.replaceChildren()
  store.setState({
    activeConversation: null,
    backgroundCommands: [],
    todos: [],
    busyConversations: [],
    views: {},
  })
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

function click(button: Element) {
  const event = new MouseEvent('click', { bubbles: true })
  const delegated = (button as unknown as { $$click?: (event: MouseEvent) => void }).$$click
  if (delegated) {
    delegated.call(button, event)
    return
  }
  button.dispatchEvent(event)
}

async function waitFor(done: () => boolean, detail: () => string) {
  for (let i = 0; i < 100; i += 1) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`界面未在时限内更新：${detail()}`)
}

/** 渲染概要页。`board` 为 `/board` 接口的响应，记录每次请求的路径。 */
async function mount(board: unknown) {
  const { render } = await import('solid-js/web')
  const store = await import('../lib/store/index.ts')
  const { OverviewPanel } = await import('./OverviewPanel.tsx')
  const calls: string[] = []
  const api = store.client.api
  ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (path) => {
    calls.push(path)
    return board
  }
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <OverviewPanel />, host as unknown as HTMLElement)
  restore = () => {
    dispose()
    store.client.api = api
  }
  return { host, calls, store }
}

const heads = (host: Element) =>
  [...host.querySelectorAll('.overview-head')].map((h) => h.textContent)

test('后台任务：当前会话的快照每项一行，点击停止发送 command.stop；其他会话的快照不显示', async () => {
  const { host, store } = await mount({ subagents: [], canvases: [] })
  store.setWorkspace({ id: 'ws_board', root: 'C:/work', name: 'work' })
  store.setState({ activeConversation: 'cv_bg', backgroundCommands: [] })
  store.openView('cv_bg')
  const snapshot = (conversationId: string, commands: { id: string; command: string }[]) =>
    store.applyEvent({
      seq: 1,
      at: 0,
      conversationId,
      event: { type: 'commands.changed', conversationId, commands },
    } as never)
  const sent: unknown[] = []
  const send = store.client.send
  store.client.send = (command) => sent.push(command)
  try {
    expect(host.querySelector('.overview-row')).toBeNull()
    snapshot('cv_bg', [{ id: 'cmd_1', command: 'npm run dev' }])
    snapshot('cv_other', [{ id: 'cmd_9', command: 'npm test' }])
    expect(heads(host)).toEqual(['后台任务'])
    const rows = host.querySelectorAll('.overview-row')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.textContent).toContain('npm run dev')

    click(rows[0]!.querySelector('button')!)
    expect(sent).toEqual([{ type: 'command.stop', conversationId: 'cv_bg', id: 'cmd_1' }])
    // 行的去留只以服务端快照为准：停止之后由下一份快照移除。
    expect(host.querySelectorAll('.overview-row')).toHaveLength(1)
    snapshot('cv_bg', [])
    expect(host.querySelector('.overview-row')).toBeNull()
  } finally {
    store.client.send = send
  }
})

test('四组按待办、画布、后台任务、子 agent 排列；子 agent 运行状态取自忙态，点击打开子会话页与画布页', async () => {
  const { host, calls, store } = await mount({
    subagents: [
      { id: 'cv_review', title: '代码审查', kind: 'role' },
      { id: 'cv_cli', title: 'OpenAI codex', kind: 'cli' },
    ],
    canvases: ['分镜/第1集.canvas.json'],
  })
  store.setWorkspace({ id: 'ws_board', root: 'C:/work', name: 'work' })
  store.openView('cv_main')
  store.setState({
    activeConversation: 'cv_main',
    todos: [{ id: 't1', content: '整理分镜', status: 'in_progress' }],
    backgroundCommands: [{ id: 'cmd_1', command: 'npm run dev' }],
    busyConversations: ['cv_main', 'cv_review'],
  })
  await waitFor(
    () => heads(host).length === 4,
    () => `组标题：${heads(host).join('、')}；请求：${calls.join('、')}`,
  )
  expect(heads(host)).toEqual(['待办', '画布', '后台任务', '子 agent'])
  expect(calls).toContain('/api/conversations/cv_main/board')

  const agents = [...host.querySelectorAll('.overview-section')][3]!
  const rows = [...agents.querySelectorAll('.overview-row')]
  expect(rows.map((r) => r.textContent)).toEqual(['代码审查', 'OpenAI codex'])
  expect(rows.map((r) => r.classList.contains('running'))).toEqual([true, false])
  // 外部 CLI 的输出记录在派发卡上；卡片未加载时没有可打开的页，该行不是按钮。
  expect(rows.map((r) => r.tagName)).toEqual(['BUTTON', 'DIV'])

  click(rows[0]!)
  expect(store.panelTabs().at(-1)).toMatchObject({ kind: 'conversation', title: '代码审查' })

  const canvas = [...host.querySelectorAll('.overview-section')][1]!.querySelector('button')!
  expect(canvas.textContent).toBe('第1集')
  click(canvas)
  expect(store.panelTabs().at(-1)).toMatchObject({
    kind: 'canvas',
    path: '分镜/第1集.canvas.json',
  })
})

test('外部 CLI 子 agent 在派发卡已加载时打开其输出页', async () => {
  const { host, store } = await mount({
    subagents: [{ id: 'cv_cli', title: 'OpenAI codex', kind: 'cli' }],
    canvases: [],
  })
  store.setWorkspace({ id: 'ws_board', root: 'C:/work', name: 'work' })
  store.setState({ activeConversation: 'cv_main' })
  store.openView('cv_main')
  store.setState('views', 'cv_main', 'transcript', [
    {
      id: 'st_dispatch',
      kind: 'tool',
      toolName: 'delegate_task',
      status: 'success',
      nodes: {
        main: { phase: 'done', label: 'OpenAI codex', kind: 'cli', subagentId: 'cv_cli' },
      },
    },
  ] as never)
  await waitFor(
    () => host.querySelector('button.overview-row') !== null,
    () => host.innerHTML,
  )
  click(host.querySelector('button.overview-row')!)
  expect(store.panelTabs().at(-1)).toMatchObject({ kind: 'cli', title: 'OpenAI codex' })
  expect(store.panelTabs().at(-1)?.id).toBe('cli-st_dispatch-main')
})

test('切换会话后不显示上一会话的子 agent 与画布', async () => {
  const store = await import('../lib/store/index.ts')
  const boards: Record<string, unknown> = {
    '/api/conversations/cv_a/board': {
      subagents: [{ id: 'cv_a1', title: '甲', kind: 'temp' }],
      canvases: [],
    },
  }
  let releaseB: (() => void) | undefined
  const { host } = await mount(null)
  ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = (path) =>
    path in boards
      ? Promise.resolve(boards[path])
      : new Promise((resolve) => {
          releaseB = () => resolve({ subagents: [], canvases: [] })
        })
  store.openView('cv_a')
  store.openView('cv_b')
  store.setState({ activeConversation: 'cv_a' })
  await waitFor(
    () => host.textContent?.includes('甲') === true,
    () => host.innerHTML,
  )
  store.setState({ activeConversation: 'cv_b' })
  // 新会话的结果尚未到达：上一会话的子 agent 不得显示在新会话下。
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(host.textContent).not.toContain('甲')
  releaseB?.()
})
