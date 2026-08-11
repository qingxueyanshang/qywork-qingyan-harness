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
  active: 'main',
  profiles: {
    main: { kind: 'anthropic', model: 'claude-opus-5', apiKey: 'sk-real-secret-value' },
    local: { kind: 'openai_compatible', model: 'qwen', baseUrl: 'http://127.0.0.1:11434/v1' },
  },
  effort: 'high',
})

describe('脱敏', () => {
  test('明文 apiKey 不出现在结果的任何一处', () => {
    const wire = JSON.stringify(redactConfig(cfg()))
    expect(wire).not.toContain('sk-real-secret-value')
  })

  test('有 key 的档案报 hasApiKey: true，没有的报 false', () => {
    const r = redactConfig(cfg())
    expect(r.profiles.main?.hasApiKey).toBe(true)
    expect(r.profiles.local?.hasApiKey).toBe(false)
  })

  test('空串 key 算「没有」 —— 否则界面会显示已配置而实际调用会 401', () => {
    const c = cfg()
    c.profiles.main = { ...c.profiles.main!, apiKey: '' }
    expect(redactConfig(c).profiles.main?.hasApiKey).toBe(false)
  })

  test('apiKeyEnv 照常回 —— 它是变量名不是值', () => {
    const c = cfg()
    c.profiles.main = { kind: 'anthropic', model: 'm', apiKeyEnv: 'ANTHROPIC_API_KEY' }
    expect(redactConfig(c).profiles.main?.apiKeyEnv).toBe('ANTHROPIC_API_KEY')
  })

  test('非密钥字段原样保留', () => {
    const r = redactConfig(cfg())
    expect(r.effort).toBe('high')
    expect(r.active).toBe('main')
    expect(r.profiles.local?.baseUrl).toBe('http://127.0.0.1:11434/v1')
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
    expect(roundTrip(() => {}).profiles.main?.apiKey).toBe('sk-real-secret-value')
  })

  test('改别的字段也不会动 key', () => {
    const out = roundTrip((r) => {
      r.profiles.main = { ...r.profiles.main!, maxOutputTokens: 4096 }
    })
    expect(out.profiles.main?.apiKey).toBe('sk-real-secret-value')
    expect(out.profiles.main?.maxOutputTokens).toBe(4096)
  })

  test('显式传新 key 就换掉', () => {
    const out = roundTrip((r) => {
      ;(r.profiles.main as { apiKey?: string }).apiKey = 'sk-new'
    })
    expect(out.profiles.main?.apiKey).toBe('sk-new')
  })

  test('显式传空串是「清掉」，与「没带」区分开', () => {
    const out = roundTrip((r) => {
      ;(r.profiles.main as { apiKey?: string }).apiKey = ''
    })
    expect(out.profiles.main?.apiKey).toBeUndefined()
  })

  test('hasApiKey 谎报 true 也变不出 key —— 库里没有就是没有', () => {
    const out = roundTrip((r) => {
      r.profiles.local = { ...r.profiles.local!, hasApiKey: true }
    })
    expect(out.profiles.local?.apiKey).toBeUndefined()
  })

  test('hasApiKey 报 false 表示这个档案本来就没配，不影响别人', () => {
    const out = roundTrip(() => {})
    expect(out.profiles.local?.apiKey).toBeUndefined()
    expect(out.profiles.main?.apiKey).toBe('sk-real-secret-value')
  })

  test('新增档案带明文 key 的话照收', () => {
    const out = roundTrip((r) => {
      r.profiles.added = {
        kind: 'anthropic',
        model: 'm',
        hasApiKey: false,
        apiKey: 'sk-added',
      } as never
    })
    expect(out.profiles.added?.apiKey).toBe('sk-added')
  })

  test('hasApiKey 这个字段本身不会漏进落盘的配置里', () => {
    const out = roundTrip(() => {})
    for (const p of Object.values(out.profiles)) {
      expect('hasApiKey' in p).toBe(false)
    }
  })

  test('顶层字段以传入的为准', () => {
    const out = roundTrip((r) => {
      r.effort = 'low'
      r.active = 'local'
    })
    expect(out.effort).toBe('low')
    expect(out.active).toBe('local')
  })

  test('多轮往返不掉 key —— 用户会反复打开设置页', () => {
    let c = cfg()
    for (let i = 0; i < 5; i++) c = mergeConfig(c, redactConfig(c))
    expect(c.profiles.main?.apiKey).toBe('sk-real-secret-value')
  })
})
