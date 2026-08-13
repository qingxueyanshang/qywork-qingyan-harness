/**
 * 配置脱敏与回填。
 *
 * 这两个函数是**明文 key 不出进程**这条边界的全部实现，所以这里测得比别处细。
 * 最要命的一条不是「key 泄漏了」——那种一眼能看出来；是**「打开设置页看一眼再保存」
 * 把 key 静默清掉**：保存那一刻没有任何反馈，要到下一次调用模型才炸，
 * 那时候人已经不会把它和「我刚才改了 baseUrl」联系起来。
 */

import { describe, expect, test } from 'bun:test'
import type { QyConfig } from '@qywork/runtime'
import { mergeConfig, type RedactedConfig, redactConfig } from './config.ts'

const cfg = (): QyConfig => ({
  active: { provider: 'main', model: 'claude-opus-5' },
  providers: {
    main: {
      kind: 'anthropic',
      apiKey: 'sk-real-secret-value',
      models: { 'claude-opus-5': {} },
    },
    local: {
      kind: 'openai_compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
      models: { qwen: {} },
    },
  },
  effort: 'high',
})

describe('脱敏', () => {
  test('明文 apiKey 不出现在结果的任何一处', () => {
    const wire = JSON.stringify(redactConfig(cfg()))
    expect(wire).not.toContain('sk-real-secret-value')
  })

  test('有 key 的接口报 hasApiKey: true，没有的报 false', () => {
    const r = redactConfig(cfg())
    expect(r.providers.main?.hasApiKey).toBe(true)
    expect(r.providers.local?.hasApiKey).toBe(false)
  })

  test('空串 key 算「没有」 —— 否则界面会显示已配置而实际调用会 401', () => {
    const c = cfg()
    c.providers.main = { ...c.providers.main!, apiKey: '' }
    expect(redactConfig(c).providers.main?.hasApiKey).toBe(false)
  })

  test('apiKeyEnv 照常回 —— 它是变量名不是值', () => {
    const c = cfg()
    c.providers.main = { kind: 'anthropic', apiKeyEnv: 'ANTHROPIC_API_KEY', models: { m: {} } }
    expect(redactConfig(c).providers.main?.apiKeyEnv).toBe('ANTHROPIC_API_KEY')
  })

  test('非密钥字段原样保留', () => {
    const r = redactConfig(cfg())
    expect(r.effort).toBe('high')
    expect(r.active).toEqual({ provider: 'main', model: 'claude-opus-5' })
    expect(r.providers.local?.baseUrl).toBe('http://127.0.0.1:11434/v1')
  })
})

describe('回填', () => {
  const roundTrip = (mutate: (r: RedactedConfig) => void): QyConfig => {
    const current = cfg()
    const wire = redactConfig(current)
    mutate(wire)
    return mergeConfig(current, wire)
  }

  test('原样存回不会动 key —— 这是最常见的一次保存', () => {
    expect(roundTrip(() => {}).providers.main?.apiKey).toBe('sk-real-secret-value')
  })

  test('改别的字段也不会动 key', () => {
    const out = roundTrip((r) => {
      r.providers.main = { ...r.providers.main!, baseUrl: 'https://relay.example/v1' }
    })
    expect(out.providers.main?.apiKey).toBe('sk-real-secret-value')
    expect(out.providers.main?.baseUrl).toBe('https://relay.example/v1')
  })

  test('显式传新 key 就换掉', () => {
    const out = roundTrip((r) => {
      ;(r.providers.main as { apiKey?: string }).apiKey = 'sk-new'
    })
    expect(out.providers.main?.apiKey).toBe('sk-new')
  })

  test('显式传空串是「清掉」，与「没带」区分开', () => {
    const out = roundTrip((r) => {
      ;(r.providers.main as { apiKey?: string }).apiKey = ''
    })
    expect(out.providers.main?.apiKey).toBeUndefined()
  })

  test('hasApiKey 谎报 true 也变不出 key —— 库里没有就是没有', () => {
    const out = roundTrip((r) => {
      r.providers.local = { ...r.providers.local!, hasApiKey: true }
    })
    expect(out.providers.local?.apiKey).toBeUndefined()
  })

  test('hasApiKey 报 false 表示这个接口本来就没配，不影响别人', () => {
    const out = roundTrip(() => {})
    expect(out.providers.local?.apiKey).toBeUndefined()
    expect(out.providers.main?.apiKey).toBe('sk-real-secret-value')
  })

  test('新增接口带明文 key 的话照收', () => {
    const out = roundTrip((r) => {
      r.providers.added = {
        kind: 'anthropic',
        models: { m: {} },
        hasApiKey: false,
        apiKey: 'sk-added',
      } as never
    })
    expect(out.providers.added?.apiKey).toBe('sk-added')
  })

  test('hasApiKey 这个字段本身不会漏进落盘的配置里', () => {
    const out = roundTrip(() => {})
    for (const p of Object.values(out.providers)) {
      expect('hasApiKey' in p).toBe(false)
    }
  })

  test('顶层字段以传入的为准', () => {
    const out = roundTrip((r) => {
      r.effort = 'low'
      r.active = { provider: 'local', model: 'qwen' }
    })
    expect(out.effort).toBe('low')
    expect(out.active).toEqual({ provider: 'local', model: 'qwen' })
  })

  /**
   * **界面认识的字段，比配置里真实存在的字段少。**
   *
   * `apps/web` 够不着 `@qywork/runtime`（层级不允许），所以那边手抄了一份
   * `RedactedConfig`。抄的那份现在就少一个 `sandboxNetwork`——它只在 CLI 里配。
   *
   * 于是失败形状是：用户 `qy config` 设了 `sandboxNetwork: 'deny'`，
   * 然后打开设置页改个模型保存，那一项被抹掉。**保存那一刻毫无反馈**，
   * 而它是条安全设置，等发现时早就跑了一堆没受限的命令了。
   *
   * 现在不会抹，靠的是 `mergeConfig` 里 `{ ...current, ...incoming }` 这个展开
   * ——incoming 没有这个键就不会覆盖。但那是一行代码的副作用，没人钉住它，
   * 改成逐字段赋值就当场坏。这条测试钉的就是它。
   */
  test('客户端不认识的顶层字段不会被抹掉', () => {
    const current: QyConfig = { ...cfg(), sandboxNetwork: 'deny', envAllowList: ['GITHUB_TOKEN'] }
    // 模拟界面：把服务端回的那份按自己认识的字段重建一遍，多余的键丢掉。
    const wire = redactConfig(current)
    const asClientSeesIt = {
      active: wire.active,
      profiles: wire.providers,
      effort: 'low',
      mode: wire.mode,
      additionalDirectories: wire.additionalDirectories,
      envAllowList: wire.envAllowList,
      classifier: wire.classifier,
    }
    // 过一遍 JSON：真实路径上 `undefined` 的键根本不会上线，别在内存里假装它在。
    const incoming = JSON.parse(JSON.stringify(asClientSeesIt)) as RedactedConfig

    const out = mergeConfig(current, incoming)
    expect(out.effort).toBe('low')
    expect(out.sandboxNetwork).toBe('deny')
    expect(out.envAllowList).toEqual(['GITHUB_TOKEN'])
  })

  test('多轮往返不掉 key —— 用户会反复打开设置页', () => {
    let c = cfg()
    for (let i = 0; i < 5; i++) c = mergeConfig(c, redactConfig(c))
    expect(c.providers.main?.apiKey).toBe('sk-real-secret-value')
  })
})
