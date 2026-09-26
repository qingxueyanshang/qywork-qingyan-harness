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
            { name: 'GLM 车组', run: run('rn_glm', 2, 'USD') },
            { name: 'Qwen 车组', run: run('rn_qwen', 4, 'CNY') },
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
    expect(roles.sort()).toEqual(['GLM 车组', 'Qwen 车组'])
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

  /** 一轮之内的压缩请求在那一轮的逐请求表里；带 runId 的账本行不再单列成一行。 */
  test('带 runId 的摘要账本行不单列，没记轮次的按时间排在轮次之间', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    const entry = (id: string, runId: string | null, occurredAt: number) => ({
      id,
      kind: 'summary',
      runId,
      model: 'omen-alpha',
      inputTokens: 1,
      outputTokens: 1,
      cachedTokens: null,
      cacheWriteTokens: null,
      cost: 0,
      currency: 'USD',
      occurredAt,
    })
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (
      path: string,
    ) => {
      if (path.endsWith('/runs')) {
        return {
          runs: [
            run('rn_a', 1, 'USD'),
            {
              ...run('rn_b', 1, 'USD'),
              createdAt: 1_700_000_100_000,
              finishedAt: 1_700_000_200_000,
            },
          ],
          childRuns: [],
        }
      }
      if (path.endsWith('/usage')) {
        return {
          totals: {
            entries: 4,
            inputTokens: 2,
            outputTokens: 2,
            cachedTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: 0,
            cost: { USD: 2 },
          },
          entries: [
            entry('ug_in', 'rn_b', 1_700_000_150_000),
            entry('ug_loose', null, 1_700_000_050_000),
          ],
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
    const rows = [...host.querySelectorAll('.run-row')]
    // 倒序：rn_b、没记轮次的那笔、rn_a；带 runId 的那笔不出现。
    expect(rows[1]!.classList.contains('static')).toBe(true)
    expect(rows[1]!.querySelector('.run-mark')?.textContent).toBe('压缩摘要')
    expect(host.querySelectorAll('.run-row.static')).toHaveLength(1)
  })

  /**
   * 原始失败形状：一轮里生成了图片，面板上这一轮的金额与逐请求表都看不到这笔花费。
   * 生成花费计入这一轮的金额（不同币种并列），展开后逐请求表里一次生成占一行；
   * 账本里带 runId 的生成行属于这一轮，不单列。
   */
  test('生成花费计入这一轮的金额，展开后在逐请求表里占一行', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    const withMedia = {
      ...run('rn_m', 0.01, 'USD'),
      usage: {
        cost: 0.01,
        currency: 'USD',
        turns: [],
        media: [
          {
            kind: 'dashscope_images',
            provider: 'qwen',
            model: 'qwen-image-3.0',
            output: 'image',
            quantity: 1,
            cost: 0.18,
            currency: 'CNY',
            at: 1_700_000_001_000,
          },
        ],
      },
    }
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (
      path: string,
    ) => {
      if (path.endsWith('/runs')) return { runs: [withMedia], childRuns: [] }
      if (path.endsWith('/requests')) return { requests: [] }
      if (path.endsWith('/usage')) {
        return {
          totals: {
            entries: 2,
            inputTokens: 10,
            outputTokens: 5,
            cachedTokens: null,
            cacheWriteTokens: null,
            reasoningTokens: 0,
            cost: { USD: 0.01, CNY: 0.18 },
          },
          entries: [
            {
              id: 'ug_media',
              kind: 'media',
              runId: 'rn_m',
              model: 'qwen-image-3.0',
              inputTokens: 0,
              outputTokens: 0,
              cachedTokens: null,
              cacheWriteTokens: null,
              cost: 0.18,
              currency: 'CNY',
              occurredAt: 1_700_000_001_000,
            },
          ],
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
      () => host.querySelectorAll('.run-row').length === 1,
      () => `清单里有 ${host.querySelectorAll('.run-row').length} 行`,
    )
    const row = host.querySelector<HTMLButtonElement>('.run-row')!
    expect(row.querySelector('.run-money')?.textContent).toBe('¥0.18 + $0.01')
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await waitFor(
      () => host.querySelectorAll('.run-req tbody tr').length === 1,
      () => `逐请求表有 ${host.querySelectorAll('.run-req tbody tr').length} 行`,
    )
    const cells = [...host.querySelectorAll('.run-req tbody tr td')].map((td) => td.textContent)
    expect(cells).toEqual(['图像', 'N/A', '1 张', 'N/A', 'N/A', '¥0.18', '已完成'])
    expect(host.querySelector('.run-req tbody tr')?.getAttribute('title')).toBe('qwen-image-3.0')
  })
})
