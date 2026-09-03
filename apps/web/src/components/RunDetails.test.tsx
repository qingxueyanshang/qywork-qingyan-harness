/**
 * 运行页的清单与合计。
 *
 * 锁的是一条真实失败形状：四个子 agent 跑了几十分钟、几块钱，而这一页只查当前会话，
 * 那几笔钱一分都不显示。子会话的轮次必须与本会话的轮次同一行型出现在清单里，
 * 并且进合计；行上要说得出这一轮是派给谁的。
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

function run(id: string, cost: number, currency: 'USD' | 'CNY') {
  return {
    id,
    conversationId: 'cv_parent',
    workspaceId: 'ws_1',
    model: 'deepseek-v4-flash',
    status: 'done',
    stopReason: 'completed',
    stepCount: 3,
    createdAt: 1_700_000_000_000,
    finishedAt: 1_700_000_002_000,
    usage: { cost, currency, turns: [] },
  }
}

describe('运行页', () => {
  test('子会话的轮次进清单也进合计，行上带角色 id', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (
      path: string,
    ) => {
      if (path.endsWith('/runs')) {
        return {
          runs: [run('rn_parent', 1, 'USD')],
          childRuns: [
            { roleId: 'build-glm', run: run('rn_glm', 2, 'USD') },
            { roleId: 'build-qwen', run: run('rn_qwen', 4, 'CNY') },
          ],
        }
      }
      if (path.endsWith('/usage')) {
        return {
          totals: {
            entries: 3,
            inputTokens: 300,
            outputTokens: 150,
            cachedTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: 0,
            cost: { USD: 3, CNY: 4 },
          },
          entries: [],
        }
      }
      if (path.startsWith('/api/usage')) return { totals: { cost: { USD: 9 } } }
      return {}
    }
    restoreApi = () => {
      ;(store.client as unknown as { api: unknown }).api = originalApi
    }
    store.setState({ activeConversation: 'cv_parent', connection: 'ready' })

    const { render } = await import('solid-js/web')
    const { default: RunDetails } = await import('./RunDetails.tsx')
    const host = document.createElement('div')
    document.body.append(host)
    dispose = render(() => <RunDetails />, host as unknown as HTMLElement)

    await waitFor(
      () => host.querySelectorAll('.run-row').length === 3,
      () => `清单里只有 ${host.querySelectorAll('.run-row').length} 行`,
    )
    const roles = [...host.querySelectorAll('.run-role')].map((el) => el.textContent)
    expect(roles.sort()).toEqual(['build-glm', 'build-qwen'])
    // 轮次合计数的是三条，不是本会话那一条。
    const stats = [...host.querySelectorAll('.run-stat')].map((el) => el.textContent)
    expect(stats.some((text) => text?.startsWith('轮次3'))).toBe(true)
    // 金额按币种分桶，不跨币种相加。
    const cost = host.querySelector('.run-sum-cost')?.textContent ?? ''
    expect(cost).toContain('3')
    expect(cost).toContain('4')
    // 边界只留这一句。
    expect(host.querySelector('.run-sum-note')?.textContent).toBe('不含外部 CLI')
  })
})
