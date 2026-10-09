/**
 * 运行页的清单与合计。
 *
 * 锁定的失败形状：四个子 agent 运行数十分钟、产生数元费用，而运行页只查询当前会话，
 * 这些费用均未显示。子会话的轮次必须以与本会话轮次相同的行格式出现在清单中，
 * 并计入合计；行上须标明该轮派发给哪个角色。
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
  test('子会话的轮次计入清单与合计，行上显示角色 id', async () => {
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
    // 轮次合计为三轮，包含子会话的轮次，不只是本会话的一轮。
    const stats = [...host.querySelectorAll('.run-stat')].map((el) => el.textContent)
    expect(stats.some((text) => text?.startsWith('轮次3'))).toBe(true)
    // 金额按币种分别合计，不跨币种相加。
    const cost = host.querySelector('.run-sum-cost')?.textContent ?? ''
    expect(cost).toContain('3')
    expect(cost).toContain('4')
    // 边界声明仅保留「不含外部 CLI」一句。
    expect(host.querySelector('.run-sum-note')?.textContent).toBe('不含外部 CLI')
  })

  /** 轮次内的压缩请求显示在该轮次的逐请求表中；带 runId 的账本行不单独成行。 */
  test('带 runId 的摘要账本行不单独成行，未记录轮次的按时间排在轮次之间', async () => {
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
    // 倒序：rn_b、未记录轮次的条目、rn_a；带 runId 的条目不显示。
    expect(rows[1]!.classList.contains('static')).toBe(true)
    expect(rows[1]!.querySelector('.run-mark')?.textContent).toBe('压缩摘要')
    expect(host.querySelectorAll('.run-row.static')).toHaveLength(1)
  })

  /**
   * 原始失败形状：某一轮生成了图片，面板上该轮的金额与逐请求表均未包含这项费用。
   * 生成费用计入该轮金额（不同币种并列显示），展开后逐请求表中每次生成占一行；
   * 账本中带 runId 的生成行归属该轮，不单独成行。
   */
  test('生成费用计入所在轮次的金额，展开后在逐请求表中占一行', async () => {
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
    expect(host.querySelector('.run-req tbody tr')?.getAttribute('data-tip')).toBe('qwen-image-3.0')
  })

  /** 原始失败形状：模型按约定停下等待用户确认，运行页却以红色标为「模型执行出错，多次重复」。 */
  test('等待用户回复的轮次不标红，连续无进展的轮次标红', async () => {
    const store = await import('../lib/store/index.ts')
    const originalApi = store.client.api
    ;(store.client as unknown as { api: (path: string) => Promise<unknown> }).api = async (
      path: string,
    ) => {
      if (path.endsWith('/runs')) {
        return {
          runs: [
            { ...run('rn_wait', 1, 'USD'), stopReason: 'awaiting_user' },
            { ...run('rn_loop', 1, 'USD'), status: 'failed', stopReason: 'no_progress' },
          ],
        }
      }
      if (path.endsWith('/usage')) return { totals: { entries: 0, cost: {} }, entries: [] }
      if (path.startsWith('/api/usage')) return { totals: { cost: {} } }
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
      () => host.querySelectorAll('.run-mark').length === 2,
      () => `清单里有 ${host.querySelectorAll('.run-mark').length} 个标记`,
    )
    const marks = [...host.querySelectorAll('.run-mark')].map((el) => [
      el.textContent,
      el.classList.contains('bad'),
    ])
    expect(marks.sort()).toEqual([
      ['模型执行出错，多次重复，已暂停', true],
      ['等待用户回复', false],
    ])
  })
})
