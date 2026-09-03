/**
 * 子 agent 页：按账本列出这条会话的子 agent 与工作流，点一行翻开它那条子会话。
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/' })
})

let dispose: (() => void) | undefined
let restoreApi: (() => void) | undefined

afterEach(async () => {
  dispose?.()
  dispose = undefined
  document.body.replaceChildren()
  restoreApi?.()
  restoreApi = undefined
  const store = await import('../lib/store/index.ts')
  store.setState({ activeConversation: null, connection: 'connecting', views: {} })
  for (const t of store.panelTabs()) store.closePanelTab(t.id)
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

async function waitFor(done: () => boolean, detail: () => string) {
  for (let i = 0; i < 100; i += 1) {
    if (done()) return
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`界面没有在时限内更新：${detail()}`)
}

describe('子 agent 页', () => {
  test('列出子 agent 与工作流的每一格，点内置子 agent 翻开它的会话', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (
      path: string,
    ) => {
      if (!path.endsWith('/subagents')) throw new Error(`意外请求 ${path}`)
      return {
        subagents: [
          {
            id: 'cv_glm',
            kind: 'temp',
            name: 'GLM 版',
            provider: 'p',
            model: 'glm-5.3-flash',
            status: 'idle',
            createdAt: 1,
          },
          {
            id: 'cv_codex',
            kind: 'cli',
            name: 'OpenAI codex',
            provider: 'cli',
            model: 'codex',
            status: 'running',
            createdAt: 2,
          },
        ],
        workflows: [
          {
            workflowId: 'st_wf',
            goal: '四个候选',
            phase: 'waiting_review',
            checkpointId: 'audit',
            nodes: [
              { id: 'build.glm', label: 'GLM 版', phase: 'done', subagentId: 'cv_glm' },
              { id: 'build.qwen', label: 'Qwen 版', phase: 'interrupted' },
            ],
          },
        ],
      }
    }
    restoreApi = () => {
      ;(store.client as unknown as { api: typeof originalApi }).api = originalApi
    }
    store.setState({ activeConversation: 'cv_parent', connection: 'ready' })

    const { render } = await import('solid-js/web')
    const { default: SubagentsPanel } = await import('./SubagentsPanel.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <SubagentsPanel />, host as unknown as HTMLElement)

    await waitFor(
      () => host.querySelectorAll('.sub-row').length === 4,
      () => host.innerHTML,
    )
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.sub-row')]
    expect(rows.map((r) => r.textContent)).toEqual([
      'GLM 版临时 · glm-5.3-flash空闲',
      'OpenAI codex外部 CLI · codex进行中',
      'build.glmGLM 版完成',
      'build.qwenQwen 版中断',
    ])
    // 外部 CLI 与没起过子 agent 的格点不开：账本上没有可翻开的会话。
    expect(rows.map((r) => r.disabled)).toEqual([false, true, false, true])
    expect(host.querySelector('.sub-group-head')?.textContent).toBe('四个候选待审查')

    rows[0]!.click()
    expect(store.panelTabs().map((t) => [t.kind, t.title])).toEqual([['conversation', 'GLM 版']])
  })
})
