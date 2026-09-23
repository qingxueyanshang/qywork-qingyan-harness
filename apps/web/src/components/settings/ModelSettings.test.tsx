/** 覆盖检测结果的思考观察、参数校验及连接失败显示。 */
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { ProbeResult } from '../../lib/store/index.ts'

beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/' }))
afterAll(async () => {
  document.body.replaceChildren()
  await GlobalRegistrator.unregister()
})

test('思考已观察但参数未确认时分别显示；未观察不显示为不支持', async () => {
  const { createSignal } = await import('solid-js')
  const { render } = await import('solid-js/web')
  const { ProbeSummary } = await import('./ModelSettings.tsx')
  const initial: ProbeResult = {
    outcome: {
      reachable: true,
      untested: [],
      inconclusive: ['effort'],
      effortSource: 'probe',
      effortLevels: ['low', 'high'],
      thinkingObserved: true,
      probes: [{ name: '非法值对照', ok: false, inconclusive: true, detail: '接口接受了非法档位' }],
    },
    transport: {},
  }
  const [result, setResult] = createSignal(initial)
  const host = document.createElement('div')
  document.body.append(host)
  const dispose = render(() => <ProbeSummary result={result()} />, host)
  try {
    expect(host.textContent).toContain('已观察到思考')
    expect(host.textContent).toContain('档位参数未确认')
    expect(host.querySelector('.bad')).toBeNull()
    expect(host.querySelector('[data-tip]')?.getAttribute('data-tip')).toContain(
      '接口接受了非法档位',
    )
    setResult({
      ...initial,
      outcome: { ...initial.outcome, inconclusive: [], thinkingObserved: false },
    })
    expect(host.textContent).toContain('未观察到思考')
    expect(host.textContent).toContain('接口接受：low / high')
    expect(host.textContent).not.toContain('不支持')
    expect(host.textContent).not.toContain('默认思考')
    setResult({
      ...initial,
      outcome: {
        ...initial.outcome,
        reachable: false,
        probes: [{ name: '最小请求', ok: false, detail: '连接超时' }],
      },
    })
    expect(host.querySelector('.bad')?.textContent).toContain('连接失败')
  } finally {
    dispose()
    host.remove()
  }
})
